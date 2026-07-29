// Стенд ЗАМЫКАНИЯ ЧЕЛОВЕКОМ: попадает ли игрок по летящему мячу и от чего это
// зависит — от МОМЕНТА нажатия или от ВРЕМЕНИ УДЕРЖАНИЯ.
//
// ЗАЧЕМ. Фидбек Олега 29.07.2026: «очень трудно попасть в тайминг навеса, чтобы
// ударить с лёта. Давай сделаем механику: пока зажата кнопка удара (или паса),
// пока мяч летит к игроку, это считается заявкой на удар; чем дольше жмёшь —
// тем сильнее и менее точно. Тайминг сместится с "попал/не попал по мячу" на
// время удержания. Но чтобы не 100 % мячей замыкались. И то же у защитника
// с выносом».
//
// Стенд гоняет ПОЛНЫЙ ТРАКТ ВВОДА (input.keys → input.update → match.update),
// а не дёргает Player.beginAerialStrike напрямую: половина жалоб такого рода
// живёт как раз в проводах между кнопкой и логикой (грабля switch-rig).
//
// Как запустить (консоль браузера на открытой игре):
//   const V = await import('./tools/volley-rig.js');
//   await V.pressGrid();          // сетка «когда нажал × сколько держал»
//   await V.pressGrid({ role: 'defender' });  // то же у защитника: вынос
//
// Как sim.js и aerial-rig.js: главный цикл останавливается перехватом
// requestAnimationFrame, все патчи снимаются в finally.

import { loftPower, predictLanding } from '../src/ai/steering.js';

const FRAME = 1 / 60;

// Один кадр полного тракта: ввод → матч → мяч → ворота (как в main.js).
// Событие мяча обязано доехать до матча, иначе голы не считаются вовсе.
function stepFrame(match, ball, goals, input) {
  input.update(FRAME);
  match.update(FRAME);
  const rep = match.state === 'replay' || match.state === 'celebration';
  const ev = rep ? null : ball.update(FRAME);
  if (!rep) goals.update(FRAME);
  if (ev === 'goal') match.onGoal();
}

// Сетка замера. press — за сколько секунд ДО прилёта мяча человек нажимает
// кнопку, hold — сколько секунд держит. Полная полоска удара = CONFIG.shot
// .chargeTime, поэтому «держать дольше» имеет смысл ровно до неё с запасом.
const PRESS = [1.60, 1.20, 0.80, 0.50, 0.30, 0.15];
const HOLD = [0.10, 0.35, 0.70];

// Расстановка эпизода. Возвращает { striker, aimGoalX, from, to }.
// Роль решает, ЧТО мы меряем: нападающий замыкает подачу у чужих ворот,
// защитник выносит ту же подачу у своих.
function setup(match, ball, CONFIG, role) {
  const team = match.teams[0];
  const foe = match.teams[1];
  const side = team.side;            // куда эта команда атакует по X
  const half = CONFIG.field.length / 2;

  // Подача летит с фланга в точку перед воротами. У нападающего это ЧУЖИЕ
  // ворота (замыкание), у защитника — СВОИ (вынос из своей штрафной).
  const goalSign = role === 'defender' ? -side : side;
  const target = { x: goalSign * (half - 9), z: 1.5 };
  const from = { x: goalSign * (half - 26), z: 24 };

  const striker = role === 'defender' ? team.fieldPlayers[2] : team.fieldPlayers[9];
  const face = Math.atan2(goalSign, 0);

  // Все остальные — далеко: стенд меряет ПРОВОДА кнопки, а не борьбу.
  let spread = -26;
  for (const p of team.players) {
    if (p === striker) continue;
    p.reset(-goalSign * 30, spread, face);
    spread += 5;
  }
  let fspread = -26;
  for (const o of foe.players) { o.reset(-goalSign * 38, fspread, -face); fspread += 5; }

  // Игрок стоит РЯДОМ с точкой прилёта, но не в ней: замыкание — это встреча
  // на ходу, и полтора метра он должен добежать сам.
  striker.reset(target.x - goalSign * 1.5, target.z - 1.0, face);
  match.setControlled(striker, 0);
  match.humanTeam = team;
  match.toucher = null;
  match.lastTouch = null;

  return { team, striker, from, target, goalSign };
}

