// Слой «голова» вратаря — ПОЛНАЯ ПЕРЕРАБОТКА 26.07.2026 (ресёрч 16-Вратарь).
//
// Прежний кипер ловил намертво всё, что влетало в радиус 1.7 м, независимо от
// силы и дистанции удара, и «бросок» был чистой анимацией — тело не двигалось.
// Теперь сейв — это ГЕОМЕТРИЯ И ВРЕМЯ:
//   1. Кипер видит удар и ЧИТАЕТ точку выхода мяча на линию ворот
//      (predictGoalPlane — та же физика, что у мяча: drag, гравитация, Магнус).
//   2. Он не бог: есть время реакции (~0.24 с) и ошибка чтения, которая тем
//      больше, чем сильнее и ближе бьют. С 8 метров в угол его не спасти —
//      ровно как в жизни.
//   3. Он ФИЗИЧЕСКИ бросается: корпус летит вбок с конечной скоростью, рука
//      достаёт мяч на handReach. Никакого магнита — касание считается по телу,
//      как у полевых (правило «касание — только телом» из CLAUDE.md).
//   4. Исход контакта решают сила удара, качество контакта (ладонь или кончики
//      пальцев) и надёжность рук: намертво / отбой в сторону / отбой в опасную
//      зону / скользящий контакт на угловой. Иногда — выронил.
// Все числа — CONFIG.ai.keeper, в логике не хардкодим.

import { CONFIG } from '../config.js';
import { arrive, seek, interposePoint, distToBall, predictGoalPlane, predictLanding } from './steering.js';

