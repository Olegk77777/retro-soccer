// Полная система ворот: точный каркас, непрерывные столкновения и пружинная сетка.
// Физического движка нет намеренно: геометрия ворот простая, поэтому ручная
// математика точнее, дешевле для iPad и полностью управляется через config.js.

import * as THREE from 'three';
import { CONFIG } from './config.js';

const AXIS = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
];

// Сетка хранит один пружинный сдвиг на узел вдоль нормали панели. Узлы связаны
// с четырьмя соседями: при попадании импульс расходится волной по полотну.
class NetPanel {
  constructor(scene, cols, rows, pointAt, outwardNormal) {
    this.cols = Math.max(2, cols);
    this.rows = Math.max(2, rows);
    this.normal = outwardNormal.clone();
    this.count = this.cols * this.rows;
    this.rest = new Float32Array(this.count * 3);
    this.offset = new Float32Array(this.count);
    this.velocity = new Float32Array(this.count);
    this.nextVelocity = new Float32Array(this.count);

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const i = row * this.cols + col;
        const p = pointAt(col / (this.cols - 1), row / (this.rows - 1));
        this.rest[i * 3] = p.x;
        this.rest[i * 3 + 1] = p.y;
        this.rest[i * 3 + 2] = p.z;
      }
    }

    this.edges = [];
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const i = row * this.cols + col;
        if (col + 1 < this.cols) this.edges.push(i, i + 1);
        if (row + 1 < this.rows) this.edges.push(i, i + this.cols);
      }
    }

    this.positions = new Float32Array(this.edges.length * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.lines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({
        color: 0xf4f4ee,
        transparent: true,
        opacity: 0.58,
        depthWrite: false,
      }),
    );
    this.lines.frustumCulled = false;
    scene.add(this.lines);
    this.syncGeometry();
  }

  isPinned(col, row) {
    return col === 0 || row === 0 || col === this.cols - 1 || row === this.rows - 1;
  }

  excite(point, outwardSpeed) {
    const N = CONFIG.goal.net;
    const r2 = N.impactRadius * N.impactRadius;
    const impactSpeed = Math.min(Math.abs(outwardSpeed), N.impactMaxSpeed);
    // Нелинейная кривая: слабый мяч лишь качает сетку, а мощный удар создаёт
    // глубокий мешок и гораздо более сильную волну по соседним ячейкам.
    const impulse = Math.sign(outwardSpeed) * N.impactTransfer * N.impactReferenceSpeed *
      Math.pow(impactSpeed / N.impactReferenceSpeed, N.impactExponent);
    let nearest = -1;
    let nearestD2 = Infinity;

    for (let row = 1; row < this.rows - 1; row++) {
      for (let col = 1; col < this.cols - 1; col++) {
        const i = row * this.cols + col;
        const j = i * 3;
        const dx = this.rest[j] - point.x;
        const dy = this.rest[j + 1] - point.y;
        const dz = this.rest[j + 2] - point.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < nearestD2) { nearestD2 = d2; nearest = i; }
        if (d2 > r2) continue;
        const weight = Math.exp(-d2 / (r2 * 0.42));
        this.velocity[i] += impulse * weight;
      }
    }

    // Попадание рядом с закреплённым краем всё равно должно дёрнуть ближайшую ячейку.
    if (nearest >= 0 && nearestD2 > r2) {
      this.velocity[nearest] += impulse * 0.35;
    }
  }

  // Пока мяч физически продавливает полотно, ближайшие узлы следуют за ним.
  // Это и создаёт видимый локальный «мешок», а не едва заметную общую дрожь.
  press(point, depth, dt) {
    const N = CONFIG.goal.net;
    const r2 = N.impactRadius * N.impactRadius;
    const follow = 1 - Math.exp(-N.followRate * dt);
    // Физический ход мяча меньше экранного хода узлов: с высоты ТВ-камеры
    // честные 30–70 см превращаются в один пиксель и выглядят как статика.
    const limitedDepth = THREE.MathUtils.clamp(
      depth * N.visualStretch,
      -N.visualMaxStretch,
      N.visualMaxStretch,
    );

    for (let row = 1; row < this.rows - 1; row++) {
      for (let col = 1; col < this.cols - 1; col++) {
        const i = row * this.cols + col;
        const j = i * 3;
        const dx = this.rest[j] - point.x;
        const dy = this.rest[j + 1] - point.y;
        const dz = this.rest[j + 2] - point.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        const weight = Math.exp(-d2 / (r2 * 0.5));
        const target = limitedDepth * weight;
        this.offset[i] += (target - this.offset[i]) * follow;
      }
    }
    this.syncGeometry();
  }

  update(dt) {
    const N = CONFIG.goal.net;
    const nextVelocity = this.nextVelocity;
    nextVelocity.set(this.velocity);

    for (let row = 1; row < this.rows - 1; row++) {
      for (let col = 1; col < this.cols - 1; col++) {
        const i = row * this.cols + col;
        const neighbours =
          this.offset[i - 1] + this.offset[i + 1] +
          this.offset[i - this.cols] + this.offset[i + this.cols];
        const laplacian = neighbours - this.offset[i] * 4;
        const accel =
          laplacian * N.spring -
          this.offset[i] * N.restore -
          this.velocity[i] * N.damping;
        nextVelocity[i] = this.velocity[i] + accel * dt;
      }
    }

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const i = row * this.cols + col;
        if (this.isPinned(col, row)) {
          this.offset[i] = 0;
          this.velocity[i] = 0;
          continue;
        }
        this.velocity[i] = nextVelocity[i];
        this.offset[i] = THREE.MathUtils.clamp(
          this.offset[i] + this.velocity[i] * dt,
          -N.visualMaxStretch,
          N.visualMaxStretch,
        );
      }
    }
    this.syncGeometry();
  }

  reset() {
    this.offset.fill(0);
    this.velocity.fill(0);
    this.syncGeometry();
  }

  syncGeometry() {
    const n = this.normal;
    for (let e = 0; e < this.edges.length; e++) {
      const i = this.edges[e];
      const src = i * 3;
      const dst = e * 3;
      const d = this.offset[i];
      this.positions[dst] = this.rest[src] + n.x * d;
      this.positions[dst + 1] = this.rest[src + 1] + n.y * d;
      this.positions[dst + 2] = this.rest[src + 2] + n.z * d;
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
  }
}

