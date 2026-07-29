// Стенд ВРАТАРЯ: числовые эталоны игры кипера (правило проекта — «у каждого
// эффекта должен быть записанный ЧИСЛОВОЙ эталон, иначе после любой правки его
// молча потеряют, а на глаз это читается расплывчатым „стало плохо“»).
//
// Как запустить (консоль браузера на открытой игре):
//   const gk = await import('./tools/gk-rig.js');
//   await gk.runGk({ matches: 4 });     // разворот, выходы + ВОРОНКА ПРИЧИН
//   gk.throughTest();                   // мяч идёт прямо в вратаря: сыграет?
//   gk.orderTest();                     // приказ «на выход» (W / Y): перехватит?
//   gk.rollTest();                      // еле катящийся мяч издалека
//   gk.looseTest();                     // свободный мяч у штрафной ПРОТИВ нападающего
//   gk.lobTest();                       // навесной удар издалека: перебрасывают?
//   gk.lobTrace({ d: 30, wantY: 1.4 }); // покадровый разбор одного навеса
//   gk.netTest();                       // фантомные голы сквозь сетку
//
// ЭТАЛОНЫ СБОРКИ (29.07.2026, сессия 59):
//   throughTest — 13 голов из 36 (свежий 3/9 · лежит 4/9 · бросок 3/9 · кулдаун 3/9)
//   orderTest   — 5 из 5 «в руках» (без приказа 2 из 5)
//   rollTest    — 0 голов из 27, НИ ОДНОГО броска
//   looseTest   — 0…3 гола из 18, забрано 15–18 (сам стенд шумит на ±2: в нём
//                 живут и ошибка чтения удара, и решения AI нападающего). До
//                 правки — 7 голов, забрано 11, и «вышел на» 1.2 м, то есть
//                 кипер не сходил со стартовой точки ВООБЩЕ
//   runGk       — воронка 4 матчей: сквозь вратаря 22 % (было 36 %),
//                 «ушёл с линии» НОЛЬ, выходы на 20–22 % подач в штрафную
//   lobTest     — 10…15 голов из 40, и это НЕ регрессия: очная ставка со сборкой
//                 до правки (git archive в подпапку, тот же сервер) дала там
//                 13/11/9 — стенд шумит из-за gauss()-ошибки чтения удара и
//                 разницу меньше пяти голов на сорока попытках НЕ РАЗРЕШАЕТ.
//                 Прежняя запись «8 из 40» была удачным прогоном, а не эталоном
//   netTest     — 2 фантомных на 1500 выстрелов
//   баланс (tools/sim.js) — 1.0 / 1.625 / 1.875 гола за матч на трёх выборках
//                 по 8 матчей; до правки вратаря 2.25 и 3.0. Разница ≈ гол за
//                 матч и она НАМЕРЕННАЯ: столько стоили дешёвые пропущенные
//
// Стенд НИЧЕГО не оставляет сломанным: все патчи снимаются в finally.

import { updateKeeper } from '../src/ai/goalkeeper.js';
import { predictGoalPlane } from '../src/ai/steering.js';

const FRAME = 1 / 60;

// ===== 1. Прогон матчей с замером по вратарям =====

function newGkProbe() {
  return {
    frames: 0,          // кадров живой игры
    nearFrames: 0,      // ...когда мяч в СВОЕЙ трети (кипер обязан работать)
    backToBall: 0,      // ...и при этом кипер повёрнут спиной (> 90° от мяча)
    wideAngle: 0,       // ...и повёрнут больше чем на 60°
    angleSum: 0,        // сумма |угла| до мяча — для средней
    crosses: 0,         // верховых мячей, влетевших в свою штрафную
    claims: 0,          // ...из них кипер вышел (gk.claim/gk.rushing)
    dives: 0,           // бросков
    conceded: 0,        // пропущено
    concededNoRead: 0,  // ...из них удар вообще не был прочитан как удар
    concededNoAct: 0,   // ...из них кипер не бросился и не переступил
    lastSeen: null,
    snap: null,         // последний снимок «мяч летит в створ» — для воронки
    misses: [],         // разбор КАЖДОГО пропущенного мяча (см. snapshot)
  };
}

// СНИМОК СИТУАЦИИ «мяч идёт в створ». Пишется каждый кадр, пока прогноз видит
// мяч на линии, и читается в момент гола: только так можно узнать, ЧТО кипер
// делал за миг до пропущенного, — после гола состояние уже сброшено.
function snapshot(k, cross, bp, goalX) {
  const kp = k.group.position;
  const g = k.gk || {};
  let act = 'стоял';
  if (k.downT > 0) act = 'лежал';
  else if (k.diveT > 0) act = 'бросок';
  else if (g.collecting) act = 'выход за мячом';
  else if (g.retreating) act = 'пятился';
  else if (g.rushing) act = 'выход';
  else if (k.jumpT > 0) act = 'прыжок';
  else if (Math.hypot(k.vel.x, k.vel.z) > 0.7) act = 'шаг';
  return {
    act,
    speed: +cross.speed.toFixed(1),      // скорость мяча НА ЛИНИИ
    z: +cross.z.toFixed(2),              // куда по створу
    y: +cross.y.toFixed(2),              // и по высоте
    t: +cross.t.toFixed(2),              // сколько ему ещё лететь
    kz: +kp.z.toFixed(2),                // где стоит кипер вдоль ворот
    depth: +Math.abs(kp.x - goalX).toFixed(2), // и в скольких метрах от ленты
    dz: +Math.abs(cross.z - kp.z).toFixed(2),  // промах по створу
    react: +(g.reactLeft || 0).toFixed(2),
    read: !!g.shotLive,
    // Кулдауны — отдельная и НЕОЧЕВИДНАЯ причина «не сыграл». Пока идёт
    // антидребезг после своего же отбоя, вратарь мяч не видит вовсе
    saveCd: +(g.saveCd || 0).toFixed(2),
    kickCd: +(k.kickCooldown || 0).toFixed(2),
    лежитЕщё: +(k.downT || 0).toFixed(2),
  };
}

// Куда именно прошёл мяч мимо вратаря. Категория важнее счёта: «не дотянулся
// вбок» лечится броском, «прошёл через него» — контактом, «пустые ворота» —
// позицией. Три разных бага дают один и тот же счёт на табло.
function missKind(s, K, G) {
  if (!s) return 'не прочитал';
  if (s.act === 'выход' || s.act === 'выход за мячом') return 'ушёл с линии';
  if (s.y > K.diveMaxY) return 'ПЕРЕКИНУЛИ (выше рук)';
  if (s.dz < K.handReach + 0.25) return 'СКВОЗЬ ВРАТАРЯ (был на линии мяча)';
  if (s.dz < K.handReach + K.diveSpeed * K.diveTime) return 'не дотянулся в броске';
  return 'угол (недосягаем)';
}

