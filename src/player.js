// Игрок: модель из Blender (models/player.glb, риг Mixamo, 22 анимации).
// Пока glb грузится (или если не загрузился) — капсула-заглушка, геймплей тот же.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { CONFIG } from './config.js';
import { buildDerivedClips } from './anim.js';
import { PoseBlend, blendTime } from './pose.js';
import { faceTexture } from './face.js';
import { HairRig } from './hair.js';
import { attachGloves } from './gloves.js';
import { kitTextureWithNumber } from './kitnum.js';
import { bakeClothMask, makeClothMaterial, updateCloth } from './cloth.js';
import { addRim } from './rimlight.js';
import { predictLanding, pursuitBall } from './ai/steering.js';

// Один .glb на всех: грузится единожды, каждый игрок получает клон со скелетом.
// Исходные материалы НЕ трогаем — каждый клон собирает свои (цвет команды).
// Сразу после загрузки достраиваем производные шаговые клипы (ходьба, спринт)
// и меряем длину шага каждого — см. src/anim.js. Делается один раз на общий
// gltf, до первого клона, поэтому все игроки получают готовый набор.
let modelPromise = null;
function loadPlayerModel() {
  if (!modelPromise) {
    modelPromise = new GLTFLoader().loadAsync('./models/player.glb')
      .then((gltf) => buildDerivedClips(gltf));
  }
  return modelPromise;
}

// Конкретная форма команды приходит путём к PNG из team.json.
// Старые JSON без kits продолжают работать: встроенный красный атлас
// перекрашивается в kitColor, как раньше.
const kitTexCache = new Map();
function setupKitTexture(tex) {
  tex.flipY = false; // glTF-развёртка хранится без переворота
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function getKitTexture(gltf, texturePath, colorHex, look) {
  // У игрока из состава форма своя: тот же атлас плюс номер и фамилия на
  // спине. У арбитров и команд без состава состава нет — им общий атлас.
  if (texturePath && look && look.number !== undefined && look.number !== null) {
    return kitTextureWithNumber(texturePath, look);
  }
  if (texturePath) {
    const key = `file:${texturePath}`;
    if (kitTexCache.has(key)) return kitTexCache.get(key);
    const tex = setupKitTexture(new THREE.TextureLoader().load(
      texturePath,
      undefined,
      undefined,
      (e) => console.error(`Текстура формы не загрузилась: ${texturePath}`, e),
    ));
    kitTexCache.set(key, tex);
    return tex;
  }
  if (!colorHex) return null;
  const key = `color:${colorHex}`;
  if (kitTexCache.has(key)) return kitTexCache.get(key);
  let srcMap = null;
  gltf.scene.traverse((o) => {
    if (o.isMesh && o.material && o.material.name === 'kit' && o.material.map) {
      srcMap = o.material.map;
    }
  });
  if (!srcMap || !srcMap.image) return null;
  const img = srcMap.image;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  // Цвет берём напрямую из hex в sRGB-байты (THREE.Color здесь нельзя:
  // он конвертирует в linear, и на canvas цвет вышел бы темнее задуманного)
  const n = parseInt(colorHex.replace('#', ''), 16);
  const cr = (n >> 16) & 255;
  const cg = (n >> 8) & 255;
  const cb = n & 255;
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (mx - mn > 30) { // насыщенный пиксель = «цвет команды»
      const v = mx / 255; // яркость исходника сохраняет светотень атласа
      d[i] = cr * v;
      d[i + 1] = cg * v;
      d[i + 2] = cb * v;
    }
  }
  ctx.putImageData(id, 0, 0);
  const tex = setupKitTexture(new THREE.CanvasTexture(c));
  kitTexCache.set(key, tex);
  return tex;
}

// Причёски переехали в src/hair.js: там и геометрия стрижек, и пружина для
// длинных волос. Здесь остался только вызов — модель одна на всех, а стиль
// и цвет приходят из squad.

// Временные вектора для handsWorldPoint — без аллокаций в кадре
const _handA = new THREE.Vector3();
const _handB = new THREE.Vector3();

// Временные для слоя «живой корпус» (updatePose) — тоже без аллокаций
const _poseEuler = new THREE.Euler();
const _poseQuat = new THREE.Quaternion();

// Куда игроки смотрят головой. Мяч — один на всех, и его вектор позиции живой
// (мутируется на месте), поэтому достаточно отдать его СЮДА один раз при сборке
// матча — дальше слой взгляда читает его сам, без прокидывания через сигнатуры.
let _lookTarget = null;
export function setLookTarget(pos) { _lookTarget = pos; }

// Какие клипы играются один раз (удары, падения), остальные — циклы.
// `fallen` тут не было — и это был не стилевой недосмотр, а баг: клип падения
// оставался зациклённым, событие finished не приходило НИКОГДА, поэтому
// this.oneShot у сбитого игрока не сбрасывался до следующего удара. Всё это
// время выбор шагового клипа был заблокирован, и человек бегал по полю в позе
// падения — ровно то самое «полупарализованные».
//
// `kick_r` наступил на те же грабли: клип добавили в модель и в таблицы ударов
// 26.07, а СЮДА вписать забыли — и правоногий пас (то есть большинство пасов)
// уходил в вечный цикл. Подробности и замер — в комментарии к playOneShot.
const ONE_SHOT = new Set([
  'fallen',
  'kick', 'kick_r', 'kick_run', 'penalty', 'header', 'tackle', 'trip', 'getup',
  'throwin', 'receive', 'gk_catch', 'gk_dive', 'gk_dive_r', 'gk_block',
  'gk_miss', 'gk_dropkick', 'gk_throw', 'gk_scoop', 'gk_pass',
  // Добавлены 28.07.2026 вместе с пересборкой модели
  'bicycle', 'knee_l', 'knee_r', 'header2', 'tackle2', 'gk_catch_hi',
]);

// Клипы, у которых СВОЙ ход таза по горизонтали спорит с движением игры.
// Все вратарские падения: Mixamo рисует их с настоящим полётом тела на
// 1.7–1.9 м (после детренда), а перемещение у нас считает физика. См. lockRootXZ.
// Сюда же 28.07.2026 добавлены ПОЛЕВЫЕ клипы: замер остаточного хода таза внутри
// самих клипов дал `trip` 0.98 м, `penalty` 0.50, `getup` 0.32, `tackle` 0.26 —
// а перемещение считает физика. Фигура уезжала от собственной тени и капсулы.
// Удар через себя `bicycle` тоже: он несёт настоящий полёт тела.
const ROOT_LOCKED = new Set([
  'gk_dive', 'gk_dive_r', 'gk_block', 'gk_catch', 'gk_miss', 'gk_catch_hi',
  'trip', 'fallen', 'getup', 'tackle', 'tackle2', 'penalty', 'bicycle',
]);

