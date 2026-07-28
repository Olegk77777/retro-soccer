// Стенд ВРАТАРЯ: числовые эталоны игры кипера (правило проекта — «у каждого
// эффекта должен быть записанный ЧИСЛОВОЙ эталон, иначе после любой правки его
// молча потеряют, а на глаз это читается расплывчатым „стало плохо“»).
//
// Как запустить (консоль браузера на открытой игре):
//   const gk = await import('./tools/gk-rig.js');
//   await gk.runGk({ matches: 2 });     // разворот, выходы, воронка сейвов
//   gk.lobTest();                       // навесной удар издалека: перебрасывают?
//   gk.netTest();                       // фантомные голы сквозь сетку
//
// Стенд НИЧЕГО не оставляет сломанным: все патчи снимаются в finally.

import { updateKeeper } from '../src/ai/goalkeeper.js';

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
  };
}

export async function runGk(opts = {}) {
  const matches = opts.matches != null ? opts.matches : 2;
  const chunk = opts.chunk != null ? opts.chunk : 5400;
  const DBG = window.DBG;
  if (!DBG || !DBG.match) throw new Error('Матч ещё не загрузился');
  const { match, ball, goals, CONFIG } = DBG;
  const F = CONFIG.field;

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
          step(match, ball, goals, probes, F);
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
  window.GKRIG = { rep, probes, score };
  return { rep, score };
}

function pct(a, b) {
  return b > 0 ? +((100 * a) / b).toFixed(1) : 0;
}

function step(match, ball, goals, probes, F) {
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

// Один кадр «вратарь против мяча», без остальных двадцати одного
function updateOne(match, keeper, ball, dt) {
  if (keeper.ai && keeper.ai.holding) return;
  updateKeeper(keeper, dt, ball);
  ball.update(dt);
  if (window.DBG.goals) window.DBG.goals.update(dt);
}

// ===== 3. Фантомные голы: мяч, не проходивший чистый проём =====

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