export async function runGk(opts = {}) {
  const matches = opts.matches != null ? opts.matches : 2;
  const chunk = opts.chunk != null ? opts.chunk : 5400;
  const DBG = window.DBG;
  if (!DBG || !DBG.match) throw new Error('Матч ещё не загрузился');
  const { match, ball, goals, CONFIG } = DBG;
  const F = CONFIG.field;
  const G = CONFIG.goal;

  const saved = {
    setControlled: match.setControlled,
    updateSwitching: match.updateSwitching,
    startIntro: match.startIntro,
    startReplay: match.startReplay,
    humanTeam: match.humanTeam,
    resetDelay: CONFIG.goal.resetDelay,
    celebTime: CONFIG.celebration.time,
    controlled: match.controlled,
    onGoal: match.onGoal,
  };
  const origRAF = window.requestAnimationFrame.bind(window);
  let pendingFrame = null;
  window.requestAnimationFrame = (cb) => { pendingFrame = cb; return 0; };

  const probes = [newGkProbe(), newGkProbe()];
  let score = [0, 0];

  try {
    match.setControlled = function () { this.controlled = null; };
    match.updateSwitching = function () { this.input.consumeSwitch(); };
    match.controlled = null;
    match.humanTeam = { players: [], fieldPlayers: [], receiver: null, receiveTimer: 0 };
    match.startIntro = function () { this.state = 'kickoff'; this.stateTimer = 0; };
    match.startReplay = function () { return false; };
    CONFIG.goal.resetDelay = 0.2;
    CONFIG.celebration.time = 0.1;

    // Гол: чей вратарь пропустил и что он в этот момент делал
    match.onGoal = function (...args) {
      const bp = ball.mesh.position;
      const sx = Math.sign(bp.x);
      const conceding = this.teams.find((t) => Math.sign(t.ownGoalX) === sx);
      if (conceding) {
        const i = this.teams.indexOf(conceding);
        const k = conceding.keeper;
        probes[i].conceded++;
        const g = k.gk || {};
        if (!g.shotLive) probes[i].concededNoRead++;
        if (!g.diving && k.diveT <= 0 && k.downT <= 0) probes[i].concededNoAct++;
        const s = probes[i].snap;
        probes[i].misses.push({
          команда: i,
          причина: missKind(s, CONFIG.ai.keeper, CONFIG.goal),
          ...(s || {}),
        });
        probes[i].snap = null;
      }
      return saved.onGoal.apply(this, args);
    };

    match.score = [0, 0];
    match.clock = 0;
    match.kickoff(0);
    match.state = 'kickoff';
    match.stateTimer = 0;

    for (let m = 0; m < matches; m++) {
      let frames = 0;
      const limit = Math.ceil(CONFIG.match.realMinutes * 60 * 60 * 1.15);
      while (match.state !== 'fulltime' && frames < limit) {
        for (let n = 0; n < chunk && match.state !== 'fulltime' && frames < limit; n++) {
          step(match, ball, goals, probes, F, G);
          frames++;
        }
        await new Promise((r) => setTimeout(r, 0));
      }
      score = [score[0] + match.score[0], score[1] + match.score[1]];
      match.score = [0, 0];
      match.clock = 0;
      goals.reset();
      match.kickoff(1 - match.kickoffTeam);
      match.state = 'kickoff';
      match.stateTimer = 0;
    }
  } finally {
    window.requestAnimationFrame = origRAF;
    if (pendingFrame) origRAF(pendingFrame);
    match.setControlled = saved.setControlled;
    match.updateSwitching = saved.updateSwitching;
    match.startIntro = saved.startIntro;
    match.startReplay = saved.startReplay;
    match.humanTeam = saved.humanTeam;
    match.onGoal = saved.onGoal;
    CONFIG.goal.resetDelay = saved.resetDelay;
    CONFIG.celebration.time = saved.celebTime;
    match.score = [0, 0];
    match.clock = 0;
    goals.reset();
    match.kickoff(0);
  }

  const rep = probes.map((p, i) => ({
    команда: i,
    'кадров у своих ворот': p.nearFrames,
    'СПИНОЙ к мячу, %': pct(p.backToBall, p.nearFrames),
    'отвёрнут > 60°, %': pct(p.wideAngle, p.nearFrames),
    'средний угол, °': p.nearFrames ? +(p.angleSum / p.nearFrames).toFixed(1) : 0,
    'навесов в штрафную': p.crosses,
    'из них выходов': p.claims,
    'выходов, %': pct(p.claims, p.crosses),
    бросков: p.dives,
    пропущено: p.conceded,
    'не прочитал удар': p.concededNoRead,
    'ничего не сделал': p.concededNoAct,
  }));
  console.table(rep);
  // ВОРОНКА ПРОПУЩЕННЫХ — главная таблица стенда. Счёт говорит «плохо», а она
  // говорит ГДЕ: не дотянулся вбок / прошло сквозь него / перекинули / ушёл с линии.
  const misses = probes.flatMap((p) => p.misses);
  const byKind = {};
  for (const m of misses) byKind[m.причина] = (byKind[m.причина] || 0) + 1;
  console.table(misses);
  console.log('ПРИЧИНЫ ПРОПУЩЕННЫХ:', byKind, '| счёт по матчам:', score);
  window.GKRIG = { rep, probes, score, misses, byKind };
  return { rep, score, misses, byKind };
}

function pct(a, b) {
  return b > 0 ? +((100 * a) / b).toFixed(1) : 0;
}

function step(match, ball, goals, probes, F, G) {
  match.update(FRAME);
  const replaying = match.state === 'replay' || match.state === 'celebration';
  const event = replaying ? null : ball.update(FRAME);
  if (!replaying) goals.update(FRAME);
  if (event === 'goal') match.onGoal();
  if (match.state !== 'play' && match.state !== 'kickoff') return;

  const bp = ball.mesh.position;
  for (let i = 0; i < 2; i++) {
    const t = match.teams[i];
    const k = t.keeper;
    const p = probes[i];
    p.frames++;
    // Мяч на нашей половине и не дальше 45 м от ворот — рабочая зона вратаря
    const d = Math.hypot(bp.x - t.ownGoalX, bp.z);
    if (d < 45) {
      p.nearFrames++;
      const kp = k.group.position;
      // Угол между взглядом кипера и направлением на мяч
      const want = Math.atan2(bp.x - kp.x, bp.z - kp.z);
      let diff = want - k.rot;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const deg = Math.abs(diff) * 180 / Math.PI;
      p.angleSum += deg;
      if (deg > 90) p.backToBall++;
      if (deg > 60) p.wideAngle++;
    }
    // Навес в свою штрафную: верховой мяч, летящий к нашим воротам.
    // Считаем СОБЫТИЯ, а не кадры: подача висит в воздухе секунду с лишним,
    // и покадровый счётчик выдавал «выходов 2372 %» вместо доли эпизодов.
    const inBox = t.side * bp.x < -(F.length / 2 - 16.5) && Math.abs(bp.z) < 20.16;
    const airborne = bp.y > 1.4;
    if (inBox && airborne) {
      if (p.lastSeen !== 'cross') { p.crosses++; p.claimed = false; }
      p.lastSeen = 'cross';
      const g = k.gk;
      if (!p.claimed && g && (g.claim || k.jumpT > 0)) { p.claims++; p.claimed = true; }
    } else if (!inBox) {
      p.lastSeen = null;
    }
    if (k.diveT > 0 && !k._rigDiving) { p.dives++; k._rigDiving = true; }
    if (k.diveT <= 0) k._rigDiving = false;

    // Снимок «мяч идёт в наши ворота» — читается в момент гола. Прогноз тот же,
    // что у самого вратаря, поэтому воронка меряет ЕГО картину мира, а не свою.
    const cross = predictGoalPlane(ball, t.ownGoalX, 3.4);
    if (cross && Math.abs(cross.z) < G.width / 2 + 0.3 && cross.y < G.height + 0.3) {
      p.snap = snapshot(k, cross, bp, t.ownGoalX);
    }
  }
}

