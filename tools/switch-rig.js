// Стенд ПЕРЕКЛЮЧЕНИЯ КУРСОРА (сессия 58, 29.07.2026).
//
// Жалоба Олега: «игроки не всегда успевают переключиться, когда на них резко
// пас или навес идёт». Меряем ровно то, что стоит за этой фразой, — ЗАПАС
// ВРЕМЕНИ: сколько секунд проходит с момента, когда курсор оказался на
// адресате, до момента, когда тот встретился с мячом. Если запас около нуля,
// человек физически не успевает ни прицелиться, ни нажать — мяч играется сам.
//
// Ориентир: зрительная реакция человека ~0.20–0.25 с (то же число, что заложено
// вратарю в CONFIG.ai.keeper.react), плюс время на решение. Меньше 0.35 с —
// это «не успел», 0.6 с и больше — комфортно.
//
// Стенд гоняет ПОЛНЫЙ ТРАКТ ВВОДА (input.keys → input.update → match.update),
// а не дёргает resolvePass напрямую: половина жалоб такого рода живёт как раз
// в проводах между вводом и логикой.
//
// Как запустить (консоль браузера на открытой игре):
//   const sw = await import('./tools/switch-rig.js');
//   sw.switchTest();
//
// ЭТАЛОН СБОРКИ (29.07.2026, sw.handoff = 1.3). Запас у адресата:
//   пас в ноги 12 м — 0.53 с (было 0.00) · 22 м — 0.95 (было −0.02) · 32 м — 1.15
//   навес в штрафную — 1.37 с · пас в зону и заброс — курсор сразу, в момент удара
//   приём при этом ЦЕЛ: адресат забирает мяч во всех эпизодах
//
// Стенд НИЧЕГО не оставляет сломанным: все патчи снимаются в finally.

const FRAME = 1 / 60;

// Пас/навес человека и замер запаса времени у адресата.
// keys — что «нажимаем», hold — сколько кадров держим (полоска силы).
const PLAYS = [
  { имя: 'пас в ноги, 12 м', key: 'KeyS', hold: 8, dist: 12 },
  { имя: 'пас в ноги, 22 м', key: 'KeyS', hold: 16, dist: 22 },
  { имя: 'пас на ход, 18 м', key: 'KeyW', hold: 14, dist: 18 },
  { имя: 'НАВЕС в штрафную', key: 'KeyA', hold: 22, dist: 24, cross: true },
  { имя: 'заброс Q+W', key: 'KeyW', hold: 20, dist: 26, combo: true },
];

