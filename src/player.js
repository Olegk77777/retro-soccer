// Игрок: модель из Blender (models/player.glb, риг Mixamo, 22 анимации).
// Пока glb грузится (или если не загрузился) — капсула-заглушка, геймплей тот же.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { CONFIG } from './config.js';

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
    this.chargeRun = false;  // замах начат на бегу — бег продолжается (удар подъёмом)
    this.lastStrikeStyle = null; // для отладки/баланса: каким ударом бил последний раз
    this.lastKick = null;    // { foot: 'L'|'R', contact: 'inside'|'outside' } — нога и часть стопы
    this.dribbleTouchCd = 0; // пауза между толчками мяча на спринте
    this.dribbleDir = null;  // курс ведения (обновляется в момент касания)
    this.sprintBoost = 0;    // инерция спринта: 1 = полный темп, спадает плавно
    this.kickCooldown = 0;
    this.bobT = 0;

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
    this.chargeRun = false;
    this.dribbleTouchCd = 0;
    this.sprintBoost = 0;
    if (this.ai) this.ai.dribDir = null; // мозг AI начинает с чистого листа
    this.group.rotation.y = rot;
    this.shadow.position.x = x;
    this.shadow.position.z = z;
  }

  get facing() {
    return new THREE.Vector3(Math.sin(this.rot), 0, Math.cos(this.rot));
  }

  // Анимация по движению — общая для человека и AI (вызывать раз в кадр)
  _updateAnim(dt, speed) {
    const P = CONFIG.player;
    if (this.mixer) {
      // Выбор клипа по движению; пока играет одноразовый (удар) — не дёргаем
      if (!this.oneShot) {
        if (speed < 0.6) {
          this.playAction('idle', 0.18);
        } else {
          this.playAction('run', 0.1);
          // Темп ног растёт со скоростью (сам клип снят под лёгкую трусцу)
          this.actions.run.timeScale = Math.min(1.9, Math.max(0.6, speed / 4.0));
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

    const sprinting = !!opts.sprint;
    const boostK = sprinting ? Math.min(1, dt * 12) : Math.min(1, dt / P.sprintInertia);
    this.sprintBoost += ((sprinting ? 1 : 0) - this.sprintBoost) * boostK;

    let maxSpeed = P.speed * CONFIG.ai.speedFactor *
      (this.isToucher ? P.dribbleSpeedFactor : 1);
    maxSpeed *= 1 + (P.sprintFactor - 1) * this.sprintBoost;

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

  // Удар AI: пас/выстрел/вынос — обычный strike с анимацией и кулдауном
  aiKick(ball, dir, power, lift, curl = 0) {
    const d = Math.hypot(dir.x, dir.z) || 1;
    const ndir = { x: dir.x / d, z: dir.z / d };
    ball.strike(ndir, power, lift, curl);
    this.rot = Math.atan2(ndir.x, ndir.z); // корпус доворачивается по удару
    this.kickCooldown = CONFIG.player.kickCooldown;
    this.playOneShot('kick', 1.6, 0.20);
  }

  update(dt, input, ball) {
    const P = CONFIG.player;
    const F = CONFIG.field;
    const pos = this.group.position;

    if (this.kickCooldown > 0) this.kickCooldown -= dt;

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
    const sprinting = input.sprint && !brake;
    // Инерция спринта (фидбек Олега): включается быстро, спадает плавно.
    // Отпустил ⚡/E — темп ещё живёт ~секунду: можно отпустить спринт
    // и тут же пробить с лёта на скорости
    const boostK = sprinting ? Math.min(1, dt * 12) : Math.min(1, dt / P.sprintInertia);
    this.sprintBoost += ((sprinting ? 1 : 0) - this.sprintBoost) * boostK;
    let maxSpeed = P.speed * (this.hasBall ? P.dribbleSpeedFactor : 1);
    maxSpeed *= 1 + (P.sprintFactor - 1) * this.sprintBoost;
    const k = Math.min(1, dt * P.accel);
    let mvx = brake ? 0 : input.move.x;
    let mvz = brake ? 0 : input.move.z;

    // Смена направления на ведении — «через касание», как в PES (фидбек Олега):
    // пока мяч впереди дальше dribbleChaseDist, бег примагничивается К МЯЧУ —
    // игрок сначала догоняет его, а руль применится в момент сближения.
    // Раньше поворот на толчке бросал мяч катиться дальше, а игрок убегал вбок.
    const il = Math.hypot(mvx, mvz);
    if (this.controlling && il > 0.01) {
      const bp0 = ball.mesh.position;
      const tbx = bp0.x - pos.x;
      const tbz = bp0.z - pos.z;
      const bd = Math.hypot(tbx, tbz);
      if (bd > P.dribbleChaseDist) {
        const w = Math.min(1, (bd - P.dribbleChaseDist) / 0.8); // дальше мяч — сильнее тяга
        const cx = (mvx / il) * (1 - w) + (tbx / bd) * w;
        const cz = (mvz / il) * (1 - w) + (tbz / bd) * w;
        const cl = Math.hypot(cx, cz) || 1;
        mvx = (cx / cl) * il;
        mvz = (cz / cl) * il;
      }
    }

    this.vel.x += (mvx * maxSpeed - this.vel.x) * k;
    this.vel.z += (mvz * maxSpeed - this.vel.z) * k;
    pos.x += this.vel.x * dt;
    pos.z += this.vel.z * dt;

    // Не убегаем дальше зоны за полем
    const maxX = F.length / 2 + F.apron - 2;
    const maxZ = F.width / 2 + F.apron - 2;
    pos.x = Math.max(-maxX, Math.min(maxX, pos.x));
    pos.z = Math.max(-maxZ, Math.min(maxZ, pos.z));

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
      if (this.controlling && bd2 > P.dribbleChaseDist) {
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
    const canKick = this.kickCooldown <= 0 &&
      dist < P.kickRadius &&
      bp.y < P.kickMaxBallY;

    if (this.dribbleTouchCd > 0) this.dribbleTouchCd -= dt;
    if (!this.hasBall) this.dribbleDir = null; // мяч потерян — курс ведения сброшен
    if (this.hasBall) {
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
        if (ahead < P.sprintTouchTrigger && this.dribbleTouchCd <= 0) {
          // Толчок — в сторону ввода (руль применяется у мяча), без ввода — по корпусу
          let pdx = this.facing.x;
          let pdz = this.facing.z;
          const rl = Math.hypot(input.move.x, input.move.z);
          if (rl > 0.3) { pdx = input.move.x / rl; pdz = input.move.z / rl; }
          const push = speed * P.sprintTouchPush;
          ball.vel.x = pdx * push;
          ball.vel.z = pdz * push;
          this.dribbleDir = { x: pdx, z: pdz };
          this.dribbleTouchCd = P.sprintTouchInterval;
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
    const pass = input.pass.consume();
    const through = input.through.consume();
    const cross = input.consumeCross();
    const shot = input.shot.consume();
    const swipe = input.consumeSwipe();

    let strike = null;
    if (pass !== null) strike = { type: 'pass', v: pass };
    else if (through !== null) strike = { type: 'through', v: through };
    else if (cross !== null) strike = { type: 'cross', v: cross };
    else if (shot !== null) strike = { type: 'shot', v: shot };
    else if (swipe !== null) strike = { type: 'swipe', v: swipe };

    if (strike) {
      this.pendingStrike = { ...strike, ttl: P.strikeBufferTime };
    } else if (this.pendingStrike) {
      this.pendingStrike.ttl -= dt;
      if (this.pendingStrike.ttl <= 0) this.pendingStrike = null; // не добежал — сгорело
    }

    if (canKick && this.pendingStrike) {
      const s = this.pendingStrike;
      this.pendingStrike = null;
      const lerp = (a, b, t) => a + (b - a) * t;
      if (s.type === 'pass' || s.type === 'through') {
        // S — пас низом; W — пас на ход (настильный). Сила — от замаха.
        // Пас-ассист (Фаза 2): Match доворачивает направление на партнёра
        // в конусе взгляда и посылает его встречать мяч; без партнёров
        // в конусе (или без Match) пас летит строго по взгляду, как раньше.
        const cfg = s.type === 'pass' ? P.pass : P.through;
        const power = lerp(cfg.powerMin, cfg.powerMax, s.v);
        const assist = this.passAssist ? this.passAssist(this, s.type, power) : null;
        ball.strike(assist ? assist.dir : this.facing, power, cfg.lift);
        this.kickCooldown = P.kickCooldown;
        this.playOneShot('kick', 1.6, 0.20); // короткий тычок, почти без замаха
      } else if (s.type === 'cross') {
        this.doCross(s.v, input, ball);
      } else if (s.type === 'shot') {
        this.shoot(s.v, input, ball);
      } else if (s.type === 'swipe') {
        this.swipeShot(s.v, input, ball);
      }
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
      return;
    }

    // Вне коридора: длинный заброс по направлению взгляда
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
        return;
      }
      const fw = this.applyFootwork(curl, ball);
      const power = (type.powerMin + (type.powerMax - type.powerMin) * charge) * fw.powerF;
      const lift = power * Math.tan((type.angle * Math.PI) / 180);
      ball.strike(dir, power, lift, curl * fw.curlF);
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
  shoot(charge, input, ball, gesture = null) {
    const S = CONFIG.shot;
    const F = CONFIG.field;
    const G = CONFIG.goal;
    const B = CONFIG.ball;
    const bp = ball.mesh.position;

    const styleName = this.strikeStyle(charge, ball);
    const st = S.styles[styleName];
    this.lastStrikeStyle = styleName;
    // У тычка сила почти не зависит от замаха — он всегда «средний, но мгновенный»
    const effCharge = styleName === 'toe' ? st.effCharge : charge;
    let power = (S.powerMin + (S.powerMax - S.powerMin) * effCharge) * st.powerFactor;
    // Помощь в ударах глушит часть шума исполнения (слайдер в НАСТРОЙКАХ)
    const AS = S.assist;
    const noiseK = Math.max(0, 1 - AS.level * AS.noiseCut);
    const nz = S.noiseZ * st.noiseFactor * noiseK;
    const ny = S.noiseY * st.noiseFactor * noiseK;

    // Щечка «вырезает» мяч внутрь бьющей ноги: корпус выбирает ногу,
    // нога — сторону завитка (правая — влево, левая — вправо).
    // Подъём и носок бьют без вращения (driven/тычок).
    let curl = 0;
    if (gesture) {
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
    const goalX = (f.x >= 0 ? 1 : -1) * (F.length / 2);
    const toGoal = new THREE.Vector3(goalX - bp.x, 0, -bp.z);
    const dist = toGoal.length();
    const angle = f.angleTo(toGoal.normalize()) * (180 / Math.PI);

    if (angle < S.assistAngle && dist < S.assistDist && dist > 3 && Math.abs(f.x) > 0.1) {
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
      // Вертикальная скорость, чтобы на воротах оказаться на высоте цели
      let vy = (targetY - bp.y) / t - 0.5 * B.gravity * t;
      vy = Math.max(0, Math.min(S.maxLift, vy));
      ball.vel.set(dir.x * power, vy, dir.z * power);
      ball.spin = curl; // щечка подкручена внутрь ноги, подъём/носок — чистые
      ball.afterTouch = B.afterTouchTime; // докрутка направлением доступна и тут
    } else {
      // Обычный удар по направлению взгляда, высота растёт с замахом
      const lift = (S.freeLiftMin + (S.freeLiftMax - S.freeLiftMin) * effCharge) * st.liftFactor;
      ball.strike(this.facing, power, lift, curl);
    }
    this.kickCooldown = CONFIG.player.kickCooldown;
    this.playOneShot('kick', st.animTs, st.animAt); // анимация в темпе типа удара
  }
}
