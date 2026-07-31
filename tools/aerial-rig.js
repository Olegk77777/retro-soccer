// Стенд ЗАМЫКАНИЯ и ПАДЕНИЙ: борьба на втором этаже и удар в падении — числом.
//
// ЗАЧЕМ. Фидбек Олега 29.07.2026 (четыре жалобы разом):
//   1. «нападающий в менее выигрышной позиции забивает — надо, чтобы замыкал
//      или выносил тот, кто ПЕРВЫЙ на мяче»;
//   2. «нападающий должен ДОБЕГАТЬ до летящего мяча и бить, а не стоять в точке
//      и ждать, пока он прилетит»;
//   3. «часто удар фиксируется, когда нападающий физически не дотягивается»;
//   4. «после удара в падении игрок падает с глюком и немного лежит закопанный
//      в землю».
//
// Правило проекта: у каждого эффекта должен быть записанный ЧИСЛОВОЙ эталон.
// Здесь их четыре — по числу жалоб.
//
// Как запустить (консоль браузера на открытой игре):
//   const R = await import('./tools/aerial-rig.js');
//   await R.diveTrace();      // (4) уходит ли фигура ПОД газон после ласточки
//   await R.contactStats({ matches: 2 });  // (1)(2)(3) разом по живым матчам
//   await R.contestRig();     // (1) очная ставка: кто первый на мяче, тот и бьёт
//
// Как и sim.js, стенд останавливает главный цикл перехватом requestAnimationFrame
// и снимает все патчи в finally.

import * as THREE from 'three';
import { predictLanding } from '../src/ai/steering.js';

const FRAME = 1 / 60;
const _v = new THREE.Vector3();
const _vel = new THREE.Vector3();

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

// Самая низкая точка ФИГУРЫ в мире (по костям). Кости — не меш, но провал
// фигуры под газон виден по ним ровно так же, а считать их дёшево.
function lowestBoneY(p) {
  if (!p.model) return null;
  let min = Infinity;
  p.model.traverse((o) => {
    if (!o.isBone) return;
    o.getWorldPosition(_v);
    if (_v.y < min) min = _v.y;
  });
  return min === Infinity ? null : min;
}

function boneY(p, re) {
  if (!p.model) return null;
  let out = null;
  p.model.traverse((o) => {
    if (out == null && o.isBone && re.test(o.name)) {
      o.getWorldPosition(_v);
      out = _v.y;
    }
  });
  return out;
}

async function harness(fn, opts = {}) {
  const DBG = window.DBG;
  if (!DBG || !DBG.match) throw new Error('Матч ещё не загрузился — подожди секунду и повтори');
  const { match, ball, goals, CONFIG } = DBG;
  const saved = {
    setControlled: match.setControlled,
    updateSwitching: match.updateSwitching,
    startIntro: match.startIntro,
    startReplay: match.startReplay,
    humanTeam: match.humanTeam,
    controlled: match.controlled,
    resetDelay: CONFIG.goal.resetDelay,
    celebTime: CONFIG.celebration.time,
  };
  const origRAF = window.requestAnimationFrame.bind(window);
  let pending = null;
  window.requestAnimationFrame = (cb) => { pending = cb; return 0; };
  try {
    if (opts.noHuman !== false) {
      match.setControlled = function () { this.controlled = null; };
      match.updateSwitching = function () { this.input.consumeSwitch(); };
      match.controlled = null;
      match.humanTeam = { players: [], fieldPlayers: [], receiver: null, receiveTimer: 0 };
    }
    match.startIntro = function () { this.state = 'kickoff'; this.stateTimer = 0; };
    match.startReplay = function () { return false; };
    CONFIG.goal.resetDelay = 0.2;
    CONFIG.celebration.time = 0.1;
    return await fn({ match, ball, goals, CONFIG });
  } finally {
    Object.assign(match, {
      setControlled: saved.setControlled,
      updateSwitching: saved.updateSwitching,
      startIntro: saved.startIntro,
      startReplay: saved.startReplay,
      humanTeam: saved.humanTeam,
      controlled: saved.controlled,
    });
    CONFIG.goal.resetDelay = saved.resetDelay;
    CONFIG.celebration.time = saved.celebTime;
    window.requestAnimationFrame = origRAF;
    if (pending) origRAF(pending);
  }
}

