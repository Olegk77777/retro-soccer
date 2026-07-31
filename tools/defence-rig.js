// Стенд ОБОРОНЫ (сессия 64, 31.07.2026).
//
// ЗАЧЕМ. Две жалобы заказчика про уровень сложности звучат одинаково
// расплывчато — «я выигрываю почти все навесы в штрафную» и «обвожу защиту
// даже без финтов», — и обе невозможно обсуждать без числа. Правило проекта:
// у каждой механики должен быть записанный ЧИСЛОВОЙ эталон, иначе после любой
// правки её молча потеряют.
//
//   crossDuel() — КТО ПЕРВЫЙ НА ПОДАЧЕ. Ставит честный фланговый эпизод
//                 (подающий, трое врывающихся, четвёрка защитников, вратарь),
//                 даёт тренеру обеих команд время раздать назначения, потом
//                 бьёт подачу той же баллистикой, что aiCross, и смотрит, кто
//                 сыграл в мяч первым: атака, оборона или вратарь.
//   runPast()   — ОБВОДКА БЕЗ ФИНТА. Человек ведёт мяч прямо на защитника на
//                 спринте и НЕ финтит. Считаем, сколько раз он проходит мимо
//                 с мячом, сколько раз защитник отбирает и за сколько секунд.
//
// Как запустить (консоль браузера на открытой игре):
//   const D = await import('./tools/defence-rig.js');
//   await D.crossDuel();          // 24 подачи, по 8 на каждый адрес
//   await D.runPast();            // 20 проходов
//
// Стенд НИЧЕГО не оставляет сломанным: все патчи снимаются в finally. Гонять
// ТОЛЬКО по свежезагруженной странице — предыдущий прогон оставляет матч в
// розыгрыше, а на розыгрыше половина веток молчит по построению.

import { freeSpace, loftPower } from '../src/ai/steering.js';

const FRAME = 1 / 60;

// ===== Общая обвязка =====

// Останавливаем главный цикл main.js (иначе кадры считаются дважды), убираем
// заставку, повторы и человека. Пустышка вместо humanTeam обязательна: аут
// «человеческой» команды ждёт нажатия кнопки, и стенд завис бы на первом же.
function begin(match) {
  const origRAF = window.requestAnimationFrame.bind(window);
  let pending = null;
  window.requestAnimationFrame = (cb) => { pending = cb; return 0; };
  const saved = {
    startIntro: match.startIntro,
    startReplay: match.startReplay,
    onGoal: match.onGoal,
    humanTeam: match.humanTeam,
    setControlled: match.setControlled,
    updateSwitching: match.updateSwitching,
    controlled: match.controlled,
  };
  match.startIntro = function () { this.state = 'play'; };
  match.startReplay = function () { return false; };
  return () => {
    match.startIntro = saved.startIntro;
    match.startReplay = saved.startReplay;
    match.onGoal = saved.onGoal;
    match.humanTeam = saved.humanTeam;
    match.setControlled = saved.setControlled;
    match.updateSwitching = saved.updateSwitching;
    match.controlled = saved.controlled;
    window.requestAnimationFrame = origRAF;
    if (pending) origRAF(pending);
  };
}

// ВРАТАРЬ С МЯЧОМ В РУКАХ — БЕЗУСЛОВНЫЙ ВЛАДЕЛЕЦ (см. Match.updateToucher), и
// флаг holding переживает любую расстановку игроков. Из-за него первая
// редакция runPast печатала «отобрали 100 % за 0.6 с»: чужой вратарь остался
// с мячом в руках после прошлого эпизода, владение числилось за соперником
// с первого кадра, и стенд честно закрывал попытку, не начав её.
function clearKeepers(match) {
  for (const t of match.teams) {
    const k = t.keeper;
    if (k && k.ai) { k.ai.holding = false; k.ai.holdT = 0; }
    if (k) k.gk = null;
  }
}

function step(match, ball, goals, input) {
  if (input) input.update(FRAME);
  match.update(FRAME);
  const rep = match.state === 'replay' || match.state === 'celebration';
  const ev = rep ? null : ball.update(FRAME);
  if (!rep) goals.update(FRAME);
  return ev;
}

