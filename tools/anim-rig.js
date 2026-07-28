// Стенд анимации: «дёрганость» ЧИСЛОМ, а не на глаз.
//
// ЗАЧЕМ. Правило проекта: у каждого эффекта должен быть записанный числовой
// эталон, иначе после любой правки его молча потеряют, а на глаз это читается
// расплывчатым «стало дёргано». Для света такие стенды уже есть (tools/tv-rig.js),
// для вратаря тоже (tools/gk-rig.js) — этот про позу игрока.
//
// ЧТО МЕРЯЕТ. Мерить надо ВТОРУЮ производную, а не первую, и это не придирка:
// первый заход считал поворот кости за кадр — и обвинил в дёрганости СПРИНТ
// (медиана 14.6°/кадр против 10.9 у клипа удара). Быстрый мах ногой и есть
// быстрый поворот, глаз на него не жалуется. Дёрганость — это РАЗРЫВ СКОРОСТИ:
// поза только что ехала с одной скоростью, а в следующем кадре с другой.
// Поэтому величина замера — |ω(n) − ω(n−1)| в градусах на кадр в квадрате.
// У плавного клипа она мала на любой скорости; у стыка двух клипов, у прыжка
// на стартовый кадр и у обрыва хвоста получается ПИК.
// Замер идёт с разбивкой по тому, ЧТО игрок в этот момент делал (шаговая
// ступень или имя одноразового клипа), — сразу видно, какое действие дёргается.
//
// Как запустить (консоль браузера на открытой игре):
//   const R = await import('./tools/anim-rig.js');
//   await R.runJerk({ seconds: 90 });     // общий замер по живому матчу
//   await R.tackleTrace();                // покадровая распечатка подката
//   await R.aerialTrace();                // навес: пятится ли игрок, зависает ли мяч
//
// Как и sim.js, стенд останавливает главный цикл перехватом requestAnimationFrame
// и снимает все патчи в finally.

import * as THREE from 'three';

const FRAME = 1 / 60;
const RAD2DEG = 180 / Math.PI;
const _tmp = new THREE.Vector3();

// Кости, по которым судим о позе. Кисти и пальцы не берём: у них своя мелкая
// жизнь, и они забивают максимум, ничего не говоря о читаемости фигуры.
const WATCH = /Hips|Spine|Neck|Head|(Left|Right)(Shoulder|Arm|ForeArm|UpLeg|Leg|Foot|ToeBase)$/;

function bonesOf(player) {
  const out = [];
  if (!player.model) return out;
  player.model.traverse((o) => {
    if (o.isBone && WATCH.test(o.name)) out.push(o);
  });
  return out;
}

// Угол между двумя кватернионами в градусах
function quatAngle(a, b) {
  const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, d)) * RAD2DEG;
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

// Что игрок делает в этот кадр — ключ для разбивки замера
function actOf(p) {
  if (p.oneShot) return 'clip:' + (p.currentName || '?');
  if (p.tackleT > 0) return 'tackle';
  if (p.downT > 0) return 'down';
  if (p.diveT > 0) return 'dive';
  return 'loco:' + (p.locoName || 'idle');
}

// Общая обвязка: остановить главный цикл, отключить человека, вернуть всё назад
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

// Один кадр матча без рендера
function step(match, ball, goals) {
  match.update(FRAME);
  ball.update(FRAME);
  if (goals && goals.update) goals.update(FRAME, ball);
}

