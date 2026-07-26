// Слой «тренер» (стейт-машина команды по Бакленду): владеем — регионы едут
// вперёд, потеряли — назад; назначает, кто гонится за мячом, кто принимает
// пас, кто открывается в поддержку. Сам никого не двигает — только раздаёт
// назначения, «головы» игроков (fieldplayer.js) их исполняют.

import { CONFIG } from '../config.js';
import {
  distToBall, freeSpace, isPassSafe, predictLanding,
  xThreat, passPower, passTime, ROLL_LAMBDA,
} from './steering.js';

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

    // Подключение крайнего защитника по бровке (overlap, ресёрч 14):
    // отдельный слот — рывок снаружи, не конкурирует с runner
    this.overlapper = null;
    this.overlapTarget = null;
    this.overlapTimer = 0;

    // Приход в ноги (coming short): один игрок показывается накоротке
    this.shortRunner = null;
    this.shortTarget = null;
    this.shortTimer = 0;

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

  // Счётчик статистики матча: команда сама не знает своего индекса,
  // поэтому спрашивает его у матча (дёшево — вызывается на событиях)
  bump(key, n = 1) {
    const s = this.match && this.match.stats;
    if (!s || !s[key]) return;
    s[key][this.match.teams.indexOf(this)] += n;
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
      // Наш верховой мяч ещё В ВОЗДУХЕ — назначение живёт, даже если формально
      // «ближайшим» на миг стал соперник под траекторией. Иначе адресат
      // бросал бег на середине полёта и мяч падал в пустоту (замер 24.07:
      // приёмщика снимало через 3 с, а мяч летел 4 с)
      const bpR = ball.mesh.position;
      const inFlight = bpR.y > CONFIG.player.kickMaxBallY;
      const done = this.receiveTimer <= 0 ||
        (!inFlight && this.match.possession === this.match.otherTeam(this)) ||
        this.match.toucher === this.receiver;
      if (done) {
        // Пас дошёл, если адресат реально взял мяч — это и есть точность передач
        if (this._passLive && this._passLive === this.receiver &&
            this.match.toucher === this.receiver) this.bump('passOk');
        this._passLive = null;
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

    // Подключение фулбека: живёт durationSec или пока не потеряли мяч
    if (this.overlapper) {
      this.overlapTimer -= dt;
      if (this.overlapTimer <= 0 || !this.attacking) {
        this.overlapper = null;
        this.overlapTarget = null;
      }
    }
    // Приход в ноги живёт короткое окно: не показался вовремя — вернулся
    if (this.shortRunner) {
      this.shortTimer -= dt;
      if (this.shortTimer <= 0 || !this.attacking ||
          this.match.toucher === this.shortRunner) {
        this.shortRunner = null;
        this.shortTarget = null;
      }
    }
    // Кулдаун рывка у каждого: рывки не должны идти сплошным потоком
    for (const p of this.players) {
      if (p.runCd > 0) p.runCd -= dt;
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
      // Мяч у широкого игрока — крайний защитник подключается по бровке
      if (!this.overlapper) this.tryOverlap();
      // Владельца прессингуют, безопасного паса нет — партнёр показывается
      // накоротке (главный источник передач под давлением)
      this.tryComingShort(ball);
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

  // ЗАНЯТИЕ ШТРАФНОЙ (ресёрч 15, раздел 5.2). Атака дошла до финальной трети —
  // четверо занимают ЧЕТЫРЕ РАЗНЫЕ точки: ближняя штанга, «золотая зона»
  // между вратарской и точкой пенальти, дальняя штанга и ТРЕЙЛЕР у линии
  // штрафной под прострел. Раньше врывания включались только из флангового
  // коридора и только на три точки без трейлера — прострел было некому
  // замыкать, и главное оружие финальной трети не работало вовсе.
  updateBoxRuns(ball) {
    const B = CONFIG.ai.attack.offBall.box;
    const F = CONFIG.field;
    // Подача уже в полёте: рывки НЕ отменяем — штанги и подбор держатся до
    // прилёта (иначе врывания умирали в момент удара по мячу, грабля 18.07)
    if (this.crossAir > 0) return;
    this.boxRuns.clear();
    if (!this.attacking) return;
    const bp = ball.mesh.position;
    const goalX = this.attackGoalX;
    if (Math.hypot(goalX - bp.x, bp.z) > B.fromGoal) return;

    const s = Math.sign(bp.z || 1); // «ближняя» штанга — со стороны мяча
    const targets = [
      { x: goalX - this.side * B.nearPost.x, z: s * B.nearPost.z },
      { x: goalX - this.side * B.golden.x, z: B.golden.z },
      { x: goalX - this.side * B.farPost.x, z: s * B.farPost.z },
      { x: goalX - this.side * B.trailer.x, z: B.trailer.z },
    ];
    // Кандидаты: атакующая шестёрка, кроме занятых ролями. Поддерживающего
    // НЕ забираем: если в штрафную уйдут все, владельцу некому отдать, он
    // упрётся в защитника и потеряет мяч — замер показал падение ударов
    // втрое, когда в коробку врывались четверо из шести
    const pool = this.players.slice(5)
      .filter((p) => p !== this.match.toucher && p !== this.match.controlled &&
        p !== this.receiver && p !== this.chaser && p !== this.shortRunner &&
        p !== this.supporter);
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

  // ПРИХОД В НОГИ (coming short, ресёрч 15, раздел 5.2 тип №4).
  // Владельца прессингуют и безопасного паса нет — партнёр обязан ПОКАЗАТЬСЯ
  // накоротке сам, а не ждать в своей зоне. Без этого владелец под прессингом
  // вынужден вести мяч до потери: именно поэтому «легче самому бежать».
  // Точка — на отрезке владелец→партнёр в short.dist метрах от владельца,
  // сдвинутая прочь от ближайшего соперника (открыть угол передачи).
  tryComingShort(ball) {
    const C = CONFIG.ai.attack.offBall;
    const S = C.short;
    const owner = this.match.toucher;
    if (this.shortRunner) return;
    if (!owner || owner.team !== this || owner.isKeeper) return;
    const op = owner.group.position;

    // Прессингуют ли владельца
    let press = Infinity;
    let presser = null;
    for (const o of this.opponents) {
      if (o.isKeeper) continue;
      const p2 = o.group.position;
      const d = Math.hypot(p2.x - op.x, p2.z - op.z);
      if (d < press) {
        press = d;
        presser = o;
      }
    }
    if (press > S.pressDist) return;

    // Уже есть надёжная опция — открываться накоротке незачем
    const safe = this.choosePass(owner, ball);
    if (safe && safe.score >= S.safeOption) return;

    // Кандидат: ближний свободный партнёр, не занятый другой ролью
    let best = null;
    let bestD = Infinity;
    for (const p of this.players) {
      if (p === owner || p.isKeeper) continue;
      if (p === this.match.controlled || p === this.runner ||
          p === this.overlapper || p === this.receiver) continue;
      if (p.runCd > 0) continue;
      const pp = p.group.position;
      const d = Math.hypot(pp.x - op.x, pp.z - op.z);
      if (d < S.minGap || d > 22) continue;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (!best) return;

    const pp = best.group.position;
    const dx = pp.x - op.x;
    const dz = pp.z - op.z;
    const dl = Math.hypot(dx, dz) || 1;
    let tx = op.x + (dx / dl) * S.dist;
    let tz = op.z + (dz / dl) * S.dist;
    // Сдвиг прочь от прессера — иначе показываемся ему же в ноги
    if (presser) {
      const ppx = presser.group.position;
      const ax = tx - ppx.x;
      const az = tz - ppx.z;
      const al = Math.hypot(ax, az) || 1;
      tx += (ax / al) * S.offset;
      tz += (az / al) * S.offset;
    }
    const F = CONFIG.field;
    this.shortRunner = best;
    this.shortTarget = {
      x: Math.max(-F.length / 2 + 3, Math.min(F.length / 2 - 3, tx)),
      z: Math.max(-F.width / 2 + 2, Math.min(F.width / 2 - 2, tz)),
    };
    this.shortTimer = S.ttl;
    best.runCd = C.cooldown;
  }

  // Подача исполнена (ресёрч 11): считаем точку приземления честной
  // мини-симуляцией полёта и назначаем ЗАМЫКАЮЩЕГО — того, кто прибежит
  // к точке ближе всего к моменту прилёта (врывание на скорости, а не
  // ожидание под мячом). Он становится receiver и атакует прилёт.
  // Возвращает замыкающего (человеку туда передаётся курсор, как в PES).
  onCrossStruck(ball) {
    // Точка прилёта: сперва на высоте замыкания; низовой прострел (мяч не
    // поднимается до головы) считаем по колену — курсор нужен и там
    // (фидбек Олега 22.07: на прострелах замыкающий не назначался вовсе)
    let land = predictLanding(ball, CONFIG.player.aerial.contactY);
    if (!land || land.t < 0.18) {
      const low = predictLanding(ball, 0.4);
      land = low && low.t >= 0.18 ? low : null;
    }
    if (!land) return null; // мгновенный тычок — не фланговый эпизод
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

  // Пас отдан — пасующий предлагает СТЕНОЧКУ (give-and-go, ресёрч 14):
  // после короткого паса под прессингом рвануть за спину опекуну и получить
  // мяч обратно на ход. Использует общий слот runner — choosePass уже умеет
  // кормить бегущего с приоритетом (passBonus) и упреждением (leadRun),
  // а человеку возврат кладёт пас на ход (W) с обычным ассистом.
  tryFollowRun(passer, passDist) {
    const C = CONFIG.ai.combo.oneTwo;
    if (this.runner || !passer || passer.isKeeper) return;
    if (passDist > C.maxPassDist) return;       // стеночка живёт на коротком пасе
    const pp = passer.group.position;
    if (this.side * pp.x < C.minX) return;      // не из своей глубины
    // Рывок оправдан, когда пасующего встречали: прессер рядом
    let oppD = Infinity;
    for (const o of this.opponents) {
      const op = o.group.position;
      const d = Math.hypot(op.x - pp.x, op.z - pp.z);
      if (d < oppD) oppD = d;
    }
    if (oppD > C.pressDist) return;
    if (Math.random() > C.chance) return;       // не каждый пас — заготовка
    const F = CONFIG.field;
    let tx = pp.x + this.side * C.runDepth;
    const maxDepth = F.length / 2 - 8;          // не в объятия вратаря
    if (this.side * tx > maxDepth) tx = this.side * maxDepth;
    this.runner = passer;
    this.runnerTarget = { x: tx, z: Math.max(-24, Math.min(24, pp.z * 0.85)) };
    this.runnerTimer = C.ttl;
  }

  // Ручная СТЕНОЧКА (Q/LB + ПАС, фидбек Олега 22.07.2026): игрок сам заказал
  // «отдал — и рванул». Никаких проверок прессинга/дистанции — намерение уже
  // высказано кнопкой. Курсор сразу переходит на адресата (как L1+пас в PES):
  // он встречает мяч, а пасующий-AI рвёт вперёд слотом runner — возврат W.
  startManualOneTwo(passer) {
    const C = CONFIG.ai.combo.oneTwo;
    const F = CONFIG.field;
    const pp = passer.group.position;
    let tx = pp.x + this.side * C.manualDepth;
    const maxDepth = F.length / 2 - 8; // не в объятия вратаря
    if (this.side * tx > maxDepth) tx = this.side * maxDepth;
    this.runner = passer;
    this.runnerTarget = { x: tx, z: Math.max(-24, Math.min(24, pp.z * 0.85)) };
    this.runnerTimer = C.manualTtl;
    const m = this.match;
    if (m && this === m.humanTeam && this.receiver && this.receiver !== m.controlled) {
      m.setControlled(this.receiver, 0.3);
    }
  }

  // Подключение крайнего защитника (overlap, ресёрч 14): мяч у широкого
  // игрока на фланге в средней/чужой трети — фулбек того же фланга забегает
  // СНАРУЖИ по бровке за линию мяча, растягивая оборону и открывая перевод
  tryOverlap() {
    const C = CONFIG.ai.combo.overlap;
    const F = CONFIG.field;
    const owner = this.match.toucher;
    if (!owner || owner.team !== this || owner.isKeeper) return;
    const op = owner.group.position;
    if (Math.abs(op.z) < C.flankZ) return;      // мяч не на фланге
    if (this.side * op.x < C.minX) return;      // рано подключаться
    const fb = this.players[op.z < 0 ? 1 : 4];  // LB на левом (−z), RB на правом
    if (!fb || fb === owner || fb === this.match.controlled ||
        fb === this.runner || fb === this.receiver) return;
    const fp = fb.group.position;
    if (Math.hypot(fp.x - op.x, fp.z - op.z) > C.triggerDist) return;
    if (this.side * (fp.x - op.x) > 2) return;  // фулбек уже глубже владельца
    this.overlapper = fb;
    this.overlapTarget = {
      x: Math.max(-F.length / 2 + 6,
        Math.min(F.length / 2 - 6, op.x + this.side * C.ahead)),
      z: Math.sign(op.z) * (F.width / 2 - C.wideZ),
    };
    this.overlapTimer = C.durationSec;
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

  // ===== Выбор паса (ресёрч 15, раздел 3) =====
  // S = P_complete^safety · Q · V · F, где
  //   P_complete — вероятность, что пас дойдёт (модель перехвата ПО ВРЕМЕНИ),
  //   Q — качество приёма (скорость мяча, разворот корпуса, прессинг, высота),
  //   V — прирост ценности позиции (xT: пас вперёд в центр дороже отката),
  //   F — множитель семейства (разрез 2.2, ПРОСТРЕЛ 1.6, навес 0.6).
  // Выбор — softmax по S, а не строгий максимум: предсказуемый пас читается
  // соперником и выглядит роботом. Возвращает {mate, dir, power, lift, target}.
  choosePass(from, ball) {
    const AI = CONFIG.ai;
    const PM = AI.passModel;
    const F = CONFIG.field;
    const fp = from.group.position;
    const opponents = this.opponents;

    // Прессинг на пасующем — он же меняет и порог, и прощение перехвата
    let nearestOpp = Infinity;
    for (const o of opponents) {
      const op = o.group.position;
      nearestOpp = Math.min(nearestOpp, Math.hypot(op.x - fp.x, op.z - fp.z));
    }
    const underPressure = nearestOpp < AI.passPressure;
    const xtFrom = xThreat(fp.x, fp.z, this.side);
    const goalX = this.attackGoalX;
    const boxX = F.length / 2 - 16.5;

    const options = [];
    for (const mate of this.players) {
      if (mate === from) continue;
      if (mate.downT > 0 || mate.tackleT > 0) continue;
      const mp = mate.group.position;
      const straight = Math.hypot(mp.x - fp.x, mp.z - fp.z);
      if (straight < AI.passMin || straight > AI.passMax) continue;

      // Два кандидата на каждого партнёра: «в ноги с упреждением» и «на ход».
      // Пас на ход кладётся ПЕРЕД бегущим (+2 м фикс), иначе мяч приходит
      // в пятки и адресат вынужден тормозить — ровно то, что убивает темп
      const cands = [{ kind: 'feet', lead: 0.8, ahead: 0 }];
      const runSpeed = Math.hypot(mate.vel.x, mate.vel.z);
      if (runSpeed > 1.5 || mate === this.runner || mate === this.overlapper) {
        cands.push({ kind: 'through', lead: 1.5, ahead: 2.0 });
      }

      for (const c of cands) {
        const arrive = c.kind === 'through' || underPressure
          ? AI.passArriveDriven : AI.passArriveNormal;
        // Две итерации неподвижной точки: цель зависит от времени полёта,
        // время полёта — от дистанции до цели
        let tx = mp.x;
        let tz = mp.z;
        let dist = straight;
        let power = 0;
        let flight = 0;
        for (let it = 0; it < 2; it++) {
          power = Math.max(AI.passSpeedMin,
            Math.min(AI.passSpeedMax, passPower(dist, arrive)));
          flight = passTime(dist, power);
          if (!isFinite(flight)) break;
          const ux = runSpeed > 0.3 ? mate.vel.x / runSpeed : 0;
          const uz = runSpeed > 0.3 ? mate.vel.z / runSpeed : 0;
          tx = mp.x + mate.vel.x * flight * c.lead + ux * c.ahead;
          tz = mp.z + mate.vel.z * flight * c.lead + uz * c.ahead;
          dist = Math.hypot(tx - fp.x, tz - fp.z) || 1;
        }
        if (!isFinite(flight)) continue;
        if (Math.abs(tx) > F.length / 2 - 1.5 || Math.abs(tz) > F.width / 2 - 1.5) continue;

        // --- P_complete: перехват по времени ---
        const p = this.passComplete(fp.x, fp.z, tx, tz, power, opponents,
          underPressure ? PM.pressBonus : 0);
        if (p <= 0.01) continue;

        // --- Q: качество приёма ---
        const vArrive = Math.max(0, power - ROLL_LAMBDA * dist);
        let q = Math.max(PM.qSpeedMin,
          Math.min(1, 1 - (vArrive - PM.qSpeedRef) / PM.qSpeedSpan));
        // Разворот корпуса: мяч, приходящий в спину, принимать труднее
        const nx = (tx - fp.x) / dist;
        const nz = (tz - fp.z) / dist;
        const face = mate.facing;
        const cosB = -(nx * face.x + nz * face.z); // 1 = адресат лицом к мячу
        q *= PM.qBodyBase + (1 - PM.qBodyBase) * (1 + cosB) / 2;
        // Опекун рядом с точкой приёма
        let dOpp = Infinity;
        for (const o of opponents) {
          if (o.isKeeper) continue;
          const op = o.group.position;
          dOpp = Math.min(dOpp, Math.hypot(op.x - tx, op.z - tz));
        }
        q *= 1 - PM.qPressDrop * Math.max(0, Math.min(1, 1 - dOpp / PM.qPressRange));
        q *= PM.qHeightLow;
        q *= c.kind === 'through' ? PM.qRunBonus
          : (runSpeed > 3 ? PM.qFeetToRunner : 1);

        // --- V: прирост ценности позиции ---
        const dxt = xThreat(tx, tz, this.side) - xtFrom;
        const v = Math.max(PM.valueMin, Math.min(PM.valueMax, 1 + PM.valueK * dxt));

        // --- F: семейство передачи ---
        let f = PM.fNormal;
        const oppLine = this.match.otherTeam(this).defLineX;
        const behindLine = this.side * (tx - oppLine) > 0;
        const inBox = this.side * tx > boxX && Math.abs(tz) < 20.16;
        // ПРОСТРЕЛ: мяч из глубины фланга НАЗАД в зону перед воротами.
        // Второе по опасности действие в футболе после разреза — и главный
        // недостающий инструмент нашей игры (ресёрч 15, раздел 9)
        const fromDeepWide = this.side * fp.x > F.length / 2 - 13 && Math.abs(fp.z) > 13;
        const isCutback = fromDeepWide && inBox &&
          this.side * (fp.x - tx) > 0 && Math.abs(tz) < Math.abs(fp.z) - 4;
        if (isCutback) f = PM.fCutback;
        else if (behindLine && c.kind === 'through') f = PM.fThrough;
        else if (this.side * (tx - fp.x) > 6) f = PM.fProgress;
        if (mate.isKeeper) f *= PM.fKeeper;
        if (mate === this.runner) f *= 1.25;
        if (mate === this.overlapper) f *= 1.15;

        const score = Math.pow(p, PM.safety) * q * v * f;
        options.push({
          score,
          mate,
          target: { x: tx, z: tz },
          dir: { x: nx, z: nz },
          power,
          lift: dist > AI.longPassDist ? AI.longPassLift : 0.4,
          kind: c.kind,
        });
      }
    }

    if (!options.length) return null;
    const minScore = PM.minScore * (underPressure ? PM.pressScoreK : 1);
    const live = options.filter((o) => o.score >= minScore);
    if (!live.length) return null;

    // Softmax по S: лучший вариант выигрывает примерно в 2/3 случаев,
    // остальное достаётся близким по ценности — игра перестаёт быть роботом
    let top = -Infinity;
    for (const o of live) top = Math.max(top, o.score);
    let sum = 0;
    for (const o of live) {
      o._w = Math.exp((o.score - top) / PM.temperature);
      sum += o._w;
    }
    let r = Math.random() * sum;
    for (const o of live) {
      r -= o._w;
      if (r <= 0) return o;
    }
    return live[live.length - 1];
  }

  // Вероятность, что наземный пас дойдёт: произведение (1 − p_перехвата) по
  // ближайшим к линии соперникам. Перехват считается ПО ВРЕМЕНИ с честной
  // кинематикой разгона (√(2s/a)), а не «плоским коридором в метрах»:
  // защитник в двух метрах от линии тратит на них 0.94 с, а не полсекунды.
  passComplete(fx, fz, tx, tz, power, opponents, forgive = 0) {
    const PM = CONFIG.ai.passModel;
    const dx = tx - fx;
    const dz = tz - fz;
    const D = Math.hypot(dx, dz) || 1;
    const nx = dx / D;
    const nz = dz / D;
    const sprint = CONFIG.player.speed * CONFIG.ai.speedFactor * CONFIG.player.sprintFactor;

    const near = [];
    for (const o of opponents) {
      if (o.downT > 0 || o.tackleT > 0) continue; // лежащий не перехватит
      const op = o.group.position;
      const a = (op.x - fx) * nx + (op.z - fz) * nz;
      if (a < 0.5) continue;                       // за спиной пасующего
      const b = Math.abs(-(op.x - fx) * nz + (op.z - fz) * nx);
      if (a > D + 1.5) continue;                   // дальше цели — не по пути
      if (b < PM.onLine && a < D) return 0;        // физически стоит на линии
      near.push({ a: Math.max(0, Math.min(D, a)), b });
    }
    near.sort((p1, p2) => p1.b - p2.b);

    let pass = 1;
    for (let i = 0; i < Math.min(PM.maxCheck, near.length); i++) {
      const { a, b } = near[i];
      const tBall = passTime(a, power);
      if (!isFinite(tBall)) continue;
      const s = Math.max(0, b - PM.bodyWidth);
      // Разгон из покоя, потом крейсерская скорость
      const tAccel = Math.sqrt((2 * s) / PM.oppAccel);
      const vEnd = PM.oppAccel * tAccel;
      const tMove = vEnd <= sprint
        ? tAccel
        : sprint / PM.oppAccel + (s - (sprint * sprint) / (2 * PM.oppAccel)) / sprint;
      const margin = PM.oppReact + tMove - tBall + forgive;
      pass *= 1 - 1 / (1 + Math.exp(PM.interceptK * margin));
    }
    return pass;
  }

  // Зафиксировать пас: адресат бросается на мяч, тренер помнит назначение.
  // from — пасующий: короткий пас под прессингом предлагает ему стеночку
  commitPass(pass, from = null) {
    this.receiver = pass.mate;
    this.receiveTarget = pass.target;
    this.receiveTimer = CONFIG.ai.receiveGiveUp;
    this.bump('pass');
    this._passLive = pass.mate; // ждём, дойдёт ли (для статистики точности)
    // Верховой пас летит по баллистике и садится ЗАМЕТНО ДАЛЬШЕ наземной цели,
    // под которую считалась сила. Адресат обязан бежать в реальную точку
    // прилёта, иначе он ждёт там, где мяча не будет: замер 24.07 дал 9 верховых
    // пасов и НОЛЬ приёмов — мяч каждый раз садился мимо ожидающего
    const ball = this.match && this.match.ball;
    if (ball && (pass.lift || 0) > 2) {
      const land = predictLanding(ball, CONFIG.player.aerial.contactY);
      if (land) {
        this.receiveTarget = { x: land.x, z: land.z };
        this.receiveTimer = Math.max(this.receiveTimer, land.t + 0.8);
      }
    }
    if (this.runner === pass.mate) {
      // Пас на рывок отдан — дальше раннер живёт как обычный приёмщик
      this.runner = null;
      this.runnerTarget = null;
    }
    if (this.overlapper === pass.mate) {
      this.overlapper = null;
      this.overlapTarget = null;
    }
    if (from) {
      const fp = from.group.position;
      this.tryFollowRun(from,
        Math.hypot(pass.target.x - fp.x, pass.target.z - fp.z));
    }
  }
}