function earliestCylinderHit(p, v, maxTime, axis, a0, a1, c1, c2, radius, kind) {
  // Каркас осевой: для стойки решаем квадратное уравнение в XZ,
  // для перекладины — в XY. Так получаем момент удара внутри кадра, а не после.
  const q1 = p[c1] - a0[c1];
  const q2 = p[c2] - a0[c2];
  const u1 = v[c1];
  const u2 = v[c2];
  const qa = u1 * u1 + u2 * u2;
  if (qa < 1e-10) return null;
  const qb = 2 * (q1 * u1 + q2 * u2);
  const qc = q1 * q1 + q2 * q2 - radius * radius;
  if (qc <= 0) {
    const along = p[axis];
    const minAlong = Math.min(a0[axis], a1[axis]) - 1e-6;
    const maxAlong = Math.max(a0[axis], a1[axis]) + 1e-6;
    if (along < minAlong || along > maxAlong) return null;
    const normal = new THREE.Vector3();
    normal[c1] = q1;
    normal[c2] = q2;
    if (normal.lengthSq() < 1e-10) return null;
    normal.normalize();
    return v.dot(normal) < 0 ? { time: 0, normal, kind } : null;
  }
  const disc = qb * qb - 4 * qa * qc;
  if (disc < 0) return null;

  const root = (-qb - Math.sqrt(disc)) / (2 * qa);
  if (root < -1e-7 || root > maxTime) return null;
  const time = Math.max(0, root);
  const along = p[axis] + v[axis] * time;
  const minAlong = Math.min(a0[axis], a1[axis]) - 1e-6;
  const maxAlong = Math.max(a0[axis], a1[axis]) + 1e-6;
  if (along < minAlong || along > maxAlong) return null;

  const normal = new THREE.Vector3();
  normal[c1] = p[c1] + v[c1] * time - a0[c1];
  normal[c2] = p[c2] + v[c2] * time - a0[c2];
  if (normal.lengthSq() < 1e-10) return null;
  normal.normalize();
  if (v.dot(normal) >= 0) return null;
  return { time, normal, kind };
}

export class GoalSystem {
  constructor(scene) {
    this.panels = [];
    this.frames = [];
    this.netPlanes = [];
    this.build(scene);
  }

