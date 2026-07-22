// Игрок: модель из Blender (models/player.glb, риг Mixamo, 22 анимации).
// Пока glb грузится (или если не загрузился) — капсула-заглушка, геймплей тот же.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { CONFIG } from './config.js';
import { predictLanding, pursuitBall } from './ai/steering.js';

// Один .glb на всех: грузится единожды, каждый игрок получает клон со скелетом.
// Исходные материалы НЕ трогаем — каждый клон собирает свои (цвет команды).
let modelPromise = null;
function loadPlayerModel() {
  if (!modelPromise) {
    modelPromise = new GLTFLoader().loadAsync('./models/player.glb');
  }
  return modelPromise;
}

// Перекраска атласа формы под цвет команды: цветные пиксели (красный дефолт)
// получают заданный цвет с сохранением светотени, белый/чёрный не трогаются.
// Кэш по цвету: у 4 расцветок (2 команды + 2 вратаря) — 4 текстуры на всех.
const kitTexCache = new Map();
function getKitTexture(gltf, colorHex) {
  if (!colorHex) return null;
  if (kitTexCache.has(colorHex)) return kitTexCache.get(colorHex);
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
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false; // glTF-развёртка хранится без переворота
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  kitTexCache.set(colorHex, tex);
  return tex;
}

// Временные вектора для handsWorldPoint — без аллокаций в кадре
const _handA = new THREE.Vector3();
const _handB = new THREE.Vector3();

// Какие клипы играются один раз (удары, падения), остальные — циклы
const ONE_SHOT = new Set([
  'kick', 'kick_run', 'penalty', 'header', 'tackle', 'trip', 'getup',
  'throwin', 'receive', 'gk_catch', 'gk_dive', 'gk_dropkick', 'gk_throw',
  'gk_scoop', 'gk_pass',
]);

export class Player {
  // opts.kitColor — hex-цвет формы ('#3a62d8'); без него — атлас как есть.
  // Команду, роль и isKeeper проставляет Team (src/ai/team.js).
  constructor(scene, opts = {}) {
    const P = CONFIG.player;
    this.kitColor = opts.kitColor || null;
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

    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(P.radius * 1.25, 12),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
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

    loadPlayerModel()
      .then((gltf) => this.attachModel(gltf))
      .catch((e) => console.error('Модель игрока не загрузилась, остаёмся на капсуле:', e));

    scene.add(this.group);
    scene.add(this.shadow);
    this.reset();
  }

