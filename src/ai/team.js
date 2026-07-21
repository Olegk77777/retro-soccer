// Слой «тренер» (стейт-машина команды по Бакленду): владеем — регионы едут
// вперёд, потеряли — назад; назначает, кто гонится за мячом, кто принимает
// пас, кто открывается в поддержку. Сам никого не двигает — только раздаёт
// назначения, «головы» игроков (fieldplayer.js) их исполняют.

import { CONFIG } from '../config.js';
import { distToBall, passLaneClearance, freeSpace, isPassSafe, predictLanding } from './steering.js';

export class Team {
  // side: +1 — атакуем ворота на +X, −1 — на −X. players[0] — вратарь.
  constructor(match, side, data, players) {
    this.match = match;
    this.side = side;
    this.data = data;
    this.players = players;
    players.forEach((p, i) => {
      p.team = this;
      p.homeIdx = i;
      p.role = CONFIG.formation.roles[i].id;
      p.isKeeper = i === 0;
    });

    this.attacking = false;   // владеем ли мячом (по мнению тренера)
    this.chaser = null;       // кто бежит к свободному мячу / прессингует
    this.coverer = null;      // кто страхует за спиной прессингующего (cover)
    this.marks = new Map();   // персональный разбор в своей трети: защитник → соперник
    this.receiver = null;     // кто ждёт адресованный ему пас
    this.receiveTarget = null; // куда этот пас летит
    this.receiveTimer = 0;
    this.supporter = null;    // кто открывается впереди под пас
    this.defLineX = -side * (CONFIG.field.length / 2 - 25); // линия защиты (мир)
    this._coachTimer = 0;

    // Забегание за спину (ресёрч 10): один активный раннер на команду
    this.runner = null;
    this.runnerTarget = null;
    this.runnerTimer = 0;
    this._runCheckTimer = 0;

    // Врывания в штрафную под навес: игрок → точка рывка (ближняя/дальняя/11 м)
    this.boxRuns = new Map();
    this.crossAir = 0; // сек: наша подача в полёте — рывки живут, врывание на прилёт

    // Support spots Бакленда: сетка точек на половине соперника
    const SP = CONFIG.ai.attack.spot;
    this._spots = [];
    for (let ix = 0; ix < SP.cols; ix++) {
      for (let iz = 0; iz < SP.rows; iz++) {
        this._spots.push({
          x: side * (4 + (42 * ix) / (SP.cols - 1)),
          z: -27 + (54 * iz) / (SP.rows - 1),
        });
      }
    }
    this.bestSpot = null;
    this._spotTimer = 0;
  }

  get keeper() {
    return this.players[0];
  }

  get fieldPlayers() {
    return this.players.slice(1);
  }

  get opponents() {
    return this.match.otherTeam(this).players;
  }

  // Чужие ворота (куда забиваем) и свои
  get attackGoalX() {
    return this.side * (CONFIG.field.length / 2);
  }

  get ownGoalX() {
    return -this.side * (CONFIG.field.length / 2);
  }