// ===== 2. Навесной удар издалека: перебрасывают ли вратаря =====
// Ставим мяч в точку удара, бьём НАВЕСОМ в створ и смотрим, спас ли кипер.
// Это ровно жалоба Олега «мяч летит издалека — вратарь плохо реагирует».

export function lobTest(opts = {}) {
  const { match, ball, CONFIG } = window.DBG;
  const F = CONFIG.field;
  const G = CONFIG.goal;
  const dists = opts.dists || [18, 24, 30, 36, 42];
  const team = match.teams[1];          // ворота на +x
  const goalX = team.ownGoalX;
  const keeper = team.keeper;
  const rows = [];
  const sign = Math.sign(goalX);

  // Прицел ПО РЕЗУЛЬТАТУ, а не по подъёму: для каждой дистанции подбираем такой
  // подъём, чтобы мяч пересёк линию на заданной высоте. Иначе «навес» с 40 м и
  // «навес» с 18 м — это два совершенно разных удара, и таблица ничего не значит.
  const aimAt = (d, z0, tz, wantY) => {
    let lo = 0; let hi = 16;
    const sp = Math.max(13, 27 - d * 0.16);
    const cross = (lift) => {
      ball.reset();
      ball.mesh.position.set(goalX - sign * d, 0.16, z0);
      const dx = sign * d; const dz = tz - z0;
      const dl = Math.hypot(dx, dz) || 1;
      ball.vel.set((sp * dx) / dl, lift, (sp * dz) / dl);
      const c = predictPlane(ball, goalX);
      return c ? c.y : -1;
    };
    for (let i = 0; i < 24; i += 1) {
      const mid = (lo + hi) / 2;
      if (cross(mid) < wantY) lo = mid; else hi = mid;
    }
    return { lift: (lo + hi) / 2, sp };
  };
  // Мини-прогноз выхода мяча на линию (копия физики predictGoalPlane, но здесь
  // он нужен ДО того, как кипер вообще появится в кадре)
  const predictPlane = (b, gx) => {
    const B = CONFIG.ball;
    const p = b.mesh.position;
    let x = p.x; let y = p.y; let z = p.z;
    let vx = b.vel.x; let vy = b.vel.y; let vz = b.vel.z;
    const dt = 1 / 60;
    for (let t = 0; t < 4; t += dt) {
      vy += B.gravity * dt;
      const s = Math.hypot(vx, vy, vz);
      if (s > 0.01) { const k = Math.min(B.dragK * s * dt, 0.5); vx *= 1 - k; vy *= 1 - k; vz *= 1 - k; }
      const px = x;
      x += vx * dt; y += vy * dt; z += vz * dt;
      if (y < B.radius) { y = B.radius; vy = Math.abs(vy) > 1.2 ? -vy * B.bounce : 0; }
      if ((x - gx) * sign >= 0) {
        const k = px !== x ? (gx - px) / (x - px) : 0;
        return { y: Math.max(B.radius, y - vy * dt * (1 - k)), z: z - vz * dt * (1 - k) };
      }
    }
    return null;
  };

  const origRAF = window.requestAnimationFrame.bind(window);
  let pending = null;
  window.requestAnimationFrame = (cb) => { pending = cb; return 0; };
  const savedIntro = match.startIntro;
  const savedReplay = match.startReplay;
  const savedGoal = match.onGoal;
  match.startIntro = function () { this.state = 'play'; };
  match.startReplay = function () { return false; };

  // Высота на линии: под перекладиной (2.28 — верх чистого проёма для мяча)
  const heights = opts.heights || [0.9, 1.4, 1.8, 2.1];
  const zs = opts.zs || [0, 2.4];

  try {
    for (const d of dists) {
      for (const z of zs) {
        for (const wantY of heights) {
          const { lift, sp } = aimAt(d, z * 0.4, z, wantY);
          let goal = false;
          match.onGoal = function () { goal = true; };
          match.state = 'play';
          keeper.reset();
          keeper.group.position.set(goalX - sign * 1.2, 0, 0);
          keeper.vel.set(0, 0, 0);
          keeper.gk = null;
          ball.reset();
          const z0 = z * 0.4;
          ball.mesh.position.set(goalX - sign * d, 0.16, z0);
          // ВРАТАРЬ СНАЧАЛА ЗАНИМАЕТ СВОЮ ПОЗИЦИЮ. Без этих полутора секунд он
          // стоит на ленточке, где пятиться некуда, и стенд меряет не то: в
          // игре кипер встречает дальний удар в 5–6 м ПЕРЕД линией, и весь
          // вопрос перекида именно в этом.
          // Мяч на разбеге обязан ПРИНАДЛЕЖАТЬ сопернику: свободный мяч в 20 м
          // от ворот — это для кипера сигнал «подчисти», и в пустом стенде (без
          // защитников) он честно убегал на 10 м от ленты, ломая замер.
          const shooter = match.teams[0].fieldPlayers[0];
          shooter.group.position.set(goalX - sign * d, 0, z0);
          const savedToucher = match.toucher;
          match.toucher = shooter;
          ball.vel.set(0, 0, 0);
          for (let w = 0; w < 90; w += 1) updateOne(match, keeper, ball, FRAME);
          match.toucher = savedToucher;
          ball.mesh.position.set(goalX - sign * d, 0.16, z0);
          const standoff = Math.abs(keeper.group.position.x - goalX);
          const dx = sign * d; const dz = z - z0;
          const dl = Math.hypot(dx, dz) || 1;
          ball.strike({ x: dx / dl, z: dz / dl }, sp, lift, 0);
          const aim = predictPlane(ball, goalX);
          // Удар мимо створа в статистику не берём — он ничего не проверяет
          if (!aim || Math.abs(aim.z) + CONFIG.ball.radius > G.width / 2 ||
              aim.y + CONFIG.ball.radius > G.height) continue;
          let acted = 'стоял';
          for (let i = 0; i < 300 && !goal; i += 1) {
            updateOne(match, keeper, ball, FRAME);
            if (keeper.diveT > 0) acted = 'бросок';
            else if (acted === 'стоял' && keeper.gk && keeper.gk.retreating) acted = 'пятился';
            if (Math.abs(ball.mesh.position.x) > F.length / 2 + 3) break;
            if (ball.goalScored) goal = true;
          }
          rows.push({
            'дистанция, м': d,
            'по створу z': z,
            'высота на линии': +aim.y.toFixed(2),
            'стоял в, м от линии': +standoff.toFixed(1),
            гол: goal ? 'ГОЛ' : 'спас',
            кипер: acted,
          });
        }
      }
    }
  } finally {
    match.startIntro = savedIntro;
    match.startReplay = savedReplay;
    match.onGoal = savedGoal;
    window.requestAnimationFrame = origRAF;
    if (pending) origRAF(pending);
    ball.reset();
    match.kickoff(0);
  }
  console.table(rows);
  const goals = rows.filter((r) => r.гол === 'ГОЛ').length;
  console.log(`ПРОПУЩЕНО ${goals} из ${rows.length} (${(100 * goals / rows.length).toFixed(0)}%)`);
  window.GKLOB = rows;
  return rows;
}

