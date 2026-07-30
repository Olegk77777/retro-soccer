// Полная система ворот: точный каркас, непрерывные столкновения и пружинная сетка.
// Физического движка нет намеренно: геометрия ворот простая, поэтому ручная
// математика точнее, дешевле для iPad и полностью управляется через config.js.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { addRim } from './rimlight.js';

const AXIS = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
];

/**
 * Текстура НИТЕЙ. Настоящая сетка ворот — ромбическая решётка с ячейкой не
 * крупнее 120 мм (стандарт ФИФА). Рисовать её линиями по узлам симуляции
 * нельзя: честная ячейка потребовала бы вчетверо больше узлов, а тонкие
 * диагонали в 720p дали бы мерцающую кашу. Поэтому решётка — ТЕКСТУРА, а
 * мипмапы сами превращают её на дальнем плане в равномерный тюль, как в
 * телекартинке 98-го.
 *
 * Тайл повторяется по полотну, поэтому обе диагонали обязаны проходить ровно
 * через углы: тогда соседние тайлы продолжают нить без излома. Ячейка ромба
 * получается со стороной tile/√2 — отсюда и множитель при переводе в метры.
 */
let netAlphaMap = null;
function netThreadTexture() {
  if (netAlphaMap) return netAlphaMap;
  const N = CONFIG.goal.net;
  const size = 64;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';                    // дырка ячейки: alphaMap читает ЯРКОСТЬ
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(1.2, size * N.thread * Math.SQRT1_2);
  ctx.lineCap = 'square';
  // По три линии на каждое направление: средняя идёт через углы тайла, крайние
  // закрывают противоположные углы — без них в стыке появлялся разрыв нити.
  for (const shift of [-size, 0, size]) {
    ctx.beginPath();
    ctx.moveTo(-1, shift - 1);
    ctx.lineTo(size + 1, shift + size + 1);
    ctx.moveTo(-1, shift + size + 1);
    ctx.lineTo(size + 1, shift - 1);
    ctx.stroke();
  }
  netAlphaMap = new THREE.CanvasTexture(c);
  netAlphaMap.wrapS = THREE.RepeatWrapping;
  netAlphaMap.wrapT = THREE.RepeatWrapping;
  netAlphaMap.minFilter = THREE.LinearMipmapLinearFilter;
  netAlphaMap.magFilter = THREE.LinearFilter;
  netAlphaMap.generateMipmaps = true;
  netAlphaMap.anisotropy = 4;
  return netAlphaMap;
}

