// Мяч: простая аркадная физика — гравитация, отскок, качение с трением.
// Никакого физического движка: для футбола хватает ручной математики, и её легко балансировать.

import * as THREE from 'three';
import { CONFIG } from './config.js';

function createBallTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 32;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f0f0ea';
  ctx.fillRect(0, 0, 64, 32);
  // Чёрные «пятна» — с расстояния читаются как классический мяч с пятиугольниками
  ctx.fillStyle = '#1a1a1a';
  for (let i = 0; i < 10; i++) {
    const x = (i * 17 + (i % 2) * 7) % 64;
    const y = (i * 11) % 32;
    ctx.fillRect(x, y, 7, 6);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Ball {
  constructor(scene) {
    const B = CONFIG.ball;
    // MeshBasic = мяч не зависит от света и всегда ярко читается (стиль PS1)
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(B.radius, 10, 8),
      new THREE.MeshBasicMaterial({ map: createBallTexture() }),
    );
    // Классическая ретро-тень: плоский тёмный кружок под мячом
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(B.radius * 1.15, 12),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.02;
    this.vel = new THREE.Vector3();
    this.spin = 0; // подкрутка (эффект Магнуса): уводит летящий мяч вбок
    this.spinAxis = new THREE.Vector3(1, 0, 0);
    this.reset();
    scene.add(this.mesh);
    scene.add(this.shadow);
  }

  reset() {
    this.mesh.position.set(0, CONFIG.ball.radius, 0);
    this.vel.set(0, 0, 0);
    this.spin = 0;
  }

  // Удар: направление (единичный вектор), сила (м/с), подъём и подкрутка.
  // curl > 0 — мяч в полёте заворачивает влево от направления, < 0 — вправо.
  strike(dir, power, lift, curl = 0) {
    this.vel.x = dir.x * power;
    this.vel.z = dir.z * power;
    this.vel.y = lift;
    this.spin = curl;
  }

  update(dt) {
    const B = CONFIG.ball;
    const F = CONFIG.field;
    const p = this.mesh.position;

    // Трение качения задано «за кадр при 60 fps» — приводим к реальному dt,
    // иначе на 120-герцовом iPad мяч катился бы вдвое дольше
    const roll = Math.pow(B.rollFriction, dt * 60);

    // Гравитация в полёте
    if (p.y > B.radius || this.vel.y > 0) {
      this.vel.y += B.gravity * dt;
      // Сопротивление воздуха ~ квадрату скорости: быстрый мяч тормозится
      // сильнее, медленный почти нет — это и даёт «прострельность» PES
      const sp = this.vel.length();
      if (sp > 0.01) {
        const d = Math.min(B.dragK * sp * dt, 0.5);
        this.vel.multiplyScalar(1 - d);
      }
      // Эффект Магнуса: подкрутка заворачивает мяч перпендикулярно скорости
      if (Math.abs(this.spin) > 0.01) {
        const vx = this.vel.x;
        const vz = this.vel.z;
        this.vel.x += -vz * this.spin * B.magnus * dt;
        this.vel.z += vx * this.spin * B.magnus * dt;
        this.spin *= Math.pow(B.spinDecay, dt * 60);
      }
    } else {
      // Качение по газону: закрутка быстро гаснет о траву
      this.vel.x *= roll;
      this.vel.z *= roll;
      this.spin *= Math.pow(0.9, dt * 60);
    }

    p.addScaledVector(this.vel, dt);

    // Отскок от газона
    if (p.y < B.radius) {
      p.y = B.radius;
      if (Math.abs(this.vel.y) > 1.2) this.vel.y = -this.vel.y * B.bounce;
      else this.vel.y = 0;
    }

    // Полная остановка на малой скорости
    if (p.y <= B.radius + 0.001 && this.vel.lengthSq() < B.stopSpeed * B.stopSpeed) {
      this.vel.set(0, 0, 0);
    }

    // Гол? (пересёк линию ворот в створе)
    const G = CONFIG.goal;
    if (Math.abs(p.x) > F.length / 2 + B.radius &&
        Math.abs(p.z) < G.width / 2 && p.y < G.height) {
      return 'goal';
    }

    // Отскок от невидимых бортов за полем (чтобы мяч не укатился в трибуны)
    const maxX = F.length / 2 + F.apron - 2;
    const maxZ = F.width / 2 + F.apron - 2;
    if (Math.abs(p.x) > maxX) { p.x = Math.sign(p.x) * maxX; this.vel.x *= -0.5; }
    if (Math.abs(p.z) > maxZ) { p.z = Math.sign(p.z) * maxZ; this.vel.z *= -0.5; }

    // Тень следует за мячом и тает с высотой полёта
    this.shadow.position.x = p.x;
    this.shadow.position.z = p.z;
    const hgt = Math.max(0, p.y - B.radius);
    const sc = Math.max(0.5, 1 - hgt / 12);
    this.shadow.scale.set(sc, sc, 1);
    this.shadow.material.opacity = 0.35 * Math.max(0.35, 1 - hgt / 15);

    // Вращение мяча при движении — дёшево и очень «оживляет»
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (speed > 0.05) {
      this.spinAxis.set(this.vel.z, 0, -this.vel.x).normalize();
      this.mesh.rotateOnWorldAxis(this.spinAxis, (speed * dt) / B.radius);
    }

    return null;
  }
}
