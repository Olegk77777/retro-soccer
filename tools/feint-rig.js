// Стенд ФИНТОВ (сессия 63, 31.07.2026).
//
// ЗАЧЕМ. Правило проекта: у каждого эффекта должен быть записанный ЧИСЛОВОЙ
// эталон, иначе после любой правки его молча потеряют, а на глаз это читается
// расплывчатым «финты не работают». У финта таких чисел три, и они про разное:
//
//   1. ЧИТАЕМОСТЬ — насколько фигура реально уходит вбок. С ТВ-камеры метр
//      газона это около 20 пикселей, и движение, которое не переставляет вес,
//      в эфире не существует, сколько бы ног ни махало в клипе.
//   2. ГЕОМЕТРИЯ ПРОБРОСА — расходятся ли мяч и игрок по РАЗНЫЕ стороны от
//      защитника (это и есть финт Ромарио) и сходятся ли они за его спиной.
//   3. КУПИЛИ ЛИ — сколько защитников клюнуло и на сколько метров уехала их
//      цель. Ноль купивших означает, что финт стоит темпа и не даёт ничего.
//
// Стенд гоняет ПОЛНЫЙ ТРАКТ ВВОДА (input.keys → input.update → match.update),
// как switch-rig: половина жалоб такого рода живёт в проводах между вводом и
// логикой, а не в самой механике.
//
// Как запустить (консоль браузера на открытой игре):
//   const F = await import('./tools/feint-rig.js');
//   F.feintGrid();     // все пять движений: читаемость, мяч, обыгранные
//   F.biteProbe();     // отдельно — кто и как покупает финт
//
// Стенд НИЧЕГО не оставляет сломанным: все патчи снимаются в finally.

const FRAME = 1 / 60;

// Пять движений и то, как их заказывают. `keys` — стрелки, которые держим в
// момент нажатия Shift (это и есть сектор выбора).
// `успех` — критерий обыгрыша, и он РАЗНЫЙ у разных движений. Первая редакция
// стенда мерила всех одной меркой «прошёл защитника по курсу» и честно
// напечатала у разворота 0 %: разворот Марадоны по построению уходит НАЗАД,
// от опеки, и «пройти мимо» он не обязан вовсе. Мерить надо то, зачем
// движение делают: степовер, проброс и ложный удар — пройти; разворот и
// крокета — уйти из-под опеки с мячом.
const MOVES = [
  { имя: 'СТЕПОВЕР (без стрелок)', keys: [], ждём: 'step', успех: 'мимо' },
  { имя: 'ПРОБРОС МИМО (вперёд)', keys: ['ArrowUp'], ждём: 'past', успех: 'мимо' },
  { имя: 'КРОКЕТА (вбок)', keys: ['ArrowRight'], ждём: 'croq', успех: 'ушёл' },
  { имя: 'РАЗВОРОТ (назад)', keys: ['ArrowDown'], ждём: 'roul', успех: 'ушёл' },
  { имя: 'ЛОЖНЫЙ УДАР (Shift+D)', keys: [], ждём: 'fake', успех: 'мимо', fake: true },
];