// Запустить подачу из точки from в точку target на высоту прилёта h.
function serve(ball, CONFIG, from, target, h) {
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const dist = Math.hypot(dx, dz);
  const theta = 0.62; // навесная дуга: мяч приходит сверху, как подача с фланга
  const power = loftPower(dist, theta, h, 4, 45);
  ball.mesh.position.set(from.x, CONFIG.ball.radius, from.z);
  ball.vel.set((dx / dist) * power, power * Math.tan(theta), (dz / dist) * power);
  ball.spin = 0;
  ball.afterTouch = 0;
  ball.seq = (ball.seq || 0) + 1;
  ball.strikeAge = 0;
}

// Сколько секунд осталось до прилёта мяча в зону удара игрока: считаем прямым
// прогоном копии баллистики, а не «дистанция / скорость» — навес идёт по дуге.
function timeToReach(ball, striker, CONFIG) {
  const B = CONFIG.ball;
  let x = ball.mesh.position.x;
  let y = ball.mesh.position.y;
  let z = ball.mesh.position.z;
  let vx = ball.vel.x;
  let vy = ball.vel.y;
  let vz = ball.vel.z;
  const p = striker.group.position;
  const dt = 1 / 120;
  for (let t = 0; t < 4; t += dt) {
    vy += B.gravity * dt;
    const sp = Math.hypot(vx, vy, vz);
    if (sp > 0.01) {
      const k = Math.min(B.dragK * sp * dt, 0.5);
      vx *= 1 - k; vy *= 1 - k; vz *= 1 - k;
    }
    x += vx * dt; y += vy * dt; z += vz * dt;
    if (y < B.radius) return t;
    if (Math.hypot(x - p.x, z - p.z) < 1.2) return t;
  }
  return null;
}

