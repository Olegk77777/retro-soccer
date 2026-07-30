// Стенд СЕТКИ ВОРОТ и УГЛОВЫХ ФЛАЖКОВ. Собран 30.07.2026, когда сетку
// переводили с линий по узлам на текстурную решётку с честной ячейкой и
// учили держать вбежавшего игрока.
//
// Как запустить (консоль браузера на открытой игре):
//   const rig = await import('./tools/net-rig.js');
//   rig.cells();                    // размеры решётки, узлы, треугольники
//   rig.netShot();                  // удар в сетку: карман, отскок, затухание
//   rig.netShot({ speed: 8 });      // тихий мяч — карман должен быть мелким
//   rig.bodyRun();                  // игрок вбегает в сетку: держит ли
//   rig.bodyRun({ speed: 9, from: 'outside' });
//   rig.cost();                     // мс на кадр: активная сетка против спящей
//   rig.flagTest();                 // флажок: ветер, толчок телом, возврат
//
// ЭТАЛОНЫ СБОРКИ (30.07.2026, сессия 66):
//   cells    — ячейка 11.5 см (было 38), шаг симуляции 26 см, узлов 1636,
//              треугольников 2800; на отрисовку 1636 вершин против 3500 у
//              прежних линий (у LineSegments каждое ребро несёт свои две)
//   netShot  — удар 9 / 25 / 34 м/с: мяч уходит за полотно на 0.18 / 0.50 /
//              0.68 м, карман 0.22 / 0.66 / 0.98 м, обратно в поле 1.4 / 3.9 /
//              5.3 м/с, полотно засыпает через 3.4–4.0 с. Мяч во ВСЕХ случаях
//              остаётся в воротах: сетка его убивает, а не отбрасывает
//   bodyRun  — 7 и 9.2 м/с изнутри и 6 м/с снаружи: насквозь НЕ проходит,
//              продавливает 0.22 м, прогиб полотна 0.26–0.28 м, отдача
//              0.21–0.32 м/с. До правки барьера тела не было вовсе — фигура
//              уходила за ворота на 13.6 м
//   cost     — активная сетка 0.014–0.045 мс на кадр, спящая ≈0.000–0.002
//   flagTest — на ветру 4.0°, ход свободного края 0.103 м; толчок: шагом (3 м/с)
//              8.7°, бегом (6) 20.1°, спринтом (9) 31.2° при пределе 35.5°
//   баланс   — автосимуляция 8 матчей: 1.75 и 1.5 гола с барьером, 2.0 без
//              него (ablation `net.bodyRadius = 0`), 1.25 на сборке ДО правок
//              (git archive HEAD, тот же сервер). Разброс между выборками
//              одной логики больше разницы между вариантами — барьер баланс
//              НЕ двигает
//
// Стенд НИЧЕГО не оставляет сломанным: все патчи снимаются в finally.

import { CONFIG } from '../src/config.js';

const FRAME = 1 / 60;

function dbg() {
  const d = window.DBG;
  if (!d) throw new Error('DBG нет: стенд запускают на открытой игре');
  return d;
}

// Замораживаем главный цикл: физику двигаем сами, кадр за кадром.
function freeze() {
  const { match, ball } = dbg();
  const raf = window.requestAnimationFrame;
  const matchUpdate = match && match.update;
  if (match) match.update = () => {};
  window.requestAnimationFrame = () => 0;
  return () => {
    window.requestAnimationFrame = raf;
    if (match && matchUpdate) match.update = matchUpdate;
    ball.reset();
    dbg().goals.reset();
  };
}

function panelStats() {
  const { goals } = dbg();
  let maxOffset = 0;
  let awake = 0;
  for (const p of goals.panels) {
    if (!p.asleep) awake++;
    for (let i = 0; i < p.count; i++) {
      const v = Math.abs(p.offset[i]);
      if (v > maxOffset) maxOffset = v;
    }
  }
  return { maxOffset, awake };
}

/** Размеры решётки: во что обошлась честная ячейка. */
export function cells() {
  const { goals } = dbg();
  const N = CONFIG.goal.net;
  const rows = goals.panels.map((p) => ({
    сетка: `${p.cols}×${p.rows}`,
    узлов: p.count,
    tris: p.mesh.geometry.index.count / 3,
  }));
  return {
    'ячейка, см': +(N.cell * 100).toFixed(1),
    'шаг симуляции, см': +(N.sim * 100).toFixed(1),
    'узлов всего': rows.reduce((s, r) => s + r.узлов, 0),
    'треугольников всего': rows.reduce((s, r) => s + r.tris, 0),
    панели: rows,
  };
}