// Один кадр матча без рендера — ОДИН В ОДИН как в main.js и sim.js.
// Событие мяча обязано доехать до матча: без `match.onGoal()` голы просто не
// засчитываются, и стенд честно печатает 0:0 на любой сборке (наступил 29.07).
function step(match, ball, goals) {
  match.update(FRAME);
  const replaying = match.state === 'replay' || match.state === 'celebration';
  const event = replaying ? null : ball.update(FRAME);
  if (!replaying && goals && goals.update) goals.update(FRAME);
  if (event === 'goal') match.onGoal();
}

// === 1. Ласточка: уходит ли фигура ПОД газон ===
//
// Ставим игрока, кидаем мяч мимо него так, чтобы он бросился, и покадрово
// смотрим самую низкую кость. Эталон: ниже −0.05 м не опускается НИЧЕГО
// (кость стопы в лёжке лежит на нуле).
export async function diveTrace(opts = {}) {
  const frames = opts.frames != null ? opts.frames : 170;
  return harness(async ({ match, ball, goals, CONFIG }) => {
    const t = match.teams[0];
    const p = t.players.find((x) => !x.isKeeper);
    const goalX = t.attackGoalX;
    const dir = Math.sign(goalX) || 1;
    match.state = 'play';
    match.stateTimer = 0;
    p.reset(goalX - dir * 10, 0, Math.atan2(dir, 0));
    p.rot = Math.atan2(dir, 0);
    // Мяч проходит в двух метрах сбоку низом — ровно случай ласточки
    ball.mesh.position.set(goalX - dir * 16, 0.8, -2.2);
    ball.vel.set(dir * 9, 0.4, 0);
    ball.spin = 0;
    const rows = [];
    // Бросок запускаем принудительно: нам нужна САМА ласточка, а не редкая
    // ситуация, в которой AI на неё решится
    for (let f = 0; f < frames; f++) {
      if (f === 4) p.startDive(0, -1, 0.8);
      step(match, ball, goals);
      rows.push({
        f,
        t: +(f * FRAME).toFixed(3),
        low: +(lowestBoneY(p) ?? 0).toFixed(3),
        hips: +(boneY(p, /Hips$/) ?? 0).toFixed(3),
        head: +(boneY(p, /Head$/) ?? 0).toFixed(3),
        tilt: +(p.group.rotation.x * 180 / Math.PI).toFixed(1),
        grpY: +p.group.position.y.toFixed(3),
        clip: p.currentName,
        diveT: +Math.max(0, p.diveT).toFixed(2),
        downT: +Math.max(0, p.downT).toFixed(2),
      });
    }
    const under = rows.filter((r) => r.low < -0.05);
    const worst = rows.reduce((a, b) => (b.low < a.low ? b : a), rows[0]);
    const out = {
      frames: rows.length,
      underFrames: under.length,
      minLow: worst.low,
      minLowAt: worst.t,
      minLowClip: worst.clip,
      rows,
    };
    window.DIVE = out;
    console.log('ласточка: под газоном %d кадров, глубже всего %s м на %s с (клип %s)',
      out.underFrames, out.minLow, out.minLowAt, out.minLowClip);
    console.table(rows.filter((r) => r.f % 2 === 0));
    return out;
  }, opts);
}