// ИСХОД ЭПИЗОДА, А НЕ ОДИН ПРОГОН. Финт вероятностный с двух сторон:
// защитник клюёт с вероятностью, игрок может провалить движение. По одному
// прогону «клюнули: 0» и «клюнули: 1» неотличимы от шума — первая редакция
// стенда честно напечатала ноль купивших у трёх движений из пяти, и это была
// ровно монетка, а не поломка. Гоняем каждое движение N раз и печатаем ДОЛИ.
export function feintGrid(opts = {}) {
  const { match, ball, goals, input, CONFIG } = window.DBG;
  const moves = opts.moves || MOVES;
  const tries = opts.tries != null ? opts.tries : 20;
  const rows = [];
  const harness = begin(match);
  try {
    const team = match.teams[0];
    const foe = match.teams[1];
    match.humanTeam = team;

    for (const mv of moves) {
      const agg = {
        ok: 0, wrong: 0, failed: 0, bite: 0, beat: 0, lost: 0,
        lat: 0, spin: 0, apart: 0, endGap: 0, opposite: 0, sides: 0,
      };
      for (let rep = 0; rep < tries; rep += 1) {
      // Расстановка: бежим на +Z (вверх экрана — это −Z, но нам важна не
      // сторона, а то, что курс и «вперёд» совпадают), защитник прямо по курсу
      const carrier = team.fieldPlayers[9];
      const def = foe.fieldPlayers[3];
      setup(match, ball, team, foe, carrier, def, CONFIG);

      // Разгон: держим ArrowUp (это −Z), пока игрок не поедет с мячом на
      // защитника. 25 кадров = 0.42 с — как раз до зоны, где финт покупают
      input.keys.add('ArrowUp');
      for (let i = 0; i < 25; i += 1) step(match, ball, goals, input);

      const pos0 = { x: carrier.group.position.x, z: carrier.group.position.z };
      const rot0 = carrier.rot;
      const c0 = course(carrier);

      // ---- ЗАКАЗ ФИНТА ----
      // Финт исполняется на ОТПУСКАНИИ Shift (как смена игрока на Q), поэтому
      // стенд обязан отпустить его так же, как это делает палец
      for (const k of mv.keys) input.keys.add(k);
      if (!mv.keys.includes('ArrowUp')) input.keys.delete('ArrowUp');
      input.keys.add('ShiftLeft');
      if (mv.fake) {
        // Ложный удар: Shift ЗАЖАТ, коротко жмём D и отпускаем — удар выходит
        // на отпускании, и Shift в этот миг ещё держится
        input.keys.add('KeyD');
        for (let i = 0; i < 5; i += 1) step(match, ball, goals, input);
        input.keys.delete('KeyD');
        step(match, ball, goals, input);
        input.keys.delete('ShiftLeft');
        step(match, ball, goals, input);
      } else {
        step(match, ball, goals, input);
        input.keys.delete('ShiftLeft');
        step(match, ball, goals, input);
      }

      const kind = carrier.feint ? carrier.feint.kind : (carrier.lastFeint || null);
      const failed = carrier.feint ? carrier.feint.failed : null;

      // ---- ЗАМЕР ----
      let bite = 0;
      for (const o of foe.players) if (o.ai && o.ai.feint) bite += 1;
      // Позицию защитника снимаем СЛЕПКОМ: дальше он бежит, и живая ссылка
      // сделала бы «сторону относительно защитника» бессмысленной
      const dp = {
        x: def.group.position.x, z: def.group.position.z,
        d: Math.hypot(def.group.position.x - carrier.group.position.x,
          def.group.position.z - carrier.group.position.z),
      };
      let lat = 0;          // максимальный УХОД ФИГУРЫ вбок от курса, м
      let ballSide = 0;     // сторона мяча относительно защитника
      let manSide = 0;      // …и сторона игрока
      let apart = 0;        // максимальное расхождение «мяч ↔ игрок», м
      let endGap = 0;       // …и оно же в кадре ОКОНЧАНИЯ движения
      let spin = 0;         // сколько корпус накрутил, °
      let rotPrev = carrier.rot;
      for (let i = 0; i < 90; i += 1) {
        step(match, ball, goals, input);
        const p = carrier.group.position;
        const b = ball.mesh.position;
        const dx = p.x - pos0.x;
        const dz = p.z - pos0.z;
        lat = Math.max(lat, Math.abs(dx * -c0.z + dz * c0.x));
        apart = Math.max(apart, Math.hypot(b.x - p.x, b.z - p.z));
        let d = carrier.rot - rotPrev;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        spin += Math.abs(d);
        rotPrev = carrier.rot;
        // Стороны меряем НЕЗАВИСИМО: каждый — в момент СВОЕГО траверза мимо
        // защитника. Общий кадр тут не годится, и это ловится замером: мяч
        // проходит защитника раньше игрока, и на «его» кадре игрок ещё позади,
        // а мяч ещё у ноги — первая редакция печатала «по разные стороны 10 %»
        // там, где расхождение было честным
        const alongP = (p.x - dp.x) * c0.x + (p.z - dp.z) * c0.z;
        if (Math.abs(alongP) < 0.9 && !manSide) {
          manSide = Math.sign((p.x - dp.x) * -c0.z + (p.z - dp.z) * c0.x);
        }
        const alongB = (b.x - dp.x) * c0.x + (b.z - dp.z) * c0.z;
        if (Math.abs(alongB) < 0.9 && !ballSide) {
          ballSide = Math.sign((b.x - dp.x) * -c0.z + (b.z - dp.z) * c0.x);
        }
        // РАЗРЫВ В КАДРЕ ОКОНЧАНИЯ ФИНТА — число, которое решает всё: если
        // мяч в этот миг дальше stickyRadius, липкое ведение его не подхватит
        // и движение отдаёт мяч, каким бы красивым оно ни было
        if (carrier.feint) endGap = Math.hypot(b.x - p.x, b.z - p.z);
        if (!carrier.feint && i > 30) break;
      }
      // ИСХОД ЭПИЗОДА. Продолжаем ДВИЖЕНИЕ ФИНТА (а не «вперёд всегда»:
      // разворот уходит назад, и стрелка вперёд гнала бы игрока обратно в
      // объятия защитника), догоняем мяч и через 2.5 с спрашиваем результат.
      // ВЛАДЕНИЕ СМОТРИМ ОКНОМ, А НЕ ОДНИМ КАДРОМ. Мяч после финта секунду
      // катится «ничьим», пока игрок его догоняет, и снимок ровно на 2.5 с
      // ловит эту секунду как «не наш»: у крокеты замер печатал 8 % обыгранных
      // при 13 % потерянных — то есть 79 % эпизодов не принадлежали никому.
      // Считаем владение за последние полсекунды.
      for (const k of (mv.keys.length ? mv.keys : ['ArrowUp'])) input.keys.add(k);
      let mine = false;
      let foeGot = false;
      for (let i = 0; i < 150; i += 1) {
        step(match, ball, goals, input);
        if (i < 120) continue;
        if (match.toucher && match.toucher.team === team) mine = true;
        if (match.toucher && match.toucher.team !== team) foeGot = true;
      }
      input.keys.clear();
      const cp = carrier.group.position;
      // «Ушёл» — это СОХРАНЁННОЕ ВЛАДЕНИЕ, и ничего больше. Первая редакция
      // требовала ещё и разорвать дистанцию до read.range, но защитник после
      // обыгрыша БЕЖИТ СЛЕДОМ — расстояние он восстанавливает всегда, и
      // критерий печатал 0 % там, где мяч на самом деле оставался у нас.
      const beat = mine && (mv.успех !== 'мимо' ||
        (cp.x - dp.x) * c0.x + (cp.z - dp.z) * c0.z > 0.5);
      const lost = foeGot && !mine;

      agg.ok += kind === mv.ждём ? 1 : 0;
      agg.wrong += kind === mv.ждём ? 0 : 1;
      agg.failed += failed ? 1 : 0;
      agg.bite += bite;
      agg.beat += beat ? 1 : 0;
      agg.lost += lost ? 1 : 0;
      agg.lat += lat;
      agg.spin += (spin * 180) / Math.PI;
      agg.apart += apart;
      agg.endGap += endGap;
      if (ballSide && manSide) {
        agg.sides += 1;
        agg.opposite += ballSide !== manSide ? 1 : 0;
      }
      match.toucher = null;
      }

      const pc = (n) => Math.round((n / tries) * 100);
      rows.push({
        движение: mv.имя,
        'то движение, %': pc(agg.ok),
        'провалов, %': pc(agg.failed),
        'клюнул, %': pc(agg.bite),
        'ОБЫГРАЛ, %': pc(agg.beat),
        'потерял, %': pc(agg.lost),
        'уход вбок, м': +(agg.lat / tries).toFixed(2),
        'спин, °': Math.round(agg.spin / tries),
        'разрыв в конце, м': +(agg.endGap / tries).toFixed(2),
        'разрыв макс, м': +(agg.apart / tries).toFixed(2),
        'мяч и игрок по разные стороны, %': agg.sides
          ? Math.round((agg.opposite / agg.sides) * 100) : null,
      });
    }
  } finally {
    harness();
    input.keys.clear();
    ball.reset();
    match.kickoff(0);
  }
  console.table(rows);
  window.FEINTRIG = rows;
  return rows;
}