// === 1. Рывок позы по живому матчу ===
//
// Возвращает: по каждому действию — сколько кадров, медиана и хвосты рывка,
// и сколько кадров превысили порог. Порог 8°/кадр² подобран по живому замеру:
// чистые шаговые ступени (лестница бега, ради которой всё и затевалось)
// держатся заметно ниже него на любой скорости.
export async function runJerk(opts = {}) {
  const seconds = opts.seconds != null ? opts.seconds : 90;
  const pop = opts.pop != null ? opts.pop : 8;
  const chunk = opts.chunk != null ? opts.chunk : 1800;

  return harness(async ({ match, ball, goals }) => {
    match.kickoff(0);
    match.state = 'kickoff';
    match.stateTimer = 0;
    // Прогрев: модели могли ещё не приехать
    for (let i = 0; i < 60; i++) step(match, ball, goals);

    const watched = [];
    for (const t of match.teams) {
      for (const p of t.players) {
        const b = bonesOf(p);
        if (b.length) {
          watched.push({
            p,
            bones: b,
            prev: b.map((x) => x.quaternion.clone()),
            vel: new Float64Array(b.length),   // угловая скорость кости, °/кадр
          });
        }
      }
    }
    if (!watched.length) throw new Error('Кости не найдены — модель ещё не загрузилась');

    const byAct = new Map();
    const worst = [];
    const total = Math.round(seconds * 60);
    for (let f = 0; f < total; f += chunk) {
      const n = Math.min(chunk, total - f);
      for (let k = 0; k < n; k++) {
        step(match, ball, goals);
        for (const w of watched) {
          let mx = 0;
          let who = '';
          for (let i = 0; i < w.bones.length; i++) {
            const q = w.bones[i].quaternion;
            const v = quatAngle(w.prev[i], q);          // скорость, °/кадр
            const a = Math.abs(v - w.vel[i]);            // рывок, °/кадр²
            if (a > mx) { mx = a; who = w.bones[i].name; }
            w.vel[i] = v;
            w.prev[i].copy(q);
          }
          const act = actOf(w.p);
          let e = byAct.get(act);
          if (!e) { e = { n: 0, pops: 0, all: [] }; byAct.set(act, e); }
          e.n++;
          if (mx > pop) e.pops++;
          e.all.push(mx);
          if (mx > pop * 2) worst.push({ act, bone: who, deg: +mx.toFixed(1) });
        }
      }
      await new Promise((r) => setTimeout(r, 0));
    }

    const rows = [];
    let allFrames = 0;
    let allPops = 0;
    for (const [act, e] of byAct) {
      allFrames += e.n;
      allPops += e.pops;
      rows.push({
        act,
        frames: e.n,
        p50: +pct(e.all, 0.5).toFixed(2),
        p95: +pct(e.all, 0.95).toFixed(2),
        p99: +pct(e.all, 0.99).toFixed(2),
        max: +Math.max(...e.all).toFixed(1),
        pops: e.pops,
        popPct: +((e.pops / e.n) * 100).toFixed(2),
      });
    }
    rows.sort((a, b) => b.p99 - a.p99);
    const report = {
      seconds,
      popThreshold: pop,
      frames: allFrames,
      pops: allPops,
      popPct: +((allPops / allFrames) * 100).toFixed(3),
      rows,
      worstSample: worst.slice(0, 20),
    };
    window.ANIMJERK = report;
    console.log('Ф-98 · рывок позы, порог %d°/кадр: %s%% кадров', pop, report.popPct);
    console.table(rows);
    return report;
  }, opts);
}