// ===== 2в. МЯЧ СКВОЗЬ ВРАТАРЯ: играет ли он мяч, идущий прямо в него =====
// Воронка пропущенных (runGk, 4 матча) назвала это главной причиной: 7 голов из
// 10 прошли в пределах вытянутой руки от кипера — то есть он СТОЯЛ НА ЛИНИИ
// МЯЧА и не сыграл. Стенд разбирает случай по СОСТОЯНИЮ вратаря: свежий, в
// броске, ЛЕЖА после броска и сразу после отбоя (кулдауны). Все четыре
// состояния в матче встречаются постоянно, а мяч в них один и тот же.
export function throughTest(opts = {}) {
  const { match, ball, CONFIG } = window.DBG;
  const team = match.teams[1];
  const goalX = team.ownGoalX;
  const sign = Math.sign(goalX);
  const k = team.keeper;
  const speeds = opts.speeds || [6, 10, 16];
  const offs = opts.offs || [0, 0.4, 0.8];       // промах мимо центра корпуса, м
  const states = opts.states || ['свежий', 'лежит', 'в броске', 'кулдаун'];
  // ВРЕМЯ ПРИХОДА, А НЕ ДИСТАНЦИЯ. Первая редакция пускала мяч с фиксированных
  // 9 м, и медленный мяч летел полторы секунды — вратарь успевал ВСТАТЬ, стенд
  // мерил не лёжку, а подъём. В матче добивание приходит через 0.2–0.4 с, то
  // есть ВНУТРИ лёжки; равное время прихода — единственный честный вход.
  const arriveIn = opts.arriveIn != null ? opts.arriveIn : 0.28;
  const rows = [];

  const origRAF = window.requestAnimationFrame.bind(window);
  let pending = null;
  window.requestAnimationFrame = (cb) => { pending = cb; return 0; };
  const savedIntro = match.startIntro;
  const savedReplay = match.startReplay;
  const savedGoal = match.onGoal;
  match.startIntro = function () { this.state = 'play'; };
  match.startReplay = function () { return false; };

  try {
    for (const st of states) {
      for (const sp of speeds) {
        for (const off of offs) {
          let goal = false;
          match.onGoal = function () { goal = true; };
          match.state = 'play';
          k.reset();
          k.group.position.set(goalX - sign * 1.2, 0, 0);
          k.vel.set(0, 0, 0);
          k.gk = null;
          ball.reset();
          ball.goalScored = false;

          // Состояние вратаря воспроизводим ЧЕСТНО, а не выставляем флаги:
          // бросок в сторону и есть источник и downT, и кулдаунов в матче.
          if (st === 'лежит') {
            k.startKeeperDive(0, 1, { dur: 0.3, speed: 3.6, recover: 0.8 });
            for (let w = 0; w < 30; w += 1) { updateKeeper(k, FRAME, ball); ball.update(FRAME); }
          } else if (st === 'в броске') {
            k.startKeeperDive(0, 1, { dur: 0.55, speed: 3.6, recover: 0.8 });
            for (let w = 0; w < 6; w += 1) { updateKeeper(k, FRAME, ball); ball.update(FRAME); }
          } else if (st === 'кулдаун') {
            k.kickCooldown = 0.25;
            const g = k.gk || (updateKeeper(k, FRAME, ball), k.gk);
            if (g) g.saveCd = 0.25;
          }
          const kp = k.group.position;
          const lying = k.downT;
          // Мяч катится ПРЯМО В КИПЕРА (плюс промах off вдоль створа)
          const from = Math.max(1.6, sp * arriveIn);
          ball.mesh.position.set(kp.x - sign * from, CONFIG.ball.radius, kp.z + off);
          ball.vel.set(sign * sp, 0, 0);
          ball.seq = (ball.seq || 0) + 1;
          ball.strikeAge = 0;

          let res = null; let act = 'стоял';
          for (let i = 0; i < 300 && !goal; i += 1) {
            updateOne(match, k, ball, FRAME);
            if (k.diveT > 0) act = 'бросок';
            else if (k.downT > 0 && act === 'стоял') act = 'лежал';
            if (k.ai && k.ai.holding) { res = 'в руках'; break; }
            if (!res && k.gk && k.gk.last) res = k.gk.last.outcome;
            if (ball.goalScored) goal = true;
            if (Math.abs(ball.mesh.position.x) > CONFIG.field.length / 2 + 3) break;
          }
          rows.push({
            состояние: st,
            'лежал/летел, с': +(lying || k.diveT).toFixed(2),
            'скорость, м/с': sp,
            'мимо центра, м': off,
            итог: goal ? 'ГОЛ' : (res || 'мяч прошёл мимо'),
            кипер: act,
          });
        }
      }
    }
  } finally {
    match.startIntro = savedIntro;
    match.startReplay = savedReplay;
    match.onGoal = savedGoal;
    window.requestAnimationFrame = origRAF;
    if (pending) origRAF(pending);
    ball.reset();
    match.kickoff(0);
  }
  console.table(rows);
  const g = rows.filter((r) => r.итог === 'ГОЛ').length;
  const byState = {};
  for (const r of rows) {
    byState[r.состояние] = byState[r.состояние] || { голов: 0, всего: 0 };
    byState[r.состояние].всего++;
    if (r.итог === 'ГОЛ') byState[r.состояние].голов++;
  }
  console.log(`ПРОПУЩЕНО ${g} из ${rows.length}`, byState);
  window.GKTHRU = { rows, goals: g, byState };
  return { rows, goals: g, byState };
}