export class Player {
  // opts.kitTexture — путь к PNG-атласу; kitColor — цвет старого фолбэка/капсулы.
  // Команду, роль и isKeeper проставляет Team (src/ai/team.js).
  constructor(scene, opts = {}) {
    const P = CONFIG.player;
    this.kitColor = opts.kitColor || null;
    this.kitTexture = opts.kitTexture || null;
    // Внешность из JSON состава: рост, телосложение, тон кожи, причёска.
    // Так Роберто Карлос ниже и коренастее Блана без единой новой модели.
    this.look = opts.look || null;
    this.group = new THREE.Group();

    // Emissive-подсветка, чтобы фигура читалась на тёмном вечернем поле
    const capCol = new THREE.Color(this.kitColor || '#d84a3c');
    this.body = new THREE.Mesh(
      new THREE.CapsuleGeometry(P.radius, P.height - P.radius * 2, 4, 8),
      new THREE.MeshLambertMaterial({
        color: capCol,
        emissive: capCol.clone().multiplyScalar(0.4),
      }),
    );
    this.body.position.y = P.height / 2;
    this.group.add(this.body);

    // «Носок бутсы» — тёмная метка, чтобы читалось, куда игрок смотрит
    this.nose = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.12, 0.34),
      new THREE.MeshLambertMaterial({ color: 0x6e1c15 }),
    );
    this.nose.position.set(0, 0.1, P.radius + 0.12);
    this.group.add(this.nose);

    // Тень не одна: на ночном стадионе четыре мачты дают веер теней.
    // Рисует их общий менеджер (src/atmosphere.js) одним draw call, а нам
    // достаётся «якорь» — пустышка, у которой мы двигаем только позицию.
    // Если сцена без менеджера (отладочный стенд) — падаем на старый кружок.
    const shadows = scene.userData && scene.userData.shadows;
    this.shadow = shadows
      ? shadows.create(P.height * P.modelScale)
      : new THREE.Mesh(
        new THREE.CircleGeometry(P.radius * 1.25, 12),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }),
      );
    this.shadow.rotation.x = shadows ? 0 : -Math.PI / 2;
    this.shadow.position.y = 0.02;

    this.vel = new THREE.Vector3();
    this.rot = 0;            // угол поворота (0 = смотрит в +Z)
    this.hasBall = false;
    this.controlling = false; // гистерезис дриблинга: подобрал вплотную — ведёт до keepRadius
    this.pendingStrike = null; // буфер «удара с хода»: событие ждёт входа мяча в зону ноги
    this.strikeContactLock = false; // замах на спринте: ноги держат контакт, стрелки целятся
    this.chargeRun = false;  // замах начат на бегу — бег продолжается (удар подъёмом)
    this.lastStrikeStyle = null; // для отладки/баланса: каким ударом бил последний раз
    this.lastKick = null;    // { foot: 'L'|'R', contact: 'inside'|'outside' } — нога и часть стопы
    this.dribbleTouchCd = 0; // пауза между толчками мяча на спринте
    this.dribbleDir = null;  // курс ведения (обновляется в момент касания)
    this.ballApproach = null; // обязательство добежать до следующего касания
    this.sprintBoost = 0;    // инерция спринта: 1 = полный темп, спадает плавно
    this.jumpT = 0;          // остаток прыжка под удар головой (визуальная дуга)
    this.jumpHeight = null;  // высота текущего прыжка (от силы нажатия); null = дефолт
    this.diveT = 0;          // бросок корпусом (ласточка): время полёта
    this.diveDir = null;     // направление броска
    this.downT = 0;          // лежим после броска + подъём (getup)
    this._gotUp = false;     // клип подъёма уже запущен
    this.challengeCd = 0;    // откат между навалами корпусом
    this.kickCooldown = 0;
    this.ownEpisodeT = 0;    // сек «эпизода владения»: недавно касался мяча (см. update)
    this.bobT = 0;
    // Порядок эйлера YXZ: сначала разворот (Y), потом наклон ласточки (X)
    // — наклон идёт вперёд по взгляду, а не вокруг мировой оси
    this.group.rotation.order = 'YXZ';

    // --- Анимации (заполнится после загрузки glb) ---
    this.model = null;
    this.mixer = null;
    this.actions = {};
    this.currentAction = null;
    this.currentName = null;
    this.oneShot = null;     // играющий сейчас одноразовый клип
    this.aerialStrike = null; // замыкание в одно касание: замах играет, мяч
                              // подлетает, перенаправляется в момент контакта
    this._ignoreShotEdge = false; // проглотить отпускание D после волея на удержании

    loadPlayerModel()
      .then((gltf) => this.attachModel(gltf))
      .catch((e) => console.error('Модель игрока не загрузилась, остаёмся на капсуле:', e));

    scene.add(this.group);
    scene.add(this.shadow);
    this.reset();
  }

  attachModel(gltf) {
    const P = CONFIG.player;
    this.model = cloneSkeleton(gltf.scene);
    // Рост и телосложение — из JSON состава. Модель одна на всех, разными
    // фигуры делают пропорции: вертикаль = рост, горизонталь = сложение.
    const L = this.look;
    const tall = L && L.height ? L.height / P.baseHeightCm : 1;
    const wide = L && L.build ? L.build : 1;
    this.model.scale.set(
      P.modelScale * tall * wide,
      P.modelScale * tall,      // ноги в origin — растём вверх, не в землю
      P.modelScale * tall * wide,
    );

    // Материалы — свои у каждого клона: форма перекрашена в цвет команды.
    // Lambert вместо Standard: быстрее на планшете, с плоскими гранями и
    // пиксельной текстурой выглядит так же (стиль PS1).
    // Самосвечение — «пол яркости» на вечернем поле, но он же и потолок
    // светотени: разница между освещённой и теневой стороной не может его
    // превысить. Оба числа теперь в ЛИНЕЙНОЙ шкале и в CONFIG.player.emissive
    // (раньше форма стояла на 0x737373 ≈ 0.17 после перевода из sRGB, а кожа
    // на явном 0.45 — две разные шкалы в соседних ветках).
    const EM = CONFIG.player.emissive;
    const R = CONFIG.atmosphere.rim;
    const kitTex = getKitTexture(gltf, this.kitTexture, this.kitColor, L);
    const faceTex = faceTexture(L || {});
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      // Скелет двигает вершины мимо исходной рамки объекта — отсечение по ней врёт
      o.frustumCulled = false;
      const src = o.material;
      let mat;
      if (src.name === 'head') {
        // Голова — единственная часть с рисованной текстурой (src/face.js).
        // ГОЛОВЕ И КОЖЕ ОБЯЗАН ДОСТАТЬСЯ ОДИН ИТОГ: они стыкуются ровно на
        // челюсти, и разные ветки дают тёмное кольцо под подбородком.
        mat = new THREE.MeshLambertMaterial({ map: faceTex, emissiveMap: faceTex });
        mat.emissive.setScalar(EM.skin);
      } else if (src.name === 'kit' && kitTex) {
        mat = new THREE.MeshLambertMaterial({ map: kitTex, emissiveMap: kitTex });
        mat.emissive.setScalar(EM.kit);
      } else if (src.map) {
        mat = new THREE.MeshLambertMaterial({ map: src.map, emissiveMap: src.map });
        mat.emissive.setScalar(EM.kit);
      } else {
        mat = new THREE.MeshLambertMaterial({
          color: src.color.clone(),
          emissive: src.color.clone().multiplyScalar(EM.skin),
        });
        // Тон кожи из состава: смуглые бразильцы и бледные европейцы в одном
        // кадре — это половина узнаваемости фигурок на PS1. Текстура лица
        // рисуется от этого же числа, поэтому лицо и руки совпадают по тону.
        if (L && L.skin && src.name === 'skin') {
          mat.color.set(L.skin);
          mat.emissive.set(L.skin).multiplyScalar(EM.skin);
        }
      }
      mat.name = src.name; // имена kit/skin/head нужны для перекраски из JSON
      if (src.name === 'kit') {
        // Ветер в футболке. Маска свободной ткани лежит во ВТОРОМ слое UV,
        // запечённом в Blender (tools/build-player-mesh.py). Геометрия у всех
        // 22 клонов ОДНА — SkeletonUtils.clone делит её по ссылке, — поэтому
        // маску достаточно прочитать один раз, а не на каждого игрока.
        bakeClothMask(o.geometry);
        // Контровик форме достаётся ВНУТРИ патча ткани: onBeforeCompile у
        // материала ровно один, и второе присваивание молча выключило бы ветер.
        this.cloth = makeClothMaterial(mat);
        this.kitMesh = o;
      } else {
        // Кожа, голова, бутсы, гетры — свободный слот, вешаем ссылкой.
        addRim(mat, src.name === 'skin' || src.name === 'head' ? R.skinScale : 1);
      }
      o.material = mat;
    });

    this.group.add(this.model);
    // Причёску и перчатки сажаем ПОСЛЕ подключения модели: если тут что-то
    // сломается, игрок останется с моделью и анимациями, а не свалится на капсулу
    this.attachHair();
    this.attachGloves();
    this.body.visible = false;   // капсула была фолбэком — прячем
    this.nose.visible = false;

    this.mixer = new THREE.AnimationMixer(this.model);
    for (const clip of gltf.animations) {
      const action = this.mixer.clipAction(clip);
      if (ONE_SHOT.has(clip.name)) {
        action.setLoop(THREE.LoopOnce);
        action.clampWhenFinished = true;
      }
      this.actions[clip.name] = action;
    }
    this.mixer.addEventListener('finished', (e) => {
      if (e.action === this.oneShot) {
        this.endOneShot();
      }
    });
    // Слой инерциализации: смена клипа больше не смешивает два движения,
    // а включает новое целиком и гасит разрыв поз затухающей поправкой
    this.poseBlend = new PoseBlend(this.model);
    this.setupLoco(gltf);
  }

  // Шаговые клипы живут иначе, чем всё остальное: они НЕ переключаются, а
  // постоянно играют с весами. Соседние ступени лестницы (стойка → ходьба →
  // бег → спринт) смешиваются по скорости, поэтому перехода «дёрнулся и сменил
  // клип» не существует в принципе. Веса ведём руками — crossFade три.js тут
  // мешал бы (он ставит свой интерполятор поверх наших весов).
  setupLoco(gltf) {
    const A = CONFIG.player.anim;
    const nat = (gltf.userData && gltf.userData.locoSpeed) || {};
    // Масштаб модели входит в длину шага честно: высокий шагает шире
    const s = this.model.scale.z || 1;
    this.loco = {};
    const names = A.derive.map((d) => d.name).concat(['idle', 'gk_idle']);
    for (const name of names) {
      const a = this.actions[name];
      if (!a) continue;
      a.enabled = true;
      a.setLoop(THREE.LoopRepeat, Infinity);
      a.setEffectiveWeight(0);
      a.play();
      this.loco[name] = { a, w: 0, nat: (nat[name] || 0) * s, dur: a.getClip().duration };
    }
    // Личная фаза и личный темп: без них 22 фигуры маршируют строем в ногу
    // (замер до правки: все 20 полевых стояли ровно на кадре t = 0.663)
    this.animPhase = Math.random();
    this.animRate = 1 + (Math.random() * 2 - 1) * A.rateJitter;
    this.locoName = 'idle';   // ведущая ступень (её пишет повтор)
    this.locoMode = 'fwd';    // направление лестницы (с гистерезисом)
    this.oneShotW = 0;        // текущий вес одноразового клипа
    this.fadingOneShot = null; // доигравший клип, который надо погасить
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.leanZ = 0;
    this.leanX = 0;
    this.locoPhase = this.animPhase;
    this._prevRot = this.rot;
    this._prevFwd = 0;
    // Кости слоя «живой корпус» ищем один раз (getObjectByName обходит дерево)
    this._headBoneLook = this.model.getObjectByName('mixamorigHead') || null;
    // Поза покоя таза: к ней возвращаем горизонталь во время падений (lockRootXZ).
    // Вертикальную ось берём ЗАМЕРОМ — у неё смещение на порядок больше (рост
    // таза около метра против сантиметров у горизонтальных).
    this._hips = this.model.getObjectByName('mixamorigHips') || null;
    if (this._hips) {
      this._hipsRest = this._hips.position.clone();
      const r = this._hipsRest;
      const m = Math.max(Math.abs(r.x), Math.abs(r.y), Math.abs(r.z));
      this._upAxis = m === Math.abs(r.x) ? 'x' : (m === Math.abs(r.y) ? 'y' : 'z');
    }
    this._chestBone = this.model.getObjectByName('mixamorigSpine2')
      || this.model.getObjectByName('mixamorigSpine1') || null;
    this._spineBone = this.model.getObjectByName('mixamorigSpine') || null;
    // Стартовая раскладка: стойка со своей фазы
    const idle = this.loco.idle;
    if (idle) {
      idle.w = 1;
      idle.a.setEffectiveWeight(1);
      idle.a.time = this.animPhase * idle.dur;
    }
    this.currentAction = idle ? idle.a : null;
    this.currentName = 'idle';
  }

  // Причёска — отдельный модуль (src/hair.js). Сажаем ПОСЛЕ подключения
  // модели: если стрижка сломается, игрок останется с моделью и анимациями,
  // а не свалится на капсулу.
  attachHair() {
    try {
      this.hair = new HairRig(this.model, this.look);
    } catch (e) {
      console.error('Причёска не собралась:', e);
      this.hair = null;
    }
  }

  // Перчатки — только вратарю (src/gloves.js). Роль к этому моменту уже
  // проставлена: Team назначает isKeeper синхронно в конструкторе Match, а
  // модель приезжает промисом, то есть заведомо позже. На всякий случай метод
  // публичный — если когда-нибудь роль начнут менять на ходу, хватит вызова.
  attachGloves() {
    if (!this.isKeeper || !this.model || this.gloves) return;
    try {
      this.gloves = attachGloves(this.model, this.look);
    } catch (e) {
      console.error('Перчатки не собрались:', e);
      this.gloves = null;
    }
  }

  // Одноразовый клип поверх движения (удар, подкат…).
  // startAt (сек клипа) стартует не с нуля, а ближе к контакту с мячом:
  // удар мгновенный, а полный замах отставал бы от уже улетевшего мяча.
  // endAt (сек клипа) обрезает хвост: доиграли проводку — и сразу обратно в
  // бег. Без обрезки длинный клип (`header` — 1.2 с) морозил ноги на пол-
  // секунды после удара и ломал темп эпизода (фидбек Олега 24.07).
  playOneShot(name, timeScale = 1, startAt = 0, endAt = null, blend = null) {
    const a = this.actions[name];
    if (!a) return;
    // ПЕРЕХОД ЗАРЯЖАЕМ ДО СМЕНЫ КЛИПА. В этот миг кости ещё держат позу прошлого
    // кадра — ту самую, от которой глаз ждёт продолжения. Дальше клип пойдёт на
    // ПОЛНЫЙ вес (см. updateLoco), а память о прошлой позе доживёт отдельным
    // затухающим слагаемым в src/pose.js. Раньше вместо этого вес клипа рос
    // 8 кадров, а весь клип паса длится 6 — удар рисовался половиной амплитуды.
    if (this.poseBlend) this.poseBlend.begin(blend != null ? blend : blendTime('strike'));
    // СТРАХОВКА ОТ «ГОПАКА». Одноразовый клип обязан быть LoopOnce с фиксацией
    // последнего кадра, иначе выхода из него нет ВООБЩЕ: событие finished у
    // зациклённого клипа не приходит никогда, а обрезка хвоста ждёт условия
    // `time >= endAt` — и промахивается мимо него, потому что LoopRepeat
    // заворачивает время через ноль. Замер по kick_r (длина 0.533, конец 0.53,
    // темп 2.1): время идёт 0.41 → 0.445 → 0.48 → 0.515 → 0.017 — окно шириной
    // 0.003 с перепрыгнуто, клип крутится 172 кадра (2.9 с). На экране это
    // правая нога, бьющая по мячу снова и снова, при неподвижной левой.
    // Список ONE_SHOT остаётся документацией намерения, но забыть в нём имя
    // больше не смертельно: право быть циклом есть только у шаговых ступеней,
    // а они через playOneShot не проходят никогда.
    if (a.loop !== THREE.LoopOnce) {
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
    }
    // Предыдущий одноразовый гасим сами (менеджер весов в updateLoco): его
    // собственный fadeOut ставил интерполятор поверх наших весов и дрался с ним
    if (this.oneShot && this.oneShot !== a) this.fadingOneShot = this.oneShot;
    if (this.fadingOneShot === a) this.fadingOneShot = null;
    a.reset();
    a.time = startAt;
    a.timeScale = timeScale;
    a.enabled = true;
    // Вес поднимет менеджер: удар вытесняет шаговые клипы, а не складывается
    // с ними (два клипа по весу 1 давали половину удара и половину бега)
    a.setEffectiveWeight(1);
    a.play();
    this.currentAction = a;
    this.currentName = name;
    this.oneShot = a;
    this.oneShotUntil = endAt;
    this.oneShotW = 1;
  }

  // Одноразовый клип закончился (доиграл, обрезан хвост, отменён снаружи).
  // ОДНА точка выхода на все случаи: раньше выход был расписан в четырёх местах
  // (событие finished, обрезка oneShotUntil, cancelOneShot, повтор), и добавить
  // туда переход, ничего не забыв, было нельзя.
  endOneShot(blend = null) {
    if (!this.oneShot) return;
    if (this.poseBlend) this.poseBlend.begin(blend != null ? blend : blendTime('exit'));
    this.fadingOneShot = this.oneShot;   // менеджер весов погасит его в этом же кадре
    this.oneShot = null;
    this.oneShotUntil = null;
    this.currentName = null;             // следующий кадр сам выберет бег/стойку
  }

  // Смеситель шаговых клипов. Вызывать раз в кадр ДО mixer.update.
  //
  // Принцип. Ступени лестницы (стойка → ходьба → бег → спринт) не
  // переключаются, а смешиваются по весам: берём пару соседних и выдаём их
  // долями. Темп считается от ДЛИНЫ ШАГА смеси, поэтому опорная стопа едет
  // ровно со скоростью газона под ней — скольжения нет ни на одной скорости.
  // Фаза у ступеней ОБЩАЯ (одна нормированная 0..1 на игрока): без неё две
  // смешанные походки идут не в ногу и дают кашу вместо ног.
  updateLoco(dt, speed) {
    const A = CONFIG.player.anim;
    const L = this.loco;
    if (!L) return;

    // --- 1. Одноразовый клип (удар, подкат, сейв) вытесняет шаговые ЦЕЛИКОМ ---
    //
    // Переключение ЖЁСТКОЕ, и это главная правка сессии. Раньше вес одноразового
    // клипа рос от нуля со скоростью oneShotRate = 16 1/с: до 0.9 — восемь кадров,
    // до 0.99 — пятнадцать. А клип паса `kick_r` длится ШЕСТЬ кадров, тычок
    // `toe` — три с половиной. Удар успевал прорисоваться в лучшем случае
    // наполовину: нога проходила половину дуги, и это и есть «игрок как робот
    // пихает мяч» (фидбек Олега 28.07.2026). Плавность теперь даёт не
    // недовешенный клип, а затухающая поправка позы (src/pose.js).
    //
    // Суммарный вес всё так же держим ровно 1: при меньшем three.js подмешивает
    // позу покоя, и фигура «уползает» в T-позу.
    const kOne = A.oneShotRate > 0 ? Math.min(1, A.oneShotRate * dt) : 1;
    if (this.oneShot) {
      this.oneShotW += (1 - this.oneShotW) * kOne;
      this.oneShot.setEffectiveWeight(this.oneShotW);
    } else {
      this.oneShotW = Math.max(0, this.oneShotW - kOne);
      if (this.fadingOneShot) this.fadingOneShot.setEffectiveWeight(this.oneShotW);
    }
    if (this.fadingOneShot && (this.fadingOneShot === this.oneShot || this.oneShotW <= 0.002)) {
      if (this.fadingOneShot !== this.oneShot) {
        this.fadingOneShot.setEffectiveWeight(0);
        this.fadingOneShot.stop();
      }
      this.fadingOneShot = null;
    }
    const room = 1 - this.oneShotW;

    // --- 2. Какая лестница: вперёд, спиной или боком ---
    // Взгляд считаем напрямую: геттер facing аллоцирует Vector3 на каждый вызов
    const fx = Math.sin(this.rot);
    const fz = Math.cos(this.rot);
    const fwd = this.vel.x * fx + this.vel.z * fz;
    const side = fx * this.vel.z - fz * this.vel.x; // >0 — движение вправо от взгляда
    const bottom = (this.isKeeper && L.gk_idle) ? 'gk_idle' : 'idle';
    // Направление с гистерезисом: порог входа в режим строже порога выхода,
    // иначе на грани (движение под ~60° к взгляду) режим дребезжит и в позе
    // одновременно висят шаг влево и шаг вправо — ноги превращаются в кашу
    const mode = this.locoMode || 'fwd';
    const sideK = speed > 0.01 ? Math.abs(side) / speed : 0;
    const fwdK = speed > 0.01 ? fwd / speed : 1;
    const sideways = mode === 'sideL' || mode === 'sideR';
    let next = mode;
    if (speed < A.dirMinSpeed) {
      next = 'fwd';
    } else if (sideways) {
      // Держим боковой режим, пока движение вбок ощутимо И по доле, и в м/с.
      // Сторону меняем только по УВЕРЕННОМУ боковому ходу: около нуля знак
      // `side` дребезжит, и раньше в позе висели оба приставных шага сразу
      const keep = sideK > A.sideExit && Math.abs(side) > A.sideMin * A.sideKeep;
      if (!keep) next = fwdK < A.backEnter ? 'back' : 'fwd';
      else if (Math.abs(side) > A.sideMin) next = side > 0 ? 'sideR' : 'sideL';
    } else if (mode === 'back') {
      if (fwdK > A.backExit) next = 'fwd';
    } else if (sideK > A.sideEnter && Math.abs(side) > A.sideMin) {
      next = side > 0 ? 'sideR' : 'sideL';
    } else if (fwdK < A.backEnter) {
      next = 'back';
    }
    // СМЕНА НАПРАВЛЕНИЯ — ТОЖЕ ПЕРЕХОД, а не смешивание. Бег вперёд, бег спиной
    // и два приставных шага — РАЗНЫЕ хореографии, и их среднее не значит ничего:
    // на стенде рывка боковые ступени давали 14–18 % пиковых кадров против 6 % у
    // бега, и вся разница приходилась ровно на кадры смены режима. Внутри одной
    // лестницы (ходьба → бег → спринт) веса по-прежнему правят: там хореография
    // одна, и промежуточная походка честная.
    //
    // ВЫДЕРЖКА ОБЯЗАТЕЛЬНА. Гистерезис по порогам не спасает: игрок в толкучке
    // меняет курс каждые несколько кадров, режим честно скачет вслед, и на
    // стенде это дало у медленных приставных шагов 57–63 % дёрганых кадров при
    // 6 % у бега — то есть в этих ступенях фигура почти всё время находилась
    // ВНУТРИ очередного перехода. Кандидат обязан продержаться modeHold секунд,
    // и только потом становится режимом.
    if (next !== mode) {
      if (next !== this._modeCand) {
        this._modeCand = next;
        this._modeCandT = 0;
      }
      this._modeCandT = (this._modeCandT || 0) + dt;
      if (this._modeCandT < A.modeHold) {
        next = mode;                     // кандидат ещё не доказал серьёзность
      } else {
        this._modeCand = null;
        this._modeCandT = 0;
        if (this.poseBlend) this.poseBlend.begin(blendTime('turn'));
        this._locoJump = true;           // веса встают на место в этом же кадре
      }
    } else {
      this._modeCand = null;
      this._modeCandT = 0;
    }
    this.locoMode = next;
    // Вратарь вдоль линии ходит своим приставным шагом в низкой стойке
    const gk = this.isKeeper && L.gk_side_l;
    const LADDER = {
      fwd: A.ladder,
      back: A.ladderBack,
      sideL: gk ? A.ladderSideLKeeper : A.ladderSideL,
      sideR: gk ? A.ladderSideRKeeper : A.ladderSideR,
    };
    const rungs = (LADDER[next] || A.ladder).map((n) => (n === 'idle' ? bottom : n));
    const avail = rungs.filter((n) => L[n]);
    if (!avail.length) return;

    // --- 3. Пара соседних ступеней и доли между ними ---
    // Якорь ступени = её вымеренная скорость (у стойки — ноль). Смесь двух
    // ступеней даёт скорость ног, равную взвешенному среднему якорей, —
    // поэтому темп ниже считается именно от него.
    const anchor = avail.map((n) => (n === bottom ? 0 : L[n].nat || 0));
    let i = 0;
    while (i < avail.length - 2 && speed >= anchor[i + 1]) i++;
    const j = Math.min(i + 1, avail.length - 1);
    let t = anchor[j] > anchor[i] ? (speed - anchor[i]) / (anchor[j] - anchor[i]) : 1;
    t = Math.max(0, Math.min(1, t));
    // «Полка»: нижняя ступень держится чисто в начале промежутка — в переходе
    // сэмплятся два клипа, и лишнюю их долю мы не оплачиваем на планшете
    if (A.blendBand < 1) t = Math.max(0, Math.min(1, (t - (1 - A.blendBand)) / A.blendBand));
    t = t * t * (3 - 2 * t);       // smoothstep: вход и выход без рывка

    const want = this._locoWant || (this._locoWant = {});
    for (const n in L) want[n] = 0;
    want[avail[i]] += 1 - t;
    want[avail[j]] += t;

    // --- 4. Веса догоняют цель плавно (смена режима вперёд/боком дискретна) ---
    // В кадре смены режима веса встают на место СРАЗУ: плавность этого стыка
    // теперь обеспечивает поправка позы, а догоняющие веса дали бы поверх неё
    // вторую, паразитную смесь — те самые «ноги превращаются в кашу».
    const kW = this._locoJump ? 1 : Math.min(1, A.weightRate * dt);
    this._locoJump = false;
    let sum = 0;
    for (const n in L) {
      const e = L[n];
      e.w += ((want[n] || 0) - e.w) * kW;
      if (e.w < A.weightFloor && !want[n]) e.w = 0;
      sum += e.w;
    }
    const norm = sum > 0.001 ? room / sum : 0;

    // --- 5. Общая фаза: ступени идут ШАГ В ШАГ ---
    // Длину шага смеси считаем по ФАКТИЧЕСКИМ весам, а не по целевым. Разница
    // не косметическая: при торможении с бега в позе ещё «висят» спринт и бег
    // (веса догоняют цель ~0.07 с), и если считать темп по цели, ноги едут
    // быстрее, чем рисует смесь. Замер: в полосе 1–2 м/с у ступеней-догонялок
    // оставалось 15% веса — ровно на них и приходилось лишнее скольжение.
    // Стойка входит в среднее с нулём законно: подмешанная неподвижная поза
    // укорачивает видимый шаг, и клип обязан крутиться быстрее.
    let nat = 0;
    if (sum > 0.001) {
      for (let k = 0; k < avail.length; k++) nat += L[avail[k]].w * anchor[k];
      for (const n in L) {
        if (avail.indexOf(n) < 0) nat += L[n].w * (L[n].nat || 0);
      }
      nat /= sum;
    }
    const rate = nat > 0.05
      ? Math.max(A.rateMin, Math.min(A.rateMax, speed / nat)) * this.animRate
      : this.animRate;
    // Опорная длительность — у ведущей шаговой ступени (у стойки цикла нет)
    const leadGait = avail[j] !== bottom ? avail[j] : avail[i];
    const ref = (L[leadGait] && leadGait !== bottom && L[leadGait].dur) || 0.7;
    this.locoPhase = (this.locoPhase + (rate * dt) / ref) % 1;

    // --- 6. Раздача весов и кадров ---
    let lead = null;
    let leadW = -1;
    for (const n in L) {
      const e = L[n];
      const w = e.w * norm;
      e.a.setEffectiveWeight(w);
      if (n === bottom) {
        e.a.timeScale = this.animRate;      // стойка живёт своим ходом
      } else {
        e.a.timeScale = 0;                  // время шаговых ведём фазой сами
        e.a.time = this.locoPhase * e.dur;
      }
      if (e.w > leadW) { leadW = e.w; lead = n; }
    }
    // Повтор (src/replay.js) пишет ОДИН клип и его время — отдаём ведущую
    // ступень; при весе ≥ 0.5 картинка от смеси почти не отличается
    if (!this.oneShot && lead) {
      this.currentAction = L[lead].a;
      this.currentName = lead;
    }
    this.locoName = lead;
  }

  // ГАШЕНИЕ СОБСТВЕННОГО ХОДА КЛИПА (правило с 28.07.2026).
  //
  // Вратарские броски Mixamo несут огромный root motion: сырой клип уводит таз
  // на 2.9–3.5 м вбок. Скрипт пересборки снимает у него ЛИНЕЙНЫЙ тренд (снос от
  // начала к концу), но у броска этот снос почти нулевой — тело уезжает и
  // возвращается, — поэтому после детренда в клипе остаётся горб в 1.7–1.9 м.
  // А игра в это же время двигает `group.position` своей физикой (diveSpeed ×
  // diveTime). Два хода складываются, и КАРТИНКА РАСХОДИТСЯ С ФИЗИКОЙ: замер
  // 28.07.2026 на броске вправо дал группу на z = +2.34 при тазе модели на
  // z = −1.98, то есть 4.2 м расхождения. Мяч играл невидимый вратарь, а тело
  // летело куда-то в сторону — ровно «анимация сейвов нереалистичная».
  //
  // Гасим ровно ГОРИЗОНТАЛЬ таза, оставляя высоту: падение, кувырок и вся
  // работа рук — это повороты костей, они не трогаются. Единственным
  // источником перемещения остаётся физика игры.
  //
  // КАКАЯ ОСЬ ВЕРТИКАЛЬНАЯ — ЗАМЕРЯЕМ, А НЕ УГАДЫВАЕМ. У кости таза Mixamo
  // оси повёрнуты: мировое «вверх» — это локальная −Z (то же самое написано
  // про скиннинг в src/cloth.js). Первый заход заморозил x и z, то есть одну
  // горизонталь и ВЕРТИКАЛЬ: вратарь перестал падать вовсе (таз опускался на
  // 16 см вместо метра), а вторая горизонталь осталась свободной и дала
  // остаточное расхождение в метр. Ось находим по позе покоя: вертикальная —
  // та, у которой смещение самое большое по модулю (рост таза ≈ 1 м против
  // сантиметров у остальных).
  lockRootXZ() {
    if (!this._hips || !ROOT_LOCKED.has(this.currentName)) return;
    const p = this._hips.position;
    const r = this._hipsRest;
    if (this._upAxis !== 'x') p.x = r.x;
    if (this._upAxis !== 'y') p.y = r.y;
    if (this._upAxis !== 'z') p.z = r.z;
    this._hips.updateMatrix();
  }

  // Живой корпус поверх клипа: доворот на мяч и завал в поворот.
  // Вызывать ПОСЛЕ mixer.update — микшер уже поставил позу кадра, а мы
  // доворачиваем шею и грудь сверху. Это самый дешёвый способ убрать
  // «деревянность»: пара кватернионов на игрока, зато фигура смотрит туда,
  // куда должна, и заваливается в дугу, как живой бегущий.
  //
  // ВАЖНО: во время одноразовых клипов (удар, сейв, подкат) слой молчит.
  // Кадры контакта вымерены по риггу (CONFIG.player.aerial.sync), а точки
  // удара считаются от костей головы и стопы — доворот сдвинул бы их.
  updatePose(dt, speed) {
    const A = CONFIG.player.anim;
    if (!this.model) return;
    const active = !this.oneShot && this.oneShotW < 0.2 &&
      this.diveT <= 0 && this.downT <= 0 && this.tackleT <= 0;

    // --- Доворот головы и груди на мяч ---
    const LK = A.look;
    if (LK.enabled) {
      let yaw = 0;
      let pitch = 0;
      const ball = active ? _lookTarget : null;
      if (ball) {
        const dx = ball.x - this.group.position.x;
        const dz = ball.z - this.group.position.z;
        const flat = Math.hypot(dx, dz);
        if (flat < LK.maxDist) {
          let d = Math.atan2(dx, dz) - this.rot;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          yaw = Math.max(-LK.maxYaw, Math.min(LK.maxYaw, d));
          const dy = ball.y - CONFIG.player.height * 0.9;
          pitch = Math.max(-LK.maxPitch, Math.min(LK.maxPitch, -Math.atan2(dy, Math.max(1, flat))));
        }
      }
      const kL = Math.min(1, LK.rate * dt);
      this.lookYaw += (yaw - this.lookYaw) * kL;
      this.lookPitch += (pitch - this.lookPitch) * kL;
      this._applyBone(this._headBoneLook, LK.headShare * this.lookYaw, LK.headShare * this.lookPitch);
      this._applyBone(this._chestBone, LK.chestShare * this.lookYaw, 0);
    }

    // --- Завал в поворот и на разгоне ---
    const LN = A.lean;
    if (LN.enabled) {
      let dRot = this.rot - this._prevRot;
      while (dRot > Math.PI) dRot -= Math.PI * 2;
      while (dRot < -Math.PI) dRot += Math.PI * 2;
      this._prevRot = this.rot;
      const fwdSp = this.vel.x * this.facing.x + this.vel.z * this.facing.z;
      const accel = dt > 0 ? (fwdSp - this._prevFwd) / dt : 0;
      this._prevFwd = fwdSp;
      const k01 = Math.min(1, speed / LN.speedRef);
      let bank = 0;
      let pitch = 0;
      if (active) {
        const w = dt > 0 ? dRot / dt : 0;
        bank = Math.max(-LN.turnMax, Math.min(LN.turnMax, -w * LN.turn * 0.1)) * k01;
        pitch = Math.max(-LN.accelMax, Math.min(LN.accelMax, accel * LN.accel)) * k01;
      }
      const kN = Math.min(1, LN.rate * dt);
      this.leanZ += (bank - this.leanZ) * kN;
      this.leanX += (pitch - this.leanX) * kN;
      this._applyBone(this._spineBone, 0, this.leanX, this.leanZ);
    }
  }

  // ДОВОРОТ КОРПУСА В УДАР — ЦЕЛЬ, А НЕ ПРИСВОЕНИЕ (правка с 28.07.2026).
  //
  // Раньше пас, удар, навес, подкат и бросок ставили угол корпуса ОДНИМ КАДРОМ:
  // восемь мест с голым `this.rot = Math.atan2(...)`. Замер по матчам: до 180°
  // за кадр, то есть 10 800 °/с, при собственном потолке игры около 21°/кадр, и
  // 1908 таких кадров за пять матчей. На экране фигура мгновенно «щёлкает»
  // лицом в новую сторону, а ноги догоняют её ещё 3–8 кадров — это и есть
  // «повороты дёрганные» из фидбека.
  //
  // Теперь удар задаёт ЦЕЛЬ, а корпус доезжает к ней с потолком угловой
  // скорости. Мяч при этом летит точно по прицелу: направление удара считается
  // отдельно и от угла корпуса не зависит — как в жизни, где мяч уходит раньше,
  // чем корпус закончил доворот.
  faceStrike(angle) {
    const P = CONFIG.player;
    this._faceLock = angle;
    this._faceLockT = P.strikeFaceTime;
    // Небольшой рывок сразу — иначе на быстром пасе доворот вообще не читается
    let d = angle - this.rot;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const step = P.turnMax * (1 / 60);
    this.rot += Math.max(-step, Math.min(step, d));
  }

  // Довести корпус к цели удара. Возвращает true, если цель ещё жива и обычный
  // разворот по ходу движения в этом кадре применять не надо.
  _driveFaceLock(dt) {
    if (this._faceLockT == null || this._faceLockT <= 0) return false;
    this._faceLockT -= dt;
    let d = this._faceLock - this.rot;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const step = CONFIG.player.turnMax * dt;
    if (Math.abs(d) <= step) {
      this.rot = this._faceLock;
      this._faceLockT = 0;
      return true;
    }
    this.rot += Math.sign(d) * step;
    return true;
  }

  // Доворот одной кости поверх позы клипа (порядок YXZ: сначала в сторону,
  // потом вверх-вниз, потом завал). Кость ищем лениво и кэшируем.
  _applyBone(bone, yaw, pitch, roll = 0) {
    if (!bone) return;
    if (Math.abs(yaw) < 1e-4 && Math.abs(pitch) < 1e-4 && Math.abs(roll) < 1e-4) return;
    _poseEuler.set(pitch, yaw, roll, 'YXZ');
    _poseQuat.setFromEuler(_poseEuler);
    bone.quaternion.multiply(_poseQuat);
  }

  // Досрочно погасить одноразовый клип (вбрасывание доиграло, вратарь выпустил
  // мяч). Гасим ЧЕРЕЗ менеджер весов: если обнулить `oneShot` снаружи, его вес
  // останется висеть, а шаговые ступени начнут подниматься независимо —
  // суммарный вес просядет ниже единицы, и three.js подмешает позу покоя.
  cancelOneShot() {
    this.endOneShot();
  }

  // Клип касания по ВИДУ действия и по бьющей ноге.
  //
  // Ногу игра уже выбирает физически (kickFoot: мяч слева от корпуса — бьёт
  // левая), но анимация об этом раньше не знала и всегда играла `kick` —
  // клип, который машет ЛЕВОЙ. Теперь под правую ногу идут `kick_run` или
  // `penalty`, и удар наконец совпадает с тем, что решила игра.
  // Внутри подходящей группы вариант выбирается случайно — два одинаковых
  // паса подряд выглядят как повтор кадра.
  playStrike(kind) {
    const table = CONFIG.player.anim.strike[kind];
    if (!table) { this.playOneShot('kick', 1.2, 0.16); return; }
    const foot = (this.lastKick && this.lastKick.foot) || CONFIG.player.dominantFoot;
    let list = table.filter((v) => this.actions[v.clip] && (!v.foot || v.foot === foot));
    if (!list.length) list = table.filter((v) => this.actions[v.clip]);
    if (!list.length) { this.playOneShot('kick', 1.2, 0.16); return; }
    const v = list[Math.floor(Math.random() * list.length)];
    this.playOneShot(v.clip, v.rate, v.at, v.end != null ? v.end : null);
  }

  // --- Поза для повтора (src/replay.js) ---
  // Повтор не пересчитывает игру: он расставляет тела и вручную ставит кадр
  // анимации. Клип не «играет», а замирает на записанном времени — поэтому
  // замедление остаётся замедлением, а не ускоренной перемоткой ног.
  setReplayPose(clipName, clipTime) {
    if (!this.mixer) return;
    const a = this.actions[clipName];
    if (!a) return;
    // Шаговые ступени постоянно играют с весами — на повторе их надо погасить,
    // иначе записанная поза смешалась бы с живым бегом
    if (this.loco) {
      for (const n in this.loco) {
        const e = this.loco[n];
        e.w = 0;
        if (e.a !== a) e.a.setEffectiveWeight(0);
      }
      this.oneShotW = 0;
    }
    if (this.currentAction && this.currentAction !== a) {
      this.currentAction.setEffectiveWeight(0);
    }
    if (this.fadingOneShot && this.fadingOneShot !== a) {
      this.fadingOneShot.setEffectiveWeight(0);
    }
    a.enabled = true;
    a.setEffectiveWeight(1);
    a.paused = true;
    a.timeScale = 1;
    a.play();
    a.time = clipTime;
    this.currentAction = a;
    this.currentName = clipName;
    // Повтор расставляет позы напрямую, и «предыдущая поза» на монтажном стыке
    // ракурсов — чужая: без сброса поправка тянула бы её через новый план
    if (this.poseBlend) this.poseBlend.reset();
    this.mixer.update(0); // применить позу без продвижения времени
  }

  // Выход из повтора: клипы снова играют сами
  endReplayPose() {
    if (!this.mixer) return;
    for (const name in this.actions) this.actions[name].paused = false;
    this.oneShot = null;
    this.oneShotUntil = null;
    this.oneShotW = 0;
    this.fadingOneShot = null;
    // Ступени лестницы снова в игре: без play() они остались бы «мёртвыми»
    // после setReplayPose, и живой игрок замер бы в позе последнего повтора
    if (this.loco) {
      for (const n in this.loco) {
        const e = this.loco[n];
        e.w = 0;
        e.a.paused = false;
        e.a.enabled = true;
        e.a.setEffectiveWeight(0);
        e.a.play();
      }
    }
    this.currentName = null; // следующий кадр сам выберет бег/idle
  }

  reset(x = -3, z = 0, rot = Math.PI / 2) {
    this.group.position.set(x, 0, z);
    // Причёску тоже «телепортируем»: пружина считает разницу положений за
    // кадр, и прыжок фигуры через полполя она бы приняла за рывок головой.
    if (this.hair) this.hair.reset();
    // И память о прошлой позе: после розыгрыша с центра она уже ложь
    if (this.poseBlend) this.poseBlend.reset();
    this.vel.set(0, 0, 0);
    this.rot = rot;
    this.kickCooldown = 0;
    this.hasBall = false;
    this.controlling = false;
    this.pendingStrike = null;
    this.strikeContactLock = false;
    this.chargeRun = false;
    this.dribbleTouchCd = 0;
    this.dribbleDir = null;
    this.ballApproach = null;
    this.ownEpisodeT = 0;
    this.aerialStrike = null;
    this._ignoreShotEdge = false;
    this.sprintBoost = 0;
    this.jumpT = 0;
    this.jumpAge = 0;
    this.jumpDelay = 0;
    this.jumpRise = CONFIG.player.aerial.jumpRise;
    this.jumpFall = CONFIG.player.aerial.jumpFall;
    this.jumpHeight = null;
    this.oneShotUntil = null;
    this.trapCushion = 0;
    this.diveT = 0;
    this.diveDir = null;
    this.diveTilt = null;    // амплитуда РУЧНОГО наклона корпуса в броске
    this.downT = 0;
    this.downDur = 0;
    this.downTiltAmp = null;
    this._gotUp = false;
    this.challengeCd = 0;
    this.tackleT = 0;
    this.tackleDir = null;
    this.tackleHit = false;
    this.tackleFoul = false;
    this.tackleCd = 0;
    this.tackleSpeed = 0;
    this.runCd = 0;          // кулдаун рывка без мяча (ресёрч 15: 5–6 с)
    this.slideRecover = false;
    this._tackleVictim = null;
    this.group.position.y = 0;
    this.group.rotation.x = 0;
    if (this.ai) {
      this.ai.dribDir = null;  // мозг AI начинает с чистого листа
      this.ai.holding = false; // кипер не «держит» несуществующий мяч
      this.ai.holdAge = 0;
      this.ai.act = null;
      this.ai.dropkickStarted = false;
    }
    this.group.rotation.y = rot;
    this.shadow.position.x = x;
    this.shadow.position.z = z;
  }

  get facing() {
    return new THREE.Vector3(Math.sin(this.rot), 0, Math.cos(this.rot));
  }

  // Середина кистей скелета в мировых координатах — точка «мяч в руках».
  // null, пока модель не загрузилась (остаёмся на капсуле-фолбэке)
  handsWorldPoint(out) {
    if (!this.model) return null;
    if (this._handL === undefined) {
      this._handL = this.model.getObjectByName('mixamorigLeftHand') || null;
      this._handR = this.model.getObjectByName('mixamorigRightHand') || null;
    }
    if (!this._handL || !this._handR) return null;
    this._handL.getWorldPosition(_handA);
    this._handR.getWorldPosition(_handB);
    return out.copy(_handA).add(_handB).multiplyScalar(0.5);
  }

  // Точка удара в мировых координатах: носок бьющей ноги (клип `kick` бьёт
  // ЛЕВОЙ, клип `tackle` метёт ПРАВОЙ — проверено по риггу) или голова.
  // Нужна, чтобы в кадре контакта мяч оказался ровно на бутсе/лбу, а не
  // «примерно рядом с игроком». null, пока модель не загрузилась.
  strikePointWorld(styleName, out) {
    if (!this.model) return null;
    if (this._bootBone === undefined) {
      this._bootBone = this.model.getObjectByName('mixamorigLeftToeBase') || null;
      this._headBone = this.model.getObjectByName('mixamorigHead') || null;
      this._slideBone = this.model.getObjectByName('mixamorigRightToeBase') || null;
    }
    let bone = this._bootBone;
    if (styleName === 'header') bone = this._headBone;
    // Подкат метёт ПРАВОЙ, удар через себя тоже бьёт правой (замер по риггу) —
    // а `_bootBone` это ЛЕВЫЙ носок, потому что клип `kick` левоногий
    else if (styleName === 'tackle' || styleName === 'bicycle') bone = this._slideBone;
    if (!bone) return null;
    bone.getWorldPosition(out);
    if (styleName !== 'header') out.y = Math.max(out.y, CONFIG.ball.radius);
    return out;
  }

  // Текущий потолок скорости бега (спринт учтён) — для честного прогноза
  // встречи с мячом. Совпадает с расчётом maxSpeed в update()/aiUpdate().
  _runSpeedCap() {
    const P = CONFIG.player;
    const m = this.team && this.team.match;
    const base = P.speed * (m && m.controlled === this ? 1 : CONFIG.ai.speedFactor);
    return base * (1 + (P.sprintFactor - 1) * this.sprintBoost);
  }

  // Куда игрок будет бить (единичный вектор): в чужие ворота — туда же за время
  // замаха доворачивается корпус, значит туда смотрит и бьющая нога
  _strikeAimDir(fromX, fromZ) {
    if (this.team) {
      const dx = this.team.attackGoalX - fromX;
      const dz = -fromZ;
      const d = Math.hypot(dx, dz);
      if (d > 0.01) return { x: dx / d, z: dz / d };
    }
    const f = this.facing;
    return { x: f.x, z: f.z };
  }

  // Прогноз встречи мяча с ТОЧКОЙ УДАРА (бутса/лоб, а не «центр игрока»).
  // Мини-симуляция той же физики, что в ball.update (гравитация + квадратичный
  // drag + Магнус); игрок при этом бежит в точку прилёта — ровно так его ведёт
  // обязательство замыкания в update(). Отсюда пляшет ВЕСЬ синхрон замыкания:
  // темп клипа, момент прыжка, доворот корпуса, куда встать ногами.
  // Возвращает { t, x, y, z, dist, tx, tz }, где x/y/z — мяч в миг удара,
  // tx/tz — куда встать ИГРОКУ (под волей это на шаг ЗА точку прилёта).
  // styleLock: во время замаха клип уже выбран, и прогноз обязан искать контакт
  // ИМЕННО этой точкой удара (голова/нога). Без замка мяч, круто падающий ниже
  // головы, «переопределял» встречу на ногу — кивок бил на полметра выше мяча.
  predictAerialContact(ball, maxT = CONFIG.player.aerial.readHorizon, styleLock = null) {
    const P = CONFIG.player;
    const A = P.aerial;
    const SY = A.sync;
    const B = CONFIG.ball;
    const APP = P.approach;
    const pos = this.group.position;
    const bp = ball.mesh.position;
    const runMax = this._runSpeedCap();
    const land = predictLanding(ball, A.contactY);
    const landX = land ? land.x : bp.x;
    const landZ = land ? land.z : bp.z;
    const aim = this._strikeAimDir(landX, landZ);

    // КУДА ВСТАВАТЬ НОГАМИ. Точка удара вынесена вперёд от центра фигуры, и
    // раньше её всегда откладывали ПРОТИВ направления на ворота: tx = landX −
    // aim.x · ahead. Пока мяч приходит спереди, это верно. Но если навес падает
    // ЗА СПИНУ, точка оказывается ещё дальше назад, и обязательство замыкания
    // честно ведёт игрока НАЗАД — тот самый «нереалистично отходит назад»
    // (замер на стенде tools/anim-rig.js → aerialTrace: игрок пятился на 7.65 м
    // от ворот, разгоняясь до 6.4 м/с, и только потом бил).
    //
    // Мяч, падающий за спину, замыкать НЕЛЬЗЯ по построению: чтобы попасть по
    // нему в створ, надо оказаться ещё дальше от ворот, чем он. Поэтому вынос
    // откладывается не от оси удара, а от НАПРАВЛЕНИЯ ПРИХОДА МЯЧА — игрок
    // встречает подачу лицом к ней, как в жизни, и остаётся на месте.
    const bvx = ball.vel.x;
    const bvz = ball.vel.z;
    const bvl = Math.hypot(bvx, bvz);
    // «Мяч идёт мне в спину» = его горизонтальный курс совпадает с курсом на
    // ворота, то есть он и так летит туда, куда я собирался бить
    const towardGoal = bvl > 0.5 ? (bvx / bvl) * aim.x + (bvz / bvl) * aim.z : 0;
    const meetX = bvl > 0.5 && towardGoal > CONFIG.player.aerial.meetCos ? -bvx / bvl : aim.x;
    const meetZ = bvl > 0.5 && towardGoal > CONFIG.player.aerial.meetCos ? -bvz / bvl : aim.z;

    // Один прогон с заданным выносом точки удара вперёд от корпуса
    const sweep = (ahead) => {
      // Ноги целятся так, чтобы В ТОЧКЕ ПРИЛЁТА оказалась бутса/лоб, а не живот
      const tx = landX - meetX * ahead;
      const tz = landZ - meetZ * ahead;
      let x = bp.x; let y = bp.y; let z = bp.z;
      let vx = ball.vel.x; let vy = ball.vel.y; let vz = ball.vel.z;
      let spin = ball.spin;
      let px = pos.x; let pz = pos.z;
      let pvx = this.vel.x; let pvz = this.vel.z;
      const dt = 1 / 90; // мельче кадра: момент контакта нужен точнее рендера
      let best = null;
      for (let t = dt; t <= maxT; t += dt) {
        vy += B.gravity * dt;
        const sp = Math.hypot(vx, vy, vz);
        if (sp > 0.01) {
          const d = Math.min(B.dragK * sp * dt, 0.5);
          vx *= 1 - d; vy *= 1 - d; vz *= 1 - d;
        }
        if (Math.abs(spin) > 0.01) {
          const sx = vx; const sz = vz;
          vx += -sz * spin * B.magnus * dt;
          vz += sx * spin * B.magnus * dt;
          spin *= Math.pow(B.spinDecay, dt * 60);
        }
        x += vx * dt; y += vy * dt; z += vz * dt;
        // Ноги: разгон к своей точке с торможением у неё (как arrive в update)
        const dxr = tx - px;
        const dzr = tz - pz;
        const dr = Math.hypot(dxr, dzr) || 1;
        const gas = Math.min(1, dr / APP.strikeHoldRadius);
        const ak = Math.min(1, dt * APP.accel);
        pvx += ((dxr / dr) * runMax * gas - pvx) * ak;
        pvz += ((dzr / dr) * runMax * gas - pvz) * ak;
        px += pvx * dt; pz += pvz * dt;
        // Точка удара этого мига: нога вынесена вперёд, голова над корпусом;
        // по высоте достаём не выше, чем позволяют клип и выпрыг
        const bike = styleLock === 'bicycle';
        const head = styleLock ? styleLock === 'header' : y >= A.headerY;
        const off = bike ? SY.bicycleAhead : (head ? SY.headAhead : SY.bootAhead);
        const sxp = px + meetX * off;
        const szp = pz + meetZ * off;
        const syp = bike
          ? Math.min(y, SY.bicycleHitY)
          : head
            ? Math.min(y, SY.headHitY + A.jumpHeight)
            : Math.min(y, this.volleyHitY(y) + SY.volleyHopMax);
        const d3 = Math.hypot(x - sxp, y - syp, z - szp);
        if (d3 <= SY.hitRadius) return { t, x, y, z, dist: d3, tx: px, tz: pz };
        if (!best || d3 < best.dist) best = { t, x, y, z, dist: d3, tx: px, tz: pz };
        else if (d3 > best.dist + 0.5) break; // ближайшую точку прошли
        if (y < B.radius) break;              // мяч уже на газоне
      }
      return best || { t: 0, x: bp.x, y: bp.y, z: bp.z, dist: Infinity, tx: pos.x, tz: pos.z };
    };

    // Два прохода: первый узнаёт высоту контакта (значит, чем бьём), второй
    // ставит ноги под нужный вынос — под волей это шаг назад от точки прилёта.
    // Если стиль уже зафиксирован замахом, первый проход не нужен.
    if (styleLock) {
      return sweep(styleLock === 'header' ? SY.headAhead : SY.bootAhead);
    }
    const first = sweep(0);
    const ahead = first.y >= A.headerY ? SY.headAhead : SY.bootAhead;
    return ahead > 0.02 ? sweep(ahead) : first;
  }

  // Выпрыг под замыкание: голова — полноценный прыжок, высокий волей — короткий
  // подскок, чтобы бутса дошла до мяча (в клипе она поднимается лишь на ~0.5 м).
  // Верхняя точка в обоих случаях приходится ровно на миг контакта.
  _scheduleStrikeJump(styleName, tHit, contactY, charge) {
    const A = CONFIG.player.aerial;
    const SY = A.sync;
    // Прыгаем РОВНО НА СКОЛЬКО НАДО, чтобы лоб/бутса пришли на мяч. Раньше
    // кивок всегда шёл с полным выпрыгом, и по мячу на уровне груди игрок
    // выпрыгивал так, что лоб проходил на полметра выше (фидбек «по позициям»).
    // Сила нажатия по-прежнему решает: тапом высокий мяч не достать.
    const need = this._strikeJumpNeed(styleName, contactY, charge);
    if (need > 0.04) this.startJump(tHit, need);
  }

  // На сколько подпрыгнуть, чтобы точка удара пришла на мяч (м)
  _strikeJumpNeed(styleName, contactY, charge) {
    const A = CONFIG.player.aerial;
    const SY = A.sync;
    // У удара через себя полёт тела нарисован в самом клипе (таз 1.02 → 0.14):
    // второй, искусственный выпрыг сложился бы с ним и унёс фигуру в небо
    if (styleName === 'bicycle') return 0;
    if (styleName === 'header') {
      const cap = A.jumpHeight *
        (1 - A.jumpChargeH + A.jumpChargeH * Math.min(1, charge));
      return Math.min(cap, contactY - SY.headHitY);
    }
    return Math.min(SY.volleyHopMax, contactY - this.volleyHitY(contactY) - SY.volleyHopSlack);
  }

  // Чем бьём волей на этой высоте и на какой высоте окажется точка удара.
  //
  // Раньше волей ВСЕГДА играл наземный клип `kick`, у которого точка удара —
  // носок на высоте 0.06 м. Мяч на бедре и на груди приходилось «догонять»
  // подскоком, а нога всё равно проходила низом: замер по риггу показал, что в
  // вымеренном кадре контакта носок стоит на 6 см от газона. Теперь мяч выше
  // kneeFrom бьётся КОЛЕНОМ (клипы knee_r/knee_l, точка удара на 1.07 м) —
  // так, как его бьют в жизни, и без всякого подскока.
  volleyHitY(contactY) {
    const SY = CONFIG.player.aerial.sync;
    return contactY >= SY.kneeFrom ? SY.kneeHitY : SY.bootHitY;
  }

  // Стоит ли игрок спиной к своей цели — условие удара через себя.
  // Считаем не по взгляду (он мог отстать), а по геометрии: точка удара между
  // игроком и воротами означает «мяч передо мной», а не «за спиной».
  _backToGoal(hit) {
    if (!this.team) return false;
    const gx = this.team.attackGoalX;
    const pos = this.group.position;
    const dgx = gx - pos.x;
    const dgz = -pos.z;
    const dg = Math.hypot(dgx, dgz) || 1;
    // Направление на мяч в миг контакта
    const dbx = hit.x - pos.x;
    const dbz = hit.z - pos.z;
    const db = Math.hypot(dbx, dbz);
    if (db < 0.3) {
      // Мяч падает прямо на голову — решает взгляд
      const f = this.facing;
      return (f.x * dgx + f.z * dgz) / dg < -CONFIG.player.aerial.bicycleCos;
    }
    return (dbx * dgx + dbz * dgz) / (db * dg) < -CONFIG.player.aerial.bicycleCos;
  }

  // Клип волея под высоту и бьющую ногу
  volleyClip(contactY) {
    const SY = CONFIG.player.aerial.sync;
    const foot = (this.lastKick && this.lastKick.foot) || CONFIG.player.dominantFoot;
    if (contactY >= SY.kneeFrom) {
      const n = foot === 'L' ? 'knee_l' : 'knee_r';
      if (this.actions[n]) return n;
    }
    return foot === 'L' || !this.actions.kick_r ? 'kick' : 'kick_r';
  }

  // Прыжок под удар головой с верхней точкой РОВНО на контакте (hitIn сек).
  // Мячу лететь дольше подъёма — толчок откладывается (jumpDelay), а не
  // растягивается: иначе выпрыг выглядит «вязким», как в аркадах.
  startJump(hitIn, height) {
    const A = CONFIG.player.aerial;
    const rise = Math.max(0.08, Math.min(A.jumpRiseMax, hitIn));
    this.jumpDelay = Math.max(0, hitIn - rise);
    this.jumpRise = rise;
    this.jumpFall = A.jumpFall;
    this.jumpAge = 0;
    this.jumpT = this.jumpDelay + rise + A.jumpFall;
    this.jumpHeight = height;
  }

  // Мяч живёт в руках: каждый кадр следует за кистями по всей анимации —
  // ловля в прыжке, падение, подъём, замах выброса (фидбек Олега 22.07:
  // «мяч висел в центре, пока вратарь падал»). Вызывать ПОСЛЕ aiUpdate,
  // когда микшер уже продвинул позу кадра. Фолбэк — перед грудью.
  holdBallInHands(ball, fallbackY = 1.05) {
    const bp = ball.mesh.position;
    const mid = this.handsWorldPoint(_handA);
    if (mid) {
      bp.set(mid.x, Math.max(CONFIG.ball.radius, mid.y), mid.z);
    } else {
      const f = this.facing;
      const pos = this.group.position;
      bp.set(pos.x + f.x * 0.5, fallbackY, pos.z + f.z * 0.5);
    }
    ball.vel.set(0, 0, 0);
    ball.spin = 0;
  }

  // Передача управления не должна обрывать AI-погоню, а резкий поворот после
  // спринтерского толчка не должен уводить футболиста мимо мяча. Оба случая
  // используют один короткий latch: ноги добегают, стик хранит будущий курс.
  beginBallApproach(kind, ball) {
    const A = CONFIG.player.approach;
    const bp = ball.mesh.position;
    const pos = this.group.position;
    const dist = Math.hypot(bp.x - pos.x, bp.z - pos.z);
    if (kind === 'switch' && dist > A.maxSwitchDist) return false;
    this.ballApproach = {
      kind,
      ttl: kind === 'switch' ? A.switchTimeout : A.dribbleTimeout,
      age: 0,
      closest: dist,
      missArmed: dist <= A.missArmDist,
      contactArmed: kind === 'switch',
      controlTime: 0,
      intent: null,
    };
    return true;
  }

  cancelBallApproach() {
    this.ballApproach = null;
  }

  // Две честные границы завершения автодобегания:
  // 1) мяч действительно отходил — ждём нового физического касания;
  // 2) слабый толчок вообще не отделил мяч от бутсы — подтверждённое владение
  //    и одинаковая скорость означают, что руль уже можно отдать человеку.
  // Формального владения одного кадра недостаточно: controlTime принадлежит
  // самому latch и копит одинаковое реальное время на экранах 30–120 Гц.
  _ballApproachComplete(a, ball, dist) {
    const P = CONFIG.player;
    const A = P.approach;
    const bp = ball.mesh.position;
    if (a.contactArmed && dist <= A.contactRadius) return true;

    const pos = this.group.position;
    const dx = bp.x - pos.x;
    const dz = bp.z - pos.z;
    const relVx = ball.vel.x - this.vel.x;
    const relVz = ball.vel.z - this.vel.z;
    const separatingSpeed = (dx * relVx + dz * relVz) / Math.max(dist, 0.001);

    // Неотделившийся мяч снова вошёл в физический контакт. Быстро летящий
    // НА игрока мяч тоже честно считается касанием; уходящий — ещё нет.
    if (a.kind === 'dribble' && !a.contactArmed && a.age >= A.settleTime &&
        dist <= A.contactRadius && separatingSpeed <= A.settleSpeed) return true;

    // Расширенная зона «у бутсы» допустима только для мяча, который устойчиво
    // принадлежит игроку и целиком движется вместе с ним. Одна лишь
    // радиальная скорость пропустила бы быстрый мяч, скользящий поперёк ноги.
    const stableControl = a.controlTime >= A.settleTime && this.isToucher === true &&
      dist <= P.stickyRadius && bp.y < CONFIG.ball.radius * 2.2;
    if (!stableControl || Math.hypot(relVx, ball.vel.y, relVz) > A.settleSpeed) return false;

    // switch: владение подтверждено непрерывным интервалом реального времени;
    // dribble: короткая пауза отличает слабый толчок от начала настоящего ухода.
    return a.kind === 'switch' || (!a.contactArmed && a.age >= A.settleTime);
  }

  // Анимация по движению — общая для человека и AI (вызывать раз в кадр).
  // Клип выбирается по соотношению скорости и взгляда: бег вперёд, приставные
  // шаги вбок (strafe), бег спиной (run_back). Вратарь стоит своей стойкой
  // (gk_idle, руки наготове) — фидбек Олега 18.07.2026 «отбивает ногами».
  _updateAnim(dt, speed) {
    const P = CONFIG.player;
    // Прыжок под удар головой: несимметричная дуга — резкий толчок вверх
    // (jumpRise) и падение (jumpFall). ВЕРХНЯЯ ТОЧКА ставится ровно на миг
    // контакта: startJump растягивает подъём под прогноз прилёта мяча, а
    // jumpDelay откладывает толчок, если мячу лететь ещё долго.
    if (this.jumpT > 0) {
      const A = P.aerial;
      this.jumpT -= dt;
      this.jumpAge += dt;
      const h = this.jumpHeight != null ? this.jumpHeight : A.jumpHeight;
      const a = this.jumpAge - this.jumpDelay;
      let y = 0;
      if (a > 0) {
        y = a < this.jumpRise
          ? Math.sin((a / this.jumpRise) * Math.PI * 0.5) * h        // толчок
          : Math.max(0, 1 - ((a - this.jumpRise) / this.jumpFall) ** 2) * h; // падение
      }
      this.group.position.y = y;
      if (this.jumpT <= 0) { this.group.position.y = 0; this.jumpHeight = null; }
    }
    // Бросок корпусом (ласточка) и подъём: наклон фигуры по взгляду
    // (порядок эйлера YXZ), после броска — лежим и встаём клипом getup.
    // Подкат: клип Mixamo — стоячий выпад, поэтому скольжение рисуем сами —
    // корпус откинут НАЗАД (ноги вперёд), после слайда сидим на газоне
    const DV = P.aerial.dive;
    let tilt = 0;
    // Приём: короткий подсед-отклон корпуса — «мягкие ноги» гасят мяч.
    // Клипа у приёма нет (просьба Олега 23.07), но без единого движения
    // корпуса приём читался как удар мяча о столб
    if (this.trapCushion > 0) {
      this.trapCushion -= dt;
      const T = P.trap;
      const k = Math.max(0, this.trapCushion) / T.cushionTime;
      tilt = -Math.sin(Math.PI * (1 - k)) * T.cushionTilt;
    }
    if (this.tackleT > 0 || this.slideRecover) {
      // Подкат: наклон не трогаем — весь силуэт (скольжение + вставание)
      // даёт сам клип `tackle`, который продолжает играть в фазе recover
      tilt = 0;
      if (this.tackleT <= 0 && this.downT > 0) {
        this.downT -= dt;
        if (this.downT <= 0) this.slideRecover = false;
      }
    } else if (this.diveT > 0) {
      this.diveT -= dt;
      // Длительность и время подъёма — свои у полевой ласточки и у броска
      // вратаря (у кипера они из CONFIG.ai.keeper)
      const dur = this.diveDur || DV.time;
      const rec = this.diveRecover != null ? this.diveRecover : DV.recover;
      // Амплитуда наклона — СВОЙСТВО БРОСКА, а не общая константа. Полевая
      // «ласточка» играет СТОЯЧИЙ клип (kick/header), и весь силуэт падения
      // даёт именно этот наклон. А вратарский gk_dive уже содержит и падение,
      // и подъём (промер по риггу: бёдра 0.95 → 0.18 → 0.92 м) — второй
      // поворот складывался с первым, и вратарь уходил головой на 1.44 м ПОД
      // ГАЗОН на целую секунду (фидбек Олега 26.07: «проваливается и исчезает»)
      const amp = this.diveTilt != null ? this.diveTilt : DV.tiltMax;
      tilt = (1 - Math.max(0, this.diveT) / dur) * amp;
      if (this.diveT <= 0) {
        this.downT = rec;
        this.downDur = rec;
        this.downTiltAmp = amp;
        this._gotUp = false;
      }
    } else if (this.downT > 0) {
      this.downT -= dt;
      const k = Math.max(0, this.downT) / (this.downDur || DV.recover);
      if (this._fallPhase) {
        // Сбитый игрок: цепочка trip → fallen → getup ведёт себя сама, наклон
        // группы не нужен вовсе — весь силуэт даёт клип
        this._updateFall(dt);
        if (this.downT <= 0) this._fallPhase = null;
      } else {
        // Полевая «ласточка» играет СТОЯЧИЙ клип, и весь силуэт падения даёт
        // именно ручной наклон — ему и нужен getup в середине лёжки
        if (k < 0.55 && !this._gotUp && (this.downTiltAmp || 0) > 0) {
          this._gotUp = true;
          this.playOneShot('getup', CONFIG.player.fall.getupRate, 0,
            null, blendTime('getup'));
        }
        const amp = this.downTiltAmp != null ? this.downTiltAmp : DV.tiltMax;
        tilt = Math.min(1, k / 0.55) * amp; // поднимаемся вместе с getup
      }
    }
    this.group.rotation.x = tilt;
    if (this.mixer) {
      // Хвост клипа удара обрезан (oneShotUntil): проводка доиграна — ноги
      // сразу возвращаются в бег, эпизод не проседает
      // История выходной позы — ДО всего: в костях сейчас стоит итог прошлого
      // кадра, и другого шанса его запомнить не будет. Из двух прошлых кадров
      // берётся не только поза на миг переключения, но и её СКОРОСТЬ — без неё
      // переход сшить нечем (см. замер в шапке src/pose.js).
      if (this.poseBlend) this.poseBlend.track();
      this._updateHitStop(dt);
      if (this.oneShot && this.oneShotUntil != null &&
          this.oneShot.time >= this.oneShotUntil) {
        this.trapCushion = 0;
        this.endOneShot();
      }
      this.updateLoco(dt, speed);
      this.mixer.update(dt);
      // Поправка позы — СРАЗУ после микшера и ДО всего остального: слои «живой
      // корпус», причёска и ткань обязаны видеть уже сшитую позу, иначе голова
      // и хвост поедут по несшитой и опоздают на кадр.
      if (this.poseBlend) this.poseBlend.apply();
      this.lockRootXZ();
      this.updatePose(dt, speed);
      // Волосы и ткань — ПОСЛЕДНИМИ. Раньше нельзя: и микшер, и слой «живой
      // корпус» переписывают поворот головы, и причёска поехала бы за ним
      // с опозданием на кадр.
      if (this.hair) this.hair.update(dt);
      if (this.cloth) updateCloth(this.cloth, this.kitMesh, this.vel, this.locoPhase);
    } else {
      // Капсула-фолбэк: лёгкое покачивание вместо анимаций
      this.bobT += dt * speed * 1.8;
      this.body.position.y = P.height / 2 + Math.abs(Math.sin(this.bobT)) * 0.06 * (speed / P.speed);
    }
  }

  // ===== AI-канал управления («ноги» исполняют решения мозга из src/ai/) =====

  // Движение AI-игрока: та же физика разгона/разворота, что у человека,
  // но без ввода. move — желаемый вектор 0..1; opts: sprint, face (угол,
  // куда смотреть стоя на месте). Вызывается ровно раз в кадр вместо update().
  aiUpdate(dt, move, opts = {}) {
    const P = CONFIG.player;
    const F = CONFIG.field;
    const pos = this.group.position;

    if (this.kickCooldown > 0) this.kickCooldown -= dt;
    if (this.challengeCd > 0) this.challengeCd -= dt;
    if (this.tackleCd > 0) this.tackleCd -= dt;
    // Эпизод владения тает и у AI: updateToucher смотрит его у всех 22,
    // иначе бывший управляемый «зависал» вечным хозяином оттолкнутого мяча
    if (this.ownEpisodeT > 0) this.ownEpisodeT -= dt;

    // Лежим после броска — не двигаемся; в броске — несёт по курсу ласточки;
    // в подкате — скользим по слайду
    if (this.downT > 0) move = { x: 0, z: 0 };
    else if (this.diveT > 0 && this.diveDir) move = this.diveDir;
    else if (this.tackleT > 0 && this.tackleDir) move = this.tackleDir;

    const sprinting = !!opts.sprint;
    const boostK = sprinting ? Math.min(1, dt * 12) : Math.min(1, dt / P.sprintInertia);
    this.sprintBoost += ((sprinting ? 1 : 0) - this.sprintBoost) * boostK;

    let maxSpeed = P.speed * CONFIG.ai.speedFactor *
      (this.isToucher ? P.dribbleSpeedFactor : 1);
    maxSpeed *= 1 + (P.sprintFactor - 1) * this.sprintBoost;
    // Кап скорости от мозга: сдерживающий защитник зеркалит темп владельца
    if (opts.speedCap != null) maxSpeed = Math.min(maxSpeed, opts.speedCap);
    // В броске скорость ЗАДАЁТСЯ, а не «берётся максимум»: у вратаря она своя
    // и заметно ниже обычного бега. С Math.max кипер летел в броске 6.4 м/с
    // вместо положенных 3.4 и накрывал руками весь створ (замер 26.07)
    if (this.diveT > 0) maxSpeed = this.diveSpeed || P.aerial.dive.lunge;
    if (this.tackleT > 0) {
      const kT = Math.max(0, this.tackleT / P.tackle.time);
      const sTop = this.tackleSpeed || P.tackle.speedMin;
      maxSpeed = P.tackle.speedEnd + (sTop - P.tackle.speedEnd) * kT;
    }

    let mvx = move.x;
    let mvz = move.z;
    const il = Math.hypot(mvx, mvz);
    if (il > 1) {
      mvx /= il;
      mvz /= il;
    }

    const k = Math.min(1, dt * P.accel);
    this.vel.x += (mvx * maxSpeed - this.vel.x) * k;
    this.vel.z += (mvz * maxSpeed - this.vel.z) * k;
    pos.x += this.vel.x * dt;
    pos.z += this.vel.z * dt;

    // AI не выбегает за поле дальше пары метров
    const maxX = F.length / 2 + 2;
    const maxZ = F.width / 2 + 2;
    pos.x = Math.max(-maxX, Math.min(maxX, pos.x));
    pos.z = Math.max(-maxZ, Math.min(maxZ, pos.z));

    // Корпус: бежим — смотрим по ходу; стоим — куда велел мозг (обычно на мяч)
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (this._driveFaceLock(dt)) {
      // Корпус доезжает в только что нанесённый удар — руль на это время его
    } else if (this.aerialStrike && this.aerialStrike.aimRot != null) {
      this._turnIntoStrike(dt); // замах замыкания: корпус приходит в удар к контакту
    } else {
      let want = null;
      // ВРАТАРЬ СМОТРИТ В ПОЛЕ, А НЕ ПО ХОДУ ДВИЖЕНИЯ (правило с 28.07.2026).
      // Прежняя строка «бежим — смотрим по ходу» верна для полевого и НЕВЕРНА
      // для кипера: он ходит по дуге приставным шагом и пятится к линии, не
      // отрывая глаз от мяча. Без замка вратарь, возвращающийся на ленточку,
      // разворачивался К СВОИМ ВОРОТАМ — то есть стоял спиной к мячу и к полю
      // (фидбек Олега 28.07.2026). Замок заодно ВКЛЮЧАЕТ нужную лестницу:
      // движение поперёк взгляда само выбирает приставной шаг (gk_side_*),
      // а движение назад — run_back. Клипы были, но выбирать их было нечему.
      if (opts.face != null && (opts.faceLock || speed <= 0.5)) want = opts.face;
      else if (speed > 0.5) want = Math.atan2(this.vel.x, this.vel.z);
      if (want != null) {
        let d = want - this.rot;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        const turn = P.turnRate * (1 - (1 - P.sprintTurnFactor) * this.sprintBoost);
        const step = P.turnMax * dt;
        this.rot += Math.max(-step, Math.min(step, d * Math.min(1, turn * dt)));
      }
    }
    this.group.rotation.y = this.rot;

    this._updateAnim(dt, speed);
    this.shadow.position.x = pos.x;
    this.shadow.position.z = pos.z;
  }

  // Ведение AI: мяч у ноги подтягивается в сторону курса (как липкое
  // ведение человека, но без ввода). Работает только на владеющем (isToucher).
  aiDribble(dt, ball, dirX, dirZ) {
    const P = CONFIG.player;
    const bp = ball.mesh.position;
    const pos = this.group.position;
    if (this.kickCooldown > 0 || bp.y > CONFIG.ball.radius * 2.2) return;
    const dist = Math.hypot(bp.x - pos.x, bp.z - pos.z);
    if (dist > P.stickyRadius) return;
    const tx = pos.x + dirX * P.dribbleAhead;
    const tz = pos.z + dirZ * P.dribbleAhead;
    ball.vel.x = this.vel.x + (tx - bp.x) * P.dribbleStrength;
    ball.vel.z = this.vel.z + (tz - bp.z) * P.dribbleStrength;
  }

  // Удар AI: пас/выстрел/вынос — обычный strike с анимацией и кулдауном.
  // anim: строка — ВИД касания (см. CONFIG.player.anim.strike), объект —
  // конкретный клип (так вратарь играет свои ловли и выбросы).
  //
  // Раньше AI вообще не считал бьющую ногу — и все 22 фигуры весь матч били
  // одним левоногим клипом. Теперь нога определяется тем же правилом, что у
  // человека, и ДО доворота корпуса: важно, слева или справа мяч был
  // относительно СТАРОГО взгляда, а не после разворота в удар.
  aiKick(ball, dir, power, lift, curl = 0, anim = null) {
    const d = Math.hypot(dir.x, dir.z) || 1;
    const ndir = { x: dir.x / d, z: dir.z / d };
    const foot = this.kickFoot(ball);
    ball.strike(ndir, power, lift, curl);
    this.lastKick = { foot, contact: 'inside' };
    this.faceStrike(Math.atan2(ndir.x, ndir.z)); // корпус ДОЕЗЖАЕТ в удар, не щёлкает
    this.kickCooldown = CONFIG.player.kickCooldown;
    this.ownEpisodeT = 0; // передача закрывает эпизод владения
    if (typeof anim === 'string') this.playStrike(anim);
    else if (anim) this.playOneShot(anim.name, anim.ts, anim.at, anim.end);
    else this.playStrike('pass');
  }

  update(dt, input, ball) {
    const P = CONFIG.player;
    const APP = P.approach;
    const F = CONFIG.field;
    const pos = this.group.position;

    if (this.kickCooldown > 0) this.kickCooldown -= dt;
    if (this.challengeCd > 0) this.challengeCd -= dt;
    if (this.tackleCd > 0) this.tackleCd -= dt;
    this.updateTackle(dt, ball); // скольжение подката и его контакты
    const downed = this.downT > 0; // лежим после броска — ввод не работает

    // Замах удара, два режима (решение Олега, 17.07.2026):
    // - начал замах НА БЕГУ (быстрее runKeepSpeed) — бег продолжается, будет
    //   удар с хода подъёмом; стрелки продолжают рулить бегом;
    // - начал С МЕСТА / на шаге — прицельная стойка: игрок тормозит, взгляд
    //   заморожен, стрелки двигают прицел по створу (щечка, как раньше)
    const aiming = input.shot.held;
    const speedNow = Math.hypot(this.vel.x, this.vel.z);
    if (aiming && !this.chargeRun && speedNow > CONFIG.shot.runKeepSpeed) this.chargeRun = true;
    if (!aiming) this.chargeRun = false;
    const bpEarly = ball.mesh.position;
    // Прицельная стойка — только под мяч, который реально играется с газона.
    // Если мяч ЛЕТИТ на игрока, удержание D означает заказ ЗАМЫКАНИЯ: ноги
    // обязаны бежать под мяч, а не вкапываться в газон. Раньше игрок замирал
    // и навес проходил в метре от него (замер в живой игре 24.07)
    const aerialIntent = !!this.aerialStrike ||
      (aiming && !downed && this.diveT <= 0 && this.kickCooldown <= 0 &&
        bpEarly.y > P.kickMaxBallY && ball.vel.y < 2 &&
        Math.hypot(bpEarly.x - pos.x, bpEarly.z - pos.z) < APP.strikePursuitRange * 2);
    const brake = aiming && !this.chargeRun && !aerialIntent;

    // --- Бег: плавный разгон к желаемой скорости (спринт — быстрее) ---
    let sprinting = input.sprint && !brake;
    let approachMove = null;
    let strikeMove = null;
    let approachIntentAtContact = null;

    // На быстром беге кнопка действия превращает стрелки в ПРИЦЕЛ. Пока
    // навес/пас/удар заряжается или ждёт окно дополнительных тапов, ноги
    // сохраняют разбег к мячу и не принимают резкую смену прицела за поворот.
    // В обороне это не включается: без владения S остаётся навалом корпусом.
    const strikeCommitted = !!input.strikeCommitted;
    // «Эпизод владения» покрывает случай, когда спринтерский толчок только что
    // вынес мяч вперёд из зоны контроля (hasBall/isToucher на миг false): игрок
    // ещё хозяин, если мяч рядом, низом и НЕ у соперника (фидбек Олега 22.07:
    // при навесе/ударе на бегу со стиком вбок игрок убегал от мяча).
    const mmatch = this.team && this.team.match;
    const oppHasBall = mmatch && mmatch.toucher &&
      mmatch.toucher !== this && mmatch.toucher.team !== this.team;
    const inEpisode = this.ownEpisodeT > 0 && !oppHasBall &&
      bpEarly.y <= P.kickMaxBallY &&
      Math.hypot(bpEarly.x - pos.x, bpEarly.z - pos.z) < APP.strikePursuitRange;
    const ownsBallForStrike =
      this.isToucher === true || this.hasBall || this.controlling || inEpisode;
    if (strikeCommitted && ownsBallForStrike &&
        (speedNow > P.sprintTouchMinSpeed || this.sprintBoost > 0.35)) {
      this.strikeContactLock = true;
    }
    if (!strikeCommitted && !this.pendingStrike) this.strikeContactLock = false;
    const strikeRunLock = this.strikeContactLock && !brake &&
      !downed && this.diveT <= 0 && bpEarly.y <= P.kickMaxBallY &&
      (speedNow > P.sprintTouchMinSpeed || this.sprintBoost > 0.35);

    // Замах навеса/удара/паса на бегу, но спринтерский толчок вынес мяч вперёд
    // из зоны контроля: поднимаем ТО ЖЕ обязательство добежать, что и при
    // обычном ведении (безлимитная погоня), — ноги гонятся за своим мячом, а
    // стик работает прицелом и не уводит вбок. strikeRunLock один держал мяч
    // лишь в strikePursuitRange, и сильный толчок вырывался за него, унося
    // игрока по стику (фидбек Олега 22.07: «убегает от мяча при навесе/беге»).
    if (this.strikeContactLock && !this.ballApproach && !this.pendingStrike &&
        !brake && !downed && this.diveT <= 0 && bpEarly.y <= P.kickMaxBallY) {
      const ddLock = Math.hypot(bpEarly.x - pos.x, bpEarly.z - pos.z);
      if (ddLock > APP.contactRadius && ddLock < APP.maxSwitchDist) {
        this.beginBallApproach('dribble', ball);
      }
    }

    // Обязательство завершить касание. Пока оно живо, стик запоминается как
    // будущий курс, но ноги каждый кадр пересчитывают погоню за движущимся мячом.
    // Это не магнит мяча: меняется только траектория футболиста.
    if (this.ballApproach) {
      const a = this.ballApproach;
      a.ttl -= dt;
      a.age += dt;
      const intentLen = Math.hypot(input.move.x, input.move.z);
      if (intentLen > APP.intentDeadZone) {
        a.intent = { x: input.move.x / intentLen, z: input.move.z / intentLen };
      }

      const approachDist = Math.hypot(bpEarly.x - pos.x, bpEarly.z - pos.z);
      const controlSeen = this.isToucher === true && approachDist <= P.stickyRadius &&
        bpEarly.y < CONFIG.ball.radius * 2.2;
      a.controlTime = controlSeen ? a.controlTime + dt : 0;
      const unavailable = a.ttl <= 0 || downed || this.diveT > 0 || brake ||
        this.kickCooldown > 0 || bpEarly.y > APP.maxBallY;
      if (unavailable) {
        this.cancelBallApproach();
      } else {
        if (a.kind === 'dribble' && approachDist >= APP.departRadius) a.contactArmed = true;
        a.closest = Math.min(a.closest, approachDist);
        if (a.kind === 'switch') {
          if (approachDist <= APP.missArmDist) a.missArmed = true;
          if (a.missArmed && approachDist > a.closest + APP.missMargin) {
            this.cancelBallApproach(); // добежал в зону, но мяч уже прошёл мимо
          }
        }
        if (this.ballApproach && this._ballApproachComplete(a, ball, approachDist)) {
          approachIntentAtContact = a.intent;
          this.cancelBallApproach();
        }
        if (this.ballApproach) {
          approachMove = pursuitBall(pos.x, pos.z, ball, P.speed * P.sprintFactor);
          if (a.kind === 'switch' && approachDist > APP.autoSprintDist) sprinting = true;
        }
      }
    }

    // Пас или подача адресованы ЭТОМУ игроку (курсор уже на нём): до касания
    // мяча ноги бегут ТОЛЬКО на мяч/точку прилёта — стрелки в это время
    // выбирают направление будущего удара, а не курс бега (фидбек Олега
    // 22.07: замыкающий убегал по стику; теперь правило живёт весь эпизод —
    // и пока подача летит, и когда мяч уже опустился и катится в штрафной).
    // Нажатый удар (pendingStrike) ведёт своей веткой ниже — цель та же.
    let receiverMove = null;
    const rcvTeam = this.team;
    if (rcvTeam && rcvTeam.receiver === this && rcvTeam.receiveTimer > 0 &&
        !this.hasBall && !downed && this.diveT <= 0 && !brake &&
        this.kickCooldown <= 0) {
      let tgt = null;
      if (bpEarly.y > P.kickMaxBallY) {
        // Верховой мяч: к точке прилёта (не за тенью мяча)
        tgt = predictLanding(ball, P.aerial.contactY) || rcvTeam.receiveTarget;
      }
      if (tgt) {
        const dcx = tgt.x - pos.x;
        const dcz = tgt.z - pos.z;
        const dc = Math.hypot(dcx, dcz);
        if (dc > APP.strikeHoldRadius) {
          receiverMove = { x: dcx / dc, z: dcz / dc };
          if (dc > 2) sprinting = true; // далеко от точки — врываемся на скорости
        }
      } else {
        // Мяч низом (пас в ноги / опустившаяся подача): навстречу мячу
        const dBall = Math.hypot(bpEarly.x - pos.x, bpEarly.z - pos.z);
        if (dBall > APP.strikeHoldRadius) {
          receiverMove = pursuitBall(pos.x, pos.z, ball, P.speed * P.sprintFactor);
          if (dBall > 2) sprinting = true;
        }
      }
    }

    // Врывание под замыкание: пока держим D, а мяч ЛЕТИТ на нас, ноги идут к
    // точке встречи — до замаха это точка прилёта, во время замаха её ведёт сам
    // замах. Без этого прицельная стойка вкапывала игрока и навес проходил
    // мимо в метре (замер в живой игре 24.07)
    let aerialTarget = null;
    if (aerialIntent && !downed && this.diveT <= 0) {
      // Цель врывания — та же точка, куда прогноз ставит ноги под удар (под
      // волей это шаг ЗА точку прилёта, чтобы мяч пришёл на бутсу). Во время
      // замаха её ведёт сам замах. Раньше ноги бежали в точку прилёта, а мяч
      // оказывался у живота — бутса промахивалась почти на метр
      if (this.aerialStrike && this.aerialStrike.point) {
        aerialTarget = this.aerialStrike.point;
      } else {
        const pre = this.predictAerialContact(ball, P.aerial.interceptT);
        aerialTarget = pre.dist < Infinity
          ? { x: pre.tx, z: pre.tz }
          : predictLanding(ball, P.aerial.contactY);
      }
      if (aerialTarget) {
        const dTa = Math.hypot(aerialTarget.x - pos.x, aerialTarget.z - pos.z);
        if (dTa > 2 && !this.aerialStrike) sprinting = true; // далеко — врываемся
      }
    }

    // Инерция спринта (фидбек Олега): включается быстро, спадает плавно.
    // Отпустил ⚡/E — темп ещё живёт ~секунду: можно отпустить спринт
    // и тут же пробить с лёта на скорости
    const boostK = sprinting ? Math.min(1, dt * 12) : Math.min(1, dt / P.sprintInertia);
    this.sprintBoost += ((sprinting ? 1 : 0) - this.sprintBoost) * boostK;
    // Кап скорости дриблинга — только когда мяч РЕАЛЬНО у ноги: за своим
    // оттолкнутым мячом бежим в полный спринт. Иначе на развороте 180° мяч
    // после толчка (×1.5 скорости) был быстрее закапанного игрока (гистерезис
    // hasBall тянется до 2.4 м) — вечный отрыв (фидбек Олега 22.07)
    const ballAtFoot = Math.hypot(bpEarly.x - pos.x, bpEarly.z - pos.z) < P.stickyRadius;
    let maxSpeed = P.speed * (this.hasBall && ballAtFoot ? P.dribbleSpeedFactor : 1);
    maxSpeed *= 1 + (P.sprintFactor - 1) * this.sprintBoost;
    let mvx = (brake || downed) ? 0 : input.move.x;
    let mvz = (brake || downed) ? 0 : input.move.z;

    // Бросок корпусом: несёт по курсу ласточки, руль отключён
    if (this.diveT > 0 && this.diveDir) {
      mvx = this.diveDir.x;
      mvz = this.diveDir.z;
      maxSpeed = Math.max(maxSpeed, P.aerial.dive.lunge);
    } else if (this.tackleT > 0 && this.tackleDir) {
      // Подкат: скользим по слайду с затуханием, руль отключён
      mvx = this.tackleDir.x;
      mvz = this.tackleDir.z;
      const kT = Math.max(0, this.tackleT / P.tackle.time);
      const sTop = this.tackleSpeed || P.tackle.speedMin;
      maxSpeed = P.tackle.speedEnd + (sTop - P.tackle.speedEnd) * kT;
    }

    if (strikeRunLock) {
      const dd = Math.hypot(bpEarly.x - pos.x, bpEarly.z - pos.z);
      // Свой мяч на замахе догоняем на всей дистанции эпизода (не только
      // strikePursuitRange): сильный спринт-толчок вырывался за неё
      if (dd < APP.maxSwitchDist) {
        if (dd > APP.strikeHoldRadius) {
          strikeMove = pursuitBall(pos.x, pos.z, ball, P.speed * P.sprintFactor);
        } else {
          // Мяч прямо у бутсы: продолжаем прежний разбег. Использовать здесь
          // input.move нельзя — это и есть направление будущего действия.
          const runLen = Math.hypot(this.vel.x, this.vel.z);
          strikeMove = runLen > 0.4
            ? { x: this.vel.x / runLen, z: this.vel.z / runLen }
            : { x: this.facing.x, z: this.facing.z };
        }
        mvx = strikeMove.x;
        mvz = strikeMove.z;
      }
    }

    // Ожидание исполнения (пас/удар нажат, мяч ещё не в зоне ноги): игрок
    // ДОБЕГАЕТ до мяча сам, а стик в это время рулит НАПРАВЛЕНИЕМ паса,
    // не уводя бег — раньше смена направления в этот момент «убегала от
    // мяча» и пас сгорал (фидбек Олега, 18.07.2026). Так это делает PES:
    // код доводит игрока до касания, направление берётся из намерения.
    if (this.pendingStrike && !brake && !downed && this.diveT <= 0) {
      // Мяч летит верхом, а игрок ждёт удар — бежим не за тенью мяча,
      // а к ТОЧКЕ ПРИЗЕМЛЕНИЯ (замыкание навеса: врывание на прилёт)
      let tx = bpEarly.x;
      let tz = bpEarly.z;
      let range = APP.strikePursuitRange;
      if (bpEarly.y > P.kickMaxBallY &&
          (this.pendingStrike.type === 'shot' || this.pendingStrike.type === 'swipe')) {
        const land = predictLanding(ball, P.aerial.contactY);
        if (land) {
          tx = land.x;
          tz = land.z;
          range = 16; // под навес добегаем издалека
        }
      }
      const dd = Math.hypot(tx - pos.x, tz - pos.z);
      if (dd < range && dd > APP.strikeHoldRadius) {
        mvx = (tx - pos.x) / dd;
        mvz = (tz - pos.z) / dd;
      }
    }

    // pendingStrike уже сам добегает к мячу/точке приземления и имеет приоритет.
    // В остальных случаях latch заменяет боковой ввод жёстким pursuit до контакта.
    if (approachMove && !this.pendingStrike && !brake && !downed && this.diveT <= 0) {
      mvx = approachMove.x;
      mvz = approachMove.z;
    }

    // Бег адресата на мяч — ниже latch/удара по приоритету, но выше
    // бокового стика: пока удар не нажат, ноги идут к мячу/точке прилёта
    if (receiverMove && !this.pendingStrike && !approachMove && !strikeMove) {
      mvx = receiverMove.x;
      mvz = receiverMove.z;
    }

    // Замах замыкания — приоритет надо всем: ноги ДОБЕГАЮТ до точки контакта,
    // а не стоят и не уходят по стику (стрелки в это время — прицел удара).
    // Так рождается врывание: игрок встречает мяч на ходу, и сила разбега
    // уходит в удар (aerial.runPower). Мяч ждать себя не заставляет.
    let aerialMove = null;
    if (aerialTarget) {
      const dax = aerialTarget.x - pos.x;
      const daz = aerialTarget.z - pos.z;
      const da = Math.hypot(dax, daz);
      // ПРИШЁЛ НА ТОЧКУ — НЕ ВКАПЫВАЕМСЯ (правка 28.07.2026).
      //
      // Раньше в этом месте движение обнулялось: `{ x: 0, z: 0 }`. Замер по
      // живой игре: скорость падала с 9.17 до 0.85 м/с за 0.117 с — это
      // торможение 67 м/с², семь g. Игрок замирал столбом и ждал мяч, и это
      // ровно вторая половина фидбека: «бьёт по внезапно остановившемуся мячу
      // в воздухе». Мяч-то летел нормально — стоял ИГРОК, и глаз считывал
      // остановку как остановку мяча.
      //
      // Замыкание — это встреча НА ХОДУ. Точка удара не столб, а линия, через
      // которую надо пробежать: подойдя вплотную, ноги переходят на ДОБОР
      // курса (мягкое подруливание вдоль прихода мяча), а не на стоп. Заодно
      // это и есть просьба «если ловит мяч сходу — то бьёт»: сходу и бьёт,
      // потому что ход никто не отнимает.
      if (da > APP.strikeHoldRadius) {
        aerialMove = { x: dax / da, z: daz / da };
      } else {
        const runLen = Math.hypot(this.vel.x, this.vel.z);
        const keep = APP.strikeGlide;   // доля прежнего курса, которую держим
        if (runLen > 0.6) {
          const ux = this.vel.x / runLen;
          const uz = this.vel.z / runLen;
          const gx = ux * keep + (da > 0.01 ? (dax / da) * (1 - keep) : 0);
          const gz = uz * keep + (da > 0.01 ? (daz / da) * (1 - keep) : 0);
          const gl = Math.hypot(gx, gz) || 1;
          aerialMove = { x: gx / gl, z: gz / gl };
        } else {
          aerialMove = { x: 0, z: 0 };  // и правда стояли — стоим дальше
        }
      }
      mvx = aerialMove.x;
      mvz = aerialMove.z;
    }

    const k = Math.min(1, dt *
      ((approachMove || strikeMove || receiverMove || aerialMove) ? APP.accel : P.accel));
    this.vel.x += (mvx * maxSpeed - this.vel.x) * k;
    this.vel.z += (mvz * maxSpeed - this.vel.z) * k;
    pos.x += this.vel.x * dt;
    pos.z += this.vel.z * dt;

    // Не убегаем дальше зоны за полем
    const maxX = F.length / 2 + F.apron - 2;
    const maxZ = F.width / 2 + F.apron - 2;
    pos.x = Math.max(-maxX, Math.min(maxX, pos.x));
    pos.z = Math.max(-maxZ, Math.min(maxZ, pos.z));

    // Match определяет владельца до движения и запаздывает на кадр, поэтому
    // настоящий первый контакт фиксируем здесь — уже ПОСЛЕ шага футболиста.
    if (this.ballApproach) {
      const contactDist = Math.hypot(bpEarly.x - pos.x, bpEarly.z - pos.z);
      const a = this.ballApproach;
      if (bpEarly.y <= APP.maxBallY && this._ballApproachComplete(a, ball, contactDist)) {
        approachIntentAtContact = a.intent;
        this.cancelBallApproach();
      }
    }

    // --- Разворот корпуса. В прицельной стойке взгляд заморожен.
    // При ведении, пока мяч ДАЛЕКО впереди, игрок смотрит НА МЯЧ и бежит за
    // ним — корпус разворачивается на новый курс только когда мяч рядом с ногой
    // (фидбек Олега: иначе игрок доворачивался раньше мяча, и мяч «прилетал
    // сбоку»). Вне ведения — обычный разворот в сторону бега.
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (this._driveFaceLock(dt)) {
      // Корпус доезжает в только что нанесённый удар (см. faceStrike)
    } else if (this.aerialStrike && this.aerialStrike.aimRot != null) {
      // Замах замыкания: корпус доворачивается в удар РОВНО к мигу контакта —
      // не раньше (иначе игрок бежит боком) и не позже (иначе бьёт мимо кадра)
      this._turnIntoStrike(dt);
    } else if (!brake && speed > 0.5) {
      let want;
      const bpp = ball.mesh.position; // bp определяется ниже — берём позицию напрямую
      const bd2 = Math.hypot(bpp.x - pos.x, bpp.z - pos.z);
      if (this.ballApproach && bd2 > APP.contactRadius) {
        want = Math.atan2(bpp.x - pos.x, bpp.z - pos.z);
      } else if (this.controlling && bd2 > P.dribbleChaseDist) {
        want = Math.atan2(bpp.x - pos.x, bpp.z - pos.z); // смотрим на мяч, пока догоняем
      } else {
        want = Math.atan2(this.vel.x, this.vel.z);
      }
      let d = want - this.rot;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      // Тяжесть разворотов растёт с инерцией темпа (на выбеге — тоже тяжёлые).
      // Потолок в °/кадр обязателен: без него множитель «доля остатка за кадр»
      // давал 42° в первом кадре разворота на 180° и вязкий хвост после.
      const turn = P.turnRate * (1 - (1 - P.sprintTurnFactor) * this.sprintBoost);
      const step = P.turnMax * dt;
      const want2 = d * Math.min(1, turn * dt);
      this.rot += Math.max(-step, Math.min(step, want2));
    }
    this.group.rotation.y = this.rot;

    this._updateAnim(dt, speed);

    this.shadow.position.x = pos.x;
    this.shadow.position.z = pos.z;

    // --- Контроль мяча: гистерезис (фидбек Олега, 17.07.2026, вторая итерация) ---
    // ПОДОБРАТЬ мяч можно только вплотную (controlRadius), но раз подобрал —
    // «поводок» дриблинга тянется до controlKeepRadius: на спринте (мяч в 1.7 м)
    // и в поворотах контроль не рвётся, мяч доворачивает за дугой игрока.
    // Раньше зона была одна: спринт выталкивал мяч за неё, и контроль умирал.
    const bp = ball.mesh.position;
    const dist = Math.hypot(bp.x - pos.x, bp.z - pos.z);
    const reach = this.controlling ? P.controlKeepRadius : P.controlRadius;
    // isToucher выставляет Match: из 22 игроков мячом владеет ближайший.
    // В одиночных тестах поля нет — undefined !== false, всё работает как раньше.
    this.hasBall = this.isToucher !== false &&
      this.kickCooldown <= 0 &&
      dist < reach &&
      bp.y < CONFIG.ball.radius * 2.2;
    this.controlling = this.hasBall;
    // «Эпизод владения»: держим окно живым, пока мяч у ног; после толчка на
    // спринте (hasBall на миг false) окно тает — контактный ассист замаха
    // навеса/удара опирается на него, а не на строгое владение этим кадром
    if (this.hasBall) this.ownEpisodeT = P.approach.episodeGrace;
    else if (this.ownEpisodeT > 0) this.ownEpisodeT = Math.max(0, this.ownEpisodeT - dt);

    // Эпизод жив, а мяч не у ноги (разворот сорвал липучку, толчок прокатился
    // мимо, мяч на миг «ничей») — ноги ОБЯЗАНЫ сначала вернуться к мячу,
    // стик хранится как будущий поворот (правило контактного ассиста;
    // фидбек Олега 22.07: «при смене направления убегает от мяча»).
    // После паса/удара не включается: kickCooldown и обнулённый эпизод
    if (this.ownEpisodeT > 0 && !this.hasBall && !this.ballApproach &&
        !this.pendingStrike && this.kickCooldown <= 0 && this.downT <= 0 &&
        this.diveT <= 0 && !brake && bp.y <= APP.maxBallY &&
        dist < P.dribbleReclaim) {
      const ownerNow = this.team && this.team.match ? this.team.match.toucher : null;
      if (!ownerNow || ownerNow === this) this.beginBallApproach('dribble', ball);
    }
    const canKick = this.kickCooldown <= 0 &&
      dist < P.kickRadius &&
      bp.y < P.kickMaxBallY;

    if (this.dribbleTouchCd > 0) this.dribbleTouchCd -= dt;
    if (!this.hasBall) this.dribbleDir = null; // мяч потерян — курс ведения сброшен
    // Пока ноги ещё честно добегают до мяча, обычное липкое ведение не должно
    // параллельно тянуть тот же мяч. После завершения контакта latch уже снят,
    // и этот блок исполняется в том же кадре.
    if (this.hasBall && !this.ballApproach && !strikeRunLock && !this.pendingStrike) {
      if ((sprinting || this.sprintBoost > 0.35) && speed > P.sprintTouchMinSpeed) {
        // Дриблинг на спринте — ТОЛЧКАМИ (фидбек Олега, 17.07.2026):
        // игрок пинает мяч вперёд, тот катится и тормозит (трение в ball.update),
        // игрок догоняет и пинает снова — мяч ритмично то у ног, то на отдалении.
        // Курс ведения (dribbleDir) обновляется В МОМЕНТ КАСАНИЯ — смена
        // направления применяется «через касание», как в PES.
        const dd = this.dribbleDir || { x: this.facing.x, z: this.facing.z };
        const relX = bp.x - pos.x, relZ = bp.z - pos.z;
        const ahead = relX * dd.x + relZ * dd.z; // проекция на курс ведения
        // Боковое удержание: мяч не сползает с линии ведения, продольно — свободно
        const latX = relX - ahead * dd.x;
        const latZ = relZ - ahead * dd.z;
        ball.vel.x -= latX * P.sprintTouchLateral;
        ball.vel.z -= latZ * P.sprintTouchLateral;
        // Мяч подкатился к ноге и пауза выдержана — новый толчок
        if (ahead < P.sprintTouchTrigger && dist <= APP.contactRadius &&
            this.dribbleTouchCd <= 0) {
          // Толчок — в сторону ввода (руль применяется у мяча), без ввода — по корпусу
          let pdx = this.facing.x;
          let pdz = this.facing.z;
          const rl = Math.hypot(input.move.x, input.move.z);
          if (rl > APP.intentDeadZone) {
            pdx = input.move.x / rl;
            pdz = input.move.z / rl;
          } else if (approachIntentAtContact) {
            pdx = approachIntentAtContact.x;
            pdz = approachIntentAtContact.z;
          }
          // Резкий разворот ГАСИТ толчок: мяч «притормаживается под
          // разворот», а не улетает вбок на полной скорости — иначе новый
          // курс 90°+ на спринте отправлял мяч на 13 м/с в сторону и игрок
          // физически не успевал (фидбек Олега 22.07)
          const runL = Math.hypot(this.vel.x, this.vel.z);
          let turnDot = 1;
          if (runL > 0.5) turnDot = (this.vel.x / runL) * pdx + (this.vel.z / runL) * pdz;
          const pushK = P.sprintTurnPushMin +
            (1 - P.sprintTurnPushMin) * Math.max(0, turnDot);
          const push = speed * P.sprintTouchPush * pushK;
          ball.vel.x = pdx * push;
          ball.vel.z = pdz * push;
          this.dribbleDir = { x: pdx, z: pdz };
          this.dribbleTouchCd = P.sprintTouchInterval;
          this.beginBallApproach('dribble', ball);
        }
      } else if (!brake) {
        // Медленное ведение: мяч липнет у ноги — близкий контроль.
        // В прицельной стойке (brake) НЕ подтягиваем: мяч остаётся там, куда
        // игрок подставил корпус — от этого зависит бьющая нога.
        // ВАЖНО (фидбек Олега): липнет только мяч РЯДОМ и ПЕРЕД игроком —
        // издалека/из-за спины мяч не «прилетает сбоку», игрок добегает сам
        const aheadF = (bp.x - pos.x) * this.facing.x + (bp.z - pos.z) * this.facing.z;
        if (dist < P.stickyRadius && aheadF > -0.3) {
          const target = pos.clone().addScaledVector(this.facing, P.dribbleAhead);
          ball.vel.x = this.vel.x + (target.x - bp.x) * P.dribbleStrength;
          ball.vel.z = this.vel.z + (target.z - bp.z) * P.dribbleStrength;
        }
      }
    }

    // --- Замахи: событие этого кадра или недавнее из буфера «удара с хода».
    // Нажал чуть раньше, чем добежал до мяча — удар исполнится в момент,
    // когда мяч войдёт в зону ноги (kickRadius). Так бьют с хода и с паса на ход.
    let pass = input.pass.consume();
    const through = input.through.consume();
    let cross = input.consumeCross();
    let shot = input.shot.consume();
    // Замыкание волея стартовало ещё на удержании D — гасим событие отпускания,
    // чтобы после волея не вылетел лишний удар (фидбек Олега 24.07)
    if (this._ignoreShotEdge && shot !== null) { shot = null; this._ignoreShotEdge = false; }
    const swipe = input.consumeSwipe();

    // Подкат (○ из PES, ресёрч 13): фронт нажатия НАВЕСА, когда мяч не у
    // нашей команды. Полоска навеса гасится — лёжа не навешивают
    if (input.consumeCrossPress() && !downed && this.diveT <= 0) {
      const al = Math.hypot(input.move.x, input.move.z);
      const aim = al > 0.3 ? { x: input.move.x / al, z: input.move.z / al } : null;
      if (this.tryTackle(ball, aim)) {
        input.cancelCross();
        cross = null;
      }
    }

    // Борьба корпусом (ресёрч 12): кнопка ПАСА, когда мяч не у нас, —
    // навал плечом на владельца / оттеснение соперника под верховым мячом
    if (pass !== null && !downed && this.tryChallenge(ball)) pass = null;

    let strike = null;
    if (pass !== null) strike = { type: 'pass', v: pass };
    else if (through !== null) strike = { type: 'through', v: through };
    else if (cross !== null) strike = { type: 'cross', v: cross };
    else if (shot !== null) strike = { type: 'shot', v: shot };
    else if (swipe !== null) strike = { type: 'swipe', v: swipe };

    if (downed || this.tackleT > 0) strike = null; // лежим/в подкате — замахи не копим

    if (strike) {
      // Удар по летящему мячу живёт в буфере дольше обычного: жми D,
      // пока навес в воздухе — замыкание исполнится в момент прилёта
      const airborne = bp.y > P.kickMaxBallY &&
        (strike.type === 'shot' ||
          (strike.type === 'swipe' && strike.v && strike.v.kind === 'shot'));
      this.pendingStrike = {
        ...strike,
        ttl: airborne ? P.aerial.buffer : P.strikeBufferTime,
        aim: null,
        combo: input.comboHeld, // Q/LB в момент нажатия — заявка на стеночку
      };
    } else if (this.pendingStrike) {
      const ps = this.pendingStrike;
      const psAirShot = bp.y > P.kickMaxBallY &&
        (ps.type === 'shot' || (ps.type === 'swipe' && ps.v && ps.v.kind === 'shot'));
      if (psAirShot) {
        // Подача ещё в полёте — заказ замыкания НЕ сгорает: жми D в любой
        // момент полёта, удар исполнится на прилёте (фидбек Олега 22.07:
        // завершение после навеса должно ощущаться ударом, а не отскоком)
        ps.ttl = Math.max(ps.ttl, P.aerial.buffer);
      } else {
        ps.ttl -= dt;
        if (ps.ttl <= 0) this.pendingStrike = null; // не добежал — сгорело
      }
    }

    // Пока пас ждёт мяча, стик пишет НАПРАВЛЕНИЕ будущей передачи:
    // игрок добегает сам (см. выше), а намерение живёт до исполнения
    if (this.pendingStrike &&
        (this.pendingStrike.type === 'pass' || this.pendingStrike.type === 'through')) {
      const ail = Math.hypot(input.move.x, input.move.z);
      if (ail > 0.3) {
        this.pendingStrike.aim = { x: input.move.x / ail, z: input.move.z / ail };
      }
    }

    const diving = this.diveT > 0;
    if (canKick && !diving && !downed && this.pendingStrike) {
      const s = this.pendingStrike;
      this.pendingStrike = null;
      this.strikeContactLock = false;
      this.cancelBallApproach(); // после паса/удара не гонимся за собственным мячом
      this.ownEpisodeT = 0;      // передача закрывает эпизод владения
      const lerp = (a, b, t) => a + (b - a) * t;
      if (s.type === 'pass' || s.type === 'through') {
        // S — пас низом; W — пас на ход (настильный). Сила — от замаха.
        // Направление: намерение стика на подходе к мячу (s.aim) или взгляд.
        // Пас-ассист: Match доворачивает на партнёра в конусе и подтягивает
        // силу к дистанции (слайдер «Помощь в пасах»); партнёр бросается
        // встречать. Без адресата пас летит строго как нарисован.
        const cfg = s.type === 'pass' ? P.pass : P.through;
        const power = lerp(cfg.powerMin, cfg.powerMax, s.v);
        let aimDir = null;
        if (s.aim) {
          aimDir = new THREE.Vector3(s.aim.x, 0, s.aim.z);
          this.faceStrike(Math.atan2(s.aim.x, s.aim.z)); // корпус ДОЕЗЖАЕТ по пасу
        }
        const assist = this.passAssist ? this.passAssist(this, s.type, power, aimDir) : null;
        ball.strike(
          assist ? assist.dir : (aimDir || this.facing),
          assist ? assist.power : power,
          cfg.lift,
        );
        this.kickCooldown = P.kickCooldown;
        this.playStrike('toe'); // короткий тычок, почти без замаха
        // СТЕНОЧКА (Q/LB + пас, 22.07.2026): пас ушёл партнёру — пасующий сам
        // рвёт вперёд за спину опекуну, курсор переходит на адресата (как
        // L1+пас в PES 5/6). Возврат мяча на ход — W
        if (assist && (s.combo || input.comboHeld) &&
            this.team && this.team.startManualOneTwo) {
          this.team.startManualOneTwo(this);
        }
      } else if (s.type === 'cross') {
        this.doCross(s.v, input, ball);
      } else if (s.type === 'shot') {
        this.shoot(s.v, input, ball);
      } else if (s.type === 'swipe') {
        this.swipeShot(s.v, input, ball);
      }
    }

    // Замыкание верхового мяча (ресёрч 11): мяч выше зоны ноги, но в
    // досягаемости — удар исполняется В ОДНО КАСАНИЕ, с лёта или головой.
    // Мощь и точность решает врывание (скорость бега), см. shoot(aerial).
    // В броске (ласточка) зона контакта другая: вытянутый корпус достаёт
    // дальше и ниже, но выше dive.maxY в падении не дотянуться
    const A = P.aerial;
    const DV = A.dive;
    // Замыкание с лёта/головой — В ОДНО КАСАНИЕ (PES 6): замах стартует, пока
    // мяч ещё подлетает (prepareRadius), мяч НЕ замирает, а перенаправляется
    // в момент контакта. В броске (ласточка) — мгновенный удар, замаха нет.
    const canAerialDive = this.kickCooldown <= 0 && !downed && diving &&
      dist < A.reach + DV.stretch && bp.y >= DV.minY && bp.y <= DV.maxY;
    // Мяч подлетает (снижается и не улетает от игрока) — тогда замах оправдан
    const closingAerial = ball.vel.y < 2 &&
      (bp.x - pos.x) * ball.vel.x + (bp.z - pos.z) * ball.vel.z < 2;
    // Зона замаха шире зоны удара (3 м): чтобы замах успел прочитаться, решение
    // принимается заранее — а раз заранее, то и проверять надо ПРОГНОЗНУЮ высоту
    // контакта, а не сегодняшнюю высоту мяча. Иначе игрок затевал бы кивок под
    // мяч, который к нему прикатится по газону.
    let canAerialPrep = this.kickCooldown <= 0 && !downed && !diving &&
      !this.aerialStrike && dist < A.prepareRadius && closingAerial;
    if (canAerialPrep) {
      // Решает ПРОГНОЗНАЯ высота контакта, а не сегодняшняя высота мяча.
      // Проверка «мяч уже ниже maxY» откладывала замах до последнего мига:
      // навес падает почти отвесно, и к моменту, когда он опускался в зону,
      // бить было уже нечем — замах не успевал (замер в игре 24.07)
      // …и замах начинается ТОЛЬКО если прогноз нашёл настоящий контакт: мяч
      // реально придёт на бутсу/лоб. Иначе игрок молотит воздух и теряет темп
      const pre = this.predictAerialContact(ball, A.readHorizon);
      canAerialPrep = pre.y >= P.kickMaxBallY && pre.y <= A.maxY &&
        pre.dist <= A.sync.hitRadius * 1.5;
    }
    const wantShot = this.pendingStrike &&
      (this.pendingStrike.type === 'shot' ||
        (this.pendingStrike.type === 'swipe' && this.pendingStrike.v.kind === 'shot'));
    if (canAerialDive && wantShot) {
      const s = this.pendingStrike;
      this.pendingStrike = null;
      if (s.type === 'shot') {
        this.shoot(s.v, input, ball, null, { aerial: true, dive: true });
      } else {
        const gdir = new THREE.Vector3(s.v.dir.x, 0, s.v.dir.z).normalize();
        this.shoot(Math.min(s.v.power, 1.3), input, ball,
          { dir: gdir, curl: -s.v.curl * CONFIG.shot.swipeCurl },
          { aerial: true, dive: true });
      }
    } else if (canAerialPrep && (wantShot || input.shot.held)) {
      // Начинаем замах в одно касание: мяч подлетает, перенаправление в контакте.
      // Триггер и по УДЕРЖАНИЮ D (замах волея копится, пока мяч летит) — иначе
      // держащий D для мощного волея не бил вовсе (фидбек Олега 24.07).
      if (wantShot) {
        this.beginAerialStrike(this.pendingStrike, input, ball);
        this.pendingStrike = null;
      } else {
        this.beginAerialStrike({ type: 'shot', v: Math.max(0.15, input.shot.charge01) },
          input, ball);
        this._ignoreShotEdge = true; // событие отпускания D не должно дать второй удар
      }
    } else if (wantShot && !diving && !downed && this.kickCooldown <= 0 &&
        dist >= A.reach && dist < DV.reach &&
        bp.y >= DV.minY && bp.y <= DV.maxY) {
      // Удар в падении (просьба Олега): на ноги не успеваю, а мяч ПРОЛЕТАЕТ
      // МИМО — бросок корпусом. Если мяч и так летит в игрока, броска нет:
      // дождёмся обычного замыкания (проверка ближайшей точки траектории)
      const sp2 = ball.vel.x * ball.vel.x + ball.vel.z * ball.vel.z;
      if (sp2 > 9) {
        const relX = bp.x - pos.x;
        const relZ = bp.z - pos.z;
        const tCa = Math.max(0, -(relX * ball.vel.x + relZ * ball.vel.z) / sp2);
        const closest = Math.hypot(relX + ball.vel.x * tCa, relZ + ball.vel.z * tCa);
        if (closest > A.reach * 0.75) {
          this.startDive(relX / dist, relZ / dist, bp.y);
        }
      }
    }

    // Приём верхового мяча (фидбек Олега 22–23.07.2026): наш пас или перевод
    // опускается на игрока, удар не заказан — мяч гасится в ноги на ЛЮБОЙ
    // досягаемой высоте (грудь, голова — без прыжков и клипов), как обычный
    // приём паса. В финишной зоне у чужих ворот авто-приём молчит: там
    // подачу замыкают (D).
    // ВАЖНО (фидбек Олега 24.07): приём НЕ срабатывает, пока игрок ЗАКАЗАЛ
    // удар — держит D для замаха волея (событие удара выходит только на
    // отпускании, wantShot тогда ещё false). Иначе приём «съедал» мяч грудью
    // до волея. input.strikeCommitted = любая боевая кнопка нажата/ждёт.
    const TR = P.trap;
    // Приём — по РЕАЛЬНОМУ касанию корпуса, а не по влёту в радиус 1.5 м
    const trapC = this.bodyContactPoint(bp);
    if (!downed && !diving && this.tackleT <= 0 && this.kickCooldown <= 0 &&
        !wantShot && !input.strikeCommitted && !this.aerialStrike &&
        bp.y > P.kickMaxBallY && bp.y <= A.maxY &&
        trapC.reachable && ball.vel.y < 1 &&
        ball.vel.length() >= TR.minSpeed) { // полная скорость: крутая перекидка
                                            // почти без горизонтали, но падает быстро
      const mt = this.team ? this.team.match : null;
      const oursIncoming = !mt || mt.possession === this.team;
      let inFinish = false;
      if (this.team) {
        const dg = Math.hypot(this.team.attackGoalX - pos.x, pos.z);
        inFinish = dg < CONFIG.ai.aerial.headerRange;
      }
      if (oursIncoming && !inFinish) this.trapBall(ball, trapC);
    }

    // --- Aftertouch: пока свежеотбитый мяч летит, направление докручивает его ---
    // (на iPad это тот же виртуальный стик — жест одинаковый на всех платформах)
    // Помощь в ударах усиливает докрутку: легче дотянуть мяч в угол
    const B = CONFIG.ball;
    if (ball.afterTouch > 0 && bp.y > B.radius * 1.5) {
      const vx = ball.vel.x;
      const vz = ball.vel.z;
      const sp = Math.hypot(vx, vz);
      if (sp > 1) {
        const AS = CONFIG.shot.assist;
        const rate = B.afterTouchRate * (1 + AS.level * AS.touchRate);
        const cap = B.afterTouchMax * (1 + AS.level * AS.touchMax);
        // Боковая составляющая ввода относительно направления полёта → закрутка
        const lat = (input.move.x * -vz + input.move.z * vx) / sp;
        ball.spin += lat * rate * dt;
        ball.spin = Math.max(-cap, Math.min(cap, ball.spin));
      }
    }
  }

  // Решатель навеса по-PES (17.07.2026): из флангового коридора чужой половины
  // навес наводится В ШТРАФНУЮ САМ — бежать по бровке можно не разворачиваясь.
  // Полоска (charge) выбирает адрес: ближняя штанга → центр → дальняя,
  // передержка утаскивает за дальнюю. Стрелки в момент исполнения уточняют
  // точку. Скорость мяча подбирается баллистикой под адрес, подкрутка — от
  // бьющей ноги (инсвингер/аутсвингер), прицел заранее скомпенсирован под дугу.
  // Вне коридора вернёт null — там навес остаётся направленным «по взгляду».
  crossSolution(type, charge, input, ball, extraSpin = 0) {
    const C = CONFIG.cross;
    const F = CONFIG.field;
    const B = CONFIG.ball;
    const pos = this.group.position;
    const bp = ball.mesh.position;

    // Куда атакуем: по взгляду; смотрим ровно поперёк поля — по своей половине
    const f = this.facing;
    const atk = Math.abs(f.x) > 0.12 ? Math.sign(f.x) : Math.sign(pos.x || 1);
    const goalX = atk * (F.length / 2);

    // Фланговый коридор чужой половины — иначе навод не работает
    const inZone = Math.abs(pos.z) > (F.width / 2) * C.zone.wideZ &&
      atk * pos.x > (F.length / 2) * C.zone.depthX;
    if (!inZone) return null;

    // Адрес по полоске: 0.15 — ближняя штанга, ~0.6 — центр, 1.0 — дальняя.
    // Передержка (>1) продолжает тащить точку за дальнюю — мяч уйдёт от всех.
    const A = C.aim;
    const side = Math.sign(pos.z || 1); // с какого фланга подаём
    const zoneT = (Math.min(charge, 1) - 0.15) / 0.85;
    let targetZ = side * A.nearZ - side * (A.nearZ + A.farZ) * Math.max(0, zoneT);
    if (charge > 1) targetZ -= side * A.overZ * (charge - 1) / 0.3;

    // Стрелки уточняют адрес прямо в мировых осях («куда тяну — туда сдвиг»):
    // вдоль поля — глубина (к вратарской / оттянуть на 11 м), поперёк — штанги
    let depth = A.depth - atk * input.move.x * A.aimDepth;
    depth = Math.max(A.depthMin, Math.min(A.depthMax, depth));
    targetZ += input.move.z * A.aimSide;
    const targetX = goalX - atk * depth;

    const dx = targetX - bp.x;
    const dz = targetZ - bp.z;
    const dist = Math.hypot(dx, dz);
    if (dist < A.minDist) return null; // сам уже в точке адреса — навод не нужен

    // Баллистика под адрес: угол дуги задан типом, скорость — чтобы долететь.
    // powerMin/powerMax держат характер типа (прострел не станет свечой);
    // недолёт низового прострела честен — он доскачет отскоками.
    const theta = (type.angle * Math.PI) / 180;
    const g = -B.gravity;
    let power = Math.sqrt((g * dist) / (2 * Math.tan(theta))) * C.dragFudge;
    power = Math.max(type.powerMin, Math.min(type.powerMax, power));
    // Передержка бьёт СИЛЬНЕЕ баллистики — мяч перелетает всех и уходит
    // за дальнюю бровку, как в PES (кламп выше не даст честного перелёта)
    if (charge > 1) power *= 1 + (charge - 1) * C.overPower;
    const lift = power * Math.tan(theta);
    const flight = (2 * lift) / g; // время до приземления

    // Дуга от ноги: внутренняя сторона правой режет влево (spin < 0), левой —
    // вправо. С правого фланга правая нога даёт аутсвингер, с левого — инсвингер.
    const foot = this.kickFoot(ball);
    let spin = (foot === 'R' ? -1 : 1) * type.curl + extraSpin;

    // Компенсация прицела: Магнус вертит вектор скорости со скоростью
    // spin·magnus рад/с — целимся против сноса (curlComp > 0.5, потому что
    // на излёте скорость падает, а крутка жива — дуга доворачивает сильнее)
    const comp = -C.curlComp * spin * B.magnus * flight;
    const ca = Math.cos(comp);
    const sa = Math.sin(comp);
    const nx = dx / dist;
    const nz = dz / dist;
    const dir = new THREE.Vector3(nx * ca - nz * sa, 0, nx * sa + nz * ca);

    return { dir, power, lift, spin, foot };
  }

  // Навес (A) — три типа по числу тапов, как в PES (ресёрч 08):
  // ×1 — высокая свеча, ×2 — настильный под удар, ×3 — низовой прострел.
  // Во фланговом коридоре — самонаведение в штрафную (crossSolution),
  // вне его — заброс по взгляду с подкруткой к воротам (лонгбол).
  doCross(ev, input, ball) {
    const C = CONFIG.cross;
    const F = CONFIG.field;
    const types = [C.high, C.mid, C.low];
    const t = types[Math.min(ev.taps, 3) - 1];

    const sol = this.crossSolution(t, ev.charge, input, ball);
    if (sol) {
      ball.strike(sol.dir, sol.power, sol.lift, sol.spin);
      this.lastKick = { foot: sol.foot, contact: 'inside' };
      this.kickCooldown = CONFIG.player.kickCooldown;
      this.playStrike('cross'); // навес — широкий мах под мяч
      this.afterCross(ball);
      return;
    }

    // Вне коридора: сперва АДРЕСНЫЙ верховой мяч (фидбек Олега 22.07.2026) —
    // короткий замах кладёт мягкий заброс на ближнего в конусе, полный
    // переводит игру на дальний фланг; адресат встречает мяч, как обычный пас
    if (this.loftedPass(t, ev.charge, input.move, ball)) return;

    // Совсем некому отдать — прежний длинный заброс по направлению взгляда
    const power = t.powerMin + (t.powerMax - t.powerMin) * ev.charge; // >1 = передержка
    const lift = power * Math.tan((t.angle * Math.PI) / 180);

    // Подкрутка в сторону той штрафной, в чьей половине стоим (inswing)
    const pos = this.group.position;
    const goalX = (pos.x >= 0 ? 1 : -1) * (F.length / 2);
    const f = this.facing;
    const side = (-f.z) * (goalX - pos.x) + f.x * (0 - pos.z); // перпендикуляр · направление на ворота
    const curl = t.curl * 0.5 * Math.sign(side || 1);

    // Нога — по корпусу; если крутка к воротам «наружу» от неё — шведка
    const fw = this.applyFootwork(curl, ball);
    ball.strike(f, power * fw.powerF, lift, curl * fw.curlF);
    this.kickCooldown = CONFIG.player.kickCooldown;
    this.playStrike('cross');
    this.afterCross(ball);
  }

  // Адресный верховой мяч (фидбек Олега 22.07.2026): навес вне флангового
  // коридора ищет адресата в конусе стика/взгляда. Полоска выбирает дальность:
  // короткая — мягкий заброс на ближнего (примет грудью/ногой), полная —
  // перевод на дальний фланг. Адресат назначается приёмщиком и встречает мяч,
  // как обычный пас. true = заброс исполнен; false = в конусе никого.
  loftedPass(type, charge, aimMove, ball) {
    const LP = CONFIG.cross.longPass;
    const C = CONFIG.cross;
    const B = CONFIG.ball;
    const team = this.team;
    if (!team) return false;
    const pos = this.group.position;

    // Направление намерения: стик/жест в момент исполнения. БЕЗ стика — не
    // взгляд (вингер вдоль бровки смотрит по линии и не видит центр штрафной,
    // фидбек Олега 22.07: «нужна помощь в направлении»), а ВПЕРЁД к чужим
    // воротам — туда, где обычно ждут адресаты заброса.
    let fx;
    let fz;
    const il = aimMove ? Math.hypot(aimMove.x, aimMove.z) : 0;
    if (il > 0.3) {
      fx = aimMove.x / il;
      fz = aimMove.z / il;
    } else {
      const atk = team.attackGoalX >= 0 ? 1 : -1;
      // Смешиваем «вперёд к воротам» с текущим взглядом — заброс идёт в атаку,
      // но с уклоном в сторону, куда развёрнут корпус
      let bx = atk * 0.85 + this.facing.x * 0.15;
      let bz = this.facing.z * 0.15;
      const bl = Math.hypot(bx, bz) || 1;
      fx = bx / bl;
      fz = bz / bl;
    }

    // Полоска = дальность адресата: короткий замах — ближний, полный — дальний.
    // Шкала нормируется от пола тапа (0.15, как zoneT навеса): чистый тап =
    // САМЫЙ ближний адресат — короткая перекидка через соперника (23.07)
    const chargeT = Math.max(0, (Math.min(charge, 1) - 0.15) / 0.85);
    const want = LP.wantNear + (LP.wantFar - LP.wantNear) * chargeT;
    // Помощь в направлении: конус расширяется слайдером «Помощь в пасах»
    const passAssist = CONFIG.ai.humanPass.assist;
    const coneCos = LP.coneCos - passAssist.level * LP.coneWiden;
    let best = null;
    let bestScore = -Infinity;
    for (const mate of team.players) {
      if (mate === this || mate.isKeeper) continue;
      const mp = mate.group.position;
      const ddx = mp.x - pos.x;
      const ddz = mp.z - pos.z;
      const d = Math.hypot(ddx, ddz);
      if (d < LP.minDist || d > LP.maxDist) continue;
      const cos = (ddx * fx + ddz * fz) / d;
      if (cos < coneCos) continue;
      // Ценим направление, близость к заказанной дальности и продвижение вперёд
      const fwd = (team.attackGoalX >= 0 ? 1 : -1) * ddx;
      const score = cos * 20 - Math.abs(d - want) * 0.55 + fwd * 0.15;
      if (score > bestScore) {
        bestScore = score;
        best = { mate, dist: d };
      }
    }
    if (!best) return false;

    // Баллистика под адресата с упреждением на его бег. Угол дуги: короткая
    // перекидка — КРУТАЯ свеча (перелетает голову соперника и падает рядом),
    // длинный перевод — обычный угол типа (фидбек Олега 23.07: «перекинуть
    // соперника и отдать ближнему верхом» было невозможно — мяч улетал)
    const chipT = Math.max(0, Math.min(1,
      (LP.chipFar - best.dist) / (LP.chipFar - LP.chipDist)));
    const angleDeg = type.angle + (LP.chipAngle - type.angle) * chipT;
    const theta = (angleDeg * Math.PI) / 180;
    const g = -B.gravity;
    const t0 = Math.sqrt((2 * best.dist * Math.tan(theta)) / g); // грубое время полёта
    const mp = best.mate.group.position;
    // Упреждение тает на коротких перекидках: мяч кладётся РЯДОМ с партнёром
    // («отдать ближнему верхом»), а не на ход за 20 м — бегущий адресат
    // растягивал перекидку в длинный заброс (фидбек Олега 23.07)
    const leadK = LP.lead * (1 - chipT * 0.7);
    const tx = mp.x + best.mate.vel.x * t0 * leadK;
    const tz = mp.z + best.mate.vel.z * t0 * leadK;
    const dx = tx - pos.x;
    const dz = tz - pos.z;
    const dist = Math.hypot(dx, dz) || 1;
    // Силу ищем ЧЕСТНОЙ баллистикой (drag учтён в симуляции), а не формулой
    // идеальной параболы с поправкой: та мазала мимо адресата на 0.8–2.0 м.
    // Целимся в высоту приёма (грудь), а не в газон — мяч должен прийти
    // партнёру на корпус, а не сесть в двух метрах за ним
    let power = this.solveLoftPower(dist, theta, CONFIG.player.aerial.contactY,
      LP.powerFloor, type.powerMax);
    // Пол силы ниже powerMin типа: короткой перекидке нужна МАЛАЯ скорость,
    // иначе даже минимальный «зажим» уносил мяч на 12+ метров
    power = Math.max(LP.powerFloor, Math.min(type.powerMax, power));
    if (charge > 1) power *= 1 + (charge - 1) * C.overPower; // передержка — перелёт
    const lift = power * Math.tan(theta);

    // Природная крутка ноги (ослабленная) с упреждением прицела под Магнус
    const foot = this.kickFoot(ball);
    const spin = (foot === 'R' ? -1 : 1) * type.curl * LP.curlK;
    const flight = (2 * lift) / g;
    const comp = -C.curlComp * spin * B.magnus * flight;
    const ca = Math.cos(comp);
    const sa = Math.sin(comp);
    const nx = dx / dist;
    const nz = dz / dist;
    const dir = new THREE.Vector3(nx * ca - nz * sa, 0, nx * sa + nz * ca);

    ball.strike(dir, power, lift, spin);
    this.lastKick = { foot, contact: 'inside' };
    this.faceStrike(Math.atan2(dir.x, dir.z));
    this.kickCooldown = CONFIG.player.kickCooldown;
    this.ownEpisodeT = 0; // передача закрывает эпизод владения
    this.playStrike('pass');

    // Адресат встречает мяч, как обычный пас: точка приёма — ЧЕСТНЫЙ прогноз
    // приземления уже улетевшего мяча (drag + Магнус), а не идеальная парабола
    // — раньше кламп силы смещал реальную точку, и адресат ждал не там
    const land = predictLanding(ball, CONFIG.player.aerial.contactY);
    team.receiver = best.mate;
    team.receiveTarget = land ? { x: land.x, z: land.z } : { x: tx, z: tz };
    team.receiveTimer = Math.max(CONFIG.ai.receiveGiveUp, (land ? land.t : flight) + 0.8);
    // Курсор СРАЗУ переходит на адресата перекидки (как после навеса в
    // штрафную): человек ведёт приёмщика на мяч и принимает его сам, а не
    // ждёт запоздалого авто-переключения — иначе мяч «отскакивал» до смены
    // управляемого (фидбек Олега 23.07). Приёмщик и без ввода бежит к точке.
    const m = team.match;
    if (m && team === m.humanTeam && best.mate !== m.controlled) {
      m.setControlled(best.mate, 0.4);
    }
    return true;
  }

  // После подачи (ресёрч 11, принцип PES «курсор на принимающего»):
  // тренер назначает замыкающего под точку приземления — тот врывается
  // на прилёт; человеку курсор сразу передаётся на него, чтобы вести
  // врывание и жать удар в момент прилёта. В одиночных тестах team нет.
  afterCross(ball) {
    const team = this.team;
    if (!team || !team.onCrossStruck) return;
    const receiver = team.onCrossStruck(ball);
    const m = team.match;
    if (receiver && m && team === m.humanTeam && receiver !== m.controlled) {
      m.setControlled(receiver, 0.35);
    }
  }

  // Жест-свайп с тача — «как нарисовал, так и полетело»:
  // направление пальца — куда (независимо от бега), длина — сила,
  // скорость жеста — характер (медленно — свеча, резко — прострел),
  // изгиб траектории пальца — подкрутка. Короткий росчерк — пас на ход.
  // Во фланговом коридоре навес-жест НАВОДИТСЯ в штрафную (как с клавиатуры):
  // рисуешь в сторону ворот — длина выбирает адрес, изгиб докручивает дугу.
  swipeShot(sw, input, ball) {
    const S = CONFIG.shot;
    const C = CONFIG.cross;
    const P = CONFIG.player;
    const dir = new THREE.Vector3(sw.dir.x, 0, sw.dir.z).normalize();
    const charge = Math.min(sw.power, 1.3);
    const curl = -sw.curl * S.swipeCurl; // палец гнёт вправо — мяч крутится вправо

    // Жест, начатый на кнопке УДАР, — именно удар по нарисованному курсу.
    // Свободный жест из круга НАВЕС ниже сохраняет прежнюю логику подачи.
    if (sw.kind === 'shot') {
      this.shoot(charge, input, ball, { dir, curl });
      return;
    }

    if (charge < 0.45) {
      // Короткий росчерк — острый пас на ход низом
      const fw = this.applyFootwork(curl, ball);
      const power = P.through.powerMin + (P.through.powerMax - P.through.powerMin) * (charge / 0.45);
      ball.strike(dir, power * fw.powerF, P.through.lift, curl * 0.5 * fw.curlF);
    } else {
      // Тип дуги по скорости жеста (экранов/сек): медленный — свеча,
      // средний — настильный, резкий — низовой прострел
      const type = sw.speed < 1.2 ? C.high : (sw.speed < 2.6 ? C.mid : C.low);
      // Самонаведение: жест нарисован в сторону штрафной — берём PES-решение,
      // изгиб пальца добавляется к природной крутке ноги
      const sol = this.crossSolution(type, charge, input, ball, curl * 0.5);
      if (sol && sol.dir.dot(dir) > 0.25) {
        ball.strike(sol.dir, sol.power, sol.lift, sol.spin);
        this.lastKick = { foot: sol.foot, contact: 'inside' };
        this.faceStrike(Math.atan2(sol.dir.x, sol.dir.z));
        this.kickCooldown = P.kickCooldown;
        this.playStrike('through');
        this.afterCross(ball);
        return;
      }
      // Вне коридора: адресный верховой мяч по нарисованному направлению
      // (мягкий заброс / перевод на фланг — как с клавиатуры)
      if (this.loftedPass(type, charge, { x: dir.x, z: dir.z }, ball)) return;
      const fw = this.applyFootwork(curl, ball);
      const power = (type.powerMin + (type.powerMax - type.powerMin) * charge) * fw.powerF;
      const lift = power * Math.tan((type.angle * Math.PI) / 180);
      ball.strike(dir, power, lift, curl * fw.curlF);
      this.afterCross(ball);
    }
    // Развернуться в сторону мяча — читаемость
    this.faceStrike(Math.atan2(dir.x, dir.z));
    this.kickCooldown = P.kickCooldown;
    this.playStrike('through');
  }

  // Какой ногой бьём: мяч слева от корпуса — левой, справа — правой,
  // почти по центру — доминантной. Корпусом рулит игрок, ногу выбирает игра.
  // (Знаки: side > 0 — мяч справа от корпуса. Раньше тут был зеркальный баг:
  // нога и знак подкрутки были перепутаны ОБА — и компенсировали друг друга.
  // Починено 17.07.2026 ради честной дуги навеса «от ноги».)
  kickFoot(ball) {
    const P = CONFIG.player;
    const bp = ball.mesh.position;
    const pos = this.group.position;
    const side = this.facing.x * (bp.z - pos.z) - this.facing.z * (bp.x - pos.x);
    if (Math.abs(side) < P.footDeadZone) return P.dominantFoot;
    return side > 0 ? 'R' : 'L';
  }

  // Часть стопы под нужную крутку: «внутрь» бьющей ноги — щечка/внутренний
  // подъём (естественно, без штрафов); «наружу» — внешняя сторона стопы
  // («шведка», стиль Роберто Карлоса): мощнее, но крутка и точность капризнее.
  // Знаки подкрутки: curl > 0 — мяч в полёте уходит ВПРАВО от направления
  // (см. Магнус в ball.js), правая нога внутренней стороной режет ВЛЕВО.
  applyFootwork(curl, ball) {
    const P = CONFIG.player;
    const foot = this.kickFoot(ball);
    let contact = 'inside';
    let powerF = 1, curlF = 1, noiseF = 1;
    if (Math.abs(curl) > 0.15) {
      const inside = (foot === 'R') === (curl < 0);
      if (!inside) {
        contact = 'outside';
        powerF = P.trivela.power;
        curlF = P.trivela.curl;
        noiseF = P.trivela.noise;
      }
    }
    this.lastKick = { foot, contact }; // отладка/баланс; позже — левши и зеркальные анимации
    return { foot, contact, powerF, curlF, noiseF };
  }

  // Выбор типа удара (сам, по контексту — решение Олега, 17.07.2026):
  // короткий тап -> НОСОК (тычок в касание); на скорости или по приходящему
  // мячу (пас на ход) -> ПОДЪЁМ (с лёта, driven); иначе -> ЩЕЧКА (плассированный)
  strikeStyle(charge, ball) {
    const ST = CONFIG.shot.styles;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const rel = Math.hypot(ball.vel.x - this.vel.x, ball.vel.z - this.vel.z);
    // Приходящий на скорости мяч бьётся с лёта ПОДЪЁМОМ (driven) — даже тапом:
    // первое касание прострела это удар ногой, а не «подставить носок». Проверка
    // до тычка (фидбек Олега 24.07: низкий прострел выходил слабым toe-тычком)
    if (rel >= ST.instep.minBallRel || speed >= ST.instep.minRunSpeed) return 'instep';
    if (charge <= ST.toe.maxCharge) return 'toe';
    return 'side';
  }

  // Удар (D). В конусе к воротам — прицельный: стрелки выбирают угол створа
  // (вверх экрана = дальняя штанга), замах — высоту; траектория решается
  // баллистикой, так что мяч реально прилетает в выбранную точку.
  // Поверх — модификаторы типа удара: подъём мощнее и настильнее,
  // носок слабее/ниже/шумнее, щечка точнее всех.
  shoot(charge, input, ball, gesture = null, opts = {}) {
    const S = CONFIG.shot;
    const F = CONFIG.field;
    const G = CONFIG.goal;
    const B = CONFIG.ball;
    const A = CONFIG.player.aerial;
    const bp = ball.mesh.position;

    // Тип удара: обычный выбирается контекстом (strikeStyle); замыкание
    // верхового мяча (opts.aerial) — головой или с лёта, по высоте мяча
    const styleName = opts.aerial
      ? (bp.y >= A.headerY ? 'header' : 'volley')
      : this.strikeStyle(charge, ball);
    const st = S.styles[styleName];
    this.lastStrikeStyle = styleName;
    // У тычка сила почти не зависит от замаха — он всегда «средний, но мгновенный»
    const effCharge = styleName === 'toe' ? st.effCharge : charge;
    let power = (S.powerMin + (S.powerMax - S.powerMin) * effCharge) * st.powerFactor;
    // Помощь в ударах глушит часть шума исполнения (слайдер в НАСТРОЙКАХ)
    const AS = S.assist;
    const noiseK = Math.max(0, 1 - AS.level * AS.noiseCut);
    let nz = S.noiseZ * st.noiseFactor * noiseK;
    let ny = S.noiseY * st.noiseFactor * noiseK;

    // Щечка «вырезает» мяч внутрь бьющей ноги: корпус выбирает ногу,
    // нога — сторону завитка (правая — влево, левая — вправо).
    // Подъём и носок бьют без вращения (driven/тычок).
    let curl = 0;
    if (opts.aerial) {
      // Замыкание бьётся «чисто»: кивок и удар с лёта без подкрутки
    } else if (gesture) {
      const fw = this.applyFootwork(gesture.curl, ball);
      power *= fw.powerF;
      curl = gesture.curl * fw.curlF;
    } else if (styleName === 'side') {
      const foot = this.kickFoot(ball);
      curl = (foot === 'R' ? -1 : 1) * st.curl; // внутренняя сторона: правая режет влево
      this.lastKick = { foot, contact: 'inside' };
    }

    const f = gesture ? gesture.dir : this.facing;
    if (gesture) {
      // Корпус и анимация тоже поворачиваются по нарисованному удару.
      this.facing.copy(f);
      this.faceStrike(Math.atan2(f.x, f.z));
    }

    // Сердце замыкания (ресёрч 11, принцип PES): мощь даёт ВРЫВАНИЕ.
    // Скорость бега в сторону удара конвертируется в силу; на скорости
    // корпус вложен в удар — прицел точнее; статичный прыжок — шумный кивок
    if (opts.aerial) {
      const runIn = Math.max(0, this.vel.x * f.x + this.vel.z * f.z);
      power *= 1 + Math.min(A.runPowerCap, runIn * A.runPower);
      // Первое касание (PES 6): часть скорости ПРИХОДЯЩЕГО мяча идёт в силу —
      // сильный прострел замыкается мощнее (мяч не гасится, а перенаправляется)
      power += Math.hypot(ball.vel.x, ball.vel.z) * A.oneTouchMomentum;
      const spd = Math.hypot(this.vel.x, this.vel.z);
      const mul = spd < A.standSpeed ? A.standNoise : A.runNoise;
      nz *= mul;
      ny *= mul;
      if (opts.dive) {
        // В падении: бьёшь без опоры — слабее и шумнее; прыжка нет (ласточка)
        power *= A.dive.powerFactor;
        nz *= A.dive.noise;
        ny *= A.dive.noise;
      } else if (styleName === 'header' && !opts.compute) {
        // Прыжок под голову ставит beginAerialStrike (замах уже идёт); в режиме
        // compute (пересчёт удара в момент контакта) прыжок не трогаем
        this.startJump(A.jumpRise,
          A.jumpHeight * (1 - A.jumpChargeH + A.jumpChargeH * Math.min(1, charge)));
      }
    }
    // Замыкание (голова / с лёта) ВСЕГДА наводится на ЧУЖИЕ ворота, а не летит
    // по корпусу: врывающийся под прострел встречает мяч боком/спиной к воротам,
    // и удар «по взгляду» уходил в сторону или назад (фидбек Олега 22.07:
    // «отскочило в другую сторону от ворот»). Ворота берём от команды.
    const goalX = (opts.aerial && this.team)
      ? this.team.attackGoalX
      : (f.x >= 0 ? 1 : -1) * (F.length / 2);
    const toGoal = new THREE.Vector3(goalX - bp.x, 0, -bp.z);
    const dist = toGoal.length();
    const angle = f.angleTo(toGoal.normalize()) * (180 / Math.PI);

    // Прицельная баллистика — только на ЧУЖИЕ ворота: лицом к своим удар
    // остаётся свободным выносом, а не «ассистом в свой угол» (автогол)
    const aimOk = !this.team || goalX === this.team.attackGoalX;

    // Замыкание идёт по прицельной ветке ВСЕГДА (наводится на ворота), даже
    // если корпус смотрит вбок — иначе кивок/удар с лёта улетал «в поле».
    // Обычный удар (не aerial) прицеливается только в конусе к воротам.
    const useAim = aimOk && dist > 2.5 &&
      (opts.aerial || (angle < S.assistAngle && dist < S.assistDist && Math.abs(f.x) > 0.1));

    const launch = new THREE.Vector3();
    if (useAim) {
      // БЕЗ магнита: базовый прицел — точка, куда смотрит игрок на линии ворот.
      // Стрелки сдвигают её; за штангу — можно, промах реален. Замыкание боком
      // к воротам взгляда не имеет — целим в центр створа, стрелки уводят в угол.
      const baseZ = opts.aerial
        ? 0
        : bp.z + (f.z / f.x) * (goalX - bp.x);
      const aimZ = gesture ? 0 : (input.shotAim ? input.shotAim.z : 0);
      const maxZ = G.width / 2 + S.aimSlack;
      let targetZ = Math.max(-maxZ, Math.min(maxZ, baseZ)) + aimZ * S.aimRange;
      let targetY = (S.heightMin + (S.heightMax - S.heightMin) *
        Math.min(effCharge / S.overchargeFrom, 1)) * (st.heightFactor || 1);
      if (effCharge > S.overchargeFrom) targetY += Math.random() * S.overchargeRise; // перезаряд — риск выше ворот
      targetZ += (Math.random() - 0.5) * 2 * nz;
      targetY += (Math.random() - 0.5) * 2 * ny;

      // Помощь в ударах: небольшой промах прощается — прицел дотягивается
      // в створ (максимум level×pullMeters метров). Чем меньше был промах,
      // тем глубже от штанги ложится мяч (tuck) — спасённые удары не липнут
      // все в одну точку у штанги. Прицел, изначально попадающий в створ,
      // не трогается; сознательный удар сильно мимо останется промахом.
      const forgive = AS.level * AS.pullMeters;
      const postEdge = G.width / 2 - B.radius;  // прицел, при котором мяч ещё в створе
      if (Math.abs(targetZ) > postEdge) {
        const miss = Math.abs(targetZ) - postEdge;
        targetZ = Math.sign(targetZ) * (miss > forgive
          ? postEdge + miss - forgive
          : postEdge - (forgive - miss) * AS.tuck);
      }
      const barEdge = G.height - B.radius;
      if (targetY > barEdge) {
        const over = targetY - barEdge;
        targetY = over > forgive
          ? barEdge + over - forgive
          : barEdge - (forgive - over) * AS.tuck;
      }

      const dir = new THREE.Vector3(goalX - bp.x, 0, targetZ - bp.z);
      const flightDist = dir.length();
      dir.normalize();
      // Поправка на сопротивление воздуха: реальный полёт дольше идеального
      // (0.80 подобрано симуляцией под квадратичный drag)
      const t = flightDist / (power * 0.80);
      // Вертикальная скорость, чтобы на воротах оказаться на высоте цели.
      // Замыкание сверху может бить ВНИЗ (кивок в газон/угол — классика)
      let vy = (targetY - bp.y) / t - 0.5 * B.gravity * t;
      vy = Math.max(opts.aerial ? A.downLift : 0, Math.min(S.maxLift, vy));
      launch.set(dir.x * power, vy, dir.z * power);
    } else if (opts.aerial && this.team) {
      // Замыкание у самой линии (dist ≤ 2.5): всё равно бьём В ВОРОТА, а не
      // по корпусу — иначе кивок в упор улетал мимо (фидбек Олега 22.07)
      const lift = (S.freeLiftMin + (S.freeLiftMax - S.freeLiftMin) * effCharge) * st.liftFactor;
      const d = new THREE.Vector3(goalX - bp.x, 0, -bp.z);
      if (d.lengthSq() < 0.01) d.set(Math.sign(goalX) || 1, 0, 0);
      d.normalize();
      launch.set(d.x * power, lift, d.z * power);
    } else {
      // Обычный удар по направлению взгляда, высота растёт с замахом
      const lift = (S.freeLiftMin + (S.freeLiftMax - S.freeLiftMin) * effCharge) * st.liftFactor;
      launch.set(this.facing.x * power, lift, this.facing.z * power);
    }
    this.kickCooldown = CONFIG.player.kickCooldown;
    // Замыкание (голова / с лёта): анимация замаха играет СЕЙЧАС с начала, а
    // мяч вылетает В КАДРЕ КОНТАКТА клипа (как вратарский вынос/вбрасывание) —
    // иначе мяч улетал раньше анимации удара (фидбек Олега 23.07). Бросок
    // (ласточка) и обычный удар исполняются мгновенно, как раньше.
    // Режим compute: вернуть вектор удара, НЕ применяя (замыкание в одно
    // касание пересчитывает удар в момент контакта из текущей позиции мяча)
    if (opts.compute) return { vel: launch, spin: curl };

    // Ласточка и обычный удар — применяем сразу; клип с кадра контакта
    ball.vel.copy(launch);
    ball.spin = curl; // щечка подкручена внутрь ноги, подъём/носок — чистые
    ball.afterTouch = B.afterTouchTime; // докрутка направлением доступна и тут
    // Клип по типу удара. У головы и удара с лёта клип задан в стиле ЖЁСТКО
    // (st.anim) — там кадр контакта вымерен по риггу и завязан на
    // CONFIG.player.aerial.sync, подменять его нельзя. Наземные удары
    // (носок / подъём / щёчка) выбирают клип по бьющей ноге.
    if (st.anim) this.playOneShot(st.anim, st.animTs, st.animAt);
    // УДАР ПО ВОРОТАМ ИГРАЕТ СВОЁ СЕМЕЙСТВО. Раньше он анимационно ничем не
    // отличался от паса — тот же клип-тычок, только строка таблицы другая, и
    // «кайфу от забитого гола» взяться было неоткуда. Тычок в касание (добивание
    // с метра) и удар из падения остаются короткими: там замаха и нет.
    else this.playStrike(styleName === 'toe' || opts.dive ? styleName : 'shot');
    // Удар по воротам «держит кадр»: чем сильнее бьём, тем дольше
    if (!opts.dive) this.hitStop(effCharge);
  }

  // ===== Замыкание в ОДНО КАСАНИЕ (PES 6, фидбек Олега 23–24.07.2026) =====
  // Мяч НЕ замирает у игрока (это и создавало «зависание»): замах начинается,
  // пока мяч подлетает, а перенаправление в ворота — в момент реального
  // контакта, сохраняя импульс приходящего мяча. Голова — с прыжком.
  //
  // Главное с 24.07: замах ПРИВЯЗАН К ПРОГНОЗУ ПРИЛЁТА. Клип удара получает
  // такой темп (и такой стартовый кадр), чтобы измеренный кадр контакта
  // (sync.hitKick / sync.hitHeader) пришёлся ровно на встречу с мячом. Прыжок
  // выходит в верхнюю точку тем же мигом, корпус доворачивается в удар к тому
  // же мигу. Раньше клип играл «своим» темпом, а мяч улетал когда придётся —
  // голова кивала уже вслед улетевшему мячу (замер: расхождение до 0.26 с).
  beginAerialStrike(s, input, ball) {
    const A = CONFIG.player.aerial;
    const SY = A.sync;
    const charge = s.type === 'swipe' ? Math.min(s.v.power, 1.3) : s.v;

    // Где и когда мяч реально встретится с игроком
    const hit = this.predictAerialContact(ball, A.readHorizon);
    const tHit = Math.max(SY.leadMin, Math.min(A.maxWait, hit.t));
    // Стиль решает ПРОГНОЗНАЯ высота контакта, а не высота мяча сейчас:
    // опускающийся мяч, что сегодня на груди, к удару придёт под колено —
    // и это волей ногой, а не кивок головой в пустоту
    let styleName = hit.y >= A.headerY ? 'header' : 'volley';
    // УДАР ЧЕРЕЗ СЕБЯ. Условие ровно то, при котором он и случается в жизни:
    // мяч высоко, игрок стоит СПИНОЙ к воротам (развернуться уже некогда) и до
    // встречи есть время на замах. Клип несёт и полёт тела, и падение на спину,
    // и подъём — поэтому искусственный выпрыг ему не нужен вовсе.
    if (this.actions.bicycle && hit.y >= A.bicycleFrom && hit.t >= A.bicycleLead &&
        this._backToGoal(hit)) {
      styleName = 'bicycle';
    }

    let gesture = null;
    if (s.type === 'swipe') {
      const gdir = new THREE.Vector3(s.v.dir.x, 0, s.v.dir.z).normalize();
      gesture = { dir: gdir, curl: -s.v.curl * CONFIG.shot.swipeCurl };
    }
    // Куда бьём — туда за время замаха и разворачивается корпус
    let aimRot = null;
    if (gesture) {
      aimRot = Math.atan2(gesture.dir.x, gesture.dir.z);
    } else if (this.team) {
      aimRot = Math.atan2(this.team.attackGoalX - hit.x, -hit.z);
    }

    this.aerialStrike = {
      styleName,
      charge,
      gesture,
      input,      // сохраняем ввод: прицел стрелками читается в момент контакта
      aimRot,
      point: { x: hit.tx, z: hit.tz }, // ноги встают ровно сюда
      t: 0,
      hitAt: tHit,
      hitY: hit.y,   // прогнозная высота контакта: по ней выбирается клип волея
      minDist: Infinity,
      clipDelay: 0,
      clipStarted: false,
    };
    this._scheduleStrikeClip(tHit, true);
    this._scheduleStrikeJump(styleName, tHit, hit.y, charge);
    // Блокируем повторный триггер/приём, пока идёт замах (но не даём кулдаун
    // на весь удар — он выставится при контакте)
    this.pendingStrike = null;
  }

  // Подгон клипа удара под момент контакта (сердце синхрона).
  // tLeft — сколько секунд осталось до встречи с мячом.
  // fresh = true — клип ещё не запущен: выбираем темп и стартовый кадр;
  // fresh = false — клип уже играет: сервоприводом правим только темп, чтобы
  // кадр контакта доехал ровно к уточнённому прогнозу (мяч тормозится о воздух,
  // игрок доворачивает бег — момент встречи всё время «плывёт»).
  _scheduleStrikeClip(tLeft, fresh) {
    const as = this.aerialStrike;
    if (!as) return;
    const SY = CONFIG.player.aerial.sync;
    // Клип выбирается ОДИН РАЗ, на входе в замах, и дальше не меняется: темп
    // ведёт сервопривод, а подмена клипа посреди замаха сбросила бы его.
    // Волей идёт коленом или носком по прогнозной высоте контакта.
    if (!as.clipName) {
      as.clipName = as.styleName === 'bicycle' ? 'bicycle'
        : as.styleName === 'header' ? 'header'
          : this.volleyClip(as.hitY != null ? as.hitY : 1.0);
    }
    const clip = this.actions[as.clipName] ? as.clipName : 'kick';
    // Кадр контакта — из ЕДИНОЙ таблицы CONFIG.player.anim.contact. Раньше он
    // жил ещё и в aerial.sync своей копией, и копии успели разойтись.
    const hitFrame = CONFIG.player.anim.contact[clip] != null
      ? CONFIG.player.anim.contact[clip] : 0.175;
    // Докуда доигрывать — СВОЁ у каждого клипа. Общего числа тут быть не может:
    // у удара через себя после контакта ещё падение на спину и подъём (0.82 →
    // 1.90 из 2.77), а у кивка проводка кончается почти сразу.
    const CE = CONFIG.player.anim.clipEnd;
    const endFrame = CE[clip] != null ? CE[clip]
      : (as.styleName === 'header' ? SY.endHeader : SY.endKick);
    const left = Math.max(1 / 120, tLeft);

    if (fresh) {
      let rate = hitFrame / left;
      let startAt = 0;
      if (rate > SY.rateMax) {
        // Мяч почти здесь: замах целиком не влезает — срезаем его начало,
        // но кадр удара всё равно приходит вовремя (резкий «выстрел» PES)
        rate = SY.rateMax;
        startAt = Math.max(0, hitFrame - left * rate);
      } else if (rate < SY.rateMin) {
        // Мячу лететь ещё долго: клип не растягиваем до «вязкости», а ждём —
        // игрок продолжает бежать и стартует замах позже
        rate = SY.rateMin;
        as.clipDelay = Math.max(0, left - hitFrame / rate);
      }
      as.clipRate = rate;
      as.clipStart = startAt;
      as.clipHit = hitFrame;
      as.clipEnd = endFrame;
      as.clipName = clip;
      if (as.clipDelay <= 0) {
        this.playOneShot(clip, rate, startAt, endFrame);
        as.clipStarted = true;
      }
      return;
    }

    // Сервопривод: клип играет — правим темп под уточнённый прогноз.
    // left уже зажат снизу (иначе на последнем кадре деление уносило темп
    // в клампы и проводка уходила в слоу-мо — замечено на стенде)
    const a = this.oneShot;
    if (!a || this.currentName !== as.clipName) return;
    const rate = (hitFrame - a.time) / left;
    if (rate > 0) {
      // Пол сервопривода поднят с rateMin×0.5 = 0.45 до самого rateMin. При
      // 0.45 окно удара растягивалось вдвое-втрое: замах вязко полз, пока мяч
      // долетал, и это читалось «мяч завис». Не успеваешь замахнуться в
      // человеческом темпе — значит это не замыкание, а приём.
      a.timeScale = Math.max(SY.rateMin, Math.min(SY.rateMax * 1.4, rate));
    }
  }

  // УДЕРЖАНИЕ КАДРА КОНТАКТА (hit-stop). Приём из файтингов и футсимов: на
  // 2–4 кадра темп клипа падает почти до нуля ровно в миг встречи с мячом.
  // Глаз успевает прочитать позу удара, и удар «весит». Держим ИГРОКА, а не
  // мяч: мяч обязан уйти сразу, иначе рассыпется физика.
  //
  // Раньше здесь было ровно наоборот: в кадре контакта темп ПОДНИМАЛСЯ до 1.7,
  // то есть самая ценная часть движения проматывалась быстрее всего.
  hitStop(power01 = 1) {
    const H = CONFIG.player.anim.hitStop;
    if (!H || !H.time || !this.oneShot) return;
    this._hitStopT = H.time * (H.minK + (1 - H.minK) * Math.min(1, power01));
    this._hitStopRate = this.oneShot.timeScale;
    this.oneShot.timeScale = this._hitStopRate * H.slow;
  }

  _updateHitStop(dt) {
    if (!(this._hitStopT > 0)) return;
    this._hitStopT -= dt;
    if (this._hitStopT <= 0 && this.oneShot) {
      // Выходим на ПРОВОДКУ: нога допрямляется своим темпом, а не тем, что был
      this.oneShot.timeScale = this._hitStopRate || 1;
    }
  }

  // Доворот корпуса в удар за время замаха: угол «доезжает» ровно к контакту.
  // Раньше корпус вставал по удару мгновенным присвоением rot (AI) или вообще
  // жил своей жизнью (человек) — кивок выглядел приклеенным к бегу.
  _turnIntoStrike(dt) {
    const as = this.aerialStrike;
    if (!as || as.aimRot == null) return;
    let d = as.aimRot - this.rot;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const left = Math.max(dt, as.hitAt - as.t);
    this.rot += d * Math.min(1, dt / left);
  }

  // Каждый кадр (из Match, до движения игрока): ведём замах к контакту и
  // перенаправляем мяч ровно в кадре удара. Мяч всё это время ЛЕТИТ сам.
  updateAerialStrike(dt, ball) {
    const as = this.aerialStrike;
    if (!as) return;
    const A = CONFIG.player.aerial;
    const SY = A.sync;
    const bp = ball.mesh.position;
    const pos = this.group.position;
    as.t += dt;
    // Прервать, если игрок сбит/в подкате/лёг — замыкание сорвалось
    if (this.downT > 0 || this.tackleT > 0 || this.diveT > 0) {
      this.aerialStrike = null;
      return;
    }

    const dist = Math.hypot(bp.x - pos.x, bp.z - pos.z);
    const wasClosing = dist <= as.minDist + 1e-4;
    as.minDist = Math.min(as.minDist, dist);

    // Уточняем прогноз каждый кадр и сглаженно ведём к нему момент удара.
    // Стиль зафиксирован (клип уже играет) — прогноз ищет встречу именно им
    const hit = this.predictAerialContact(ball, A.readHorizon, as.styleName);
    if (hit.dist < A.prepareRadius) {
      const want = as.t + hit.t;
      as.hitAt += (want - as.hitAt) * Math.min(1, dt * SY.servo);
      as.point.x = hit.tx;
      as.point.z = hit.tz;
      // Высота выпрыга тоже плывёт вместе с прогнозом: мяч тормозится о воздух,
      // игрок доворачивает бег — точка контакта уходит выше или ниже расчёта
      const wantJump = this._strikeJumpNeed(as.styleName, hit.y, as.charge != null ? as.charge : 1);
      if (this.jumpT > 0 && this.jumpHeight != null) {
        this.jumpHeight += (Math.max(0, wantJump) - this.jumpHeight) *
          Math.min(1, dt * SY.servo);
      } else if (wantJump > 0.04 && this.jumpT <= 0) {
        this.startJump(Math.max(1 / 60, as.hitAt - as.t), wantJump);
      }
    }
    let left = as.hitAt - as.t;

    // Отложенный замах: мячу было лететь дольше клипа — стартуем сейчас
    if (!as.clipStarted) {
      as.clipDelay -= dt;
      if (as.clipDelay <= 0 || left <= as.clipHit / as.clipRate) {
        this.playOneShot(as.clipName, as.clipRate, as.clipStart, as.clipEnd);
        as.clipStarted = true;
      }
    } else {
      this._scheduleStrikeClip(left, false);
    }

    // Мяч прошёл ближайшую точку (начал удаляться) — бьём по нему сейчас;
    // ждать дальше нечего, иначе мяч уйдёт «сквозь» игрока
    const passed = !wasClosing && as.minDist <= A.prepareRadius && as.t > 0.05;
    const timeout = as.t >= A.maxWait + SY.lateWait;
    // Кадр удара: либо доехал прогноз, либо клип дошёл до измеренного кадра
    // контакта — по определению это один и тот же миг, вторая проверка страхует.
    // Округляем к БЛИЖАЙШЕМУ кадру (полшага вперёд): иначе на быстром клипе
    // удар всегда чуть запаздывал — целый кадр проводки до вылета мяча
    const atFrame = as.clipStarted && this.oneShot &&
      this.currentName === as.clipName &&
      this.oneShot.time + this.oneShot.timeScale * dt * 0.5 >= as.clipHit;
    const onFrame = left <= dt * 0.5 || atFrame;
    if (!(onFrame || passed || timeout)) return;

    // Мяч так и не дошёл до бутсы/лба — это ПРОМАХ, а не удар: замах доигрывает
    // вхолостую, мяч летит дальше. Иначе получался «выстрел из воздуха» —
    // мяч менял направление в метре от игрока (замер на симуляции матча)
    const spMiss = this.strikePointWorld(as.styleName, _handA);
    if (spMiss && spMiss.distanceTo(bp) > SY.missRadius) {
      this.aerialStrike = null;
      this.kickCooldown = CONFIG.player.kickCooldown * 0.5; // отмашка ногой — пауза
      return;
    }

    // Мяч встаёт РОВНО на бутсу/лоб: без этого он отлетал от точки в метре от
    // игрока и контакт не читался (фидбек Олега «по позициям»). Поправку делим
    // на две части: ВДОЛЬ полёта мяча (глазу не видно — мяч и так идёт по этой
    // линии, бюджет щедрый) и ПОПЕРЁК (скупой, иначе мяч заметно телепортится).
    const sp = this.strikePointWorld(as.styleName, _handA);
    if (sp) {
      const dx = sp.x - bp.x;
      const dy = sp.y - bp.y;
      const dz = sp.z - bp.z;
      const vlen = Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z);
      let ax = 0;
      let ay = 0;
      let az = 0;          // продольная часть поправки (щедрый лимит)
      let px = dx;
      let py = dy;
      let pz = dz;         // поперечная часть (скупой лимит)
      if (vlen > 0.5) {
        const ux = ball.vel.x / vlen;
        const uy = ball.vel.y / vlen;
        const uz = ball.vel.z / vlen;
        const along = dx * ux + dy * uy + dz * uz;
        const cl = Math.max(-SY.snapAlong, Math.min(SY.snapAlong, along));
        ax = ux * cl;
        ay = uy * cl;
        az = uz * cl;
        px = dx - ux * along;
        py = dy - uy * along;
        pz = dz - uz * along;
      }
      const pd = Math.hypot(px, py, pz);
      const pk = pd > 0.001 ? Math.min(1, SY.snap / pd) : 0;
      bp.x += ax + px * pk;
      bp.y = Math.max(CONFIG.ball.radius, bp.y + ay + py * pk);
      bp.z += az + pz * pk;
    }

    // Перенаправляем мяч в ворота из ТОЧКИ КОНТАКТА (одно касание). Скорость
    // приходящего мяча уже вложена в силу (oneTouchMomentum). AI использует
    // заранее посчитанный вектор, человек пересчитывает удар из текущей позиции.
    if (as.aiVel) {
      ball.vel.copy(as.aiVel);
      ball.spin = as.aiSpin || 0;
    } else {
      const r = this.shoot(as.charge, as.input, ball, as.gesture,
        { aerial: true, dive: false, compute: true });
      ball.vel.copy(r.vel);
      ball.spin = r.spin;
    }
    ball.afterTouch = CONFIG.ball.afterTouchTime;
    // Проводка идёт своим резким темпом: замах мог тянуться под медленный мяч,
    // но НОГА ПОСЛЕ УДАРА всегда допрямляется быстро — иначе конец клипа
    // доигрывался в слоу-мо и съедал темп эпизода
    if (this.oneShot && this.currentName === as.clipName) {
      this.oneShot.timeScale = SY.followRate;
      this.hitStop(as.charge != null ? as.charge : 1);
    }
    this.lastStrikeStyle = as.styleName;
    this.kickCooldown = CONFIG.player.kickCooldown;
    this.ownEpisodeT = 0;
    this.aerialStrike = null;
  }

  // Бросок корпусом к мячу (удар в падении, просьба Олега 18.07.2026):
  // рывок ~2 м + вытянутый корпус (ласточка). Контакт случится — или нет —
  // в обычном цикле замыкания; после броска игрок лежит dive.recover сек.
  // Реалистичная зона: reach + бросок, никаких «полётов на 10 метров»
  startDive(dx, dz, contactY = 1.0) {
    const DV = CONFIG.player.aerial.dive;
    this.diveT = DV.time;
    this.diveDur = DV.time;
    this.diveSpeed = DV.lunge;
    this.diveRecover = DV.recover;
    this.diveTilt = DV.tiltMax;  // клипы kick/header стоячие — падение рисуем сами
    this.diveDir = { x: dx, z: dz };
    this.vel.x = dx * DV.lunge;
    this.vel.z = dz * DV.lunge;
    this.rot = Math.atan2(dx, dz); // корпус — в сторону броска
    this.playOneShot(contactY >= DV.headerY ? 'header' : 'kick', 1.0, 0.05);
  }

  // Бросок ВРАТАРЯ (ресёрч 16). Отличается от полевой «ласточки» тем, что
  // длительность, скорость и время подъёма берутся из CONFIG.ai.keeper, а на
  // верховой мяч кипер ещё и выпрыгивает: верхняя точка дуги ставится ровно
  // на миг встречи с мячом (та же механика, что у замыкания головой).
  // dirZ — вдоль линии ворот, dirX — вперёд/назад (обычно 0).
  startKeeperDive(dx, dz, opts = {}) {
    const K = CONFIG.ai.keeper;
    const dur = opts.dur || K.diveTime;
    this.diveT = dur;
    this.diveDur = dur;
    this.diveSpeed = opts.speed || K.diveSpeed;
    this.diveRecover = opts.recover != null ? opts.recover : K.recover;
    // Клип gk_dive самодостаточен: сам кладёт вратаря и сам поднимает.
    // Наш наклон поверх него топил фигуру под газон (см. _updateAnim)
    this.diveTilt = opts.tilt != null ? opts.tilt : K.diveTilt;
    const l = Math.hypot(dx, dz) || 1;
    this.diveDir = { x: dx / l, z: dz / l };
    this.vel.x = this.diveDir.x * this.diveSpeed;
    this.vel.z = this.diveDir.z * this.diveSpeed;
    // Корпус разворачивается ЛИЦОМ к мячу (кипер летит боком, а не спиной)
    if (opts.face != null) this.rot = opts.face;
    if (opts.lift > 0.05) this.startJump(Math.max(0.06, opts.liftIn || 0.14), opts.lift);

    // КЛИП ВЫБИРАЕТСЯ ПО СТОРОНЕ БРОСКА (правило с 28.07.2026). В модели лежал
    // ровно один бросок — влево, — и он играл на оба направления: половина
    // сейвов шла телом ПРОТИВ движения. Сторону считаем не по знаку dz (он в
    // мировых осях, а команды играют в разные ворота), а честно: проекцию
    // направления броска на вектор «вправо» самого вратаря.
    //
    // Форма выражения взята ОДИН В ОДИН из updateLoco (`side = fx·vz − fz·vx`),
    // и это не косметика: там она уже проверена — по ней выбирается приставной
    // шаг влево/вправо. Свой вывод «right = (cos rot, −sin rot)» я написал
    // зеркально и получил бросок влево на клипе вправо; правильный вектор
    // right = forward × up = (−fz, 0, fx) при forward = (sin rot, 0, cos rot).
    let name = opts.clip || null;
    if (!name) {
      const fx = Math.sin(this.rot);
      const fz = Math.cos(this.rot);
      const toRight = fx * this.diveDir.z - fz * this.diveDir.x;
      name = toRight > 0 ? 'gk_dive_r' : 'gk_dive';
    }
    // Темп подгоняется ПОД ФИЗИКУ, а не берётся числом: клипы разной длины
    // (gk_dive 2.07 с, gk_dive_r 3.27 с), и общий множитель растянул бы один
    // из них вдвое.
    //
    // Якорь — МОМЕНТ КАСАНИЯ ГАЗОНА, а не общая длина. Замер обоих клипов:
    // таз приходит вниз ровно на половине длины у каждого. Если растягивать
    // клип на «полёт + подъём», к концу полёта фигура успевает пройти лишь 40 %
    // клипа — то есть максимум растяжки наступает уже ПОСЛЕ того, как руки
    // должны встретить мяч, и на кадре сейва вратарь ещё в подседе.
    const act = this.actions[name];
    const DV = CONFIG.player.aerial.dive;
    const clipDur = act ? act.getClip().duration : 2.067;
    const start = clipDur * DV.clipStart;
    const rate = (clipDur * DV.clipGround - start) / Math.max(0.12, dur);
    this.playOneShot(name, opts.clipRate || rate, start);
  }

  // Снос: игрок сбит и лежит dur секунд (клип fallen), потом встаёт.
  // Всё «горячее» гаснет — сбитый не доигрывает пас из положения лёжа
  // ПАДЕНИЕ — ЭТО ТРИ КЛИПА, А НЕ ОДИН (правка 28.07.2026).
  //
  // Раньше сбитый игрок сразу играл `fallen`, и это было не падение: замер по
  // риггу показал, что в `fallen` таз стоит на 0.23 м ВСЕ 1.5 с (ход 7 мм) —
  // это лежачая СТОЙКА, снятая из «fallen idle.fbx». То есть фигура мгновенно
  // оказывалась лежащей за время блендинга, лежала, а потом так же мгновенно
  // оказывалась бегущей: клип `getup` не проигрывался НИКОГДА, потому что его
  // запуск был завязан на `downTiltAmp > 0`, а `startFall` ставил его в НОЛЬ —
  // условие ложно по построению.
  //
  // Теперь цепочка честная и вся вымерена по риггу пересобранной модели:
  //   trip   (1.567 с) таз 1.039 → 0.236, на газоне с 0.588 — САМО ПАДЕНИЕ;
  //   fallen (1.533 с) таз 0.23 ровно — ПЕТЛЯ лёжки, её длина и есть драма;
  //   getup  (1.700 с) таз 0.23 → 1.019 — ПОДЪЁМ до стойки.
  // Стыки сходятся по высоте таза (0.236 → 0.23 → 0.23), а остаток разрыва поз
  // сшивает слой инерциализации (src/pose.js).
  startFall(dur) {
    const F = CONFIG.player.fall;
    this.downT = dur;
    this.downDur = dur;
    this.downTiltAmp = 0;     // весь силуэт даёт клип, ручной наклон не нужен
    this.slideRecover = false;
    this._gotUp = false;
    this._fallPhase = 'drop';
    this.controlling = false;
    this.pendingStrike = null;
    this.strikeContactLock = false;
    this.cancelBallApproach();
    // Падение идёт со скоростью, с которой снято: голова проходит 1.30 м за
    // 0.59 с, а свободное падение с этой высоты занимает 0.51 с — то есть темп
    // уже почти физический. Разгонять его (прежние 1.2 поверх ускоренного в
    // 1.61 раза клипа давали 1.93×) значит ронять человека быстрее гравитации.
    this.playOneShot('trip', F.dropRate, 0, null, blendTime('fall'));
  }

  // Ведение цепочки падения. Вызывается из _updateAnim, пока downT > 0.
  _updateFall(dt) {
    const F = CONFIG.player.fall;
    if (this._fallPhase === 'drop') {
      // Упал: клип падения дошёл до газона — переходим в лёжку петлёй
      if (!this.oneShot || this.currentName !== 'trip' ||
          this.oneShot.time >= F.dropGround) {
        this._fallPhase = 'down';
        this.playOneShot('fallen', 1, 0, null, blendTime('fall'));
        if (this.oneShot) this.oneShot.setLoop(THREE.LoopRepeat, Infinity);
      }
      return;
    }
    if (this._fallPhase === 'down') {
      // Встаём НЕ по таймеру, а так, чтобы подъём успел доиграть целиком
      const rise = (this.actions.getup ? this.actions.getup.getClip().duration : 1.7)
        / F.getupRate;
      if (this.downT <= rise) {
        this._fallPhase = 'rise';
        this.playOneShot('getup', F.getupRate, 0, null, blendTime('getup'));
      }
    }
  }

  // ===== Подкат (ресёрч 09/12/13: ○ в PES 5/6 — high risk / high reward) =====

  // Вход человека: кнопка ПОДКАТА в обороне. Срабатывает ТОЛЬКО когда мячом
  // реально владеет соперник рядом (как ○ в PES: отбор — оборонительное
  // действие, а не «падение в никуда»). Если мяч наш, летит между своими
  // (пас/навес с ходу) или отпущен на спринте — возвращаем false, и кнопка
  // остаётся навесом (фидбек Олега 21.07: подкат перебивал навес с ходу).
  // Направление — стик, без стика целим в соперника-владельца (грубый подкат
  // сзади возможен). true = подкат пошёл.
  tryTackle(ball, aimDir) {
    const m = this.team && this.team.match;
    if (this.tackleCd > 0 || this.tackleT > 0 || this.downT > 0 ||
        this.diveT > 0 || this.kickCooldown > 0) return false;
    if (!m || m.state === 'restart') return false; // мёртвый мяч — свисток бы не дал
    if (this.isToucher === true) return false;      // мяч у меня — это навес/удар
    // Владение считаем по команде, а не по мгновенному касанию: пас в полёте
    // (toucher = null) всё ещё «наш мяч», подкат тут не нужен
    if (m.possession === this.team) return false;
    const owner = m.toucher;
    if (!owner || owner.team === this.team) return false; // никто/свой владеет — не отбор
    const TK = CONFIG.player.tackle;
    const pos = this.group.position;
    const op = owner.group.position;
    // Соперник-владелец должен быть в досягаемости слайда — но дистанцию мерим
    // С УЧЁТОМ СБЛИЖЕНИЯ: прущий на меня форвард за время слайда сам приедет.
    // Раньше самый естественный подкат (шаг навстречу) движок отказывался
    // исполнять с 4.5 м, хотя сближение было 9 м/с (замер 24.07)
    const relX = op.x - pos.x;
    const relZ = op.z - pos.z;
    const d0 = Math.hypot(relX, relZ) || 1;
    const closing = Math.max(0,
      ((this.vel.x - owner.vel.x) * relX + (this.vel.z - owner.vel.z) * relZ) / d0);
    if (d0 - closing * TK.reachClosing > TK.reachOwner) return false;

    // Прицел: стик, иначе — В МЯЧ с упреждением на приход НОГИ (раньше целились
    // в корпус соперника: слайд шёл в человека — фол или мимо мяча)
    let dx;
    let dz;
    if (aimDir) {
      dx = aimDir.x;
      dz = aimDir.z;
    } else {
      const aim = this.tackleAim(ball);
      dx = aim.x;
      dz = aim.z;
    }
    if (Math.hypot(dx, dz) < 0.01) {
      dx = this.facing.x;
      dz = this.facing.z;
    }
    this.startTackle(dx, dz);
    return true;
  }

  // Подбор силы верховой передачи ЧЕСТНОЙ баллистикой: скорость ищется
  // бисекцией по той же физике, что в ball.update (drag + Магнус), а не по
  // формуле идеальной параболы с поправочным коэффициентом. Формула + fudge
  // промахивались мимо адресата на 0.8–2.0 м (замер 24.07): на своей половине
  // мягкий заброс «улетал не туда», и партнёр бежал не к тому месту.
  solveLoftPower(dist, theta, targetH, lo, hi) {
    const B = CONFIG.ball;
    const fly = (power) => {
      let x = 0;
      let y = CONFIG.ball.radius;
      let vx = power;
      let vy = power * Math.tan(theta);
      const dt = 1 / 120;
      for (let t = 0; t < 6; t += dt) {
        vy += B.gravity * dt;
        const sp = Math.hypot(vx, vy);
        if (sp > 0.01) {
          const k = Math.min(B.dragK * sp * dt, 0.5);
          vx *= 1 - k;
          vy *= 1 - k;
        }
        x += vx * dt;
        y += vy * dt;
        if (vy < 0 && y <= targetH) return x;
        if (y < 0) return x;
      }
      return x;
    };
    let a = lo;
    let b = hi;
    for (let i = 0; i < 26; i++) {
      const mid = (a + b) / 2;
      if (fly(mid) < dist) a = mid; else b = mid;
    }
    return (a + b) / 2;
  }

  // Достанет ли слайд мяч вообще: путь корпуса до точки прицела (минус вынос
  // ноги) против того, сколько корпус проедет за активную фазу скольжения.
  // Нужно, чтобы AI шёл в подкат, когда есть РЕАЛЬНЫЙ шанс, а не по таймеру.
  tackleReachable(ball) {
    const TK = CONFIG.player.tackle;
    const aim = this.tackleAim(ball);
    const need = Math.max(0, Math.hypot(aim.x, aim.z) - TK.legAhead - TK.legReach);
    const run = Math.hypot(this.vel.x, this.vel.z);
    const sld = Math.min(TK.speedMax, Math.max(TK.speedMin, run * TK.runBoost));
    const avg = (sld + TK.speedEnd) / 2; // слайд затухает по ходу
    return need <= avg * TK.time * TK.activeTo;
  }

  // Куда вести слайд: точка, где окажется МЯЧ к приходу вытянутой ноги.
  // Итерация из трёх шагов — время долёта зависит от дистанции, а дистанция
  // от времени. Вынос ноги (legAhead) укорачивает нужный путь корпуса.
  tackleAim(ball) {
    const TK = CONFIG.player.tackle;
    const pos = this.group.position;
    const bp = ball.mesh.position;
    const run = Math.hypot(this.vel.x, this.vel.z);
    const sld = Math.min(TK.speedMax, Math.max(TK.speedMin, run * TK.runBoost));
    let t = 0;
    for (let i = 0; i < 3; i++) {
      const tx = bp.x + ball.vel.x * t;
      const tz = bp.z + ball.vel.z * t;
      const d = Math.max(0, Math.hypot(tx - pos.x, tz - pos.z) - TK.legAhead);
      t = Math.min(TK.aimLeadMax, d / Math.max(sld, 1));
    }
    return {
      x: bp.x + ball.vel.x * t - pos.x,
      z: bp.z + ball.vel.z * t - pos.z,
      t,
    };
  }

  startTackle(dx, dz) {
    const TK = CONFIG.player.tackle;
    const dl = Math.hypot(dx, dz) || 1;
    this.tackleT = TK.time;
    this.tackleDir = { x: dx / dl, z: dz / dl };
    this.tackleHit = false;
    this.tackleFoul = false;
    this.tackleCd = TK.cooldown;
    this._tackleVictim = null;
    // Инерция: слайд с разгона летит дальше, с места — короткий (дух PES)
    const run = Math.hypot(this.vel.x, this.vel.z);
    this.tackleSpeed = Math.min(TK.speedMax, Math.max(TK.speedMin, run * TK.runBoost));
    this.slideRecover = false;
    this.rot = Math.atan2(dx, dz); // корпус — по слайду
    this.vel.x = this.tackleDir.x * this.tackleSpeed;
    this.vel.z = this.tackleDir.z * this.tackleSpeed;
    this.pendingStrike = null;
    this.strikeContactLock = false;
    this.cancelBallApproach();
    // Клип стартует ровно на входе в фазу подметания (таз на газоне, нога
    // вытянута), а темп подбирается так, чтобы эта фаза заняла ровно слайд:
    // раньше первую треть слайда игрок ещё «падал» стоя, уже скользя по полю
    const sweep = TK.sweepTo - TK.sweepFrom;
    const rate = Math.max(0.6, Math.min(1.8, sweep / Math.max(0.05, TK.time)));
    this.playOneShot('tackle', rate, TK.clipStart);
  }

  // Скольжение: контакт ноги с мячом выбивает его в 50/50 (владение НЕ
  // телепортируется — принцип PES), контакт корпусом без выбитого мяча —
  // грубый снос: жертва падает, сам потом лежишь дольше всех. Сзади мяч
  // экранирован телом — чисто сыграть можно, только если он заметно сбоку.
  // Вызывается раз в кадр (человек — из update, AI — из fieldplayer)
  updateTackle(dt, ball) {
    if (this.tackleT <= 0) return false;
    const TK = CONFIG.player.tackle;
    this.tackleT -= dt;

    const pos = this.group.position;
    const bp = ball.mesh.position;

    // Активное окно ног (GFootball: кадры 5–28 слайда): в самом начале
    // и на затухании ни отбора, ни сноса нет — только средняя фаза
    const prog = 1 - Math.max(0, this.tackleT) / TK.time;
    const active = prog >= TK.activeFrom && prog <= TK.activeTo;

    // Выбивание: отскок с разбросом — подбор 50/50, владение не телепортируется
    const knock = () => {
      const spd = Math.hypot(this.vel.x, this.vel.z);
      const a = ((Math.random() * 2 - 1) * TK.knockSpread * Math.PI) / 180;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      ball.strike(
        {
          x: this.tackleDir.x * ca - this.tackleDir.z * sa,
          z: this.tackleDir.x * sa + this.tackleDir.z * ca,
        },
        TK.knockBase + spd * TK.knockRun,
        TK.knockLift * (0.5 + Math.random()),
      );
      ball.afterTouch = 0; // выбитый мяч не докручивают
      this.tackleHit = true;
      this.kickCooldown = CONFIG.player.kickCooldown;
    };

    const dBall = Math.hypot(bp.x - pos.x, bp.z - pos.z);

    // Достала ли МЯЧ вытянутая нога. Точка ноги — из скелета (кадр подметания),
    // фолбэк на капсуле — вынос legAhead по курсу слайда. Раньше мерили от
    // ЦЕНТРА игрока (1.35 м): мяч «выбивался», когда нога была в полуметре от
    // него, и подкат читался как удар по воздуху (замер 24.07)
    const legHit = () => {
      if (!active || bp.y >= TK.ballMaxY) return false;
      if (dBall > TK.ballReach + TK.legAhead) return false; // грубый предфильтр
      const lp = this.strikePointWorld('tackle', _handB);
      if (lp) return Math.hypot(bp.x - lp.x, bp.y - lp.y, bp.z - lp.z) < TK.legReach;
      const d = this.tackleDir || { x: this.facing.x, z: this.facing.z };
      return Math.hypot(bp.x - (pos.x + d.x * TK.legAhead),
        bp.z - (pos.z + d.z * TK.legAhead)) < TK.legReach;
    };

    // Вытянутая нога достаёт мяч — выбить
    if (!this.tackleHit && legHit()) knock();

    // Столкновение с соперником (одна жертва за слайд)
    const m = this.team && this.team.match;
    if (m && active && !this._tackleVictim) {
      for (const o of m.otherTeam(this.team).players) {
        if (o.downT > 0) continue;
        // Кипера с мячом в руках не сносим — это всегда свисток
        if (o.isKeeper && o.ai && o.ai.holding) continue;
        const op = o.group.position;
        if (Math.hypot(op.x - pos.x, op.z - pos.z) > TK.bodyReach) continue;
        this._tackleVictim = o;
        o.vel.x += this.tackleDir.x * TK.victimPush;
        o.vel.z += this.tackleDir.z * TK.victimPush;
        const fromBehind =
          this.tackleDir.x * o.facing.x + this.tackleDir.z * o.facing.z > TK.backCos;
        // Мяч у ног владельца: пороги ноги и тела пересекаются в один кадр,
        // и дискретность превращала бы честный подкат сбоку-в-мяч в снос.
        // Нога впереди корпуса — если мяч в досягаемости, она играет ПЕРВОЙ
        // (сзади мяч экранирован телом — туда нога не дотягивается)
        if (active && !this.tackleHit && !fromBehind &&
            dBall < TK.ballReach * 1.15 && bp.y < CONFIG.player.tackle.ballMaxY) {
          knock();
        }
        // Мяч у ног сбитого соперника освобождается в сторону слайда — даже
        // при сносе сзади (фидбек Олега: после отбора мяч оставался на месте).
        // Соперник потерял контроль — мяч катится, куда шёл подкат
        const opBall = Math.hypot(bp.x - op.x, bp.z - op.z);
        if (!this.tackleHit && opBall < CONFIG.player.controlKeepRadius &&
            bp.y < CONFIG.player.tackle.ballMaxY) {
          knock();
        }
        // Мяч заметно сбоку от корпуса жертвы — дотянуться можно и сзади-сбоку
        const side = Math.abs(
          o.facing.x * (bp.z - op.z) - o.facing.z * (bp.x - op.x));
        if (this.tackleHit && (!fromBehind || side > TK.sideClear)) {
          // Жёстко, но чисто: мяч уже выбит, соперник спотыкается об подкат
          o.kickCooldown = Math.max(o.kickCooldown, TK.victimTrip);
          o.controlling = false;
          o.playOneShot('trip', TK.tripRate, 0, null, blendTime('fall'));
        } else {
          // Грубо: ноги вперёд в игрока (или сзади) — снос. Свисток — Фаза 5
          o.startFall(TK.victimDown);
          this.tackleFoul = true;
        }
        break;
      }
    }

    // Слайд закончился: игрок ещё «выключен» на recover, пока клип `tackle`
    // доигрывает вставание (slideRecover — не путать с fallen-падением)
    if (this.tackleT <= 0) {
      const rec = this.tackleFoul
        ? TK.recoverFoul
        : this.tackleHit ? TK.recoverHit : TK.recoverMiss;
      this.downT = rec;
      this.downDur = rec;
      this.slideRecover = true;
      this.tackleDir = null;
      this._tackleVictim = null;
      // ХВОСТ КЛИПА УСКОРЯЕМ, а не держим игрока выключенным дольше.
      // Развилка тут неочевидная. Клип `tackle` доигрывает вставание только к
      // 1.29 с после начала подката, а прежние recoverHit = 0.55 отдавали
      // управление на 1.00 — игрок вставал из полуприседа и бежал (таз на
      // 0.66 м из 1.07). Растянуть recoverHit до 0.87, чтобы клип успел, —
      // решение честное анимационно и ПЛОХОЕ для баланса: автосимуляция дала
      // 4.25 гола за матч против эталонных 3.6, потому что отбор стал стоить
      // слишком дорого. Правильный ответ — не держать игрока дольше, а дать
      // ему встать БЫСТРЕЕ: подкатившийся вскакивает рывком, и это ещё и
      // правдивее вялого подъёма.
      if (this.oneShot && TK.getupBoost > 1) {
        this.oneShot.timeScale *= TK.getupBoost;
      }
    }
    return true;
  }

  // Навал корпусом (ресёрч 12): кнопка паса, когда мяч не у нашей команды.
  // Сбоку/спереди у владельца — оттеснение и сбитое касание (мяч отскакивает,
  // окно отбора); под верховым мячом — оттеснение соперника от точки падения.
  // Толчок В СПИНУ — нечестный: сам спотыкаешься. true = навал случился
  // (кнопка потрачена), false = соперника рядом нет — обычный пас/подбор
  tryChallenge(ball) {
    const CH = CONFIG.player.challenge;
    const P = CONFIG.player;
    const team = this.team;
    const m = team && team.match;
    // На мёртвом мяче (стандарт) толкаться нельзя — свисток бы не дал;
    // в подкате руки заняты газоном
    if (!m || m.state === 'restart' || this.challengeCd > 0 ||
        this.tackleT > 0 || this.isToucher) return false;
    const owner = m.toucher;
    if (owner && owner.team === team) return false; // мяч у своих — это пас
    const pos = this.group.position;

    // Цель навала: владелец в радиусе; мяч ничей и верхом — ближний соперник
    let target = null;
    if (owner) {
      const op = owner.group.position;
      if (Math.hypot(op.x - pos.x, op.z - pos.z) <= CH.range) target = owner;
    } else if (ball.mesh.position.y > P.kickMaxBallY) {
      let bd = Infinity;
      for (const o of m.otherTeam(team).players) {
        if (o.isKeeper) continue;
        const op = o.group.position;
        const d = Math.hypot(op.x - pos.x, op.z - pos.z);
        if (d < bd) {
          bd = d;
          target = o;
        }
      }
      if (bd > CH.range) target = null;
    }
    if (!target) return false;

    const tp = target.group.position;
    const dx = tp.x - pos.x;
    const dz = tp.z - pos.z;
    const dl = Math.hypot(dx, dz) || 1;
    const nx = dx / dl;
    const nz = dz / dl;
    this.challengeCd = CH.cooldown;

    // Толчок по направлению взгляда цели = в спину: сам спотыкаешься
    if (nx * target.facing.x + nz * target.facing.z > CH.backCos) {
      this.vel.x *= 0.25;
      this.vel.z *= 0.25;
      this.challengeCd = CH.cooldown + CH.stumble;
      this.playOneShot('trip', 1.5, 0.1);
      return true;
    }

    // Честный навал: оттесняем цель, вкладываясь корпусом
    target.vel.x += nx * CH.pushTarget;
    target.vel.z += nz * CH.pushTarget;
    this.vel.x += nx * CH.pushSelf;
    this.vel.z += nz * CH.pushSelf;
    if (target.isToucher) {
      const bp = ball.mesh.position;
      if (bp.y < P.kickMaxBallY &&
          Math.hypot(bp.x - tp.x, bp.z - tp.z) < P.controlKeepRadius) {
        // Сбитое касание: мяч отскакивает — ничей, окно отбора
        ball.vel.x = nx * CH.looseBall + target.vel.x * 0.4 + (Math.random() - 0.5) * 2;
        ball.vel.z = nz * CH.looseBall + target.vel.z * 0.4 + (Math.random() - 0.5) * 2;
        target.kickCooldown = Math.max(target.kickCooldown, CH.targetLock);
        target.controlling = false;
        target.playOneShot('trip', 1.4, 0.12); // сбитый спотыкается
      }
    }
    return true;
  }

  // Ближайшая точка КОРПУСА к мячу: вертикальный отрезок от стопы до лба,
  // сдвинутый чуть вперёд по взгляду. Возвращает { x, y, z, dist } — это и
  // есть «мяч коснулся игрока», а не «мяч влетел в радиус полтора метра».
  bodyContactPoint(bp) {
    const T = CONFIG.player.trap;
    const pos = this.group.position;
    const f = this.facing;
    const cx = pos.x + f.x * T.bodyAhead;
    const cz = pos.z + f.z * T.bodyAhead;
    const cy = Math.max(T.bodyLowY, Math.min(T.bodyTopY, bp.y));
    const horiz = Math.hypot(bp.x - cx, bp.z - cz);
    // Касание = мяч над корпусом по горизонтали И в пределах роста. Мерить
    // одним 3D-радиусом нельзя: мяч в 40 см НАД ГОЛОВОЙ попадал в сферу и
    // «принимался» (замер 24.07) — рост считаем отдельной проверкой
    return {
      x: cx, y: cy, z: cz, horiz,
      dist: Math.hypot(bp.x - cx, bp.y - cy, bp.z - cz),
      reachable: horiz < T.contactRadius &&
        bp.y <= T.bodyTopY && bp.y >= T.bodyLowY - T.underFoot,
    };
  }

  // Приём верхового мяча: мяч ГАСИТСЯ О КОРПУС в точке касания и сходит под
  // ноги ПО СВОЕМУ ходу. Клипа и прыжков по-прежнему нет (просьба Олега
  // 23.07) — вместо них короткий подсед корпуса: видно, что мяч приняли.
  // Раньше мяч менял направление в метре от груди и мог улететь назад в
  // пасующего на 3.4 м/с — это и читалось как «отскок от дерева».
  trapBall(ball, contact = null) {
    const T = CONFIG.player.trap;
    const bp = ball.mesh.position;
    const c = contact || this.bodyContactPoint(bp);

    // Мяч встаёт на точку касания (сдвиг ограничен — телепорта не видно)
    const dx = c.x - bp.x;
    const dy = c.y - bp.y;
    const dz = c.z - bp.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > 0.001) {
      const k = Math.min(1, T.snap / d);
      bp.x += dx * k;
      bp.y = Math.max(CONFIG.ball.radius, bp.y + dy * k);
      bp.z += dz * k;
    }

    // Гашение: мяч НЕ разворачивается назад — он сходит с корпуса по своему
    // ходу плюс доля бега игрока. Стоящий игрок просто роняет мяч себе в ноги.
    const insp = Math.hypot(ball.vel.x, ball.vel.z);
    const ux = insp > 0.1 ? ball.vel.x / insp : this.facing.x;
    const uz = insp > 0.1 ? ball.vel.z / insp : this.facing.z;
    let vx = ux * T.keepIn + this.vel.x * T.keepRun;
    let vz = uz * T.keepIn + this.vel.z * T.keepRun;
    const sp = Math.hypot(vx, vz);
    if (sp > T.maxOut) {
      vx = (vx / sp) * T.maxOut;
      vz = (vz / sp) * T.maxOut;
    }
    // Вниз — тем сильнее, чем выше приняли: мяч у самой земли не вколачиваем
    const drop = T.dropSpeed *
      Math.max(0.2, Math.min(1, (c.y - T.bodyLowY) / (T.dropRefY - T.bodyLowY)));
    ball.vel.set(vx, -drop, vz);
    ball.spin = 0;
    ball.afterTouch = 0;
    this.kickCooldown = T.settle; // мяч опускается — нога ждёт
    this.trapCushion = T.cushionTime; // корпус «мягкий»: видно, что приняли
    this.ownEpisodeT = CONFIG.player.approach.episodeGrace;
    this.cancelBallApproach();
  }

  // Верховой мяч у AI: сыграть в ОДНО КАСАНИЕ — вынос, скидка или кивок в
  // створ. Синхрон тот же, что у человека (кадр удара клипа = миг контакта,
  // верхняя точка прыжка = миг контакта, корпус доворачивается к тому же мигу).
  aiAerial(ball, dir, power, lift) {
    const A = CONFIG.player.aerial;
    const SY = A.sync;
    const d = Math.hypot(dir.x, dir.z) || 1;
    const ndir = { x: dir.x / d, z: dir.z / d };
    const hit = this.predictAerialContact(ball, A.readHorizon);
    const tHit = Math.max(SY.leadMin, Math.min(A.maxWait, hit.t));
    const isHeader = hit.y >= A.headerY;
    this.aerialStrike = {
      styleName: isHeader ? 'header' : 'volley',
      aiVel: new THREE.Vector3(ndir.x * power, lift, ndir.z * power),
      aiSpin: 0,
      aimRot: Math.atan2(ndir.x, ndir.z), // корпус доворачивается К УДАРУ, не рывком
      point: { x: hit.tx, z: hit.tz },
      t: 0,
      hitAt: tHit,
      hitY: hit.y,
      minDist: Infinity,
      clipDelay: 0,
      clipStarted: false,
    };
    this._scheduleStrikeClip(tHit, true);
    this._scheduleStrikeJump(isHeader ? 'header' : 'volley', tHit, hit.y, 1); // AI — полноценный выпрыг
  }
}
