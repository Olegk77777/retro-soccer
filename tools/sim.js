// Стенд автосимуляции AI vs AI (Фаза 3, пункт CONCEPT.md «скрипт автосимуляции
// матчей для замера баланса»). Работает ПРЯМО В ИГРЕ: берёт живой матч из
// window.DBG, отключает человека, гоняет кадры без рендера и считает воронку
// «владение → финальная треть → штрафная → удар → гол».
//
// Правило проекта: «баланс счёта проверяем автосимуляцией, не на глаз».
// Числа отсюда — единственный честный аргумент в разговоре про баланс.
//
// Как запустить (консоль браузера на открытой игре):
//   const { runSim } = await import('./tools/sim.js');
//   await runSim({ matches: 4 });          // результат ещё и в window.SIM
//
// Ничего в игре не остаётся сломанным: все патчи снимаются в finally, после
// прогона матч перезапускается с центра.

// Шаг симуляции по умолчанию. Это ИГРОВОЕ время, а не реальное: множитель
// темпа (CONFIG.gameSpeed) стенд НЕ применяет, поэтому эталоны баланса
// сравнимы при любой настройке «Темп игры». Параметр opts.frame нужен для
// другого — проверить, что мельче шаг не двигает баланс: при темпе 80 % и
// 60 кадрах в секунду игра реально считает по 1/60 × 0.8, и точность
// заметания контактов (sweptContact) там выше, чем на эталонном шаге.
const DEFAULT_FRAME = 1 / 60;

// Ключи Match.stats, которые ведёт сам движок (Team.bump)
const STAT_KEYS = ['pass', 'passOk', 'shot', 'cross', 'save', 'hold', 'parry', 'loose'];

function zero2() {
  return [0, 0];
}

// Пустая копилка замера: всё, что не считает движок, считаем здесь
function newProbe() {
  return {
    shotDist: [[], []],      // дистанция каждого удара до чужих ворот
    shotBox: zero2(),        // ударов из штрафной (< 16.5 м по глубине)
    shotKill: zero2(),       // ударов из убойной зоны (< 14 м до ворот)
    boxTouch: zero2(),       // касаний мяча в чужой штрафной
    boxFrames: zero2(),      // кадров, когда мяч в чужой штрафной
    thirdFrames: zero2(),    // кадров, когда мяч в финальной трети
    possFrames: zero2(),     // кадров владения
    liveFrames: 0,           // кадров живой игры (мяч в игре)
    tackles: zero2(),        // подкатов начато
    intercepts: zero2(),     // перехватов (владение сменилось без удара соперника)
    goals: zero2(),
    // Кадров по состояниям матча: первый признак, что стенд где-то завис
    // (например, стандарт ждёт кнопку, которую в симуляции никто не нажмёт)
    states: {},
  };
}

// Матч → номер команды
function teamIdx(match, team) {
  return match.teams.indexOf(team);
}