  build(scene) {
    const G = CONFIG.goal;
    const F = CONFIG.field;
    const innerHalf = G.width / 2;
    const postAxisZ = innerHalf + G.postRadius;
    const barAxisY = G.height + G.postRadius;
    const outerHalf = innerHalf + G.postRadius * 2;
    const frameMat = new THREE.MeshLambertMaterial({ color: 0xf2f2f2, emissive: 0x555555 });
    const postHeight = G.height + G.postRadius * 2;
    const postGeo = new THREE.CylinderGeometry(G.postRadius, G.postRadius, postHeight, 8);
    const barGeo = new THREE.CylinderGeometry(G.postRadius, G.postRadius, G.width + G.postRadius * 4, 8);

    for (const dir of [-1, 1]) {
      const lineX = dir * (F.length / 2);
      const backX = lineX + dir * G.depth;

      for (const z of [-postAxisZ, postAxisZ]) {
        const post = new THREE.Mesh(postGeo, frameMat);
        post.position.set(lineX, postHeight / 2, z);
        scene.add(post);
        this.frames.push({
          type: 'post',
          a0: new THREE.Vector3(lineX, 0, z),
          a1: new THREE.Vector3(lineX, barAxisY, z),
        });
      }

      const bar = new THREE.Mesh(barGeo, frameMat);
      bar.rotation.x = Math.PI / 2;
      bar.position.set(lineX, barAxisY, 0);
      scene.add(bar);
      this.frames.push({
        type: 'crossbar',
        a0: new THREE.Vector3(lineX, barAxisY, -postAxisZ),
        a1: new THREE.Vector3(lineX, barAxisY, postAxisZ),
      });

      const back = new NetPanel(
        scene,
        Math.ceil((outerHalf * 2) / G.net.cellSize) + 1,
        Math.ceil(barAxisY / G.net.cellSize) + 1,
        (u, v) => new THREE.Vector3(backX, v * barAxisY, -outerHalf + u * outerHalf * 2),
        new THREE.Vector3(dir, 0, 0),
      );
      this.panels.push(back);
      this.netPlanes.push({
        axis: 0, value: backX, outward: new THREE.Vector3(dir, 0, 0), panel: back,
        inside: (p) => p.y >= 0 && p.y <= barAxisY && Math.abs(p.z) <= outerHalf,
      });

      const roof = new NetPanel(
        scene,
        Math.ceil(G.depth / G.net.cellSize) + 1,
        Math.ceil((outerHalf * 2) / G.net.cellSize) + 1,
        (u, v) => new THREE.Vector3(lineX + dir * G.depth * u, barAxisY, -outerHalf + v * outerHalf * 2),
        new THREE.Vector3(0, 1, 0),
      );
      this.panels.push(roof);
      this.netPlanes.push({
        axis: 1, value: barAxisY, outward: new THREE.Vector3(0, 1, 0), panel: roof,
        inside: (p) => dir * (p.x - lineX) >= 0 && dir * (p.x - lineX) <= G.depth && Math.abs(p.z) <= outerHalf,
      });

      for (const side of [-1, 1]) {
        const sideZ = side * outerHalf;
        const panel = new NetPanel(
          scene,
          Math.ceil(G.depth / G.net.cellSize) + 1,
          Math.ceil(barAxisY / G.net.cellSize) + 1,
          (u, v) => new THREE.Vector3(lineX + dir * G.depth * u, v * barAxisY, sideZ),
          new THREE.Vector3(0, 0, side),
        );
        this.panels.push(panel);
        this.netPlanes.push({
          axis: 2, value: sideZ, outward: new THREE.Vector3(0, 0, side), panel,
          inside: (p) => dir * (p.x - lineX) >= 0 && dir * (p.x - lineX) <= G.depth && p.y >= 0 && p.y <= barAxisY,
        });
      }
    }
  }

  update(dt) {
    for (const panel of this.panels) panel.update(dt);
  }

  reset() {
    for (const panel of this.panels) panel.reset();
  }

  findFrameHit(p, v, maxTime, ballRadius) {
    const G = CONFIG.goal;
    const effectiveRadius = ballRadius + G.postRadius;
    let best = null;
    for (const frame of this.frames) {
      const hit = frame.type === 'post'
        ? earliestCylinderHit(p, v, maxTime, 'y', frame.a0, frame.a1, 'x', 'z', effectiveRadius, frame.type)
        : earliestCylinderHit(p, v, maxTime, 'z', frame.a0, frame.a1, 'x', 'y', effectiveRadius, frame.type);
      if (hit && (!best || hit.time < best.time)) best = hit;
    }
    return best;
  }

