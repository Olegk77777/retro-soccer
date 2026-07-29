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
import { arrive, seek, interposePoint, predictGoalPlane, flightPath } from './steering.js';

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
      collecting: false, // идём НАВСТРЕЧУ медленному мячу — забрать в руки
      collectSeq: -1,    // ball.seq, на который уже решено «иду забирать»
      collectOn: false,  // …и само решение (мигать им нельзя, см. tryCollect)
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
  // НОРМАЛЬ КОНТАКТА — от вратаря к мячу в точке наибольшего сближения.
  // Без неё отбой невозможно посчитать честно: мяч, пришедший в живот, и мяч,
  // задетый краем перчатки, обязаны уходить в РАЗНЫЕ стороны, а раньше оба
  // получали один и тот же заранее заданный вектор.
  const inv = d > 1e-4 ? 1 / d : 0;
  return {
    dist: d, rel: d / reach, y: by, t: tca,
    nx: inv ? cx * inv : 0,
    nz: inv ? cz * inv : (ball.vel.z >= 0 ? -1 : 1),
    // Высота контакта относительно КОРПУСА: 0 — в ноги, 1 — над головой.
    // По ней решается, уходит ли отбой вверх (перевод через перекладину).
    high: Math.max(0, Math.min(1, (by - lift) / CONFIG.ai.keeper.diveMaxY)),
  };
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
    if (p.diveT <= 0 && p.downT <= 0) p.playOneShot('gk_catch', 1.4, 0.2);
    gk.claim = null;
    gk.claimPunch = false;
    team.bump('parry');
    return 'punch';
  }

  // Кончиками пальцев: контакт на самом пределе вытянутой руки. Мяч почти не
  // меняет курса — чаще всего уходит за линию (угловой) или в штангу.
  if (ctx.rel > K.parryTouchFrom || !handsOk) {
    deflect(p, ball, K.parryTouchAngle * (0.5 + Math.random()), 0.82, 0.6, ctx);
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
  // Лёжа мяч забирается хуже: под него не подставить корпус, работают только
  // руки. Мяч, накрытый лёжа, чаще остаётся в игре — и это правильно, иначе
  // «лежачий сейв» стал бы бесплатным продолжением каждого броска
  const lyingF = p.downT > 0 ? 1 - K.downHoldDrop : 1;
  const hold = K.holdBase * (1 - veloDiff) * (1 - sudden) *
    (1 - K.holdReachDrop * ctx.rel * ctx.rel) * heightF * lyingF *
    (0.7 + 0.3 * handling);

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
      if (p.diveT <= 0 && p.downT <= 0) p.playOneShot('gk_scoop', 1.2, 0.2);
      return 'fumble';
    }
    catchBall(p, ball, match);
    team.bump('hold');
    return 'catch';
  }

  // ===== ОТБОЙ — ОТРАЖЕНИЕ ОТ РУКИ, А НЕ ТЕЛЕПОРТ СКОРОСТИ =====
  // (правило с 28.07.2026, фидбек Олега «отскоки при парировании нереалистичные»).
  //
  // Что было. Мячу НАЗНАЧАЛАСЬ новая скорость: направление — на точку за
  // штангой, модуль — доля прежнего, вертикаль — константа `parryLift` = 2.2.
  // Входящее направление не участвовало ВООБЩЕ. Поэтому пушка с 8 метров в
  // упор и слабый навесной откат уходили от вратаря совершенно одинаково, а
  // мяч в живот отскакивал вбок «сам по себе» — это читается как телепорт,
  // а не как отбитый мяч.
  //
  // Что стало. Честное отражение от плоскости кисти:
  //   v' = v − (1 + e)·(v·n)·n  плюс добавка от хода самой руки,
  // где n — нормаль контакта (от корпуса вратаря к мячу, посчитана в
  // sweptContact), e — упругость перчатки. Отсюда всё само собой правильно:
  // мяч в центр корпуса летит НАЗАД в поле (и это опасный отбой), мяч на
  // краю ладони уходит вбок по касательной, верховой — переводится вверх.
  //
  // Мастерство не подменяет физику, а ДОВОРАЧИВАЕТ НОРМАЛЬ: хороший вратарь
  // подставляет ладонь так, чтобы увести мяч от створа. Это единственное
  // место, где решает навык, и именно так это и работает в жизни.
  const G = CONFIG.goal;
  const skill = 0.45 + 0.55 * handling;
  // Куда «надо» увести: наружу от центра створа и от ворот
  const zs = bp.z !== 0 ? Math.sign(bp.z) : (Math.random() < 0.5 ? -1 : 1);
  const wantX = into;                        // прочь от своих ворот
  const wantZ = zs * K.parryOutZ;            // и в сторону от створа
  const wl = Math.hypot(wantX, wantZ) || 1;
  // Доворот нормали к желаемому. Полный поворот запрещён: мяч, пришедший в
  // живот, физически не может уйти под прямым углом, сколько ни старайся
  const aim = K.parryAim * skill;
  let nx = ctx.nx * (1 - aim) + (wantX / wl) * aim;
  let nz = ctx.nz * (1 - aim) + (wantZ / wl) * aim;
  const nl = Math.hypot(nx, nz) || 1;
  nx /= nl; nz /= nl;
  // Вертикаль нормали: чем выше контакт, тем сильнее мяч идёт ВВЕРХ (перевод
  // через перекладину), у самого газона — наоборот, прижимается
  const ny = K.parryUp * (ctx.high - K.parryUpFrom);

  const vn = ball.vel.x * nx + ball.vel.y * ny + ball.vel.z * nz;
  const e = K.parryBounce;
  // Ход руки/корпуса: вратарь в броске добавляет мячу своей скорости
  const push = K.parryPush * (0.5 + 0.5 * skill) *
    (p.diveT > 0 ? 1 : 0.45) * Math.max(0, -vn / Math.max(4, speed));
  ball.vel.x -= (1 + e) * vn * nx;
  ball.vel.y -= (1 + e) * vn * ny;
  ball.vel.z -= (1 + e) * vn * nz;
  ball.vel.x += nx * push;
  ball.vel.y += ny * push + K.parryScoop;
  ball.vel.z += nz * push;
  // Перчатка гасит удар: без этого мяч уходит от вратаря быстрее, чем прилетел
  ball.vel.multiplyScalar(K.parrySpeedKeep + K.parryKeepSkill * skill);
  // ЖЁСТКИЙ ПОТОЛОК. Отражение с добавкой от руки может в сумме дать мячу
  // больше, чем он принёс: замер на стенде показал уходящие 20 м/с при
  // входящих 24. Отбитый мяч ФИЗИЧЕСКИ не может быть быстрее удара — рука
  // отдаёт куда меньше, чем нога. Держим долю от входящей скорости.
  const out = ball.vel.length();
  const cap = speed * K.parryMaxKeep;
  if (out > cap && out > 0.01) ball.vel.multiplyScalar(cap / out);

  // Опасен ли отбой — это ИТОГ, а не бросок монеты: мяч, ушедший в поле
  // перед воротами, и есть тот самый подарок на добивание.
  const away = ball.vel.x * into;                    // > 0 — прочь от ворот
  const wide = Math.abs(ball.vel.z) > Math.abs(ball.vel.x) * 0.6;
  const good = away > 1.5 || wide;

  ball.spin = 0;
  ball.afterTouch = 0;
  p.kickCooldown = Math.max(p.kickCooldown, K.catchCooldown);
  // Отбой стоя — тоже движение: раньше здесь всегда играл gk_dive, то есть
  // вратарь падал вбок от мяча, отбитого в упор. Клип выбирается по стороне
  if (p.diveT <= 0 && p.downT <= 0) {
    // Та же проверенная форма, что в updateLoco и startKeeperDive:
    // side = fx·nz − fz·nx, > 0 — мяч ушёл вправо от взгляда
    const side = Math.sin(p.rot) * ctx.nz - Math.cos(p.rot) * ctx.nx;
    p.playOneShot(Math.abs(side) < 0.35 ? 'gk_block'
      : (side > 0 ? 'gk_dive_r' : 'gk_dive'), 1.9, 0.25);
  }
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
function deflect(p, ball, angleDeg, keep, lift, ctx = null) {
  const bp = ball.mesh.position;
  const zs = bp.z !== 0 ? Math.sign(bp.z) : (Math.random() < 0.5 ? -1 : 1);
  const vx = ball.vel.x * keep;
  const vz = ball.vel.z * keep;
  const lat = Math.tan((angleDeg * Math.PI) / 180) * Math.hypot(vx, vz) * zs;
  ball.vel.set(vx, Math.max(ball.vel.y * keep, lift), vz + lat);
  ball.spin = 0;
  ball.afterTouch = 0;
  p.kickCooldown = Math.max(p.kickCooldown, CONFIG.ai.keeper.catchCooldown);
  // Касание кончиками пальцев — тоже ДВИЖЕНИЕ. Раньше оно не играло ничего:
  // мяч менял курс у неподвижного вратаря, и это читалось как отскок от
  // воздуха. Клип выбираем по стороне тем же выражением, что и везде.
  if (ctx && p.diveT <= 0 && p.downT <= 0) {
    const side = Math.sin(p.rot) * ctx.nz - Math.cos(p.rot) * ctx.nx;
    p.playOneShot(Math.abs(side) < 0.35 ? 'gk_block'
      : (side > 0 ? 'gk_dive_r' : 'gk_dive'), 2.1, 0.3);
  }
}

