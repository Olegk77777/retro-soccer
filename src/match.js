// Матч: 22 игрока, две команды, счёт, таймер, розыгрыш с центра,
// переключение управляемого игрока. Оркестратор — сам никого не «думает»:
// решения принимают тренеры (ai/team.js) и головы игроков (ai/*.js),
// человек управляет одним игроком через прежний Player.update.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Player } from './player.js';
import { Team } from './ai/team.js';
import { updateFieldPlayer } from './ai/fieldplayer.js';
import { updateKeeper } from './ai/goalkeeper.js';
import { distToBall, freeSpace } from './ai/steering.js';

function createControlledMarker() {
  const starPath = (tipRadius, notchRadius, clockwise = false) => {
    const path = clockwise ? new THREE.Path() : new THREE.Shape();
    for (let i = 0; i < 10; i++) {
      const radius = i % 2 === 0 ? tipRadius : notchRadius;
      const angle = Math.PI / 2 + (clockwise ? -1 : 1) * i * Math.PI / 5;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
    path.closePath();
    return path;
  };

  const hollowStar = (outerTip, outerNotch, innerTip, innerNotch) => {
    const shape = starPath(outerTip, outerNotch);
    shape.holes.push(starPath(innerTip, innerNotch, true));
    return shape;
  };

  const marker = new THREE.Group();
  const material = (color, opacity) => new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  // Полый центр оставляет газон видимым. Тёмная печатная кайма удерживает
  // огненно-жёлтый контур после 240p и CRT-размытия, особенно на белых линиях.
  const outline = new THREE.Mesh(
    new THREE.ShapeGeometry(hollowStar(0.86, 0.41, 0.56, 0.265)),
    material(0x6b3d00, 0.82),
  );
  const fire = new THREE.Mesh(
    new THREE.ShapeGeometry(hollowStar(0.78, 0.37, 0.60, 0.285)),
    material(0xffb800, 0.98),
  );
  fire.position.z = 0.008;
  outline.renderOrder = 3;
  fire.renderOrder = 4;
  marker.add(outline, fire);
  marker.rotation.x = -Math.PI / 2;
  marker.position.y = 0.045;
  return marker;
}

export class Match {
  // teamsData: [home.json, away.json]. Человек — команда 0, атакует +X.
  constructor(scene, ball, goals, input, teamsData) {
    this.ball = ball;
    this.goals = goals;
    this.input = input;

    const mkPlayers = (data) => CONFIG.formation.roles.map((r, i) =>
      new Player(scene, {
        kitColor: i === 0 ? data.colors.gk : data.colors.primary,
      }));
    this.teams = [
      new Team(this, +1, teamsData[0], mkPlayers(teamsData[0])),
      new Team(this, -1, teamsData[1], mkPlayers(teamsData[1])),
    ];
    this.humanTeam = this.teams[0];
    this._all = [...this.teams[0].players, ...this.teams[1].players];

    this.controlled = null;   // игрок под управлением человека
    this.possession = this.teams[0];
    this.toucher = null;      // кто из 22 сейчас у мяча (арбитраж владения)
    this.lastTouch = null;    // последнее касание — решает, чей аут/угловой
    this.restart = null;      // активный стандарт: аут / угловой / удар от ворот
    this.score = [0, 0];
    this.clock = 0;           // игровые секунды (0..90×60)
    this.state = 'kickoff';   // kickoff | play | goalpause | fulltime
    this.stateTimer = 0;
    this.kickoffTeam = 0;
    this.switchCd = 0;
    this.flashTimer = 0;

    // «Мяч в центре» — подставной объект на паузы (после гола настоящий мяч
    // лежит в сетке; AI строится к центру, а не толпится у ворот)
    this._centerBall = {
      mesh: { position: new THREE.Vector3(0, CONFIG.ball.radius, 0) },
      vel: new THREE.Vector3(),
    };

    // Полая огненно-жёлтая звезда — как курсор в футсимах 90-х.
    this.controlledMarker = createControlledMarker();
    scene.add(this.controlledMarker);

    // Табло-телеграфика
    this.hud = {
      home: document.getElementById('sb-home'),
      away: document.getElementById('sb-away'),
      score: document.getElementById('sb-score'),
      time: document.getElementById('sb-time'),
      flash: document.getElementById('goal-flash'),
    };
    this.hud.home.textContent = teamsData[0].short;
    this.hud.away.textContent = teamsData[1].short;
    this._hudCache = '';
    this._phase = ''; // фаза для контекстных тач-кнопок (атака/оборона)

    // Пас-ассист для игроков человека (AI пасует своим умом в team.js)
    for (const p of this.humanTeam.players) {
      p.passAssist = (player, type, power) => this.resolvePass(player, type, power);
    }

    this.kickoff(0);
  }

  get allPlayers() {
    return this._all;
  }

  otherTeam(t) {
    return t === this.teams[0] ? this.teams[1] : this.teams[0];
  }

  // Расстановка на розыгрыш с центра. kickingIdx — кто разыгрывает.
  kickoff(kickingIdx) {
    this.state = 'kickoff';
    this.stateTimer = 0;
    this.kickoffTeam = kickingIdx;
    this.restart = null;
    this.lastTouch = null;
    this.ball.reset();

    for (const team of this.teams) {
      team.attacking = false; // расстановка — оборонительная, своя половина
      team.receiver = null;
      team.receiveTarget = null;
      team.supporter = null;
      team.chaser = null;
      team.coverer = null;
      team.marks.clear();
      team.runner = null;
      team.runnerTarget = null;
      team.bestSpot = null;
      team.boxRuns.clear();
      team.crossAir = 0;
      team.defLineX = team.defLineTarget(this._centerBall); // линия сразу на месте
      for (const p of team.players) {
        const home = team.homeTarget(p, this._centerBall);
        // Все за пределами центрального круга (форварды с defOff не в круге)
        const x = Math.min(team.side * home.x, -10) * team.side;
        p.reset(x, home.z, Math.atan2(team.side, 0)); // лицом к чужим воротам
      }
    }

    // Разыгрывающая пара нападающих — к мячу
    const kt = this.teams[kickingIdx];
    const st1 = kt.players[9];
    const st2 = kt.players[10];
    st1.reset(-kt.side * 1.1, 0.4, Math.atan2(kt.side, 0));
    st2.reset(-kt.side * 3.0, -5, Math.atan2(kt.side, 0));

    this.possession = kt;
    this.toucher = null;
    for (const p of this._all) p.isToucher = false;

    // Человеку — ближнего к мячу полевого игрока
    this.setControlled(this.nearestFieldPlayer(this.humanTeam), 0);
  }

  nearestFieldPlayer(team, except = null) {
    let best = null;
    let bestD = Infinity;
    for (const p of team.fieldPlayers) {
      if (p === except) continue;
      const d = distToBall(p, this.ball);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  // Автодобегание включаем только к действительно свободному мячу или к
  // явной ошибке соперника. На уверенно владеющего соперника не наводимся:
  // иначе переключение превращалось бы в бесплатный отбор.
  armControlledApproach(p) {
    p.cancelBallApproach();
    if (this.state !== 'play' && this.state !== 'kickoff') return;
    const bp = this.ball.mesh.position;
    if (bp.y > CONFIG.player.approach.maxBallY) return;

    const owner = this.toucher;
    let loose = !owner;
    if (owner && owner !== p && owner.team !== p.team) {
      const op = owner.group.position;
      const ownerGap = Math.hypot(bp.x - op.x, bp.z - op.z);
      loose = ownerGap > CONFIG.ai.defence.badTouchDist;
    }
    if (owner === p || (owner && owner.team === p.team) || !loose) return;
    p.beginBallApproach('switch', this.ball);
  }

  validateControlledApproach() {
    const p = this.controlled;
    const a = p && p.ballApproach;
    if (!a) return;
    if ((this.state !== 'play' && this.state !== 'kickoff') ||
        p.downT > 0 || p.kickCooldown > 0) {
      p.cancelBallApproach();
      return;
    }

    const owner = this.toucher;
    if (!owner || owner === p) return;
    if (a.kind === 'dribble' || owner.team === p.team) {
      p.cancelBallApproach();
      return;
    }
    const bp = this.ball.mesh.position;
    const op = owner.group.position;
    const ownerGap = Math.hypot(bp.x - op.x, bp.z - op.z);
    if (ownerGap <= CONFIG.ai.defence.badTouchDist) p.cancelBallApproach();
  }

  setControlled(p, cd = CONFIG.ai.switch.cooldown) {
    if (!p) return;
    if (p === this.controlled) {
      this.switchCd = cd;
      this.armControlledApproach(p);
      return;
    }
    if (this.controlled) this.controlled.cancelBallApproach();
    this.controlled = p;
    this.switchCd = cd;
    p.pendingStrike = null;
    p.strikeContactLock = false;
    p.chargeRun = false;
    if (p.ai) p.ai.dribDir = null;
    this.armControlledApproach(p);
  }

  update(dt) {
    const M = CONFIG.match;
    this.stateTimer += dt;
    if (this.switchCd > 0) this.switchCd -= dt;

    // «ГОЛ!» на экране гаснет сам
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.hud.flash.classList.remove('show');
    }

    // Игровые часы: 90 минут сжаты в realMinutes реальных.
    // На стандартах время идёт — как в настоящей трансляции
    if (this.state === 'kickoff' || this.state === 'play' || this.state === 'restart') {
      this.clock += dt * (M.gameMinutes / M.realMinutes);
      if (this.clock >= M.gameMinutes * 60) this.fullTime();
    }

    // Пауза после гола: дать сетке и повтору «подышать», потом — с центра
    if (this.state === 'goalpause' && this.stateTimer > CONFIG.goal.resetDelay) {
      this.goals.reset();
      this.kickoff(this.kickoffTeam);
    }
    // Финальный свисток: пауза и новый матч
    if (this.state === 'fulltime' && this.stateTimer > M.fulltimePause) {
      this.score = [0, 0];
      this.clock = 0;
      this.hud.flash.classList.remove('show');
      this.flashTimer = 0;
      this.goals.reset();
      this.kickoff(1 - this.kickoffTeam);
    }

    // Розыгрыш AI с центра: выдержал паузу — отдал пас
    if (this.state === 'kickoff') {
      const kt = this.teams[this.kickoffTeam];
      if (kt !== this.humanTeam && this.stateTimer > M.kickoffDelay) {
        const st = kt.players[9];
        const pass = kt.choosePass(st, this.ball);
        if (pass) {
          st.aiKick(this.ball, pass.dir, pass.power, pass.lift);
          kt.commitPass(pass);
        } else {
          st.aiKick(this.ball, { x: -kt.side * 0.5, z: 0.86 }, 12, 0.5);
        }
        this.state = 'play';
      }
      // Человек разыгрывает сам: мяч сдвинулся — игра пошла
      if (this.ball.vel.lengthSq() > 0.4) this.state = 'play';
    }

    // Стандарты (Фаза 2): мяч полностью пересёк линию — аут/угловой/от ворот
    if (this.state === 'play') this.checkOutOfPlay();
    if (this.state === 'restart' && this.restart) this.updateRestart(dt);

    // На паузах AI строится к центру (настоящий мяч лежит в сетке)
    const paused = this.state === 'goalpause' || this.state === 'fulltime';
    const aiBall = paused ? this._centerBall : this.ball;

    // Мёртвый мяч стандарта арбитражу владения не принадлежит никому
    if (!paused && this.state !== 'restart') this.updateToucher();
    this.validateControlledApproach();

    for (const team of this.teams) team.update(dt, aiBall);

    this.updateSwitching();

    for (const team of this.teams) {
      for (const p of team.players) {
        if (this.restart && p === this.restart.taker) this.updateTaker(p, dt);
        else if (p === this.controlled) p.update(dt, this.input, this.ball);
        else if (p.isKeeper) updateKeeper(p, dt, aiBall);
        else updateFieldPlayer(p, dt, aiBall);
      }
    }

    // Установленный мяч стандарта не сдвигают ни физика, ни чужие касания.
    // В замахе вбрасывания мяч живёт в руках над головой исполнителя
    if (this.state === 'restart' && this.restart && this.restart.phase !== 'dead') {
      const r = this.restart;
      if (r.phase === 'throw' && r.pending) {
        const tp = r.taker.group.position;
        this.ball.mesh.position.set(
          tp.x + r.pending.dir.x * 0.25,
          CONFIG.restart.throwIn.releaseY,
          tp.z + r.pending.dir.z * 0.25,
        );
      } else {
        this.ball.mesh.position.set(r.x, CONFIG.ball.radius, r.z);
      }
      this.ball.vel.set(0, 0, 0);
    }

    // Звезда следует за управляемым
    if (this.controlled) {
      const cp = this.controlled.group.position;
      this.controlledMarker.position.x = cp.x;
      this.controlledMarker.position.z = cp.z;
    }

    this.updateHUD();
  }

  // Кто у мяча: ближайший из 22 в радиусе контроля. Только он «владеет» —
  // липкое ведение и дриблинг остальных отключаются (иначе мяч рвали бы
  // на части все, кто рядом). Отборы по-настоящему — Фаза 3.
  updateToucher() {
    const B = CONFIG.ball;
    const P = CONFIG.player;
    const bp = this.ball.mesh.position;
    let best = null;
    let bestD = Infinity;
    let touch = null;
    let touchD = Infinity;
    const lowBall = bp.y < B.radius * 2.2;
    // Последнее касание (для аутов/угловых) шире арбитража владения: удары
    // исполняются из kickRadius, верховые сыгровки — из зоны замыкания.
    // Линию почти всегда решает настоящий удар, а бьющий в тот кадр — ближний
    const touchReach = bp.y < P.kickMaxBallY ? P.kickRadius : P.aerial.reach;
    const touchable = bp.y < P.aerial.maxY;
    for (const p of this._all) {
      const d = distToBall(p, this.ball);
      if (lowBall) {
        const reach = p.controlling ? P.controlKeepRadius : P.controlRadius;
        if (d < reach && d < bestD) {
          bestD = d;
          best = p;
        }
      }
      if (touchable && d < touchReach && d < touchD) {
        touchD = d;
        touch = p;
      }
    }
    // Кипер с мячом в руках — безусловный владелец (мяч на высоте рук,
    // обычный радиус-арбитраж его не видит)
    for (const team of this.teams) {
      if (team.keeper.ai && team.keeper.ai.holdT > 0) {
        best = team.keeper;
        touch = team.keeper;
      }
    }
    this.toucher = best;
    for (const p of this._all) p.isToucher = p === best;
    if (best) this.possession = best.team;
    if (touch) this.lastTouch = touch;
  }

  // Переключение управляемого игрока: Q/LB — вручную (ближний к мячу),
  // авто — партнёр принял мяч, или мяч свободен/у соперника, а сосед
  // ощутимо ближе текущего (с кулдауном против дёрганья)
  updateSwitching() {
    const SW = CONFIG.ai.switch;
    const team = this.humanTeam;

    // Свой стандарт: курсор прибит к исполнителю до розыгрыша
    if (this.state === 'restart' && this.restart &&
        this.restart.team === team && this.restart.type !== 'goalkick') {
      this.input.consumeSwitch();
      return;
    }
    const manual = this.input.consumeSwitch();

    if (manual) {
      this.setControlled(this.nearestFieldPlayer(team, this.controlled), 0.25);
      return;
    }
    if (this.switchCd > 0) return;

    // Партнёр взял мяч — управление к нему (как после паса в PES)
    if (this.toucher && this.toucher.team === team &&
        !this.toucher.isKeeper && this.toucher !== this.controlled) {
      this.setControlled(this.toucher, 0.4);
      return;
    }

    // Мяч свободен или у соперника: сосед заметно ближе — переключаемся
    if (!this.toucher || this.toucher.team !== team) {
      const cur = this.controlled ? distToBall(this.controlled, this.ball) : Infinity;
      const near = this.nearestFieldPlayer(team, this.controlled);
      if (near) {
        const nd = distToBall(near, this.ball);
        if (nd < cur * SW.advantage && cur - nd > 2.5) this.setControlled(near);
      }
    }
  }

  // Пас-ассист человека: адресат — партнёр в конусе взгляда; направление
  // доворачивается с упреждением на его бег, партнёр бросается встречать.
  // Уровень помощи (слайдер 10–30%, как у ударов): шире конус поиска и
  // подтяжка силы полоски к дистанции адресата. aimDir — направление
  // намерения (стик в момент паса), по умолчанию взгляд игрока.
  resolvePass(player, type, power, aimDir = null) {
    const HP = CONFIG.ai.humanPass;
    const AS = HP.assist;
    const team = player.team;
    if (!team) return null;
    const f = aimDir || player.facing;
    const pos = player.group.position;
    const coneCos = AS.coneBase - AS.level * AS.coneWiden;

    let best = null;
    let bestScore = -Infinity;
    for (const mate of team.players) {
      if (mate === player || mate.isKeeper) continue;
      const mp = mate.group.position;
      const dx = mp.x - pos.x;
      const dz = mp.z - pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < HP.minDist || dist > HP.maxDist) continue;
      const cos = (dx * f.x + dz * f.z) / dist;
      if (cos < coneCos) continue;
      const score = cos * 30 - dist * 0.25; // ближе к линии взгляда и не слишком далеко
      if (score > bestScore) {
        bestScore = score;
        best = { mate, dist };
      }
    }
    if (!best) return null;

    // Помощь в силе: полоска тянется к «идеальной для дистанции» на долю
    // level×powerPull. Осознанная передержка всё равно уводит мяч дальше
    const ideal = best.dist * AS.idealK;
    const P = CONFIG.player;
    const cfg = type === 'through' ? P.through : P.pass;
    let outPower = power + (ideal - power) * Math.min(1, AS.level * AS.powerPull);
    outPower = Math.max(cfg.powerMin * 0.8, Math.min(cfg.powerMax * 1.3, outPower));

    const lead = type === 'through' ? HP.leadThrough : HP.lead;
    const t = best.dist / Math.max(outPower, 6);
    const mp = best.mate.group.position;
    const tx = mp.x + best.mate.vel.x * t * lead;
    const tz = mp.z + best.mate.vel.z * t * lead;
    const d = Math.hypot(tx - pos.x, tz - pos.z) || 1;

    team.receiver = best.mate;
    team.receiveTarget = { x: tx, z: tz };
    team.receiveTimer = CONFIG.ai.receiveGiveUp;

    return { dir: new THREE.Vector3((tx - pos.x) / d, 0, (tz - pos.z) / d), power: outPower };
  }

  // ===== Стандарты: ауты, угловые, удары от ворот (Фаза 2, 21.07.2026) =====

  // Мяч полностью пересёк линию (весь мяч за линией, как в правилах).
  // Голы сюда не попадают: goal.js ловит их раньше и ставит goalpause.
  checkOutOfPlay() {
    const F = CONFIG.field;
    const R = CONFIG.restart;
    const bp = this.ball.mesh.position;
    const rr = CONFIG.ball.radius;
    if (this.ball.goalScored) return;
    const halfL = F.length / 2;
    const halfW = F.width / 2;
    const lastTeam = this.lastTouch ? this.lastTouch.team : this.possession;

    if (Math.abs(bp.z) > halfW + rr) {
      // Боковая линия — вбрасывание команды, которая мяча НЕ касалась
      const sz = Math.sign(bp.z);
      const x = Math.max(-halfL + 1, Math.min(halfL - 1, bp.x));
      this.beginRestart('throwin', this.otherTeam(lastTeam), x, sz * (halfW - R.lineInset));
    } else if (Math.abs(bp.x) > halfL + rr) {
      // Лицевая линия: от обороняющихся — угловой, от атакующих — от ворот
      const sx = Math.sign(bp.x);
      const sz = Math.sign(bp.z || 1);
      const defTeam = this.teams.find((t) => Math.sign(t.ownGoalX) === sx);
      if (lastTeam === defTeam) {
        this.beginRestart('corner', this.otherTeam(defTeam),
          sx * (halfL - R.lineInset), sz * (halfW - R.lineInset));
      } else {
        this.beginRestart('goalkick', defTeam,
          sx * (halfL - R.goalKick.x), sz * R.goalKick.z);
      }
    }
  }

  nearestToPoint(players, x, z) {
    let best = null;
    let bestD = Infinity;
    for (const p of players) {
      const pp = p.group.position;
      const d = Math.hypot(pp.x - x, pp.z - z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  // Назначить стандарт: мяч мёртв, владение снято, исполнитель идёт к точке.
  // Свой аут/угловой человек исполняет сам (курсор на исполнителе), удар
  // от ворот всегда бьёт AI-кипер — как в старых футсимах.
  beginRestart(type, team, x, z) {
    this.state = 'restart';
    this.stateTimer = 0;
    const taker = type === 'goalkick'
      ? team.keeper
      : this.nearestToPoint(team.fieldPlayers, x, z);
    this.restart = { type, team, x, z, taker, phase: 'dead', t: 0 };

    this.toucher = null;
    for (const p of this._all) p.isToucher = false;
    this.possession = team; // тренеры строятся: одни в атаку, другие в оборону
    for (const t of this.teams) {
      t.receiver = null;
      t.receiveTarget = null;
      t.runner = null;
      t.runnerTarget = null;
      t.crossAir = 0;
      t.boxRuns.clear();
    }
    if (this.controlled) {
      this.controlled.pendingStrike = null;
      this.controlled.strikeContactLock = false;
      this.controlled.cancelBallApproach();
    }
    if (team === this.humanTeam && type !== 'goalkick') this.setControlled(taker, 1.0);

    const label = { throwin: 'АУТ', corner: 'УГЛОВОЙ', goalkick: 'ОТ ВОРОТ' };
    this.hud.flash.textContent = label[type];
    this.hud.flash.classList.add('show');
    this.flashTimer = CONFIG.restart.flashTime;
  }

  // Точка, где стоит исполнитель: чуть снаружи от мяча
  _restartStand(r) {
    if (r.type === 'throwin') {
      const sz = Math.sign(r.z || 1);
      return { x: r.x, z: r.z + sz * 0.9 };
    }
    if (r.type === 'corner') {
      return { x: r.x + Math.sign(r.x || 1) * 0.8, z: r.z + Math.sign(r.z || 1) * 0.8 };
    }
    return { x: r.x - r.team.side, z: r.z }; // удар от ворот: за мячом
  }

  // Куда исполнитель смотрит, пока ждёт (человек может довернуть стиком)
  _restartFaceTarget(r) {
    const F = CONFIG.field;
    if (r.type === 'corner') return { x: r.team.side * (F.length / 2 - 11), z: 0 };
    if (r.type === 'goalkick') return { x: 0, z: 0 };
    return { x: r.x + r.team.side * 12, z: r.z * 0.2 };
  }

  // Направление розыгрыша: стик человека, иначе разумный дефолт вперёд-внутрь
  _restartAim(r) {
    const im = this.input.move;
    const l = Math.hypot(im.x, im.z);
    if (r.team === this.humanTeam && l > 0.3) return { x: im.x / l, z: im.z / l };
    if (r.type === 'throwin') {
      const sz = Math.sign(r.z || 1);
      const d = Math.hypot(r.team.side * 0.8, 0.6);
      return { x: (r.team.side * 0.8) / d, z: (-sz * 0.6) / d };
    }
    const t = this._restartFaceTarget(r);
    const dx = t.x - r.x;
    const dz = t.z - r.z;
    const d2 = Math.hypot(dx, dz) || 1;
    return { x: dx / d2, z: dz / d2 };
  }

  // Установить мёртвый мяч на точку (сбрасывает и хвосты прошлой жизни мяча)
  _placeBall(x, z) {
    const b = this.ball;
    b.mesh.position.set(x, CONFIG.ball.radius, z);
    b.vel.set(0, 0, 0);
    b.spin = 0;
    b.afterTouch = 0;
    b.goalScored = false;
    b.netContact = null;
    if (b.mark) b.mark.visible = false;
  }

  // Исполнитель: дойти до точки, встать, смотреть в поле (или по стику)
  updateTaker(p, dt) {
    const r = this.restart;
    // Замах вбрасывания: стоим, корпус по направлению броска
    if (r.phase === 'throw' && r.pending) {
      p.aiUpdate(dt, { x: 0, z: 0 },
        { face: Math.atan2(r.pending.dir.x, r.pending.dir.z) });
      return;
    }
    const stand = this._restartStand(r);
    const pos = p.group.position;
    const dx = stand.x - pos.x;
    const dz = stand.z - pos.z;
    const d = Math.hypot(dx, dz);
    let move = { x: 0, z: 0 };
    if (d > 0.25) {
      const k = Math.min(1, d / 2.5); // у точки — шагом, не юзом
      move = { x: (dx / d) * k, z: (dz / d) * k };
    }
    let face = null;
    if (d < 1.5) {
      const ft = this._restartFaceTarget(r);
      face = Math.atan2(ft.x - pos.x, ft.z - pos.z);
      const im = this.input.move;
      if (r.team === this.humanTeam && r.type !== 'goalkick' &&
          Math.hypot(im.x, im.z) > 0.3) {
        face = Math.atan2(im.x, im.z);
      }
    }
    p.aiUpdate(dt, move, { face, sprint: d > 2.5 }); // к точке — бегом, не прогулкой
  }

  // Жизнь стандарта: свисток → установка мяча → подход → исполнение.
  // Человек бьёт своими кнопками (та же полоска), AI — после короткой паузы
  updateRestart(dt) {
    const R = CONFIG.restart;
    const r = this.restart;
    r.t += dt;

    // Замах вбрасывания: клип уже идёт, мяч в руках — выпуск по таймеру
    if (r.phase === 'throw') {
      if (r.t >= R.throwIn.releaseDelay) this._releaseThrow(r);
      return;
    }

    // «Свисток»: мяч ещё докатывается за линией, потом встаёт на точку
    if (r.phase === 'dead') {
      if (r.t >= R.outDelay) {
        r.phase = 'walk';
        r.t = 0;
        this._placeBall(r.x, r.z);
        // ТВ-склейка: дальний исполнитель не бежит через полполя — после
        // монтажной паузы он уже в кадре у точки (камера панорамирует туда)
        const st = this._restartStand(r);
        const tp = r.taker.group.position;
        if (Math.hypot(st.x - tp.x, st.z - tp.z) > R.snapDist) {
          const ft = this._restartFaceTarget(r);
          r.taker.reset(st.x, st.z, Math.atan2(ft.x - st.x, ft.z - st.z));
        }
      }
      return;
    }

    const stand = this._restartStand(r);
    const tp = r.taker.group.position;
    const d = Math.hypot(stand.x - tp.x, stand.z - tp.z);
    if (r.phase === 'walk') {
      if (d < 1.0 || r.t > R.walkTimeout) {
        r.phase = 'ready';
        r.t = 0;
      } else return;
    }

    const humanTakes = r.team === this.humanTeam && r.type !== 'goalkick';
    if (!humanTakes) {
      if (r.t >= R.aiDelay) this.executeAIRestart(r);
      return;
    }

    // Человек: снимаем ВСЕ события кнопок (несъеденное событие после
    // розыгрыша выстрелило бы «ударом из ниоткуда») и исполняем нужное
    const pass = this.input.pass.consume();
    const through = this.input.through.consume();
    const cross = this.input.consumeCross();
    const shot = this.input.shot.consume();
    const swipe = this.input.consumeSwipe();
    const aim = this._restartAim(r);

    if (r.type === 'corner') {
      if (cross) this.executeCorner(r, cross);
      else if (swipe) this.executeCornerSwipe(r, swipe);
      else if (pass !== null) this.executeRestartPass(r, 'pass', pass, aim);
      else if (through !== null) this.executeRestartPass(r, 'through', through, aim);
      else if (shot !== null) this.executeCorner(r, { charge: shot, taps: 3 }); // УДАР = прострел
    } else {
      // Аут: любая кнопка — бросок; ПАС с ассистом на ближнего, НА ХОД /
      // НАВЕС — сильнее и на ход, свайп — по нарисованному направлению
      if (pass !== null) this.executeThrowIn(r, 'pass', pass, aim);
      else if (through !== null) this.executeThrowIn(r, 'through', through, aim);
      else if (cross) this.executeThrowIn(r, 'through', cross.charge, aim);
      else if (shot !== null) this.executeThrowIn(r, 'pass', shot, aim);
      else if (swipe) this.executeThrowSwipe(r, swipe);
    }
  }

  _finishRestart() {
    this.restart = null;
    this.state = 'play';
  }

  // Замах вбрасывания: клип стартует СРАЗУ, мяч уходит из рук только через
  // releaseDelay — раньше мяч вылетал до начала анимации (фидбек Олега)
  _scheduleThrow(r, dir, power) {
    const dl = Math.hypot(dir.x, dir.z) || 1;
    r.pending = { dir: { x: dir.x / dl, z: dir.z / dl }, power };
    r.phase = 'throw';
    r.t = 0;
    r.taker.rot = Math.atan2(dir.x, dir.z);
    r.taker.playOneShot('throwin', 1.15, 0.1);
  }

  // Выпуск мяча из рук (фаза throw по таймеру замаха)
  _releaseThrow(r) {
    const R = CONFIG.restart.throwIn;
    const taker = r.taker;
    const tp = taker.group.position;
    const nd = r.pending.dir;
    this.ball.mesh.position.set(tp.x + nd.x * 0.35, R.releaseY, tp.z + nd.z * 0.35);
    this.ball.strike(nd, r.pending.power, R.lift);
    this.ball.spin = 0;
    this.ball.afterTouch = 0; // руками мяч в полёте не докручивают
    taker.kickCooldown = CONFIG.player.kickCooldown;
    this._finishRestart();
  }

  executeThrowIn(r, type, charge, aim) {
    const R = CONFIG.restart.throwIn;
    let power = R.powerMin + (R.powerMax - R.powerMin) * charge; // >1 — передержка
    let dir = aim;
    const assist = this.resolvePass(r.taker, type, power, new THREE.Vector3(aim.x, 0, aim.z));
    if (assist) {
      dir = { x: assist.dir.x, z: assist.dir.z };
      power = Math.min(assist.power, R.powerMax * 1.15); // руками сильнее не бросить
    }
    this._scheduleThrow(r, dir, power);
  }

  // Планшет: бросок по нарисованному направлению, длина жеста = сила
  executeThrowSwipe(r, swipe) {
    const R = CONFIG.restart.throwIn;
    const power = R.powerMin + (R.powerMax - R.powerMin) * Math.min(swipe.power, 1.3);
    this._scheduleThrow(r, swipe.dir, power);
  }

  // Угловой человека — обычная PES-машина навеса: полоска = адрес
  // (ближняя → центр → дальняя), тапы = тип дуги, стрелки уточняют точку.
  // Корпус ставим строго поперёк поля: crossSolution сам возьмёт нужные
  // ворота по позиции (взгляд с угла «в поле» сбивал бы ему сторону атаки)
  executeCorner(r, ev) {
    r.taker.rot = Math.atan2(0, -Math.sign(r.z || 1));
    r.taker.doCross(ev, this.input, this.ball);
    this._finishRestart();
  }

  executeCornerSwipe(r, swipe) {
    r.taker.rot = Math.atan2(0, -Math.sign(r.z || 1));
    r.taker.swipeShot(swipe, this.input, this.ball);
    this._finishRestart();
  }

  // Короткий розыгрыш углового пасом (с обычным пас-ассистом)
  executeRestartPass(r, type, charge, aim) {
    const P = CONFIG.player;
    const cfg = type === 'through' ? P.through : P.pass;
    let power = cfg.powerMin + (cfg.powerMax - cfg.powerMin) * charge;
    const aimVec = new THREE.Vector3(aim.x, 0, aim.z);
    const assist = this.resolvePass(r.taker, type, power, aimVec);
    const dir = assist ? assist.dir : aimVec;
    if (assist) power = assist.power;
    this.ball.strike(dir, power, cfg.lift);
    r.taker.rot = Math.atan2(dir.x, dir.z);
    r.taker.kickCooldown = P.kickCooldown;
    r.taker.playOneShot('kick', 1.6, 0.20);
    this._finishRestart();
  }

  // AI-исполнение: вбрасывание ближнему, угловой на свободного в штрафной,
  // удар от ворот — короткий розыгрыш или вынос на фланг
  executeAIRestart(r) {
    const F = CONFIG.field;
    const team = r.team;
    const taker = r.taker;

    if (r.type === 'throwin') {
      const R = CONFIG.restart.throwIn;
      const tp = taker.group.position;
      // Адресный бросок ближнему СВОБОДНОМУ своему. choosePass не годится:
      // он ценит продвижение вперёд и охотно бросал «в никуда» вдоль
      // бровки (фидбек Олега) — руками важна точность, а не метры
      let best = null;
      let bestScore = -Infinity;
      for (const mate of team.players) {
        if (mate === taker || mate.isKeeper) continue;
        const mp = mate.group.position;
        const dist = Math.hypot(mp.x - tp.x, mp.z - tp.z);
        if (dist < 3 || dist > R.aiMaxDist) continue;
        if (Math.abs(mp.x) > F.length / 2 - 1 || Math.abs(mp.z) > F.width / 2 - 1) continue;
        const score = freeSpace(mp.x, mp.z, team.opponents) * 3 +
          team.side * (mp.x - tp.x) * 0.06 - dist * 0.1;
        if (score > bestScore) {
          bestScore = score;
          best = { mate, dist };
        }
      }
      let dir;
      let power;
      if (best) {
        const mp = best.mate.group.position;
        const t = best.dist / 10;
        const txx = mp.x + best.mate.vel.x * t * 0.6;
        const tzz = mp.z + best.mate.vel.z * t * 0.6;
        const dl = Math.hypot(txx - tp.x, tzz - tp.z) || 1;
        dir = { x: (txx - tp.x) / dl, z: (tzz - tp.z) / dl };
        power = Math.max(R.powerMin, Math.min(R.aiPowerMax, best.dist * 0.85));
        team.receiver = best.mate; // адресат бросается встречать
        team.receiveTarget = { x: txx, z: tzz };
        team.receiveTimer = CONFIG.ai.receiveGiveUp;
      } else {
        // совсем никого в радиусе броска — коротко вперёд-внутрь
        const sz = Math.sign(r.z || 1);
        const dl = Math.hypot(team.side * 0.8, 0.6);
        dir = { x: (team.side * 0.8) / dl, z: (-sz * 0.6) / dl };
        power = 10;
      }
      this._scheduleThrow(r, dir, power);
      return;
    }

    if (r.type === 'corner') {
      const RC = CONFIG.restart.corner;
      const pos = taker.group.position;
      const boxX = F.length / 2 - 16.5;
      // Адресат — свой в штрафной с самой свободной зоной (как AI-навес)
      let target = null;
      let bestSpace = -1;
      for (const m of team.players) {
        if (m === taker || m.isKeeper) continue;
        const mp = m.group.position;
        if (team.side * mp.x < boxX - 3 || Math.abs(mp.z) > 20.16) continue;
        const space = freeSpace(mp.x, mp.z, team.opponents);
        if (space > bestSpace) {
          bestSpace = space;
          target = { x: mp.x + m.vel.x * 0.5, z: mp.z + m.vel.z * 0.5 };
        }
      }
      if (!target) {
        target = { x: team.side * (F.length / 2 - 8), z: -Math.sign(r.z || 1) * RC.farPostZ };
      }
      const dx = target.x - pos.x;
      const dz = target.z - pos.z;
      const dist = Math.hypot(dx, dz) || 1;
      const theta = (RC.angle * Math.PI) / 180;
      let power = Math.sqrt((-CONFIG.ball.gravity * dist) / (2 * Math.tan(theta))) * RC.powerFudge;
      power = Math.max(RC.powerMin, Math.min(RC.powerMax, power));
      taker.aiKick(this.ball, { x: dx / dist, z: dz / dist }, power, power * Math.tan(theta), 0,
        { name: 'kick', ts: 1.2, at: 0.16 });
      team.onCrossStruck(this.ball); // замыкающий врывается на прилёт
      this._finishRestart();
      return;
    }

    // Удар от ворот: разыграть коротко, если есть чистый адресат, иначе вынос
    const K = CONFIG.ai.keeper;
    const pass = team.choosePass(taker, this.ball);
    if (pass) {
      taker.aiKick(this.ball, pass.dir, pass.power, pass.lift, 0,
        { name: 'kick', ts: 1.4, at: 0.18 });
      team.commitPass(pass);
    } else {
      const zs = Math.sign(r.z || 1);
      const dl = Math.hypot(team.side, zs * 0.5);
      taker.aiKick(this.ball, { x: team.side / dl, z: (zs * 0.5) / dl },
        K.clearPower, K.clearLift, 0, { name: 'kick', ts: 1.4, at: 0.18 });
    }
    this._finishRestart();
  }

  // Пауза = мяч мёртв: кипер не держит его в руках. Без этого его отложенный
  // вынос по таймеру бил бы подставной _centerBall без метода strike (старый
  // TypeError из аудита 18.07.2026)
  _releaseKeeperHolds() {
    for (const team of this.teams) {
      if (team.keeper.ai) {
        team.keeper.ai.holdT = 0;
        team.keeper.ai.dropkickStarted = false;
      }
    }
  }

  // Гол: определяем сторону по позиции мяча, счёт, пауза, потом розыгрыш
  onGoal() {
    if (this.state !== 'play' && this.state !== 'kickoff') return;
    const side = this.ball.mesh.position.x > 0 ? 1 : -1; // в чьи ворота влетело
    const scorerIdx = this.teams.findIndex((t) => t.side === side);
    this.score[scorerIdx]++;
    this.kickoffTeam = 1 - scorerIdx; // разыгрывает пропустившая команда
    this.state = 'goalpause';
    this.stateTimer = 0;
    // Мяч в сетке — владение снимается, никто не «ведёт» его сквозь ворота
    this.toucher = null;
    for (const p of this._all) p.isToucher = false;
    this._releaseKeeperHolds();
    this.hud.flash.textContent = 'ГОЛ!';
    this.hud.flash.classList.add('show');
    this.flashTimer = 2.0;
  }

  fullTime() {
    this.state = 'fulltime';
    this.stateTimer = 0;
    this.restart = null; // свисток мог застать стандарт — бросаем его
    this._releaseKeeperHolds();
    this.hud.flash.textContent = `МАТЧ ОКОНЧЕН ${this.score[0]}:${this.score[1]}`;
    this.hud.flash.classList.add('show');
    this.flashTimer = CONFIG.match.fulltimePause;
  }

  updateHUD() {
    // Контекстные тач-кнопки (как в мобильных футсимах): владеем мячом —
    // ПАС/УДАР, обороняемся — КОРПУС/ВЫНОС. CSS переключает по data-phase
    const phase = this.possession === this.humanTeam ? 'attack' : 'defend';
    if (phase !== this._phase) {
      this._phase = phase;
      document.body.dataset.phase = phase;
    }

    const min = Math.min(90, Math.floor(this.clock / 60));
    const key = `${this.score[0]}:${this.score[1]}|${min}`;
    if (key === this._hudCache) return;
    this._hudCache = key;
    this.hud.score.textContent = `${this.score[0]}:${this.score[1]}`;
    this.hud.time.textContent = `${min}'`;
  }
}