  findNetHit(p, v, maxTime, radius, ignorePanel = null) {
    let best = null;
    for (const plane of this.netPlanes) {
      if (plane.panel === ignorePanel) continue;
      const axis = plane.axis;
      const speed = v.getComponent(axis);
      if (Math.abs(speed) < 1e-8) continue;
      const signed = p.getComponent(axis) - plane.value;
      const outSign = plane.outward.getComponent(axis);
      if (signed * speed >= 0) {
        // Мяч движется НАРУЖУ, но полотно ещё касается сферы, а центр не ушёл
        // за плоскость — последний шанс схватить «побег» сквозь сетку
        // (гол с угла: контакт с одной панелью умер, когда мяч уже прошивал другую)
        if (speed * outSign <= 0) continue;            // уходит внутрь ворот — не побег
        if (signed * outSign > 1e-5) continue;         // центр уже снаружи — поздно
        if (Math.abs(signed) > radius + 1e-5) continue;
        const point = p.clone();
        point.setComponent(axis, plane.value);
        if (!plane.inside(point)) continue;
        const catchHit = {
          time: 0, normal: plane.outward.clone().negate(), kind: 'net',
          panel: plane.panel, outward: plane.outward, plane,
        };
        if (!best || catchHit.time < best.time) best = catchHit;
        continue;
      }
      // Мяч уже частично пересекает плоскость (гол с острого угла: влетел
      // почти вдоль полотна) — контакт начинается немедленно, а не пропускается.
      // Раньше этот случай отбрасывался, и боковая сетка «не держала» мяч.
      const side = Math.sign(signed);
      const time = Math.abs(signed) <= radius + 1e-5
        ? 0
        : (side * radius - signed) / speed;
      if (time < -1e-7 || time > maxTime) continue;
      const point = p.clone().addScaledVector(v, Math.max(0, time));
      if (!plane.inside(point)) continue;
      const normal = AXIS[axis].clone().multiplyScalar(side);
      const hit = {
        time: Math.max(0, time), normal, kind: 'net', panel: plane.panel,
        outward: plane.outward, plane,
      };
      if (!best || hit.time < best.time) best = hit;
    }
    return best;
  }

  goalCrossing(from, to, radius) {
    const G = CONFIG.goal;
    const line = CONFIG.field.length / 2;
    for (const dir of [-1, 1]) {
      // Вся сфера должна оказаться за линией. Проверяем только переход ИЗ поля
      // наружу: мяч, прилетевший сзади или сбоку, голом стать не может.
      const threshold = dir * (line + radius);
      const a = dir * (from.x - threshold);
      const b = dir * (to.x - threshold);
      if (a > 0 || b <= 0) continue;
      const denom = b - a;
      if (denom <= 1e-9) continue;
      const t = THREE.MathUtils.clamp(-a / denom, 0, 1);
      const z = THREE.MathUtils.lerp(from.z, to.z, t);
      const y = THREE.MathUtils.lerp(from.y, to.y, t);
      // width/height — чистый проём: вся окружность мяча проходит между
      // внутренними гранями стоек и под нижней гранью перекладины.
      if (Math.abs(z) + radius <= G.width / 2 + 1e-6 &&
          y - radius >= -1e-6 && y + radius <= G.height + 1e-6) {
        return { side: dir, point: new THREE.Vector3(threshold, y, z) };
      }
    }
    return null;
  }

  recordGoalCrossing(ball, from, to) {
    if (ball.goalScored) return null;
    const crossing = this.goalCrossing(from, to, CONFIG.ball.radius);
    if (!crossing) return null;
    ball.goalScored = true;
    return 'goal';
  }