// === 2. Замыкания живого матча: дотянулся ли, бежал ли, был ли первым ===
//
// Перехватываем сам момент удара (patch на updateAerialStrike) и в кадре
// контакта пишем: расстояние от точки удара до мяча, скорость игрока, и был ли
// В ЭТОТ МОМЕНТ кто-то ближе к мячу (свой или чужой).
export async function contactStats(opts = {}) {
  const matches = opts.matches != null ? opts.matches : 2;
  const chunk = opts.chunk != null ? opts.chunk : 1800;
  return harness(async ({ match, ball, goals, CONFIG }) => {
    const Player = Object.getPrototypeOf(match.allPlayers[0]);
    const origUpdate = Player.updateAerialStrike;
    const hits = [];
    const _p = new THREE.Vector3();
    Player.updateAerialStrike = function (dt, b) {
      const had = this.aerialStrike;
      const style = had ? had.styleName : null;
      const t0 = had ? had.t : 0;
      const v0 = had ? b.vel.clone() : null;
      origUpdate.call(this, dt, b);
      // Замах кончился в этом кадре — либо ударом, либо промахом/срывом
      if (!had || this.aerialStrike) return;
      const bp = b.mesh.position;
      const sp = this.strikePointWorld(style, _p);
      const d = sp ? sp.distanceTo(bp) : null;
      // …и то же расстояние, посчитанное ПО ХОДУ КАДРА — им игра и решает,
      // дотянулся ли игрок (Player._strikeGap)
      const gap = sp ? this._strikeGap(sp, b, dt) : null;
      // Настоящий удар отличается от промаха тем, что мяч ПОМЕНЯЛ скорость
      const connected = !!v0 && b.vel.distanceTo(v0) > 0.5;
      // Кто ближе к мячу прямо сейчас
      let nearer = 0;
      let nearestOther = Infinity;
      let nearestFoe = Infinity;
      for (const o of this.team.match.allPlayers) {
        if (o === this) continue;
        const dd = Math.hypot(o.group.position.x - bp.x, o.group.position.z - bp.z);
        if (dd < nearestOther) nearestOther = dd;
        if (o.team !== this.team && dd < nearestFoe) nearestFoe = dd;
        const mine = Math.hypot(this.group.position.x - bp.x, this.group.position.z - bp.z);
        if (dd < mine - 0.15) nearer++;
      }
      // РАНО ИЛИ ПОЗДНО — вопрос, без которого промах не починить: ожидание
      // мяча лечит только замах, дошедший до кадра контакта РАНЬШЕ мяча.
      // Мяч ещё сближается с точкой удара — значит замахнулись рано
      let closing = null;
      if (sp) {
        const rvx = b.vel.x - this.vel.x;
        const rvz = b.vel.z - this.vel.z;
        closing = (sp.x - bp.x) * rvx + (sp.z - bp.z) * rvz > 0;
      }
      hits.push({
        style,
        connected,
        closing,
        ai: !!(had && had.aiVel),
        gap: gap != null ? +gap.toFixed(2) : null,
        swing: +t0.toFixed(2),
        reach: d != null ? +d.toFixed(2) : null,
        speed: +Math.hypot(this.vel.x, this.vel.z).toFixed(2),
        ballY: +bp.y.toFixed(2),
        mine: +Math.hypot(this.group.position.x - bp.x, this.group.position.z - bp.z).toFixed(2),
        nearest: +nearestOther.toFixed(2),
        foe: +nearestFoe.toFixed(2),
        nearer,
        keeper: !!this.isKeeper,
      });
    };
    try {
      const scores = [];
      match.score = [0, 0];
      match.clock = 0;
      goals.reset();
      match.kickoff(0);
      match.state = 'kickoff';
      match.stateTimer = 0;
      for (let m = 0; m < matches; m++) {
        const limit = Math.ceil(CONFIG.match.realMinutes * 60 * 60 * 1.15);
        let frames = 0;
        while (match.state !== 'fulltime' && frames < limit) {
          for (let k = 0; k < chunk && match.state !== 'fulltime' && frames < limit; k++) {
            step(match, ball, goals);
            frames++;
          }
          await new Promise((r) => setTimeout(r, 0));
        }
        scores.push(`${match.score[0]}:${match.score[1]}`);
        match.score = [0, 0];
        match.clock = 0;
        goals.reset();
        match.kickoff(1 - match.kickoffTeam);
        match.state = 'kickoff';
        match.stateTimer = 0;
      }
      const goals_ = scores.reduce((a, s) => a + s.split(':').reduce((x, y) => x + +y, 0), 0);
      // Промах и настоящее касание — разные вещи, и мерить их вместе бессмысленно
      const real = hits.filter((h) => h.reach != null && h.connected);
      const out = {
        matches,
        scores,
        goalsPerMatch: +(goals_ / matches).toFixed(2),
        swings: hits.length,
        connects: real.length,
        // (3) ДОТЯНУЛСЯ ЛИ: расстояние точка удара → мяч в кадре контакта
        reachMed: +pct(real.map((h) => h.reach), 0.5).toFixed(2),
        reachP90: +pct(real.map((h) => h.reach), 0.9).toFixed(2),
        reachMax: real.length ? +Math.max(...real.map((h) => h.reach)).toFixed(2) : null,
        far40: real.filter((h) => h.reach > 0.4).length,
        far70: real.filter((h) => h.reach > 0.7).length,
        // (2) БЕЖАЛ ЛИ: скорость в кадре контакта
        speedMed: +pct(real.map((h) => h.speed), 0.5).toFixed(2),
        standing: real.filter((h) => h.speed < CONFIG.player.aerial.standSpeed).length,
        // (1) БЫЛ ЛИ ПЕРВЫМ: кто-то стоял к мячу ближе
        notFirst: real.filter((h) => h.nearer > 0).length,
        foeCloser: real.filter((h) => h.foe < h.mine - 0.15).length,
        // Гистограмма «промаха по ходу кадра» у НЕсостоявшихся касаний: по ней
        // и выбирается contactRadius. Если у большинства промахов зазор меньше
        // полуметра — порог режет живое, а не пустые взмахи
        missGap: [0.2, 0.35, 0.5, 0.8, 1.5].map((edge) => ({
          edge,
          n: hits.filter((h) => !h.connected && h.gap != null && h.gap <= edge).length,
        })),
        missTotal: hits.filter((h) => !h.connected && h.gap != null).length,
        // Промахи, которые ЛЕЧАТСЯ ОЖИДАНИЕМ: мяч ещё шёл к точке удара и был
        // недалеко. Всё остальное — опоздание, и ожидание там не поможет
        missEarly: hits.filter((h) => !h.connected && h.closing && h.gap != null &&
          h.gap <= 1.5).length,
        missLate: hits.filter((h) => !h.connected && h.closing === false).length,
        rows: hits,
      };
      window.AER = out;
      console.log(out);
      return out;
    } finally {
      Player.updateAerialStrike = origUpdate;
    }
  }, opts);
}

