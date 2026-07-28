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
import { arrive, seek, interposePoint, distToBall, predictGoalPlane, predictLanding, flightPath } from './steering.js';

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
      claimSeq: -1,    // ball.seq подачи, на которую кипер уже решился
      claimPunch: false, // выход КУЛАКОМ (толпа в точке), а не в руки
      rushing: false,  // выход 1в1
      shotLive: false, // удар в створ прямо сейчас (для позиции «в стойке»)
      retreating: false, // пятимся к линии: мяч перелетает
      orderT: 0,       // остаток приказа человека «на выход» (W / Y)
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
// reachAt — функция высоты мяча: тянуться вверх дороже, чем вбок, а пока идёт
// время реакции руки вообще не работают (играет только корпус).
function sweptContact(p, ball, dt, reachAt, maxY) {
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
  // Высота рук: стоя кипер играет от газона до вытянутых рук, в прыжке
  // (group.position.y > 0) зона поднимается вместе с ним
  const lift = p.group.position.y || 0;
  const by = bp.y + ball.vel.y * tca;
  if (by > maxY + lift || by < -0.05) return null;
  const reach = reachAt(by - lift);
  if (d >= reach) return null;
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

  // КУЛАКОМ (правило с 28.07.2026). Вышел в сутолоку — не ловим, а выносим:
  // мяч, пойманный между тремя чужими головами, — это аркада. Кулак бьёт
  // ПРОЧЬ ОТ ВОРОТ и в сторону от центра — туда, откуда бить уже неудобно.
  if (gk.claimPunch && gk.claim && handsOk) {
    const zs = bp.z !== 0 ? Math.sign(bp.z) : (Math.random() < 0.5 ? -1 : 1);
    const dx = into;
    const dz = zs * 0.9;
    const dl = Math.hypot(dx, dz) || 1;
    const pw = K.punchPower * (0.75 + 0.35 * handling);
    ball.vel.set((dx / dl) * pw, K.punchLift, (dz / dl) * pw);
    ball.spin = 0;
    ball.afterTouch = 0;
    p.kickCooldown = Math.max(p.kickCooldown, K.catchCooldown);
    p.playOneShot('gk_catch', 1.4, 0.2);
    gk.claim = null;
    gk.claimPunch = false;
    team.bump('parry');
    return 'punch';
  }

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
  // Удачно отбил — встаёт быстрее: лежать 0.8 с после чистого отбоя значит
  // подарить добивание (константа recoverHold существовала, но не читалась)
  if (good && p.downT > 0) p.downT = Math.min(p.downT, K.recoverHold);
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
  let depth = K.depthNear + (K.depthFar - K.depthNear) * k;
  // ВЕРХОВОЙ МЯЧ ПРИЖИМАЕТ КИПЕРА К ЛЕНТОЧКЕ (правило с 28.07.2026).
  // Дуга, посчитанная по одной дистанции, ставила вратаря в 6.5 м перед
  // линией — и любой навесной мяч, летящий к воротам, проходил над ним.
  // Высоко летящий мяч, идущий В НАШУ СТОРОНУ, — это заявка на перекид,
  // и единственный ответ на неё — заранее сократить глубину.
  const toGoal = ball.vel.x * Math.sign(goalX); // > 0 — мяч идёт к нашим воротам
  if (bp.y > K.airDepthFrom && toGoal > 0 && d < K.airDepthRange) {
    const air = Math.min(1, (bp.y - K.airDepthFrom) /
      Math.max(0.1, K.airDepthTo - K.airDepthFrom));
    // Прижим не съедает глубину до нуля: свипер нужен и под навесом,
    // а вратарь НА ЛЕНТЕ отдаёт весь угол на обычном ударе с линии штрафной
    depth = K.depthNear + (depth - K.depthNear) * (1 - air * (1 - K.airDepthKeep));
  }
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
  // Приказ человека «на выход» (W / клавиша Y на геймпаде) держится ещё
  // немного после отпускания: иначе выход срывается на дрожании пальца
  if (p.gkOrder) { gk.orderT = K.orderHold; p.gkOrder = false; }
  else if (gk.orderT > 0) gk.orderT -= dt;

  // Куда смотреть по умолчанию — ВСЕГДА на мяч. Один угол на всю функцию:
  // раньше его считали в четырёх местах и в двух ветках (лежим, бросок)
  // не считали вовсе, и кипер там доворачивался по вектору скорости
  const faceBall = Math.atan2(bp.x - pos.x, bp.z - pos.z);

  // Лежим после броска — только встаём (кадр отдан анимации подъёма)
  if (p.downT > 0) {
    gk.diving = false;
    gk.rushing = false;
    gk.retreating = false;
    p.aiUpdate(dt, { x: 0, z: 0 }, { face: faceBall, faceLock: true });
    return;
  }

  // ---- Контакт: единственная дверь, через которую мяч попадает в руки ----
  const canTouch = gk.saveCd <= 0 && p.kickCooldown <= 0 &&
    match.state !== 'restart';
  if (canTouch) {
    const diving = p.diveT > 0;
    // Зона контакта — не цилиндр в полный рост. Пока не истекла реакция,
    // играет только КОРПУС; выше метра боковая досягаемость тает; стоя выше
    // standMaxY мяч не берётся вовсе — за верхними углами надо прыгать
    const reacted = gk.reactLeft <= 0;
    const base = diving ? K.handReach + K.diveHandBonus
      : (reacted ? K.handReach : K.bodyReach);
    const reachAt = (y) => base * Math.max(0.25,
      1 - K.reachHighCost * Math.max(0, y - 1.0));
    const maxY = diving || p.jumpT > 0 ? K.handleMaxY : K.standMaxY;
    const ctx = sweptContact(p, ball, dt, reachAt, maxY);
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
        p.aiUpdate(dt, { x: 0, z: 0 }, { face: faceBall, faceLock: true });
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
    if (act && act.retreat) {
      // ОТСТУПЛЕНИЕ. Мяч перелетает вытянутые руки, но идёт в ворота —
      // единственный шанс достать его на линии. Кипер пятится СПИНОЙ ВПЕРЁД,
      // лицом к мячу (faceLock включает клип бега назад), и одновременно
      // подбирает точку по створу. Раньше этой ветки не было вовсе: кипер
      // объявлял такой мяч «не своим делом» и провожал его взглядом.
      gk.retreating = true;
      const mv = arrive(pos.x, pos.z, act.x, act.step, 1.2);
      p.aiUpdate(dt, mv, {
        face: faceBall, faceLock: true, speedCap: K.retreatSpeed,
      });
      return;
    }
    gk.retreating = false;
    if (act) {
      // Приставной шаг под прочитанную точку: кипер ставит КОРПУС за мяч,
      // а не подставляет кончики пальцев. Глубину держим свою (дуга).
      const home = homeSpot(p, ball, K);
      const mv = arrive(pos.x, pos.z, home.x, act.step, 0.8);
      // СТОЙКА — ЭТО ПОЗА, А НЕ ПОТОЛОК СКОРОСТИ НА ВСЁ ВРЕМЯ ПОЛЁТА.
      // После того как горизонт прогноза вырос с 1.8 до 3.4 с, «ударом» стал
      // считаться и медленный мяч, катящийся к воротам с сорока метров, — и
      // кипер полторы лишние секунды полз к своей точке на 2.6 м/с вместо 4.6.
      // Пока до точки далеко, идём полным ходом; мельчить шаги начинаем, уже
      // стоя на месте (то же правило recoverGap, что в ветке «дом»).
      const far = Math.hypot(home.x - pos.x, act.step - pos.z) > K.recoverGap;
      p.aiUpdate(dt, mv, {
        face: faceBall, faceLock: true,
        speedCap: far ? K.stepSpeed : K.setSpeed,
      });
      return;
    }
  }
  gk.retreating = false;

  // ---- Верховой мяч в штрафную: выход на перехват подачи ----
  // Только если это НЕ удар в створ: мяч, летящий в ворота, играется с линии
  // по своей ветке (реакция, бросок, отступление). Кипер, побежавший НАВСТРЕЧУ
  // удару, оставляет за спиной пустые ворота — замер 28.07.2026 показал плюс
  // пять голов за два матча, стоило снять это условие.
  if (!shot && tryClaim(p, dt, ball, match, gk, K, faceBall)) return;
  if (shot) gk.claim = null;

  // ---- Мяч за спину защите / выход 1в1 / приказ человека ----
  if (!shot && tryRush(p, dt, ball, match, gk, K, faceBall)) return;
  gk.rushing = false;

  // ---- Дом: дуга вратаря ----
  const t = homeSpot(p, ball, K);
  const ballNear = Math.hypot(bp.x - goalX, bp.z) < K.setDist;
  let cap = shot || ballNear ? K.setSpeed : K.stepSpeed;
  // …но если кипер ЗАМЕТНО не на своей точке (сбило рикошетом, вернулся с
  // выхода, мяч резко пошёл к воротам с 40 м), он возвращается полным ходом.
  // «Стойка готовности» 2.6 м/с посреди дороги к линии — это гол в пустые
  const gap = Math.hypot(t.x - pos.x, t.z - pos.z);
  if (gap > K.recoverGap) cap = K.stepSpeed;
  // ВОЗВРАТ НА ЛИНИЮ — ТОЖЕ ОТСТУПЛЕНИЕ, А НЕ ПРОБЕЖКА СПИНОЙ К ПОЛЮ.
  // Именно здесь кипер и разворачивался: точка дома почти всегда позади него,
  // движение шло назад, и взгляд уезжал за вектором скорости — прямо в свои
  // ворота. Лицо держим на мяче всегда; замок отпускаем только на дальнем
  // возврате, где кипер честно бежит и разворот по ходу выглядит правильно.
  const move = arrive(pos.x, pos.z, t.x, t.z, 2.0);
  p.aiUpdate(dt, move, {
    face: faceBall,
    faceLock: gap < K.recoverGap * 4,
    speedCap: cap,
  });
}