  // Мягкий контакт с сеткой. Мяч не отражается от невидимой плоскости:
  // он входит в полотно, локально тянет узлы за собой, а пружина постепенно
  // тормозит его и возвращает обратно. Шаг дробится до 1/120 с, чтобы сильный
  // удар не перескочил весь диапазон растяжения на одном кадре планшета.
  advanceNetContact(ball, maxTime) {
    const N = CONFIG.goal.net;
    const p = ball.mesh.position;
    let used = 0;
    let event = null;

    while (ball.netContact && used < maxTime - 1e-7) {
      const contact = ball.netContact;
      const step = Math.min(1 / 120, maxTime - used);
      const axis = contact.plane.axis;
      const axisSign = contact.pushDir.getComponent(axis);
      const signedTravel = (p.getComponent(axis) - contact.plane.value) * axisSign;
      const penetration = signedTravel + CONFIG.ball.radius;
      const normalSpeed = ball.vel.dot(contact.pushDir);

      if (penetration <= 0 && normalSpeed <= 0 && contact.age > 0) {
        // Своя панель отпустила мяч — но он мог тем временем продавить соседнюю
        // (скольжение вдоль задней в бок). Контакт передаётся, а не обрывается.
        if (!this.transferNetContact(ball, contact)) break;
        continue;
      }

      const stretch = Math.max(0, penetration);
      const extra = Math.max(0, stretch - N.physicalMaxStretch);
      const accel = -N.ballSpring * stretch - N.hardStopSpring * extra - N.ballDamping * normalSpeed;
      ball.vel.addScaledVector(contact.pushDir, accel * step);

      // Гол с угла (грабля 17.07.2026): пока мяч скользит в «мешке» одной панели,
      // он может уткнуться в СОСЕДНЮЮ (бок, крышу) — без её пружины он проходил
      // сквозь полотно насквозь. Все продавленные панели работают одновременно.
      this.applySidePanels(ball, contact, step);

      const vn = ball.vel.dot(contact.pushDir);
      const normalVelocity = contact.pushDir.clone().multiplyScalar(vn);
      const tangentVelocity = ball.vel.clone().sub(normalVelocity)
        .multiplyScalar(Math.exp(-N.tangentDamping * step));
      ball.vel.copy(normalVelocity).add(tangentVelocity);
      ball.spin *= Math.exp(-3.5 * step);

      const before = p.clone();
      p.addScaledVector(ball.vel, step);
      if (this.recordGoalCrossing(ball, before, p)) event = 'goal';

      const newSignedTravel = (p.getComponent(axis) - contact.plane.value) * axisSign;
      const newPenetration = Math.max(0, newSignedTravel + CONFIG.ball.radius);
      const planePoint = p.clone();
      planePoint.setComponent(axis, contact.plane.value);
      const panelDepth = newPenetration * contact.panel.normal.dot(contact.pushDir);
      contact.panel.press(planePoint, panelDepth, step);

      contact.age += step;
      used += step;
      if (contact.age >= N.contactMaxTime) {
        ball.netContact = null; // страховка от вечного контакта — жёсткий выход
      } else if (newPenetration <= 0 && ball.vel.dot(contact.pushDir) <= 0) {
        this.transferNetContact(ball, contact); // либо соседняя панель, либо null
      }
    }
    return { used, event };
  }

  // Смерть контакта ≠ свобода: если мяч в этот момент продавливает другую
  // панель (шов задней и боковой при голе с угла), контакт переезжает на неё —
  // с накопленным возрастом, чтобы страховка contactMaxTime не сбрасывалась.
  transferNetContact(ball, contact) {
    const R = CONFIG.ball.radius;
    const p = ball.mesh.position;
    let best = null;
    let bestPen = 0.005;
    for (const plane of this.netPlanes) {
      if (plane === contact.plane) continue;
      const axis = plane.axis;
      const outSign = plane.outward.getComponent(axis);
      const pen = (p.getComponent(axis) - plane.value) * outSign + R;
      if (pen <= bestPen) continue;
      const planePoint = p.clone();
      planePoint.setComponent(axis, plane.value);
      if (!plane.inside(planePoint)) continue;
      best = plane;
      bestPen = pen;
    }
    if (!best) {
      ball.netContact = null;
      return false;
    }
    ball.netContact = {
      panel: best.panel,
      plane: best,
      pushDir: best.outward.clone(),
      age: contact.age,
      excited: contact.excited,
    };
    return true;
  }

