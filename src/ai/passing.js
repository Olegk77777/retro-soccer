// ПАС В ЗОНУ — мяч летит не в игрока, а в ТОЧКУ, куда игрок добежит.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ (правило с 28.07.2026). Просьба Олега: «пасы в
// прострел и такие закиды должны работать как пас на перспективу, когда ты
// догадываешься, что футболист туда забежит, а не тогда, когда он уже там».
// До этой правки пас на ход отличался от обычного РОВНО ОДНИМ числом —
// упреждением 1.5 против 0.8 доли времени полёта. Замер по двум матчам
// автосимуляции: AI выбирал вариант `through` в 55 % случаев, и средняя
// дистанция доставки у него была 20.1 м против 19.9 м у паса в ноги. То есть
// «пас на ход» и «пас в ноги» были одним и тем же пасом с разными подписями.
//
// РАЗВИЛКА КАНОНИЧНАЯ: в PES это ⨯ против △, в FIFA — прицел В адресата против
// прицела ПЕРЕД ним. У нас S — пас в ноги, W — пас в зону, Q+W — заброс в зону.
//
// ПОЧЕМУ НЕЛЬЗЯ ПРОСТО УМНОЖИТЬ УПРЕЖДЕНИЕ. Экстраполяция скорости адресата
// (так делает FIFA) вырождается на СТОЯЩЕМ партнёре: вектор нулевой, и пас на
// ход превращается в пас в ноги — EA это признаёт прямым текстом («if they
// remain stationary, these techniques will not work»). А просили ровно
// обратного: бросить мяч в пространство ПЕРВЫМ, и партнёр побежит туда уже
// под отданный пас. Поэтому направление выноса у стоящего партнёра берётся не
// из его скорости, а из НАМЕРЕНИЯ ЧЕЛОВЕКА (стик) и стороны атаки.
//
// ТРИ ЗАИМСТВОВАНИЯ, каждое проверено в источнике:
//  · Полоска = ДАЛЬНОСТЬ ВЫНОСА (EA FC Precision Pass: «the longer you hold
//    down the pass, the further the ball will be placed in front of the
//    receiver»). Отсюда весь спектр, который просил Олег: тап — лёгкий накат
//    рядом стоящему, полный замах — сильный бросок на забег.
//  · Веер кандидатов из ТРЁХ точек — вынос по бегу плюс две касательные к
//    кругу досягаемости (Buckland, Simple Soccer, GetBestPassToReceiver).
//    Касательные и есть «на ход слева» и «на ход справа», то есть разрез.
//  · Pass Openness (FIFA 21): точка сдвигается ПРОЧЬ от ближайшего соперника —
//    «leading the receiver away from opponents». Дешевле любой умной модели и
//    даёт ровно ощущение паса плеймейкера, а не паса по геометрии.
//
// СВОБОДА ЧЕЛОВЕКА НЕ ОТНИМАЕТСЯ. Решатель возвращает null, если под стик
// ничего разумного не нашлось, — и тогда мяч летит строго как нарисован, с
// силой полоски. Помощь тут не «доворачивает мяч в партнёра», а ВЫБИРАЕТ ТОЧКУ
// в секторе, который человек уже указал: направление и дальность заданы им.

import { CONFIG } from '../config.js';
import {
  passPower, passTime, ROLL_LAMBDA, xThreat, freeSpace, loftPower,
} from './steering.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

// Логистика вокруг нуля — та же форма, что в passComplete: мягкая граница
// вместо жёсткого порога, поэтому пас на грани иногда доходит, а иногда нет.
function logistic(x, k) {
  return 1 / (1 + Math.exp(-k * x));
}

// Скорость, с которой игрок реально доберётся до точки (спринт с гандикапом AI)
function runSpeedOf(p) {
  const P = CONFIG.player;
  const human = p.team && p.team.match && p.team.match.controlled === p;
  return P.speed * P.sprintFactor * (human ? 1 : CONFIG.ai.speedFactor);
}

// Время прихода игрока в точку: реакция + бег по прямой. Модель Spearman в
// упрощении (без инерции) — нам хватает, шаг сетки у нас метровый.
function timeTo(p, x, z, react) {
  const pp = p.group.position;
  return react + Math.hypot(x - pp.x, z - pp.z) / runSpeedOf(p);
}