// Покадровая трасса ОДНОГО эпизода — когда таблица показывает «не работает», а
// почему, непонятно. Печатает, кто владеет мячом, куда он катится и держится ли
// обязательство добежать. ВАЖНО: гонять только по свежезагруженной странице —
// предыдущий прогон оставляет матч в состоянии розыгрыша, а `canFeint` на нём
// молчит по построению, и трасса печатает «финта не было» вместо ответа.
export function feintTrace(opts = {}) {
  const { match, ball, goals, input, CONFIG } = window.DBG;
  const mv = (opts.moves || MOVES).find((m) => m.ждём === (opts.kind || 'past')) || MOVES[1];
  const out = [];
  const harness = begin(match);
  try {
    const team = match.teams[0];
    const foe = match.teams[1];
    match.humanTeam = team;
    const carrier = team.fieldPlayers[9];
    const def = foe.fieldPlayers[3];
    setup(match, ball, team, foe, carrier, def, CONFIG);
    input.keys.add('ArrowUp');
    for (let i = 0; i < 25; i += 1) step(match, ball, goals, input);
    for (const k of mv.keys) input.keys.add(k);
    if (!mv.keys.includes('ArrowUp')) input.keys.delete('ArrowUp');
    input.keys.add('ShiftLeft');
    step(match, ball, goals, input);
    input.keys.delete('ShiftLeft');
    step(match, ball, goals, input);
    const f = carrier.feint;
    out.push({
      '—': 'ЗАКАЗ', kind: f && f.kind, провал: f && f.failed, сторона: f && f.side,
      via: f && f.via ? `${f.via.x.toFixed(2)} / ${f.via.z.toFixed(2)}` : null,
      клюнул: !!(def.ai && def.ai.feint),
      'мяч, м/с': +Math.hypot(ball.vel.x, ball.vel.z).toFixed(2),
      'защитник': `${def.group.position.x.toFixed(2)} / ${def.group.position.z.toFixed(2)}`,
    });
    for (const k of (mv.keys.length ? mv.keys : ['ArrowUp'])) input.keys.add(k);
    for (let i = 0; i < 170; i += 1) {
      step(match, ball, goals, input);
      if (i % 10) continue;
      const p = carrier.group.position;
      const b = ball.mesh.position;
      out.push({
        '—': i, финт: carrier.feint ? 'да' : '', догон: carrier.ballApproach
          ? +carrier.ballApproach.ttl.toFixed(2) : null,
        пауза: +carrier.kickCooldown.toFixed(2),
        владеет: match.toucher ? (match.toucher === carrier ? 'мой' : 'ЧУЖОЙ') : 'ничей',
        игрок: `${p.x.toFixed(1)} / ${p.z.toFixed(1)}`,
        мяч: `${b.x.toFixed(1)} / ${b.z.toFixed(1)}`,
        разрыв: +Math.hypot(b.x - p.x, b.z - p.z).toFixed(2),
      });
    }
  } finally {
    harness();
    input.keys.clear();
    ball.reset();
    match.kickoff(0);
  }
  console.table(out);
  return out;
}

