// Стенд ПОСЛЕДНЕЙ МИЛИ АТАКИ.
//
// Зачем. Воронка в tools/sim.js кончается ударом и печатает «мяч под контролем
// в чужой штрафной, %». На текущей сборке там 0.1 % — то есть мяч в штрафной
// соперника под контролем практически не бывает, и это записано как незакрытая
// задача. Но одно число не говорит, ГДЕ атака умирает: на входе в финальную
// треть, у линии штрафной или уже внутри. Этот стенд разбирает каждую СЕРИЮ
// ВЛАДЕНИЯ по глубине и по тому, ЧЕМ она кончилась.
//
// Принцип тот же, что у остальных стендов проекта: ничего своего не считаем,
// а вешаемся на живой матч. Перехватываем Match.prototype.update (его зовёт
// шаг sim.js ровно раз в кадр) и после каждого кадра смотрим на владение,
// глубину мяча и приросты match.stats. Матчи гоняет runSim из sim.js — второй
// копии цикла симуляции в проекте быть не должно.
//
// Как запустить (консоль браузера на открытой игре):
//   const { attackFunnel } = await import('./tools/attack-rig.js');
//   await attackFunnel({ matches: 4 });
//
// ВАЖНО: гонять по СВЕЖЕЙ странице, как и остальные стенды — предыдущий прогон
// оставляет матч в состоянии розыгрыша.

// Зоны меряются ДО ЦЕНТРА ЧУЖИХ ВОРОТ, а не до лицевой линии. Разница не
// косметическая: мяч у углового флажка стоит в 5 м от лицевой и в 35 м от
// ворот, и по «глубине» он попадал бы в убойную зону — первая редакция стенда
// именно так и врала. Штрафная — единственная зона, где нужен ПРЯМОУГОЛЬНИК
// (16.5 м по глубине и 20.16 по ширине), поэтому у неё своя проверка.
const ZONES = [
  { id: 'third', name: 'финальная треть (35 м до ворот)', r: 35 },
  { id: 'edge', name: 'подступы (25 м до ворот)', r: 25 },
  { id: 'box', name: 'ШТРАФНАЯ (16.5 × 40.3)', box: true },
  { id: 'kill', name: 'убойная зона (11 м до ворот)', r: 11 },
];

// Чем кончилась серия. Порядок проверки = приоритет: удар важнее подачи,
// подача важнее потери (потеря после подачи — это подбор соперника, а не
// «атака заглохла»).
const ENDINGS = ['shot', 'cross', 'lost', 'out', 'keeper', 'end'];

function newBucket() {
  // scorers — по СЛОТУ формации, а не по фамилии: приёмка стиля Франции-98
  // звучит как «забивает НЕ форвард», и проверять это надо позицией автора.
  // fbThird — кадры, когда крайний защитник в чужой трети (приёмка Бразилии-98
  // с её латералями). line — средняя высота линии обороны в метрах от ворот
  const b = { seqs: 0, byZone: {}, endsByZone: {}, lostAt: [], boxSec: 0,
    scorers: {}, fbThird: 0, lineSum: 0, lineN: 0, frames: 0 };
  for (const z of ZONES) {
    b.byZone[z.id] = 0;
    b.endsByZone[z.id] = {};
    for (const e of ENDINGS) b.endsByZone[z.id][e] = 0;
  }
  return b;
}