  // Вторичные контакты: любая ДРУГАЯ панель, которую мяч продавил, пружинит
  // тем же законом, что и основная. Так работает угловой «карман» — задняя и
  // боковая сетки держат мяч вместе, и он не просачивается сквозь шов.
  applySidePanels(ball, contact, step) {
    const N = CONFIG.goal.net;
    const R = CONFIG.ball.radius;
    const p = ball.mesh.position;
    for (const plane of this.netPlanes) {
      if (plane === contact.plane) continue;
      const axis = plane.axis;
      const outSign = plane.outward.getComponent(axis);
      const pen = (p.getComponent(axis) - plane.value) * outSign + R;
      if (pen <= 0) continue;
      const planePoint = p.clone();
      planePoint.setComponent(axis, plane.value);
      if (!plane.inside(planePoint)) continue; // панель другого края/ворот

      const vn = ball.vel.dot(plane.outward);
      if (!contact.excited.has(plane.panel)) {
        contact.excited.add(plane.panel);
        plane.panel.excite(planePoint, vn);
      }
      const extra = Math.max(0, pen - N.physicalMaxStretch);
      const accel = -N.ballSpring * pen - N.hardStopSpring * extra - N.ballDamping * vn;
      ball.vel.addScaledVector(plane.outward, accel * step);
      plane.panel.press(planePoint, pen, step);
    }
  }

  moveBall(ball, dt) {
    const G = CONFIG.goal;
    const p = ball.mesh.position;
    let remaining = dt;
    let event = null;

    if (ball.netContact) {
      const soft = this.advanceNetContact(ball, remaining);
      remaining -= soft.used;
      if (soft.event) event = soft.event;
    }

    for (let iteration = 0; iteration < G.collisionIterations && remaining > 1e-6; iteration++) {
      const frameHit = this.findFrameHit(p, ball.vel, remaining, CONFIG.ball.radius);
      const netHit = this.findNetHit(
        p, ball.vel, remaining, CONFIG.ball.radius, ball.netContact?.panel ?? null,
      );
      let hit = frameHit;
      if (netHit && (!hit || netHit.time < hit.time)) hit = netHit;
      const travel = hit ? hit.time : remaining;
      const before = p.clone();
      p.addScaledVector(ball.vel, travel);

      if (this.recordGoalCrossing(ball, before, p)) event = 'goal';

      remaining -= travel;
      if (!hit) break;

      if (hit.kind === 'net') {
        const outwardImpact = ball.vel.dot(hit.outward);
        const impactPoint = p.clone().addScaledVector(hit.normal, -CONFIG.ball.radius);
        hit.panel.excite(impactPoint, outwardImpact);
        ball.netContact = {
          panel: hit.panel,
          plane: hit.plane,
          pushDir: hit.normal.clone().negate(),
          age: 0,
          excited: new Set([hit.panel]), // какие панели уже дёрнуты этим контактом
        };
        // Отладочный или испорченный импульс не должен протащить мяч дальше,
        // чем способен физически выдержать контакт. Игровые удары (до 30 м/с)
        // этот предохранитель не затрагивает.
        const intoNet = ball.vel.dot(ball.netContact.pushDir);
        if (intoNet > G.net.impactMaxSpeed) {
          ball.vel.addScaledVector(ball.netContact.pushDir, G.net.impactMaxSpeed - intoNet);
        }

        const soft = this.advanceNetContact(ball, remaining);
        remaining -= soft.used;
        if (soft.event) event = soft.event;
        continue;
      }

      const vn = ball.vel.dot(hit.normal);
      if (vn < 0) {
        const bounce = G.frameBounce;
        const tangent = G.frameTangent;
        const normalVelocity = hit.normal.clone().multiplyScalar(vn);
        const tangentVelocity = ball.vel.clone().sub(normalVelocity).multiplyScalar(tangent);
        ball.vel.copy(tangentVelocity).addScaledVector(hit.normal, -vn * bounce);
        ball.spin *= 0.78;
      }

      // Отделяем сферу от поверхности и съедаем крошечный кусок времени,
      // иначе один контакт может повторно ловиться из-за погрешности float.
      p.addScaledVector(hit.normal, G.contactEpsilon);
      const epsilonTime = Math.min(remaining, 1e-5);
      p.addScaledVector(ball.vel, epsilonTime);
      remaining -= epsilonTime;
    }

    if (remaining > 1e-6) {
      // Финальный доводочный сдвиг кадра тоже обязан проверять линию ворот:
      // без этого мяч, исчерпавший итерации столкновений (рикошет у штанги),
      // пересекал линию «незамеченным» — и вместо гола свистели угловой
      const before = p.clone();
      p.addScaledVector(ball.vel, remaining);
      if (this.recordGoalCrossing(ball, before, p)) event = 'goal';
    }
    return event;
  }
}