export async function pressGrid(opts = {}) {
  const role = opts.role || 'striker';
  const presses = opts.press || PRESS;
  const holds = opts.hold || HOLD;
  const key = opts.key || 'KeyD';
  const { match, ball, goals, input, CONFIG } = window.DBG;

  const origRAF = window.requestAnimationFrame.bind(window);
  let pending = null;
  window.requestAnimationFrame = (cb) => { pending = cb; return 0; };
  const saved = {
    startIntro: match.startIntro,
    startReplay: match.startReplay,
    onGoal: match.onGoal,
    humanTeam: match.humanTeam,
    controlled: match.controlled,
  };
  // Патчим ИСХОД касания, а не угадываем его по скорости мяча: удар, приём и
  // промах различаются только тем, какой метод игрока сработал.
  const PP = Object.getPrototypeOf(match.teams[0].players[1]);
  const origShoot = PP.shoot;
  const origTrap = PP.trapBall;
  const origBegin = PP.beginAerialStrike;
  let ev = null;

  match.startIntro = function () { this.state = 'play'; };
  match.startReplay = function () { return false; };
  match.onGoal = function () {};
  PP.shoot = function (...args) {
    const r = origShoot.apply(this, args);
    if (ev && this === ev.striker) {
      ev.shots++;
      ev.shotAt = ev.t;
      ev.charge = args[0];
    }
    return r;
  };
  PP.trapBall = function (...args) {
    const r = origTrap.apply(this, args);
    if (ev && this === ev.striker) ev.traps++;
    return r;
  };
  PP.beginAerialStrike = function (...args) {
    if (ev && this === ev.striker) { ev.preps++; ev.prepAt = ev.t; }
    return origBegin.apply(this, args);
  };

  const rows = [];
  try {
    for (const press of presses) {
      for (const hold of holds) {
        match.state = 'play';
        ball.reset();
        ball.goalScored = false;
        input.keys.clear();
        const S = setup(match, ball, CONFIG, role);
        for (let i = 0; i < 12; i += 1) stepFrame(match, ball, goals, input);

        serve(ball, CONFIG, S.from, S.target, 1.3);
        ev = { striker: S.striker, shots: 0, traps: 0, preps: 0, t: 0, shotAt: null, prepAt: null, charge: null };

        const flight = timeToReach(ball, S.striker, CONFIG) || 1.6;
        let held = false;
        let heldLeft = 0;
        let goal = false;
        const bp = ball.mesh.position;
        // Скорость мяча ПОСЛЕ касания снимаем на следующем кадре: в самом
        // кадре удара скорость ещё старая
        let outSpeed = null;
        let outDir = null;

        for (let i = 0; i < 200; i += 1) {
          const left = flight - ev.t;
          // «Человек» жмёт кнопку за press секунд до прилёта и держит hold
          if (!held && ev.shots === 0 && left <= press) {
            input.keys.add(key);
            held = true;
            heldLeft = hold;
          } else if (held && heldLeft > 0) {
            heldLeft -= FRAME;
            if (heldLeft <= 0) input.keys.delete(key);
          }
          const wasShots = ev.shots;
          stepFrame(match, ball, goals, input);
          ev.t += FRAME;
          if (wasShots === 0 && ev.shots > 0) {
            outSpeed = ball.vel.length();
            outDir = { x: ball.vel.x, z: ball.vel.z, y: ball.vel.y };
          }
          if (ball.goalScored) { goal = true; break; }
          if (ev.t > flight + 1.6) break;
        }
        input.keys.delete(key);

        // Куда ушёл мяч: для нападающего — в створ ли, для защитника — далеко ли
        // от своих ворот (вынос считается удавшимся, если мяч ушёл из штрафной)
        const half = CONFIG.field.length / 2;
        const goalX = role === 'defender' ? -S.goalSign * half : S.goalSign * half;
        let onTarget = null;
        if (outDir) {
          const dxg = goalX - bp.x;
          const k = Math.abs(dxg) > 0.1 && Math.sign(dxg) === Math.sign(outDir.x)
            ? dxg / outDir.x : null;
          if (k != null && k > 0) {
            const zAt = bp.z + outDir.z * k;
            const yAt = bp.y + outDir.y * k + 0.5 * CONFIG.ball.gravity * k * k;
            onTarget = Math.abs(zAt) < CONFIG.goal.width / 2 && yAt > 0 && yAt < CONFIG.goal.height;
          } else onTarget = false;
        }

        rows.push({
          'нажал за, с': press,
          'держал, с': hold,
          'замах': ev.preps > 0 ? 'да' : '—',
          'исход': ev.shots > 0 ? 'УДАР' : (ev.traps > 0 ? 'приём' : 'мимо'),
          'сила заявки': ev.charge != null ? +Number(ev.charge).toFixed(2) : null,
          'скорость мяча': outSpeed != null ? +outSpeed.toFixed(1) : null,
          [role === 'defender' ? 'из штрафной' : 'в створ']: onTarget == null ? '—'
            : (role === 'defender' ? (onTarget ? 'НЕТ, в свои' : 'да') : (onTarget ? 'да' : 'нет')),
          'гол': goal ? 'ГОЛ' : '',
        });
      }
    }
  } finally {
    PP.shoot = origShoot;
    PP.trapBall = origTrap;
    PP.beginAerialStrike = origBegin;
    Object.assign(match, saved);
    input.keys.clear();
    window.requestAnimationFrame = origRAF;
    if (pending) origRAF(pending);
    ball.reset();
    match.kickoff(0);
  }

  const hits = rows.filter((r) => r.исход === 'УДАР').length;
  console.table(rows);
  console.log(`${role}: ударов ${hits} из ${rows.length}`);
  window.VRIG = rows;
  return { rows, hits, total: rows.length };
}

