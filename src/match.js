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
import { playWhistle } from './sfx.js';

// Плавная кривая 0..1 (smoothstep): кино-движение камеры интро без рывков
function smooth01(t) {
  const k = Math.max(0, Math.min(1, t));
  return k * k * (3 - 2 * k);
}

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
      hint: document.getElementById('hint'),
    };
    this.hud.home.textContent = teamsData[0].short;
    this.hud.away.textContent = teamsData[1].short;
    this._hintHTML = this.hud.hint ? this.hud.hint.innerHTML : '';
    this._keeperHintShown = false;
    this._tempHint = false;

    // ТВ-заставка: параметрическая камера интро ({pos, look, mix, fading})
    this.introCam = null;
    this.introPhase = null;
    this.introT = 0;
    this._hudCache = '';
    this._phase = ''; // фаза для контекстных тач-кнопок (атака/оборона)

    // Пас-ассист для игроков человека (AI пасует своим умом в team.js)
    for (const p of this.humanTeam.players) {
      p.passAssist = (player, type, power) => this.resolvePass(player, type, power);
    }

    this.kickoff(0);
    this.startIntro(); // премьера матча — ТВ-заставка с крупного плана мяча
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
      team.overlapper = null;
      team.overlapTarget = null;
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

  // ===== ТВ-заставка перед матчем (22.07.2026) =====
  // Крупный план Tricolore на центральной точке → свисток → камера медленно
  // отлетает и показывает пару нападающих → ПАС (любая кнопка действия)
  // разыгрывает с центра, камера доезжает в игровое положение уже по живой
  // игре. Кадры и тайминги — CONFIG.intro; расстановка уже сделана kickoff().
  startIntro() {
    this.state = 'intro';
    this.stateTimer = 0;
    this.introPhase = 'ball';
    this.introT = 0;
    this._introWhistled = false;
    this.introCam = {
      pos: new THREE.Vector3(),
      look: new THREE.Vector3(),
      mix: 1,
      fading: false,
    };
    this.controlledMarker.visible = false; // звезда не мельтешит в кино-кадре
    this._setTempHint('');
  }

  updateIntro(dt) {
    const I = CONFIG.intro;
    this.introT += dt;
    const s = this.teams[this.kickoffTeam].side; // кадры зеркалятся под сторону

    // Игроки стоят по местам и «дышат» (idle, вратарь — своей стойкой),
    // мяч мёртв на центральной точке
    for (const p of this._all) p.aiUpdate(dt, { x: 0, z: 0 }, {});
    this.ball.mesh.position.set(0, CONFIG.ball.radius, 0);
    this.ball.vel.set(0, 0, 0);

    // Гасим шальные события ввода; любая кнопка действия = «начали!»
    this.input.consumeSwitch();
    const start =
      this.input.pass.consume() !== null ||
      this.input.through.consume() !== null ||
      this.input.shot.consume() !== null ||
      !!this.input.consumeCross() ||
      !!this.input.consumeSwipe();
    if (start) {
      this.beginIntroKickoff();
      return;
    }

    const cam = this.introCam;
    const A = I.closeA;
    const B = I.closeB;
    if (this.introPhase === 'ball') {
      // Крупный план: медленный облёт вокруг Tricolore-98
      const k = smooth01(this.introT / I.ballTime);
      cam.pos.set(
        (A.x + (B.x - A.x) * k) * s,
        A.y + (B.y - A.y) * k,
        A.z + (B.z - A.z) * k,
      );
      cam.look.set(0, I.closeLookY, 0);
      if (this.introT >= I.ballTime) {
        this.introPhase = 'pull';
        this.introT = 0;
        this._introWhistled = playWhistle(); // свисток — и камера пошла назад
      }
    } else if (this.introPhase === 'pull') {
      // Отлёт: от мяча к общему плану с парой нападающих у центра
      const k = smooth01(this.introT / I.pullTime);
      cam.pos.set(
        (B.x + (I.mid.x - B.x) * k) * s,
        B.y + (I.mid.y - B.y) * k,
        B.z + (I.mid.z - B.z) * k,
      );
      cam.look.set(
        I.midLook.x * s * k,
        I.closeLookY + (I.midLook.y - I.closeLookY) * k,
        I.midLook.z * k,
      );
      if (this.introT >= I.pullTime) {
        this.introPhase = 'wait';
        this.introT = 0;
        if (this.teams[this.kickoffTeam] === this.humanTeam) {
          this._setTempHint('ПАС (S / кнопка ПАС) — разыграть с центра');
        }
      }
    } else {
      // Ожидание розыгрыша: лёгкое «дыхание» камеры, как у живого оператора
      const b = Math.sin(this.introT * 0.7) * I.breath;
      cam.pos.set(I.mid.x * s + b * 0.6, I.mid.y + b * 0.35, I.mid.z);
      cam.look.set(I.midLook.x * s, I.midLook.y, I.midLook.z);
      const humanKick = this.teams[this.kickoffTeam] === this.humanTeam;
      if (!humanKick && this.introT >= I.aiWait) this.beginIntroKickoff();
    }
  }

  // Розыгрыш из заставки: первый нападающий катит второму, камера доезжает
  // в игровую позицию плавным вытеснением (introCam.mix тает в update)
  beginIntroKickoff() {
    this._restoreHint();
    this.controlledMarker.visible = true;
    this.introCam.fading = true;
    // Свисток мог молчать до первого жеста (автоплей) — добираем его сейчас
    if (!this._introWhistled) this._introWhistled = playWhistle(0.55);
    const kt = this.teams[this.kickoffTeam];
    if (kt === this.humanTeam) {
      const st1 = kt.players[9];
      const st2 = kt.players[10];
      const bp = this.ball.mesh.position;   // мяч на центральной точке
      const p2 = st2.group.position;
      // Пас катится ИЗ мяча в ноги второго нападающего (раньше направление
      // считалось между игроками — мяч летел мимо; фидбек Олега 22.07)
      const dx = p2.x - bp.x;
      const dz = p2.z - bp.z;
      const d = Math.hypot(dx, dz) || 1;
      const power = Math.max(6, Math.min(11, d * 1.25)); // мягко, чтоб не проскочил
      st1.rot = Math.atan2(dx, dz);
      st1.aiKick(this.ball, { x: dx / d, z: dz / d }, power, 0, 0,
        { name: 'kick', ts: 1.5, at: 0.2 });
      kt.receiver = st2;
      kt.receiveTarget = { x: p2.x, z: p2.z };
      kt.receiveTimer = CONFIG.ai.receiveGiveUp;
      // Курсор — на ПАСУЮЩЕМ: адресат остаётся AI-приёмщиком, сам добежит и
      // примет (не «убегает»). cd=0, чтобы курсор перешёл к нему СРАЗУ при
      // приёме — пока мяч летит, курсор держит защита receiver в updateSwitching
      this.setControlled(st1, 0);
      this.state = 'play';
    } else {
      // Чужой розыгрыш: обычная логика кикоффа, AI пасанёт на ближайшем такте
      this.state = 'kickoff';
      this.stateTimer = CONFIG.match.kickoffDelay + 0.01;
    }
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

    // Хвост ТВ-заставки: интро-камера дотаивает уже по живой игре (mix 1→0),
    // затем руль полностью у обычной ТВ-логики в main.js
    if (this.introCam && this.introCam.fading) {
      this.introCam.mix -= dt / CONFIG.intro.goTime;
      if (this.introCam.mix <= 0) this.introCam = null;
    }
    if (this.state === 'intro') {
      this.updateIntro(dt);
      this.updateHUD();
      return;
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
      this.startIntro(); // новый матч — снова ТВ-заставка
    }

    // Розыгрыш AI с центра: выдержал паузу — отдал пас
    if (this.state === 'kickoff') {
      const kt = this.teams[this.kickoffTeam];
      if (kt !== this.humanTeam && this.stateTimer > M.kickoffDelay) {
        const st = kt.players[9];
        const pass = kt.choosePass(st, this.ball);
        if (pass) {
          st.aiKick(this.ball, pass.dir, pass.power, pass.lift);
          kt.commitPass(pass, st);
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
        // Замыкание в одно касание: замах играет, мяч подлетает и
        // перенаправляется в момент контакта (до движения игрока)
        if (p.aerialStrike && !paused) p.updateAerialStrike(dt, this.ball);
        if (this.restart && p === this.restart.taker) this.updateTaker(p, dt);
        else if (p.isKeeper && p.ai && p.ai.holding) this.updateKeeperHold(p, dt);
        else if (p === this.controlled) p.update(dt, this.input, this.ball);
        else if (p.isKeeper) updateKeeper(p, dt, aiBall);
        else updateFieldPlayer(p, dt, aiBall);
      }
    }

    // Установленный мяч стандарта не сдвигают ни физика, ни чужие касания.
    // В замахе вбрасывания мяч живёт в руках над головой исполнителя.
    // В фазе follow мяч уже выпущен и летит — его ведёт обычная физика
    if (this.state === 'restart' && this.restart &&
        this.restart.phase !== 'dead' && this.restart.phase !== 'follow') {
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
    // Мяч, оттолкнутый на спринте своим ведущим, не «свободен»: пока жив
    // эпизод владения и ведущий остаётся ближайшим к мячу в пределах
    // dribbleReclaim, он сохраняет владение. Иначе авто-переключение отдавало
    // курсор партнёру, ближе к оттолкнутому мячу, а ведущий «убегал» без
    // курсора (фидбек Олега 22.07: убегание при ведении по диагонали)
    if (!best && lowBall) {
      let epi = null;
      let epiD = Infinity;
      let anyD = Infinity;
      for (const p of this._all) {
        const d = distToBall(p, this.ball);
        if (d < anyD) anyD = d;
        if (p.ownEpisodeT > 0 && d < epiD) {
          epiD = d;
          epi = p;
        }
      }
      if (epi && epiD < P.dribbleReclaim && epiD <= anyD + 0.15) best = epi;
    }

    // Кипер с мячом в руках — безусловный владелец (мяч на высоте рук,
    // обычный радиус-арбитраж его не видит)
    for (const team of this.teams) {
      if (team.keeper.ai && team.keeper.ai.holding) {
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
      // С мячом Q/LB курсор НЕ переключает: это модификатор СТЕНОЧКИ (Q+ПАС),
      // и курсор никогда не убегает с владеющего мячом (дух PES: L1 в атаке)
      if (this.controlled && (this.controlled.isToucher || this.controlled.hasBall)) return;
      this.setControlled(this.nearestFieldPlayer(team, this.controlled), 0.25);
      return;
    }
    if (this.switchCd > 0) return;

    // Пока наш пас/подача летит выбранному адресату (в т.ч. замыкающему
    // навеса или адресату розыгрыша) и мяча ещё никто не коснулся — авто-
    // переключение курсор НЕ трогает: адресат-AI сам добежит и примет, потом
    // курсор перейдёт к нему («партнёр взял мяч»). Иначе, став controlled
    // заранее, он терял автоприём и убегал от мяча (фидбек Олега 22.07)
    if (team.receiver && team.receiveTimer > 0 && !this.toucher &&
        Math.hypot(this.ball.vel.x, this.ball.vel.z) > 2) return;

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
    // Пас под прессингом — пасующий предлагает стеночку: сам рвёт вперёд,
    // возврат на ход (W) завершает «раз-два» (ресёрч 14)
    team.tryFollowRun(player, best.dist);

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
    // Мяч в руках вратаря МЁРТВ для арбитража линий: кисти в падении заносят
    // его за лицевую (сейв у линии), и без этого гейта тут же свистели
    // угловой/«гол» из ничего (фидбек Олега 22.07: «вместо гола угловой»)
    for (const t of this.teams) {
      if (t.keeper.ai && t.keeper.ai.holding) return;
    }
    const halfL = F.length / 2;
    const halfW = F.width / 2;
    const lastTeam = this.lastTouch ? this.lastTouch.team : this.possession;

    if (Math.abs(bp.z) > halfW + rr) {
      // Боковая линия — вбрасывание команды, которая мяча НЕ касалась
      const sz = Math.sign(bp.z);
      const x = Math.max(-halfL + 1, Math.min(halfL - 1, bp.x));
      this.beginRestart('throwin', this.otherTeam(lastTeam), x, sz * (halfW - R.lineInset));
    } else if (Math.abs(bp.x) > halfL + rr) {
      // Мяч фактически В СЕТКЕ (за линией, между штангами, ниже перекладины) —
      // это ГОЛ, даже если непрерывная проверка пересечения его проглядела
      // (рикошет от штанги/сутолока с вратарём на последней итерации кадра).
      // Страховка от «мяч в воротах, а свистят угловой» (фидбек Олега 22.07)
      const G = CONFIG.goal;
      if (Math.abs(bp.z) <= G.width / 2 + G.postRadius &&
          bp.y <= G.height + G.postRadius &&
          Math.abs(bp.x) <= halfL + G.depth + 0.5) {
        this.ball.goalScored = true;
        this.onGoal();
        return;
      }
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
      t.overlapper = null;
      t.overlapTarget = null;
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
    // Замах и follow-through вбрасывания: стоим, корпус по направлению броска
    if ((r.phase === 'throw' || r.phase === 'follow') && r.pending) {
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

    // Замах вбрасывания: клип идёт, мяч в руках — выпуск ровно в кадре броска
    // (руки и мяч синхронны; не по таймеру, чтобы не зависеть от длины клипа)
    if (r.phase === 'throw') {
      const os = r.taker.oneShot;
      if (!os || os.time >= R.throwIn.releaseClip) this._releaseThrow(r);
      return;
    }

    // Follow-through: мяч уже улетел, даём броску дойти, затем гасим клип
    // (иначе играет хвост с шагами — «кидает невидимый мяч») и продолжаем игру
    if (r.phase === 'follow') {
      if (r.t >= R.throwIn.followTime) {
        const taker = r.taker;
        if (taker.oneShot) {
          taker.oneShot.fadeOut(0.15);
          taker.oneShot = null;
          taker.currentName = null; // следующий кадр выберет run/idle
        }
        this._finishRestart();
      }
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

  // Замах вбрасывания: клип стартует СРАЗУ, мяч уходит из рук в кадре броска
  // (releaseClip) — updateRestart следит за временем клипа (фидбек Олега)
  _scheduleThrow(r, dir, power) {
    const R = CONFIG.restart.throwIn;
    const dl = Math.hypot(dir.x, dir.z) || 1;
    r.pending = { dir: { x: dir.x / dl, z: dir.z / dl }, power };
    r.phase = 'throw';
    r.t = 0;
    r.taker.rot = Math.atan2(dir.x, dir.z);
    // Клип стартует с фазы замаха — мяч уйдёт из рук ровно на броске (releaseClip)
    r.taker.playOneShot('throwin', R.clipRate, R.clipStart);
  }

  // Выпуск мяча из рук (в момент броска в анимации). Не завершаем стандарт
  // сразу — даём follow-through доиграть, потом гасим хвост клипа с шагами
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
    taker.ownEpisodeT = 0; // бросок закрывает эпизод владения
    r.phase = 'follow';
    r.t = 0;
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
      team.commitPass(pass, taker);
    } else {
      const zs = Math.sign(r.z || 1);
      const dl = Math.hypot(team.side, zs * 0.5);
      taker.aiKick(this.ball, { x: team.side / dl, z: (zs * 0.5) / dl },
        K.clearPower, K.clearLift, 0, { name: 'kick', ts: 1.4, at: 0.18 });
    }
    this._finishRestart();
  }

  // ===== Вратарь с мячом в руках (Фаза 2, 22.07.2026) =====
  // AI держит мяч holdTime и выносит с ноги. Вратарь ЧЕЛОВЕКА получает
  // управление и сам решает: УДАР — выбить ногой (сильно, на фланг/по стику),
  // ПАС / НА ХОД — бросить рукой (настильно и точно, в ноги партнёру). Не
  // выбрал за holdMaxHuman — выносим сами. Вылет мяча синхронён с кадром клипа.
  updateKeeperHold(p, dt) {
    const K = CONFIG.ai.keeper;
    const human = p.team === this.humanTeam;
    const ai = p.ai;
    ai.holdAge = (ai.holdAge || 0) + dt;

    // Выбор сделан: клип идёт, мяч остаётся в кистях до кадра выпуска
    if (ai.act) {
      const os = p.oneShot;
      if (!os || os.time >= ai.act.release) {
        this._keeperRelease(p);
        return;
      }
      p.aiUpdate(dt, { x: 0, z: 0 }, { face: Math.atan2(ai.act.dir.x, ai.act.dir.z) });
      p.holdBallInHands(this.ball, K.holdY);
      return;
    }

    // Мяч живёт В РУКАХ: каждый кадр следует за кистями скелета по всей
    // анимации ловли/падения/подъёма (holdBallInHands после aiUpdate ниже)

    if (human) {
      // Пока мяч в руках — управление на вратаре: человек целится и выбирает
      if (this.controlled !== p) this.setControlled(p, 0);
      if (!this._keeperHintShown) {
        this._setTempHint('ВРАТАРЬ ЗАБРАЛ МЯЧ: УДАР — ВЫБИТЬ НОГОЙ · ПАС — БРОСОК РУКОЙ · сам вынесет через 6 сек');
        this._keeperHintShown = true;
      }
      const pass = this.input.pass.consume();
      const through = this.input.through.consume();
      const shot = this.input.shot.consume();
      const cross = this.input.consumeCross();
      const swipe = this.input.consumeSwipe();
      const aim = this._keeperAim(p);

      if (shot !== null || cross) {
        this._keeperPunt(p, aim, shot !== null ? shot : cross.charge); // выбить ногой
      } else if (pass !== null || through !== null) {
        const t = through !== null ? 'through' : 'pass';
        this._keeperThrow(p, t, through !== null ? through : pass, aim); // бросок рукой
      } else if (swipe) {
        if (swipe.kind === 'cross') this._keeperPunt(p, swipe.dir, swipe.power);
        else this._keeperThrow(p, 'pass', swipe.power, swipe.dir);
      } else if (ai.holdAge >= K.holdMaxHuman) {
        this._keeperPunt(p, aim, 1); // время вышло — выносим автоматически
      }

      // Ждёт решения — стоит лицом в поле (или доворачивается по стику-прицелу)
      let face = Math.atan2(p.team.side, 0);
      const im = this.input.move;
      if (Math.hypot(im.x, im.z) > 0.3) face = Math.atan2(im.x, im.z);
      p.aiUpdate(dt, { x: 0, z: 0 }, { face });
      p.holdBallInHands(this.ball, K.holdY);
      return;
    }

    // AI-вратарь: подержал пару секунд — выносит с ноги на фланг
    if (ai.holdAge >= K.holdTime && !ai.act) this._keeperPunt(p, null, 1);
    p.aiUpdate(dt, { x: 0, z: 0 }, { face: Math.atan2(p.team.side, 0) });
    p.holdBallInHands(this.ball, K.holdY);
  }

  // Прицел вратаря: стик человека, иначе прямо в поле от своих ворот
  _keeperAim(p) {
    const im = this.input.move;
    if (Math.hypot(im.x, im.z) > 0.3) return { x: im.x, z: im.z };
    return { x: p.team.side, z: 0 };
  }

  // Выбить ногой: сильный высокий вынос. dir=null (AI) — на свободный фланг
  _keeperPunt(p, dir, charge = 1) {
    const K = CONFIG.ai.keeper;
    const pos = p.group.position;
    let d;
    if (dir) {
      const l = Math.hypot(dir.x, dir.z) || 1;
      d = { x: dir.x / l, z: dir.z / l };
    } else {
      const zs = Math.abs(pos.z) > 2 ? Math.sign(pos.z) : (Math.random() < 0.5 ? -1 : 1);
      const dl = Math.hypot(p.team.side, zs * 0.55) || 1;
      d = { x: p.team.side / dl, z: (zs * 0.55) / dl };
    }
    const power = K.clearPower * (0.85 + 0.15 * Math.min(1, charge));
    p.ai.act = { type: 'punt', dir: d, power, lift: K.clearLift, release: K.puntClip.release };
    p.rot = Math.atan2(d.x, d.z);
    p.playOneShot('gk_dropkick', K.puntClip.rate, K.puntClip.start);
  }

  // Бросить рукой: настильно и точно, с пас-ассистом в ноги партнёру
  _keeperThrow(p, type, charge, aim) {
    const K = CONFIG.ai.keeper;
    const l = Math.hypot(aim.x, aim.z) || 1;
    let dir = { x: aim.x / l, z: aim.z / l };
    let power = K.throwPower * (0.6 + 0.6 * Math.min(1, charge));
    const assist = this.resolvePass(p, type, power, new THREE.Vector3(dir.x, 0, dir.z));
    if (assist) {
      dir = { x: assist.dir.x, z: assist.dir.z };
      power = Math.min(assist.power, K.throwPower * 1.6); // рукой сильнее не бросить
    }
    p.ai.act = { type: 'throw', dir, power, lift: K.throwLift, release: K.throwClip.release };
    p.rot = Math.atan2(dir.x, dir.z);
    p.playOneShot('gk_throw', K.throwClip.rate, K.throwClip.start);
  }

  // Соперник в упор по курсу выброса? (чтобы не бить в него — рикошет в
  // свои ворота). Проверяем узкий коридор длиной dist перед вратарём.
  _laneBlocked(p, dir, dist) {
    const pos = p.group.position;
    for (const o of this.otherTeam(p.team).players) {
      const ox = o.group.position.x - pos.x;
      const oz = o.group.position.z - pos.z;
      const along = ox * dir.x + oz * dir.z;
      if (along < 0.3 || along > dist) continue;
      const perp = Math.abs(ox * dir.z - oz * dir.x);
      if (perp < 1.3) return true;
    }
    return false;
  }

  // Мяч покидает руки / ногу в нужном кадре клипа — вратарь снова обычный игрок
  _keeperRelease(p) {
    const K = CONFIG.ai.keeper;
    const act = p.ai.act;
    const pos = p.group.position;
    // Соперник прилип и стоит на курсе — перебрасываем через него навесом,
    // а не бьём в упор (иначе рикошет в свои ворота, фидбек Олега 22.07)
    let lift = act.lift;
    if (this._laneBlocked(p, act.dir, 3.2)) {
      lift = Math.max(lift, act.type === 'throw' ? 6.5 : lift + 4);
    }
    const h = act.type === 'throw' ? K.holdY + 0.45 : CONFIG.ball.radius + 0.35;
    this.ball.mesh.position.set(pos.x + act.dir.x * 0.45, h, pos.z + act.dir.z * 0.45);
    this.ball.strike(act.dir, act.power, lift);
    this.ball.spin = 0;
    this.ball.afterTouch = 0;
    p.kickCooldown = CONFIG.player.kickCooldown * 2; // свой же вынос не ловим сразу
    p.ownEpisodeT = 0; // выброс закрывает эпизод владения
    // Соперники рядом не играют мяч короткое окно — иначе прилипший в упор
    // отбивал бы выброс в наши ворота (фидбек Олега 22.07). Мяч успевает уйти.
    for (const o of this.otherTeam(p.team).players) {
      const op = o.group.position;
      if (Math.hypot(op.x - pos.x, op.z - pos.z) < K.releaseGuard) {
        o.kickCooldown = Math.max(o.kickCooldown, K.releaseGuardTime);
      }
    }
    p.ai.act = null;
    p.ai.holding = false;
    p.ai.holdAge = 0;
    p.ai.dropkickStarted = false;
    this._restoreHint();
    // Управление человека — на адресата броска (или ближнего к мячу)
    if (this.controlled === p) {
      const next = p.team.receiver || this.nearestFieldPlayer(p.team);
      if (next) this.setControlled(next, 0.4);
    }
  }

  // Временная строка-подсказка (вратарь с мячом, интро) вместо постоянной
  _setTempHint(text) {
    if (this.hud.hint) this.hud.hint.textContent = text;
    this._tempHint = true;
  }

  _restoreHint() {
    if (this._tempHint && this.hud.hint) this.hud.hint.innerHTML = this._hintHTML;
    this._tempHint = false;
    this._keeperHintShown = false;
  }

  // Пауза = мяч мёртв: кипер не держит его в руках. Без этого его отложенный
  // вынос по таймеру бил бы подставной _centerBall без метода strike (старый
  // TypeError из аудита 18.07.2026)
  _releaseKeeperHolds() {
    for (const team of this.teams) {
      if (team.keeper.ai) {
        team.keeper.ai.holding = false;
        team.keeper.ai.holdAge = 0;
        team.keeper.ai.act = null;
        team.keeper.ai.dropkickStarted = false;
      }
    }
    this._restoreHint();
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