export async function runSim(opts = {}) {
  const matches = opts.matches != null ? opts.matches : 3;
  // Кадров между передышками. Крупный кусок нарочно: в фоновой вкладке
  // браузер душит setTimeout до 1 раза в секунду, и мелкие куски растянули бы
  // прогон в десятки раз. 5400 кадров = 90 секунд игры за один заход.
  const chunk = opts.chunk != null ? opts.chunk : 5400;
  const quiet = !!opts.quiet;
  const FRAME = opts.frame != null ? opts.frame : DEFAULT_FRAME;

  const DBG = window.DBG;
  if (!DBG || !DBG.match) throw new Error('Матч ещё не загрузился — подожди секунду и повтори');
  const { match, ball, goals, CONFIG } = DBG;

  const F = CONFIG.field;
  const boxDepth = 16.5;
  const boxHalfZ = 20.16;

  // --- Сохраняем всё, что будем патчить ---
  const saved = {
    setControlled: match.setControlled,
    updateSwitching: match.updateSwitching,
    startIntro: match.startIntro,
    startReplay: match.startReplay,
    humanTeam: match.humanTeam,
    resetDelay: CONFIG.goal.resetDelay,
    celebTime: CONFIG.celebration.time,
    controlled: match.controlled,
  };
  const TeamProto = Object.getPrototypeOf(match.teams[0]);
  const origBump = TeamProto.bump;
  const PlayerProto = Object.getPrototypeOf(match.teams[0].players[1]);
  const origTackle = PlayerProto.startTackle;

  const probe = newProbe();
  const perMatch = [];

  // Главный цикл main.js крутит СВОИ match.update — на время замера его надо
  // остановить, иначе кадры считаются дважды. Хука для паузы в main.js нет и
  // заводить его ради стенда не нужно: перехватываем requestAnimationFrame,
  // ловим отложенный колбэк и возвращаем цикл к жизни в finally.
  const origRAF = window.requestAnimationFrame.bind(window);
  let pendingFrame = null;
  window.requestAnimationFrame = (cb) => { pendingFrame = cb; return 0; };

  try {
    // --- Человека в симуляции нет: курсор пуст, переключений нет ---
    match.setControlled = function () { this.controlled = null; };
    match.updateSwitching = function () { this.input.consumeSwitch(); };
    match.controlled = null;
    // Человеческой команды в симуляции нет ВООБЩЕ. Это важнее, чем кажется:
    // розыгрыш с центра, аут и угловой «человеческой» команды ждут нажатия
    // кнопки (updateRestart → humanTakes), и матч намертво зависает на первом
    // же ауте. Подставляем пустышку: ни одна из двух команд ей не равна.
    match.humanTeam = { players: [], fieldPlayers: [], receiver: null, receiveTimer: 0 };
    // Ни заставки, ни повторов: нам нужен футбол, а не эфир
    match.startIntro = function () { this.state = 'kickoff'; this.stateTimer = 0; };
    match.startReplay = function () { return false; };
    CONFIG.goal.resetDelay = 0.2;
    CONFIG.celebration.time = 0.1;

    // --- Хуки замера поверх счётчиков движка ---
    TeamProto.bump = function (key, n = 1) {
      origBump.call(this, key, n);
      const i = teamIdx(match, this);
      if (i < 0) return;
      if (key === 'shot') {
        const bp = ball.mesh.position;
        const d = Math.hypot(this.attackGoalX - bp.x, bp.z);
        probe.shotDist[i].push(Math.round(d * 10) / 10);
        if (this.side * bp.x > F.length / 2 - boxDepth && Math.abs(bp.z) < boxHalfZ) {
          probe.shotBox[i]++;
        }
        if (d < CONFIG.ai.shootBest) probe.shotKill[i]++;
      }
    };
    PlayerProto.startTackle = function (...args) {
      const i = this.team ? teamIdx(match, this.team) : -1;
      if (i >= 0) probe.tackles[i]++;
      return origTackle.apply(this, args);
    };

    match.score = [0, 0];
    match.clock = 0;
    match.kickoff(0);
    match.state = 'kickoff';
    match.stateTimer = 0;

    const t0 = performance.now();
    for (let m = 0; m < matches; m++) {
      const before = { stats: snapStats(match), probe: snapProbe(probe) };
      const startGoals = [...match.score];
      let frames = 0;
      // Страховка от зависания. Считается ОТ ШАГА, а не от 60 кадров в
      // секунду: на мелком шаге кадров на тот же матч уходит больше, и
      // фиксированный потолок обрубал бы матч до финального свистка.
      const limit = Math.ceil(CONFIG.match.realMinutes * 60 / FRAME * 1.15);

      // Гоняем ровно один игровой матч: до финального свистка
      while (match.state !== 'fulltime' && frames < limit) {
        for (let k = 0; k < chunk && match.state !== 'fulltime' && frames < limit; k++) {
          step(match, ball, goals, probe, F, boxDepth, boxHalfZ, FRAME);
          frames++;
        }
        await new Promise((r) => setTimeout(r, 0));
      }

      const res = {
        score: [match.score[0] - startGoals[0], match.score[1] - startGoals[1]],
        frames,
        stats: diffStats(snapStats(match), before.stats),
        probe: diffProbe(snapProbe(probe), before.probe),
      };
      perMatch.push(res);
      if (!quiet) console.log(`матч ${m + 1}: ${res.score[0]}:${res.score[1]}`, res.stats);

      // Следующий матч: движок сам сбрасывает счёт после fulltimePause,
      // но нам ждать нечего — перезапускаем вручную
      match.score = [0, 0];
      match.clock = 0;
      goals.reset();
      match.kickoff(1 - match.kickoffTeam);
      match.state = 'kickoff';
      match.stateTimer = 0;
    }

    const report = summarize(perMatch, probe, performance.now() - t0);
    window.SIM = { report, perMatch, probe };
    if (!quiet) console.log(format(report));
    return report;
  } finally {
    // --- Возвращаем игру человеку ---
    window.requestAnimationFrame = origRAF;
    if (pendingFrame) origRAF(pendingFrame); // главный цикл продолжается
    TeamProto.bump = origBump;
    PlayerProto.startTackle = origTackle;
    match.setControlled = saved.setControlled;
    match.updateSwitching = saved.updateSwitching;
    match.startIntro = saved.startIntro;
    match.startReplay = saved.startReplay;
    match.humanTeam = saved.humanTeam;
    CONFIG.goal.resetDelay = saved.resetDelay;
    CONFIG.celebration.time = saved.celebTime;
    match.score = [0, 0];
    match.clock = 0;
    goals.reset();
    match.kickoff(0);
  }
}

// Один кадр симуляции: то же, что делает главный цикл в main.js, но без
// рендера, камеры и атмосферы (они на игру не влияют)
function step(match, ball, goals, probe, F, boxDepth, boxHalfZ, FRAME) {
  match.update(FRAME);
  const replaying = match.state === 'replay' || match.state === 'celebration';
  const event = replaying ? null : ball.update(FRAME);
  if (!replaying) goals.update(FRAME);
  if (event === 'goal') match.onGoal();

  probe.states[match.state] = (probe.states[match.state] || 0) + 1;
  if (match.state !== 'play' && match.state !== 'kickoff') return;
  probe.liveFrames++;
  const bp = ball.mesh.position;
  for (let i = 0; i < 2; i++) {
    const t = match.teams[i];
    const depth = t.side * bp.x;
    if (depth > F.length / 2 - 35) probe.thirdFrames[i]++;
    if (depth > F.length / 2 - boxDepth && Math.abs(bp.z) < boxHalfZ) {
      probe.boxFrames[i]++;
      if (match.toucher && match.toucher.team === t) probe.boxTouch[i]++;
    }
    if (match.possession === t) probe.possFrames[i]++;
  }
}

