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