// Удар летит в створ? Возвращает { z, y, t, speed } — точку и время выхода
// мяча на линию ворот, уже С УЧЁТОМ ошибки чтения этого вратаря.
function readShot(p, ball, gk, dt, match, K, G) {
  const seq = ball.seq || 0;
  const cross = predictGoalPlane(ball, p.team.ownGoalX, K.readHorizon);
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
    cross.speed > K.onTargetSpeed;
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

  // Решение принимается по СВОЕЙ ПЛОСКОСТИ, а не по линии ворот. Вратарь стоит
  // в нескольких метрах впереди, и мяч проходит мимо него РАНЬШЕ и в ДРУГОЙ
  // точке: на типовых траекториях расхождение по z доходило до 2.3 м, по
  // времени — до 0.21 с (почти всё время реакции), по высоте — до двух метров.
  // Из-за этого часть мячей проходила просто над вратарём, а бросок стартовал
  // тогда, когда мяч уже был позади. Линия ворот остаётся только для ответа
  // «летит ли вообще в створ».
  const kp = p.group.position;
  const own = predictGoalPlane(ball, kp.x, K.readHorizon, Math.sign(p.team.ownGoalX));
  const at = own || cross;
  return {
    z: at.z + gk.readErrZ,
    y: Math.max(CONFIG.ball.radius, at.y + gk.readErrY),
    trueZ: at.z,
    t: at.t,
    speed: at.speed,
    // Точка и время на САМОЙ ЛИНИИ: по ним решается, стоит ли пятиться.
    // Своя плоскость отвечает «достану ли я мяч ЗДЕСЬ», линия — «а войдёт ли
    // он в ворота, если я его не достану». Без второго ответа кипер пропускал
    // всё, что летело выше его рук, — то есть каждый навесной удар.
    goalZ: cross.z + gk.readErrZ,
    goalY: Math.max(CONFIG.ball.radius, cross.y + gk.readErrY),
    goalT: cross.t,
  };
}

