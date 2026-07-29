// Слой «ноги» (steering behaviors по Бакленду, Simple Soccer):
// превращают решение «беги туда» в желаемый вектор движения 0..1.
// Никакого Three.js — чистая математика на плоскости XZ, легко тестировать.

import { CONFIG } from '../config.js';

// Полный ход к точке: единичный вектор на цель
// Вид касания по выбору тренера: он уже различает пас в ноги и пас на ход
// (choosePass → kind), а высокий lift означает наброс. Анимация обязана это
// показывать — иначе все передачи выглядят одним движением.
export function passStrikeKind(pass) {
  if (!pass) return 'pass';
  if (pass.lift > 1) return 'cross';
  return pass.kind === 'feet' ? 'pass' : 'through';
}

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

// Прогноз точки, где летящий мяч снизится до высоты h (ресёрч 11: замыкание
// навесов). Мини-симуляция той же физики, что в ball.update — гравитация,
// квадратичный drag, Магнус — поэтому прогноз честный, а не «идеальная
// парабола». Возвращает { x, z, t } или null, если мяч уже внизу/не упадёт.
export function predictLanding(ball, h = CONFIG.ball.radius, maxT = 4) {
  const B = CONFIG.ball;
  const p = ball.mesh.position;
  if (p.y <= h && ball.vel.y <= 0) return null; // уже ниже — нечего предсказывать
  let x = p.x;
  let y = p.y;
  let z = p.z;
  let vx = ball.vel.x;
  let vy = ball.vel.y;
  let vz = ball.vel.z;
  let spin = ball.spin;
  const dt = 1 / 30;
  for (let t = 0; t < maxT; t += dt) {
    vy += B.gravity * dt;
    const sp = Math.hypot(vx, vy, vz);
    if (sp > 0.01) {
      const d = Math.min(B.dragK * sp * dt, 0.5);
      vx *= 1 - d;
      vy *= 1 - d;
      vz *= 1 - d;
    }
    if (Math.abs(spin) > 0.01) {
      const ax = -vz * spin * B.magnus * dt;
      const az = vx * spin * B.magnus * dt;
      vx += ax;
      vz += az;
      spin *= Math.pow(B.spinDecay, dt * 60);
    }
    x += vx * dt;
    y += vy * dt;
    z += vz * dt;
    if (vy < 0 && y <= h) return { x, z, t: t + dt };
  }
  return null;
}

// Проход по всей траектории мяча с шагом step: колбэк получает (x, y, z, t) и,
// вернув true, останавливает обход. Та же физика, что в predictLanding и
// predictGoalPlane, — но вопрос другой: не «где мяч приземлится», а «где я
// могу его встретить». Вратарю на выходе нужно именно это: он ловит подачу не
// на фиксированной высоте, а в САМОЙ РАННЕЙ точке, до которой успевает
// добежать, — и чем раньше, тем выше над головами (правило с 28.07.2026).
export function flightPath(ball, cb, maxT = 3, step = 1 / 30) {
  const B = CONFIG.ball;
  const p = ball.mesh.position;
  let x = p.x;
  let y = p.y;
  let z = p.z;
  let vx = ball.vel.x;
  let vy = ball.vel.y;
  let vz = ball.vel.z;
  let spin = ball.spin;
  for (let t = 0; t < maxT; t += step) {
    const airborne = y > B.radius + 0.001 || vy > 0;
    if (airborne) {
      vy += B.gravity * step;
      const sp = Math.hypot(vx, vy, vz);
      if (sp > 0.01) {
        const d = Math.min(B.dragK * sp * step, 0.5);
        vx *= 1 - d;
        vy *= 1 - d;
        vz *= 1 - d;
      }
      if (Math.abs(spin) > 0.01) {
        const ax = -vz * spin * B.magnus * step;
        const az = vx * spin * B.magnus * step;
        vx += ax;
        vz += az;
        spin *= Math.pow(B.spinDecay, step * 60);
      }
    } else {
      const roll = Math.pow(B.rollFriction, step * 60);
      vx *= roll;
      vz *= roll;
    }
    x += vx * step;
    y += vy * step;
    z += vz * step;
    if (y < B.radius) {
      y = B.radius;
      if (Math.abs(vy) > 1.2) vy = -vy * B.bounce;
      else vy = 0;
    }
    // Пятым аргументом идёт СКОРОСТЬ мяча в этой точке. Без неё «медленный мяч»
    // приходится определять по скорости СЕЙЧАС, а она ничего не говорит о
    // встрече: удар с 35 м уходит на 20 м/с, а на вратаря выкатывается на 4 —
    // и это ровно тот мяч, который надо не отбивать, а забирать в руки.
    if (cb(x, y, z, t + step, Math.hypot(vx, vy, vz))) return true;
  }
  return false;
}