// === 1b. Паспорт клипа: кадр контакта, замах, проводка, фазы ===
//
// ЗАЧЕМ ЗДЕСЬ, А НЕ В BLENDER. Мерить надо в тех же координатах, в которых
// живёт игра: с личным масштабом фигуры, с нашими осями и с тем же ригом, по
// которому потом считаются точки удара (Player.strikePointWorld). Блендер даёт
// сырые числа рига, и их каждый раз приходится переводить руками.
//
// ГЛАВНОЕ ПРАВИЛО ЗАМЕРА (грабля, стоившая правоногому пасу всей достоверности):
// кадр контакта ищется по проекции скорости носка НА НАПРАВЛЕНИЕ УДАРА при
// стопе НИЗКО, а НЕ по модулю скорости. У модуля максимум приходится на фазу
// ОТДЁРГИВАНИЯ ноги назад-вверх — именно так в конфиг попал контакт `kick_r`
// на 0.467 с вместо настоящих 0.136, и большинство пасов играло возвратом ноги.
export async function clipProbe(names, opts = {}) {
  const steps = opts.steps != null ? opts.steps : 120;
  return harness(async ({ match }) => {
    const p = match.teams[0].players.find((x) => !x.isKeeper && x.model);
    if (!p) throw new Error('Модель ещё не загрузилась');
    p.reset(0, 0, 0);                       // взгляд в +Z: «вперёд» = локальная +Z
    const g = p.group;
    const bones = {
      hips: p.model.getObjectByName('mixamorigHips'),
      lToe: p.model.getObjectByName('mixamorigLeftToeBase'),
      rToe: p.model.getObjectByName('mixamorigRightToeBase'),
      head: p.model.getObjectByName('mixamorigHead'),
      lHand: p.model.getObjectByName('mixamorigLeftHand'),
    };
    const inv = new THREE.Matrix4();
    const list = Array.isArray(names) ? names : [names];
    const out = {};
    for (const name of list) {
      const a = p.actions[name];
      if (!a) { out[name] = { error: 'нет такого клипа' }; continue; }
      for (const n in p.actions) p.actions[n].setEffectiveWeight(0);
      if (p.loco) for (const n in p.loco) p.loco[n].w = 0;
      a.reset(); a.enabled = true; a.setEffectiveWeight(1); a.timeScale = 0; a.play();
      const dur = a.getClip().duration;
      const rows = [];
      for (let i = 0; i <= steps; i++) {
        a.time = (i / steps) * dur;
        p.mixer.update(0);
        g.updateMatrixWorld(true);
        inv.copy(g.matrixWorld).invert();
        const s = { t: (i / steps) * dur };
        for (const k in bones) {
          if (!bones[k]) continue;
          const v = bones[k].getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
          s[k] = { x: v.x, y: v.y, z: v.z };
        }
        rows.push(s);
      }
      a.setEffectiveWeight(0); a.stop();
      const dt = dur / steps;
      // Скорость носка ВПЕРЁД (по локальной +Z) при стопе ниже 0.7 м
      const scan = (key) => {
        let best = { v: -Infinity, t: 0 };
        let backMost = { z: Infinity, t: 0 };
        let fwdMost = { z: -Infinity, t: 0 };
        for (let i = 1; i < rows.length; i++) {
          const a0 = rows[i - 1][key];
          const a1 = rows[i][key];
          if (!a0 || !a1) continue;
          const v = (a1.z - a0.z) / dt;
          if (a1.y < 0.7 && v > best.v) best = { v, t: rows[i].t };
          if (a1.z < backMost.z) backMost = { z: a1.z, t: rows[i].t };
          if (a1.z > fwdMost.z) fwdMost = { z: a1.z, t: rows[i].t };
        }
        return { peak: +best.v.toFixed(2), at: +best.t.toFixed(3),
          back: +backMost.z.toFixed(3), backAt: +backMost.t.toFixed(3),
          fwd: +fwdMost.z.toFixed(3), fwdAt: +fwdMost.t.toFixed(3) };
      };
      const L = scan('lToe');
      const R = scan('rToe');
      const hipsY = rows.map((r) => r.hips && r.hips.y).filter((x) => x != null);
      const foot = L.peak >= R.peak ? 'L' : 'R';
      const S = foot === 'L' ? L : R;
      out[name] = {
        dur: +dur.toFixed(3), foot, contact: S.at, peak: S.peak,
        windupAt: S.backAt, windupZ: S.back, extentAt: S.fwdAt, extentZ: S.fwd,
        L, R,
        hipsMin: +Math.min(...hipsY).toFixed(3), hipsMax: +Math.max(...hipsY).toFixed(3),
        hipsStart: +hipsY[0].toFixed(3), hipsEnd: +hipsY[hipsY.length - 1].toFixed(3),
        // Куда таз опускается ниже 0.45 м (то есть фигура на газоне)
        groundFrom: +(rows.find((r) => r.hips && r.hips.y < 0.45) || { t: -1 }).t.toFixed(3),
        groundTo: +([...rows].reverse().find((r) => r.hips && r.hips.y < 0.45) || { t: -1 }).t.toFixed(3),
      };
    }
    window.CLIPS = out;
    console.table(Object.entries(out).map(([k, v]) => ({ clip: k, ...v, L: undefined, R: undefined })));
    return out;
  }, opts);
}