let netMaterial = null;
function getNetMaterial() {
  if (netMaterial) return netMaterial;
  const N = CONFIG.goal.net;
  // Один материал на все восемь полотен: у three.js ключ кэша программ — это
  // материал, и восемь одинаковых дали бы восемь программ на ровном месте.
  // depthWrite: false — сквозь сетку обязан просвечивать мяч в воротах.
  netMaterial = new THREE.MeshBasicMaterial({
    color: N.color,
    alphaMap: netThreadTexture(),
    transparent: true,
    opacity: N.opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  return netMaterial;
}

// Сетка хранит один пружинный сдвиг на узел вдоль нормали панели. Узлы связаны
// с четырьмя соседями: при попадании импульс расходится волной по полотну.
//
// Узлы — это ФИЗИКА, а не рисунок: видимую решётку даёт текстура нитей, и
// поэтому шаг узлов подбирается по гладкости кармана, а не по размеру ячейки.
class NetPanel {
  constructor(scene, cols, rows, pointAt, outwardNormal, sag = 0) {
    this.cols = Math.max(2, cols);
    this.rows = Math.max(2, rows);
    this.normal = outwardNormal.clone();
    this.count = this.cols * this.rows;
    this.rest = new Float32Array(this.count * 3);
    this.offset = new Float32Array(this.count);
    this.velocity = new Float32Array(this.count);
    this.nextVelocity = new Float32Array(this.count);
    this.asleep = false;   // спящее полотно не считается и не грузится в GPU
    this.dirty = true;

    const uvs = new Float32Array(this.count * 2);
    // Размер полотна в МЕТРАХ — из него считается, сколько ячеек ложится по
    // каждой стороне. Иначе узкая боковина и широкая задняя стенка получили бы
    // ячейки разного размера, и ворота читались бы двумя разными сетками.
    const p00 = pointAt(0, 0);
    const spanU = p00.distanceTo(pointAt(1, 0));
    const spanV = p00.distanceTo(pointAt(0, 1));
    const tile = CONFIG.goal.net.cell * Math.SQRT2; // сторона ромба → шаг тайла

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const i = row * this.cols + col;
        const u = col / (this.cols - 1);
        const v = row / (this.rows - 1);
        const p = pointAt(u, v);
        // ПРОВИС. Полотно висит на каркасе и втягивается внутрь коробки:
        // максимум в середине, ноль по краям (там оно привязано к трубам).
        // Смещение только визуальное — столкновения считает плоскость панели.
        const droop = sag * Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
        this.rest[i * 3] = p.x - this.normal.x * droop;
        this.rest[i * 3 + 1] = p.y - this.normal.y * droop;
        this.rest[i * 3 + 2] = p.z - this.normal.z * droop;
        uvs[i * 2] = (u * spanU) / tile;
        uvs[i * 2 + 1] = (v * spanV) / tile;
      }
    }

    const index = [];
    for (let row = 0; row + 1 < this.rows; row++) {
      for (let col = 0; col + 1 < this.cols; col++) {
        const a = row * this.cols + col;
        const b = a + 1;
        const c = a + this.cols;
        const d = c + 1;
        index.push(a, c, b, b, c, d);
      }
    }

    this.positions = new Float32Array(this.count * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(index);
    this.mesh = new THREE.Mesh(geometry, getNetMaterial());
    this.mesh.frustumCulled = false;
    // Сетка прозрачная и стоит на фоне трибуны: пусть рисуется после щитов
    // и до мяча в воротах — так карман не «съедает» мяч по краю.
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
    this.syncGeometry();
  }

  isPinned(col, row) {
    return col === 0 || row === 0 || col === this.cols - 1 || row === this.rows - 1;
  }

  // Любое воздействие будит полотно: спящее не тратит ни цикла, ни загрузки
  // буфера в видеопамять. Восемь полотен живут в кадре всегда, а работают
  // считаные секунды за матч — без сна это чистый налог.
  wake() {
    this.asleep = false;
    this.idle = 0;
  }

  excite(point, outwardSpeed, gain = 1, radius = CONFIG.goal.net.impactRadius) {
    const N = CONFIG.goal.net;
    this.wake();
    const r2 = radius * radius;
    const impactSpeed = Math.min(Math.abs(outwardSpeed), N.impactMaxSpeed);
    // Нелинейная кривая: слабый мяч лишь качает сетку, а мощный удар создаёт
    // глубокий мешок и гораздо более сильную волну по соседним ячейкам.
    const impulse = Math.sign(outwardSpeed) * gain * N.impactTransfer * N.impactReferenceSpeed *
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
  // Радиус — параметр: у мяча карман узкий, у вбежавшего игрока широкий.
  press(point, depth, dt, radius = CONFIG.goal.net.impactRadius) {
    const N = CONFIG.goal.net;
    this.wake();
    const r2 = radius * radius;
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
    this.dirty = true;
  }

  update(dt) {
    if (this.asleep) return;
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

    let energy = 0;
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
        const e = Math.abs(this.offset[i]) + Math.abs(this.velocity[i]) * 0.05;
        if (e > energy) energy = e;
      }
    }
    this.dirty = true;
    this.syncGeometry();

    // Успокоилось — полотно засыпает ровно в позе покоя. Порог берём заметно
    // ниже пикселя на игровом плане (1 мм), чтобы засыпание не было видно.
    if (energy < 0.001) {
      this.offset.fill(0);
      this.velocity.fill(0);
      this.syncGeometry();
      this.asleep = true;
    }
  }

  reset() {
    this.offset.fill(0);
    this.velocity.fill(0);
    this.dirty = true;
    this.syncGeometry();
    this.asleep = true;
  }

  syncGeometry() {
    if (!this.dirty) return;
    const n = this.normal;
    for (let i = 0; i < this.count; i++) {
      const j = i * 3;
      const d = this.offset[i];
      this.positions[j] = this.rest[j] + n.x * d;
      this.positions[j + 1] = this.rest[j + 1] + n.y * d;
      this.positions[j + 2] = this.rest[j + 2] + n.z * d;
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.dirty = false;
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
    // Каркас ворот стоит на фоне дальней трибуны и без каймы теряет круглоту:
    // белая труба на тёмном фоне читается плоской полосой.
    const frameMat = addRim(
      new THREE.MeshLambertMaterial({ color: 0xf2f2f2, emissive: 0x555555 }),
      CONFIG.atmosphere.rim.gearScale,
    );
    const postHeight = G.height + G.postRadius * 2;
    // Перекладина обрывается ровно на ОСЯХ штанг, а не на их внешней кромке.
    // Раньше её длина была width + 4R: торцевой круг приходился точно на
    // внешний силуэт штанги и на большом разрешении читался крестом на стыке
    // (фидбек Олега 27.07.2026). Уехав внутрь штанги, торец прячется в ней
    // целиком, и угол ворот выглядит одной сплошной трубой.
    // Физика тут ни при чём: столкновения считаются по осям a0/a1 ниже,
    // они не изменились.
    const postGeo = new THREE.CylinderGeometry(G.postRadius, G.postRadius, postHeight, G.frameSegments);
    const barGeo = new THREE.CylinderGeometry(
      G.postRadius, G.postRadius, postAxisZ * 2, G.frameSegments);

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

      // ШОВ ПАНЕЛЕЙ ПЕРЕКРЫВАЕТСЯ (правило с 28.07.2026, тот же приём, что у
      // хорд трибун). Замер: мяч, летящий из-за ворот наискось, проходил через
      // УГОЛ сетки насквозь и дальше свободно летел внутри ворот поперёк створа
      // (след: 55.8/4.43 → 54.4/2.82 → 54.6/0.07 → 54.7/−2.60). Причина — обе
      // панели честно отказывались его ловить: заднюю он пересекал ещё сбоку от
      // её полотна (|z| 4.2 > 3.90), а боковую — ещё позади её полотна
      // (x 55.0 > backX 54.4). Ни одна проверка `inside` не срабатывала, и мяч
      // въезжал в ворота через щель в углу. Каждая панель теперь считает себя
      // чуть больше своих видимых границ, и щели в шве не остаётся.
      const seam = CONFIG.ball.radius * 2 + 0.05;
      const back = new NetPanel(
        scene,
        Math.ceil((outerHalf * 2) / G.net.sim) + 1,
        Math.ceil(barAxisY / G.net.sim) + 1,
        (u, v) => new THREE.Vector3(backX, v * barAxisY, -outerHalf + u * outerHalf * 2),
        new THREE.Vector3(dir, 0, 0),
        G.net.sagBack,
      );
      this.panels.push(back);
      // pad — запас шва (см. выше). Мячу он нужен, а вот телу игрока его дают
      // нулевым: иначе бегущего ЗА полотном, вдоль внешней кромки, барьер
      // хватал бы за воздух в 37 см от края сетки.
      this.netPlanes.push({
        axis: 0, value: backX, outward: new THREE.Vector3(dir, 0, 0), panel: back,
        inside: (p, pad = seam) => p.y >= -pad && p.y <= barAxisY + pad &&
          Math.abs(p.z) <= outerHalf + pad,
      });

      const roof = new NetPanel(
        scene,
        Math.ceil(G.depth / G.net.sim) + 1,
        Math.ceil((outerHalf * 2) / G.net.sim) + 1,
        (u, v) => new THREE.Vector3(lineX + dir * G.depth * u, barAxisY, -outerHalf + v * outerHalf * 2),
        new THREE.Vector3(0, 1, 0),
        G.net.sagRoof,
      );
      this.panels.push(roof);
      this.netPlanes.push({
        axis: 1, value: barAxisY, outward: new THREE.Vector3(0, 1, 0), panel: roof,
        inside: (p, pad = seam) => dir * (p.x - lineX) >= -pad &&
          dir * (p.x - lineX) <= G.depth + pad && Math.abs(p.z) <= outerHalf + pad,
      });

      for (const side of [-1, 1]) {
        const sideZ = side * outerHalf;
        const panel = new NetPanel(
          scene,
          Math.ceil(G.depth / G.net.sim) + 1,
          Math.ceil(barAxisY / G.net.sim) + 1,
          (u, v) => new THREE.Vector3(lineX + dir * G.depth * u, v * barAxisY, sideZ),
          new THREE.Vector3(0, 0, side),
          G.net.sagSide,
        );
        this.panels.push(panel);
        this.netPlanes.push({
          axis: 2, value: sideZ, outward: new THREE.Vector3(0, 0, side), panel,
          inside: (p, pad = seam) => dir * (p.x - lineX) >= -pad &&
            dir * (p.x - lineX) <= G.depth + pad && p.y >= -pad && p.y <= barAxisY + pad,
        });
      }
    }
  }

  update(dt, players = null) {
    if (players) this.updateBodies(players, dt);
    for (const panel of this.panels) panel.update(dt);
  }

  reset() {
    for (const panel of this.panels) panel.reset();
    this.bodyTouch = new WeakMap();
  }

  /**
   * ТЕЛО В СЕТКЕ (правило с 30.07.2026). До этого игроки проходили сквозь
   * полотно как призраки: вбежавший за мячом нападающий вылетал за ворота
   * насквозь, а упавший вратарь лежал наполовину снаружи. Сетка — натянутое
   * полотно: она человека ДЕРЖИТ, а он её ТЯНЕТ, и оба это показывают.
   *
   * Барьер ДВУСТОРОННИЙ и определяет сторону по знаку: в какую сторону от
   * полотна центр тела, туда и выталкивает. Иначе игрок, обегающий ворота
   * сзади, влетал бы внутрь коробки, а выйти уже не мог.
   *
   * Податливость обязательна (bodyGive): жёсткая стенка на месте сетки
   * выглядела бы стеклом и, главное, ломала бы вымеренную геометрию броска
   * вратаря — он ложится в полотно и должен его РАСТЯНУТЬ, а не отскочить.
   */
  updateBodies(players, dt) {
    const N = CONFIG.goal.net;
    const R = N.bodyRadius;
    const G = CONFIG.goal;
    const line = CONFIG.field.length / 2;
    if (!this.bodyTouch) this.bodyTouch = new WeakMap();

    for (const player of players) {
      const pos = player.group.position;
      // Грубый отсев: сетка живёт от лицевой линии и на глубину ворот.
      // Двадцать полевых игроков в центре поля не стоят ни одной проверки.
      if (Math.abs(pos.x) < line - R) { this.bodyTouch.delete(player); continue; }
      let touched = null;

      for (const plane of this.netPlanes) {
        // Крышу пропускаем: до 2.68 м не достаёт ни один игрок, даже в прыжке,
        // и вертикальная проверка «цилиндром» для неё бессмысленна.
        if (plane.axis === 1) continue;
        const axis = plane.axis;
        const outSign = plane.outward.getComponent(axis);
        const signed = (pos.getComponent(axis) - plane.value) * outSign;
        if (Math.abs(signed) >= R) continue;
        const pushSign = signed >= 0 ? 1 : -1;   // куда выталкивать: где центр тела

        const point = pos.clone();
        point.setComponent(axis, plane.value);
        // Точка прогиба — по КОРПУСУ, а не по ногам: полотно тянет грудь и
        // плечи. У лежащего вратаря группа опущена, и точка опускается с ней.
        point.y = THREE.MathUtils.clamp(pos.y + 0.95, 0.35, G.height + G.postRadius * 2 - 0.25);
        if (!plane.inside(point, 0)) continue;

        const pen = R - Math.abs(signed);
        const panel = plane.panel;
        touched = panel;
        // Первое касание — короткий рывок волны по полотну. Дальше только
        // прогиб: человек не бьёт по сетке, он в неё упирается.
        if (this.bodyTouch.get(player) !== panel) {
          const speed = player.vel ? player.vel.getComponent(axis) * outSign : 0;
          panel.excite(point, speed, N.bodyExcite, N.bodyPress);
        }
        panel.press(point, pen * N.bodyDepth * -pushSign, dt, N.bodyPress);

        // Полотно тянется на bodyGive и на этом ДЕРЖИТ. Коррекция полная, а не
        // долей за кадр: мягкость даёт сама податливость, а «доля за кадр» на
        // скорости бега просто не успевает (замер — игрок уходил за ворота на
        // 13.6 м). Мягко и надёжно — разные вещи, и здесь нужна вторая.
        const over = pen - N.bodyGive;
        if (over > 0) {
          pos.setComponent(axis, pos.getComponent(axis) + outSign * pushSign * over);
        }
        // Скорость «в полотно» отдаётся назад малой долей: капрон под нагрузкой
        // работает как слабая пружина — влетевшего он останавливает и слегка
        // отталкивает, но батутом не становится.
        if (player.vel) {
          const v = player.vel.getComponent(axis);
          if (v * outSign * pushSign < 0) player.vel.setComponent(axis, -v * N.bodyBounce);
        }
      }
      if (touched) this.bodyTouch.set(player, touched);
      else this.bodyTouch.delete(player);
    }
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

  // ВОШЁЛ ЛИ МЯЧ В ВОРОТА ЧЕРЕЗ ПРОЁМ (правило с 28.07.2026).
  // Страховке в match.js мало знать, что мяч оказался в коробке ворот: он мог
  // попасть туда мимо створа (через угловой шов, из-за ворот, сверху) — и тогда
  // «гол» засчитывался мячу, который прошёл СНАРУЖИ, вдоль боковой сетки
  // (жалоба Олега 28.07.2026). Поэтому вход отмечается ровно один раз, в момент
  // пересечения плоскости линии, и только если центр мяча прошёл между
  // штангами и под перекладиной. Мерка — ТОТ ЖЕ чистый проём, что у честной
  // проверки goalCrossing: полоса |z| от 3.50 до 3.78 — это ОБЪЁМ ШТАНГИ, мяч
  // там физически быть не может, и «гол», засчитанный в ней, читается как мяч,
  // прошедший сквозь стойку и боковую сетку.
  trackNetEntry(ball, from, to) {
    const G = CONFIG.goal;
    const R = CONFIG.ball.radius;
    const line = CONFIG.field.length / 2;
    for (const dir of [-1, 1]) {
      const a = dir * (from.x - dir * line);
      const b = dir * (to.x - dir * line);
      if (a <= 0 && b > 0) {
        const t = b - a > 1e-9 ? -a / (b - a) : 0;
        const z = THREE.MathUtils.lerp(from.z, to.z, t);
        const y = THREE.MathUtils.lerp(from.y, to.y, t);
        ball.inGoalNet = (Math.abs(z) + R <= G.width / 2 + 1e-6 &&
          y - R >= -1e-6 && y + R <= G.height + 1e-6) ? dir : 0;
      } else if (a > 0 && b <= 0) {
        ball.inGoalNet = 0; // вышел обратно в поле — метка снимается
      }
    }
  }

  recordGoalCrossing(ball, from, to) {
    this.trackNetEntry(ball, from, to);
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