// Отдельный замер «покупки»: один и тот же финт, защитник в разных ролях и на
// разных дистанциях. Меряем ДОЛЮ клюнувших по 60 повторам — вероятность,
// подобранную на глаз, иначе не проверить.
export function biteProbe(opts = {}) {
  const { match, ball, CONFIG } = window.DBG;
  const tries = opts.tries || 60;
  const dists = opts.dists || [1.5, 2.5, 3.5, 4.5];
  const rows = [];
  const team = match.teams[0];
  const foe = match.teams[1];
  const carrier = team.fieldPlayers[9];
  const def = foe.fieldPlayers[3];
  for (const d of dists) {
    for (const jockey of [false, true]) {
      let bought = 0;
      for (let i = 0; i < tries; i += 1) {
        carrier.reset(0, 0, 0);
        def.reset(0, d, Math.PI);           // защитник впереди, лицом ко мне
        def.vel.set(0, 0, -3);              // и бежит НА меня
        if (!def.ai) def.ai = { decideCd: 0, dribDir: null };
        def.ai.feint = null;
        def.ai.jockey = jockey;
        if (carrier.sellFeint(1, 0, 1.0)) bought += 1;
      }
      rows.push({
        'до защитника, м': d,
        'роль': jockey ? 'сдерживает' : 'идёт на мяч',
        'клюнул, %': Math.round((bought / tries) * 100),
      });
    }
  }
  def.ai.feint = null;
  def.ai.jockey = false;
  console.table(rows);
  console.log('Ожидание: вплотную покупают охотно, у края read.range почти нет; ' +
    'сдерживающий — заметно реже (read.jockeyK)');
  return rows;
}