export async function attackFunnel(opts = {}) {
  const DBG = window.DBG;
  if (!DBG || !DBG.match) throw new Error('Матч ещё не загрузился — подожди секунду и повтори');
  const { match, ball, CONFIG } = DBG;
  const F = CONFIG.field;

  const buckets = [newBucket(), newBucket()];
  // Живая серия владения: чья, до какой глубины дошла, сколько передач
  let cur = null;
  // Прошлые значения счётчиков — прирост за кадр и есть событие
  const prev = { shot: [0, 0], cross: [0, 0], hold: [0, 0], pass: [0, 0] };
  const snap = (key, i) => match.stats[key][i];
  // Дистанция мяча до ЦЕНТРА чужих ворот и признак «в штрафной»
  const distGoal = (t) => {
    const bp = ball.mesh.position;
    return Math.hypot(t.attackGoalX - bp.x, bp.z);
  };
  const inBox = (t) => {
    const bp = ball.mesh.position;
    return t.side * bp.x > F.length / 2 - 16.5 && Math.abs(bp.z) < 20.16;
  };

  const MatchProto = Object.getPrototypeOf(match);
  const origUpdate = MatchProto.update;
  // Автор гола ищется тем же журналом касаний, что и в самой игре (findScorer):
  // ближайший к мячу в момент пересечения линии почти всегда вратарь
  const origGoal = MatchProto.onGoal;
  MatchProto.onGoal = function patchedGoal(...args) {
    // Сторону и автора считаем ТЕМИ ЖЕ формулами, что игра: сторона по
    // положению мяча, автор — по журналу касаний. Своей арифметики тут быть
    // не должно, иначе стенд однажды разойдётся с движком
    if (this.state === 'play' || this.state === 'kickoff') {
      const side = this.ball.mesh.position.x > 0 ? 1 : -1;
      const i = this.teams.findIndex((t) => t.side === side);
      const sc = i >= 0 ? this.findScorer(i) : null;
      if (sc) {
        const slot = CONFIG.formation.roles[sc.homeIdx].id;
        buckets[i].scorers[slot] = (buckets[i].scorers[slot] || 0) + 1;
      }
    }
    return origGoal.apply(this, args);
  };

  function closeSeq(kind) {
    if (!cur) return;
    const b = buckets[cur.i];
    b.seqs++;
    for (const z of ZONES) {
      const reached = z.box ? cur.box : cur.best <= z.r;
      if (reached) {
        b.byZone[z.id]++;
        b.endsByZone[z.id][kind] = (b.endsByZone[z.id][kind] || 0) + 1;
      }
    }
    // Где именно потеряли мяч — главный вопрос «последней мили». Пишем
    // дистанцию до чужих ворот В МОМЕНТ ПОТЕРИ, а не лучшую за серию
    if (kind === 'lost' && isFinite(cur.endDist)) b.lostAt.push(Math.round(cur.endDist));
    cur = null;
  }

  MatchProto.update = function patched(dt) {
    const r = origUpdate.call(this, dt);
    const live = this.state === 'play' || this.state === 'kickoff';
    const own = this.possession;
    const i = own ? this.teams.indexOf(own) : -1;

    // Приросты счётчиков за этот кадр
    const d = {};
    for (const k of ['shot', 'cross', 'hold', 'pass']) {
      d[k] = [snap(k, 0) - prev[k][0], snap(k, 1) - prev[k][1]];
      prev[k][0] = snap(k, 0);
      prev[k][1] = snap(k, 1);
    }

    if (!live) {
      // Мяч вышел / стандарт: серия кончилась, но это не потеря
      if (cur) closeSeq(cur.pendingEnd || 'out');
      return r;
    }
    if (i < 0) { if (cur) closeSeq(cur.pendingEnd || 'lost'); return r; }

    if (!cur || cur.i !== i) {
      // Владение сменилось. Прежняя серия кончилась потерей — если только в
      // этом же кадре не было удара или подачи (тогда виноват не отбор).
      // Вратарь соперника мог забрать мяч на кадр РАНЬШЕ смены владения,
      // поэтому смотрим не только текущий кадр (holdSeen)
      if (cur) closeSeq(cur.pendingEnd || (cur.holdT > 0 ? 'keeper' : 'lost'));
      cur = { i, best: Infinity, box: false, passes: 0, pendingEnd: null, endDist: Infinity, holdT: 0 };
    }
    // Признаки СТИЛЯ снимаем каждый кадр живой игры, независимо от владения:
    // высота линии обороны и присутствие крайних защитников в чужой трети —
    // это как раз то, что зритель видит на общем плане без единого касания
    for (let k = 0; k < 2; k++) {
      const t = this.teams[k];
      const b = buckets[k];
      b.frames++;
      b.lineSum += Math.abs(t.defLineX - t.ownGoalX);
      b.lineN++;
      for (const idx of [1, 4]) {
        const fb = t.players[idx];
        if (fb && t.side * fb.group.position.x > F.length / 2 - 35) b.fbThird++;
      }
    }

    cur.best = Math.min(cur.best, distGoal(own));
    cur.endDist = distGoal(own);
    if (inBox(own)) { cur.box = true; buckets[i].boxSec += dt; }
    cur.holdT = d.hold[1 - i] > 0 ? 0.4 : Math.max(0, cur.holdT - dt);
    if (d.pass[i] > 0) cur.passes += d.pass[i];
    // Удар и подача не обрывают серию сами (может быть добивание), но
    // запоминаются как её итог
    if (d.shot[i] > 0) cur.pendingEnd = 'shot';
    else if (d.cross[i] > 0 && !cur.pendingEnd) cur.pendingEnd = 'cross';
    return r;
  };

  // ABLATION ОДНИМ ПАРАМЕТРОМ: attackFunnel({ roles: false }) гасит ролевой
  // слой целиком и обязан вернуть числа сборки ДО ролей — это одновременно и
  // выключатель, и приёмка «база = как сейчас». Роли считаются один раз при
  // создании команды, поэтому их надо пересобрать, а не только снять флаг
  const rolesBack = CONFIG.ai.roles.enabled;
  let rolesMod = null;
  if (opts.roles === false || opts.roles === true) {
    rolesMod = await import('../src/roles.js');
    CONFIG.ai.roles.enabled = opts.roles;
    for (const t of match.teams) rolesMod.rebuildTeam(t);
  }

  try {
    const { runSim } = await import('./sim.js');
    const report = await runSim({ ...opts, quiet: true });
    closeSeq('end');
    const out = { sim: report, funnel: buckets.map((b, i) => summarize(b, opts.matches || 3, i, match)) };
    window.ATTACK = out;
    console.log(format(out));
    return out;
  } finally {
    MatchProto.update = origUpdate;
    MatchProto.onGoal = origGoal;
    if (rolesMod) {
      CONFIG.ai.roles.enabled = rolesBack;
      for (const t of match.teams) rolesMod.rebuildTeam(t);
    }
  }
}