// Свободна ли линия паса — нужна забросу: «Lob passes will have more driven
// trajectories when the path is unobstructed» (EA FC 26). Свеча там, где
// перебрасывать некого, читается ошибкой, а не решением.
function laneClear(fromX, fromZ, toX, toZ, opponents, width) {
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  const len2 = dx * dx + dz * dz || 1;
  for (const o of opponents) {
    if (o.isKeeper) continue;
    const op = o.group.position;
    let t = ((op.x - fromX) * dx + (op.z - fromZ) * dz) / len2;
    if (t <= 0.05 || t >= 0.95) continue;
    const cx = fromX + dx * t;
    const cz = fromZ + dz * t;
    if (Math.hypot(op.x - cx, op.z - cz) < width) return false;
  }
  return true;
}

// Увести точку ПРОЧЬ от ближайшего соперника (Pass Openness). Сдвиг идёт
// ПОПЕРЁК линии выноса: вдоль неё двигать нельзя — там сидит заказанная
// человеком дальность, и сдвиг сломал бы связку «полоска = дальность».
function openUp(tx, tz, ux, uz, opponents) {
  const SP = CONFIG.ai.humanPass.space;
  let best = null;
  let bd = Infinity;
  for (const o of opponents) {
    if (o.isKeeper) continue;
    const op = o.group.position;
    const d = Math.hypot(op.x - tx, op.z - tz);
    if (d < bd) { bd = d; best = op; }
  }
  if (!best || bd > SP.openRange || bd < 0.05) return { x: tx, z: tz };
  // Перпендикуляр к линии выноса, направленный ОТ соперника
  const px = -uz;
  const pz = ux;
  const side = ((tx - best.x) * px + (tz - best.z) * pz) >= 0 ? 1 : -1;
  const k = SP.openShift * (1 - bd / SP.openRange);
  return { x: tx + px * side * k, z: tz + pz * side * k };
}

// Направление выноса для конкретного партнёра. Бежит — по его бегу; стоит —
// по намерению человека, смешанному со стороной атаки. Это и есть «пас на
// перспективу»: точка выбирается ДО того, как партнёр туда побежал.
function runDirOf(mate, aim, side) {
  const rs = Math.hypot(mate.vel.x, mate.vel.z);
  if (rs > 1.5) return { x: mate.vel.x / rs, z: mate.vel.z / rs };
  let rx = (aim ? aim.x : 0) * 0.55 + side * 0.45;
  let rz = (aim ? aim.z : 0) * 0.55;
  const l = Math.hypot(rx, rz) || 1;
  return { x: rx / l, z: rz / l };
}

/**
 * Найти лучший пас В ЗОНУ.
 * @param passer   кто отдаёт
 * @param opts {aim:{x,z}|null, charge:0.15..1.3, lob:boolean, level:0..1}
 * @returns {mate, target:{x,z}, dir:{x,z}, power, lift, flight, lead, score} | null
 */