// Кто сейчас ближе всех к мячу. Стенд ловит момент, когда мяч ПЕРЕБИТ
// (Ball.strike) — а кто именно его перебил, ball не знает. В борьбе в
// штрафной ближайший к мячу в кадре удара и есть ударивший: следующий по
// близости в наших замерах отстоит на метры.
function nearest(match, ball) {
  const bp = ball.mesh.position;
  let best = null;
  let bd = Infinity;
  for (const p of match.allPlayers) {
    const pp = p.group.position;
    const d = Math.hypot(pp.x - bp.x, pp.z - bp.z);
    if (d < bd) { bd = d; best = p; }
  }
  return { p: best, d: bd };
}

function pct(n, total) {
  return total ? Math.round((n / total) * 100) : 0;
}

// ===== 1. КТО ПЕРВЫЙ НА ПОДАЧЕ =====

// Виды подачи. АДРЕС НЕ НАЗНАЧАЕМ РУКАМИ, и это не мелочь: первая редакция
// стенда била в три фиксированные точки штрафной (5.5 / 10.5 / 6.5 м от
// лицевой) — и замер честно напечатал «никто 100 %». Причина оказалась не в
// борьбе, а в геометрии: за время расстановки врывающиеся встают в 13–20 м от
// лицевой, то есть подача в пяти метрах от линии падает ЗА ними, к вратарю, а
// то и прямо в ворота (2 «гола» без единого касания). Адресата выбираем так
// же, как aiCross: свой в штрафной с самой свободной зоной, с упреждением на
// его скорость. Различаем подачи не адресом, а ГЛУБИНОЙ — из глубины фланга
// идёт дуга под голову, с самой лицевой режется прострел низом.
const AIMS = [
  { имя: 'подача из глубины', deep: 20 },
  { имя: 'подача от лицевой', deep: 8 },
];

