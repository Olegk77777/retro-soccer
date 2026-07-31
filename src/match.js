// Матч: 22 игрока, две команды, счёт, таймер, розыгрыш с центра,
// переключение управляемого игрока. Оркестратор — сам никого не «думает»:
// решения принимают тренеры (ai/team.js) и головы игроков (ai/*.js),
// человек управляет одним игроком через прежний Player.update.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { PACK } from './pack.js';
import { Player, setLookTarget } from './player.js';
import { Team } from './ai/team.js';
import { updateFieldPlayer } from './ai/fieldplayer.js';
import { updateKeeper } from './ai/goalkeeper.js';
import { distToBall, freeSpace, passPower, passStrikeKind, passTime } from './ai/steering.js';
import { solveSpacePass } from './ai/passing.js';
import { pickCornerRoutine, spotToWorld } from './setpieces.js';
import {
  playWhistle, setCrowdIntensity, crowdCheer, flareHiss,
  crowdGasp, crowdApplause,
} from './sfx.js';
import { Replay } from './replay.js';
import { Officials } from './officials.js';
import { Celebration } from './celebration.js';

// Куда встаёт мяч, пока он в руках вбрасывающего — без аллокаций в кадре
const _ballHands = new THREE.Vector3();

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
    this.scene = scene;   // нужна для атмосферы: вспышки трибун реагируют на гол
    this.ball = ball;
    this.goals = goals;
    this.input = input;
    // Куда все смотрят головой. Вектор позиции мяча живой (мутируется на
    // месте), поэтому отдаём его слою анимации один раз — дальше он читает сам
    setLookTarget(ball.mesh.position);

    const mkPlayers = (data) => CONFIG.formation.roles.map((r, i) => {
      const isKeeper = i === 0;
      // Внешность и фамилия — из состава (data.squad[i]); нет состава —
      // игрок остаётся «средним», как было до Фазы 5
      const look = data.squad && data.squad[i] ? data.squad[i] : null;
      const p = new Player(scene, {
        kitColor: isKeeper ? data.colors.gk : data.colors.primary,
        kitTexture: isKeeper ? data.kits?.goalkeeper : data.kits?.home,
        look,
      });
      if (look) {
        p.name = look.name;
        p.number = look.number;
      }
      return p;
    });
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
    this.touchLog = [];       // журнал касаний: по нему ищем автора гола
    this.restart = null;      // активный стандарт: аут / угловой / удар от ворот
    this.score = [0, 0];
    this.clock = 0;           // игровые секунды (0..90×60)
    // Статистика матча (Фаза 3: «баланс проверяем автосимуляцией, не на глаз»).
    // Индекс — номер команды в this.teams. Считать дёшево, а без чисел любой
    // разговор о балансе превращается в «мне показалось»
    this.stats = {
      pass: [0, 0], passOk: [0, 0], shot: [0, 0], cross: [0, 0],
      save: [0, 0], hold: [0, 0], parry: [0, 0], loose: [0, 0],
      // Финты: сколько исполнено и сколько провалено. Без этих двух чисел
      // разговор «не слишком ли дёшево даётся обыгрыш» снова превратился бы
      // в «мне показалось» — а автосимуляция считает именно по ним
      feint: [0, 0], feintFail: [0, 0],
      // Комбинации «тренера» (31.07.2026). Жалоба заказчика «у AI вообще нет
      // комбинаций» была неизмерима: связки взводились, но ни одна из них не
      // инкрементила ничего, и проверить «стало больше» было нечем. Теперь
      // считаем каждую: стеночка и забег за спину (run), игра третьего
      // (third), подключение фулбека (overlap), приход в ноги (short)
      run: [0, 0], third: [0, 0], overlap: [0, 0], short: [0, 0],
      // ОСМЫСЛЕННОСТЬ АТАКИ (31.07.2026). Жалоба «играет сумбурно» была
      // неизмерима ровно так же, как до этого «нет комбинаций»: счёт голов
      // сумбур не ловит вовсе (замер до правок дал 1.5 гола за матч при
      // 74 рывках и точности паса 38 %). Считаем СЕРИЯМИ ВЛАДЕНИЯ — это и
      // есть единица осмысленной атаки:
      //   seq        — серий владения (началось владение мячом)
      //   seqPass    — сумма передач по сериям (среднее = передач в серии)
      //   seqTime    — сумма длительностей серий, десятые доли секунды
      //   seqProg    — сумма продвижения серий вперёд, метры
      //   seqLong    — серий из 4+ передач (в АПЛ таких 11 %)
      //   shotAfter3 — ударов, подготовленных серией из 3+ передач
      //   switchPass — переводов фланга (пас поперёк дальше switchMinZ)
      //   flips      — сколько раз владелец сменил ВИД решения на соседних
      //                тактах: прямая мера метания
      seq: [0, 0], seqPass: [0, 0], seqTime: [0, 0], seqProg: [0, 0],
      seqLong: [0, 0], shotAfter3: [0, 0], switchPass: [0, 0], flips: [0, 0],
      // Стеночка отдельно от забегания за спину: они делят один слот `runner`,
      // и пока обе бумпили общий ключ `run`, было не видно, что стеночка
      // вытеснила забегание почти начисто
      oneTwo: [0, 0], passKept: [0, 0],
      // chain — сколько раз ГОРИЗОНТ (поиск цепочек действий, passModel.
      // chainWeight) реально поменял лучшего кандидата на пас. Прямая мера
      // механики: косвенные метрики «пас под пас» не различают
      chain: [0, 0],
    };
    // Сколько сейвов зал уже отреагировал «ахом». Считаем ПО СТАТИСТИКЕ, а не
    // хуками в goalkeeper.js: счётчики и так растут ровно в момент касания
    // вратаря, а слой AI знать про звук не должен
    this._savesHeard = 0;
    this._gaspCd = 0;         // сек до следующего разрешённого «аха»
    this.state = 'kickoff';   // kickoff | play | goalpause | fulltime
    this.stateTimer = 0;
    this.kickoffTeam = 0;
    this.switchCd = 0;
    this.flashTimer = 0;

    // «Мяч в центре» — подставной объект на паузы (после гола настоящий мяч
    // лежит в сетке; AI строится к центру, а не толпится у ворот).
    // Пустышки strike/afterTouch обязательны: игрок, застигнутый паузой в
    // подкате или замахе, честно доигрывает действие и бьёт по ЭТОМУ объекту —
    // без них падало «ball.strike is not a function» (поймано симуляцией 24.07)
    this._centerBall = {
      mesh: { position: new THREE.Vector3(0, CONFIG.ball.radius, 0) },
      vel: new THREE.Vector3(),
      spin: 0,
      afterTouch: 0,
      strike() { /* фантомный мяч — по нему нельзя сыграть */ },
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
      // Титры трансляции: заставка «кто с кем» и плашка автора гола
      card: document.getElementById('goal-card'),
      cardMark: document.getElementById('gc-mark'),
      cardTeam: document.getElementById('gc-team'),
      cardMin: document.getElementById('gc-min'),
      matchcard: document.getElementById('matchcard'),
      // Плашка игрока с мячом (номер + фамилия) — как в футсимах
      plate: document.getElementById('nameplate'),
      plateMark: document.getElementById('np-mark'),
      plateNum: document.getElementById('np-num'),
      plateName: document.getElementById('np-name'),
      // Бегущая строка с составами — как в начале трансляции 90-х
      lineups: document.getElementById('lineups'),
      lineupsText: document.getElementById('lineups-text'),
    };
    this._plateKey = '';

    // Текст строки собираем ОДИН раз: состав за матч не меняется, а сборка
    // на каждом розыгрыше дёргала бы вёрстку. Имена и номера — из пака,
    // значит публичная сборка покажет псевдонимы, и ничего править не надо.
    this._lineupHTML = teamsData.map((t) => {
      const men = (t.squad || []).map((p) =>
        `<span class="lu-num">${p.number}</span> ${p.name}`).join('<span class="lu-sep">·</span>');
      return `<span class="lu-team">${t.name}</span><span class="lu-sep">—</span>${men}`;
    }).join('<span class="lu-sep">◆</span>');
    this.hud.home.textContent = teamsData[0].short;
    this.hud.away.textContent = teamsData[1].short;

    // Цвет формы — метка команды на табло и в титрах (данные, не код)
    this._teamColors = teamsData.map((t) => (t.colors && t.colors.primary) || '#cccccc');
    const paintMark = (id, color) => {
      const el = document.getElementById(id);
      if (el) el.style.background = color;
    };
    paintMark('sb-home-mark', this._teamColors[0]);
    paintMark('sb-away-mark', this._teamColors[1]);
    paintMark('mc-home-mark', this._teamColors[0]);
    paintMark('mc-away-mark', this._teamColors[1]);
    const mcHome = document.getElementById('mc-home');
    const mcAway = document.getElementById('mc-away');
    const mcVenue = document.getElementById('mc-venue');
    if (mcHome) mcHome.textContent = teamsData[0].name;
    if (mcAway) mcAway.textContent = teamsData[1].name;
    if (mcVenue) mcVenue.textContent = PACK.venue || CONFIG.match.venue;
    this._teamNames = teamsData.map((t) => t.name);
    this.goalCardTimer = 0;
    this._hintHTML = this.hud.hint ? this.hud.hint.innerHTML : '';
    this._keeperHintShown = false;
    this._gkOrderHintShown = false;  // подсказка про выход вратаря — один раз за матч
    this._tempHint = false;

    // ТВ-заставка: параметрическая камера интро ({pos, look, mix, fading})
    this.introCam = null;
    this.introPhase = null;
    this.introT = 0;
    this._hudCache = '';
    this._phase = ''; // фаза для контекстных тач-кнопок (атака/оборона)

    // Пас-ассист для игроков человека (AI пасует своим умом в team.js).
    // ЧЕТВЁРТЫЙ АРГУМЕНТ (направление стика) РАНЬШЕ ТЕРЯЛСЯ ЗДЕСЬ. Стрелка
    // писала намерение в pendingStrike.aim, player.js честно передавал его
    // пятым параметром — а эта стрелочная функция принимала только три и
    // молча его роняла. Конус поиска адресата строился вокруг ВЗГЛЯДА игрока,
    // и пока корпус доворачивался (turnMax 11 рад/с, разворот на 180° — 0.29 с),
    // пас искал партнёра там, куда игрок ещё смотрел, а не туда, куда его
    // послали. Ровно это и читалось как «не свободен выкатить в любом
    // направлении» (фидбек Олега 28.07.2026)
    for (const p of this.humanTeam.players) {
      p.passAssist = (player, type, power, aimDir, opts) =>
        this.resolvePass(player, type, power, aimDir, opts);
    }

    // Бригада арбитров: чисто визуальные фигуры, в игру не вмешиваются
    this.officials = new Officials(scene);

    // Повтор гола: кольцевая запись поз всех тел, включается после гола
    this.replay = new Replay(this._all, ball);
    this.replayTag = document.getElementById('replay-tag');
    // Празднование: живой эпизод после гола, он же попадает в повтор
    this.celebration = new Celebration();

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
    this.touchLog.length = 0; // касания прошлого эпизода к следующему голу не относятся
    this.ball.reset();

    for (const team of this.teams) {
      team.attacking = false; // расстановка — оборонительная, своя половина
      team.receiver = null;
      team.receiveSpace = false;
      team.receiveTarget = null;
      team.supporter = null;
      team.chaser = null;
      team.coverer = null;
      team.marks.clear();
      team.runner = null;
      team.runnerTarget = null;
      team.overlapper = null;
      team.overlapTarget = null;
      team.thirdMan = null;
      team.thirdManTarget = null;
      team._thirdArm = null;
      team.decoy = null;
      team.decoyTarget = null;
      team.bestSpot = null;
      team.boxRuns.clear();
      team.crossAir = 0;
      team.airGuards.clear();   // выход на подачу — такое же назначение
      team.airGuardT = 0;
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
  // Бегущая строка с составами: один быстрый проход в начале матча.
  // Скорость задана в пикселях за секунду (CONFIG.intro.lineupSpeed), а
  // длительность считается от РЕАЛЬНОЙ ширины текста — иначе длинный состав
  // ехал бы медленнее короткого. По окончании прохода строка гаснет сама.
  startLineups() {
    const el = this.hud.lineups;
    const txt = this.hud.lineupsText;
    if (!el || !txt || !this._lineupHTML) return;
    txt.innerHTML = this._lineupHTML;
    el.classList.add('show');
    // Ширину меряем ПОСЛЕ показа: у скрытого блока она нулевая
    const from = el.clientWidth;
    const width = txt.scrollWidth;
    const speed = Math.max(40, CONFIG.intro.lineupSpeed);
    txt.style.setProperty('--from', `${from}px`);
    txt.style.setProperty('--to', `${-width}px`);
    txt.style.setProperty('--roll', `${(from + width) / speed}s`);
    // Перезапуск анимации: без сброса второй матч не поехал бы вовсе
    txt.style.animation = 'none';
    void txt.offsetWidth;
    txt.style.animation = '';
    txt.onanimationend = () => el.classList.remove('show');
  }

  startIntro() {
    this.startLineups();
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
    // Выход команд: оба фанатских сектора встречают своих пиротехникой.
    // Это самый узнаваемый кадр вечернего эфира 90-х — трибуна в дыму,
    // который сносит через лучи прожекторов.
    this.litFlares('intro');
    // ...и встречает аплодисментами. Первая попытка почти всегда уходит в
    // пустоту: до ответа на стартовый вопрос звук ещё спит, а банк зала мог
    // не доехать. Поэтому дальше их ДОБИРАЕТ updateIntro — как свисток.
    this._introClap = crowdApplause();
    this._clapCd = 0;
    // Титр «кто с кем и где» выезжает поверх заставки, как в начале эфира
    if (this.hud.matchcard) this.hud.matchcard.classList.add('show');
    this.controlledMarker.visible = false; // звезда не мельтешит в кино-кадре
    this._setTempHint('');
  }

  updateIntro(dt) {
    const I = CONFIG.intro;
    this.introT += dt;

    // ЗАЛ ШУМИТ С ПЕРВОГО КАДРА, А НЕ С РОЗЫГРЫША (правило с 30.07.2026).
    // Раньше напряжение зала задавалось только в главной ветке update(), а
    // заставка выходит из неё раньше — то есть за всю заставку зал не получал
    // ни одного указания и стоял на нуле. Теперь у выхода команд своя ступень:
    // трибуна уже полна и встречает своих, но матч ещё не начался.
    // Указание доходит даже при спящем звуке: crowd.js запомнит его и заведёт
    // петли уже на этом уровне, как только звук разрешат.
    setCrowdIntensity(CONFIG.match.introHeat);

    // Аплодисменты выхода команд: добираем, пока не прозвучат. Редко — иначе
    // на заблокированном звуке событие молотило бы каждый кадр
    if (!this._introClap) {
      this._clapCd -= dt;
      if (this._clapCd <= 0) {
        this._clapCd = CONFIG.match.introClapRetry;
        this._introClap = crowdApplause();
      }
    }
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
    if (this.hud.matchcard) this.hud.matchcard.classList.remove('show');
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
      st1.aiKick(this.ball, { x: dx / d, z: dz / d }, power, 0, 0, 'pass');
      kt.receiver = st2;
      kt.receiveSpace = false;
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
    // Плашка автора гола висит дольше крика — как титр в трансляции
    if (this.goalCardTimer > 0) {
      this.goalCardTimer -= dt;
      if (this.goalCardTimer <= 0 && this.hud.card) this.hud.card.classList.remove('show');
    }

    // Шпаргалка управления гаснет, когда игра пошла: кадр остаётся чистым,
    // как в эфире. Временная подсказка (стандарт, вратарь) зажжёт её снова.
    if (this.hud.hint && !this._tempHint && this.state !== 'intro') {
      this.hintTimer = (this.hintTimer || 0) + dt;
      if (this.hintTimer > CONFIG.match.hintFade) this.hud.hint.classList.add('dim');
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

    // Празднование гола: тела ведёт celebration.js, мозги AI молчат.
    // Пишем его в буфер повтора — потом покажем крупным планом.
    if (this.state === 'celebration') {
      const alive = this.celebration.update(dt, this._all);
      this.officials.update(dt, this._centerBall, this.teams);
      this.replay.record(dt, -1);
      if (!alive || this._actionPressed()) {
        this.celebration.stop();
        if (!this.startReplay()) {
          this.goals.reset();
          this.kickoff(this.kickoffTeam);
        }
      }
      this.updateHUD();
      return;
    }

    // Серия повторов: игра стоит, тела расставляет запись. Кнопка действия
    // пропускает ТЕКУЩИЙ ракурс — как в трансляции режиссёр уходит дальше.
    if (this.state === 'replay') {
      const skip = this._actionPressed();
      const alive = skip ? this.replay.skipSegment() : this.replay.update(dt);
      if (!alive) this.endReplay();
      else if (this.replayTag) {
        this.replayTag.textContent = this.replay.segmentCount > 1
          ? `ПОВТОР ${this.replay.segmentNumber}/${this.replay.segmentCount}`
          : 'ПОВТОР';
      }
      this.updateHUD();
      return;
    }

    // Игровые часы: 90 минут сжаты в realMinutes реальных.
    // На стандартах время идёт — как в настоящей трансляции
    if (this.state === 'kickoff' || this.state === 'play' || this.state === 'restart') {
      this.clock += dt * (M.gameMinutes / M.realMinutes);
      if (this.clock >= M.gameMinutes * 60) this.fullTime();
    }

    // Пауза после гола: мяч и волна сетки живут в кадре, дальше —
    // ПРАЗДНОВАНИЕ (его тоже пишем), и только после него серия повторов
    if (this.state === 'goalpause' && this.stateTimer > CONFIG.goal.resetDelay) {
      this.state = 'celebration';
      this.stateTimer = 0;
      this.celebration.start(this._scorerPlayer, this.teams[this._scorerIdx],
        this.teams[1 - this._scorerIdx]);
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
          st.aiKick(this.ball, pass.dir, pass.power, pass.lift, 0, passStrikeKind(pass));
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
    if (!paused && this.state !== 'restart') this.updateToucher(dt);
    this.validateControlledApproach();

    for (const team of this.teams) team.update(dt, aiBall);

    this.updateSwitching();
    // Приказ вратарю читаем ДО обхода игроков: goalkeeper.js увидит его в
    // этом же кадре, а не в следующем
    if (!paused && this.state !== 'restart') this.updateKeeperOrder();

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
        // МЯЧ ЖИВЁТ В КИСТЯХ, А НЕ В ТОЧКЕ НАД ГОЛОВОЙ (правка 28.07.2026).
        // Раньше он на всё время замаха прикалывался к постоянной высоте
        // releaseY = 1.85 в 0.25 м перед корпусом. А кисти в клипе ходят: замер
        // по риггу дал 0.90 м внизу за спиной (0.5 с), 2.07 м над головой
        // (1.22 с) и вынос на 1.57 м вперёд к 1.66 с. То есть мяч ВИСЕЛ, а руки
        // летали вокруг него — ровно «мяч не синхронно улетает с броском руки».
        // Теперь он едет с кистями, и выпуск получается сам собой.
        const T = CONFIG.restart.throwIn;
        const h = r.taker.handsWorldPoint(_ballHands);
        if (h) {
          this.ball.mesh.position.set(
            h.x + r.pending.dir.x * T.handAhead,
            h.y + T.handLift,
            h.z + r.pending.dir.z * T.handAhead,
          );
        } else {
          const tp = r.taker.group.position;
          this.ball.mesh.position.set(
            tp.x + r.pending.dir.x * 0.25, T.releaseY, tp.z + r.pending.dir.z * 0.25);
        }
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

    // Бригада арбитров живёт своей жизнью — на паузах тоже (они не замирают,
    // пока мяч в сетке), но в повторе стоят: там кадром правит запись
    this.officials.update(dt, aiBall, this.teams);

    // Гул трибун ведёт САМА игра: чем ближе мяч к воротам и чем быстрее
    // эпизод, тем громче и «ближе» зал. Ровный фон — это радио, а не стадион.
    if (!paused) {
      const F = CONFIG.field;
      const bx = Math.abs(this.ball.mesh.position.x) / (F.length / 2);
      const near = Math.max(0, (bx - CONFIG.match.crowdFrom) / (1 - CONFIG.match.crowdFrom));
      const tempo = Math.min(1, this.ball.vel.length() / 26);
      const heat = Math.min(1, near * 0.85 + tempo * 0.3);
      setCrowdIntensity(heat);

      // Сейв — это момент, на котором зал ахает. Ловим по счётчикам:
      // они растут в goalkeeper.js ровно в кадре контакта с мячом.
      // Пойманный намертво мяч (hold) в счёт не идёт — там выдох, а не ах
      const s = this.stats;
      const saves = s.save[0] + s.save[1] + s.parry[0] + s.parry[1];
      this._gaspCd -= dt;
      if (saves > this._savesHeard) {
        this._savesHeard = saves;
        const A = CONFIG.audio.events;
        if (heat >= A.gaspFrom && this._gaspCd <= 0) {
          this._gaspCd = A.gaspCd;
          crowdGasp(Math.min(1, 0.6 + heat * 0.5));   // острее момент — громче ах
        }
      }
    }

    // Кольцевая запись для повтора: пишем позы уже ПОСЛЕ движения всех тел,
    // вместе с тем, чья была атака — по ней потом отматываем комбинацию.
    // Паузу после гола тоже пишем: мяч в сетке и первая реакция — часть эпизода.
    if (this.state !== 'fulltime') {
      const owner = this.state === 'goalpause'
        ? -1
        : (this.possession ? this.teams.indexOf(this.possession) : -1);
      this.replay.record(dt, owner);
    }

    this.updateHUD();
  }

  // Кто у мяча: ближайший из 22 в радиусе контроля. Только он «владеет» —
  // липкое ведение и дриблинг остальных отключаются (иначе мяч рвали бы
  // на части все, кто рядом). Отборы по-настоящему — Фаза 3.
  updateToucher(dt = 0) {
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
      // ЛЕЖАЩИЙ И СКОЛЬЗЯЩИЙ МЯЧОМ НЕ ВЛАДЕЮТ (правка 28.07.2026).
      // Владельца выбирали ЧИСТО ПО ДИСТАНЦИИ, и подкат этого не менял: игрок
      // уезжал в слайд, оказывался ближайшим к мячу — и оставался владельцем.
      // Дальше липкое ведение тащило мяч за ним по газону, а как только
      // кончался recover, он вставал уже С МЯЧОМ и убегал. Ровно это заказчик
      // и описал: «падает и моментально встаёт и дальше бежит с мячом».
      // Отбор мячом не награждает — он его ВЫБИВАЕТ, а подбирать надо заново.
      // ВРАТАРЬ СЮДА НЕ ВХОДИТ, и это не оговорка. Для полевого «лежу» значит
      // «выключен из эпизода», а для кипера бросок — это и есть способ ЗАБРАТЬ
      // мяч: у него diveT и downT горят как раз в кадрах сейва. Первая редакция
      // исключила и его — и шесть матчей автосимуляции дали 14 голов из 17
      // ударов у одной из команд (82 % реализации при норме около 20 %): мяч
      // после сейва переставал считаться вратарским и добивался в пустые.
      // ОБЫГРАННЫЙ ФИНТОМ МЯЧОМ НЕ ВЛАДЕЕТ (правило с 31.07.2026) — по той же
      // причине, что лежащий и скользящий. Замер трассы разворота: защитник в
      // 2.3 м честно покупал финт, его цель уезжала в ложную сторону, темп
      // падал до 2.3 м/с — и он ВСЁ РАВНО оказывался ближайшим к мячу, получал
      // владение и выносил его на 28.5 м/с. То есть финт удавался, а награды
      // за него не было вовсе: обыгрыш существовал только на бумаге.
      // Перенос веса не туда — это и есть «я не успеваю сыграть в мяч».
      const outOfPlay = !p.isKeeper &&
        (p.downT > 0 || p.tackleT > 0 || p.slideRecover || (p.ai && p.ai.feint));
      if (lowBall && !outOfPlay) {
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
    // ВЛАДЕНИЕ — ЭТО МНЕНИЕ ТРЕНЕРА, А НЕ РАДИУС (правило с 31.07.2026).
    // Самая дорогая находка сессии про сумбур, и нашлась она только замером.
    // `toucher` — физический арбитраж: ближайший к низкому мячу в пределах
    // controlRadius (1.35 м). Для ведения и отбора это верно. Но `possession`
    // писалась ТОЙ ЖЕ строкой — и потому переходила к сопернику, стоило мячу
    // просто ПРОКАТИТЬСЯ мимо его ног. Замер на одном матче: 73 смены владения
    // за 6 минут, то есть каждые 2.5 секунды, при том что настоящих перехватов
    // передач всего 17 %. А на каждой смене «тренер» переворачивает ВСЮ
    // команду: снимает раннера, оверлаппера, обманщика и приход в ноги
    // (`if (!this.attacking)` в Team.update), и одиннадцать домашних точек
    // разом переезжают из атакующей формы в оборонительную. Ровно это зритель
    // и читает как «сумбур»: фигуры дёргаются туда-сюда без видимой причины.
    //
    // Лечение — НЕ трогать физику, а дать владению гистерезис: соперник
    // получает мяч, когда он его РЕАЛЬНО ЗАБРАЛ, то есть либо продержал рядом
    // possessionHold секунд, либо мяч при нём успокоился до possessionSlow.
    // Мимолётное сближение с катящимся мячом владения не даёт.
    if (best) {
      const AIp = CONFIG.ai;
      if (best.team === this.possession) {
        this._possT = 0;
        this._possClaim = null;
      } else {
        if (this._possClaim !== best.team) {
          this._possClaim = best.team;
          this._possT = 0;
        }
        this._possT += dt;
        const slow = Math.hypot(this.ball.vel.x, this.ball.vel.z) < AIp.possessionSlow;
        // Вратарь с мячом в руках — владелец немедленно и без разговоров
        const inHands = best.isKeeper && best.ai && best.ai.holding;
        if (slow || inHands || this._possT >= AIp.possessionHold) {
          this.possession = best.team;
          this._possT = 0;
          this._possClaim = null;
        }
      }
    }
    if (touch) {
      this.lastTouch = touch;
      // Журнал последних касаний. Нужен для автора гола: в момент, когда мяч
      // пересекает линию, ближайшим к нему почти всегда оказывается ВРАТАРЬ
      // или защитник — по одному lastTouch автор не определяется никогда.
      const log = this.touchLog;
      if (!log.length || log[log.length - 1].p !== touch) {
        log.push({ p: touch, t: this.clock });
        if (log.length > 12) log.shift();
      }
    }
  }

  // Автор гола: последний касавшийся ИЗ ЗАБИВШЕЙ команды (он же бьющий, а при
  // рикошете — тот, кто начал). Не нашли (автогол, дальний рикошет) —
  // празднует ближайший к воротам полевой игрок.
  findScorer(scorerIdx) {
    const team = this.teams[scorerIdx];
    for (let i = this.touchLog.length - 1; i >= 0; i--) {
      const p = this.touchLog[i].p;
      if (p.team === team && !p.isKeeper) return p;
    }
    let best = null;
    let bestD = Infinity;
    const bp = this.ball.mesh.position;
    for (const p of team.players) {
      if (p.isKeeper) continue;
      const d = distToBall(p, this.ball) + Math.abs(p.group.position.x - bp.x) * 0.1;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
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
      // ПОКА НАШ ПАС ЛЕТИТ, РУЧНОЕ ПЕРЕКЛЮЧЕНИЕ ЖДЁТ АДРЕСАТА (правило с
      // 29.07.2026). `nearestFieldPlayer` ищет ближайшего К МЯЧУ, а мяч в этот
      // момент ещё рядом с пасующим — то есть человек, жмущий Q «дайте мне
      // того, к кому летит», получал кого угодно, только не его.
      if (team.receiver && team.receiveTimer > 0 && !this.toucher &&
          team.receiver !== this.controlled) {
        this.setControlled(team.receiver, 0.25);
        return;
      }
      this.setControlled(this.nearestFieldPlayer(team, this.controlled), 0.25);
      return;
    }
    if (this.switchCd > 0) return;

    // ---- ПЕРЕДАЧА КУРСОРА АДРЕСАТУ: ЗАРАНЕЕ, А НЕ ПО КАСАНИЮ ----
    // (правило с 29.07.2026, фидбек Олега «игроки не всегда успевают
    // переключиться, когда на них резко пас или навес идёт»).
    //
    // Пока мяч летит, курсор вёл адресат-AI, а человек получал управление
    // только когда партнёр УЖЕ коснулся мяча (ветка ниже). Замер стенда
    // switch-rig: пас в ноги на 12 м — курсор переходил на 0.97 с при встрече
    // с мячом на 0.97 с, то есть ЗАПАС 0.00 с; на 22 м — курсор на 1.48 при
    // встрече на 1.47, то есть −0.02 с, управление приходило уже ПОСЛЕ мяча.
    // На таком запасе человек физически не успевает ничего: зрительная реакция
    // сама по себе 0.20–0.25 с (то же число заложено вратарю).
    //
    // Но и переключать в момент паса нельзя — на этом обжигались 22.07:
    // адресат, ставший controlled сразу, терял автоприём и убегал от мяча.
    // Поэтому курсор передаётся ЗА handoff секунд до встречи: большую часть
    // полёта мяч ведёт AI (он и бежит на приём), а последние полсекунды с
    // лишним человек уже правит сам и успевает решить — принять, отпустить
    // под удар или сыграть в касание.
    if (team.receiver && team.receiveTimer > 0 && !this.toucher &&
        Math.hypot(this.ball.vel.x, this.ball.vel.z) > 2) {
      const lead = this.receiverLead(team.receiver);
      if (lead == null || lead > SW.handoff) return;
      if (team.receiver !== this.controlled) {
        this.setControlled(team.receiver, SW.handoffCd);
      }
      return;
    }

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

  // Сколько СЕКУНД мячу до адресата — по этому числу решается, когда отдавать
  // курсор человеку. Катящийся мяч тормозит о газон экспонентой, поэтому его
  // время берём готовой `passTime` (та же λ, что у расчёта силы паса): наивное
  // «дистанция / скорость» на пасе через полполя врёт почти вдвое. Летящий
  // мяч горизонтальную скорость почти держит — там хватает деления.
  // null значит «встречи не будет»: мяч идёт мимо адресата или уже еле ползёт.
  receiverLead(mate) {
    if (!mate) return null;
    const bp = this.ball.mesh.position;
    const mp = mate.group.position;
    const dx = mp.x - bp.x;
    const dz = mp.z - bp.z;
    const d = Math.hypot(dx, dz);
    const vx = this.ball.vel.x;
    const vz = this.ball.vel.z;
    const v = Math.hypot(vx, vz);
    if (v < 0.5 || d < 0.01) return 0;
    // Мяч должен ЛЕТЕТЬ НА адресата, а не мимо: иначе «время до встречи»
    // посчиталось бы и для мяча, уходящего в другую сторону
    if ((dx * vx + dz * vz) / (d * v) < 0.3) return null;
    const air = bp.y > 0.5 || this.ball.vel.y > 0.5;
    const t = air ? d / v : passTime(d, v);
    return Number.isFinite(t) ? t : null;
  }

  // Пас-ассист человека: адресат — партнёр в конусе взгляда; направление
  // доворачивается с упреждением на его бег, партнёр бросается встречать.
  // Уровень помощи (слайдер 10–30%, как у ударов): шире конус поиска и
  // подтяжка силы полоски к дистанции адресата. aimDir — направление
  // намерения (стик в момент паса), по умолчанию взгляд игрока.
  resolvePass(player, type, power, aimDir = null, opts = {}) {
    const HP = CONFIG.ai.humanPass;
    const AS = HP.assist;
    const team = player.team;
    if (!team) return null;

    // ПАС В ЗОНУ (W и Q+W) идёт своим решателем: мяч летит не в игрока, а в
    // ТОЧКУ, куда игрок добежит. Разделение каноничное — в PES это ⨯ против △.
    if (type === 'through' || type === 'lob') {
      const sp = solveSpacePass(player, {
        aim: aimDir ? { x: aimDir.x, z: aimDir.z } : null,
        charge: opts.charge != null ? opts.charge : 0.6,
        lob: type === 'lob',
        level: AS.level,
      });
      if (sp) {
        team.receiver = sp.mate;
        team.receiveSpace = true;
        team.receiveTarget = { x: sp.target.x, z: sp.target.z };
        team.receiveTimer = Math.max(CONFIG.ai.receiveGiveUp, sp.flight + sp.wait + 0.8);
        // Курсор СРАЗУ на бегущего под пас (принцип PES «курсор на
        // принимающего»): смысл паса в зону в том, чтобы человек сам вёл
        // рывок. Ждать авто-переключения по касанию значит отдать самое
        // ценное — сам забег — автомату
        if (team === this.humanTeam && sp.mate !== this.controlled) {
          this.setControlled(sp.mate, 0.4);
        }
        return {
          dir: new THREE.Vector3(sp.dir.x, 0, sp.dir.z),
          power: sp.power,
          lift: sp.lift,
          space: true,
          target: sp.target,
        };
      }
      // Под стик ничего разумного не нашлось — мяч летит СТРОГО как нарисован.
      // Это и есть обещанная свобода: помощь выбирает точку в секторе, который
      // человек указал, а не подменяет его решение
      if (type === 'lob') return null;
    }

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
      // В конусе выбираем не «самого точно по взгляду», а самого ПОЛЕЗНОГО:
      // проходимость коридора × свободная зона на приёме × продвижение.
      // Без этого пас регулярно уходил в ближайшего опекаемого партнёра —
      // одна из причин, почему человеку было выгоднее везти мяч самому
      const pc = team.passComplete(pos.x, pos.z, mp.x, mp.z,
        Math.max(12, dist * 0.9 + 9), team.opponents, 0);
      const space = freeSpace(mp.x, mp.z, team.opponents);
      const gain = team.side * dx;
      const score = cos * 12 + pc * 14 + space * 6 + gain * 0.20 - dist * 0.10;
      if (score > bestScore) {
        bestScore = score;
        best = { mate, dist };
      }
    }
    if (!best) return null;

    // Помощь в силе: полоска тянется к «идеальной для дистанции» на долю
    // level×powerPull. Осознанная передержка всё равно уводит мяч дальше.
    // Идеал считается ПО ПРИХОДУ: мяч должен добраться живым (ресёрч 15)
    const ideal = passPower(best.dist, AS.idealArrive);
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
    team.receiveSpace = false;
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
      // Страховка от «мяч в воротах, а свистят угловой» (фидбек Олега 22.07).
      //
      // НО ТОЛЬКО ЕСЛИ МЯЧ ВОШЁЛ ЧЕРЕЗ ПРОЁМ (правило с 28.07.2026). Раньше
      // проверялось лишь «мяч сейчас в коробке ворот», и этого мало: коробка
      // шире створа (боковая сетка на 3.90, чистый проём — до 3.50 по центру
      // мяча) и на полметра длиннее задней сетки. Замер: 0.6 % случайных ударов
      // засчитывались голом, пройдя СНАРУЖИ штанги, а мяч, положенный за заднюю
      // сетку, объявлялся голом на месте. Метку ставит goal.js в момент
      // пересечения плоскости линии — она и есть ответ «через створ или мимо».
      const G = CONFIG.goal;
      const sx = Math.sign(bp.x);
      // Предел по глубине — задняя сетка ПЛЮС её ход: мяч честно продавливает
      // полотно (замер: пушка 38 м/с уносит его на 0.59 м за плоскость сетки),
      // и жёсткая граница по backX отняла бы у такого мяча гол.
      if (this.ball.inGoalNet === sx &&
          Math.abs(bp.z) <= G.width / 2 + G.postRadius &&
          bp.y <= G.height + G.postRadius &&
          Math.abs(bp.x) <= halfL + G.depth + G.net.physicalMaxStretch) {
        this.ball.goalScored = true;
        this.onGoal();
        return;
      }
      // Лицевая линия: от обороняющихся — угловой, от атакующих — от ворот
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
      t.receiveSpace = false;
      t.receiveTarget = null;
      t.runner = null;
      t.runnerTarget = null;
      t.overlapper = null;
      t.overlapTarget = null;
      t.thirdMan = null;
      t.thirdManTarget = null;
      t._thirdArm = null;
      t.decoy = null;
      t.decoyTarget = null;
      t.crossAir = 0;
      t.boxRuns.clear();
      t.airGuards.clear();
      t.airGuardT = 0;
      t._setPieceT = 0;
    }

    // РОЗЫГРЫШ УГЛОВОГО ПО СХЕМЕ (31.07.2026). Схема выбирается ЗДЕСЬ, а не в
    // момент удара: тела обязаны занять точки, пока мяч мёртв, — именно эта
    // пауза и делает угловой похожим на угловой, а не на «навес откуда-то».
    // Схему помним в самом стандарте: подающий возьмёт из неё адрес, чтобы
    // мяч летел туда, куда команда встала, а не в самую свободную точку
    if (type === 'corner') {
      const routine = pickCornerRoutine();
      this.restart.routine = routine;
      team.armCornerAttack(this.restart, routine);
      this.otherTeam(team).armCornerDefend(this.restart);
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
        r.taker.cancelOneShot(); // хвост клипа с шагами — «кидает невидимый мяч»
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
    const nd = r.pending.dir;
    // Выпуск из РЕАЛЬНОЙ точки кистей, а не из постоянной высоты: мяч всё
    // время замаха ехал с руками, и обрывать эту связь телепортом нельзя
    const h = taker.handsWorldPoint(_ballHands);
    if (h) {
      this.ball.mesh.position.set(
        h.x + nd.x * R.handAhead, h.y + R.handLift, h.z + nd.z * R.handAhead);
    } else {
      const tp = taker.group.position;
      this.ball.mesh.position.set(tp.x + nd.x * 0.35, R.releaseY, tp.z + nd.z * 0.35);
    }
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
    r.taker.playStrike('setpiece'); // стандарт: игрок стоит, время на замах есть
    this._finishRestart();
  }

  // AI-исполнение: вбрасывание ближнему, угловой на свободного в штрафной,
  // удар от ворот — короткий розыгрыш или вынос на фланг
  executeAIRestart(r) {
    const F = CONFIG.field;
    const AI = CONFIG.ai;
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
        team.receiveSpace = false;
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
      // АДРЕС ПОДАЧИ БЕРЁТСЯ ИЗ СХЕМЫ (31.07.2026). Раньше подающий сам искал
      // «своего в штрафной с самой свободной зоной» — то есть команда вставала
      // как придётся, а мяч летел куда придётся, и совпадало это случайно.
      // Теперь схема выбрана в beginRestart, тела уже стоят по ней, и подача
      // идёт РОВНО ТУДА, где кто-то есть. Это и есть разница между розыгрышем
      // и навесом наугад
      let target = null;
      let lift = null;
      if (r.routine && r.routine.aim) {
        const w = spotToWorld(r.routine.aim, team.side, r.z, F.length / 2);
        target = { x: w.x, z: w.z };
        lift = r.routine.lift;
      }
      if (!target) {
        // Фолбэк прежним поведением: схем нет (битый JSON) — ищем свободного
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
      }
      if (!target) {
        target = { x: team.side * (F.length / 2 - 8), z: -Math.sign(r.z || 1) * RC.farPostZ };
      }
      const dx = target.x - pos.x;
      const dz = target.z - pos.z;
      const dist = Math.hypot(dx, dz) || 1;
      // КОРОТКИЙ РОЗЫГРЫШ — это наземная передача, а не навес. Схема помечает
      // его нулевым подъёмом, и тогда угловой становится обычным фланговым
      // эпизодом: адресат принимает мяч и идёт под прострел, а прострел даёт
      // 6.4 гола на 100 против 2.5 у навеса
      if (lift === 0) {
        const power = Math.max(AI.passSpeedMin,
          Math.min(AI.passSpeedMax, passPower(dist, AI.passArriveNormal)));
        taker.aiKick(this.ball, { x: dx / dist, z: dz / dist }, power, 0.4, 0, 'setpiece');
        // Адресатом считаем того, кто стоит на точке схемы: он уже туда идёт
        const rec = this.nearestToPoint(
          team.fieldPlayers.filter((m) => m !== taker), target.x, target.z);
        if (rec) {
          team.receiver = rec;
          team.receiveTarget = { x: target.x, z: target.z };
          team.receiveTimer = CONFIG.ai.receiveGiveUp;
        }
        this._finishRestart();
        return;
      }
      const theta = (RC.angle * Math.PI) / 180;
      let power = Math.sqrt((-CONFIG.ball.gravity * dist) / (2 * Math.tan(theta))) * RC.powerFudge;
      power = Math.max(RC.powerMin, Math.min(RC.powerMax, power));
      taker.aiKick(this.ball, { x: dx / dist, z: dz / dist }, power, power * Math.tan(theta), 0, 'cross');
      team.onCrossStruck(this.ball); // замыкающий врывается на прилёт
      this._finishRestart();
      return;
    }

    // Удар от ворот: разыграть коротко, если есть чистый адресат, иначе вынос
    const K = CONFIG.ai.keeper;
    const pass = team.choosePass(taker, this.ball);
    if (pass) {
      taker.aiKick(this.ball, pass.dir, pass.power, pass.lift, 0, 'setpiece');
      team.commitPass(pass, taker);
    } else {
      const zs = Math.sign(r.z || 1);
      const dl = Math.hypot(team.side, zs * 0.5);
      taker.aiKick(this.ball, { x: team.side / dl, z: (zs * 0.5) / dl },
        K.clearPower, K.clearLift, 0, 'setpiece');
    }
    this._finishRestart();
  }

  // ===== Приказ своему вратарю «НА ВЫХОД» (W / Y, 28.07.2026) =====
  // У кнопки два смысла — ровно как у остальных в этой раскладке (см. шапку
  // src/input.js): мяч у нас — это ПАС НА ХОД, мяч у соперника — приказ
  // вратарю выйти из ворот. Так же устроена кнопка вратаря в FIFA/FC: она
  // не «умный помощник», а прямое управление риском — вышел не вовремя,
  // и это ошибка человека, а не движка.
  //
  // Приказ ДЕРЖИТСЯ, а не нажимается: пока кнопка зажата, кипер идёт на мяч.
  // Копившийся замах гасим — иначе на отпускании из вратарской вылетел бы
  // невольный пас на ход (та же грабля, что у подката и навеса).
  updateKeeperOrder() {
    const team = this.humanTeam;
    if (!team || !team.keeper) return;
    const ours = this.toucher && this.toucher.team === team;
    const held = this.input.through.held;
    if (!held || ours) return;
    team.keeper.gkOrder = true;
    this.input.through.cancel();
    if (!this._gkOrderHintShown) {
      this._setTempHint('ВРАТАРЬ ПОШЁЛ НА ВЫХОД');
      this._gkOrderHintShown = true;
    }
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
    if (this.hud.hint) {
      this.hud.hint.textContent = text;
      this.hud.hint.classList.remove('dim'); // временная подсказка всегда видна
    }
    this._tempHint = true;
    this.hintTimer = 0;
  }

  _restoreHint() {
    if (this._tempHint && this.hud.hint) this.hud.hint.innerHTML = this._hintHTML;
    this._tempHint = false;
    this._keeperHintShown = false;
    this._gkOrderHintShown = false;  // подсказка про выход вратаря — один раз за матч
    this.hintTimer = 0; // базовая шпаргалка повисит и погаснет заново
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

  // Пиротехника фанатского сектора. Одно место на все поводы: заставка
  // (встречают обе команды) и гол (зажигает только забившая).
  // Цвет ореола берём из формы, поэтому подмена пака меняет и его.
  litFlares(kind, teamIdx = -1) {
    const flares = this.scene && this.scene.userData.flares;
    if (!flares) return;
    const F = CONFIG.atmosphere.flares;
    const C = CONFIG.atmosphere.confetti;
    const confetti = this.scene.userData.confetti;
    // Бумагу бросают ТОЛЬКО свои: цвета берём из формы команды, поэтому
    // подмена пака меняет и серпантин.
    const paper = (i, count) => {
      if (!confetti) return;
      confetti.burst({ side: -this.teams[i].side, count, colors: [this._teamColors[i]] });
    };
    let lit = 0;
    if (kind === 'intro') {
      // «Свой» сектор — за СВОИМИ воротами, то есть напротив стороны атаки
      for (let i = 0; i < this.teams.length; i++) {
        lit += flares.ignite({
          side: -this.teams[i].side,
          count: F.introCount,
          color: this._teamColors[i],
        });
        paper(i, C.burstCount);
      }
    } else if (teamIdx >= 0) {
      lit = flares.ignite({
        side: -this.teams[teamIdx].side,
        color: this._teamColors[teamIdx],
      });
      paper(teamIdx, C.goalCount);
    }
    if (lit) flareHiss(lit, F.life);
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
    this._scorerIdx = scorerIdx;      // кого отматывать в повторе
    // Автор гола: он побежит праздновать, его назовёт титр и его же покажет
    // крупный план в конце серии повторов
    this._scorerPlayer = this.findScorer(scorerIdx);
    this.replay.markGoal(this._scorerPlayer ? this._all.indexOf(this._scorerPlayer) : -1);
    // Стадион взрывается: рёв трибун, шквал фотовспышек, сектора светлеют
    crowdCheer(1);
    const flashes = this.scene && this.scene.userData.flashes;
    if (flashes) flashes.cheer();
    // И фанатский сектор забившей зажигает файеры. Сектор СВОЙ, то есть за
    // своими воротами: t.side — это сторона ЧУЖИХ ворот (куда команда атакует).
    this.litFlares('goal', scorerIdx);
    this.hud.flash.textContent = 'ГОЛ!';
    this.hud.flash.classList.add('show');
    this.flashTimer = 2.0;

    // Титр под криком: автор гола и минута — как плашка в эфире. Автор —
    // последний касавшийся из забившей команды (свой гол подписываем
    // командой: имя защитника в титре гола выглядело бы наградой)
    if (this.hud.card) {
      const min = Math.max(1, Math.min(90, Math.floor(this.clock / 60)));
      const scorer = this._scorerPlayer;
      this.hud.cardMark.style.background = this._teamColors[scorerIdx];
      this.hud.cardTeam.textContent = (scorer && scorer.name)
        ? scorer.name : this._teamNames[scorerIdx];
      this.hud.cardMin.textContent = `${min}'`;
      this.hud.card.classList.add('show');
      this.goalCardTimer = CONFIG.match.goalCardTime;
    }
  }

  // Любая кнопка действия: «дальше» в заставке, празднике и повторах
  _actionPressed() {
    return this.input.pass.consume() !== null ||
      this.input.through.consume() !== null ||
      this.input.shot.consume() !== null ||
      !!this.input.consumeCross() ||
      !!this.input.consumeSwipe();
  }

  // ===== Повтор гола (26.07.2026) =====
  // Показываем всю комбинацию: запись отматывается до момента, когда мяч
  // забрала забившая команда. Не набралось истории — молча пропускаем.
  startReplay() {
    if (!this.replay || !this.replay.start(this._scorerIdx)) return false;
    this.state = 'replay';
    this.stateTimer = 0;
    this.goals.reset();               // сетка перестаёт колыхаться от «того» мяча
    this.controlledMarker.visible = false; // курсор игрока — не эфирная графика
    if (this.replayTag) this.replayTag.classList.add('show');
    document.body.classList.add('replaying'); // полосы видеомагнитофона
    return true;
  }

  endReplay() {
    this.replay.stop();
    if (this.replayTag) this.replayTag.classList.remove('show');
    document.body.classList.remove('replaying');
    this.controlledMarker.visible = true;
    this.goals.reset();
    this.kickoff(this.kickoffTeam);
  }

  fullTime() {
    this.state = 'fulltime';
    this.stateTimer = 0;
    this.restart = null; // свисток мог застать стандарт — бросаем его
    this._releaseKeeperHolds();
    playWhistle(1.6);        // финальный свисток длинный — так и свистят конец
    crowdApplause(1);
    this.hud.flash.textContent = `МАТЧ ОКОНЧЕН ${this.score[0]}:${this.score[1]}`;
    this.hud.flash.classList.add('show');
    this.flashTimer = CONFIG.match.fulltimePause;
  }

  // Плашка внизу кадра: чей сейчас мяч. Имя и номер приходят из состава
  // (data/teams/*.json → squad), метка — цвет формы команды. Никого с мячом —
  // подписываем управляемого игрока, чтобы курсор всегда был назван.
  // В заставке, повторе и празднике плашки нет: там своя графика.
  updatePlate() {
    const h = this.hud;
    if (!h.plate) return;
    const quiet = this.state === 'intro' || this.state === 'replay' || this.state === 'celebration';
    const p = quiet ? null : (this.toucher || this.controlled);
    // Ключ-кэш: трогаем DOM только когда игрок реально сменился
    const key = p ? `${p.name}|${p.number}|${this.teams.indexOf(p.team)}` : '';
    if (key === this._plateKey) return;
    this._plateKey = key;
    if (!p || !p.name) {
      h.plate.classList.remove('show');
      return;
    }
    h.plateMark.style.background = this._teamColors[Math.max(0, this.teams.indexOf(p.team))];
    h.plateNum.textContent = p.number != null ? String(p.number) : '';
    h.plateName.textContent = p.name;
    h.plate.classList.add('show');
  }

  updateHUD() {
    this.updatePlate();

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