// Нормальное распределение (Бокс–Мюллер): ошибка чтения удара должна быть
// колоколом, а не равномерным шумом — иначе кипер «одинаково часто» ошибается
// на 5 см и на полметра, и промахи выглядят случайной лотереей.
function gauss() {
  const u = Math.max(1e-9, 1 - Math.random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

// Навыки вратаря из JSON состава (data/teams/*.json → squad[0].gk).
// Нет данных — «средний кипер эпохи»: правило «данные ≠ код», состав может
// не содержать характеристик, и ничего не должно ломаться.
function gkSkill(p, key, def = 0.6) {
  const v = p.look && p.look.gk ? p.look.gk[key] : undefined;
  return typeof v === 'number' ? Math.max(0, Math.min(1, v)) : def;
}

function gkState(p) {
  if (!p.gk) {
    p.gk = {
      armedSeq: -1,    // ball.seq, на который уже взведена реакция
      reactLeft: 0,    // остаток времени реакции на текущий удар
      readErrZ: 0,     // ошибка чтения точки по створу (м), своя на каждый удар
      readErrY: 0,     // и по высоте
      diving: false,   // бросок начат под ЭТОТ удар
      saveCd: 0,       // антидребезг: свой же отбитый мяч не хватаем мгновенно
      claim: null,     // точка выхода на верховой мяч
      rushing: false,  // выход 1в1
      shotLive: false, // удар в створ прямо сейчас (для позиции «в стойке»)
    };
  }
  return p.gk;
}

// Мяч в своей штрафной? Руками играть можно только здесь (правило).
function inOwnBox(team, x, z) {
  const F = CONFIG.field;
  return -team.side * x > F.length / 2 - 16.5 && Math.abs(z) < 20.16;
}

// Удар нанесён «из-за спин»? Игрок на линии удар→ворота закрывает вратарю
// обзор, и реакция запаздывает — классическая причина пропущенных мячей.
function isScreened(p, ball, match, K) {
  const bp = ball.mesh.position;
  const kp = p.group.position;
  const dx = kp.x - bp.x;
  const dz = kp.z - bp.z;
  const len = Math.hypot(dx, dz) || 1;
  const nx = dx / len;
  const nz = dz / len;
  for (const o of match.allPlayers) {
    if (o === p) continue;
    const op = o.group.position;
    const along = (op.x - bp.x) * nx + (op.z - bp.z) * nz;
    if (along < 1.0 || along > len - 1.0) continue;
    const perp = Math.abs(-(op.x - bp.x) * nz + (op.z - bp.z) * nx);
    if (perp < K.screenRadius) return true;
  }
  return false;
}

// ===== Контакт с мячом =====

// Контакт с мячом в МОМЕНТ НАИБОЛЬШЕГО СБЛИЖЕНИЯ, а не на входе мяча в зону
// рук. Разница огромная (замер 26.07): при проверке «мяч влетел в радиус»
// вратарь ловил мяч на вытянутых пальцах ЕЩЁ ЗА МЕТР до себя, качество
// контакта всегда выходило скользящим, и мяч летел дальше в ворота — даже
// удар в живот. Считаем классическую точку наибольшего сближения двух тел
// (tca) по относительной скорости и играем мяч ровно там.
// Возвращает { dist, rel, y, t } или null.
function sweptContact(p, ball, dt, reach, maxY) {
  const bp = ball.mesh.position;
  const kp = p.group.position;
  const rx = bp.x - kp.x;
  const rz = bp.z - kp.z;
  const vx = ball.vel.x - p.vel.x;
  const vz = ball.vel.z - p.vel.z;
  const vv = vx * vx + vz * vz;
  let tca = vv > 1e-6 ? -(rx * vx + rz * vz) / vv : 0;
  if (tca > dt) return null;   // мяч ещё сближается — рано играть
  if (tca < 0) tca = 0;        // мяч уже уходит — последний шанс, здесь и сейчас
  const cx = rx + vx * tca;
  const cz = rz + vz * tca;
  const d = Math.hypot(cx, cz);
  if (d >= reach) return null;
  // Высота рук: стоя кипер играет от газона до вытянутых рук, в прыжке
  // (group.position.y > 0) зона поднимается вместе с ним
  const lift = p.group.position.y || 0;
  const by = bp.y + ball.vel.y * tca;
  if (by > maxY + lift || by < -0.05) return null;
  return { dist: d, rel: d / reach, y: by, t: tca };
}

// Исход контакта: намертво / отбой / скользящий контакт / выронил.
function resolveContact(p, ball, match, gk, ctx) {
  const K = CONFIG.ai.keeper;
  const team = p.team;
  const bp = ball.mesh.position;
  const speed = ball.vel.length();
  const handling = gkSkill(p, 'handling');
  const into = team.side; // направление «в поле» от своих ворот

  gk.saveCd = K.catchCooldown;
  match.lastTouch = p; // мяч за линией после вратаря — угловой, а не «от ворот»
  team.bump('save');

  const handsOk = !K.handleOutsideBox
    ? inOwnBox(team, bp.x, bp.z) && bp.y <= K.handleMaxY
    : bp.y <= K.handleMaxY;

  // Кончиками пальцев: контакт на самом пределе вытянутой руки. Мяч почти не
  // меняет курса — чаще всего уходит за линию (угловой) или в штангу.
  if (ctx.rel > K.parryTouchFrom || !handsOk) {
    deflect(p, ball, K.parryTouchAngle * (0.5 + Math.random()), 0.82, 0.6);
    return 'touch';
  }

  // «Намертво» или отбой — решается ДЕТЕРМИНИРОВАННО (ресёрч 16, правило
  // «никакого кубика в момент истины»): мультипликативная формула gfootball.
  // Каждый множитель может убить ловлю сам по себе — потому пушка в упор
  // отбивается всегда, а дальний навесной удар берётся спокойно в руки.
  const relSpeed = Math.hypot(ball.vel.x - p.vel.x, ball.vel.y, ball.vel.z - p.vel.z);
  const veloDiff = Math.min(1, relSpeed / K.holdSpeedHard);
  // Внезапность: чем меньше времени прошло с удара, тем меньше кипер готов
  const win = K.suddenWindow - K.suddenReflex * gkSkill(p, 'reflexes');
  const age = ball.strikeAge != null ? ball.strikeAge : 9;
  const sudden = Math.pow(1 - Math.min(1, age / win), 0.6);
  let heightF = 1;
  if (bp.y > 1.9) heightF = 1 - K.holdHighDrop;
  else if (bp.y < 0.30) heightF = 1 - K.holdLowDrop;
  const hold = K.holdBase * (1 - veloDiff) * (1 - sudden) *
    (1 - K.holdReachDrop * ctx.rel * ctx.rel) * heightF * (0.7 + 0.3 * handling);

  if (hold > K.holdThreshold) {
    // Иногда руки подводят даже на «своём» мяче — ошибка вратаря (ресёрч 16:
    // спилы бывают у всех, вопрос частоты; ориентир — одна грубая ошибка
    // не чаще чем раз в 8–10 матчей, иначе читается как аркада)
    if (Math.random() < K.fumble * (1 - handling)) {
      const f = p.facing;
      ball.vel.set(f.x * K.fumbleDrop + into * 1.2, 1.4, f.z * K.fumbleDrop);
      ball.spin = 0;
      ball.afterTouch = 0;
      p.kickCooldown = Math.max(p.kickCooldown, 0.55); // сам не подберёт мгновенно
      p.playOneShot('gk_scoop', 1.2, 0.2);
      return 'fumble';
    }
    catchBall(p, ball, match);
    team.bump('hold');
    return 'catch';
  }

  // Отбой. «Правильный» — от створа в сторону/за линию; «неудачный» —
  // недалеко в опасную зону, откуда добивают (главный источник добиваний).
  const good = Math.random() < K.parryWide * (0.6 + 0.7 * handling);
  if (good) {
    // Отбой «в сторону» ЦЕЛИТСЯ ЗА ШТАНГУ — в точку на линии ворот заведомо
    // снаружи створа. Раньше направление задавалось фиксированным вектором,
    // и с позиции в метре перед линией «широкий» отбой центрального удара
    // регулярно заканчивался в собственных воротах (замер 26.07).
    const G = CONFIG.goal;
    const zs = bp.z !== 0 ? Math.sign(bp.z) : (Math.random() < 0.5 ? -1 : 1);
    const tx = team.ownGoalX - into * 0.6;             // чуть ЗА линию
    const tz = zs * (G.width / 2 + 1.8 + Math.random() * 1.4); // мимо штанги
    const dx = tx - bp.x;
    const dz = tz - bp.z;
    const dl = Math.hypot(dx, dz) || 1;
    const sp = speed * K.parrySpeedKeep;
    ball.vel.set((dx / dl) * sp, K.parryLift, (dz / dl) * sp);
  } else {
    const zr = (Math.random() * 2 - 1) * 0.8;
    const fx = into * (0.5 + 0.5 * Math.random());
    const dl = Math.hypot(fx, zr) || 1;
    const sp = speed * K.parrySpeedKeep * 0.8;
    ball.vel.set((fx / dl) * sp, K.parryLift * 0.7, (zr / dl) * sp);
  }
  ball.spin = 0;
  ball.afterTouch = 0;
  p.kickCooldown = Math.max(p.kickCooldown, K.catchCooldown);
  if (p.diveT <= 0) p.playOneShot('gk_dive', 1.5, 0.25);
  team.bump(good ? 'parry' : 'loose');
  return good ? 'parry' : 'loose';
}

// Скользящий контакт кончиками пальцев: мяч почти не теряет курс, но его
// уводит НАРУЖУ от центра створа — классический перевод на угловой (или в
// штангу). Направление задаём добавкой поперечной скорости, а не поворотом
// вектора: поворот на знак z заворачивал мяч ВНУТРЬ ворот.
function deflect(p, ball, angleDeg, keep, lift) {
  const bp = ball.mesh.position;
  const zs = bp.z !== 0 ? Math.sign(bp.z) : (Math.random() < 0.5 ? -1 : 1);
  const vx = ball.vel.x * keep;
  const vz = ball.vel.z * keep;
  const lat = Math.tan((angleDeg * Math.PI) / 180) * Math.hypot(vx, vz) * zs;
  ball.vel.set(vx, Math.max(ball.vel.y * keep, lift), vz + lat);
  ball.spin = 0;
  ball.afterTouch = 0;
  p.kickCooldown = Math.max(p.kickCooldown, CONFIG.ai.keeper.catchCooldown);
}

function catchBall(p, ball, match) {
  const K = CONFIG.ai.keeper;
  p.ai.holding = true;
  p.ai.holdAge = 0;
  p.ai.act = null;
  p.ai.dropkickStarted = false;
  p.rot = Math.atan2(p.team.side, 0);
  p.holdBallInHands(ball, K.holdY);
  match.lastTouch = p;
}

// ===== Позиция =====

// Точка «дома»: на линии мяч→центр ворот, глубина растёт с дистанцией до мяча.
// Мяч в штрафной — кипер почти на ленточке (иначе перебросят), мяч далеко —
// выдвинут и подчищает за спиной защиты (умеренный свипер 90-х).
function homeSpot(p, ball, K) {
  const team = p.team;
  const G = CONFIG.goal;
  const goalX = team.ownGoalX;
  const bp = ball.mesh.position;
  const d = Math.hypot(bp.x - goalX, bp.z);
  const k = Math.max(0, Math.min(1,
    (d - K.depthRefNear) / (K.depthRefFar - K.depthRefNear)));
  const depth = K.depthNear + (K.depthFar - K.depthNear) * k;
  const t = interposePoint(goalX, 0, bp.x, bp.z, depth);
  // Вдоль ворот кипер не уходит за штангу: закрывать ближний угол ценой
  // распахнутого дальнего — ошибка позиционирования, а не «умный» кипер
  const lim = Math.min(K.maxZ, G.width / 2 + 0.6);
  t.z = Math.max(-lim, Math.min(lim, t.z));
  return t;
}

// ===== Главная функция =====

export function updateKeeper(p, dt, ball) {
  const K = CONFIG.ai.keeper;
  const G = CONFIG.goal;
  const team = p.team;
  const match = team.match;
  const gk = gkState(p);
  const pos = p.group.position;
  const bp = ball.mesh.position;
  const goalX = team.ownGoalX;
  if (!p.ai) p.ai = {};

  if (gk.saveCd > 0) gk.saveCd -= dt;

  // Лежим после броска — только встаём (кадр отдан анимации подъёма)
  if (p.downT > 0) {
    gk.diving = false;
    gk.rushing = false;
    p.aiUpdate(dt, { x: 0, z: 0 }, {});
    return;
  }

  // ---- Контакт: единственная дверь, через которую мяч попадает в руки ----
  const canTouch = gk.saveCd <= 0 && p.kickCooldown <= 0 &&
    match.state !== 'restart';
  if (canTouch) {
    const diving = p.diveT > 0;
    const reach = K.handReach + (diving ? K.diveHandBonus : 0); // в броске руки вытянуты
    const ctx = sweptContact(p, ball, dt, reach, K.handleMaxY);
    if (ctx) {
      // Мяч под контролем СВОЕГО полевого — вратарь его не отнимает
      const owner = match.toucher;
      const mateOnBall = owner && owner.team === team && owner !== p;
      if (!mateOnBall) {
        // Итог сыгранного мяча остаётся на вратаре: по нему живут отладка,
        // замеры баланса и будущий комментатор («намертво!» / «отбил перед собой»)
        gk.last = {
          outcome: resolveContact(p, ball, match, gk, ctx),
          rel: ctx.rel,
          y: ctx.y,
        };
        p.aiUpdate(dt, { x: 0, z: 0 }, {});
        if (p.ai.holding) p.holdBallInHands(ball, K.holdY);
        return;
      }
    }
  }

  // В броске корпус летит по diveDir — рулить нельзя, только доигрывать
  if (p.diveT > 0) {
    p.aiUpdate(dt, { x: 0, z: 0 }, {});
    return;
  }

  // ---- Чтение удара ----
  const shot = readShot(p, ball, gk, dt, match, K, G);
  gk.shotLive = !!shot;

  if (shot && gk.reactLeft <= 0) {
    const act = decideSave(p, ball, gk, shot, K, G);
    if (act === 'dive') return;               // бросок пошёл, кадр закрыт
    if (act) {
      // Приставной шаг под прочитанную точку: кипер ставит КОРПУС за мяч,
      // а не подставляет кончики пальцев. Глубину держим свою (дуга).
      const home = homeSpot(p, ball, K);
      const mv = arrive(pos.x, pos.z, home.x, act.step, 0.8);
      p.aiUpdate(dt, mv, {
        face: Math.atan2(bp.x - pos.x, bp.z - pos.z),
        speedCap: K.setSpeed,
      });
      return;
    }
  }

  // ---- Верховой мяч в штрафную: выход на перехват подачи ----
  if (!shot && tryClaim(p, dt, ball, match, gk, K)) return;

  // ---- Мяч за спину защите / выход 1в1 ----
  if (!shot && tryRush(p, dt, ball, match, gk, K)) return;
  gk.rushing = false;

  // ---- Дом: дуга вратаря ----
  const t = homeSpot(p, ball, K);
  const ballNear = Math.hypot(bp.x - goalX, bp.z) < K.setDist;
  const cap = shot || ballNear ? K.setSpeed : K.stepSpeed;
  const move = arrive(pos.x, pos.z, t.x, t.z, 2.0);
  p.aiUpdate(dt, move, {
    face: Math.atan2(bp.x - pos.x, bp.z - pos.z),
    speedCap: cap,
  });
}

// Удар летит в створ? Возвращает { z, y, t, speed } — точку и время выхода
// мяча на линию ворот, уже С УЧЁТОМ ошибки чтения этого вратаря.
function readShot(p, ball, gk, dt, match, K, G) {
  const seq = ball.seq || 0;
  const cross = predictGoalPlane(ball, p.team.ownGoalX, 1.8);
  if (typeof window !== 'undefined' && window.GKDBG) gk.dbg = { seq, cross };
  // «В створ» — но с ПАНИКОЙ (ресёрч 16, лучшая идея документа): плохой
  // вратарь считает створом полосу шире реальной и дёргается на мячи,
  // летящие мимо ворот, — теряет позицию и пропускает следующий момент.
  // Ошибка рождается из позиции, а не из брошенного кубика: игрок такое
  // прощает, а «кубик в момент истины» — нет.
  const panic = 1.02 + (1 - (0.6 * gkSkill(p, 'positioning') +
    0.4 * gkSkill(p, 'vision'))) * 0.5;
  const onTarget = cross &&
    Math.abs(cross.z) < (G.width / 2) * panic &&
    cross.y < G.height * panic &&
    cross.speed > 4;
  if (!onTarget) {
    if (gk.reactLeft > 0) gk.reactLeft -= dt;
    gk.diving = false;
    return null;
  }

  // Новый удар (или рикошет — ball.seq тикнул) — взводим реакцию заново
  if (gk.armedSeq !== seq) {
    gk.armedSeq = seq;
    gk.diving = false;
    const reflexes = gkSkill(p, 'reflexes');
    let r = K.react * (1.25 - 0.5 * reflexes) + gauss() * K.reactJitter;
    if (isScreened(p, ball, match, K)) r += K.reactScreen;
    gk.reactLeft = Math.max(0.06, r);
    // Ошибка чтения фиксируется на весь удар: сильный и близкий мяч читается
    // хуже. Это ЕДИНСТВЕННЫЙ источник «бросился не в тот угол» — никаких
    // бросков монеты «спас / не спас».
    const bp = ball.mesh.position;
    const dist = Math.hypot(bp.x - p.team.ownGoalX, bp.z);
    const closeK = 1 + Math.max(0, K.readNoiseClose - dist) / K.readNoiseClose;
    const sigma = (K.readNoise + K.readNoiseSpeed * cross.speed) * closeK;
    gk.readErrZ = gauss() * sigma;
    gk.readErrY = gauss() * sigma * 0.45;
    gk.setZ = p.group.position.z; // откуда кипер стартует под ЭТОТ удар
  }
  if (gk.reactLeft > 0) gk.reactLeft -= dt;

  return {
    z: cross.z + gk.readErrZ,
    y: Math.max(CONFIG.ball.radius, cross.y + gk.readErrY),
    trueZ: cross.z,
    t: cross.t,
    speed: cross.speed,
  };
}

// Что делать под удар: бросок или приставной шаг под точку.
// Возвращает 'dive' | { step: z } — целевую координату вдоль створа.
function decideSave(p, ball, gk, shot, K, G) {
  const pos = p.group.position;
  const dz = shot.z - pos.z;
  const need = Math.abs(dz);
  // Переступать можно лишь чуть-чуть от точки, где кипер стоял в момент
  // удара: бросок идёт ИЗ СТОЙКИ, а не после полутора метров разбега
  const base = gk.setZ != null ? gk.setZ : pos.z;
  const step = {
    step: Math.max(base - K.setStepMax, Math.min(base + K.setStepMax, shot.z)),
  };

  // Верховой мяч съедает боковую дальность: тянуться вверх и вбок
  // одновременно нельзя (потому девятка и остаётся девяткой)
  let highK = 1;
  if (shot.y > K.diveHighFrom) {
    highK = 1 - K.diveHighCost *
      Math.min(1, (shot.y - K.diveHighFrom) / Math.max(0.1, K.diveMaxY - K.diveHighFrom));
  }
  if (shot.y > K.diveMaxY) return step; // выше перекладины — не наше дело

  // Успеваем ПРИСТАВНЫМ ШАГОМ поставить корпус за мяч — бросок не нужен.
  // Это и есть «сейв на месте»: лучший сейв тот, что не выглядит сейвом.
  const stepRoom = Math.abs(step.step - pos.z); // остаток разрешённого шага
  const stepSpan = Math.min(stepRoom, K.setSpeed * Math.max(0, shot.t - 0.05));
  if (need <= stepSpan + K.handReach * 0.30) return step;

  const spanFull = K.diveSpeed * K.diveTime * highK;
  const travel = Math.max(0, need - K.handReach);
  const tTravel = travel / Math.max(0.5, K.diveSpeed * highK);

  // Время ещё есть — переступаем, экономя бросок (бросок обнуляет манёвр)
  if (shot.t > tTravel + 0.08) return step;

  // Пора решаться. Дотягиваемся ли вообще — с небольшим «отчаянным» запасом:
  // безнадёжный полёт в угол всё равно надо ИЗОБРАЗИТЬ, иначе кипер стоит
  // столбом при голе, и это выглядит как поломка, а не как красивый гол
  if (need > K.handReach + spanFull + 0.9) return step;
  if (need < K.diveMinSpan + K.handReach) return step;

  // Бросок: длительность подгоняется под оставшееся время, чтобы руки
  // пришли к мячу в момент его выхода на линию, а не после
  const dur = Math.max(0.2, Math.min(K.diveTime, shot.t + 0.12));
  const lift = shot.y > 1.35
    ? Math.min(0.75, (shot.y - 1.35) * 0.7)
    : 0;
  p.startKeeperDive(0, Math.sign(dz), {
    dur,
    speed: K.diveSpeed * highK,
    recover: K.recover,
    lift,
    liftIn: Math.max(0.06, Math.min(0.25, shot.t)),
    face: Math.atan2(p.team.side, 0),
  });
  gk.diving = true;
  return 'dive';
}

// Выход на верховую подачу: забираем только СВОЙ мяч — тот, к точке прилёта
// которого мы успеваем раньше соперников. Полёт мимо — цена решения (флап).
function tryClaim(p, dt, ball, match, gk, K) {
  const team = p.team;
  const pos = p.group.position;
  const bp = ball.mesh.position;
  if (bp.y < 1.2 || ball.vel.y > 2) return false;
  const land = predictLanding(ball, 1.6);
  if (!land) return false;
  if (!inOwnBox(team, land.x, land.z)) return false;
  const dLand = Math.hypot(land.x - pos.x, land.z - pos.z);
  if (dLand > K.claimRadius) return false;

  // Успеваем ли раньше ближайшего соперника (и своего, чтобы не сбить его)
  const mine = dLand / K.lungeSpeed;
  let theirs = Infinity;
  for (const o of match.allPlayers) {
    if (o === p) continue;
    const op = o.group.position;
    const d = Math.hypot(op.x - land.x, op.z - land.z);
    theirs = Math.min(theirs, d / (CONFIG.player.speed * CONFIG.player.sprintFactor));
  }
  if (mine > theirs - K.claimMargin) return false;

  gk.claim = land;
  const mv = seek(pos.x, pos.z, land.x, land.z);
  p.aiUpdate(dt, mv, {
    sprint: true,
    face: Math.atan2(bp.x - pos.x, bp.z - pos.z),
    speedCap: K.lungeSpeed,
  });
  return true;
}

// Выход на мяч за спину защите и 1в1: сокращаем угол. Вышел рано — обыграют,
// поздно — пробьют; это осознанный риск, а не «кипер телепортируется к мячу».
function tryRush(p, dt, ball, match, gk, K) {
  const team = p.team;
  const pos = p.group.position;
  const bp = ball.mesh.position;
  const goalX = team.ownGoalX;
  const dGoal = Math.hypot(bp.x - goalX, bp.z);
  const owner = match.toucher;

  // (1) Свободный мяч за спиной защиты — подчистить (свипер)
  if ((!owner || owner === p) && dGoal < K.sweepRange && bp.y < 1.2) {
    const mine = distToBall(p, ball) / K.lungeSpeed;
    let theirs = Infinity;
    for (const o of match.otherTeam(team).players) {
      theirs = Math.min(theirs, distToBall(o, ball) /
        (CONFIG.player.speed * CONFIG.player.sprintFactor));
    }
    if (mine < theirs - K.sweepMargin) {
      const mv = seek(pos.x, pos.z, bp.x, bp.z);
      // Вне штрафной руками нельзя — там кипер просто выносит ногой,
      // обычной механикой удара полевого игрока (aiKick через контакт)
      p.aiUpdate(dt, mv, { sprint: true, speedCap: K.lungeSpeed });
      gk.rushing = true;
      return true;
    }
  }

  // (2) 1в1: соперник ведёт мяч на нас, защитники не успевают
  if (owner && owner.team !== team && dGoal < K.rushRange &&
      Math.abs(bp.z) < K.rushMaxZ) {
    let cover = Infinity;
    for (const d of team.players) {
      if (d === p) continue;
      const dp = d.group.position;
      cover = Math.min(cover, Math.hypot(dp.x - bp.x, dp.z - bp.z));
    }
    if (cover > K.rushGap) {
      const dOpp = Math.hypot(bp.x - pos.x, bp.z - pos.z);
      if (dOpp > K.rushStop) {
        // Идём на сокращение угла — по линии мяч→центр ворот
        const t = interposePoint(goalX, 0, bp.x, bp.z,
          Math.max(K.depthNear, dGoal - dOpp * 0.55));
        const mv = seek(pos.x, pos.z, t.x, t.z);
        p.aiUpdate(dt, mv, {
          sprint: true,
          face: Math.atan2(bp.x - pos.x, bp.z - pos.z),
          speedCap: K.lungeSpeed,
        });
        gk.rushing = true;
        return true;
      }
      // Вплотную — «звезда»: раскрываемся, низом и по центру не пробить.
      // Дальше сработает обычная проверка контакта (мяч влетит в зону рук)
      if (!gk.diving) {
        p.startKeeperDive(team.side, 0, {
          dur: K.diveTime * 0.7,
          speed: K.lungeSpeed * 0.5,
          recover: K.recover,
          face: Math.atan2(bp.x - pos.x, bp.z - pos.z),
        });
        gk.diving = true;
      }
      return true;
    }
  }
  return false;
}