// ===== обвязка =====

function begin(match) {
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
  return () => {
    match.startIntro = saved.startIntro;
    match.startReplay = saved.startReplay;
    match.onGoal = saved.onGoal;
    match.humanTeam = saved.humanTeam;
    window.requestAnimationFrame = origRAF;
    if (pending) origRAF(pending);
  };
}

// Расстановка. КУРС ЗАДАЁТ СТРЕЛКА, А НЕ ЗДРАВЫЙ СМЫСЛ: в раскладке
// ArrowUp — это −Z (вверх ЭКРАНА), поэтому защитник обязан стоять на −Z от
// владельца. Первая редакция стенда поставила его на +Z, то есть ЗА СПИНУ, и
// честно напечатала «клюнули: 0» у всех пяти движений — стенд мерил финт в
// пустоту. Остальные двадцать уведены: меряем МЕХАНИКУ, а не борьбу.
function setup(match, ball, team, foe, carrier, def, CONFIG) {
  match.state = 'play';
  ball.reset();
  ball.goalScored = false;
  const FACE = Math.PI;              // взгляд в −Z (rot = atan2(x, z))
  let spread = -20;
  for (const p of team.players) {
    if (p === carrier) continue;
    p.reset(-34, spread, FACE);
    spread += 4;
  }
  spread = -20;
  for (const o of foe.players) {
    if (o === def) continue;
    o.reset(34, spread, 0);
    spread += 4;
    if (o.ai) o.ai.feint = null;
  }
  carrier.reset(0, 6, FACE);
  def.reset(0, 0, 0);                // прямо по курсу, лицом к владельцу
  if (!def.ai) def.ai = { decideCd: 0, dribDir: null };
  def.ai.feint = null;
  // Подкат защитнику запрещаем: стенд меряет ГЕОМЕТРИЮ обыгрыша, а слайд
  // превратил бы каждый прогон в лотерею отбора
  def.tackleCd = 99;
  carrier.feint = null;
  carrier.feintCd = 0;
  ball.mesh.position.set(0, CONFIG.ball.radius, 5.0);
  ball.vel.set(0, 0, 0);
  match.toucher = carrier;
  match.lastTouch = carrier;
  match.setControlled(carrier, 0);
}

function course(p) {
  const s = Math.hypot(p.vel.x, p.vel.z);
  if (s > 0.6) return { x: p.vel.x / s, z: p.vel.z / s };
  return { x: Math.sin(p.rot), z: Math.cos(p.rot) };
}

function step(match, ball, goals, input) {
  input.update(FRAME);
  match.update(FRAME);
  const rep = match.state === 'replay' || match.state === 'celebration';
  const ev = rep ? null : ball.update(FRAME);
  if (!rep) goals.update(FRAME);
  if (ev === 'goal') match.onGoal();
}
