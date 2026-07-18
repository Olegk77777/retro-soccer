// Слой «ноги» (steering behaviors по Бакленду, Simple Soccer):
// превращают решение «беги туда» в желаемый вектор движения 0..1.
// Никакого Three.js — чистая математика на плоскости XZ, легко тестировать.

import { CONFIG } from '../config.js';

// Полный ход к точке: единичный вектор на цель
export function seek(px, pz, tx, tz) {
  const dx = tx - px;
  const dz = tz - pz;
  const d = Math.hypot(dx, dz);
  if (d < 0.001) return { x: 0, z: 0 };
  return { x: dx / d, z: dz / d };
}

// Подход с торможением: внутри slowRadius газ спадает до нуля —
// игрок не проскакивает свою точку и не «вибрирует» на ней
export function arrive(px, pz, tx, tz, slowRadius = CONFIG.ai.homeSlow) {
  const dx = tx - px;
  const dz = tz - pz;
  const d = Math.hypot(dx, dz);
  if (d < 0.15) return { x: 0, z: 0 };
  const throttle = Math.min(1, d / slowRadius);
  return { x: (dx / d) * throttle, z: (dz / d) * throttle };
}

// Погоня за мячом с упреждением: целимся не в мяч, а туда, где он будет.
// Время упреждения — грубая оценка дистанция/скорость игрока (хватает с головой).
export function pursuitBall(px, pz, ball, playerSpeed) {
  const bp = ball.mesh.position;
  const d = Math.hypot(bp.x - px, bp.z - pz);
  const t = Math.min(d / Math.max(playerSpeed, 1), 0.9);
  // Мяч тормозит трением — упреждение с половинным коэффициентом, не в «бесконечность»
  const tx = bp.x + ball.vel.x * t * 0.5;
  const tz = bp.z + ball.vel.z * t * 0.5;
  return seek(px, pz, tx, tz);
}

// Точка «между мячом и своими воротами» на заданном отступе от ворот —
// interpose Бакленда, основа позиции вратаря
export function interposePoint(goalX, goalZ, ballX, ballZ, depth) {
  const dx = ballX - goalX;
  const dz = ballZ - goalZ;
  const d = Math.hypot(dx, dz) || 1;
  return { x: goalX + (dx / d) * depth, z: goalZ + (dz / d) * depth };
}

// Расталкивание: суммарный «пинок» от всех соседей ближе radius.
// Не даёт двадцати двум игрокам слипнуться в одну кучу у мяча.
export function separation(self, all, radius, push) {
  let ox = 0;
  let oz = 0;
  const sp = self.group.position;
  for (const other of all) {
    if (other === self) continue;
    const op = other.group.position;
    const dx = sp.x - op.x;
    const dz = sp.z - op.z;
    const d = Math.hypot(dx, dz);
    if (d > radius || d < 0.001) continue;
    const k = (1 - d / radius) * push;
    ox += (dx / d) * k;
    oz += (dz / d) * k;
  }
  return { x: ox, z: oz };
}

// Расстояние по земле от игрока до точки/мяча — мелкий, но частый помощник
export function distTo(player, x, z) {
  const p = player.group.position;
  return Math.hypot(x - p.x, z - p.z);
}

export function distToBall(player, ball) {
  const bp = ball.mesh.position;
  return distTo(player, bp.x, bp.z);
}

// Свободная зона вокруг точки: 1 = пусто, 0 = толпа (ресёрч 10, формула
// GameplayFootball AI_CalculateFreeSpace — 90% пользы pitch control за O(n)).
// Соперники берутся с упреждением на их движение.
export function freeSpace(px, pz, opponents, safeDist = CONFIG.ai.attack.freeSpaceSafeDist) {
  let crowd = 0;
  for (const o of opponents) {
    if (o.isKeeper) continue;
    const op = o.group.position;
    const ox = op.x + o.vel.x * 0.2;
    const oz = op.z + o.vel.z * 0.2;
    crowd += 1 - Math.min(1, Math.hypot(ox - px, oz - pz) / safeDist);
  }
  return 1 - Math.min(1, crowd / 2.5);
}

// Пас безопасен? Схема Бакленда (isPassSafeFromOpponent, ресёрч 10):
// соперник в координатах линии паса; за спиной пасующего — не мешает;
// иначе успевает ли добежать до траектории раньше мяча (reach = v·tМяча).
export function isPassSafe(fromX, fromZ, toX, toZ, power, opponents) {
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  const len = Math.hypot(dx, dz) || 1;
  const nx = dx / len;
  const nz = dz / len;
  const P = CONFIG.player;
  const oppSpeed = P.speed * CONFIG.ai.speedFactor * P.sprintFactor;
  for (const o of opponents) {
    const op = o.group.position;
    const lx = (op.x - fromX) * nx + (op.z - fromZ) * nz; // вдоль линии паса
    if (lx < 0 || lx > len + 3) continue; // за пасующим или дальше цели
    const ly = Math.abs(-(op.x - fromX) * nz + (op.z - fromZ) * nx); // поперёк
    // Время мяча до проекции соперника: линейно с поправкой на трение
    const tBall = lx / Math.max(power * 0.8, 1);
    const reach = oppSpeed * tBall + 1.2; // радиус досягаемости + корпус
    if (ly < reach && lx > 2) return false;
  }
  return true;
}

// Насколько «чист» коридор паса: минимальное расстояние от соперников
// до отрезка (fromX,fromZ)→(toX,toZ). Меньше порога = пас перехватят.
export function passLaneClearance(fromX, fromZ, toX, toZ, opponents) {
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  const len2 = dx * dx + dz * dz || 1;
  let min = Infinity;
  for (const o of opponents) {
    const op = o.group.position;
    // Проекция соперника на отрезок паса, зажатая в [0..1]
    let t = ((op.x - fromX) * dx + (op.z - fromZ) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = fromX + dx * t;
    const cz = fromZ + dz * t;
    const d = Math.hypot(op.x - cx, op.z - cz);
    if (d < min) min = d;
  }
  return min;
}