// Что делать под удар: бросок или приставной шаг под точку.
// Возвращает 'dive' | { step: z } — целевую координату вдоль створа.
function decideSave(p, ball, gk, shot, K, G) {
  const pos = p.group.position;
  const dz = shot.z - pos.z;
  const need = Math.abs(dz);
  // Переступать можно лишь чуть-чуть от точки, где кипер стоял в момент
  // удара: бросок идёт ИЗ СТОЙКИ, а не после полутора метров разбега.
  // Но «чуть-чуть» — это БЮДЖЕТ ПО ВРЕМЕНИ, а не фиксированные полметра:
  // ограничение писалось под удар в упор, а применялось и к мячу, летящему
  // полторы секунды. С 30 м вратарь честно успевает пройти 2.5 м, и без этого
  // почти треть дальних мячей уходила в ветку «безнадёжно, не бросаюсь»
  const base = gk.setZ != null ? gk.setZ : pos.z;
  const budget = Math.max(K.setStepMax, K.setSpeed * Math.max(0, shot.t - K.react));
  const step = {
    step: Math.max(base - budget, Math.min(base + budget, shot.z)),
  };

  // Верховой мяч съедает боковую дальность: тянуться вверх и вбок
  // одновременно нельзя (потому девятка и остаётся девяткой)
  let highK = 1;
  if (shot.y > K.diveHighFrom) {
    highK = 1 - K.diveHighCost *
      Math.min(1, (shot.y - K.diveHighFrom) / Math.max(0.1, K.diveMaxY - K.diveHighFrom));
  }

  // МЯЧ ПЕРЕЛЕТАЕТ ВРАТАРЯ (правило с 28.07.2026). Здесь стояло короткое
  // `выше перекладины — не наше дело`, и это была ЛОЖЬ: «выше» считалось на
  // СВОЕЙ плоскости кипера, вынесенной на 3–6 м вперёд, а мяч на этой высоте
  // спокойно опускался под перекладину за его спиной. Каждый навесной удар и
  // каждый высокий отскок кончались голом в пустые ворота при неподвижном
  // вратаре — ровно жалоба «мяч летит издалека, а он вообще не реагирует».
  // Правильный вопрос не «достану ли я тут», а «войдёт ли мяч В ВОРОТА».
  const overMe = shot.y > K.diveMaxY + K.retreatMargin;
  if (overMe) {
    const G2 = CONFIG.goal;
    const intoGoal = shot.goalT != null &&
      Math.abs(shot.goalZ) < G2.width / 2 && shot.goalY < G2.height;
    // Пятиться некуда: уже на ленточке — остаёмся и играем что дадут
    const onLine = Math.abs(pos.x - p.team.ownGoalX) <= K.retreatGuard;
    if (!intoGoal || onLine) return step;
    // Цель отступления — точка на линии под мячом, но не дальше самой ленты
    const lineX = p.team.ownGoalX - Math.sign(p.team.ownGoalX) * K.retreatGuard;
    const lim = Math.min(K.maxZ, G2.width / 2 + 0.6);
    return {
      retreat: true,
      x: lineX,
      step: Math.max(-lim, Math.min(lim, shot.goalZ)),
    };
  }
  if (shot.y > K.diveMaxY) return step; // впритык выше рук — шагом, не броском

  // ВЫПРЫГ ПОД УДАР (правило с 28.07.2026). Стоя вратарь достаёт только до
  // `standMaxY` (2.05 м) — это и есть потолок зоны контакта. Всё, что проходит
  // выше, но ниже `diveMaxY` (2.45), он не брал НИЧЕМ: бросок вбок такому мячу
  // не нужен (он летит в корпус), а прыгать было нечему — прыжок у кипера
  // существовал только в выходе на подачу. Полоса в 40 см по высоте прямо над
  // головой была дырой в воротах. Толчок ставится так, чтобы верхняя точка
  // дуги пришлась на миг встречи, — та же механика, что у замыкания головой.
  if (shot.y > K.standMaxY && p.jumpT <= 0 && shot.t > 0.10 && shot.t < 0.75 &&
      Math.abs(shot.z - pos.z) < K.handReach + K.standReach) {
    p.startJump(shot.t, Math.min(K.jumpMax, shot.y - K.standMaxY + 0.12));
    p.playOneShot('gk_catch', 1.2, 0.1);
  }

  // Успеваем ПРИСТАВНЫМ ШАГОМ поставить корпус за мяч — бросок не нужен.
  // Это и есть «сейв на месте»: лучший сейв тот, что не выглядит сейвом.
  const stepRoom = Math.abs(step.step - pos.z); // остаток разрешённого шага
  const stepSpan = Math.min(stepRoom, K.setSpeed * Math.max(0, shot.t - 0.05));
  if (need <= stepSpan + K.standReach * 0.5) return step;

  const spanFull = K.diveSpeed * K.diveTime * highK;
  const travel = Math.max(0, need - K.handReach);
  const tTravel = travel / Math.max(0.5, K.diveSpeed * highK);

  // Время ещё есть — переступаем, экономя бросок (бросок обнуляет манёвр)
  if (shot.t > tTravel + 0.08) return step;

  // Пора решаться. Дотягиваемся ли вообще — с небольшим «отчаянным» запасом:
  // безнадёжный полёт в угол всё равно надо ИЗОБРАЗИТЬ, иначе кипер стоит
  // столбом при голе, и это выглядит как поломка, а не как красивый гол
  if (need > K.handReach + spanFull + 0.9) return step;
  // Мёртвая щель: раньше здесь стояло `need < diveMinSpan + handReach` = 1.30 м,
  // хотя стоя вратарь достаёт ровно handReach = 0.95 м. Мяч, проходящий в
  // 0.95–1.30 м, объявлялся «не броском, а шагом» — и не отбивался ничем:
  // 0.7 м мёртвой полосы, почти 15% всех пропущенных. Порог сравнивал need с
  // СУММОЙ, хотя diveMinSpan — это минимальная длина полёта КОРПУСА.
  // Правило простое: не достаёт стоя — бросается
  if (need < K.handReach) return step;

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

// ВЫХОД НА ПОДАЧУ — ПОЛНАЯ ПЕРЕРАБОТКА 28.07.2026 («он вообще не играет на
// выходах», фидбек Олега).
//
// Что было сломано в прежней версии, по пунктам:
//   1. Решение принималось, когда мяч УЖЕ снижался (`bp.y ≥ 1.2 && vel.y ≤ 2`).
//      Подача летит около полутора секунд, из них половина — вверх; кипер
//      начинал думать, когда бежать было уже поздно.
//   2. Зона — радиус 6 м от ТЕКУЩЕЙ позиции вратаря. Своя вратарская — это
//      5.5 м, то есть кипер претендовал только на мяч, падающий ему на голову.
//   3. Он должен был успеть раньше ЛЮБОГО из 21 игрока — включая собственных
//      защитников. На подаче в штрафной свои всегда рядом, поэтому условие не
//      выполнялось практически никогда. А в жизни всё наоборот: на выходе
//      вратарь ХОЗЯИН, свои ему уступают, он кричит «моё!».
//   4. Не было ни кулака, ни решения «остаться» — только «поймать или нет».
//
// Теперь: цель — точка на высоте ПРИЁМА (руки над головой), решение
// принимается один раз на подачу (`claimSeq`) и дальше держится до конца
// (`claimCommit`) — метания вратаря туда-сюда выглядят хуже любой ошибки.
function tryClaim(p, dt, ball, match, gk, K, faceBall) {
  const team = p.team;
  const pos = p.group.position;
  const bp = ball.mesh.position;
  const goalX = team.ownGoalX;
  const seq = ball.seq || 0;

  // Заявка на этот мяч уже отменена — второй раз не думаем
  if (gk.claimSeq === seq && !gk.claim) return false;

  const committed = gk.claimSeq === seq && gk.claim;
  if (!committed) {
    // Подача — это ВЕРХОВОЙ мяч. Проверять «летит ли он к нашим воротам» по
    // знаку vel.x НЕЛЬЗЯ: настоящая подача с фланга идёт почти ВДОЛЬ лицевой
    // линии, у неё vel.x около нуля, и такая проверка отсекала бы ровно те
    // мячи, ради которых вратарь и выходит. Спрашиваем у траектории.
    if (bp.y < K.claimMinY && ball.vel.y < 1) return false;

    // САМАЯ РАННЯЯ точка траектории, до которой кипер успевает и где мяч ещё
    // в пределах вытянутых рук в прыжке. Раньше = выше над головами и дальше
    // от ворот — именно так и выходят на подачу.
    let best = null;
    flightPath(ball, (x, y, z, t) => {
      if (y > K.claimMaxY || y < CONFIG.ball.radius * 2) return false;
      const depth = Math.abs(x - goalX);
      if (depth > K.claimZoneX || Math.abs(z) > K.claimZoneZ) return false;
      const d = Math.hypot(x - pos.x, z - pos.z);
      // Запас на СВОЙ приход обязателен: «успеваю ровно впритык» — это не
      // выход, а подарок. Кипер должен прийти в точку ДО мяча и стоять там
      if (d / K.lungeSpeed + K.claimOwnLead > t) return false;
      best = { x, z, y, t, d };
      return true;                              // первая же годная точка и есть наша
    }, K.readHorizon);
    if (!best) { gk.claimSeq = seq; gk.claim = null; return false; }

    // Соперники — да, свои — нет: на выходе вратарь хозяин штрафной и кричит
    // «моё!». Прежняя версия считала своих защитников конкурентами, а на
    // подаче они рядом всегда — потому выход и не случался НИ РАЗУ.
    let theirs = Infinity;
    const opp = match.otherTeam(team).players;
    for (const o of opp) {
      const op = o.group.position;
      const d = Math.hypot(op.x - best.x, op.z - best.z);
      theirs = Math.min(theirs, d / (CONFIG.player.speed * CONFIG.player.sprintFactor));
    }
    // Приказ человека (W / Y) отменяет расчёт: решил выходить — выходим,
    // и промах становится ЕГО ошибкой. Ровно так это работает в FIFA/FC.
    const ordered = gk.orderT > 0;
    if (!ordered && best.d / K.lungeSpeed > theirs - K.claimLead) {
      gk.claimSeq = seq; gk.claim = null; return false;
    }
    gk.claimSeq = seq;
    gk.claim = best;
    gk.claimStart = best.d;
    // Толпа в точке — играем КУЛАКОМ: ловить мяч в сутолоке нельзя
    let crowd = 0;
    for (const o of opp) {
      const op = o.group.position;
      if (Math.hypot(op.x - best.x, op.z - best.z) < K.punchRadius) crowd++;
    }
    gk.claimPunch = crowd >= K.punchCrowd;
  }

  // ТОЧКА ОБНОВЛЯЕТСЯ КАЖДЫЙ КАДР, а РЕШЕНИЕ — нет. Разделение принципиальное:
  // мяч в полёте сносит ветром Магнуса и он бьётся о газон, поэтому цель обязана
  // пересчитываться (то же правило, что у адресата верхового паса в team.js).
  // А вот «идти или не идти» пересматривать нельзя: кипер, передумывающий на
  // бегу, — худшее, что может быть в штрафной.
  let land = null;
  flightPath(ball, (x, y, z, t) => {
    if (y > K.claimMaxY || y < CONFIG.ball.radius * 2) return false;
    const depth = Math.abs(x - goalX);
    if (depth > K.claimZoneX + 2 || Math.abs(z) > K.claimZoneZ + 2) return false;
    land = { x, z, y, t };
    return true;
  }, K.readHorizon);
  // Мяча в воздухе больше нет (сбит, принят, укатился) — выход окончен
  if (!land || (ball.seq || 0) !== seq) { gk.claim = null; return false; }
  gk.claim = land;
  const dLand = Math.hypot(land.x - pos.x, land.z - pos.z);

  // Выпрыгиваем за мячом: верхняя точка дуги ставится на миг встречи — та же
  // механика, что у замыкания головой (CONFIG.player.aerial). Прыгаем ровно
  // настолько, чтобы руки пришли на мяч, а не «на всякий случай повыше».
  if (land.y > K.claimJumpFrom && p.jumpT <= 0 && dLand < 1.6 && land.t < 0.5) {
    p.startJump(Math.max(0.08, land.t), Math.min(0.5, land.y - K.claimJumpFrom + 0.12));
    p.playOneShot('gk_catch', 1.3, 0.15);
  }

  const mv = seek(pos.x, pos.z, land.x, land.z);
  const ordered = gk.orderT > 0;
  p.aiUpdate(dt, mv, {
    sprint: true,
    face: faceBall,
    // На коротком выходе кипер идёт лицом к мячу, на длинном честно бежит
    faceLock: dLand < 3.5,
    speedCap: ordered ? K.orderSpeed : K.lungeSpeed,
  });
  gk.rushing = true;
  return true;
}

// Выход на мяч за спину защите и 1в1: сокращаем угол. Вышел рано — обыграют,
// поздно — пробьют; это осознанный риск, а не «кипер телепортируется к мячу».
function tryRush(p, dt, ball, match, gk, K, faceBall) {
  const team = p.team;
  const pos = p.group.position;
  const bp = ball.mesh.position;
  const goalX = team.ownGoalX;
  const dGoal = Math.hypot(bp.x - goalX, bp.z);
  const owner = match.toucher;

  // (0) ПРИКАЗ ЧЕЛОВЕКА (W на клавиатуре, Y на геймпаде). Расчёты отключены:
  // человек сказал «на выход» — кипер идёт на мяч и отвечает за это сам.
  // Это тот же принцип, что у кнопки вратаря в FIFA/FC: не «умный помощник»,
  // а прямое управление риском.
  if (gk.orderT > 0 && dGoal < K.orderRange && !(owner && owner.team === team)) {
    const mv = seek(pos.x, pos.z, bp.x, bp.z);
    p.aiUpdate(dt, mv, {
      sprint: true,
      face: faceBall,
      faceLock: Math.hypot(bp.x - pos.x, bp.z - pos.z) < 3.5,
      speedCap: K.orderSpeed,
    });
    gk.rushing = true;
    return true;
  }

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
      p.aiUpdate(dt, mv, {
        sprint: true,
        face: faceBall,
        faceLock: Math.hypot(bp.x - pos.x, bp.z - pos.z) < 3.5,
        speedCap: K.lungeSpeed,
      });
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
      // Стоп-дистанция НЕ константа. Раскрытый вплотную вратарь проецируется
      // на линию ворот как стена: с 8 м он накрывал 92% створа, с 10 м и
      // дальше — все 100%, и мимо него было физически не попасть. Держим
      // накрытие около половины створа: чем дальше от ворот, тем раньше стоп
      const stop = Math.max(K.rushStop, K.rushCoverK * dGoal);
      if (dOpp > stop) {
        // Идём на сокращение угла — по линии мяч→центр ворот, но не дальше
        // rushMaxDepth от линии: вратарь у центрального круга — это не выход
        const t = interposePoint(goalX, 0, bp.x, bp.z,
          Math.min(K.rushMaxDepth, Math.max(K.depthNear, dGoal - dOpp * 0.55)));
        const mv = seek(pos.x, pos.z, t.x, t.z);
        p.aiUpdate(dt, mv, {
          sprint: true,
          face: faceBall,
          faceLock: true,   // на сокращении угла глаз с мяча не спускают
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