// Прогноз пересечения ПЛОСКОСТИ ВОРОТ (x = goalX): та же мини-симуляция
// физики, что predictLanding, но условие остановки — не высота, а координата X.
// Нужна вратарю: он обязан знать, КУДА и КОГДА мяч придёт на линию, иначе
// «сейв» — это магнит радиусом полтора метра, а не чтение удара.
// Возвращает { z, y, t, speed } или null (мяч не идёт в створ за maxT).
// dirX — с какой стороны мяч подходит к плоскости. По умолчанию знак самой
// координаты (ворота всегда далеко от центра поля), но вратарь спрашивает и
// про СВОЮ плоскость, которая может стоять где угодно, — там знак задаётся явно.
export function predictGoalPlane(ball, goalX, maxT = 2.0, dirX = Math.sign(goalX)) {
  const B = CONFIG.ball;
  const p = ball.mesh.position;
  // Мяч уже за линией или летит от ворот — предсказывать нечего
  if ((goalX - p.x) * dirX <= 0) return null;
  if (ball.vel.x * dirX <= 0.1) return null;

  let x = p.x;
  let y = p.y;
  let z = p.z;
  let vx = ball.vel.x;
  let vy = ball.vel.y;
  let vz = ball.vel.z;
  let spin = ball.spin;
  const dt = 1 / 60;
  for (let t = 0; t < maxT; t += dt) {
    const airborne = y > B.radius + 0.001 || vy > 0;
    if (airborne) {
      vy += B.gravity * dt;
      const sp = Math.hypot(vx, vy, vz);
      if (sp > 0.01) {
        const d = Math.min(B.dragK * sp * dt, 0.5);
        vx *= 1 - d;
        vy *= 1 - d;
        vz *= 1 - d;
      }
      if (Math.abs(spin) > 0.01) {
        const ax = -vz * spin * B.magnus * dt;
        const az = vx * spin * B.magnus * dt;
        vx += ax;
        vz += az;
        spin *= Math.pow(B.spinDecay, dt * 60);
      }
    } else {
      const roll = Math.pow(B.rollFriction, dt * 60);
      vx *= roll;
      vz *= roll;
    }
    const px = x;
    x += vx * dt;
    y += vy * dt;
    z += vz * dt;
    if (y < B.radius) {
      y = B.radius;
      if (Math.abs(vy) > 1.2) vy = -vy * B.bounce;
      else vy = 0;
    }
    if ((x - goalX) * dirX >= 0) {
      // Линейная доводка внутри шага — точность до сантиметров
      const k = px !== x ? (goalX - px) / (x - px) : 0;
      return {
        z: z - vz * dt * (1 - k),
        y: Math.max(B.radius, y - vy * dt * (1 - k)),
        t: t + dt * k,
        speed: Math.hypot(vx, vy, vz),
      };
    }
    if (vx * dirX <= 0.05) return null; // мяч встал/развернулся — до линии не дойдёт
  }
  return null;
}

// ===== Арифметика паса (ресёрч 15, раздел 1) =====
// Качение мяча — экспоненциальное затухание: dv/dt = −λ·v, где λ выводится
// из CONFIG.ball.rollFriction («за кадр при 60 fps»). Отсюда ТОЧНЫЕ формулы:
//   v(d) = v0 − λ·d          скорость мяча, прокатившегося d метров
//   t(d) = −ln(1 − λd/v0)/λ  время прихода
// Главный вывод ресёрча: задавать надо ПРИХОДЯЩУЮ скорость, а не начальную.
// Прежняя формула (v0 = d·0.55 + 5.5) давала пас на 15 м, летящий 2.15 с и
// приходящий на 2.9 м/с — медленнее, чем добежать спринтом. Отсюда и брался
// весь дисбаланс «легче самому бежать, чем отдавать пас».
export const ROLL_LAMBDA = -60 * Math.log(CONFIG.ball.rollFriction);

// Начальная скорость паса, чтобы мяч ПРИШЁЛ к адресату со скоростью arrive
export function passPower(dist, arrive) {
  return arrive + ROLL_LAMBDA * dist;
}