// === 1d. Корпус в ударе: куда уходит голова и стоит ли на месте носок ===
//
// Два числа на каждую ситуацию. ГОЛОВА показывает, читается ли наклон вообще
// (с игрового плана фигура 30–60 пикселей, и сдвиг головы на 0.2 м — это как
// раз то, что видно). НОСОК обязан остаться на месте: кадры контакта вымерены
// по риггу, и если наклон корпуса сдвинет бутсу, развалится весь синхрон.
//
// Мерить ОБЯЗАТЕЛЬНО внутри harness: главный цикл игры каждый кадр заново
// раскладывает позу, и без остановки цикла замер показывает чужую работу.
export async function leanProbe(opts = {}) {
  const clip = opts.clip || 'kick_run';
  return harness(async ({ match, CONFIG }) => {
    const p = match.teams[0].players.find((x) => !x.isKeeper && x.model);
    if (!p) throw new Error('модель не загрузилась');
    const head = p.model.getObjectByName('mixamorigHead');
    const toe = p.model.getObjectByName('mixamorigRightToeBase');
    const inv = new THREE.Matrix4();
    const grab = () => {
      p.group.updateMatrixWorld(true);
      inv.copy(p.group.matrixWorld).invert();
      return {
        h: head.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv),
        t: toe.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv),
      };
    };
    const a = p.actions[clip];
    const setPose = () => {
      for (const n in p.actions) p.actions[n].setEffectiveWeight(0);
      if (p.loco) for (const n in p.loco) p.loco[n].w = 0;
      a.reset(); a.enabled = true; a.setEffectiveWeight(1); a.timeScale = 0; a.play();
      a.time = CONFIG.player.anim.contact[clip] || 0.3;
      p.mixer.update(0);
    };
    // ПРОГРЕВ ОБЯЗАТЕЛЕН. Первый mixer.update после reset() не даёт устоявшейся
    // позы, и снятая на нём база уезжает: контрольный замер «без наклона»
    // показывал сдвиг головы на 0.753 м, которого нет. Гоняем вхолостую и
    // берём за базу именно КОНТРОЛЬ — позу без наклона, снятую тем же путём.
    for (let i = 0; i < 4; i++) setPose();
    p._leanP = 0; p._leanR = 0; p._leanA = 0; p._leanT = 0; p._leanWant = null;
    setPose();
    const base = grab();

    const cases = opts.cases || [
      ['настильный низом', { lift: 1, power: 1.0, foot: 'R' }],
      ['средний', { lift: 5, power: 0.8, foot: 'R' }],
      ['навес', { lift: 9, power: 0.9, foot: 'R' }],
      ['то же левой', { lift: 5, power: 0.8, foot: 'L' }],
      ['слабый пас', { lift: 1, power: 0.25, foot: 'R' }],
    ];
    const hold = CONFIG.player.anim.strikeLean.hold;
    const n = Math.round(hold * 60);
    const out = {};
    // Сравнение делаем ПАРАМИ в одном прогоне: сперва тот же путь без наклона,
    // сразу за ним с наклоном. Мерить относительно далёкой базы нельзя — микшер
    // после reset() устаканивается не мгновенно, и первый замер уезжает
    // (контроль «без наклона» показывал сдвиг головы на 0.75 м, которого нет).
    const runCase = (o) => {
      p._leanP = 0; p._leanR = 0; p._leanA = 0; p._leanT = 0; p._leanWant = null;
      if (o) p.setStrikeLean(o);
      for (let i = 0; i < n; i++) { setPose(); p._updateStrikeLean(1 / 60); }
      return { g: grab(), pitch: p._leanP, roll: p._leanR, arm: p._leanA };
    };
    for (const [tag, o] of cases) {
      const off = runCase(null);
      const on = runCase(o);
      out[tag] = {
        наклонВперёдГрад: +(on.pitch * 180 / Math.PI).toFixed(1),
        завалВбокГрад: +(on.roll * 180 / Math.PI).toFixed(1),
        махРукойГрад: +(on.arm * 180 / Math.PI).toFixed(1),
        // Смещение ГОЛОВЫ сюда не выводится нарочно. Пара прогонов подряд даёт
        // по нему разброс ±0.2 м — того же порядка, что сам эффект: микшер
        // после reset() устаканивается не одинаково, и число врёт. Оценка
        // считается аналитически: голова стоит примерно в 0.55 м над основанием
        // позвоночника, значит наклон 14.5° уводит её на 0.55·sin(14.5°) = 0.14 м.
        // Углы ниже — это РОВНО то, что применено к костям, им верить можно.
        // ГЛАВНОЕ ЧИСЛО: точка удара обязана остаться на месте
        носокСместился: +on.g.t.distanceTo(off.g.t).toFixed(4),
      };
    }
    a.setEffectiveWeight(0); a.stop();
    window.LEAN = out;
    console.table(out);
    return out;
  }, opts);
}

