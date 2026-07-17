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

    // --- Бег: плавный разгон к желаемой скорости ---
    const maxSpeed = P.speed * (this.hasBall ? P.dribbleSpeedFactor : 1);
    const k = Math.min(1, dt * P.accel);
    this.vel.x += (input.move.x * maxSpeed - this.vel.x) * k;
    this.vel.z += (input.move.z * maxSpeed - this.vel.z) * k;
    pos.x += this.vel.x * dt;
    pos.z += this.vel.z * dt;

    // Не убегаем дальше зоны за полем
    const maxX = F.length / 2 + F.apron - 2;
    const maxZ = F.width / 2 + F.apron - 2;
    pos.x = Math.max(-maxX, Math.min(maxX, pos.x));
    pos.z = Math.max(-maxZ, Math.min(maxZ, pos.z));

    // --- Разворот в сторону бега (кратчайшей дугой) ---
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (speed > 0.5) {
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

    if (this.hasBall) {
      // Дриблинг: мяч тянется к точке перед ногой
      const target = pos.clone().addScaledVector(this.facing, P.dribbleAhead);
      ball.vel.x = this.vel.x + (target.x - bp.x) * P.dribbleStrength;
      ball.vel.z = this.vel.z + (target.z - bp.z) * P.dribbleStrength;

      if (input.consumePass()) {
        // S — обычный пас низом
        ball.strike(this.facing, P.passPower, P.passLift);
        this.kickCooldown = P.kickCooldown;
      } else if (input.consumeThrough()) {
        // W — пас на ход: быстрее и почти без подъёма
        ball.strike(this.facing, P.throughPower, P.throughLift);
        this.kickCooldown = P.kickCooldown;
      } else if (input.consumeCross()) {
        // A — навес: высокая подача
        ball.strike(this.facing, P.crossPower, P.crossLift);
        this.kickCooldown = P.kickCooldown;
      } else {
        const shot = input.consumeShot();
        if (shot !== null) {
          // D — удар, сила зависит от замаха
          const power = P.shotPowerMin + (P.shotPowerMax - P.shotPowerMin) * shot;
          const lift = P.shotLift * (0.4 + 0.6 * shot);
          ball.strike(this.facing, power, lift);
          this.kickCooldown = P.kickCooldown;
        }
      }
    } else {
      // Без мяча события сгорают, чтобы не «выстрелить» при первом касании
      input.consumePass();
      input.consumeThrough();
      input.consumeCross();
      input.consumeShot();
    }
  }
}