export function solveSpacePass(passer, opts = {}) {
  const team = passer.team;
  if (!team) return null;
  const AI = CONFIG.ai;
  const HP = AI.humanPass;
  const SP = HP.space;
  const AS = HP.assist;
  const PM = AI.passModel;
  const P = CONFIG.player;
  const F = CONFIG.field;
  const B = CONFIG.ball;
  const pos = passer.group.position;
  const opponents = team.opponents;
  const side = team.side;
  const lob = !!opts.lob;

  const charge = opts.charge != null ? opts.charge : 0.6;
  const charge01 = clamp((Math.min(charge, 1) - 0.15) / 0.85, 0, 1);
  // ПОЛОСКА = ДАЛЬНОСТЬ ВЫНОСА. Заброс кладётся дальше: он дольше в воздухе,
  // и адресат успевает разогнаться под него сильнее
  const wantLead = lerp(SP.leadNear, SP.leadFar, charge01) * (lob ? SP.lobLeadK : 1);
  // …и она же выбирает АДРЕСАТА: тап — ближний, полный замах — дальний
  const wantDist = lerp(SP.distNear, SP.distFar, charge01);
  const arrive = lerp(AI.passArriveSoft, AI.passArriveDriven, charge01);
  // ПОТОЛОК СИЛЫ ОТ ПОЛОСКИ — то, что делает связку честной. Точка доставки
  // считается баллистикой, но СИЛЬНЕЕ, чем задал человек, игра бить не имеет
  // права: иначе чистый тап уносил мяч дальнему партнёру за 31 метр на 28.8 м/с
  // (замер на синтетической расстановке до правки). Мяч, пущенный со скоростью
  // v0, прокатится не дальше v0/λ — отсюда и вся шкала: тап достаёт метров на
  // 18, полный замах — почти через всё поле. Свобода «с любой силой» при этом
  // не отнята, а наоборот стала физической: полоска и есть сила.
  const capBase = lob
    ? lerp(P.lob.powerNear, P.lob.powerMax, charge01)
    : lerp(P.through.powerMin, P.through.powerMax, Math.min(1, charge));
  const powerCap = capBase * (charge > 1 ? 1 + (charge - 1) * CONFIG.cross.overPower : 1);

  const aim = opts.aim && Math.hypot(opts.aim.x, opts.aim.z) > 0.1
    ? { x: opts.aim.x, z: opts.aim.z } : null;
  // Ворота адресата в конусе ищем ШИРЕ, чем целятся: точка лежит ВПЕРЕДИ
  // партнёра, и сам он вполне может стоять за краем конуса. Прицел
  // отрабатывается ниже, на самих точках, — так намерение человека уважается
  // (FC 26: «Through Passes are now more respectful of your aim input»)
  const level = opts.level != null ? opts.level : AS.level;
  const gateCos = (AS.coneBase - level * AS.coneWiden) - 0.30;

  const oppGoalX = team.attackGoalX;
  const keeper = opponents.find((o) => o.isKeeper) || null;
  const xtFrom = xThreat(pos.x, pos.z, side);
  const fan = (SP.fanDeg * Math.PI) / 180;

  let best = null;

  for (const mate of team.players) {
    if (mate === passer || mate.isKeeper) continue;
    if (mate.downT > 0 || mate.tackleT > 0) continue;
    const mp = mate.group.position;
    const dm = Math.hypot(mp.x - pos.x, mp.z - pos.z);
    if (dm < HP.minDist || dm > HP.maxDist) continue;
    if (aim) {
      const c = ((mp.x - pos.x) * aim.x + (mp.z - pos.z) * aim.z) / dm;
      if (c < gateCos) continue;
    }

    const rd = runDirOf(mate, aim, side);
    // Круг досягаемости адресата (Buckland): за время полёта он успевает
    // пробежать v·t, но не по идеальной прямой и не с места — отсюда reachK
    const leads = [wantLead, Math.max(SP.minLead, wantLead * 0.45)];
    for (const lead of leads) {
      for (const a of [-fan, 0, fan]) {
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const ux = rd.x * ca - rd.z * sa;
        const uz = rd.x * sa + rd.z * ca;
        let tx = mp.x + ux * lead;
        let tz = mp.z + uz * lead;
        const op2 = openUp(tx, tz, ux, uz, opponents);
        tx = op2.x;
        tz = op2.z;
        if (Math.abs(tx) > F.length / 2 - 1.5 || Math.abs(tz) > F.width / 2 - 1.5) continue;
        // ЗАБРОС НЕ КЛАДЁТСЯ В РУКИ ВРАТАРЮ: мяч, падающий у самой лицевой,
        // всегда достаётся киперу — и заброс читается подарком, а не решением
        if (lob && Math.abs(oppGoalX - tx) < P.lob.keeperKeep) continue;

        const dist = Math.hypot(tx - pos.x, tz - pos.z);
        if (dist < 3) continue;

        let power;
        let lift;
        let flight;
        if (lob) {
          const L = P.lob;
          // Путь свободен — траектория настильнее (FC 26)
          const clear = laneClear(pos.x, pos.z, tx, tz, opponents, L.clearLane);
          const near = clamp((dist - 10) / 22, 0, 1);
          const deg = clear ? L.angleClear : lerp(L.angleNear, L.angleFar, near);
          const theta = (deg * Math.PI) / 180;
          power = loftPower(dist, theta, B.radius, L.powerFloor, L.powerMax);
          if (power >= L.powerMax - 0.05) continue; // не долетает — не наш вариант
          if (power > powerCap) continue;           // сильнее, чем задал человек
          lift = power * Math.tan(theta);
          flight = (2 * lift) / -B.gravity;
        } else {
          power = passPower(dist, arrive);
          // ДОСТИЖИМОСТЬ ПРОВЕРЯЕТСЯ ЧЕСТНО. Мяч, пущенный со скоростью v0,
          // прокатится не дальше v0/λ — и цель за этой границей физически
          // недостижима. У AI такой проверки не было: замер на двух матчах
          // поймал 1.7 % выбранных пасов с целью ДАЛЬШЕ предела (медиана
          // недолёта 7.2 м, максимум 23.2), причём качество приёма у них
          // выходило МАКСИМАЛЬНЫМ — приходящая скорость считалась нулевой
          if (power > powerCap) continue;   // сильнее, чем задал человек полоской
          power = Math.max(P.through.powerMin, power);
          if (dist > (power / ROLL_LAMBDA) * 0.98) continue;
          flight = passTime(dist, power);
          if (!isFinite(flight)) continue;
          lift = P.through.lift;
        }

        // --- Успеет ли АДРЕСАТ? ---
        const tMate = timeTo(mate, tx, tz, SP.reactTime);
        if (tMate > flight + SP.maxWait) continue; // мяч уедет и умрёт в поле
        // --- Успеет ли соперник раньше? ---
        let tOpp = Infinity;
        for (const o of opponents) {
          if (o.isKeeper || o.downT > 0 || o.tackleT > 0) continue;
          tOpp = Math.min(tOpp, timeTo(o, tx, tz, SP.reactTime));
        }
        // Вратарь считается отдельно и только для заброса: низовой пас он
        // подбирает лишь у самой штрафной, а верховой забирает с выхода
        if (lob && keeper) {
          const tk = timeTo(keeper, tx, tz, SP.reactTime);
          if (tk < tMate + P.lob.keeperLead) continue;
        }
        const race = logistic(tOpp - tMate - SP.leadMargin, PM.interceptK * 0.5);
        if (race < 0.05) continue;

        // --- Общая модель ценности (та же, что у тренера): S = P^safety·Q·V·F ---
        const pc = team.passComplete(pos.x, pos.z, tx, tz, power, opponents,
          PM.pressBonus);
        if (pc <= 0.01) continue;
        const spaceQ = 0.55 + 0.45 * freeSpace(tx, tz, opponents);
        const dxt = xThreat(tx, tz, side) - xtFrom;
        const v = clamp(1 + PM.valueK * dxt, PM.valueMin, PM.valueMax);
        const oppLine = team.match.otherTeam(team).defLineX;
        const behind = side * (tx - oppLine) > 0;
        let f = behind ? PM.fThrough : PM.fProgress;
        if (side * (tx - pos.x) < 0) f = PM.fNormal * 0.6; // назад — не наш жанр
        // Намерение человека: точка по стику ценится выше «объективно лучшей»
        // в стороне. Экспонента, а не линейка: в самом конусе почти не давит,
        // а за его краем гасит вариант быстро
        let aimK = 1;
        if (aim) {
          const c = ((tx - pos.x) * aim.x + (tz - pos.z) * aim.z) / dist;
          aimK = Math.exp(SP.aimWeight * (Math.min(1, c) - 1));
        }
        // И заказанная полоской дальность — по обеим шкалам сразу: насколько
        // далеко вперёд вынесен мяч (lead) и как далеко он вообще летит (dist)
        const wantK = Math.exp(-SP.wantWeight * Math.abs(lead - wantLead)) *
          Math.exp(-SP.distWeight * Math.abs(dist - wantDist));

        const score = Math.pow(pc, PM.safety) * race * spaceQ * v * f * aimK * wantK;
        if (!best || score > best.score) {
          const nx = (tx - pos.x) / dist;
          const nz = (tz - pos.z) / dist;
          best = {
            mate, score, power, lift, flight, lead, lob,
            target: { x: tx, z: tz },
            dir: { x: nx, z: nz },
            wait: Math.max(0, tMate - flight),
          };
        }
      }
    }
  }
  return best;
}