export function switchTest(opts = {}) {
  const { match, ball, goals, input, CONFIG } = window.DBG;
  const plays = opts.plays || PLAYS;
  const rows = [];

  const origRAF = window.requestAnimationFrame.bind(window);
  let pending = null;
  window.requestAnimationFrame = (cb) => { pending = cb; return 0; };
  const saved = {
    startIntro: match.startIntro,
    startReplay: match.startReplay,
    onGoal: match.onGoal,
    humanTeam: match.humanTeam,
  };
  match.startIntro = function () { this.state = 'play'; };
  match.startReplay = function () { return false; };
  match.onGoal = function () {};

  try {
    const team = match.teams[0];
    const foe = match.teams[1];
    match.humanTeam = team;

    for (const pl of plays) {
      match.state = 'play';
      ball.reset();
      ball.goalScored = false;

      // Расстановка: пасующий у центра, адресат впереди по ходу атаки.
      // Соперников уводим — стенд меряет ПРОВОДА, а не борьбу.
      // ВНИМАНИЕ: сигнатура reset — (x, z, rot), а НЕ (x, y, z): первая
      // редакция стенда перепутала порядок и ставила игроков в поперечник
      const passer = team.fieldPlayers[7];
      const mate = team.fieldPlayers[9];
      const face = Math.atan2(team.side, 0);
      let spread = -18;
      for (const p of team.players) {
        if (p === passer || p === mate) continue;
        p.reset(-team.side * 20, spread, face);      // свои — позади, не мешают
        spread += 4;
      }
      let fspread = -18;
      for (const o of foe.players) { o.reset(foe.side * 34, fspread, -face); fspread += 4; }
      passer.reset(0, 0, face);
      mate.reset(team.side * pl.dist, pl.cross ? 8 : 1.5, face);
      ball.mesh.position.set(0, CONFIG.ball.radius, 0);
      ball.vel.set(0, 0, 0);
      match.toucher = passer;
      match.lastTouch = passer;
      match.setControlled(passer, 0);

      // Даём расстановке устояться (мяч под ногой, все на местах)
      for (let i = 0; i < 20; i += 1) stepFrame(match, ball, goals, input);

      // ---- НАЖАТИЕ ----
      if (pl.combo) input.keys.add('KeyQ');
      input.keys.add(pl.key);
      for (let i = 0; i < pl.hold; i += 1) stepFrame(match, ball, goals, input);
      input.keys.delete(pl.key);
      if (pl.combo) input.keys.delete('KeyQ');

      // ---- ЗАМЕР ----
      let t = 0;
      let tFly = null;      // когда мяч реально полетел
      let tSwitch = null;   // когда курсор оказался на адресате
      let tTouch = null;    // когда адресат встретился с мячом
      let target = null;    // кого игра выбрала адресатом
      let switchedTo = null;
      for (let i = 0; i < 240; i += 1) {
        stepFrame(match, ball, goals, input);
        t += FRAME;
        if (tFly == null && Math.hypot(ball.vel.x, ball.vel.z) > 3) {
          tFly = t;
          target = team.receiver || mate;
        }
        if (tFly != null) {
          const c = match.controlled;
          if (tSwitch == null && c && c !== passer) {
            tSwitch = t;
            switchedTo = c;
          }
          // Касание ловим ФИЗИЧЕСКИ, а не по match.toucher: у паса в ноги
          // владение переписывается лишь после приёма, и по нему момент
          // встречи с мячом не поймать вовсе (первая редакция стенда честно
          // напечатала null во всех трёх пасах в ноги)
          if (tTouch == null) {
            const bp = ball.mesh.position;
            const mp = target ? target.group.position : mate.group.position;
            if (Math.hypot(bp.x - mp.x, bp.z - mp.z) < 1.2) tTouch = t;
          }
          if (tTouch != null && tSwitch != null) break;
        }
      }

      // ПРИЁМ НЕ ДОЛЖЕН СЛОМАТЬСЯ. Ранняя передача курсора отняла бы у адресата
      // автоприём, и он убежал бы от мяча — ровно на этом обжигались 22.07.
      // Поэтому доигрываем эпизод и смотрим, ЗАБРАЛ ли он мяч на самом деле
      let got = false;
      let miss = 99;
      for (let i = 0; i < 90 && !got; i += 1) {
        stepFrame(match, ball, goals, input);
        const bp = ball.mesh.position;
        const mp = (target || mate).group.position;
        miss = Math.min(miss, Math.hypot(bp.x - mp.x, bp.z - mp.z));
        if (match.toucher === (target || mate)) got = true;
      }

      const запас = tTouch != null && tSwitch != null
        ? +(tTouch - tSwitch).toFixed(2) : null;
      rows.push({
        эпизод: pl.имя,
        'мяч полетел, с': tFly != null ? +tFly.toFixed(2) : null,
        'курсор перешёл, с': tSwitch != null ? +tSwitch.toFixed(2) : null,
        'мяч встречен, с': tTouch != null ? +tTouch.toFixed(2) : null,
        'ЗАПАС, с': запас,
        // Пас В ЗОНУ отдаёт курсор в момент удара, а встречи с мячом в стенде
        // не происходит вовсе: адресат бежит в пустую зону, а «человек» здесь
        // не нажимает стрелок. Это не провал переключения, а его противоположность
        вердикт: запас == null
          ? (tSwitch != null && tSwitch < 0.2 ? 'курсор СРАЗУ (пас в зону)'
            : 'курсор НЕ перешёл')
          : (запас < 0.35 ? 'НЕ УСПЕВАЕТ' : (запас < 0.6 ? 'впритык' : 'успевает')),
        'курсор на том?': switchedTo && target
          ? (switchedTo === target ? 'да' : 'НЕТ, на другого') : '—',
        'приём': got ? 'забрал' : 'НЕ ЗАБРАЛ',
        'ближе всего, м': +miss.toFixed(2),
      });
      match.toucher = null;
    }
  } finally {
    match.startIntro = saved.startIntro;
    match.startReplay = saved.startReplay;
    match.onGoal = saved.onGoal;
    match.humanTeam = saved.humanTeam;
    input.keys.clear();
    window.requestAnimationFrame = origRAF;
    if (pending) origRAF(pending);
    ball.reset();
    match.kickoff(0);
  }
  console.table(rows);
  const bad = rows.filter((r) => r.вердикт === 'НЕ УСПЕВАЕТ' ||
    r.вердикт === 'курсор НЕ перешёл').length;
  console.log(`НЕ УСПЕВАЕТ: ${bad} из ${rows.length}`);
  window.SWRIG = rows;
  return { rows, bad };
}

// Один кадр полного тракта: ввод → матч → мяч → ворота (как в main.js)
function stepFrame(match, ball, goals, input) {
  input.update(FRAME);
  match.update(FRAME);
  const rep = match.state === 'replay' || match.state === 'celebration';
  const ev = rep ? null : ball.update(FRAME);
  if (!rep) goals.update(FRAME);
  if (ev === 'goal') match.onGoal();
}