// ===== 2г. ПРИКАЗ «НА ВЫХОД» (W / Y): доходит ли кипер до мяча =====
// Жалоба Олега: «зажимаешь кнопку выхода — он выходит, но мяч не перехватывает,
// что делает выход бесполезным». Стенд гоняет типовые доставки мяча в штрафную
// (прострел, навес, заброс за спину, отскок) с приказом и без него и меряет
// ГЛАВНОЕ: сблизился ли кипер с мячом настолько, чтобы сыграть.
export function orderTest(opts = {}) {
  const { match, ball, CONFIG } = window.DBG;
  const team = match.teams[1];
  const goalX = team.ownGoalX;
  const sign = Math.sign(goalX);
  const k = team.keeper;
  const K = CONFIG.ai.keeper;

  // Доставки мяча в штрафную: откуда, куда и с какой дугой. Все — «мяч у
  // соперника», то есть ровно те моменты, ради которых кнопка и существует.
  const plays = opts.plays || [
    { имя: 'прострел низом', from: { x: 13, z: 22 }, to: { x: 5.5, z: -6 }, sp: 17, lift: 0 },
    { имя: 'навес с фланга', from: { x: 16, z: 24 }, to: { x: 6, z: -2 }, sp: 15, lift: 7.5 },
    { имя: 'заброс за спину', from: { x: 30, z: 8 }, to: { x: 8, z: 2 }, sp: 14, lift: 4.5 },
    { имя: 'отскок в штрафной', from: { x: 14, z: -8 }, to: { x: 6, z: 3 }, sp: 11, lift: 1.5 },
    { имя: 'пас вдоль вратарской', from: { x: 12, z: 16 }, to: { x: 4.5, z: -8 }, sp: 19, lift: 0 },
  ];
  const rows = [];

  const origRAF = window.requestAnimationFrame.bind(window);
  let pending = null;
  window.requestAnimationFrame = (cb) => { pending = cb; return 0; };
  const savedIntro = match.startIntro;
  const savedReplay = match.startReplay;
  const savedGoal = match.onGoal;
  match.startIntro = function () { this.state = 'play'; };
  match.startReplay = function () { return false; };

  try {
    for (const pl of plays) {
      for (const ordered of [false, true]) {
        match.onGoal = function () {};
        match.state = 'play';
        k.reset();
        k.group.position.set(goalX - sign * 1.2, 0, 0);
        k.vel.set(0, 0, 0);
        k.gk = null;
        ball.reset();
        ball.goalScored = false;

        // Мяч держит СОПЕРНИК — иначе приказ гасится (mateOnBall) и кипер
        // считает свободный мяч своим по обычной ветке свипера
        const shooter = match.teams[0].fieldPlayers[0];
        shooter.group.position.set(goalX - sign * pl.from.x, 0, pl.from.z);
        const savedToucher = match.toucher;
        match.toucher = shooter;

        // Вратарь сначала занимает свою точку на дуге
        ball.mesh.position.set(goalX - sign * pl.from.x, 0.2, pl.from.z);
        ball.vel.set(0, 0, 0);
        for (let w = 0; w < 60; w += 1) updateOne(match, k, ball, FRAME);
        const startDepth = Math.abs(k.group.position.x - goalX);

        const dx = (goalX - sign * pl.to.x) - (goalX - sign * pl.from.x);
        const dz = pl.to.z - pl.from.z;
        const dl = Math.hypot(dx, dz) || 1;
        ball.strike({ x: dx / dl, z: dz / dl }, pl.sp, pl.lift, 0);

        let near = 99; let res = null; let maxOut = startDepth;
        for (let i = 0; i < 180; i += 1) {
          if (ordered) k.gkOrder = true;      // кнопка ЗАЖАТА (см. updateKeeperOrder)
          updateOne(match, k, ball, FRAME);
          const kp = k.group.position;
          const bp = ball.mesh.position;
          near = Math.min(near, Math.hypot(bp.x - kp.x, bp.z - kp.z, (bp.y - 1.0) * 0.6));
          maxOut = Math.max(maxOut, Math.abs(kp.x - goalX));
          if (k.ai && k.ai.holding) { res = 'в руках'; break; }
          if (!res && k.gk && k.gk.last) res = k.gk.last.outcome;
          if (Math.abs(bp.x) > CONFIG.field.length / 2 + 2) break;
        }
        match.toucher = savedToucher;
        rows.push({
          эпизод: pl.имя,
          приказ: ordered ? 'ДЕРЖУ W' : '—',
          'ближе всего, м': +near.toFixed(2),
          'вышел на, м': +maxOut.toFixed(1),
          итог: res || 'НЕ СЫГРАЛ',
        });
      }
    }
  } finally {
    match.startIntro = savedIntro;
    match.startReplay = savedReplay;
    match.onGoal = savedGoal;
    window.requestAnimationFrame = origRAF;
    if (pending) origRAF(pending);
    ball.reset();
    match.kickoff(0);
  }
  console.table(rows);
  const ord = rows.filter((r) => r.приказ !== '—');
  const got = ord.filter((r) => r.итог !== 'НЕ СЫГРАЛ').length;
  console.log(`ПО ПРИКАЗУ сыграл ${got} из ${ord.length}`);
  window.GKORDER = rows;
  return { rows, got, of: ord.length };
}

// ===== 2д. ТРАССА ОДНОГО НАВЕСНОГО УДАРА =====
// lobTest говорит «гол», трасса говорит ПОЧЕМУ. Печатает по кадрам, что вратарь
// ЧИТАЕТ — высоту мяча на СВОЕЙ плоскости против высоты на ЛИНИИ ВОРОТ — и что
// при этом делает. Прицел подбирается под заданную высоту НА ЛИНИИ (как в
// lobTest): без этого «навес» с 18 м и с 30 м — два разных удара.
export function lobTrace(opts = {}) {
  const { match, ball, CONFIG } = window.DBG;
  const team = match.teams[1];
  const goalX = team.ownGoalX;
  const sign = Math.sign(goalX);
  const k = team.keeper;
  const d = opts.d != null ? opts.d : 18;
  const tz = opts.z != null ? opts.z : 0;
  const wantY = opts.wantY != null ? opts.wantY : 1.8;
  const sp = opts.sp != null ? opts.sp : Math.max(13, 27 - d * 0.16);

  // Подбор подъёма под нужную высоту НА ЛИНИИ
  const dl = Math.hypot(d, tz) || 1;
  const tryLift = (lift) => {
    ball.reset();
    ball.mesh.position.set(goalX - sign * d, 0.16, 0);
    ball.vel.set((sp * sign * d) / dl, lift, (sp * tz) / dl);
    const c = predictGoalPlane(ball, goalX, 4, sign);
    return c ? c.y : -1;
  };
  let lo = 0; let hi = 16;
  for (let i = 0; i < 26; i += 1) {
    const mid = (lo + hi) / 2;
    if (tryLift(mid) < wantY) lo = mid; else hi = mid;
  }
  const lift = (lo + hi) / 2;

  const rows = [];
  const origRAF = window.requestAnimationFrame.bind(window);
  let pending = null;
  window.requestAnimationFrame = (cb) => { pending = cb; return 0; };
  const savedIntro = match.startIntro;
  const savedReplay = match.startReplay;
  const savedGoal = match.onGoal;
  match.startIntro = function () { this.state = 'play'; };
  match.startReplay = function () { return false; };
  let goal = false;
  match.onGoal = function () { goal = true; };
  let worstGap = 0;   // максимум «у меня выше, чем на линии» — суть дефекта

  try {
    match.state = 'play';
    k.reset();
    k.group.position.set(goalX - sign * 1.2, 0, 0);
    k.vel.set(0, 0, 0);
    k.gk = null;
    ball.reset();
    ball.goalScored = false;
    const shooter = match.teams[0].fieldPlayers[0];
    shooter.group.position.set(goalX - sign * d, 0, 0);
    const savedToucher = match.toucher;
    match.toucher = shooter;
    ball.mesh.position.set(goalX - sign * d, 0.16, 0);
    ball.vel.set(0, 0, 0);
    for (let w = 0; w < 90; w += 1) updateOne(match, k, ball, FRAME);
    match.toucher = savedToucher;
    ball.mesh.position.set(goalX - sign * d, 0.16, 0);
    ball.strike({ x: (sign * d) / dl, z: tz / dl }, sp, lift, 0);

    for (let i = 0; i < 220; i += 1) {
      updateOne(match, k, ball, FRAME);
      const bp = ball.mesh.position;
      const kp = k.group.position;
      const behind = (bp.x - goalX) * sign > 0;      // мяч уже за линией
      const own = predictGoalPlane(ball, kp.x, 3.4, sign);
      const line = predictGoalPlane(ball, goalX, 3.4, sign);
      if (own && line) worstGap = Math.max(worstGap, own.y - line.y);
      // Печатаем только «горячие» кадры: мяч ближе 10 м к линии
      if (Math.abs(bp.x - goalX) < 10 && i % 3 === 0) {
        rows.push({
          'мяч до линии, м': +Math.abs(bp.x - goalX).toFixed(1),
          'мяч y': +bp.y.toFixed(2),
          'кипер в, м': +Math.abs(kp.x - goalX).toFixed(2),
          'у МЕНЯ y': own ? +own.y.toFixed(2) : null,
          'на ЛИНИИ y': line ? +line.y.toFixed(2) : null,
          решение: k.diveT > 0 ? 'бросок'
            : (k.gk && k.gk.retreating ? 'ПЯТИТСЯ'
              : (k.jumpT > 0 ? 'прыжок' : 'шаг')),
        });
      }
      if (goal || behind) break;
    }
  } finally {
    match.startIntro = savedIntro;
    match.startReplay = savedReplay;
    match.onGoal = savedGoal;
    window.requestAnimationFrame = origRAF;
    if (pending) origRAF(pending);
    ball.reset();
    match.kickoff(0);
  }
  console.table(rows);
  console.log(goal ? 'ГОЛ' : 'спас', '| максимум «у меня выше, чем на линии»:',
    worstGap.toFixed(2), 'м');
  window.GKTRACE = { rows, goal, worstGap };
  return { rows, goal, worstGap: +worstGap.toFixed(2) };
}