/**
 * Удар в сетку. Мяч пускается из поля в створ; меряем карман, отскок и
 * затухание. Скорость выхода — главное число реализма: мяч, влетевший в
 * сетку, обязан УМЕРЕТЬ в ней, а не выпрыгнуть обратно на поле.
 */
export function netShot({ speed = 25, y = 1.1, dir = 1, frames = 420 } = {}) {
  const { ball, goals } = dbg();
  const restore = freeze();
  try {
    const line = CONFIG.field.length / 2;
    const backX = dir * (line + CONFIG.goal.depth);
    ball.reset();
    ball.mesh.position.set(dir * (line - 6), y, 0);
    ball.vel.set(dir * speed, 0.4, 0);
    ball.seq = (ball.seq || 0) + 1;

    let maxPen = 0;         // как глубоко мяч ушёл ЗА плоскость задней сетки
    let maxCarry = 0;       // максимальный ход узлов полотна (видимый карман)
    let exitSpeed = 0;      // максимальная скорость обратно в поле после контакта
    let touched = false;
    let touchAt = 0;
    let settleAt = null;
    let goal = false;

    for (let f = 0; f < frames; f++) {
      const event = ball.update(FRAME);
      goals.update(FRAME);
      if (event === 'goal') goal = true;
      const p = ball.mesh.position;
      const pen = (p.x - backX) * dir + CONFIG.ball.radius;
      if (pen > maxPen) maxPen = pen;
      if (!touched && ball.netContact) { touched = true; touchAt = f * FRAME; }
      const st = panelStats();
      if (st.maxOffset > maxCarry) maxCarry = st.maxOffset;
      if (touched) {
        const back = -ball.vel.x * dir;         // + = летит обратно в поле
        if (back > exitSpeed) exitSpeed = back;
        if (settleAt === null && st.awake === 0) settleAt = f * FRAME;
      }
    }

    return {
      'удар, м/с': speed,
      'гол засчитан': goal,
      'контакт с сеткой, с': +touchAt.toFixed(2),
      'мяч ушёл за полотно, м': +maxPen.toFixed(2),
      'карман полотна, м': +maxCarry.toFixed(2),
      'вернулся в поле, м/с': +exitSpeed.toFixed(2),
      'сетка успокоилась, с': settleAt === null ? '> ' + (frames * FRAME).toFixed(1) : +settleAt.toFixed(2),
      'мяч в конце': ball.mesh.position.toArray().map((v) => +v.toFixed(2)),
    };
  } finally {
    restore();
  }
}

/**
 * Игрок вбегает в сетку. До 30.07.2026 полотна для тел не существовало вовсе:
 * фигура проходила ворота НАСКВОЗЬ и оказывалась на дорожке за ними.
 *
 * from: 'inside'  — влетает за мячом через створ и упирается в заднюю сетку;
 *       'outside' — прибегает из-за ворот и упирается в неё же снаружи.
 */
export function bodyRun({ speed = 7, from = 'inside', dir = 1, frames = 150 } = {}) {
  const { goals, match } = dbg();
  if (!match) throw new Error('нет матча: стенд гоняет настоящего игрока');
  const restore = freeze();
  const player = match.allPlayers[1];
  const keep = player.group.position.clone();
  const keepVel = player.vel.clone();
  try {
    const line = CONFIG.field.length / 2;
    const backX = dir * (line + CONFIG.goal.depth);
    const start = from === 'inside' ? dir * (line - 1.5) : dir * (line + CONFIG.goal.depth + 2.2);
    const run = from === 'inside' ? dir * speed : -dir * speed;
    player.group.position.set(start, 0, 0);
    player.vel.set(run, 0, 0);

    let maxPen = 0;      // насколько глубоко тело зашло в полотно
    let crossed = false; // прошёл ли насквозь
    let maxCarry = 0;
    for (let f = 0; f < frames; f++) {
      // Свой шаг движения: match.update заморожен, а ноги игроку двигает он.
      // Разгон не нужен — стенд про барьер, а не про разгон.
      player.vel.x += (run - player.vel.x) * Math.min(1, CONFIG.player.accel * FRAME);
      player.group.position.x += player.vel.x * FRAME;
      goals.update(FRAME, [player]);
      const rel = (player.group.position.x - backX) * dir;
      const pen = CONFIG.goal.net.bodyRadius - Math.abs(rel);
      if (pen > 0 && pen > maxPen) maxPen = pen;
      if (from === 'inside' && rel > CONFIG.goal.net.bodyRadius) crossed = true;
      if (from === 'outside' && rel < -CONFIG.goal.net.bodyRadius) crossed = true;
      const st = panelStats();
      if (st.maxOffset > maxCarry) maxCarry = st.maxOffset;
    }

    const rel = (player.group.position.x - backX) * dir;
    return {
      'бег, м/с': speed,
      откуда: from,
      'прошёл насквозь': crossed,
      'продавил полотно, м': +maxPen.toFixed(2),
      'прогиб полотна, м': +maxCarry.toFixed(2),
      'встал в, м от плоскости': +rel.toFixed(2),
      'скорость в конце, м/с': +player.vel.x.toFixed(2),
    };
  } finally {
    player.group.position.copy(keep);
    player.vel.copy(keepVel);
    restore();
  }
}