// === 1c. Вбрасывание: едет ли мяч вместе с кистями ===
//
// Жалоба заказчика — «мяч не синхронно улетает с броском руки». Мерить надо не
// момент вылета сам по себе, а РАССТОЯНИЕ ОТ МЯЧА ДО КИСТЕЙ на всём замахе:
// пока мяч в руках, оно обязано быть постоянным и маленьким. Раньше мяч
// прикалывался к неподвижной точке на высоте 1.85, а кисти в клипе ходят от
// 0.90 до 2.07 — то есть мяч висел, а руки летали вокруг него.
export async function throwTrace(opts = {}) {
  const frames = opts.frames != null ? opts.frames : 200;
  return harness(async ({ match, ball, goals, CONFIG }) => {
    const F = CONFIG.field;
    // Ставим аут: мяч за боковой, розыгрыш достаётся AI-команде
    match.state = 'play';
    match.stateTimer = 0;
    ball.mesh.position.set(6, 0.2, F.width / 2 + 1.2);
    ball.vel.set(0, 0, 6);
    const rows = [];
    let seen = false;
    for (let f = 0; f < frames; f++) {
      step(match, ball, goals);
      const r = match.restart;
      if (!r || !r.taker || !r.taker.model) continue;
      const hands = r.taker.handsWorldPoint(_tmp);
      const bp = ball.mesh.position;
      const os = r.taker.oneShot;
      if (r.phase === 'throw' || r.phase === 'follow') seen = true;
      if (!seen) continue;
      rows.push({
        f,
        phase: r.phase,
        clipT: os ? +os.time.toFixed(3) : null,
        handsY: hands ? +hands.y.toFixed(2) : null,
        ballY: +bp.y.toFixed(2),
        // главное число: насколько мяч отстал от рук
        gap: hands ? +Math.hypot(bp.x - hands.x, bp.y - hands.y, bp.z - hands.z).toFixed(3) : null,
        ballSp: +Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z).toFixed(2),
      });
      if (r.phase === 'follow' && rows.length > 4 &&
          rows[rows.length - 2].phase === 'follow') break;
    }
    const held = rows.filter((r) => r.phase === 'throw' && r.gap != null);
    const gaps = held.map((r) => r.gap);
    const out = {
      кадров: rows.length,
      вЗамахе: held.length,
      разрывМин: gaps.length ? +Math.min(...gaps).toFixed(3) : null,
      разрывМакс: gaps.length ? +Math.max(...gaps).toFixed(3) : null,
      разбросРазрыва: gaps.length ? +(Math.max(...gaps) - Math.min(...gaps)).toFixed(3) : null,
      выпускНаКадре: (rows.find((r) => r.phase === 'follow') || {}).clipT,
      rows,
    };
    window.THROW = out;
    console.log('вбрасывание: разрыв мяч↔кисти %s…%s м (разброс %s)',
      out.разрывМин, out.разрывМакс, out.разбросРазрыва);
    console.table(rows.filter((r, i) => i % 3 === 0));
    return out;
  }, opts);
}

// === 2. Покадровая распечатка подката ===
//
// Ставит защитника и владельца лицом друг к другу, запускает подкат и пишет,
// что происходит с клипом, с высотой таза, со скоростью и с владением мячом.
export async function tackleTrace(opts = {}) {
  const frames = opts.frames != null ? opts.frames : 180;
  return harness(async ({ match, ball, goals }) => {
    const [tA, tB] = match.teams;
    const owner = tA.players.find((p) => !p.isKeeper);
    const def = tB.players.find((p) => !p.isKeeper);
    match.state = 'play';
    match.stateTimer = 0;
    owner.reset(0, 0, 0);
    def.reset(2.6, 0, Math.PI);
    ball.mesh.position.set(0, 0.11, 0.7);
    ball.vel.set(0, 0, 0);
    for (let i = 0; i < 3; i++) step(match, ball, goals);

    def.startTackle(-1, 0);
    const hips = def.model && def.model.getObjectByName('mixamorigHips');
    const rows = [];
    for (let f = 0; f < frames; f++) {
      step(match, ball, goals);
      const a = def.oneShot;
      rows.push({
        f,
        t: +(f * FRAME).toFixed(3),
        clip: def.currentName,
        clipT: a ? +a.time.toFixed(3) : null,
        w: +(def.oneShotW || 0).toFixed(2),
        tackleT: +def.tackleT.toFixed(2),
        downT: +def.downT.toFixed(2),
        rec: !!def.slideRecover,
        hipsY: hips ? +hips.getWorldPosition(_tmp).y.toFixed(2) : null,
        speed: +Math.hypot(def.vel.x, def.vel.z).toFixed(2),
        toucher: match.toucher === def ? 'ОН' : (match.toucher === owner ? 'владелец' : '-'),
        ballD: +Math.hypot(ball.mesh.position.x - def.group.position.x,
          ball.mesh.position.z - def.group.position.z).toFixed(2),
      });
    }
    window.TACKLE = rows;
    console.table(rows.filter((r) => r.f % 3 === 0));
    return rows;
  }, opts);
}