// Время прихода наземного паса на дистанцию dist при начальной скорости v0
export function passTime(dist, v0) {
  const k = (ROLL_LAMBDA * dist) / Math.max(0.1, v0);
  if (k >= 0.995) return Infinity; // мяч не докатится
  return -Math.log(1 - k) / ROLL_LAMBDA;
}

// Сила ВЕРХОВОГО мяча под заданную дальность — двоичный поиск по ЧЕСТНОЙ
// симуляции полёта (гравитация + квадратичный drag), а не по формуле идеальной
// параболы с поправочным коэффициентом: та мазала мимо адресата на 0.8–2.0 м.
// Жила методом Player.solveLoftPower; вынесена сюда, когда её понадобилось
// звать и решателю паса в зону (src/ai/passing.js) — двух копий такой
// калибровки в проекте быть не должно.
export function loftPower(dist, theta, targetH, lo, hi) {
  const B = CONFIG.ball;
  const fly = (power) => {
    let x = 0;
    let y = B.radius;
    let vx = power;
    let vy = power * Math.tan(theta);
    const dt = 1 / 120;
    for (let t = 0; t < 6; t += dt) {
      vy += B.gravity * dt;
      const sp = Math.hypot(vx, vy);
      if (sp > 0.01) {
        const k = Math.min(B.dragK * sp * dt, 0.5);
        vx *= 1 - k;
        vy *= 1 - k;
      }
      x += vx * dt;
      y += vy * dt;
      if (vy < 0 && y <= targetH) return x;
      if (y < 0) return x;
    }
    return x;
  };
  let a = lo;
  let b = hi;
  for (let i = 0; i < 26; i++) {
    const mid = (a + b) / 2;
    if (fly(mid) < dist) a = mid; else b = mid;
  }
  return (a + b) / 2;
}

// Ценность позиции для атаки — упрощённый xT (expected threat, сетка Карун
// Сингха). Нужна скорингу паса: без неё «пас вперёд» и «пас назад» отличаются
// только метрами, и AI одинаково рад откату к своим воротам и разрезу в
// штрафную. Модель аналитическая (не таблица): экспонента по дистанции до
// чужих ворот × центральность + мягкий бонус за продвижение по полю.
// Калибровка по сетке Сингха: ~0.30 у вратарской, ~0.07 у линии штрафной,
// ~0.03 с 25 м, ~0.01 у центра поля.
export function xThreat(x, z, side) {
  const F = CONFIG.field;
  const goalX = side * (F.length / 2);
  const dx = goalX - x;
  const d = Math.hypot(dx, z);
  if (d < 0.5) return 1;
  // cos λ — насколько точка «смотрит» на ворота вдоль оси поля: по центру 1,
  // с острого угла меньше. Калибровка (ресёрч 15): точка пенальти 0.54,
  // линия штрафной по центру 0.41, 30 м 0.19, центр поля 0.06
  const cosL = Math.max(0, (dx * side) / d);
  return Math.exp(-d / 18) * (0.35 + 0.65 * cosL);
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

// Запас проходимости паса (м): насколько соперники НЕ успевают на линию.
// Модель времени вместо плоского коридора: пока мяч летит до проекции
// соперника на линию паса, тот бежит поперёк — но не мгновенно (react) и не
// всем спринтом (speedK: он ещё разворачивается и не всегда лицом к мячу).
// > 0 — пас проходит, < 0 — перехватят. Плоский порог «чистоты» отсекал
// почти всё: в компактном блоке зазора в пару метров попросту не бывает.
export function passSafeMargin(fromX, fromZ, toX, toZ, power, opponents, cfg) {
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  const len = Math.hypot(dx, dz) || 1;
  const nx = dx / len;
  const nz = dz / len;
  const P = CONFIG.player;
  const oppSpeed = P.speed * CONFIG.ai.speedFactor * P.sprintFactor;
  let margin = Infinity;
  for (const o of opponents) {
    if (o.downT > 0 || o.tackleT > 0) continue; // лежащий на линии не перехватит
    const op = o.group.position;
    const lx = (op.x - fromX) * nx + (op.z - fromZ) * nz; // вдоль линии паса
    if (lx < 0.5 || lx > len) continue;                   // за спиной или дальше цели
    const ly = Math.abs(-(op.x - fromX) * nz + (op.z - fromZ) * nx); // поперёк
    const tBall = lx / Math.max(power * 0.8, 1);
    const reach = cfg.body + oppSpeed * cfg.speedK * Math.max(0, tBall - cfg.react);
    margin = Math.min(margin, ly - reach);
  }
  return margin;
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
