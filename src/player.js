// Игрок: модель из Blender (models/player.glb, риг Mixamo, 22 анимации).
// Пока glb грузится (или если не загрузился) — капсула-заглушка, геймплей тот же.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { CONFIG } from './config.js';

// Один .glb на всех: грузится единожды, каждый игрок получает клон со скелетом
let modelPromise = null;
function loadPlayerModel() {
  if (!modelPromise) {
    modelPromise = new GLTFLoader().loadAsync('./models/player.glb').then((gltf) => {
      gltf.scene.traverse((o) => {
        if (o.isMesh) {
          // Скелет двигает вершины мимо исходной рамки объекта — отсечение по ней врёт
          o.frustumCulled = false;
          // Lambert вместо Standard: быстрее на планшете, а с плоскими гранями
          // и пиксельной текстурой выглядит ровно так же (стиль PS1).
          // Emissive ~45% — как у капсулы: без него фигура на вечернем поле чёрная
          const src = o.material;
          o.material = src.map
            ? new THREE.MeshLambertMaterial({
                map: src.map,
                emissive: 0x737373,
                emissiveMap: src.map,
              })
            : new THREE.MeshLambertMaterial({
                color: src.color.clone(),
                emissive: src.color.clone().multiplyScalar(0.45),
              });
          o.material.name = src.name; // имена kit/skin/head нужны для перекраски из JSON
        }
      });
      return gltf;
    });
  }
  return modelPromise;
}

// Какие клипы играются один раз (удары, падения), остальные — циклы
const ONE_SHOT = new Set([
  'kick', 'kick_run', 'penalty', 'header', 'tackle', 'trip', 'getup',
  'throwin', 'receive', 'gk_catch', 'gk_dive', 'gk_dropkick', 'gk_throw',
  'gk_scoop', 'gk_pass',
]);