function snapStats(match) {
  const o = {};
  for (const k of STAT_KEYS) o[k] = [...match.stats[k]];
  return o;
}

function diffStats(now, before) {
  const o = {};
  for (const k of STAT_KEYS) o[k] = [now[k][0] - before[k][0], now[k][1] - before[k][1]];
  return o;
}

function snapProbe(p) {
  return {
    shotBox: [...p.shotBox], shotKill: [...p.shotKill], boxTouch: [...p.boxTouch],
    boxFrames: [...p.boxFrames], thirdFrames: [...p.thirdFrames],
    possFrames: [...p.possFrames], liveFrames: p.liveFrames, tackles: [...p.tackles],
    shotDist: [p.shotDist[0].length, p.shotDist[1].length],
  };
}

function diffProbe(now, before) {
  const o = {};
  for (const k of Object.keys(now)) {
    o[k] = Array.isArray(now[k])
      ? [now[k][0] - before[k][0], now[k][1] - before[k][1]]
      : now[k] - before[k];
  }
  return o;
}

function sum2(list, key) {
  return list.reduce((a, r) => [a[0] + r[key][0], a[1] + r[key][1]], [0, 0]);
}

function summarize(perMatch, probe, ms) {
  const n = perMatch.length || 1;
  const add = (k, from) => {
    const s = perMatch.reduce((a, r) => [a[0] + from(r)[k][0], a[1] + from(r)[k][1]], [0, 0]);
    return [s[0] / n, s[1] / n];
  };
  const st = (k) => add(k, (r) => r.stats);
  const pr = (k) => add(k, (r) => r.probe);
  const scores = perMatch.map((r) => `${r.score[0]}:${r.score[1]}`);
  const totalGoals = perMatch.reduce((a, r) => a + r.score[0] + r.score[1], 0);
  const live = perMatch.reduce((a, r) => a + r.probe.liveFrames, 0) / n || 1;
  const allDist = [...probe.shotDist[0], ...probe.shotDist[1]].sort((a, b) => a - b);
  return {
    matches: perMatch.length,
    scores,
    goalsPerMatch: totalGoals / n,
    shots: st('shot'),
    shotsBox: pr('shotBox'),
    shotsKill: pr('shotKill'),
    shotMedianDist: allDist.length ? allDist[Math.floor(allDist.length / 2)] : null,
    passes: st('pass'),
    passAcc: (() => {
      const p = sum2(perMatch.map((r) => r.stats), 'pass');
      const ok = sum2(perMatch.map((r) => r.stats), 'passOk');
      return [p[0] ? Math.round((ok[0] / p[0]) * 100) : 0, p[1] ? Math.round((ok[1] / p[1]) * 100) : 0];
    })(),
    crosses: st('cross'),
    saves: st('save'),
    holds: st('hold'),
    parries: st('parry'),
    loose: st('loose'),
    tackles: pr('tackles'),
    boxTouchPct: pr('boxTouch').map((v) => Math.round((v / live) * 1000) / 10),
    finalThirdPct: pr('thirdFrames').map((v) => Math.round((v / live) * 1000) / 10),
    possessionPct: pr('possFrames').map((v) => Math.round((v / live) * 1000) / 10),
    states: probe.states,
    seconds: Math.round(ms / 100) / 10,
  };
}

function format(r) {
  const p = (a) => `${Math.round(a[0] * 10) / 10} / ${Math.round(a[1] * 10) / 10}`;
  return [
    `=== АВТОСИМУЛЯЦИЯ: ${r.matches} матч(ей) за ${r.seconds} с ===`,
    `счета: ${r.scores.join(', ')}   голов за матч: ${Math.round(r.goalsPerMatch * 100) / 100}`,
    `удары: ${p(r.shots)}  из штрафной: ${p(r.shotsBox)}  из убойной зоны: ${p(r.shotsKill)}  медиана дистанции: ${r.shotMedianDist} м`,
    `пасы: ${p(r.passes)}  точность %: ${r.passAcc.join(' / ')}  навесы: ${p(r.crosses)}`,
    `сейвы: ${p(r.saves)}  намертво: ${p(r.holds)}  отбой: ${p(r.parries)}  в опасную зону: ${p(r.loose)}`,
    `подкаты: ${p(r.tackles)}`,
    `владение %: ${r.possessionPct.join(' / ')}  финальная треть %: ${r.finalThirdPct.join(' / ')}  мяч под контролем в чужой штрафной %: ${r.boxTouchPct.join(' / ')}`,
  ].join('\n');
}

// Удобство для консоли: window.runSim() без импорта
if (typeof window !== 'undefined') window.runSim = runSim;