function summarize(b, matches, i, match) {
  const per = (v) => Math.round((v / matches) * 100) / 100;
  const rows = ZONES.map((z) => {
    const n = b.byZone[z.id];
    const ends = b.endsByZone[z.id];
    return {
      zone: z.name,
      seqs: per(n),
      pct: b.seqs ? Math.round((n / b.seqs) * 1000) / 10 : 0,
      shot: per(ends.shot), cross: per(ends.cross),
      lost: per(ends.lost), out: per(ends.out), keeper: per(ends.keeper),
    };
  });
  // Гистограмма «где потеряли»: по 10 м до чужих ворот
  const hist = [0, 0, 0, 0, 0, 0];
  for (const d of b.lostAt) hist[Math.min(5, Math.floor(d / 10))]++;
  return { team: match.teams[i].data ? match.teams[i].data.name : `команда ${i}`,
    style: match.teams[i].style ? match.teams[i].style.id : '—',
    seqs: per(b.seqs), boxSec: per(Math.round(b.boxSec * 10) / 10),
    lostHist: hist.map((v) => per(v)), rows,
    // Средняя высота линии обороны, м от своих ворот
    line: b.lineN ? Math.round((b.lineSum / b.lineN) * 10) / 10 : 0,
    // Доля кадров, когда крайний защитник в чужой трети (два игрока = 200 %)
    fbThird: b.frames ? Math.round((b.fbThird / b.frames) * 1000) / 10 : 0,
    scorers: b.scorers };
}

function format(out) {
  const L = ['', '=== ВОРОНКА ПОСЛЕДНЕЙ МИЛИ (за матч) ==='];
  for (const t of out.funnel) {
    L.push('');
    L.push(`${t.team} [стиль ${t.style}]: серий владения ${t.seqs}, ` +
      `мяч под контролем в чужой штрафной ${t.boxSec} с/матч`);
    L.push(`  линия обороны ${t.line} м от своих ворот · крайние защитники в чужой трети ${t.fbThird} % кадров`);
    L.push(`  авторы голов по слотам: ${Object.entries(t.scorers)
      .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}`);
    L.push(`  где теряли мяч (м до чужих ворот): 0-10 ${t.lostHist[0]} · 10-20 ${t.lostHist[1]} · ` +
      `20-30 ${t.lostHist[2]} · 30-40 ${t.lostHist[3]} · 40-50 ${t.lostHist[4]} · 50+ ${t.lostHist[5]}`);
    L.push('  зона                            дошло  %    удар  навес  потеря  аут  вратарь');
    for (const r of t.rows) {
      L.push(`  ${r.zone.padEnd(30)} ${String(r.seqs).padStart(5)} ${String(r.pct).padStart(4)} ` +
        `${String(r.shot).padStart(5)} ${String(r.cross).padStart(6)} ${String(r.lost).padStart(7)} ` +
        `${String(r.out).padStart(4)} ${String(r.keeper).padStart(8)}`);
    }
  }
  return L.join('\n');
}