  update(dt, ball) {
    const AI = CONFIG.ai;

    // Приём паса: живёт, пока мяч летит адресату. Снимаем, когда адресат
    // принял, соперник перехватил или время вышло. Важно: НЕ снимаем от
    // касания пасующего — сразу после удара он ещё пару кадров «ближайший».
    if (this.receiver) {
      this.receiveTimer -= dt;
      const done = this.receiveTimer <= 0 ||
        this.match.possession === this.match.otherTeam(this) ||
        this.match.toucher === this.receiver;
      if (done) {
        this.receiver = null;
        this.receiveTarget = null;
      }
    }

    // Догоняющий пересчитывается каждый кадр — это дёшево (11 дистанций),
    // а реакция на отскок мгновенная, как у Бакленда в ChaseBall
    this.chaser = this.pickChaser(ball);

    // Линия защиты «дышит»: плавно едет к расчётной высоте (не телепорт) —
    // push up за мячом, drop off к своим воротам (ресёрч 09, lineSpeed)
    const lt = this.defLineTarget(ball);
    const step = CONFIG.ai.defence.lineSpeed * dt;
    const dl = lt - this.defLineX;
    this.defLineX += Math.abs(dl) < step ? dl : Math.sign(dl) * step;

    // Подача в полёте: таймер тает; мяч опустился — фланговый эпизод окончен
    if (this.crossAir > 0) {
      this.crossAir -= dt;
      const bpA = ball.mesh.position;
      if (bpA.y < 0.5 && ball.vel.y <= 0) this.crossAir = 0;
    }

    // Раннер: рывок живёт durationSec или пока не потеряли мяч
    if (this.runner) {
      this.runnerTimer -= dt;
      if (this.runnerTimer <= 0 || !this.attacking) {
        this.runner = null;
        this.runnerTarget = null;
      }
    }
    if (this._runCheckTimer > 0) this._runCheckTimer -= dt;
    if (this._spotTimer > 0) this._spotTimer -= dt;

    this._coachTimer -= dt;
    if (this._coachTimer > 0) return;
    this._coachTimer = AI.coachTick;

    // Владение — по последнему касанию (считает Match)
    this.attacking = this.match.possession === this;

    if (this.attacking) {
      // Лучший спот открывания (Бакленд, пересчёт раз в updateSec)
      if (this._spotTimer <= 0) {
        this._spotTimer = CONFIG.ai.attack.spot.updateSec;
        this.updateBestSpot(ball);
      }
      // Пора ли кому-то рвануть за спину защите
      if (!this.runner && this._runCheckTimer <= 0) {
        this._runCheckTimer = CONFIG.ai.attack.runs.checkSec;
        this.tryStartRun(ball);
      }
    }

    // Поддержка атаки: ближний к «точке открывания» полузащитник/нападающий
    this.supporter = this.attacking ? this.pickSupporter(ball) : null;

    // Оборонительные назначения: страхующий за спиной прессингующего
    // (sweeper/cover из PES Defence System) и персональный разбор в своей трети
    this.coverer = this.attacking ? null : this.pickCoverer(ball);
    this.updateMarks(ball);

    // Врывания под навес: мяч на нашем фланге в финальной трети —
    // форварды рывками занимают штанги и точку 11 м
    this.updateBoxRuns(ball);
  }

