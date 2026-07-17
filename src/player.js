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

    // --- Бег: плавный разгон к желаемой скорости ---
    const maxSpeed = P.speed * (this.hasBall ? P.dribbleSpeedFactor : 1);
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

    // --- Разворот в сторону бега (кратчайшей дугой); при замахе взгляд заморожен ---
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (!aiming && speed > 0.5) {
      const want = Math.atan2(this.vel.x, this.vel.z);
      let d = want - this.rot;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.rot += d * Math.min(1, P.turnRate * dt);
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
    const cross = input.cross.consume();
    const shot = input.shot.consume();

    if (this.hasBall) {
      // Дриблинг: мяч тянется к точке перед ногой
      const target = pos.clone().addScaledVector(this.facing, P.dribbleAhead);
      ball.vel.x = this.vel.x + (target.x - bp.x) * P.dribbleStrength;
      ball.vel.z = this.vel.z + (target.z - bp.z) * P.dribbleStrength;

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
        // A — навес: чем сильнее замах, тем дальше и выше
        ball.strike(this.facing,
          lerp(P.cross.powerMin, P.cross.powerMax, cross),
          lerp(P.cross.liftMin, P.cross.liftMax, cross));
        this.kickCooldown = P.kickCooldown;
      } else if (shot !== null) {
        this.shoot(shot, input, ball);
      }
    }
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
      // Поправка на сопротивление воздуха: реальный полёт чуть дольше идеального
      const t = flightDist / (power * 0.93);
      // Вертикальная скорость, чтобы на воротах оказаться на высоте цели
      let vy = (targetY - bp.y) / t - 0.5 * B.gravity * t;
      vy = Math.max(0, Math.min(S.maxLift, vy));
      ball.vel.set(dir.x * power, vy, dir.z * power);
    } else {
      // Обычный удар по направлению взгляда, высота растёт с замахом
      const lift = S.freeLiftMin + (S.freeLiftMax - S.freeLiftMin) * charge;
      ball.strike(this.facing, power, lift);
    }
    this.kickCooldown = CONFIG.player.kickCooldown;
  }
}
