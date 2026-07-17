// Игрок-заглушка (капсула): бег, развороты, дриблинг, пас, удар с замахом.
// Настоящая модель придёт из Blender позже — геймплей графику не ждёт.

import * as THREE from 'three';
import { CONFIG } from './config.js';

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
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.12, 0.34),
      new THREE.MeshLambertMaterial({ color: 0x6e1c15 }),
    );
    nose.position.set(0, 0.1, P.radius + 0.12);
    this.group.add(nose);

    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(P.radius * 1.25, 12),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.02;

    this.vel = new THREE.Vector3();
    this.rot = 0;            // угол поворота (0 = смотрит в +Z)
    this.hasBall = false;
    this.kickCooldown = 0;
    this.bobT = 0;

    scene.add(this.group);
    scene.add(this.shadow);
    this.reset();
  }

  reset() {
    this.group.position.set(-3, 0, 0);
    this.vel.set(0, 0, 0);
    this.rot = Math.PI / 2;  // лицом к правым воротам
    this.kickCooldown = 0;
    this.hasBall = false;
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

    // Лёгкое покачивание на бегу — дешёвая «жизнь» до настоящих анимаций
    this.bobT += dt * speed * 1.8;
    this.body.position.y = P.height / 2 + Math.abs(Math.sin(this.bobT)) * 0.06 * (speed / P.speed);

    this.shadow.position.x = pos.x;
    this.shadow.position.z = pos.z;

    // --- Контроль мяча ---
    const bp = ball.mesh.position;
    const dist = Math.hypot(bp.x - pos.x, bp.z - pos.z);
    this.hasBall = this.kickCooldown <= 0 &&
      dist < P.controlRadius &&
      bp.y < CONFIG.ball.radius * 2.2;

    // События замахов снимаем каждый кадр: без мяча они просто сгорают
    const pass = input.pass.consume();
    const through = input.through.consume();
    const cross = input.consumeCross();
    const shot = input.shot.consume();

    if (this.hasBall) {
      // Дриблинг: мяч тянется к точке перед ногой.
      // На спринте мяч отпускается дальше и липнет хуже — легче потерять
      const ahead = sprinting ? P.sprintDribbleAhead : P.dribbleAhead;
      const grip = sprinting ? P.sprintDribbleStrength : P.dribbleStrength;
      const target = pos.clone().addScaledVector(this.facing, ahead);
      ball.vel.x = this.vel.x + (target.x - bp.x) * grip;
      ball.vel.z = this.vel.z + (target.z - bp.z) * grip;

      const lerp = (a, b, t) => a + (b - a) * t;
      if (pass !== null) {
        // S — пас низом, сила от замаха
        ball.strike(this.facing, lerp(P.pass.powerMin, P.pass.powerMax, pass), P.pass.lift);
        this.kickCooldown = P.kickCooldown;
      } else if (through !== null) {
        // W — пас на ход: быстрый, настильный
        ball.strike(this.facing, lerp(P.through.powerMin, P.through.powerMax, through), P.through.lift);
        this.kickCooldown = P.kickCooldown;
      } else if (cross !== null) {
        this.doCross(cross, ball);
      } else if (shot !== null) {
        this.shoot(shot, input, ball);
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

    const goalX = (this.facing.x >= 0 ? 1 : -1) * (F.length / 2);
    const toGoal = new THREE.Vector3(goalX - bp.x, 0, -bp.z);
    const dist = toGoal.length();
    const angle = this.facing.angleTo(toGoal.normalize()) * (180 / Math.PI);
    const power = S.powerMin + (S.powerMax - S.powerMin) * charge;

    if (angle < S.assistAngle && dist < S.assistDist && dist > 3) {
      // Прицельный удар в створ (прицел запомнен за время замаха)
      const aimZ = input.shotAim ? input.shotAim.z : 0;
      let targetZ = aimZ * (G.width / 2 - S.postMargin);
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
  }
}