// ===== ВЫХОД ОДИН НА ОДИН (31.07.2026) =====
//
// ЗАЧЕМ. Фидбек Олега: «очень часто футболист выходит один на один с вратарём
// и отдаёт пас назад». Воронка выше этого не ловит: она считает, чем кончилась
// серия ПО ЗОНАМ, а «вышел один на один» — это не зона, а ОБСТАНОВКА (между
// мной и воротами нет полевых соперников). В матче такие эпизоды редки, и
// ловить их наблюдением значит гонять часы симуляции ради десятка случаев.
//
// Поэтому эпизод СТАВИТСЯ: нападающий с мячом на заданной дистанции до чужих
// ворот, перед ним только вратарь, защитники позади (отыгранные), партнёры —
// сзади и сбоку, как на настоящем выходе. Дальше AI решает сам, а стенд
// записывает, ЧЕМ он распорядился: удар / ведение / пас вперёд / ПАС НАЗАД.
//
// Две грабли самого стенда, обе уже стоили ложных ответов в этом проекте:
//   1) вратарь с мячом в руках — безусловный владелец (`Match.updateToucher`),
//      и флаг переживает расстановку: не сбросив его, получаешь «владеет
//      соперник» с первого кадра и пустую таблицу;
//   2) гонять только по СВЕЖЕЙ странице — прошлый прогон оставляет матч в
//      состоянии розыгрыша, а на розыгрыше половина веток молчит по построению.
const FRAME1 = 1 / 60;

function stepOne(match, ball, goals) {
  match.update(FRAME1);
  const rep = match.state === 'replay' || match.state === 'celebration';
  const ev = rep ? null : ball.update(FRAME1);
  if (!rep) goals.update(FRAME1);
  return ev;
}