// Один кадр «вратарь против мяча», без остальных двадцати одного
function updateOne(match, keeper, ball, dt) {
  if (keeper.ai && keeper.ai.holding) return;
  updateKeeper(keeper, dt, ball);
  ball.update(dt);
  if (window.DBG.goals) window.DBG.goals.update(dt);
}

// ===== 2б. МЕДЛЕННЫЙ МЯЧ ИЗДАЛЕКА: берёт ли в руки =====
// Жалоба Олега 28.07.2026: «пропускает еле катящиеся мячи, если они летят
// издалека или рикошетятся издалека — пытается прыгать за ними и проигрывает
// тайминг, хотя тут его надо просто брать в руки».
//
// Стенд бьёт с разных дистанций так, чтобы мяч ПРИШЁЛ НА ЛИНИЮ с заданной
// (маленькой) скоростью — прицел по РЕЗУЛЬТАТУ, как в lobTest: «удар с 22 м» и
// «удар с 38 м» одинаковой начальной силы дают на линии совершенно разные мячи,
// и без подбора таблица ничего не значит.
//
// ЭТАЛОН (28.07.2026): до правки — 11 голов из 27, бросок ВСЕГДА за 0.5…1.7 с
// до прихода мяча. После — 0 из 27, действие «шаг» или «выход».
export function rollTest(opts = {}) {
  const { match, ball, CONFIG, goals } = window.DBG;
  const B = CONFIG.ball;
  const team = match.teams[1];
  const goalX = team.ownGoalX;
  const sign = Math.sign(goalX);
  const k = team.keeper;
  const dists = opts.dists || [22, 30, 38];
  const speeds = opts.speeds || [3, 5, 8];   // м/с НА ЛИНИИ
  const zs = opts.zs || [0.8, 1.8, 2.8];     // куда по створу
  const rows = [];

  // Мини-прогноз выхода на линию (нужен ДО того, как в кадре появится вратарь)
  const plane = (d, v0, tz) => {
    const dl = Math.hypot(d, tz) || 1;
    let x = goalX - sign * d; let y = 0.16; let z = 0;
    let vx = (sign * v0 * d) / dl; let vy = 0; let vz = (v0 * tz) / dl;
    for (let t = 0; t < 8; t += FRAME) {
      const air = y > B.radius + 0.001 || vy > 0;
      if (air) {
        vy += B.gravity * FRAME;
        const s = Math.hypot(vx, vy, vz);
        if (s > 0.01) { const c = Math.min(B.dragK * s * FRAME, 0.5); vx *= 1 - c; vy *= 1 - c; vz *= 1 - c; }
      } else { const r = Math.pow(B.rollFriction, FRAME * 60); vx *= r; vz *= r; }
      x += vx * FRAME; y += vy * FRAME; z += vz * FRAME;
      if (y < B.radius) { y = B.radius; vy = Math.abs(vy) > 1.2 ? -vy * B.bounce : 0; }
      if ((x - goalX) * sign >= 0) return { t, sp: Math.hypot(vx, vy, vz), y, z };
      if (vx * sign <= 0.05) return null;
    }
    return null;
  };

  const origRAF = window.requestAnimationFrame.bind(window);
  let pending = null;
  window.requestAnimationFrame = (cb) => { pending = cb; return 0; };
  const savedIntro = match.startIntro;
  const savedReplay = match.startReplay;
  const savedGoal = match.onGoal;
  match.startIntro = function () { this.state = 'play'; };
  match.startReplay = function () { return false; };

  try {
    for (const d of dists) {
      for (const want of speeds) {
        for (const tz of zs) {
          // Подбор начальной силы под нужную скорость ПРИХОДА
          let lo = 5; let hi = 70;
          for (let i = 0; i < 30; i += 1) {
            const mid = (lo + hi) / 2;
            const r = plane(d, mid, tz);
            if (!r || r.sp < want) lo = mid; else hi = mid;
          }
          const v0 = (lo + hi) / 2;
          const pre = plane(d, v0, tz);
          if (!pre || Math.abs(pre.z) > CONFIG.goal.width / 2 - CONFIG.ball.radius) continue;

          let goal = false;
          match.onGoal = function () { goal = true; };
          match.state = 'play';
          k.reset();
          k.group.position.set(goalX - sign * 1.2, 0, 0);
          k.vel.set(0, 0, 0);
          k.gk = null;
          ball.reset();
          ball.goalScored = false;
          ball.mesh.position.set(goalX - sign * d, 0.16, 0);
          // Вратарь сначала занимает свою точку на дуге; мяч на разбеге держит
          // соперник, иначе кипер убежит его «подчищать» и замер поедет
          const shooter = match.teams[0].fieldPlayers[0];
          shooter.group.position.set(goalX - sign * d, 0, 0);
          const savedToucher = match.toucher;
          match.toucher = shooter;
          ball.vel.set(0, 0, 0);
          for (let w = 0; w < 120; w += 1) updateOne(match, k, ball, FRAME);
          match.toucher = savedToucher;
          ball.mesh.position.set(goalX - sign * d, 0.16, 0);
          const standoff = Math.abs(k.group.position.x - goalX);
          const dl = Math.hypot(d, tz) || 1;
          ball.strike({ x: (sign * d) / dl, z: tz / dl }, v0, 0, 0);

          let acted = 'стоял'; let diveLead = null; let res = null; let t = 0;
          for (let i = 0; i < 700 && !goal; i += 1) {
            updateOne(match, k, ball, FRAME);
            t += FRAME;
            if (k.diveT > 0 && diveLead == null) { acted = 'БРОСОК'; diveLead = +(pre.t - t).toFixed(2); }
            else if (acted === 'стоял' && k.gk && k.gk.collecting) acted = 'выход';
            else if (acted === 'стоял' && k.gk && k.gk.retreating) acted = 'пятился';
            if (k.ai && k.ai.holding) { res = 'в руках'; break; }
            if (!res && k.gk && k.gk.last) res = k.gk.last.outcome;
            if (ball.goalScored) goal = true;
            if (Math.abs(ball.mesh.position.x) > CONFIG.field.length / 2 + 3) break;
          }
          rows.push({
            'дистанция, м': d,
            'приход, м/с': +pre.sp.toFixed(1),
            'по створу z': +pre.z.toFixed(1),
            'стоял в, м': +standoff.toFixed(1),
            итог: goal ? 'ГОЛ' : (res || 'жив'),
            кипер: acted === 'стоял' && res ? 'шаг' : acted,
            'бросок за, с': diveLead,
          });
        }
      }
    }
  } finally {
    match.startIntro = savedIntro;
    match.startReplay = savedReplay;
    match.onGoal = savedGoal;
    window.requestAnimationFrame = origRAF;
    if (pending) origRAF(pending);
    ball.reset();
    match.kickoff(0);
  }
  console.table(rows);
  const g = rows.filter((r) => r.итог === 'ГОЛ').length;
  const dives = rows.filter((r) => r['бросок за, с'] != null).length;
  console.log(`ПРОПУЩЕНО ${g} из ${rows.length}; бросков ${dives}`);
  window.GKROLL = rows;
  return { rows, goals: g, dives };
}