// === 3. Навес: пятится ли игрок и зависает ли мяч ===
//
// Запускает мяч по навесной дуге в игрока с заданным смещением ЗА спину
// (behind > 0 — мяч упадёт позади него, ровно случай из фидбека Олега) и пишет
// покадрово: куда едут ноги, что со скоростью мяча, что с клипом.
export async function aerialTrace(opts = {}) {
  const behind = opts.behind != null ? opts.behind : 2.5;
  const frames = opts.frames != null ? opts.frames : 150;
  return harness(async ({ match, ball, goals, CONFIG }) => {
    const t = match.teams[0];
    const p = t.players.find((x) => !x.isKeeper);
    const goalX = t.attackGoalX;
    const dir = Math.sign(goalX) || 1;
    match.state = 'play';
    match.stateTimer = 0;
    // Игрок смотрит на ворота, мяч прилетит ЗА него (то есть ближе к центру поля)
    p.reset(goalX - dir * 22, 6, dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    p.rot = Math.atan2(dir, 0);
    const from = { x: goalX - dir * (22 + behind + 16), z: -18 };
    const to = { x: goalX - dir * (22 + behind), z: 6 };
    // Навес: подбираем вертикаль так, чтобы мяч летел около 1.6 с
    const T = 1.6;
    ball.mesh.position.set(from.x, 0.4, from.z);
    ball.vel.set((to.x - from.x) / T, -CONFIG.ball.gravity * T * 0.5 + 2.2, (to.z - from.z) / T);
    ball.spin = 0;
    const p0 = { x: p.group.position.x, z: p.group.position.z };
    const rows = [];
    for (let f = 0; f < frames; f++) {
      step(match, ball, goals);
      const bp = ball.mesh.position;
      const as = p.aerialStrike;
      rows.push({
        f,
        t: +(f * FRAME).toFixed(3),
        ballY: +bp.y.toFixed(2),
        ballSp: +Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z).toFixed(2),
        // сдвиг игрока ОТ ворот: положительный = пятится назад
        backed: +(((p.group.position.x - p0.x) * -dir)).toFixed(2),
        speed: +Math.hypot(p.vel.x, p.vel.z).toFixed(2),
        clip: p.currentName,
        clipT: p.oneShot ? +p.oneShot.time.toFixed(3) : null,
        rate: p.oneShot ? +p.oneShot.timeScale.toFixed(2) : null,
        swing: as ? +as.t.toFixed(2) : null,
        hitAt: as ? +as.hitAt.toFixed(2) : null,
        dBall: +Math.hypot(bp.x - p.group.position.x, bp.z - p.group.position.z).toFixed(2),
      });
    }
    const maxBack = Math.max(...rows.map((r) => r.backed));
    // «Мяч завис»: сколько кадров подряд его скорость почти не менялась при том,
    // что он в воздухе (у честного полёта скорость меняется каждый кадр)
    let frozen = 0;
    let run = 0;
    for (let i = 1; i < rows.length; i++) {
      const still = Math.abs(rows[i].ballSp - rows[i - 1].ballSp) < 0.02 && rows[i].ballY > 0.3;
      run = still ? run + 1 : 0;
      frozen = Math.max(frozen, run);
    }
    const out = { behind, maxBack: +maxBack.toFixed(2), frozenFrames: frozen, rows };
    window.AERIAL = out;
    console.log('навес за спину %s м: пятился на %s м, мяч «стоял» %d кадров',
      behind, out.maxBack, frozen);
    console.table(rows.filter((r) => r.f % 2 === 0));
    return out;
  }, opts);
}