function catchBall(p, ball, match) {
  const K = CONFIG.ai.keeper;
  // ЛОВЛЯ БЕЗ КЛИПА — это и было половиной «нереалистичных сейвов»: мяч просто
  // прилипал к рукам бегущего вратаря, и ноги продолжали перебирать. Клип
  // gk_catch лежал в модели с самого начала и не проигрывался НИ РАЗУ.
  // В броске не трогаем: там уже идёт gk_dive и мяч ловится в падении.
  if (p.diveT <= 0 && p.downT <= 0) p.playOneShot('gk_catch', 1.35, 0.15);
  p.ai.holding = true;
  p.ai.holdAge = 0;
  p.ai.act = null;
  p.ai.dropkickStarted = false;
  // Развернуться лицом в поле — ДОЕХАТЬ, а не щёлкнуть. Замер по матчу: голое
  // присваивание давало до 141° за кадр при потолке игры 10.5°/кадр — та же
  // «телепортация», из-за которой удары перевели на faceStrike.
  p.faceStrike(Math.atan2(p.team.side, 0));
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
  gk.collecting = false;

  // ---- Контакт: единственная дверь, через которую мяч попадает в руки ----
  // ПРОВЕРКА СТОИТ ВЫШЕ ВЕТКИ «ЛЕЖИМ» (правило с 29.07.2026). Раньше ветка
  // `downT > 0` возвращалась ДО неё, и лежащий вратарь был ПРИЗРАКОМ: мяч
  // проходил сквозь тело, а он смотрел ему вслед. Замер на стенде (throughTest,
  // мяч приходит через 0.28 с — типичное добивание): свежий кипер пропускал
  // 4 мяча из 9, лежащий — ВСЕ ДЕВЯТЬ, включая мяч, катящийся ему в руки на
  // 6 м/с в ноль сантиметров от корпуса. В воронке живых матчей это 4 гола из
  // 10. В жизни всё наоборот: лежащий вратарь накрывает мяч руками — это самая
  // типичная картина штрафной, и по створу лежащее тело занимает БОЛЬШЕ места,
  // а не меньше. Но играет он только НИЗОМ (downMaxY) и только тем, до чего
  // дотянулся не вставая (downReach): подняться и переместиться он не может.
  //
  // АНТИДРЕБЕЗГ НЕ ИМЕЕТ ПРАВА СТОИТЬ ГОЛА (правило с 29.07.2026). Пауза в
  // 0.25 с после своего касания нужна: без неё вратарь схватил бы отбитый им же
  // мяч в следующем кадре, и отбоя как явления не существовало бы. Но у неё
  // была цена, которую видно только в воронке: замер по 4 матчам показал, что
  // у ВСЕХ ШЕСТИ голов категории «прошло сквозь вратаря» кулдаун был АКТИВЕН
  // (0.05…0.18 с), а скорости мяча — 6.3…13.4 м/с. То есть кипер отбивал мяч
  // себе за спину и слеп ровно на то время, за которое тот закатывался в
  // ворота. Это и была жалоба «еле катящийся гол». Живой вратарь так не стоит:
  // отбив мяч под себя, он его тут же и накрывает. Второй контакт разрешаем
  // рано (reboundCooldown), но ТОЛЬКО по мячу, который идёт в свои ворота, —
  // безопасный отбой в поле по-прежнему честно уходит из рук.
  const cdLeft = Math.max(gk.saveCd, p.kickCooldown);
  const rebound = cdLeft > 0 &&
    gk.saveCd <= K.catchCooldown - K.reboundCooldown &&
    p.kickCooldown <= K.catchCooldown - K.reboundCooldown &&
    !!predictGoalPlane(ball, goalX, K.reboundHorizon);
  const canTouch = (cdLeft <= 0 || rebound) &&
    match.state !== 'restart';
  if (canTouch) {
    const diving = p.diveT > 0;
    const lying = p.downT > 0;
    // Зона контакта — не цилиндр в полный рост. Пока не истекла реакция,
    // играет только КОРПУС; выше метра боковая досягаемость тает; стоя выше
    // standMaxY мяч не берётся вовсе — за верхними углами надо прыгать
    const reacted = gk.reactLeft <= 0;
    const base = lying ? K.downReach
      : (diving ? K.handReach + K.diveHandBonus
        : (reacted ? K.handReach : K.bodyReach));
    const reachAt = (y) => base * Math.max(0.25,
      1 - K.reachHighCost * Math.max(0, y - 1.0));
    const maxY = lying ? K.downMaxY
      : (diving || p.jumpT > 0 ? K.handleMaxY : K.standMaxY);
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
        // Лежачему корпус не доворачиваем: цепочку падения ведёт клип, и
        // доворот поверх неё — та же грабля, что «слой живого корпуса» во
        // время одноразовых клипов (CLAUDE.md, правило про updatePose)
        p.aiUpdate(dt, { x: 0, z: 0 },
          p.downT > 0 ? {} : { face: faceBall, faceLock: true });
        if (p.ai.holding) p.holdBallInHands(ball, K.holdY);
        return;
      }
    }
  }

  // Лежим после броска — только встаём (кадр отдан анимации подъёма)
  if (p.downT > 0) {
    gk.diving = false;
    gk.rushing = false;
    gk.retreating = false;
    p.aiUpdate(dt, { x: 0, z: 0 }, { face: faceBall, faceLock: true });
    return;
  }

  // В броске корпус летит по diveDir — рулить нельзя, только доигрывать
  if (p.diveT > 0) {
    p.aiUpdate(dt, { x: 0, z: 0 }, {});
    return;
  }

  // ---- Чтение удара ----
  const shot = readShot(p, ball, gk, dt, match, K, G);
  gk.shotLive = !!shot;

  // ---- Медленный мяч НЕ ОТБИВАЮТ, ЕГО ЗАБИРАЮТ (правило с 28.07.2026) ----
  // Просьба Олега прямым текстом: «еле катящиеся мячи издалека — тут его надо
  // просто брать в руки». Живой вратарь на такой мяч ВЫХОДИТ и накрывает его в
  // нескольких метрах перед линией, а не ждёт на ленточке, пока мяч допрыгает.
  // Условия узкие: мяч тихий, низкий, точка встречи в своей штрафной (руками
  // играть можно только там) и ни один соперник к ней не поспевает — иначе это
  // не выход, а подарок на пустые ворота.
  //
  // ВЫЗОВ СТОИТ ВЫШЕ ВЕТКИ УДАРА И ОТ НЕЁ НЕ ЗАВИСИТ (правило с 29.07.2026).
  // Раньше он жил ВНУТРИ `if (shot)`, то есть работал только для мяча, который
  // дойдёт до линии ворот. Мяч, замирающий в штрафной, ударом не считается —
  // и вратарь за ним не шёл вовсе.
  if (gk.reactLeft <= 0 && tryCollect(p, dt, ball, match, gk, K, faceBall)) return;

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
      // …и на МЕДЛЕННЫЙ мяч стойка тоже не нужна: пока он ползёт, кипер
      // спокойно переходит на его линию нормальным приставным ходом. Стойка
      // готовности нужна против ПУШКИ, где решают сантиметры и рефлекс.
      const far = Math.hypot(home.x - pos.x, act.step - pos.z) > K.recoverGap;
      p.aiUpdate(dt, mv, {
        face: faceBall, faceLock: true,
        speedCap: far || shot.speed < K.collectSpeed ? K.stepSpeed : K.setSpeed,
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
  // Переступать можно лишь столько, сколько успеваешь ЗА ОСТАВШЕЕСЯ ВРЕМЯ:
  // бросок идёт ИЗ СТОЙКИ, а не после полутора метров разбега. Но «чуть-чуть» —
  // это БЮДЖЕТ ПО ВРЕМЕНИ, а не фиксированные полметра: ограничение писалось
  // под удар в упор, а применялось и к мячу, летящему полторы секунды.
  //
  // ЯКОРЬ БЮДЖЕТА — ТЕКУЩАЯ ПОЗИЦИЯ, А НЕ ПОЗИЦИЯ В МОМЕНТ УДАРА (правило с
  // 28.07.2026). Прежняя редакция откладывала бюджет от `gk.setZ`, то есть от
  // точки, где кипер стоял, когда по мячу ударили. Радиус при этом СЖИМАЕТСЯ
  // (`shot.t` тает с каждым кадром), и кипер, честно прошедший часть пути,
  // получал цель ПОЗАДИ СЕБЯ и разворачивался ОТ мяча. Замер (мяч с 38 м,
  // приход 3 м/с, точка на 1.8 по створу): кипер дошёл до z = 0.79, бюджет
  // ужался до setStepMax = 0.55 — и он поехал обратно 0.79 → 0.75 → 0.68 →
  // 0.62, после чего объявил оставшиеся 1.1 м «броском» и упал за 0.09 с до
  // мяча. Ровно жалоба «пытается прыгать и проигрывает тайминг». От текущей
  // позиции цель всегда ЛЕЖИТ МЕЖДУ вратарём и мячом и назад не уводит,
  // а физика «дальше, чем успею» соблюдается сама: за t секунд не пройти
  // больше, чем v·t, сколько кадров ни считай.
  const budget = Math.max(K.setStepMax, K.setSpeed * Math.max(0, shot.t - K.react));
  const step = {
    step: Math.max(pos.z - budget, Math.min(pos.z + budget, shot.z)),
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
  // ЗАПАС ОТСЧИТЫВАЕТСЯ ВНИЗ ОТ ДОСЯГАЕМОСТИ, А НЕ ВВЕРХ ОТ НЕЁ (правило с
  // 29.07.2026). Здесь стояли ДВА РАЗНЫХ порога: пятиться — выше 2.57, а
  // «впритык выше рук, стоим» — выше 2.45. Между ними лежала МЁРТВАЯ ПОЛОСА
  // в 12 см: мяч на этой высоте не игрался ничем и не вызывал отступления.
  // Стоила она дорого, потому что попадали в неё не редкие мячи, а самые
  // обычные: замер трассы навеса (lobTrace) показал, что на плоскости вратаря
  // мяч выше, чем на линии, на 0.34 м с 18 метров и на 1.14 м с 24 — то есть
  // мяч, входящий в ворота на высоте груди (1.4 м), проходит над вратарём как
  // раз на 2.5 м. Отсюда и «пропускает мячи, летящие прямо по центру»: кипер
  // объявлял «выше моих рук» и оставался стоять, а мяч спокойно опускался под
  // перекладину за его спиной. Порог теперь ОДИН, и запас работает в правильную
  // сторону — пятиться начинаем чуть РАНЬШЕ, чем мяч станет недосягаемым.
  const overMe = shot.y > K.diveMaxY - K.retreatMargin;
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

  // ЗА МЕДЛЕННЫМ МЯЧОМ НЕ ПРЫГАЮТ (правило с 28.07.2026). Отдельный
  // предохранитель поверх расчёта шага: пока мяч ползёт, у вратаря есть время
  // ДОЙТИ, а бросок его только тратит — 0.55 с полёта плюс 0.8 с подъёма, и
  // всё это лёжа мимо мяча. Считаем по полному приставному ходу (stepSpeed):
  // на тихий мяч кипер и правда идёт нормально, а не «в стойке».
  if (shot.speed < K.collectSpeed &&
      need <= K.handReach + K.stepSpeed * Math.max(0, shot.t - K.react)) return step;

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

// ВЫХОД ЗА МЕДЛЕННЫМ МЯЧОМ (правило с 28.07.2026, фидбек Олега «еле катящиеся
// мячи издалека… тут его надо просто брать в руки»).
//
// Что было. Тихий мяч, идущий в створ, проходил у вратаря по общей ветке удара:
// он ждал его «в стойке» на дуге, а в последний миг объявлял оставшийся метр
// броском и падал мимо. Замер на стенде (мячи 3–8 м/с с 22–38 м): 11 голов из
// 27, и во ВСЕХ бросок стартовал за 0.5–1.7 с до прихода мяча — то есть кипер
// ложился на газон задолго до него.
//
// Что стало. Медленный низкий мяч — это не удар, а МЯЧ, КОТОРЫЙ ЗАБИРАЮТ.
// Кипер идёт НАВСТРЕЧУ и накрывает его в нескольких метрах перед линией: чем
// раньше мяч в руках, тем меньше поводов для рикошета и добивания. Условия
// узкие нарочно (тот же принцип, что у выхода на подачу): точка встречи — в
// СВОЕЙ штрафной, иначе руками играть нельзя, и соперник к ней не поспевает.
// Решение принимается один раз на этот полёт мяча (`collectSeq` = ball.seq) и
// дальше держится: перебили мяч — считаем заново, всё остальное время «вышел,
// доводи». Гаснет ветка сама, когда годной точки в зоне больше нет.
function tryCollect(p, dt, ball, match, gk, K, faceBall) {
  const team = p.team;
  const pos = p.group.position;
  const bp = ball.mesh.position;
  const goalX = team.ownGoalX;
  const seq = ball.seq || 0;
  // Приказ человека ведёт tryRush со своими правилами — двух ветвей выхода
  // одновременно быть не должно
  if (gk.orderT > 0) return false;
  // РЕШЕНИЕ ДЕРЖИТСЯ, ТОЧКА ПЕРЕСЧИТЫВАЕТСЯ — та же развилка, что у выхода на
  // подачу, и здесь она стоила голов. Мяч тормозится о газон, поэтому его
  // скорость ползёт мимо порога туда-обратно: замер дал «своя sp» 8.9 / 9.1 /
  // 8.9 при пороге 9.0, ветка мигала, и кипер вместо выхода топтался на месте,
  // а мяч забирал уже на ленточке (2 гола из 27 ровно на этом). Сказал «иду» —
  // идёт до конца; отменяет выход только смена траектории (рикошет тикает
  // ball.seq) или сам факт, что мяч больше не идёт в створ.
  const committed = gk.collectSeq === seq && gk.collectOn;
  if (!committed && bp.y > K.collectMaxY) return false;

  // МЯЧ ПОД ЧЬИМ-ТО КОНТРОЛЕМ — ЭТО УЖЕ НЕ ПОДБОР. У своего защитника вратарь
  // мяч не отнимает никогда; мяч, взятый соперником, — забота выхода 1в1
  // (tryRush), у которого своя стоп-дистанция и своя «звезда». Но уже начатый
  // выход так не отменяют — «вышел, доводи»: гасим его только когда гонка
  // проиграна начисто, то есть соперник и мячом владеет, и стоит к нему ближе.
  const owner = match.toucher;
  if (owner && owner !== p) {
    const mate = owner.team === team;
    const op = owner.group.position;
    const lost = Math.hypot(op.x - bp.x, op.z - bp.z) <
      Math.hypot(pos.x - bp.x, pos.z - bp.z) - K.handReach;
    if (mate || !committed || lost) { gk.collectOn = false; return false; }
  }

  // Самая ранняя точка траектории, до которой кипер успевает с запасом.
  //
  // ВЫШЕЛ — ДОВОДИ (правило с 29.07.2026). Раньше требование «успеваю» стояло и
  // на решении, и на КАЖДОМ последующем кадре, и достаточно было мячу разок
  // подпрыгнуть, чтобы кипер, уже убежавший с ленточки, объявил «не успеваю» и
  // побрёл домой — а мяч закатывался в пустые ворота у него за спиной. Замер
  // воронки (4 матча): три гола из восьми пришли ровно так, со скоростью мяча
  // 7.0–7.7 м/с, то есть на еле катящихся мячах. Решение принимается ОДИН раз
  // (strict), дальше цель считается без него: пусть кипер придёт на полшага
  // позже, чем хотел, — это всё равно лучше, чем не прийти вовсе.
  // СКОРОСТЬ СМОТРИМ В ТОЧКЕ ВСТРЕЧИ, А НЕ СЕЙЧАС И НЕ НА ЛИНИИ (правило с
  // 29.07.2026). Прежняя редакция брала её из `shot.speed`, то есть жила ВНУТРИ
  // ветки удара, — а «удар» у нас существует только для мяча, который дойдёт до
  // линии ворот. Мяч, тормозящий о газон, до неё чаще всего НЕ доходит: при
  // λ ≈ 0.72 1/с мяч, катящийся на 3 м/с, встаёт через 4.2 м. То есть самый
  // частый вид «еле катящегося мяча» — тот, что замирает в штрафной, — вратарь
  // не читал как удар и не забирал ВООБЩЕ: он ждал на дуге, пока к мячу добежит
  // нападающий (замер looseTest: 7 голов из 18). Теперь решение о подборе не
  // зависит от того, доедет ли мяч до ворот.
  const best = interceptPoint(pos, ball, K.lungeSpeed, K.readHorizon, {
    lead: K.collectOwnLead,
    strict: !committed,
    vel: p.vel,
    reach: K.handReach,
    accept: (x, y, z, t, sp) => y <= K.collectMaxY && inOwnBox(team, x, z) &&
      Math.abs(x - goalX) <= K.collectRange && (committed || sp <= K.collectSpeed),
  });
  if (!best) { if (!committed) gk.collectOn = false; return false; }

  if (!committed) {
    // Гонка честная в ОБЕ стороны: своё время — с разгоном и с учётом того, что
    // мяч берут РУКАМИ, чужое — по фактической скорости спринта (а не по
    // формуле без speedFactor, которая дарила сопернику лишние 6 %) и с
    // реакцией, если он на мяч ещё не бежит.
    const mine = reachTime(pos.x, pos.z, p.vel.x, p.vel.z, best.x, best.z,
      K.lungeSpeed, K.handReach);
    // ЗАПАС ЗАВИСИТ ОТ ЦЕНЫ НЕВЫХОДА (правило с 29.07.2026). Постоянные 0.30 с
    // читались как осторожность, а были слепотой: мяч, лежащий в семи метрах
    // от ворот, вратарь брал с честной форой 0.18 с — и не шёл, потому что до
    // 0.30 не дотягивал. Дальше форы становилось только меньше, и эпизод
    // кончался тем, что нападающий спокойно добегал и бил в стоящего на линии
    // кипера. Но у невыхода тоже есть цена, и у самой ленты она равна голу:
    // мяч в трёх метрах от ворот отдавать сопернику нельзя ни при каком
    // расчёте. Поэтому полный запас требуется на КРАЮ зоны сбора, а у ворот он
    // тает до нуля — ровно так и играют живые вратари.
    const dPoint = Math.hypot(best.x - goalX, best.z);
    const lead = K.collectLead * Math.max(0, Math.min(1, dPoint / K.collectRange));
    const theirs = foeReach(match, team, best.x, best.z);
    if (theirs < mine + lead) {
      gk.collectOn = false;
      return false;
    }
    // ВЫХОДЯТ ЗА МЯЧОМ, КОТОРЫЙ ИНАЧЕ ДОСТАНЕТСЯ СОПЕРНИКУ (правило с
    // 29.07.2026). Без этого условия кипер шёл подбирать ЛЮБОЙ тихий мяч в
    // штрафной — в том числе тот, который спокойно выносит свой защитник. В
    // футболе так не играют, и цена видна числом: ablation на автосимуляции
    // (по 4 матча, ветка выключается своим числом в конфиге) дал при жадном
    // сборе 0.5 гола за матч против 2.5 с выключенным — вратарь съедал не
    // моменты, а сами ПЕРЕДАЧИ, и точность паса падала с 46 % до 41 %.
    // Свой полевой успевает раньше соперника — мяч его, вратарь остаётся дома.
    if (sideReach(team.players, best.x, best.z, p) + K.collectMateLead < theirs) {
      gk.collectOn = false;
      return false;
    }
    gk.collectSeq = seq;
    gk.collectOn = true;
  }

  const mv = seek(pos.x, pos.z, best.x, best.z);
  p.aiUpdate(dt, mv, {
    face: faceBall,
    faceLock: true,
    speedCap: K.lungeSpeed,
  });
  gk.collecting = true;
  return true;
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

  // Приказ человека (W / Y) меняет ДВЕ вещи сразу: кипер бежит быстрее и не
  // требует запаса на свой приход. Расчёт «успею ли я» — это осторожность
  // движка, а человек её как раз и отменяет нажатием кнопки.
  const ordered = gk.orderT > 0;
  const goSpeed = ordered ? K.orderSpeed : K.lungeSpeed;
  const ownLead = ordered ? 0 : K.claimOwnLead;

  const committed = gk.claimSeq === seq && gk.claim;
  if (!committed) {
    // Подача — это ВЕРХОВОЙ мяч. Проверять «летит ли он к нашим воротам» по
    // знаку vel.x НЕЛЬЗЯ: настоящая подача с фланга идёт почти ВДОЛЬ лицевой
    // линии, у неё vel.x около нуля, и такая проверка отсекала бы ровно те
    // мячи, ради которых вратарь и выходит. Спрашиваем у траектории.
    if (bp.y < K.claimMinY && ball.vel.y < 1) return false;

    // САМАЯ РАННЯЯ точка траектории, до которой кипер успевает и где мяч ещё
    // в пределах вытянутых рук в прыжке. Раньше = выше над головами и дальше
    // от ворот — именно так и выходят на подачу. Запас на СВОЙ приход
    // обязателен: «успеваю ровно впритык» — это не выход, а подарок; по
    // приказу человека запаса нет (см. ownLead выше).
    const best = interceptPoint(pos, ball, goSpeed, K.readHorizon, {
      lead: ownLead,
      strict: true,
      vel: p.vel,
      reach: K.handReach,
      accept: (x, y, z) => y <= K.claimMaxY && y >= CONFIG.ball.radius * 2 &&
        Math.abs(x - goalX) <= K.claimZoneX && Math.abs(z) <= K.claimZoneZ,
    });
    if (!best) { gk.claimSeq = seq; gk.claim = null; return false; }

    // Соперники — да, свои — нет: на выходе вратарь хозяин штрафной и кричит
    // «моё!». Прежняя версия считала своих защитников конкурентами, а на
    // подаче они рядом всегда — потому выход и не случался НИ РАЗУ.
    // Обе стороны гонки считает одна модель (reachTime): разгон, реакция того,
    // кто ещё не бежит, и разная длина «дотягивания» — руки против бутсы.
    const theirs = foeReach(match, team, best.x, best.z);
    const mine = reachTime(pos.x, pos.z, p.vel.x, p.vel.z, best.x, best.z,
      goSpeed, K.handReach);
    // Приказ человека (W / Y) отменяет расчёт: решил выходить — выходим,
    // и промах становится ЕГО ошибкой. Ровно так это работает в FIFA/FC.
    if (!ordered && mine > theirs - K.claimLead) {
      gk.claimSeq = seq; gk.claim = null; return false;
    }
    gk.claimSeq = seq;
    gk.claim = best;
    gk.claimStart = best.d;
    // Толпа в точке — играем КУЛАКОМ: ловить мяч в сутолоке нельзя
    let crowd = 0;
    for (const o of match.otherTeam(team).players) {
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
  //
  // И ЦЕЛЬ ЭТА — ТОЧКА ПЕРЕХВАТА, А НЕ ПЕРВАЯ ГОДНАЯ ТОЧКА ТРАЕКТОРИИ (правило
  // с 29.07.2026). Здесь была вторая половина жалобы «выходит, но мяч не
  // перехватывает»: цель бралась как первый же кадр полёта в пределах зоны, то
  // есть практически ТЕКУЩАЯ позиция мяча. Вратарь бежал за тенью и приезжал
  // туда, откуда мяч уже ушёл. Замер (навес с фланга, приказ зажат): ближе
  // всего он оказывался в 1.24 м при вытянутой руке 0.95 — не хватало ровно
  // тридцати сантиметров, и так на каждой подаче.
  const land = interceptPoint(pos, ball, goSpeed, K.readHorizon, {
    accept: (x, y, z) => y <= K.claimMaxY && y >= CONFIG.ball.radius * 2 &&
      Math.abs(x - goalX) <= K.claimZoneX + 2 && Math.abs(z) <= K.claimZoneZ + 2,
  });
  // Мяча в воздухе больше нет (сбит, принят, укатился) — выход окончен.
  // Если вратарь при этом уже бежал и мяч ушёл далеко — это ФЛАП, и он обязан
  // быть ВИДЕН: кипер хватает воздух (gk_miss). Молча развернуться и потрусить
  // назад — значит спрятать собственную ошибку, а в трансляции 98-го такие
  // моменты как раз и крутили в повторе.
  if (!land || (ball.seq || 0) !== seq) {
    const far = Math.hypot(bp.x - pos.x, bp.z - pos.z);
    if (gk.claim && far > K.punchRadius && p.diveT <= 0 && p.downT <= 0) {
      p.playOneShot('gk_miss', 1.5, 0.3);
    }
    gk.claim = null;
    return false;
  }
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
  p.aiUpdate(dt, mv, {
    sprint: true,
    face: faceBall,
    // На коротком выходе кипер идёт лицом к мячу, на длинном честно бежит
    faceLock: dLand < 3.5,
    speedCap: goSpeed,
  });
  gk.rushing = true;
  return true;
}

// ТОЧКА ПЕРЕХВАТА, А НЕ ТЕНЬ МЯЧА (правило с 29.07.2026).
//
// Жалоба Олега: «зажимаешь кнопку выхода — он выходит, но мяч не перехватывает,
// что делает выход бесполезным». Причина была в одной строке: приказ вёл кипера
// в `seek(pos, ball.x, ball.z)` — на ТЕКУЩУЮ позицию мяча. Это погоня за
// хвостом: пока вратарь добежит, мяч уже в другом месте, и на летящем мяче он
// не сходится с ним НИКОГДА. Верно другое — бежать туда, где мяч БУДЕТ.
//
// Берём САМУЮ РАННЮЮ точку траектории, до которой успеваем (раньше = дальше от
// ворот и выше над головами — ровно так и выходят), а если не успеваем никуда,
// бежим в точку наименьшего опоздания: приказ есть приказ, и промах по нему —
// осознанная ошибка человека, а не отказ движка выполнять команду.
// accept — фильтр допустимой точки (зона выхода, высота приёма);
// lead — запас на свой приход; strict — «нет точки, куда успеваю» вернуть null,
// а не гнаться за недостижимой (так решается «идти или не идти»).
function interceptPoint(pos, ball, speed, horizon, opts = {}) {
  const accept = opts.accept || null;
  const lead = opts.lead || 0;
  const vel = opts.vel || null;
  const reach = opts.reach || 0;
  let best = null;
  let fallback = null;
  let bestLack = Infinity;
  flightPath(ball, (x, y, z, t, sp) => {
    if (accept && !accept(x, y, z, t, sp)) return false;
    const d = Math.hypot(x - pos.x, z - pos.z);
    const mine = vel
      ? reachTime(pos.x, pos.z, vel.x, vel.z, x, z, speed, reach)
      : d / Math.max(0.5, speed);
    const lack = mine + lead - t;                      // > 0 — опаздываю
    if (lack <= 0) { best = { x, y, z, t, d, sp }; return true; }
    if (lack < bestLack) { bestLack = lack; fallback = { x, y, z, t, d, sp }; }
    return false;
  }, horizon);
  if (best) return best;
  if (opts.strict) return null;
  if (fallback) return fallback;
  const bp = ball.mesh.position;
  return {
    x: bp.x, y: bp.y, z: bp.z, t: 0, sp: ball.vel.length(),
    d: Math.hypot(bp.x - pos.x, bp.z - pos.z),
  };
}

// ВРЕМЯ ВЫХОДА НА ТОЧКУ — ТА ЖЕ ФОРМУЛА, ПО КОТОРОЙ ЖИВЁТ ДВИЖОК (правило с
// 29.07.2026). Все решения вратаря о выходе — это сравнение «успею ли я раньше
// соперника», и раньше обе стороны считались наивным `дистанция / скорость`.
// Замер разгона (aiUpdate гонит скорость к пределу экспонентой с CONFIG.player
// .accel = 10 1/с): полевой на спринте проходит 10 м за 1.27 с, вратарь — за
// 1.65, а наивная формула обещает 1.09 и 1.56. Ошибка невелика сама по себе,
// но она РАЗНАЯ у быстрого и медленного, то есть систематически дарит фору
// сопернику — как раз в те доли секунды, которыми решение и определяется.
// Интеграл экспоненты даёт точный ответ: s = v·t − (v − v0)/a, отсюда
//   t = d/v + (1 − v0∥/v)/a.
// Проверка: 10/8.63 + 0.1 = 1.26 против замеренных 1.27; 10/6.4 + 0.1 = 1.66
// против 1.65.
//
// reach — то, чем игрок ДОТЯГИВАЕТСЯ до мяча (у вратаря руки, у полевого
// радиус подбора): сравнивать надо приход НОГИ и приход РУКИ, а не центров.
// react начисляется только тому, кто на мяч ещё не бежит: нападающий, уже
// летящий к мячу, реакцию потратил, а стоящий — нет.
function reachTime(px, pz, vx, vz, tx, tz, vmax, reach = 0, react = 0) {
  const dx = tx - px;
  const dz = tz - pz;
  const raw = Math.hypot(dx, dz);
  const d = Math.max(0, raw - reach);
  if (d <= 0.001) return 0;
  const along = raw > 1e-4 ? (vx * dx + vz * dz) / raw : 0;
  const v = Math.max(0.5, vmax);
  const lag = Math.max(0, 1 - Math.max(0, along) / v) / CONFIG.player.accel;
  return d / v + lag + (along > 1 ? 0 : react);
}

// Через сколько ближайший игрок команды сыграет мяч в этой точке.
// Соперников считаем всегда — это гонка; своих только там, где надо ответить
// «а справится ли защита без меня». В самой гонке свои не участвуют: на выходе
// вратарь хозяин штрафной и кричит «моё!» (то же правило, что в tryClaim).
function sideReach(players, x, z, skip = null) {
  const P = CONFIG.player;
  const sprint = P.speed * CONFIG.ai.speedFactor * P.sprintFactor;
  const react = CONFIG.ai.passModel.oppReact;
  let best = Infinity;
  for (const o of players) {
    if (o === skip || o.isKeeper) continue;
    if (o.downT > 0 || o.tackleT > 0) continue;   // лежащий в гонке не участвует
    const op = o.group.position;
    best = Math.min(best,
      reachTime(op.x, op.z, o.vel.x, o.vel.z, x, z, sprint, P.controlRadius, react));
  }
  return best;
}

function foeReach(match, team, x, z) {
  return sideReach(match.otherTeam(team).players, x, z);
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
    const aim = interceptPoint(pos, ball, K.orderSpeed, K.readHorizon);
    const dAim = Math.hypot(aim.x - pos.x, aim.z - pos.z);
    // Мяч встречается выше вытянутых рук — ВЫПРЫГИВАЕМ под него, как на
    // подаче. Без этого приказ на навес был заведомо мёртвым: кипер приходил
    // под мяч и стоял, а мяч проходил над ним (замер orderTest: подошёл на
    // 1.24 м при вытянутой руке 0.95 — не хватило тридцати сантиметров).
    if (aim.y > K.claimJumpFrom && p.jumpT <= 0 && dAim < 1.8 && aim.t < 0.5) {
      p.startJump(Math.max(0.08, aim.t),
        Math.min(0.5, aim.y - K.claimJumpFrom + 0.12));
      p.playOneShot('gk_catch', 1.3, 0.15);
    }
    const mv = seek(pos.x, pos.z, aim.x, aim.z);
    p.aiUpdate(dt, mv, {
      sprint: true,
      face: faceBall,
      faceLock: Math.hypot(bp.x - pos.x, bp.z - pos.z) < 3.5,
      speedCap: K.orderSpeed,
    });
    gk.rushing = true;
    return true;
  }

  // (1) Свободный мяч за спиной защиты — подчистить (свипер).
  // ЦЕЛЬ — ТОЧКА ПЕРЕХВАТА, А НЕ ТЕНЬ МЯЧА (правило с 29.07.2026, третий случай
  // одной и той же грабли — до этого на ней спотыкались приказ «на выход» и
  // сам tryClaim). Свипер бежал в `bp.x, bp.z`, то есть туда, где мяч СЕЙЧАС;
  // на катящемся мяче это погоня за хвостом, и гонку он вдобавок считал по той
  // же уходящей точке. Обе стороны теперь считаются моделью reachTime.
  if ((!owner || owner === p) && dGoal < K.sweepRange && bp.y < 1.2) {
    const aim = interceptPoint(pos, ball, K.lungeSpeed, K.readHorizon, {
      vel: p.vel,
      reach: K.handReach,
    });
    const mine = reachTime(pos.x, pos.z, p.vel.x, p.vel.z, aim.x, aim.z,
      K.lungeSpeed, K.handReach);
    if (mine < foeReach(match, team, aim.x, aim.z) - K.sweepMargin) {
      const mv = seek(pos.x, pos.z, aim.x, aim.z);
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
      // Дальше сработает обычная проверка контакта (мяч влетит в зону рук).
      // Клип здесь СВОЙ: раньше играл боковой бросок, и вратарь в момент
      // выхода один на один валился вбок от мяча, летящего ему в живот.
      if (!gk.diving) {
        p.startKeeperDive(team.side, 0, {
          dur: K.diveTime * 0.7,
          speed: K.lungeSpeed * 0.5,
          recover: K.recover,
          clip: 'gk_block',
          face: Math.atan2(bp.x - pos.x, bp.z - pos.z),
        });
        gk.diving = true;
      }
      return true;
    }
  }
  return false;
}