// ===== 3. ОТБОЙ: куда уходит мяч и как падает вратарь =====
// Отвечает на два вопроса Олега сразу: «честные ли отскоки» и «правильные ли
// падения». Бьём в кипера с разных точек и по разной высоте и смотрим, КУДА
// ушёл мяч относительно ворот — и совпало ли при этом тело с физикой.

export function parryTest(opts = {}) {
  const { match, ball, CONFIG } = window.DBG;
  const F = CONFIG.field;
  const G = CONFIG.goal;
  const team = match.teams[1];
  const goalX = team.ownGoalX;
  const sign = Math.sign(goalX);
  const k = team.keeper;
  const hips = k.model && k.model.getObjectByName('mixamorigHips');
  const V = ball.mesh.position.constructor;
  const tmp = new V();

  const dists = opts.dists || [8, 13, 20];
  const aims = opts.aims || [-2.6, -1.2, 0, 1.2, 2.6];   // куда по створу
  const highs = opts.highs || [0.4, 1.2, 2.0];           // высота на линии
  const rows = [];

  const origRAF = window.requestAnimationFrame.bind(window);
  let pending = null;
  window.requestAnimationFrame = (cb) => { pending = cb; return 0; };
  const savedIntro = match.startIntro;
  const savedReplay = match.startReplay;
  const savedGoal = match.onGoal;
  match.startIntro = function () { this.state = 'play'; };
  match.startReplay = function () { return false; };

  try {
    for (const d of dists) {
      for (const aim of aims) {
        for (const hy of highs) {
          let goal = false;
          match.onGoal = function () { goal = true; };
          match.state = 'play';
          k.reset();
          k.group.position.set(goalX - sign * 1.6, 0, 0);
          k.vel.set(0, 0, 0);
          k.gk = null;
          ball.reset();
          ball.mesh.position.set(goalX - sign * d, 0.2, 0);
          // Скорость подбираем так, чтобы мяч пришёл на линию на высоте hy
          const t = d / 24;
          const vy = (hy - 0.2) / t - 0.5 * CONFIG.ball.gravity * t;
          ball.strike({ x: sign, z: 0 }, 24, 0, 0);
          ball.vel.set(sign * 24, vy, (aim - 0) / t);

          let touched = false; let after = null; let drift = 0; let low = 9;
          let clip = null;
          for (let i = 0; i < 200 && !goal; i += 1) {
            const before = ball.vel.clone();
            updateOne(match, k, ball, FRAME);
            if (hips) {
              k.group.updateMatrixWorld(true);
              tmp.setFromMatrixPosition(hips.matrixWorld);
              drift = Math.max(drift, Math.hypot(tmp.x - k.group.position.x,
                tmp.z - k.group.position.z));
              low = Math.min(low, tmp.y);
            }
            if (!touched && ball.vel.distanceTo(before) > 0.5) {
              touched = true;
              clip = k.currentName;
              after = ball.vel.clone();
            }
            if (ball.goalScored) goal = true;
            if (touched && i > 120) break;
          }
          if (!touched) continue;
          // Куда ушёл мяч: наружу от ворот (безопасно), вбок (за штангу) или
          // назад в опасную зону перед воротами
          const away = after.x * team.side;         // > 0 — прочь от ворот
          const lateral = Math.abs(after.z);
          const where = goal ? 'ГОЛ'
            : (away > 3 && lateral < away ? 'в поле от ворот'
              : (lateral > 2 ? 'вбок за штангу'
                : (away > 0 ? 'слабо вперёд' : 'НАЗАД в ворота')));
          rows.push({
            'удар с, м': d,
            'по створу': aim,
            'высота': hy,
            'ушёл': where,
            'скорость после': +after.length().toFixed(1),
            'вверх': +after.y.toFixed(1),
            клип: clip,
            'тело↔физика, м': +drift.toFixed(2),
            'таз упал до': +low.toFixed(2),
          });
        }
      }
    }
  } finally {
    match.startIntro = savedIntro;
    match.startReplay = savedReplay;
    match.onGoal = savedGoal;
    window.requestAnimationFrame = origRAF;
    if (pending) origRAF(pending);
    ball.reset();
    match.kickoff(0);
  }
  const by = {};
  for (const r of rows) by[r.ушёл] = (by[r.ушёл] || 0) + 1;
  const worst = rows.reduce((m, r) => Math.max(m, r['тело↔физика, м']), 0);
  console.table(rows);
  console.log('исходы:', by, 'худшее расхождение тело↔физика:', worst.toFixed(2), 'м');
  window.GKPARRY = { rows, by, worst };
  return { rows, by, worst };
}