/** Цена кадра: активное полотно против спящего. */
export function cost({ frames = 240 } = {}) {
  const { goals, ball } = dbg();
  const restore = freeze();
  try {
    // 1) Спящая сетка — так она живёт почти весь матч
    goals.reset();
    let t0 = performance.now();
    for (let f = 0; f < frames; f++) goals.update(FRAME, null);
    const idle = (performance.now() - t0) / frames;

    // 2) Разбуженная: мяч в кармане задней сетки
    const line = CONFIG.field.length / 2;
    ball.reset();
    ball.mesh.position.set(line - 4, 1.1, 0);
    ball.vel.set(25, 0.4, 0);
    for (let f = 0; f < 40; f++) { ball.update(FRAME); goals.update(FRAME); }
    t0 = performance.now();
    for (let f = 0; f < frames; f++) {
      goals.panels[0].wake();
      goals.update(FRAME, dbg().match ? dbg().match.allPlayers : null);
    }
    const busy = (performance.now() - t0) / frames;

    return {
      'спящая сетка, мс': +idle.toFixed(4),
      'активная сетка, мс': +busy.toFixed(4),
      'доля кадра 60 Гц, %': +((busy / 16.7) * 100).toFixed(2),
    };
  } finally {
    restore();
  }
}

/**
 * Флажок: полощется ли на ветру, гнётся ли от пробегающего и возвращается ли.
 * Меряем угол наклона древка — он и есть вся механика.
 */
export function flagTest({ speed = 7 } = {}) {
  const { scene, match } = dbg();
  const corners = scene.userData.corners;
  if (!corners) throw new Error('флажков в сцене нет');
  const restore = freeze();
  const player = match.allPlayers[1];
  const keep = player.group.position.clone();
  const keepVel = player.vel.clone();
  try {
    const flag = corners.flags[0];
    const F = CONFIG.field;

    // 1) Покой на ветру: сколько градусов держит и как дышит полотнище
    for (let f = 0; f < 180; f++) corners.update(FRAME, null, null);
    const restTilt = Math.hypot(flag.bendX, flag.bendZ) * 180 / Math.PI;
    const wave = [];
    for (let f = 0; f < 60; f++) {
      corners.update(FRAME, null, null);
      const arr = flag.flag.geometry.attributes.position.array;
      wave.push(arr[arr.length - 1]); // z последней вершины — свободный край
    }
    const waveSpan = Math.max(...wave) - Math.min(...wave);

    // 2) Игрок пробегает вплотную. Гоняем ПОЛНЫЙ проход мимо флажка, а не
    // фиксированные 12 кадров: на шаге медленно идущий не успевал войти в
    // радиус, и стенд печатал «толчка нет» там, где он просто не начался.
    player.group.position.set(flag.x - 0.2, 0, flag.z + 1.6);
    player.vel.set(0, 0, -speed);
    let maxTilt = 0;
    for (let f = 0; f < 90 && player.group.position.z > flag.z - 1.6; f++) {
      player.group.position.z += player.vel.z * FRAME;
      corners.update(FRAME, [player], null);
      maxTilt = Math.max(maxTilt, Math.hypot(flag.bendX, flag.bendZ) * 180 / Math.PI);
    }
    // 3) Возврат: сколько секунд качается обратно к покою
    player.group.position.set(0, 0, 0);
    let back = null;
    for (let f = 0; f < 240; f++) {
      corners.update(FRAME, null, null);
      const tilt = Math.hypot(flag.bendX, flag.bendZ) * 180 / Math.PI;
      if (back === null && Math.abs(tilt - restTilt) < 0.5) back = f * FRAME;
    }

    return {
      'наклон на ветру, °': +restTilt.toFixed(2),
      'ход свободного края, м': +waveSpan.toFixed(3),
      'наклон от игрока, °': +maxTilt.toFixed(1),
      'вернулся за, с': back === null ? '> 4' : +back.toFixed(2),
      'угол поля': [flag.x, flag.z],
    };
  } finally {
    player.group.position.copy(keep);
    player.vel.copy(keepVel);
    restore();
  }
}
