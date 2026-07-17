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
  }

  get facing() {
    return new THREE.Vector3(Math.sin(this.rot), 0, Math.cos(this.rot));
  }

  update(dt, input, ball) {
    const P = CONFIG.player;
    const F = CONFIG.field;
    const pos = this.group.position;

    if (this.kickCooldown > 0) this.kickCooldown -= dt;

    // Во время замаха удара стрелки — это ПРИЦЕЛ, а не бег (как в PES):
    // игрок плавно тормозит и держит направление взгляда
    const aiming = input.shot.held;

    // --- Бег: плавный разгон к желаемой скорости (спринт — быстрее) ---
    const sprinting = input.sprint && !aiming;
    let maxSpeed = P.speed * (this.hasBall ? P.dribbleSpeedFactor : 1);
    if (sprinting) maxSpeed *= P.sprintFactor;
    const k = Math.min(1, dt * P.accel);
    const mvx = aiming ? 0 : input.move.x;
    const mvz = aiming ? 0 : input.move.z;
    this.vel.x += (mvx * maxSpeed - this.vel.x) * k;
    this.vel.z += (mvz * maxSpeed - this.vel.z) * k;
    pos.x += this.vel.x * dt;
    pos.z += this.vel.z * dt;

    // Не убегаем дальше зоны за полем
    const maxX = F.length / 2 + F.apron - 2;
    const maxZ = F.width / 2 + F.apron - 2;
    pos.x = Math.max(-maxX, Math.min(maxX, pos.x));
    pos.z = Math.max(-maxZ, Math.min(maxZ, pos.z));

    // --- Разворот в сторону бега (кратчайшей дугой); при замахе взгляд заморожен,
    // на спринте развороты тяжелее ---
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (!aiming && speed > 0.5) {
      const want = Math.atan2(this.vel.x, this.vel.z);
      let d = want - this.rot;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const turn = P.turnRate * (sprinting ? P.sprintTurnFactor : 1);
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

    if (this.hasBall) {
      // Дриблинг: мяч тянется к точке перед ногой.
      // На спринте мяч отпускается дальше и липнет хуже — легче потерять
      const ahead = sprinting ? P.sprintDribbleAhead : P.dribbleAhead;
      const grip = sprinting ? P.sprintDribbleStrength : P.dribbleStrength;
      const target = pos.clone().addScaledVector(this.facing, ahead);
      ball.vel.x = this.vel.x + (target.x - bp.x) * grip;
      ball.vel.z = this.vel.z + (target.z - bp.z) * grip;
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

    ball.strike(f, power, lift, curl);
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

    if (charge < 0.45) {
      // Короткий росчерк — острый пас на ход низом
      const power = P.through.powerMin + (P.through.powerMax - P.through.powerMin) * (charge / 0.45);
      ball.strike(dir, power, P.through.lift, curl * 0.5);
    } else {
      // Тип дуги по скорости жеста (экранов/сек): медленный — свеча,
      // средний — настильный, резкий — низовой прострел
      const type = sw.speed < 1.2 ? C.high : (sw.speed < 2.6 ? C.mid : C.low);
      const power = type.powerMin + (type.powerMax - type.powerMin) * charge;
      const lift = power * Math.tan((type.angle * Math.PI) / 180);
      ball.strike(dir, power, lift, curl);
    }
    // Развернуться в сторону мяча — читаемость
    this.rot = Math.atan2(dir.x, dir.z);
    this.kickCooldown = P.kickCooldown;
    this.playOneShot('kick', 1.3, 0.17);
  }

  // Удар (D). В конусе к воротам — прицельный: стрелки выбирают угол створа
  // (вверх экрана = дальняя штанга), замах — высоту; траектория решается
  // баллистикой, так что мяч реально прилетает в выбранную точку.
  shoot(charge, input, ball) {
    const S = CONFIG.shot;
    const F = CONFIG.field;
    const G = CONFIG.goal;
    const B = CONFIG.ball;
    const bp = ball.mesh.position;

    const f = this.facing;
    const goalX = (f.x >= 0 ? 1 : -1) * (F.length / 2);
    const toGoal = new THREE.Vector3(goalX - bp.x, 0, -bp.z);
    const dist = toGoal.length();
    const angle = f.angleTo(toGoal.normalize()) * (180 / Math.PI);
    const power = S.powerMin + (S.powerMax - S.powerMin) * charge;

    if (angle < S.assistAngle && dist < S.assistDist && dist > 3 && Math.abs(f.x) > 0.1) {
      // БЕЗ магнита: базовый прицел — точка, куда смотрит игрок на линии ворот.
      // Стрелки сдвигают её; за штангу — можно, промах реален.
      const baseZ = bp.z + (f.z / f.x) * (goalX - bp.x);
      const aimZ = input.shotAim ? input.shotAim.z : 0;
      const maxZ = G.width / 2 + S.aimSlack;
      let targetZ = Math.max(-maxZ, Math.min(maxZ, baseZ)) + aimZ * S.aimRange;
      let targetY = S.heightMin + (S.heightMax - S.heightMin) * Math.min(charge / S.overchargeFrom, 1);
      if (charge > S.overchargeFrom) targetY += Math.random() * S.overchargeRise; // перезаряд — риск выше ворот
      targetZ += (Math.random() - 0.5) * 2 * S.noiseZ;
      targetY += (Math.random() - 0.5) * 2 * S.noiseY;

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
      ball.spin = 0;
      ball.afterTouch = B.afterTouchTime; // докрутка направлением доступна и тут
    } else {
      // Обычный удар по направлению взгляда, высота растёт с замахом
      const lift = S.freeLiftMin + (S.freeLiftMax - S.freeLiftMin) * charge;
      ball.strike(this.facing, power, lift);
    }
    this.kickCooldown = CONFIG.player.kickCooldown;
    this.playOneShot('kick', 1.2, 0.16); // удар — стартуем у мяча, без пустого замаха
  }
}