  // Мяч во фланговом коридоре чужой трети (у нас) — форварды не стоят
  // и не ждут, а ВРЫВАЮТСЯ в штрафную (фидбек Олега 18.07.2026): ближняя
  // штанга, дальняя, подбор на 11 м. Цели живут, пока идёт фланговая атака.
  updateBoxRuns(ball) {
    const AC = CONFIG.ai.attack.cross;
    const F = CONFIG.field;
    // Подача уже в полёте: мяч покинул фланговый коридор, но рывки НЕ
    // отменяем — штанги и подбор держатся до прилёта (иначе врывания
    // умирали в момент удара по мячу — грабля 18.07.2026)
    if (this.crossAir > 0) return;
    this.boxRuns.clear();
    if (!this.attacking) return;
    const bp = ball.mesh.position;
    const inFlank = Math.abs(bp.z) > AC.flankZ - 2;
    const inFinal = this.side * bp.x > F.length / 2 - AC.finalThird;
    if (!inFlank || !inFinal) return;

    const goalX = this.attackGoalX;
    const s = Math.sign(bp.z || 1);
    const targets = [
      { x: goalX - this.side * 6.5, z: s * 3.2 },    // ближняя штанга
      { x: goalX - this.side * 8.0, z: -s * 4.8 },   // дальняя штанга
      { x: goalX - this.side * 11.5, z: -s * 0.5 },  // подбор у 11 метров
    ];
    // Кандидаты: оба форварда + открывающийся; занятые роли не трогаем
    const pool = [this.players[9], this.players[10], this.supporter]
      .filter((p, i, arr) => p && arr.indexOf(p) === i &&
        p !== this.match.toucher && p !== this.match.controlled &&
        p !== this.receiver && p !== this.chaser && p !== this.runner);
    for (const t of targets) {
      if (!pool.length) break;
      let bi = 0;
      let bd = Infinity;
      pool.forEach((p, i) => {
        const pp = p.group.position;
        const d = Math.hypot(pp.x - t.x, pp.z - t.z);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
      this.boxRuns.set(pool[bi], t);
      pool.splice(bi, 1);
    }
  }

  // Подача исполнена (ресёрч 11): считаем точку приземления честной
  // мини-симуляцией полёта и назначаем ЗАМЫКАЮЩЕГО — того, кто прибежит
  // к точке ближе всего к моменту прилёта (врывание на скорости, а не
  // ожидание под мячом). Он становится receiver и атакует прилёт.
  // Возвращает замыкающего (человеку туда передаётся курсор, как в PES).
  onCrossStruck(ball) {
    const land = predictLanding(ball, CONFIG.player.aerial.contactY);
    if (!land || land.t < 0.35) return null; // мгновенный прострел — не эпизод
    this.crossAir = land.t + 0.4;

    // Кандидаты: врывающиеся + вся атакующая шестёрка (позиции 5..10)
    const pool = [...this.boxRuns.keys(), ...this.players.slice(5)]
      .filter((p, i, arr) => arr.indexOf(p) === i &&
        p !== this.match.toucher && !p.isKeeper);
    if (!pool.length) return null;

    // Лучший — минимальный «зазор» между временем добегания и полётом:
    // прибежать К ПРИЛЁТУ (удар в движении) ценнее, чем стоять под мячом
    const spd = CONFIG.player.speed * CONFIG.player.sprintFactor;
    let best = null;
    let bestCost = Infinity;
    for (const p of pool) {
      const pp = p.group.position;
      const need = Math.hypot(land.x - pp.x, land.z - pp.z) / spd;
      const slack = land.t - need;
      // Опоздание штрафуем жёстко: лучше тот, кто успевает с небольшим запасом
      const cost = slack >= 0 ? slack : 3 - slack * 6;
      if (cost < bestCost) {
        bestCost = cost;
        best = p;
      }
    }
    if (!best) return null;
    this.receiver = best;
    this.receiveTarget = { x: land.x, z: land.z };
    this.receiveTimer = Math.max(CONFIG.ai.receiveGiveUp, land.t + 0.8);
    return best;
  }

  // Оценка support spots (веса Params.ini Бакленда + свободная зона):
  // безопасный пас 2.0, ударная позиция 1.0, оптимальная дистанция до 2.0
  updateBestSpot(ball) {
    const SP = CONFIG.ai.attack.spot;
    const AI = CONFIG.ai;
    const bp = ball.mesh.position;
    const goalX = this.attackGoalX;
    const opp = this.opponents;
    let best = null;
    let bestScore = -1;
    for (const s of this._spots) {
      let score = 1;
      if (isPassSafe(bp.x, bp.z, s.x, s.z, 22, opp)) score += SP.passSafeScore;
      if (Math.hypot(goalX - s.x, s.z) < AI.shootRange + 4) score += SP.canScoreScore;
      const d = Math.hypot(s.x - bp.x, s.z - bp.z);
      const t = Math.abs(SP.optimalDist - d);
      if (t < SP.optimalDist) score += SP.distScore * (SP.optimalDist - t) / SP.optimalDist;
      score += SP.spaceScore * freeSpace(s.x, s.z, opp);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    this.bestSpot = best;
  }

  // Запуск забегания за спину (триггер из GameplayFootball): раннер — ближний
  // к точке впереди владельца атакующий; рывок случается, если он не слишком
  // далеко для паса и рядом с ним мало защитников. Цель — за линию обороны.
  tryStartRun(ball) {
    const R = CONFIG.ai.attack.runs;
    const F = CONFIG.field;
    const owner = this.match.toucher;
    if (!owner || owner.team !== this) return;
    const op = owner.group.position;
    const fx = op.x + this.side * R.focusAhead;

    let runner = null;
    let bd = Infinity;
    for (const p of this.players.slice(5)) {
      if (p === owner || p === this.receiver || p === this.supporter ||
          p === this.match.controlled) continue;
      const d = Math.hypot(p.group.position.x - fx, p.group.position.z - op.z);
      if (d < bd) {
        bd = d;
        runner = p;
      }
    }
    if (!runner) return;

    const rp = runner.group.position;
    const dOwner = Math.hypot(rp.x - op.x, rp.z - op.z);
    const distanceRating = Math.sqrt(Math.max(0, 1 - dOwner / R.maxDist));
    // Плотность защитников за спиной раннера глушит рывок
    const px = rp.x - this.side * 10;
    const nearest = this.opponents
      .map((o) => Math.hypot(o.group.position.x - px, o.group.position.z - rp.z))
      .sort((a, b) => a - b)
      .slice(0, 4);
    let density = 1;
    for (const d of nearest) {
      density -= R.densityPenalty * Math.sqrt(Math.max(0, 1 - d / R.densityRadius));
    }
    if (distanceRating * density < R.trigger) return;

    // Цель — за фактическую линию защиты соперника, ближе к центру (канал)
    const oppTeam = this.match.otherTeam(this);
    let tx = oppTeam.defLineX + this.side * R.behindLine;
    const maxDepth = F.length / 2 - 8; // не в объятия вратаря
    if (this.side * tx > maxDepth) tx = this.side * maxDepth;
    this.runner = runner;
    this.runnerTarget = { x: tx, z: Math.max(-18, Math.min(18, rp.z * 0.6)) };
    this.runnerTimer = R.durationSec;
  }

  // Высота линии защиты — считается ОТ МЯЧА (ресёрч 09: формула UvA/RoboCup):
  // мяч у чужих ворот — линия у центра, мяч катится к нам — линия отступает,
  // но никогда не прижимается к ленточке (lineMinDepth). Лечит фидбек Олега
  // «защитники жмутся к линии ворот».
  defLineTarget(ball) {
    const D = CONFIG.ai.defence;
    const F = CONFIG.field;
    const bp = ball.mesh.position;
    // Продвижение мяча: 0 = у наших ворот, 1 = у чужих
    const ballDepth = this.side * bp.x + F.length / 2;
    const adv = Math.max(0, Math.min(1, ballDepth / F.length));
    let depth = D.lineMinDepth + D.lineRange * adv * D.mentality;
    // Линия держится глубже мяча (goal-side) минимум на зазор
    depth = Math.min(depth, ballDepth - D.lineBallGap);
    depth = Math.max(D.lineMinDepth, Math.min(F.length / 2 + 8, depth));
    return this.ownGoalX + this.side * depth;
  }

  // Страхующий (cover): второй по близости к мячу полевой — встаёт за спиной
  // прессингующего под углом к центру, ловит обыгрыш и прострел
  pickCoverer(ball) {
    let best = null;
    let bestD = Infinity;
    for (const p of this.fieldPlayers) {
      if (p === this.match.controlled || p === this.chaser) continue;
      const d = distToBall(p, ball);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  // Персональный разбор в своей трети (гибрид MarliK/PES Mark Man):
  // свободные защитники разбирают ближних к нашим воротам соперников.
  // Дальше своей трети — чистая зона (линия), как Mark Zone в PES.
  updateMarks(ball) {
    const D = CONFIG.ai.defence;
    const F = CONFIG.field;
    this.marks.clear();
    if (this.attacking) return;
    const bp = ball.mesh.position;
    const ballDepth = this.side * bp.x + F.length / 2;
    if (ballDepth > D.markThird) return;

    const gx = this.ownGoalX;
    const threats = this.opponents
      .filter((o) => !o.isKeeper && this.side * o.group.position.x < 2)
      .sort((a, b) =>
        Math.hypot(a.group.position.x - gx, a.group.position.z) -
        Math.hypot(b.group.position.x - gx, b.group.position.z));
    // Защитники (индексы 1–4), не занятые прессингом/страховкой/человеком
    const free = this.players.slice(1, 5).filter((p) =>
      p !== this.chaser && p !== this.coverer && p !== this.match.controlled);
    for (const t of threats) {
      if (!free.length) break;
      const tp = t.group.position;
      let bi = 0;
      let bd = Infinity;
      free.forEach((d, i) => {
        const dp = d.group.position;
        const dd = Math.hypot(dp.x - tp.x, dp.z - tp.z);
        if (dd < bd) {
          bd = dd;
          bi = i;
        }
      });
      this.marks.set(free[bi], t);
      free.splice(bi, 1);
    }
  }

  // Кто бежит к мячу: ближний полевой игрок. Управляемого человеком не
  // назначаем — за него решает Олег (авто-переключение и так отдаст ему
  // ближнего). Вратарь гонится только по своей логике (goalkeeper.js).
  pickChaser(ball) {
    if (this.match.state === 'restart') return null; // мёртвый мяч не догоняют
    let best = null;
    let bestD = Infinity;
    for (const p of this.fieldPlayers) {
      if (p === this.match.controlled) continue;
      const d = distToBall(p, ball);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  // Точка открывания: лучший спот сетки Бакленда; пока не посчитан —
  // фолбэк «впереди мяча ближе к центру»
  supportSpot(ball) {
    if (this.bestSpot) return this.bestSpot;
    const F = CONFIG.field;
    const AI = CONFIG.ai;
    const bp = ball.mesh.position;
    const x = Math.max(
      -F.length / 2 + 4,
      Math.min(F.length / 2 - 4, bp.x + this.side * AI.supportDist),
    );
    const z = Math.abs(bp.z) > 8 ? -Math.sign(bp.z) * 8 : Math.sign(bp.z || 1) * -12;
    return { x, z };
  }

  pickSupporter(ball) {
    const spot = this.supportSpot(ball);
    let best = null;
    let bestD = Infinity;
    // Открываются атакующие роли (полузащита и нападение — индексы 5..10)
    for (const p of this.players.slice(5)) {
      if (p === this.match.controlled || p === this.chaser ||
          p === this.receiver || p === this.runner) continue;
      const d = Math.hypot(spot.x - p.group.position.x, spot.z - p.group.position.z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    // Гистерезис (слабость Бакленда — суппорт «мигает»): текущий держится,
    // пока новый кандидат не ближе к споту на switchHysteresis метров
    if (this.supporter && best && best !== this.supporter &&
        this.supporter !== this.match.controlled && this.supporter !== this.chaser &&
        this.supporter !== this.receiver && this.supporter !== this.runner) {
      const sp = this.supporter.group.position;
      const curD = Math.hypot(spot.x - sp.x, spot.z - sp.z);
      if (curD < bestD + CONFIG.ai.attack.spot.switchHysteresis) return this.supporter;
    }
    return best;
  }

  // Домашняя точка игрока. В атаке — регион формации, сдвинутый вперёд и
  // притянутый к мячу. В обороне — строимся ОТ ЛИНИИ ЗАЩИТЫ (ресёрч 09):
  // защитники стоят на линии (плоская четвёрка), опорные — второй линией
  // (defOff), форварды остаются выше под контратаку; все сжимаются к мячу
  // по ширине (компактность).
  homeTarget(p, ball) {
    const F = CONFIG.field;
    const AI = CONFIG.ai;
    const D = AI.defence;
    const base = CONFIG.formation.roles[p.homeIdx];
    const bp = ball.mesh.position;

    if (p.isKeeper) {
      // Вратарь регионами не живёт — его точку даёт goalkeeper.js;
      // сюда попадает только при расстановке на кикофф
      return { x: this.side * base.x * (F.length / 2), z: 0 };
    }

    let x;
    let z;
    if (this.attacking) {
      x = this.side * (base.x + AI.attackShift) * (F.length / 2) + bp.x * AI.ballPullX;
      // Вингеры держат ширину у бровки и НЕ стягиваются к мячу — растяжка
      // обороны и адресат для перевода на пустой фланг (ресёрч 10 + PES)
      if (base.id === 'LM' || base.id === 'RM') {
        z = base.z * (F.width / 2) * CONFIG.ai.attack.wingerWide;
      } else {
        z = base.z * (F.width / 2) * 0.92 + bp.z * AI.ballPullZ;
      }
    } else {
      x = this.defLineX + this.side * base.defOff;
      z = base.z * (F.width / 2) * D.zCompact;
      // Четвёрка защитников не разъезжается шире компактного блока
      if (base.defOff === 0) {
        z = Math.max(-D.defWidth / 2, Math.min(D.defWidth / 2, z));
      }
      z += bp.z * AI.ballPullZ;
    }

    x = Math.max(-F.length / 2 + 2, Math.min(F.length / 2 - 2, x));
    z = Math.max(-F.width / 2 + 1.5, Math.min(F.width / 2 - 1.5, z));
    return { x, z };
  }

  // Выбор паса для игрока с мячом: вперёд, в чистый коридор, на ход.
  // Возвращает готовое решение {mate, dir, power, lift, target} или null.
  choosePass(from, ball) {
    const AI = CONFIG.ai;
    const fp = from.group.position;
    const opponents = this.opponents;
    let best = null;
    let bestScore = -Infinity;

    for (const mate of this.players) {
      if (mate === from || mate.isKeeper) continue;
      const mp = mate.group.position;
      const dist = Math.hypot(mp.x - fp.x, mp.z - fp.z);
      if (dist < AI.passMin || dist > AI.passMax) continue;

      // Упреждение: пас на ход бегущему, а не в точку, где он был.
      // Раннеру за спину защиты мяч кладётся дальше в зону рывка (leadRun)
      const isRunner = mate === this.runner;
      const lead = isRunner ? CONFIG.ai.attack.runs.leadRun : 0.7;
      const speed = Math.min(AI.passSpeedMax,
        Math.max(AI.passSpeedMin, dist * AI.passSpeedK + AI.passSpeedMin * 0.5));
      const t = dist / speed;
      const tx = mp.x + mate.vel.x * t * lead;
      const tz = mp.z + mate.vel.z * t * lead;

      const clearance = passLaneClearance(fp.x, fp.z, tx, tz, opponents);
      // Пас в разрез терпит более узкую щель (riskFactor, Gliders2d)
      const needClear = isRunner
        ? AI.passOpenRadius * CONFIG.ai.attack.runs.riskFactor
        : AI.passOpenRadius;
      if (clearance < needClear) continue;

      // Ценим продвижение к воротам, чистоту коридора, свободную зону на
      // приёме (перевод из толпы на пустой фланг) и бегущего в разрез
      const forward = this.side * (tx - fp.x);
      const score = forward + clearance * 1.5 +
        freeSpace(tx, tz, opponents) * 2 +
        (isRunner ? CONFIG.ai.attack.runs.passBonus : 0) -
        dist * 0.08;
      if (score > bestScore) {
        bestScore = score;
        const d = Math.hypot(tx - fp.x, tz - fp.z) || 1;
        best = {
          mate,
          target: { x: tx, z: tz },
          dir: { x: (tx - fp.x) / d, z: (tz - fp.z) / d },
          power: speed,
          lift: dist > AI.longPassDist ? AI.longPassLift : 0.6,
        };
      }
    }
    return best;
  }

  // Зафиксировать пас: адресат бросается на мяч, тренер помнит назначение
  commitPass(pass) {
    this.receiver = pass.mate;
    this.receiveTarget = pass.target;
    this.receiveTimer = CONFIG.ai.receiveGiveUp;
    if (this.runner === pass.mate) {
      // Пас на рывок отдан — дальше раннер живёт как обычный приёмщик
      this.runner = null;
      this.runnerTarget = null;
    }
  }
}