export async function oneOnOne(opts = {}) {
  const { match, ball, goals, CONFIG } = window.DBG;
  const dists = opts.dist || [30, 26, 22, 18, 14];
  const reps = opts.reps || 12;
  const limit = opts.limit || 210;           // кадров на попытку (3.5 с)
  // ДОГОНЯЮЩИЙ ЗАЩИТНИК. Стерильный выход (никого ближе шести метров) в матче
  // почти не встречается: за прорвавшимся почти всегда кто-то бежит, и именно
  // он превращает «бей» в «отдай». Число — метры ПОЗАДИ нападающего;
  // null — чистый выход
  const chase = opts.chase != null ? opts.chase : null;

  const origRAF = window.requestAnimationFrame.bind(window);
  let pending = null;
  window.requestAnimationFrame = (cb) => { pending = cb; return 0; };
  const saved = {
    startIntro: match.startIntro, startReplay: match.startReplay,
    onGoal: match.onGoal, humanTeam: match.humanTeam, controlled: match.controlled,
  };
  const PP = Object.getPrototypeOf(match.teams[0].players[1]);
  const origKick = PP.aiKick;
  const origShoot = PP.aiShootHook;
  let ev = null;

  match.startIntro = function () { this.state = 'play'; };
  match.startReplay = function () { return false; };
  match.onGoal = function () { if (ev) ev.goal = true; };
  // Человека в стенде нет вовсе: обе команды компьютерные, как в sim.js
  match.humanTeam = { players: [], fieldPlayers: [], receiver: null, receiveTimer: 0 };
  match.controlled = null;

  // ЧЕМ РАСПОРЯДИЛСЯ — ловим по САМОМУ касанию, а не по скорости мяча:
  // удар, пас вперёд и пас назад различаются только направлением и силой,
  // и угадывать их по мячу — это ровно та ошибка, из-за которой стенд подачи
  // печатал «подачу», которая на деле уходила пяткой
  PP.aiKick = function (b, dir, power, lift, curl, kind) {
    if (ev && this === ev.striker && !ev.done) {
      const toGoalX = ev.side;                       // куда атакуем по X
      const along = dir.x * toGoalX;                 // >0 — вперёд к воротам
      ev.done = along > 0.35 && power > 20 ? 'удар'
        : (along > 0.15 ? 'пас вперёд' : (along < -0.15 ? 'ПАС НАЗАД' : 'пас поперёк'));
      ev.power = +power.toFixed(1);
      ev.at = +ev.dGoal.toFixed(1);
    }
    return origKick.apply(this, arguments);
  };

  const rows = [];
  try {
    for (const d of dists) {
      const tally = { 'удар': 0, 'пас вперёд': 0, 'ПАС НАЗАД': 0, 'пас поперёк': 0, 'довёл сам': 0 };
      let goals_ = 0;
      let saved_ = 0;
      let wide_ = 0;
      const shotAt = [];
      const ownF = [];
      const kickF = [];
      for (let r = 0; r < reps; r += 1) {
        // ПОЛНЫЙ СБРОС ПЕРЕД КАЖДОЙ ПОПЫТКОЙ. Первая редакция стенда сбрасывала
        // только мяч и позиции — и два прогона подряд в одной странице давали
        // ПРОТИВОРЕЧИВЫЕ числа (92 % ударов против 0 % на той же дистанции).
        // Переносилось состояние: сетка ворот держала забитый мяч (`goals`),
        // тренер помнил назначения прошлого эпизода (`receiver`, `runner`,
        // `boxRuns`), а у игроков жила память такта решений (`p.ai.carryT`,
        // `decideCd`, `dribFree` из прошлой попытки). Это ровно записанная
        // грабля проекта «гонять стенды только по свежей странице», и лечится
        // она не дисциплиной запуска, а честным сбросом здесь
        match.state = 'play';
        match.stateTimer = 0;
        match.restart = null;
        // ЧАСЫ МАТЧА ТОЖЕ СБРАСЫВАЕМ, и это не мелочь. Матч длится
        // CONFIG.match.realMinutes (6) игровых минут, а стенд наигрывает по
        // 3.5 с на попытку плюс до 2.5 с досмотра исхода: уже к третьей строке
        // таблицы часы доходили до финального свистка, матч замирал, и
        // ОСТАВШИЕСЯ строки печатали честные, но бессмысленные «0 ударов,
        // 100 % не решил». Изолированный прогон той же дистанции давал
        // 94 % ударов — вот так стенд и врёт, когда его гонят длинной серией
        match.clock = 0;
        goals.reset();
        ball.reset();
        ball.goalScored = false;
        ball.spin = 0;
        ball.afterTouch = 0;
        for (const t of match.teams) {
          t.receiver = null; t.receiveTarget = null; t.receiveTimer = 0;
          t.runner = null; t.overlapper = null; t.decoy = null; t.supporter = null;
          t.chaser = null; t.coverer = null;
          if (t.boxRuns) t.boxRuns.clear();
          if (t.marks) t.marks.clear();
          if (t.airGuards) t.airGuards.clear();
          t.phaseLock = 0;
          for (const p of t.players) {
            if (p.ai) {
              p.ai.decideCd = 0; p.ai.carryT = 0; p.ai.intent = null;
              p.ai.lastKind = null; p.ai.kindT = 0; p.ai.dribFree = null;
              p.ai.dribDir = null; p.ai.wide = false; p.ai.jockey = false;
              p.ai.feint = 0; p.ai.runCd = 0;
            }
          }
        }
        const team = match.teams[0];
        const foe = match.teams[1];
        const side = team.side;
        const half = CONFIG.field.length / 2;
        // Вратарь без мяча в руках — иначе владение с первого кадра чужое
        for (const t of match.teams) {
          const k = t.keeper;
          if (k && k.ai) { k.ai.holding = false; k.ai.holdT = 0; }
        }
        const face = Math.atan2(side, 0);
        // Нападающий: по центру, на заданной дистанции до ворот
        const striker = team.fieldPlayers[9];
        const sx = side * (half - d);
        striker.reset(sx, (r % 3 - 1) * 2.5, face);   // чуть варьируем по ширине
        // Партнёры — СЗАДИ и сбоку, как на настоящем выходе: пас назад обязан
        // быть физически доступен, иначе стенд измерит не выбор, а его отсутствие
        let k = 0;
        for (const p of team.fieldPlayers) {
          if (p === striker) continue;
          k += 1;
          p.reset(sx - side * (8 + (k % 4) * 5), ((k % 5) - 2) * 8, face);
        }
        // Защитники соперника — ПОЗАДИ нападающего (отыграны), вратарь на месте
        let j = 0;
        for (const o of foe.fieldPlayers) {
          j += 1;
          o.reset(sx - side * (6 + (j % 5) * 4), ((j % 5) - 2) * 7, -face);
        }
        // Догоняющий: ставим ПОЗАДИ и чуть сбоку, лицом к своим воротам —
        // он не перекрывает линию удара, но давит. Берём ближайшего по слоту
        if (chase != null) {
          const d1 = foe.fieldPlayers[3];
          d1.reset(sx - side * chase, striker.group.position.z + 0.8, face);
        }
        foe.keeper.reset(side * (half - 4), 0, -face);
        // Мяч — у ног нападающего
        ball.mesh.position.set(sx + side * 0.4, CONFIG.ball.radius, striker.group.position.z);
        ball.vel.set(0, 0, 0);
        ball.spin = 0;
        ball.seq = (ball.seq || 0) + 1;
        match.toucher = striker;
        match.lastTouch = striker;
        match.possession = team;

        ev = { striker, side, done: null, goal: false, dGoal: d };
        // ПОЧЕМУ УДАРА НЕ БЫЛО — вопрос отдельный от «сколько раз бил».
        // Такт решений вообще не запускается, пока мяч не у ноги (`canKick`),
        // а спринтующий владелец толкает мяч вперёд — значит «не решил» может
        // означать не «выбрал вести», а «его ни разу не спросили»
        let framesCanKick = 0;
        let framesOwn = 0;
        for (let i = 0; i < limit && !ev.done; i += 1) {
          stepOne(match, ball, goals);
          const sp = striker.group.position;
          ev.dGoal = Math.hypot(team.attackGoalX - sp.x, sp.z);
          if (match.toucher === striker) {
            framesOwn += 1;
            const db = Math.hypot(ball.mesh.position.x - sp.x, ball.mesh.position.z - sp.z);
            if (striker.kickCooldown <= 0 && db < CONFIG.player.kickRadius &&
                ball.mesh.position.y < CONFIG.player.kickMaxBallY) framesCanKick += 1;
          }
          if (ball.goalScored) break;
        }
        ev.own = framesOwn;
        ev.canKick = framesCanKick;
        if (!ev.done) { ownF.push(framesOwn); kickF.push(framesCanKick); }
        // Исход удара досматриваем ДО конца: гол, сейв вратаря или мимо.
        // Без этого «удар 100 %» ничего не говорит — бить и забивать разные вещи
        if (ev.done === 'удар') {
          const s0 = match.stats.save[0] + match.stats.hold[0] + match.stats.parry[0] +
            match.stats.save[1] + match.stats.hold[1] + match.stats.parry[1];
          for (let i = 0; i < 150 && !ball.goalScored; i += 1) stepOne(match, ball, goals);
          const s1 = match.stats.save[0] + match.stats.hold[0] + match.stats.parry[0] +
            match.stats.save[1] + match.stats.hold[1] + match.stats.parry[1];
          if (ball.goalScored) ev.goal = true;
          else if (s1 > s0) saved_ += 1;
          else wide_ += 1;
        }
        if (ev.goal || ball.goalScored) goals_ += 1;
        if (!ev.done) tally['довёл сам'] += 1;
        else { tally[ev.done] += 1; if (ev.done === 'удар') shotAt.push(ev.at); }
      }
      const pct = (n) => Math.round(n / reps * 100);
      rows.push({
        'до ворот, м': d,
        'УДАР %': pct(tally['удар']),
        'ПАС НАЗАД %': pct(tally['ПАС НАЗАД']),
        'пас вперёд %': pct(tally['пас вперёд']),
        'пас поперёк %': pct(tally['пас поперёк']),
        'не решил %': pct(tally['довёл сам']),
        'ГОЛ %': pct(goals_),
        'взял вратарь %': pct(saved_),
        'мимо %': pct(wide_),
        'бил с, м': shotAt.length
          ? +(shotAt.reduce((a, b) => a + b, 0) / shotAt.length).toFixed(1) : null,
        // У НЕРЕШИВШИХ: сколько кадров мяч был его и сколько из них он мог бить
        'владел кадров': ownF.length
          ? Math.round(ownF.reduce((a, b) => a + b, 0) / ownF.length) : null,
        'мог бить кадров': kickF.length
          ? Math.round(kickF.reduce((a, b) => a + b, 0) / kickF.length) : null,
      });
    }
  } finally {
    PP.aiKick = origKick;
    Object.assign(match, saved);
    window.requestAnimationFrame = origRAF;
    if (pending) origRAF(pending);
    ball.reset();
    match.kickoff(0);
  }
  console.table(rows);
  window.ONE = rows;
  return rows;
}