// === 3. Очная ставка: двое на один навес ===
//
// Ставим на подачу СВОЕГО и ЧУЖОГО на заданных дистанциях от точки прилёта и
// смотрим, кто сыграл мячом. Правильный ответ ровно один: тот, кто оказался
// ближе к мячу, — «первый на мяче» из фидбека. Прогоняем сеткой по форе, чтобы
// проверить обе стороны: и что нападающий не отбирает мяч у успевшего
// защитника, и что защитник не отбирает у успевшего нападающего.
export async function contestRig(opts = {}) {
  const leads = opts.leads || [-3, -2, -1, 0, 1, 2, 3];
  const frames = opts.frames != null ? opts.frames : 200;
  return harness(async ({ match, ball, goals, CONFIG }) => {
    const Player = Object.getPrototypeOf(match.allPlayers[0]);
    const origUpdate = Player.updateAerialStrike;
    let touched = null;      // кто реально сыграл мячом
    let touchGap = null;     // …и насколько его точка удара была от мяча
    const _p = new THREE.Vector3();
    Player.updateAerialStrike = function (dt, b) {
      const had = this.aerialStrike;
      const style = had ? had.styleName : null;
      const v0 = had ? b.vel.clone() : null;
      origUpdate.call(this, dt, b);
      if (!had || this.aerialStrike || touched) return;
      if (b.vel.distanceTo(v0) > 0.5) {
        touched = this;
        const sp = this.strikePointWorld(style, _p);
        touchGap = sp ? +sp.distanceTo(b.mesh.position).toFixed(2) : null;
      }
    };
    try {
      const A = match.teams[0];
      const B = match.teams[1];
      const goalX = A.attackGoalX;
      const dir = Math.sign(goalX) || 1;
      const rows = [];
      for (const lead of leads) {
        match.state = 'play';
        match.stateTimer = 0;
        match.possession = A;
        touched = null;
        touchGap = null;
        // Все прочие — в дальний угол, чтобы в эпизод не лезли. Разводим их по
        // ИНДЕКСУ, а не по `p.role`: роль у нас не число, и `28 + role * 0.4`
        // молча давало NaN — фигуры уезжали «в никуда», а вместе с ними в NaN
        // уходил и мяч после первого же касания (сутки на поиск, 29.07.2026)
        match.allPlayers.forEach((p, i) => {
          p.reset(p.team === A ? -46 : -40, 24 + (i % 11) * 0.9, 0);
        });
        // Навес с фланга. Точку прилёта НЕ ЗАДАЁМ, а СПРАШИВАЕМ у самой игры:
        // сопротивление воздуха уносит мяч заметно ближе и ниже, чем считает
        // школьная парабола, и расставленные «по замыслу» игроки оказывались
        // в стороне от эпизода вовсе (первая редакция стенда не поймала НИ
        // ОДНОГО касания за семь прогонов).
        const aim = { x: goalX - dir * 8, z: 3 };
        const from = { x: goalX - dir * 20, z: -22 };
        const T = 1.5;
        ball.mesh.position.set(from.x, 0.4, from.z);
        ball.vel.set((aim.x - from.x) / T, -CONFIG.ball.gravity * T * 0.5,
          (aim.z - from.z) / T);
        ball.spin = 0;
        const land = predictLanding(ball, 1.7) || aim;
        const att = A.players.find((p) => !p.isKeeper);
        const def = B.players.find((p) => !p.isKeeper);
        // lead > 0 — защитник ближе к точке, значит первым обязан быть он
        att.reset(land.x - dir * (3 + Math.max(0, lead)), land.z - 2.0, Math.atan2(dir, 0));
        def.reset(land.x + dir * (3 + Math.max(0, -lead)), land.z + 2.0, Math.atan2(-dir, 0));
        att.rot = Math.atan2(dir, 0);
        def.rot = Math.atan2(-dir, 0);
        A.receiver = att;
        A.receiveTarget = land;
        A.receiveTimer = 3;
        // «Первый на мяче» меряется В МИГ ПЕРВОГО КАСАНИЯ, а не на условной
        // высоте: кто в этот момент ближе к мячу, тот и должен был им сыграть.
        // Ждать, пока мяч опустится до заданной высоты, нельзя — его как раз и
        // играют выше неё, и первая редакция стенда не намерила НИЧЕГО.
        let dAtt = null;
        let dDef = null;
        let hitFrame = null;
        for (let f = 0; f < frames; f++) {
          const bp = ball.mesh.position;
          const ax = Math.hypot(att.group.position.x - bp.x, att.group.position.z - bp.z);
          const dx = Math.hypot(def.group.position.x - bp.x, def.group.position.z - bp.z);
          const v0 = _vel.copy(ball.vel);
          step(match, ball, goals);
          // Первые кадры пропускаем: подача только что подставлена руками, и
          // движок в первом же шаге правит скорость на своё
          if (f > 3 && dAtt == null && ball.vel.distanceTo(v0) > 0.5 && bp.y > 0.35) {
            dAtt = ax;
            dDef = dx;
            hitFrame = f;
            break;
          }
        }
        const expect = dAtt == null ? '?' : (dAtt < dDef ? 'att' : 'def');
        const got = touched === att ? 'att' : touched === def ? 'def' : '—';
        rows.push({
          lead,
          dAtt: dAtt != null ? +dAtt.toFixed(2) : null,
          dDef: dDef != null ? +dDef.toFixed(2) : null,
          expect,
          got,
          gap: touchGap,
          frame: hitFrame,
          ok: got === expect,
        });
      }
      const ok = rows.filter((r) => r.ok).length;
      console.log('очная ставка: мячом сыграл ПЕРВЫЙ на нём в %d случаях из %d', ok, rows.length);
      console.table(rows);
      window.CONTEST = { ok, total: rows.length, rows };
      return window.CONTEST;
    } finally {
      Player.updateAerialStrike = origUpdate;
    }
  }, opts);
}