export class Player {
  constructor(scene) {
    const P = CONFIG.player;
    this.group = new THREE.Group();

    // Emissive-подсветка, чтобы фигура читалась на тёмном вечернем поле
    this.body = new THREE.Mesh(
      new THREE.CapsuleGeometry(P.radius, P.height - P.radius * 2, 4, 8),
      new THREE.MeshLambertMaterial({ color: 0xd84a3c, emissive: 0x571712 }),
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

  reset() {
    this.group.position.set(-3, 0, 0);
    this.vel.set(0, 0, 0);
    this.rot = Math.PI / 2;  // лицом к правым воротам
    this.kickCooldown = 0;
    this.hasBall = false;
    this.controlling = false;
    this.pendingStrike = null;
    this.chargeRun = false;
    this.dribbleTouchCd = 0;
    this.sprintBoost = 0;
  }

  get facing() {
    return new THREE.Vector3(Math.sin(this.rot), 0, Math.cos(this.rot));
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
    this.hasBall = this.kickCooldown <= 0 &&
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
      if (s.type === 'pass') {
        // S — пас низом, сила от замаха
        ball.strike(this.facing, lerp(P.pass.powerMin, P.pass.powerMax, s.v), P.pass.lift);
        this.kickCooldown = P.kickCooldown;
        this.playOneShot('kick', 1.6, 0.20); // короткий тычок, почти без замаха
      } else if (s.type === 'through') {
        // W — пас на ход: быстрый, настильный
        ball.strike(this.facing, lerp(P.through.powerMin, P.through.powerMax, s.v), P.through.lift);
        this.kickCooldown = P.kickCooldown;
        this.playOneShot('kick', 1.6, 0.20);
      } else if (s.type === 'cross') {
        this.doCross(s.v, ball);
      } else if (s.type === 'shot') {
        this.shoot(s.v, input, ball);
      } else if (s.type === 'swipe') {
        this.swipeShot(s.v, ball);
      }
    }

    // --- Aftertouch: пока свежеотбитый мяч летит, направление докручивает его ---
    // (на iPad это тот же виртуальный стик — жест одинаковый на всех платформах)
    const B = CONFIG.ball;
    if (ball.afterTouch > 0 && bp.y > B.radius * 1.5) {
      const vx = ball.vel.x;
      const vz = ball.vel.z;
      const sp = Math.hypot(vx, vz);
      if (sp > 1) {
        // Боковая составляющая ввода относительно направления полёта → закрутка
        const lat = (input.move.x * -vz + input.move.z * vx) / sp;
        ball.spin += lat * B.afterTouchRate * dt;
        ball.spin = Math.max(-B.afterTouchMax, Math.min(B.afterTouchMax, ball.spin));
      }
    }
  }

  // Навес (A) — три типа по числу тапов, как в PES (ресёрч 08):
  // ×1 — высокая свеча, ×2 — настильный под удар, ×3 — низовой прострел.
  // Дуга задаётся углом вылета, подкрутка заворачивает мяч к воротам.
  doCross(ev, ball) {
    const C = CONFIG.cross;
    const F = CONFIG.field;
    const types = [C.high, C.mid, C.low];
    const t = types[Math.min(ev.taps, 3) - 1];

    const power = t.powerMin + (t.powerMax - t.powerMin) * ev.charge; // >1 = передержка
    const lift = power * Math.tan((t.angle * Math.PI) / 180);

    // Подкрутка в сторону той штрафной, в чьей половине стоим (inswing)
    const pos = this.group.position;
    const goalX = (pos.x >= 0 ? 1 : -1) * (F.length / 2);
    const f = this.facing;
    const side = (-f.z) * (goalX - pos.x) + f.x * (0 - pos.z); // перпендикуляр · направление на ворота
    const curl = t.curl * Math.sign(side || 1);

    // Нога — по корпусу; если инсвинг требует крутку «наружу» от неё — шведка
    const fw = this.applyFootwork(curl, ball);
    ball.strike(f, power * fw.powerF, lift, curl * fw.curlF);
    this.kickCooldown = CONFIG.player.kickCooldown;
    this.playOneShot('kick', 1.2, 0.16); // навес — чуть больше проводки
  }

  // Жест-свайп с тача — «как нарисовал, так и полетело»:
  // направление пальца — куда (независимо от бега), длина — сила,
  // скорость жеста — характер (медленно — свеча, резко — прострел),
  // изгиб траектории пальца — подкрутка. Короткий росчерк — пас на ход.
  swipeShot(sw, ball) {
    const S = CONFIG.shot;
    const C = CONFIG.cross;
    const P = CONFIG.player;
    const dir = new THREE.Vector3(sw.dir.x, 0, sw.dir.z).normalize();
    const charge = Math.min(sw.power, 1.3);
    const curl = -sw.curl * S.swipeCurl; // палец гнёт вправо — мяч крутится вправо
    // Изгиб пальца «наружу» от бьющей ноги исполняется шведкой (мощнее/шумнее)
    const fw = this.applyFootwork(curl, ball);

    if (charge < 0.45) {
      // Короткий росчерк — острый пас на ход низом
      const power = P.through.powerMin + (P.through.powerMax - P.through.powerMin) * (charge / 0.45);
      ball.strike(dir, power * fw.powerF, P.through.lift, curl * 0.5 * fw.curlF);
    } else {
      // Тип дуги по скорости жеста (экранов/сек): медленный — свеча,
      // средний — настильный, резкий — низовой прострел
      const type = sw.speed < 1.2 ? C.high : (sw.speed < 2.6 ? C.mid : C.low);
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
  // (Знаки: curl > 0 = мяч заворачивает влево; правая нога внутренней
  // стороной крутит влево, внешней — вправо; левая — зеркально.)
  kickFoot(ball) {
    const P = CONFIG.player;
    const bp = ball.mesh.position;
    const pos = this.group.position;
    const side = this.facing.x * (bp.z - pos.z) - this.facing.z * (bp.x - pos.x);
    if (Math.abs(side) < P.footDeadZone) return P.dominantFoot;
    return side > 0 ? 'L' : 'R';
  }

  // Часть стопы под нужную крутку: «внутрь» бьющей ноги — щечка/внутренний
  // подъём (естественно, без штрафов); «наружу» — внешняя сторона стопы
  // («шведка», стиль Роберто Карлоса): мощнее, но крутка и точность капризнее
  applyFootwork(curl, ball) {
    const P = CONFIG.player;
    const foot = this.kickFoot(ball);
    let contact = 'inside';
    let powerF = 1, curlF = 1, noiseF = 1;
    if (Math.abs(curl) > 0.15) {
      const inside = (foot === 'R') === (curl > 0);
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
  shoot(charge, input, ball) {
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
    const power = (S.powerMin + (S.powerMax - S.powerMin) * effCharge) * st.powerFactor;
    const nz = S.noiseZ * st.noiseFactor;
    const ny = S.noiseY * st.noiseFactor;

    // Щечка «вырезает» мяч внутрь бьющей ноги: корпус выбирает ногу,
    // нога — сторону завитка (правая — влево, левая — вправо).
    // Подъём и носок бьют без вращения (driven/тычок).
    let curl = 0;
    if (styleName === 'side') {
      const foot = this.kickFoot(ball);
      curl = (foot === 'R' ? 1 : -1) * st.curl;
      this.lastKick = { foot, contact: 'inside' };
    }

    const f = this.facing;
    const goalX = (f.x >= 0 ? 1 : -1) * (F.length / 2);
    const toGoal = new THREE.Vector3(goalX - bp.x, 0, -bp.z);
    const dist = toGoal.length();
    const angle = f.angleTo(toGoal.normalize()) * (180 / Math.PI);

    if (angle < S.assistAngle && dist < S.assistDist && dist > 3 && Math.abs(f.x) > 0.1) {
      // БЕЗ магнита: базовый прицел — точка, куда смотрит игрок на линии ворот.
      // Стрелки сдвигают её; за штангу — можно, промах реален.
      const baseZ = bp.z + (f.z / f.x) * (goalX - bp.x);
      const aimZ = input.shotAim ? input.shotAim.z : 0;
      const maxZ = G.width / 2 + S.aimSlack;
      let targetZ = Math.max(-maxZ, Math.min(maxZ, baseZ)) + aimZ * S.aimRange;
      let targetY = (S.heightMin + (S.heightMax - S.heightMin) *
        Math.min(effCharge / S.overchargeFrom, 1)) * (st.heightFactor || 1);
      if (effCharge > S.overchargeFrom) targetY += Math.random() * S.overchargeRise; // перезаряд — риск выше ворот
      targetZ += (Math.random() - 0.5) * 2 * nz;
      targetY += (Math.random() - 0.5) * 2 * ny;

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