export async function crossDuel(opts = {}) {
  const { match, ball, goals, CONFIG } = window.DBG;
  const tries = opts.tries != null ? opts.tries : 8;       // на каждый адрес
  const settle = opts.settle != null ? opts.settle : 110;  // кадров на расстановку
  const window_ = opts.window != null ? opts.window : 150; // кадров на сам эпизод
  const aims = opts.aims || AIMS;
  const done = begin(match);

  // Человека в эпизоде нет: подачу бьёт AI, борется тоже AI. Так стенд меряет
  // САМУ МЕХАНИКУ борьбы, а не мастерство того, кто держит клавиши.
  match.humanTeam = { players: [], fieldPlayers: [], receiver: null, receiveTimer: 0 };
  match.setControlled = function () { this.controlled = null; };
  match.updateSwitching = function () { this.input.consumeSwitch(); };
  match.controlled = null;

  const BallProto = Object.getPrototypeOf(ball);
  const origStrike = BallProto.strike;
  const PlayerProto = Object.getPrototypeOf(match.teams[0].players[1]);
  const origTrap = PlayerProto.trapBall;
  let hits = [];
  BallProto.strike = function (...a) {
    hits.push(nearest(match, ball));
    return origStrike.apply(this, a);
  };
  PlayerProto.trapBall = function (...a) {
    hits.push({ p: this, d: 0 });
    return origTrap.apply(this, a);
  };

  const rows = [];
  try {
    const A = match.teams[0];   // атакует
    const B = match.teams[1];   // обороняется
    for (const aim of aims) {
      const agg = {
        attack: 0, defence: 0, keeper: 0, none: 0, goals: 0, first: [],
        atk: [], def: [], guards: 0,
      };
      for (let rep = 0; rep < tries; rep += 1) {
        // Фланг чередуем: правая и левая подачи — разные эпизоды (у защиты
        // разные ноги-стороны и разная сторона сползания блока)
        const flank = rep % 2 ? 1 : -1;
        const crosser = setupCross(match, ball, A, B, CONFIG, flank, aim.deep);

        // Даём тренеру раздать назначения: врывания в штрафную, персоналку,
        // трекинг забегающих. Мяч и подающего держим на месте — эпизод должен
        // начаться с ПОДАЧИ, а не с того, что подающий сам что-то решил
        const cp = { x: crosser.group.position.x, z: crosser.group.position.z };
        for (let i = 0; i < settle; i += 1) {
          crosser.group.position.set(cp.x, 0, cp.z);
          crosser.vel.set(0, 0, 0);
          crosser.kickCooldown = 0.5;
          if (crosser.ai) crosser.ai.decideCd = 1;
          ball.mesh.position.set(cp.x, CONFIG.ball.radius, cp.z + flank * 0.4);
          ball.vel.set(0, 0, 0);
          step(match, ball, goals, null);
        }
        crosser.kickCooldown = 0;

        // ---- ПОДАЧА ----
        // Баллистика один в один из aiCross: угол дуги из конфига, скорость из
        // угла и дистанции. Никакой «своей» формулы — иначе стенд мерил бы не
        // тот навес, который бывает в игре
        hits = [];
        const AC = CONFIG.ai.attack.cross;
        const F = CONFIG.field;
        const s = A.side;
        const t = pickTarget(A, crosser, CONFIG);
        if (!t) { agg.none += 1; continue; }
        const tx = t.x;
        const tz = t.z;
        const dx = tx - cp.x;
        const dz = tz - cp.z;
        const dist = Math.hypot(dx, dz);
        const nearByline = s * cp.x > F.length / 2 - AC.deepX;
        const theta = ((nearByline ? AC.lowAngle : AC.angle) * Math.PI) / 180;
        // СИЛУ СЧИТАЕМ ЧЕСТНОЙ БАЛЛИСТИКОЙ С DRAG, а не формулой параболы из
        // aiCross. Та берёт дальность по вакуумной формуле и умножает на 1.15,
        // то есть перелетает адрес примерно на треть: замер стенда дал у подачи
        // из глубины «никто 75 %» — мяч уходил за спины всем и за лицевую.
        // Стенд меряет БОРЬБУ, и подача обязана долетать до головы; перелёт
        // самого aiCross — отдельная беда, её ловит tools/sim.js (навесы за матч)
        const power = Math.max(10, Math.min(32,
          loftPower(dist, theta, CONFIG.player.aerial.contactY, 6, 34)));
        crosser.aiKick(ball, { x: dx / dist, z: dz / dist }, power, power * Math.tan(theta), 0, 'cross');
        A.onCrossStruck(ball);

        // ---- ЭПИЗОД ----
        // Эпизод доигрывается ДО КОНЦА, а не обрывается на первом касании:
        // нам нужен и победитель борьбы, и то, чем всё кончилось. После
        // первого касания даём ещё tail кадров — добивание тоже часть эпизода.
        let winner = null;
        let goal = false;
        let winFrame = -1;
        let atLand = null;   // кто был рядом в момент, когда мяч пришёл на голову
        for (let i = 0; i < window_; i += 1) {
          const ev = step(match, ball, goals, null);
          // «Никто не сыграл» — само по себе не ответ: непонятно, промахнулись
          // все или просто НИКОГО ТАМ НЕ БЫЛО. Снимаем расклад ровно в тот миг,
          // когда мяч опускается на высоту головы
          if (!atLand && ball.mesh.position.y < 1.9 && ball.vel.y < 0) {
            const bp = ball.mesh.position;
            const near = (team) => {
              let d = Infinity;
              for (const p of team.players) {
                if (p.isKeeper) continue;
                const pp = p.group.position;
                d = Math.min(d, Math.hypot(pp.x - bp.x, pp.z - bp.z));
              }
              return Math.round(d * 10) / 10;
            };
            atLand = { atk: near(A), def: near(B), guards: B.airGuards.size };
          }
          if (ev === 'goal') { goal = true; break; }
          if (!winner) {
            for (const k of [A.players[0], B.players[0]]) {
              if (k.ai && k.ai.holding) { winner = k; break; }
            }
            const h = hits.find((x) => x.p && x.p !== crosser);
            if (!winner && h) winner = h.p;
            if (winner) winFrame = i;
          }
          // Мяч ушёл из игры (аут, угловой, от ворот) — эпизод окончен
          if (match.state === 'restart') break;
          if (winFrame >= 0 && i - winFrame > 60) break;
        }
        if (atLand) {
          agg.atk.push(atLand.atk);
          agg.def.push(atLand.def);
          agg.guards += atLand.guards;
        }
        if (goal) agg.goals += 1;
        if (!winner) agg.none += 1;
        else if (winner.isKeeper) agg.keeper += 1;
        else if (winner.team === A) agg.attack += 1;
        else agg.defence += 1;
        if (winner) {
          agg.first.push(`${winner.team === A ? 'А' : 'О'}${winner.homeIdx}`);
        }
        await new Promise((r) => setTimeout(r, 0));
      }
      const n = tries;
      const med = (a) => (a.length
        ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
      rows.push({
        адрес: aim.имя,
        'атака %': pct(agg.attack, n),
        'оборона %': pct(agg.defence, n),
        'вратарь %': pct(agg.keeper, n),
        'никто %': pct(agg.none, n),
        голов: agg.goals,
        'ближний атаки, м': med(agg.atk),
        'ближний обороны, м': med(agg.def),
        'выброшено защитников': Math.round((agg.guards / n) * 10) / 10,
        'кто играл': agg.first.join(' '),
      });
    }
    console.table(rows);
    const tot = rows.reduce((a, r) => ({
      atk: a.atk + r['атака %'], def: a.def + r['оборона %'],
      gk: a.gk + r['вратарь %'], g: a.g + r.голов,
    }), { atk: 0, def: 0, gk: 0, g: 0 });
    const k = rows.length || 1;
    console.log(`ИТОГО: атака ${Math.round(tot.atk / k)} % · оборона ${Math.round(tot.def / k)} % · ` +
      `вратарь ${Math.round(tot.gk / k)} % · голов ${tot.g} из ${k * tries}`);
    window.CROSS = rows;
    return rows;
  } finally {
    BallProto.strike = origStrike;
    PlayerProto.trapBall = origTrap;
    done();
    match.kickoff(0);
  }
}

// Адресат подачи — один в один из aiCross: свой в чужой штрафной с самой
// свободной зоной вокруг, с упреждением 0.6 с на его скорость.
function pickTarget(A, crosser, CONFIG) {
  const F = CONFIG.field;
  const boxX = F.length / 2 - 16.5;
  let target = null;
  let bestSpace = -1;
  for (const m of A.players) {
    if (m === crosser || m.isKeeper) continue;
    const mp = m.group.position;
    if (A.side * mp.x < boxX || Math.abs(mp.z) > 20.16) continue;
    const space = freeSpace(mp.x, mp.z, A.opponents);
    if (space > bestSpace) {
      bestSpace = space;
      target = { x: mp.x + m.vel.x * 0.6, z: mp.z + m.vel.z * 0.6, p: m };
    }
  }
  return target;
}

// Фланговый эпизод: подающий у бровки, трое у штрафной, четвёрка защитников
// в своей штрафной, вратарь на линии. Остальные — далеко, чтобы не мешать
// замеру: нам нужна борьба в штрафной, а не случайный подбор из середины.
function setupCross(match, ball, A, B, CONFIG, flank, deep = 20) {
  const F = CONFIG.field;
  const s = A.side;
  const gx = A.attackGoalX;
  const face = (dx, dz) => Math.atan2(dx, dz);
  match.state = 'play';
  ball.reset();
  ball.goalScored = false;

  // Атака. ПОДАЮЩИЙ ОБЯЗАН СТОЯТЬ ЛИЦОМ В ШТРАФНУЮ, и это не косметика:
  // aiKick сперва спрашивает trickTouch, и мяч, посланный НАЗАД относительно
  // взгляда, уходит ПЯТКОЙ. Первая редакция ставила подающего лицом от ворот —
  // трасса показала подачу, которая поднялась на 0.36 м и легла ему под ноги,
  // а таблица печатала честное «никто 90 %», и виновата была не оборона
  const crosser = A.players[8];
  crosser.reset(gx - s * deep, flank * 24,
    Math.atan2(s * (deep - 10), -flank * 24));
  A.players[9].reset(gx - s * 17, flank * 5, face(s, 0));
  A.players[10].reset(gx - s * 18, -flank * 4, face(s, 0));
  A.players[7].reset(gx - s * 24, 0, face(s, 0));
  let spread = -16;
  for (const p of A.players) {
    if (p === crosser || p === A.players[9] || p === A.players[10] ||
        p === A.players[7] || p.isKeeper) continue;
    p.reset(gx - s * 45, spread, face(s, 0));
    spread += 8;
  }
  A.players[0].reset(-gx + s * 2, 0, face(s, 0));

  // Оборона: четвёрка в штрафной, полузащита на подступах
  B.players[2].reset(gx - s * 9, flank * 3, face(-s, 0));
  B.players[3].reset(gx - s * 10, -flank * 3, face(-s, 0));
  B.players[1].reset(gx - s * 12, flank * 10, face(-s, 0));
  B.players[4].reset(gx - s * 12, -flank * 10, face(-s, 0));
  spread = -12;
  for (const i of [5, 6, 7, 8]) {
    B.players[i].reset(gx - s * 26, spread, face(-s, 0));
    spread += 8;
  }
  B.players[9].reset(gx - s * 45, 6, face(-s, 0));
  B.players[10].reset(gx - s * 45, -6, face(-s, 0));
  B.players[0].reset(gx - s * 1.2, 0, face(-s, 0));
  clearKeepers(match);            // память прошлого эпизода, включая holding

  ball.mesh.position.set(gx - s * deep, CONFIG.ball.radius, flank * 24.4);
  ball.vel.set(0, 0, 0);
  match.toucher = crosser;
  match.lastTouch = crosser;
  match.possession = A;
  A.crossAir = 0;
  A.boxRuns.clear();
  A.receiver = null;
  return crosser;
}

// ===== 1б. ТРАССА ОДНОЙ ПОДАЧИ: ПОЧЕМУ НИКТО НЕ СЫГРАЛ =====
//
// `crossDuel` отвечает «кто сыграл», но на вопрос «почему НЕ сыграл никто»
// ответить не может: и 80 % «никто» при ближайшем игроке в 2.3 м, и 80 % при
// пустой штрафной печатаются одинаково. Гейтов на входе в верховую борьбу
// пять (`src/ai/fieldplayer.js`), и молчат они молча. Трасса повторяет их один
// в один и печатает по кадрам, какой именно закрыт.
//
//   await D.crossTrace({ deep: 20 })
export async function crossTrace(opts = {}) {
  const { match, ball, goals, CONFIG } = window.DBG;
  const deep = opts.deep != null ? opts.deep : 20;
  const flank = opts.flank != null ? opts.flank : -1;
  const settle = opts.settle != null ? opts.settle : 110;
  const window_ = opts.window != null ? opts.window : 150;
  const done = begin(match);
  match.humanTeam = { players: [], fieldPlayers: [], receiver: null, receiveTimer: 0 };
  match.setControlled = function () { this.controlled = null; };
  match.updateSwitching = function () { this.input.consumeSwitch(); };
  match.controlled = null;

  const rows = [];
  try {
    const A = match.teams[0];
    const B = match.teams[1];
    const crosser = setupCross(match, ball, A, B, CONFIG, flank, deep);
    const cp = { x: crosser.group.position.x, z: crosser.group.position.z };
    for (let i = 0; i < settle; i += 1) {
      crosser.group.position.set(cp.x, 0, cp.z);
      crosser.vel.set(0, 0, 0);
      crosser.kickCooldown = 0.5;
      if (crosser.ai) crosser.ai.decideCd = 1;
      ball.mesh.position.set(cp.x, CONFIG.ball.radius, cp.z + flank * 0.4);
      ball.vel.set(0, 0, 0);
      step(match, ball, goals, null);
    }
    crosser.kickCooldown = 0;

    const AC = CONFIG.ai.attack.cross;
    const F = CONFIG.field;
    const t = pickTarget(A, crosser, CONFIG);
    if (!t) { console.warn('адресата нет'); return null; }
    const dx = t.x - cp.x;
    const dz = t.z - cp.z;
    const dist = Math.hypot(dx, dz);
    const nearByline = A.side * cp.x > F.length / 2 - AC.deepX;
    const theta = ((nearByline ? AC.lowAngle : AC.angle) * Math.PI) / 180;
    const power = Math.max(10, Math.min(32,
      loftPower(dist, theta, CONFIG.player.aerial.contactY, 6, 34)));
    crosser.aiKick(ball, { x: dx / dist, z: dz / dist }, power, power * Math.tan(theta), 0, 'cross');
    A.onCrossStruck(ball);

    const AP = CONFIG.player.aerial;
    const AI = CONFIG.ai;
    let wasUp = false;
    for (let i = 0; i < window_; i += 1) {
      step(match, ball, goals, null);
      const bp = ball.mesh.position;
      // Мяч поднимается не в первом кадре: обрывать трассу по «мяч низко»
      // можно только ПОСЛЕ того, как он реально взлетел
      if (bp.y > 1.2) wasUp = true;
      if (wasUp && bp.y < 0.6) break;
      // Три ближайших к мячу полевых — только они и могут бороться
      const near = match.allPlayers
        .filter((p) => !p.isKeeper && p !== crosser)
        .map((p) => ({
          p,
          d: Math.hypot(p.group.position.x - bp.x, p.group.position.z - bp.z),
        }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);
      for (const { p, d } of near) {
        if (d > 9) continue;
        const team = p.team;
        const pre = p.predictAerialContact(ball, AP.ai.horizon);
        const toGoal = Math.hypot(team.attackGoalX - p.group.position.x, p.group.position.z);
        rows.push({
          кадр: i,
          'мяч y': Math.round(bp.y * 100) / 100,
          'мяч vy': Math.round(ball.vel.y * 10) / 10,
          'мяч v': Math.round(ball.vel.length() * 10) / 10,
          кто: `${team === A ? 'А' : 'О'}${p.homeIdx}`,
          'до мяча': Math.round(d * 100) / 100,
          роль: team.receiver === p ? 'адресат'
            : (team.airGuards && team.airGuards.has(p) ? 'страж' : '—'),
          'g:дист': d < AP.ai.prepare,
          'g:vy': ball.vel.y < AP.ai.velY,
          'g:vmin': ball.vel.length() > AP.ai.minSpeed,
          'g:cd': p.kickCooldown <= 0,
          трэппер: team.receiver === p && toGoal >= AI.aerial.headerRange,
          'прогноз y': Math.round(pre.y * 100) / 100,
          'прогноз зазор': Math.round(pre.dist * 100) / 100,
          'g:прогноз': pre.y > CONFIG.player.kickMaxBallY && pre.y <= AP.maxY &&
            pre.dist <= AP.sync.hitRadius * AP.ai.hitK,
          замах: !!p.aerialStrike,
        });
      }
    }
    console.table(rows);
    window.CROSSTRACE = rows;
    return rows;
  } finally {
    done();
    match.kickoff(0);
  }
}

// ===== 2. ОБВОДКА БЕЗ ФИНТА =====

// Человек ведёт мяч прямо на защитника на спринте и НЕ финтит. Это ровно та
// ситуация, на которую жалуется заказчик: «обвожу защиту даже без финтов».
// Успех — пройти линию защитника, СОХРАНИВ мяч (иначе это не обводка, а
// потеря с продвижением корпуса).
//
// ВЕДЁМ ВДОЛЬ ОСИ АТАКИ (X), а не поперёк поля. Первая редакция гоняла эпизод
// по Z в центре поля — и защитник честно ПЯТИЛСЯ, потому что его блок-точка
// считается между мячом и СВОИМИ ВОРОТАМИ, а ворота при таком беге сбоку.
// Замер печатал «отобрали 100 % за 0.63 с», хотя отбора не было вовсе:
// сдерживание в этой геометрии вырождается, и мерить было нечего.
export async function runPast(opts = {}) {
  const { match, ball, goals, input, CONFIG } = window.DBG;
  const tries = opts.tries != null ? opts.tries : 20;
  const limit = opts.limit != null ? opts.limit : 240;  // кадров на попытку
  const gap0 = opts.gap != null ? opts.gap : 8;         // м между ними на старте
  const done = begin(match);
  const rows = { прошёл: 0, отобрали: 0, застрял: 0, время: [], зазор: [] };
  try {
    const team = match.teams[0];
    const foe = match.teams[1];
    const s = team.side;
    match.humanTeam = team;
    for (let rep = 0; rep < tries; rep += 1) {
      const carrier = team.fieldPlayers[9];
      const def = foe.fieldPlayers[3];
      setupRun(match, ball, team, foe, carrier, def, CONFIG, gap0);
      input.keys.clear();
      input.keys.add(s > 0 ? 'ArrowRight' : 'ArrowLeft');  // на чужие ворота
      input.keys.add('KeyE');                              // спринт
      let outcome = null;
      let frames = 0;
      let foeFrames = 0;   // подряд кадров, что мяч у соперника
      let pastAt = -1;     // кадр, на котором прошли линию защитника
      const d0 = s * def.group.position.x;   // глубина защитника на старте
      for (let i = 0; i < limit && !outcome; i += 1) {
        step(match, ball, goals, input);
        frames = i;
        const cp = carrier.group.position;
        const bp = ball.mesh.position;
        // ВЛАДЕНИЕ СМОТРИМ ОКНОМ, А НЕ ОДНИМ КАДРОМ. Мяч, прокинутый мимо
        // защитника, на пару кадров оказывается ближе к НЕМУ — и одиночный
        // снимок читает это как отбор: первая редакция печатала «отобрали
        // 95 %» там, где на трассе игрок спокойно уходил с мячом
        foeFrames = (match.toucher && match.toucher.team === foe) ? foeFrames + 1 : 0;
        if (foeFrames > 15) { outcome = 'отобрали'; break; }
        if (pastAt < 0 && s * cp.x > d0 + 1.0) pastAt = i;
        // Прошёл линию — доигрываем ещё 40 кадров: обводка засчитывается,
        // только если мяч ОСТАЛСЯ нашим (прокинуть мимо и не догнать — не она)
        if (pastAt >= 0 && i - pastAt > 40) {
          const gap = Math.hypot(bp.x - cp.x, bp.z - cp.z);
          const mine = match.toucher === carrier ||
            (match.possession === team && gap < CONFIG.player.stickyRadius + 1.2);
          outcome = mine ? 'прошёл' : 'застрял';
          // Зазор пишем ТОЛЬКО у удавшихся проходов: у «застрял» он равен
          // тому, насколько далеко улетел потерянный мяч, и в общей медиане
          // эти десятки метров перебивают настоящие полтора
          if (mine) rows.зазор.push(Math.round(gap * 100) / 100);
        }
      }
      rows[outcome || 'застрял'] += 1;
      rows.время.push(Math.round((frames / 60) * 100) / 100);
      input.keys.clear();
      await new Promise((r) => setTimeout(r, 0));
    }
    const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
    const out = {
      попыток: tries,
      'прошёл %': pct(rows.прошёл, tries),
      'отобрали %': pct(rows.отобрали, tries),
      'застрял %': pct(rows.застрял, tries),
      'медиана времени, с': med(rows.время),
      'медиана зазора мяч↔игрок, м': med(rows.зазор),
    };
    console.table([out]);
    window.RUNPAST = out;
    return out;
  } finally {
    input.keys.clear();
    done();
    match.kickoff(0);
  }
}

function setupRun(match, ball, team, foe, carrier, def, CONFIG, gap0 = 8) {
  match.state = 'play';
  ball.reset();
  ball.goalScored = false;
  const s = team.side;
  const gx = team.attackGoalX;
  const face = (dx) => Math.atan2(dx, 0);
  // Эпизод ставим в 35 м от чужих ворот: это подступы к финальной трети, где
  // обводка и случается. Ближе — вмешается вратарь, дальше — соперник не
  // считает эпизод опасным (desperateK в подкатах привязан к своей трети)
  const startDepth = 35;
  let spread = -22;
  for (const p of team.players) {
    if (p === carrier) continue;
    p.reset(gx - s * 60, spread, face(s));
    spread += 5;
  }
  spread = -22;
  for (const o of foe.players) {
    if (o === def) continue;
    o.reset(gx - s * 8, spread, face(-s));
    spread += 5;
    if (o.ai) o.ai.feint = null;
  }
  carrier.reset(gx - s * startDepth, 0, face(s));
  def.reset(gx - s * (startDepth - gap0), 0, face(-s));
  if (!def.ai) def.ai = { decideCd: 0, dribDir: null };
  def.ai.feint = null;
  def.tackleCd = 0;                  // подкат РАЗРЕШЁН: это и есть предмет замера
  carrier.feint = null;
  carrier.feintCd = 99;              // финты запрещены — «даже без финтов»
  clearKeepers(match);
  ball.mesh.position.set(gx - s * (startDepth - 1), CONFIG.ball.radius, 0);
  ball.vel.set(0, 0, 0);
  match.toucher = carrier;
  match.lastTouch = carrier;
  match.possession = team;
  match.setControlled(carrier, 0);
}

if (typeof window !== 'undefined') {
  window.crossDuel = crossDuel;
  window.crossTrace = crossTrace;
  window.runPast = runPast;
}