// ПОКАДРОВАЯ ТРАССА одного эпизода: почему замах не превратился в удар.
// Печатает состояние aerialStrike каждый кадр и причину, по которой он умер —
// промах по зазору, проигранная борьба, таймаут или срыв (сбит/подкат).
export async function traceOne(opts = {}) {
  const role = opts.role || 'striker';
  const press = opts.press != null ? opts.press : 0.8;
  const hold = opts.hold != null ? opts.hold : 0.7;
  const key = opts.key || 'KeyD';
  const { match, ball, goals, input, CONFIG } = window.DBG;

  const origRAF = window.requestAnimationFrame.bind(window);
  let pending = null;
  window.requestAnimationFrame = (cb) => { pending = cb; return 0; };
  const saved = {
    startIntro: match.startIntro, startReplay: match.startReplay,
    onGoal: match.onGoal, humanTeam: match.humanTeam, controlled: match.controlled,
  };
  match.startIntro = function () { this.state = 'play'; };
  match.startReplay = function () { return false; };
  match.onGoal = function () {};

  const PP = Object.getPrototypeOf(match.teams[0].players[1]);
  const origUpd = PP.updateAerialStrike;
  const origGap = PP._strikeGap;
  const origBegin = PP.beginAerialStrike;
  const trace = [];
  let watch = null;
  let lastGap = null;

  PP._strikeGap = function (...a) {
    const g = origGap.apply(this, a);
    if (this === watch) lastGap = g;
    return g;
  };
  PP.beginAerialStrike = function (s, ...rest) {
    if (this === watch) trace.push({ ев: 'ЗАМАХ', заряд: +Number(s.v).toFixed(2), тип: s.type });
    return origBegin.call(this, s, ...rest);
  };
  PP.updateAerialStrike = function (dt, b) {
    if (this !== watch) return origUpd.call(this, dt, b);
    const as = this.aerialStrike;
    const before = !!as;
    lastGap = null;
    const r = origUpd.call(this, dt, b);
    if (before && !this.aerialStrike) {
      const bp = b.mesh.position;
      const pp = this.group.position;
      trace.push({
        ев: 'КОНЕЦ ЗАМАХА',
        'мяч в, м': +Math.hypot(bp.x - pp.x, bp.z - pp.z).toFixed(2),
        'высота мяча': +bp.y.toFixed(2),
        'зазор, м': lastGap != null ? +lastGap.toFixed(2) : null,
        'порог': CONFIG.player.aerial.sync.contactRadius,
        't замаха': +as.t.toFixed(2),
        'hitAt': +as.hitAt.toFixed(2),
        'minDist': +as.minDist.toFixed(2),
        willMiss: as.willMiss,
        стиль: as.styleName,
      });
    }
    return r;
  };

  try {
    match.state = 'play';
    ball.reset();
    ball.goalScored = false;
    input.keys.clear();
    const S = setup(match, ball, CONFIG, role);
    watch = S.striker;
    for (let i = 0; i < 12; i += 1) stepFrame(match, ball, goals, input);
    serve(ball, CONFIG, S.from, S.target, 1.3);
    const flight = timeToReach(ball, S.striker, CONFIG) || 1.6;
    trace.push({ ев: 'ПОДАЧА', 'лететь, с': +flight.toFixed(2) });

    let t = 0;
    let held = false;
    let heldLeft = 0;
    for (let i = 0; i < 200; i += 1) {
      const left = flight - t;
      if (!held && left <= press) { input.keys.add(key); held = true; heldLeft = hold; }
      else if (held && heldLeft > 0) { heldLeft -= FRAME; if (heldLeft <= 0) input.keys.delete(key); }
      stepFrame(match, ball, goals, input);
      t += FRAME;
      const bp = ball.mesh.position;
      const pp = S.striker.group.position;
      if (Math.abs(left) < 1.4 && i % 2 === 0) {
        // Куда мяч упадёт и где игрок: если ноги не идут к точке, видно сразу
        const land = predictLanding(ball, CONFIG.player.aerial.contactY);
        trace.push({
          ев: 'кадр', 'до прилёта, с': +left.toFixed(2),
          'мяч в, м': +Math.hypot(bp.x - pp.x, bp.z - pp.z).toFixed(2),
          'высота': +bp.y.toFixed(2),
          'игрок до точки, м': land
            ? +Math.hypot(land.x - pp.x, land.z - pp.z).toFixed(2) : null,
          'скорость игрока': +Math.hypot(S.striker.vel.x, S.striker.vel.z).toFixed(1),
          замах: S.striker.aerialStrike ? 'идёт' : '—',
          pending: S.striker.pendingStrike ? S.striker.pendingStrike.type : '—',
          held: input.shot.held ? 'D' : '—',
          заряд: +input.shot.charge01.toFixed(2),
        });
      }
      if (t > flight + 1.2) break;
    }
    input.keys.delete(key);
  } finally {
    PP.updateAerialStrike = origUpd;
    PP._strikeGap = origGap;
    PP.beginAerialStrike = origBegin;
    Object.assign(match, saved);
    input.keys.clear();
    window.requestAnimationFrame = origRAF;
    if (pending) origRAF(pending);
    ball.reset();
    match.kickoff(0);
  }
  console.table(trace);
  window.VTRACE = trace;
  return trace;
}
