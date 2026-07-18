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
import { distToBall } from './ai/steering.js';

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

    // Кольцо-маркер под управляемым игроком (жёлтое, читается с ТВ-камеры)
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.78, 24),
      new THREE.MeshBasicMaterial({ color: 0xe8d44d, transparent: true, opacity: 0.85 }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.04;
    scene.add(this.ring);

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

  setControlled(p, cd = CONFIG.ai.switch.cooldown) {
    if (!p || p === this.controlled) return;
    this.controlled = p;
    this.switchCd = cd;
    p.pendingStrike = null;
    p.chargeRun = false;
    if (p.ai) p.ai.dribDir = null;
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

    // Игровые часы: 90 минут сжаты в realMinutes реальных
    if (this.state === 'kickoff' || this.state === 'play') {
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

    // На паузах AI строится к центру (настоящий мяч лежит в сетке)
    const paused = this.state === 'goalpause' || this.state === 'fulltime';
    const aiBall = paused ? this._centerBall : this.ball;

    if (!paused) this.updateToucher();

    for (const team of this.teams) team.update(dt, aiBall);

    this.updateSwitching();

    for (const team of this.teams) {
      for (const p of team.players) {
        if (p === this.controlled) p.update(dt, this.input, this.ball);
        else if (p.isKeeper) updateKeeper(p, dt, aiBall);
        else updateFieldPlayer(p, dt, aiBall);
      }
    }

    // Кольцо следует за управляемым
    if (this.controlled) {
      const cp = this.controlled.group.position;
      this.ring.position.x = cp.x;
      this.ring.position.z = cp.z;
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
    if (bp.y < B.radius * 2.2) {
      for (const p of this._all) {
        const d = distToBall(p, this.ball);
        const reach = p.controlling ? P.controlKeepRadius : P.controlRadius;
        if (d < reach && d < bestD) {
          bestD = d;
          best = p;
        }
      }
    }
    // Кипер с мячом в руках — безусловный владелец (мяч на высоте рук,
    // обычный радиус-арбитраж его не видит)
    for (const team of this.teams) {
      if (team.keeper.ai && team.keeper.ai.holdT > 0) best = team.keeper;
    }
    this.toucher = best;
    for (const p of this._all) p.isToucher = p === best;
    if (best) this.possession = best.team;
  }

  // Переключение управляемого игрока: Q/LB — вручную (ближний к мячу),
  // авто — партнёр принял мяч, или мяч свободен/у соперника, а сосед
  // ощутимо ближе текущего (с кулдауном против дёрганья)
  updateSwitching() {
    const SW = CONFIG.ai.switch;
    const team = this.humanTeam;
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
    this.hud.flash.textContent = 'ГОЛ!';
    this.hud.flash.classList.add('show');
    this.flashTimer = 2.0;
  }

  fullTime() {
    this.state = 'fulltime';
    this.stateTimer = 0;
    this.hud.flash.textContent = `МАТЧ ОКОНЧЕН ${this.score[0]}:${this.score[1]}`;
    this.hud.flash.classList.add('show');
    this.flashTimer = CONFIG.match.fulltimePause;
  }

  updateHUD() {
    const min = Math.min(90, Math.floor(this.clock / 60));
    const key = `${this.score[0]}:${this.score[1]}|${min}`;
    if (key === this._hudCache) return;
    this._hudCache = key;
    this.hud.score.textContent = `${this.score[0]}:${this.score[1]}`;
    this.hud.time.textContent = `${min}'`;
  }
}