  attachModel(gltf) {
    this.model = cloneSkeleton(gltf.scene);
    this.model.scale.setScalar(CONFIG.player.modelScale); // ноги в origin — растём вверх, не в землю

    // Материалы — свои у каждого клона: форма перекрашена в цвет команды.
    // Lambert вместо Standard: быстрее на планшете, с плоскими гранями и
    // пиксельной текстурой выглядит так же (стиль PS1). Emissive ~45% —
    // без него фигура на вечернем поле чёрная.
    const kitTex = getKitTexture(gltf, this.kitColor);
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      // Скелет двигает вершины мимо исходной рамки объекта — отсечение по ней врёт
      o.frustumCulled = false;
      const src = o.material;
      const map = (src.name === 'kit' && kitTex) ? kitTex : src.map;
      const mat = map
        ? new THREE.MeshLambertMaterial({ map, emissive: 0x737373, emissiveMap: map })
        : new THREE.MeshLambertMaterial({
            color: src.color.clone(),
            emissive: src.color.clone().multiplyScalar(0.45),
          });
      mat.name = src.name; // имена kit/skin/head нужны для перекраски из JSON
      o.material = mat;
    });

    this.group.add(this.model);
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
        this.oneShot = null;
        this.currentName = null; // следующий кадр сам выберет idle/run
      }
    });
    this.playAction('idle', 0);
  }

  // Плавное переключение клипа (crossfade), повторный вызов того же клипа — no-op
  playAction(name, fade = 0.12) {
    const next = this.actions[name];
    if (!next || this.currentName === name) return;
    next.enabled = true;
    next.reset();
    if (this.currentAction && this.currentAction !== next) {
      next.crossFadeFrom(this.currentAction, fade, false);
    }
    next.play();
    this.currentAction = next;
    this.currentName = name;
  }

  // Одноразовый клип поверх движения (удар, подкат…).
  // startAt (сек клипа) стартует не с нуля, а ближе к контакту с мячом:
  // удар мгновенный, а полный замах отставал бы от уже улетевшего мяча.
  playOneShot(name, timeScale = 1, startAt = 0) {
    const a = this.actions[name];
    if (!a) return;
    if (this.currentAction && this.currentAction !== a) {
      this.currentAction.fadeOut(0.05);
    }
    a.reset();
    a.time = startAt;
    a.timeScale = timeScale;
    a.enabled = true;
    a.setEffectiveWeight(1);
    a.fadeIn(0.05);
    a.play();
    this.currentAction = a;
    this.currentName = name;
    this.oneShot = a;
  }

  reset(x = -3, z = 0, rot = Math.PI / 2) {
    this.group.position.set(x, 0, z);
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
    this.sprintBoost = 0;
    this.jumpT = 0;
    this.diveT = 0;
    this.diveDir = null;
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
    // Прыжок под удар головой: короткая дуга вверх-вниз (визуал, физику
    // замыкания решает зона aerial.maxY — прыжок её не расширяет)
    if (this.jumpT > 0) {
      const A = P.aerial;
      this.jumpT -= dt;
      const k = Math.max(0, 1 - this.jumpT / A.jumpTime);
      this.group.position.y = Math.sin(Math.PI * k) * A.jumpHeight;
      if (this.jumpT <= 0) this.group.position.y = 0;
    }
    // Бросок корпусом (ласточка) и подъём: наклон фигуры по взгляду
    // (порядок эйлера YXZ), после броска — лежим и встаём клипом getup.
    // Подкат: клип Mixamo — стоячий выпад, поэтому скольжение рисуем сами —
    // корпус откинут НАЗАД (ноги вперёд), после слайда сидим на газоне
    const DV = P.aerial.dive;
    let tilt = 0;
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
      tilt = (1 - Math.max(0, this.diveT) / DV.time) * DV.tiltMax;
      if (this.diveT <= 0) {
        this.downT = DV.recover;
        this.downDur = DV.recover;
        this.downTiltAmp = DV.tiltMax;
        this._gotUp = false;
      }
    } else if (this.downT > 0) {
      this.downT -= dt;
      const k = Math.max(0, this.downT) / (this.downDur || DV.recover);
      if (k < 0.55 && !this._gotUp) {
        this._gotUp = true;
        this.playOneShot('getup', 1.4, 0);
      }
      const amp = this.downTiltAmp != null ? this.downTiltAmp : DV.tiltMax;
      tilt = Math.min(1, k / 0.55) * amp; // поднимаемся вместе с getup
    }
    this.group.rotation.x = tilt;
    if (this.mixer) {
      // Пока играет одноразовый (удар, ловля) — не дёргаем
      if (!this.oneShot) {
        if (speed < 0.6) {
          const idle = this.isKeeper && this.actions.gk_idle ? 'gk_idle' : 'idle';
          this.playAction(idle, 0.18);
        } else {
          // Продольная и поперечная составляющие скорости относительно взгляда
          const f = this.facing;
          const fwd = this.vel.x * f.x + this.vel.z * f.z;
          const side = f.x * this.vel.z - f.z * this.vel.x; // >0 — движение вправо от взгляда
          let clip = 'run';
          if (Math.abs(fwd) < speed * 0.5 && this.actions.strafe_l) {
            clip = side > 0 ? 'strafe_r' : 'strafe_l'; // боком — приставные шаги
          } else if (fwd < -speed * 0.5 && this.actions.run_back) {
            clip = 'run_back'; // пятимся, не отворачиваясь от мяча
          }
          this.playAction(clip, 0.12);
          // Темп ног растёт со скоростью (клипы сняты под лёгкую трусцу)
          this.actions[clip].timeScale = Math.min(1.9, Math.max(0.6, speed / 4.0));
        }
      }
      this.mixer.update(dt);
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
    if (this.diveT > 0) maxSpeed = Math.max(maxSpeed, P.aerial.dive.lunge);
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
    let want = null;
    if (speed > 0.5) want = Math.atan2(this.vel.x, this.vel.z);
    else if (opts.face != null) want = opts.face;
    if (want != null) {
      let d = want - this.rot;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const turn = P.turnRate * (1 - (1 - P.sprintTurnFactor) * this.sprintBoost);
      this.rot += d * Math.min(1, turn * dt);
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
  // anim позволяет мозгу выбрать клип (вратарь ловит/выбивает своими)
  aiKick(ball, dir, power, lift, curl = 0, anim = null) {
    const d = Math.hypot(dir.x, dir.z) || 1;
    const ndir = { x: dir.x / d, z: dir.z / d };
    ball.strike(ndir, power, lift, curl);
    this.rot = Math.atan2(ndir.x, ndir.z); // корпус доворачивается по удару
    this.kickCooldown = CONFIG.player.kickCooldown;
    this.ownEpisodeT = 0; // передача закрывает эпизод владения
    const a = anim || { name: 'kick', ts: 1.6, at: 0.20 };
    this.playOneShot(a.name, a.ts, a.at);
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
    const brake = aiming && !this.chargeRun;

    // --- Бег: плавный разгон к желаемой скорости (спринт — быстрее) ---
    let sprinting = input.sprint && !brake;
    const bpEarly = ball.mesh.position;
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

    const k = Math.min(1, dt * ((approachMove || strikeMove || receiverMove) ? APP.accel : P.accel));
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
    if (!brake && speed > 0.5) {
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
      // Тяжесть разворотов растёт с инерцией темпа (на выбеге — тоже тяжёлые)
      const turn = P.turnRate * (1 - (1 - P.sprintTurnFactor) * this.sprintBoost);
      this.rot += d * Math.min(1, turn * dt);
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
    const shot = input.shot.consume();
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
          this.rot = Math.atan2(s.aim.x, s.aim.z); // корпус доворачивается по пасу
        }
        const assist = this.passAssist ? this.passAssist(this, s.type, power, aimDir) : null;
        ball.strike(
          assist ? assist.dir : (aimDir || this.facing),
          assist ? assist.power : power,
          cfg.lift,
        );
        this.kickCooldown = P.kickCooldown;
        this.playOneShot('kick', 1.6, 0.20); // короткий тычок, почти без замаха
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
    const canAerial = this.kickCooldown <= 0 && !downed && (
      diving
        ? (dist < A.reach + DV.stretch && bp.y >= DV.minY && bp.y <= DV.maxY)
        : (dist < A.reach && bp.y >= P.kickMaxBallY && bp.y <= A.maxY)
    );
    const wantShot = this.pendingStrike &&
      (this.pendingStrike.type === 'shot' ||
        (this.pendingStrike.type === 'swipe' && this.pendingStrike.v.kind === 'shot'));
    if (canAerial && wantShot) {
      const s = this.pendingStrike;
      this.pendingStrike = null;
      if (s.type === 'shot') {
        this.shoot(s.v, input, ball, null, { aerial: true, dive: diving });
      } else {
        const gdir = new THREE.Vector3(s.v.dir.x, 0, s.v.dir.z).normalize();
        this.shoot(Math.min(s.v.power, 1.3), input, ball,
          { dir: gdir, curl: -s.v.curl * CONFIG.shot.swipeCurl },
          { aerial: true, dive: diving });
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

    // Приём верхового мяча корпусом (фидбек Олега 22.07.2026): наш пас или
    // перевод опускается на игрока, удар не заказан — грудь/бедро гасят мяч
    // в ноги, как обычный приём паса, а не дают ему отскочить. В финишной
    // зоне у чужих ворот авто-приём молчит: там подачу замыкают (D).
    const TR = P.trap;
    if (!downed && !diving && this.tackleT <= 0 && this.kickCooldown <= 0 &&
        !wantShot && bp.y > P.kickMaxBallY && bp.y <= TR.maxY &&
        dist < A.reach && ball.vel.y < 1 &&
        Math.hypot(ball.vel.x, ball.vel.z) >= TR.minSpeed) {
      const mt = this.team ? this.team.match : null;
      const oursIncoming = !mt || mt.possession === this.team;
      let inFinish = false;
      if (this.team) {
        const dg = Math.hypot(this.team.attackGoalX - pos.x, pos.z);
        inFinish = dg < CONFIG.ai.aerial.headerRange;
      }
      if (oursIncoming && !inFinish) this.trapBall(ball);
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
      this.playOneShot('kick', 1.2, 0.16); // навес — чуть больше проводки
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
    this.playOneShot('kick', 1.2, 0.16);
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

    // Направление намерения: стик/жест в момент исполнения, иначе взгляд
    let fx = this.facing.x;
    let fz = this.facing.z;
    const il = aimMove ? Math.hypot(aimMove.x, aimMove.z) : 0;
    if (il > 0.3) {
      fx = aimMove.x / il;
      fz = aimMove.z / il;
    }

    // Полоска = дальность адресата: короткий замах — ближний, полный — дальний
    const want = LP.wantNear + (LP.wantFar - LP.wantNear) * Math.min(charge, 1);
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
      if (cos < LP.coneCos) continue;
      const score = cos * 20 - Math.abs(d - want) * 0.55;
      if (score > bestScore) {
        bestScore = score;
        best = { mate, dist: d };
      }
    }
    if (!best) return false;

    // Баллистика под адресата с упреждением на его бег (угол дуги — от типа)
    const theta = (type.angle * Math.PI) / 180;
    const g = -B.gravity;
    const t0 = Math.sqrt((2 * best.dist * Math.tan(theta)) / g); // грубое время полёта
    const mp = best.mate.group.position;
    const tx = mp.x + best.mate.vel.x * t0 * LP.lead;
    const tz = mp.z + best.mate.vel.z * t0 * LP.lead;
    const dx = tx - pos.x;
    const dz = tz - pos.z;
    const dist = Math.hypot(dx, dz) || 1;
    let power = Math.sqrt((g * dist) / (2 * Math.tan(theta))) * LP.fudge;
    power = Math.max(type.powerMin, Math.min(type.powerMax, power));
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
    this.rot = Math.atan2(dir.x, dir.z);
    this.kickCooldown = CONFIG.player.kickCooldown;
    this.ownEpisodeT = 0; // передача закрывает эпизод владения
    this.playOneShot('kick', 1.2, 0.16);

    // Адресат встречает мяч, как обычный пас (выйдет под точку и примет)
    team.receiver = best.mate;
    team.receiveTarget = { x: tx, z: tz };
    team.receiveTimer = Math.max(CONFIG.ai.receiveGiveUp, flight + 0.8);
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
        this.rot = Math.atan2(sol.dir.x, sol.dir.z);
        this.kickCooldown = P.kickCooldown;
        this.playOneShot('kick', 1.3, 0.17);
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
    this.rot = Math.atan2(dir.x, dir.z);
    this.kickCooldown = P.kickCooldown;
    this.playOneShot('kick', 1.3, 0.17);
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
    if (charge <= ST.toe.maxCharge) return 'toe';
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const rel = Math.hypot(ball.vel.x - this.vel.x, ball.vel.z - this.vel.z);
    if (speed >= ST.instep.minRunSpeed || rel >= ST.instep.minBallRel) return 'instep';
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
      this.rot = Math.atan2(f.x, f.z);
    }

    // Сердце замыкания (ресёрч 11, принцип PES): мощь даёт ВРЫВАНИЕ.
    // Скорость бега в сторону удара конвертируется в силу; на скорости
    // корпус вложен в удар — прицел точнее; статичный прыжок — шумный кивок
    if (opts.aerial) {
      const runIn = Math.max(0, this.vel.x * f.x + this.vel.z * f.z);
      power *= 1 + Math.min(A.runPowerCap, runIn * A.runPower);
      const spd = Math.hypot(this.vel.x, this.vel.z);
      const mul = spd < A.standSpeed ? A.standNoise : A.runNoise;
      nz *= mul;
      ny *= mul;
      if (opts.dive) {
        // В падении: бьёшь без опоры — слабее и шумнее; прыжка нет (ласточка)
        power *= A.dive.powerFactor;
        nz *= A.dive.noise;
        ny *= A.dive.noise;
      } else if (styleName === 'header') {
        this.jumpT = A.jumpTime;
      }
    }
    const goalX = (f.x >= 0 ? 1 : -1) * (F.length / 2);
    const toGoal = new THREE.Vector3(goalX - bp.x, 0, -bp.z);
    const dist = toGoal.length();
    const angle = f.angleTo(toGoal.normalize()) * (180 / Math.PI);

    // Прицельная баллистика — только на ЧУЖИЕ ворота: лицом к своим удар
    // остаётся свободным выносом, а не «ассистом в свой угол» (автогол)
    const aimOk = !this.team || goalX === this.team.attackGoalX;

    if (aimOk && angle < S.assistAngle && dist < S.assistDist && dist > 3 && Math.abs(f.x) > 0.1) {
      // БЕЗ магнита: базовый прицел — точка, куда смотрит игрок на линии ворот.
      // Стрелки сдвигают её; за штангу — можно, промах реален.
      const baseZ = bp.z + (f.z / f.x) * (goalX - bp.x);
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
      ball.vel.set(dir.x * power, vy, dir.z * power);
      ball.spin = curl; // щечка подкручена внутрь ноги, подъём/носок — чистые
      ball.afterTouch = B.afterTouchTime; // докрутка направлением доступна и тут
    } else {
      // Обычный удар по направлению взгляда, высота растёт с замахом
      const lift = (S.freeLiftMin + (S.freeLiftMax - S.freeLiftMin) * effCharge) * st.liftFactor;
      ball.strike(this.facing, power, lift, curl);
    }
    this.kickCooldown = CONFIG.player.kickCooldown;
    this.playOneShot(st.anim || 'kick', st.animTs, st.animAt); // клип и темп — от типа удара
  }

  // Бросок корпусом к мячу (удар в падении, просьба Олега 18.07.2026):
  // рывок ~2 м + вытянутый корпус (ласточка). Контакт случится — или нет —
  // в обычном цикле замыкания; после броска игрок лежит dive.recover сек.
  // Реалистичная зона: reach + бросок, никаких «полётов на 10 метров»
  startDive(dx, dz, contactY = 1.0) {
    const DV = CONFIG.player.aerial.dive;
    this.diveT = DV.time;
    this.diveDir = { x: dx, z: dz };
    this.vel.x = dx * DV.lunge;
    this.vel.z = dz * DV.lunge;
    this.rot = Math.atan2(dx, dz); // корпус — в сторону броска
    this.playOneShot(contactY >= CONFIG.player.aerial.headerY ? 'header' : 'kick', 1.0, 0.05);
  }

  // Снос: игрок сбит и лежит dur секунд (клип fallen), потом встаёт.
  // Всё «горячее» гаснет — сбитый не доигрывает пас из положения лёжа
  startFall(dur) {
    this.downT = dur;
    this.downDur = dur;
    this.downTiltAmp = CONFIG.player.aerial.dive.tiltMax;
    this.slideRecover = false;
    this._gotUp = false;
    this.controlling = false;
    this.pendingStrike = null;
    this.strikeContactLock = false;
    this.cancelBallApproach();
    this.playOneShot('fallen', 1.2, 0.05);
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
    // Соперник-владелец должен быть в досягаемости слайда, иначе — добегаем,
    // а не бросаемся в подкат за тридевять земель («противник рядом», Олег)
    if (Math.hypot(op.x - pos.x, op.z - pos.z) > TK.reachOwner) return false;

    // Прицел: стик, иначе в соперника с упреждением на его бег (мяч сзади
    // экранирован его корпусом — тогда подкат считается грубым)
    const run = Math.hypot(this.vel.x, this.vel.z);
    const sld = Math.min(TK.speedMax, Math.max(TK.speedMin, run * TK.runBoost));
    const d0 = Math.hypot(op.x - pos.x, op.z - pos.z);
    const lead = Math.min(TK.aimLeadMax, d0 / Math.max(sld, 1));
    let dx = aimDir ? aimDir.x : op.x + owner.vel.x * lead - pos.x;
    let dz = aimDir ? aimDir.z : op.z + owner.vel.z * lead - pos.z;
    if (Math.hypot(dx, dz) < 0.01) {
      dx = this.facing.x;
      dz = this.facing.z;
    }
    this.startTackle(dx, dz);
    return true;
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
    // Стартуем клип сразу с фазы скольжения (не с разбега) — иначе за
    // короткий слайд виден только «выпад» стоя, а не сам подкат
    this.playOneShot('tackle', TK.clipRate, TK.clipStart);
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

    // Вытянутая нога достаёт мяч — выбить
    if (active && !this.tackleHit && dBall < TK.ballReach && bp.y < TK.ballMaxY) knock();

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
          o.playOneShot('trip', 1.3, 0.1);
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

  // Приём верхового мяча корпусом (грудь/бедро): мяч гасится и мягко
  // опускается в ноги — дальше обычное владение. Общий для человека и AI
  // (фидбек Олега 22.07.2026: мяч не должен «отскакивать от деревянного»)
  trapBall(ball) {
    const T = CONFIG.player.trap;
    const f = this.facing;
    ball.vel.x = this.vel.x + f.x * T.push;
    ball.vel.z = this.vel.z + f.z * T.push;
    ball.vel.y = Math.min(ball.vel.y, 0) * T.keepVy;
    ball.spin = 0;
    ball.afterTouch = 0;
    this.kickCooldown = T.settle; // мяч опускается с груди — нога ждёт
    this.ownEpisodeT = CONFIG.player.approach.episodeGrace;
    this.cancelBallApproach();
    this.playOneShot('receive', 1.3, 0.1);
  }

  // Верховой мяч у AI: сыграть в одно касание — вынос, скидка или кивок
  // в створ. Клип и прыжок — по высоте контакта (голова/с лёта)
  aiAerial(ball, dir, power, lift) {
    const A = CONFIG.player.aerial;
    const isHeader = ball.mesh.position.y >= A.headerY;
    if (isHeader) this.jumpT = A.jumpTime;
    const anim = isHeader
      ? { name: 'header', ts: 1.5, at: 0.12 }
      : { name: 'kick', ts: 1.7, at: 0.13 };
    this.aiKick(ball, dir, power, lift, 0, anim);
  }
}