// ===== 3б. СВОБОДНЫЙ МЯЧ У ШТРАФНОЙ: выходит ли кипер ЗАБРАТЬ его =====
// Жалоба Олега 29.07.2026: «вратарь у ИИ не выходит забрать мяч, когда тот
// совсем не далеко от него, — стоит и ждёт, пока нападающий добежит и забьёт».
//
// Ни один прежний стенд этого не ловит ПО ПОСТРОЕНИЮ: в rollTest и orderTest
// соперник СТОИТ в точке удара, а вся ветка выхода (tryCollect и свипер в
// tryRush) отменяется именно расчётом «успею ли я раньше бегущего соперника».
// Значит вход стенда обязан содержать нападающего, который к мячу БЕЖИТ.
//
// Гонка честная: работает полный match.update, то есть нападающего ведёт его
// собственный AI, а не подсказка стенда. Остальные двадцать игроков уезжают на
// чужую половину — меряем ОДНУ дуэль, а не эпизод с семью подстраховками.
export function looseTest(opts = {}) {
  const { match, ball, goals, CONFIG } = window.DBG;
  const team = match.teams[1];          // обороняющаяся команда, ворота на +x
  const foe = match.teams[0];
  const goalX = team.ownGoalX;
  const sign = Math.sign(goalX);
  const k = team.keeper;
  const dBalls = opts.dBalls || [7, 11, 15];   // м от линии ворот до мяча
  const dOpps = opts.dOpps || [6, 10, 14];     // м от мяча до нападающего
  const rolls = opts.rolls || [0, 3];          // м/с: мяч лежит или катится к воротам
  const z0 = opts.z != null ? opts.z : 2;
  const rows = [];

  const saved = {
    setControlled: match.setControlled,
    updateSwitching: match.updateSwitching,
    startIntro: match.startIntro,
    startReplay: match.startReplay,
    humanTeam: match.humanTeam,
    controlled: match.controlled,
    onGoal: match.onGoal,
  };
  const origRAF = window.requestAnimationFrame.bind(window);
  let pending = null;
  window.requestAnimationFrame = (cb) => { pending = cb; return 0; };

  try {
    match.setControlled = function () { this.controlled = null; };
    match.updateSwitching = function () { this.input.consumeSwitch(); };
    match.controlled = null;
    match.humanTeam = { players: [], fieldPlayers: [], receiver: null, receiveTimer: 0 };
    match.startIntro = function () { this.state = 'play'; };
    match.startReplay = function () { return false; };

    for (const dBall of dBalls) {
      for (const dOpp of dOpps) {
        for (const roll of rolls) {
          let goal = false;
          match.onGoal = function () { goal = true; };
          match.state = 'play';
          ball.reset();
          ball.goalScored = false;

          const striker = foe.fieldPlayers[9] || foe.fieldPlayers[0];
          let n = 0;
          for (const p of match.allPlayers) {
            if (p === k || p === striker) continue;
            p.reset(-sign * (CONFIG.field.length / 2 - 14), ((n++ % 10) - 5) * 4, sign * Math.PI / 2);
          }
          k.reset();
          k.group.position.set(goalX - sign * 1.2, 0, 0);
          k.vel.set(0, 0, 0);
          k.gk = null;

          const bx = goalX - sign * dBall;
          ball.mesh.position.set(bx, CONFIG.ball.radius, z0);
          ball.vel.set(roll ? sign * roll : 0, 0, 0);
          ball.seq = (ball.seq || 0) + 1;
          ball.strikeAge = 0.8;     // мяч уже катится какое-то время, это не удар в упор
          striker.reset(bx - sign * dOpp, z0, sign * Math.PI / 2);

          // Что кипер ВИДИТ на входе: идёт ли мяч в створ (от этого зависит,
          // попадёт ли он вообще в ветку tryCollect) и какова его фора в гонке
          const cross = predictGoalPlane(ball, goalX, CONFIG.ai.keeper.readHorizon);
          const K = CONFIG.ai.keeper;
          const mine = Math.hypot(bx - k.group.position.x, z0) / K.lungeSpeed;
          const theirs = dOpp / (CONFIG.player.speed * CONFIG.player.sprintFactor);

          let out = Math.abs(k.group.position.x - goalX);
          let near = 99; let acted = 'стоял'; let first = null; let res = null;
          match.lastTouch = null;
          for (let i = 0; i < 260 && !goal; i += 1) {
            match.update(FRAME);
            const ev = ball.update(FRAME);
            goals.update(FRAME);
            if (ev === 'goal') match.onGoal();
            const kp = k.group.position;
            const bp = ball.mesh.position;
            out = Math.max(out, Math.abs(kp.x - goalX));
            near = Math.min(near, Math.hypot(bp.x - kp.x, bp.z - kp.z));
            const g = k.gk || {};
            if (acted === 'стоял') {
              if (g.collecting) acted = 'выход за мячом';
              else if (g.rushing) acted = 'выход';
              else if (k.diveT > 0) acted = 'бросок';
              else if (g.retreating) acted = 'пятился';
            }
            if (!first && match.lastTouch) first = match.lastTouch === k ? 'ВРАТАРЬ' : 'соперник';
            if (k.ai && k.ai.holding) { res = 'в руках'; break; }
            if (!res && k.gk && k.gk.last) res = k.gk.last.outcome;
          }
          rows.push({
            'мяч в, м': dBall,
            'соперник в, м': dOpp,
            'катится, м/с': roll,
            'в створ?': cross ? 'да' : 'нет',
            'фора кипера, с': +(theirs - mine).toFixed(2),
            кипер: acted,
            'вышел на, м': +out.toFixed(1),
            'ближе всего, м': +near.toFixed(2),
            'первый на мяче': first || '—',
            итог: goal ? 'ГОЛ' : (res || (first === 'соперник' ? 'у соперника' : 'жив')),
          });
        }
      }
    }
  } finally {
    match.setControlled = saved.setControlled;
    match.updateSwitching = saved.updateSwitching;
    match.startIntro = saved.startIntro;
    match.startReplay = saved.startReplay;
    match.humanTeam = saved.humanTeam;
    match.onGoal = saved.onGoal;
    match.controlled = saved.controlled;
    window.requestAnimationFrame = origRAF;
    if (pending) origRAF(pending);
    ball.reset();
    match.score = [0, 0];
    match.kickoff(0);
  }
  console.table(rows);
  // «ВЫШЕЛ» МЕРЯЕТСЯ МЕТРАМИ, А НЕ ФЛАГОМ. Флаг `collecting` загорается и после
  // того, как по мячу уже ударил соперник, — на исходной сборке он давал 15
  // «выходов» из 18 при том, что кипер не сходил с ленточки (замер: «вышел на»
  // 1.2 м, то есть стартовая позиция). Уходом с линии считаем 2.5 м и дальше.
  const went = rows.filter((r) => r['вышел на, м'] > 2.5).length;
  const got = rows.filter((r) => r.итог === 'в руках').length;
  const goals_ = rows.filter((r) => r.итог === 'ГОЛ').length;
  console.log(`ВЫШЕЛ ${went} из ${rows.length}; забрал ${got}; пропущено ${goals_}`);
  window.GKLOOSE = { rows, went, got, goals: goals_ };
  return { rows, went, got, goals: goals_ };
}

// ===== 4. Фантомные голы: мяч, не проходивший чистый проём =====

export function netTest(opts = {}) {
  const { match, ball, CONFIG } = window.DBG;
  const G = CONFIG.goal;
  const line = CONFIG.field.length / 2;
  const R = CONFIG.ball.radius;
  const n = opts.n || 2000;
  const rnd = (a, b) => a + Math.random() * (b - a);

  // Честный судья: центр мяча пересёк плоскость линии ИЗ ПОЛЯ и весь мяч
  // прошёл в чистом проёме (штанга физически не пустила бы иначе).
  const honest = (prev, cur) => {
    if (!(prev.x < line + R && cur.x >= line + R)) return false;
    const t = (line + R - prev.x) / (cur.x - prev.x);
    const z = prev.z + (cur.z - prev.z) * t;
    const y = prev.y + (cur.y - prev.y) * t;
    return Math.abs(z) + R <= G.width / 2 + 1e-6 && y - R >= -1e-6 && y + R <= G.height + 1e-6;
  };

  let phantom = 0; let missed = 0; let real = 0;
  const samples = [];
  const oG = match.onGoal.bind(match);
  const oR = match.beginRestart.bind(match);
  for (let i = 0; i < n; i++) {
    const x0 = rnd(20, 50); const z0 = rnd(-26, 26); const y0 = rnd(0.16, 1.4);
    const tz = rnd(-10, 10);
    const dd = Math.hypot(line - x0, tz - z0);
    const sp = rnd(12, 32); const lift = rnd(0, 14);
    ball.reset(); ball.goalScored = false; match.state = 'play';
    ball.mesh.position.set(x0, y0, z0);
    ball.vel.set((sp * (line - x0)) / dd, lift, (sp * (tz - z0)) / dd);
    let verdict = null; let ok = false; let at = null;
    const mark = (v) => {
      if (!verdict) {
        verdict = v;
        const p = ball.mesh.position;
        at = { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) };
      }
    };
    match.onGoal = () => mark('ГОЛ');
    match.beginRestart = (t) => mark(t);
    let prev = { x: x0, y: y0, z: z0 };
    for (let f = 0; f < 500 && !verdict; f++) {
      ball.update(FRAME);
      const p = ball.mesh.position;
      const cur = { x: p.x, y: p.y, z: p.z };
      if (honest(prev, cur)) ok = true;
      prev = cur;
      if (ball.goalScored) mark('ГОЛ');
      match.checkOutOfPlay();
    }
    if (verdict === 'ГОЛ' && !ok) { phantom++; if (samples.length < 8) samples.push(at); }
    else if (verdict !== 'ГОЛ' && ok) missed++;
    else if (verdict === 'ГОЛ') real++;
  }
  match.onGoal = oG; match.beginRestart = oR;
  ball.reset(); ball.goalScored = false;
  const out = {
    выстрелов: n, честныхГолов: real, фантомных: phantom,
    'фантомных, %': +((100 * phantom) / n).toFixed(2),
    'проглядели гол': missed, примеры: samples,
  };
  console.log(out);
  window.GKNET = out;
  return out;
}
