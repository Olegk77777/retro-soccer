// Слой «тренер» (стейт-машина команды по Бакленду): владеем — регионы едут
// вперёд, потеряли — назад; назначает, кто гонится за мячом, кто принимает
// пас, кто открывается в поддержку. Сам никого не двигает — только раздаёт
// назначения, «головы» игроков (fieldplayer.js) их исполняют.

import { CONFIG } from '../config.js';
import {
  distToBall, freeSpace, isPassSafe, predictLanding,
  xThreat, passPower, passTime, ROLL_LAMBDA,
} from './steering.js';
import { setPieces, spotToWorld } from '../setpieces.js';
import { buildMods, buildStyle, NEUTRAL_MODS } from '../roles.js';
import { buildFoeDefence, currentLevel } from '../difficulty.js';

export class Team {
  // side: +1 — атакуем ворота на +X, −1 — на −X. players[0] — вратарь.
  constructor(match, side, data, players) {
    this.match = match;
    this.side = side;
    this.data = data;
    this.players = players;
    // НАДБАВКА СОПЕРНИКУ ЧЕЛОВЕКА (31.07.2026, см. шапку src/difficulty.js).
    // Считается один раз здесь, как стиль и роли; ВЫБИРАЕТСЯ на лету геттером
    // `defence` ниже — потому что кто именно играет против человека, известно
    // только матчу и может смениться уже после конструктора (так делает
    // автосимуляция, подменяя humanTeam пустышкой)
    const lvl = currentLevel();
    this._defFoe = buildFoeDefence(lvl && lvl.id);
    // СТИЛЬ КОМАНДЫ и РОЛИ ИГРОКОВ (ресёрч 21 §8). Считаются ОДИН раз здесь:
    // в кадре это чтение готовых множителей из p.mods, без единой аллокации.
    // В глобальный CONFIG не пишет ничего — он один на игру, а роли поигроцкие
    this.style = buildStyle(data.style);
    players.forEach((p, i) => {
      p.team = this;
      p.homeIdx = i;
      p.role = CONFIG.formation.roles[i].id;
      p.isKeeper = i === 0;
      // Вратарю роли не назначаем: его поведение целиком в goalkeeper.js и
      // ролевых рычагов там нет ни одного
      p.mods = p.isKeeper ? NEUTRAL_MODS : buildMods(p, p.role, this.style);
    });

    this.attacking = false;   // владеем ли мячом (по мнению тренера)
    this.chaser = null;       // кто бежит к свободному мячу / прессингует
    this.coverer = null;      // кто страхует за спиной прессингующего (cover)
    this.marks = new Map();   // персональный разбор в своей трети: защитник → соперник
    this.receiver = null;     // кто ждёт адресованный ему пас
    this.receiveSpace = false; // пас отдан В ЗОНУ: адресат бежит в ТОЧКУ, а не за мячом
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
    this._armCd = 0;          // кулдаун ручного открывания под пас (armSpaceRun)

    // Подключение крайнего защитника по бровке (overlap, ресёрч 14):
    // отдельный слот — рывок снаружи, не конкурирует с runner
    this.overlapper = null;
    this.overlapTarget = null;
    this.overlapTimer = 0;

    // Приход в ноги (coming short): один игрок показывается накоротке
    this.shortRunner = null;
    this.shortTarget = null;
    this.shortTimer = 0;

    // Игра третьего (third man): связка взводится на пасе А→В и СТАРТУЕТ
    // по первому касанию В. До касания живёт только «заряд» (_thirdArm)
    this.thirdMan = null;
    this.thirdManTarget = null;
    this.thirdManTimer = 0;
    this._thirdArm = null;

    // Ложный рывок: уводит опекуна из зоны, куда бежит настоящий раннер
    this.decoy = null;
    this.decoyTarget = null;
    this.decoyTimer = 0;

    // Врывания в штрафную под навес: игрок → точка рывка (ближняя/дальняя/11 м)
    this.boxRuns = new Map();
    this.crossAir = 0; // сек: наша подача в полёте — рывки живут, врывание на прилёт

    // ВЫХОД НА ЧУЖУЮ ПОДАЧУ (правило с 31.07.2026): защитник → точка прилёта.
    // Зеркало boxRuns для обороняющейся стороны. Раньше на подачу в нашу
    // штрафную бежал ровно один chaser, а четвёрка держала опеку goal-side —
    // то есть ЗА спиной врывающегося (замер crossDuel: 0 выигранных мячей
    // из 10). Живёт ровно время полёта: назначение с истёкшим сроком хуже,
    // чем его отсутствие — защитник останется стоять в точке, где ничего нет
    this.airGuards = new Map();
    this.airGuardT = 0;

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

    // СЕРИЯ ВЛАДЕНИЯ (31.07.2026) — единица измерения осмысленной атаки.
    // Ведётся КАЖДЫЙ КАДР по match.possession, а не по this.attacking:
    // последнее обновляется лишь на такте тренера (до 250 мс запаздывания),
    // и серия начиналась бы уже после первой передачи
    this.seqLive = false;     // идёт ли серия прямо сейчас
    this.seqPasses = 0;       // передач в текущей серии
    this.seqT = 0;            // сек с начала серии
    this.seqStartX = 0;       // x мяча в начале серии (продвижение = |x − startX|)

    // ФАЗА ВЛАДЕНИЯ (31.07.2026) — скелет осмысленной атаки. Хранится СТРОКОЙ,
    // как ТВ-пресеты и уровни сложности: Number(null) === 0, и уровень с
    // индексом 0 неотличим от «ключа нет» — эта грабля в проекте стреляла дважды
    this.phase = 'PROGRESS';  // BUILD | PROGRESS | CREATE | COUNTER | DIRECT | CALM
    this.phaseT = 0;          // сек в текущей фазе
    this.phaseLock = 0;       // сек до разрешённой смены (обязательство)
    this.counterT = 0;        // окно контратаки
    this._justWon = false;    // мяч отобран в этом кадре (ставит updateSequence)
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

  // ОБОРОННЫЕ ЧИСЛА ЭТОЙ КОМАНДЫ. Обычно это общий CONFIG.ai.defence; команда,
  // против которой играет ЧЕЛОВЕК, получает надбавку уровня (см. шапку
  // src/difficulty.js). Геттер, а не поле, ровно из-за автосимуляции: она
  // подменяет `match.humanTeam` пустышкой уже после конструктора, и решение,
  // принятое один раз при создании команды, молча выдало бы надбавку одной из
  // двух AI-команд — а значит поехали бы все записанные эталоны AI против AI.
  // Условие «команда человека — одна из ДВУХ играющих» у пустышки ложно,
  // поэтому в симуляции надбавку не получает никто. Стоит это одно сравнение
  // ссылок на такт решений, то есть нисколько
  get defence() {
    if (!this._defFoe) return CONFIG.ai.defence;
    const human = this.match.humanTeam;
    if (human === this || !human) return CONFIG.ai.defence;
    return this.match.teams.includes(human) ? this._defFoe : CONFIG.ai.defence;
  }

  update(dt, ball) {
    const AI = CONFIG.ai;

    this.updateSequence(dt, ball);

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
        this._passLive = null;
        this.receiver = null;
        this.receiveTarget = null;
        this.receiveSpace = false;
      }
    }

    // Догоняющий пересчитывается каждый кадр — это дёшево (11 дистанций),
    // а реакция на отскок мгновенная, как у Бакленда в ChaseBall
    this.chaser = this.pickChaser(ball);

    // Линия защиты «дышит»: плавно едет к расчётной высоте (не телепорт) —
    // push up за мячом, drop off к своим воротам (ресёрч 09, lineSpeed)
    const lt = this.defLineTarget(ball);
    const step = this.defence.lineSpeed * dt;
    const dl = lt - this.defLineX;
    this.defLineX += Math.abs(dl) < step ? dl : Math.sign(dl) * step;

    // Подача в полёте: таймер тает; мяч опустился — фланговый эпизод окончен
    if (this.crossAir > 0) {
      this.crossAir -= dt;
      const bpA = ball.mesh.position;
      if (bpA.y < 0.5 && ball.vel.y <= 0) this.crossAir = 0;
    }

    // Выход на ЧУЖУЮ подачу живёт то же окно, что сама подача. Снимаем и по
    // приземлению мяча: дальше это обычный подбор, и держать защитника на
    // старой точке прилёта — значит уводить его от эпизода
    // Розыгрыш стандарта живёт своим таймером и НЕ подчиняется правилу «мяч
    // опустился — эпизод окончен»: на угловом мяч лежит на газоне, и это
    // правило стёрло бы расстановку в первом же кадре
    if (this._setPieceT > 0) this._setPieceT -= dt;
    const inSetPiece = this._setPieceT > 0;
    if (this.airGuardT > 0) {
      this.airGuardT -= dt;
      const bpG = ball.mesh.position;
      if (this.airGuardT <= 0 || (!inSetPiece && bpG.y < 0.5 && ball.vel.y <= 0)) {
        this.airGuardT = 0;
        this.airGuards.clear();
      }
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
    // Игра третьего: заряд ждёт ПЕРВОГО КАСАНИЯ адресата первого паса —
    // именно этот миг и обманывает оборону, а не сам пас
    if (this._thirdArm) {
      this._thirdArm.t -= dt;
      if (this._thirdArm.t <= 0 || !this.attacking) {
        this._thirdArm = null;
      } else if (this.match.toucher === this._thirdArm.b) {
        const a = this._thirdArm;
        this.thirdMan = a.c;
        this.thirdManTarget = a.target;
        this.thirdManTimer = CONFIG.ai.combo.thirdMan.ttl;
        this.bump('third');
        a.c.runCd = CONFIG.ai.attack.offBall.cooldown;
        this._thirdArm = null;
      }
    }
    if (this.thirdMan) {
      this.thirdManTimer -= dt;
      if (this.thirdManTimer <= 0 || !this.attacking ||
          this.match.toucher === this.thirdMan) {
        this.thirdMan = null;
        this.thirdManTarget = null;
      }
    }
    // Ложный рывок живёт своё окно и НИКОГДА не просит мяч (см. choosePass)
    if (this.decoy) {
      this.decoyTimer -= dt;
      if (this.decoyTimer <= 0 || !this.attacking) {
        this.decoy = null;
        this.decoyTarget = null;
      }
    }
    // Кулдаун рывка у каждого: рывки не должны идти сплошным потоком
    for (const p of this.players) {
      if (p.runCd > 0) p.runCd -= dt;
    }

    if (this._runCheckTimer > 0) this._runCheckTimer -= dt;
    if (this._armCd > 0) this._armCd -= dt;
    if (this._spotTimer > 0) this._spotTimer -= dt;

    this._coachTimer -= dt;
    if (this._coachTimer > 0) return;
    this._coachTimer = AI.coachTick;

    // Владение — по последнему касанию (считает Match)
    this.attacking = this.match.possession === this;

    // Фаза решается ДО назначений: споты, рывки, оверлап и врывания обязаны
    // читать уже новую фазу в этом же такте, иначе они отстают на четверть
    // секунды и на переходе «продвижение → завершение» команда полтакта
    // занимает штрафную по правилам середины поля
    this.updatePhase(ball);

    if (this.attacking) {
      // Лучший спот открывания (Бакленд, пересчёт раз в updateSec)
      if (this._spotTimer <= 0) {
        this._spotTimer = CONFIG.ai.attack.spot.updateSec;
        this.updateBestSpot(ball);
      }
      // БЮДЖЕТ РЫВКОВ (ресёрч 15 §5.3, оживлён 31.07.2026). Поля maxInSpace,
      // maxToFeet и commit лежали в конфиге с 26.07 и НЕ ЧИТАЛИСЬ НИ РАЗУ —
      // grep по src/ давал ноль совпадений вне config.js. Единственным
      // ограничителем был личный кулдаун игрока, поэтому одновременных рывков
      // выходило 5–7 при заявленном потолке 3, и замер это подтвердил:
      // 74 рывка и 25 приходов в ноги за 6-минутный матч на «Профессионале» —
      // одно движение без мяча каждые 3.6 секунды. Это и есть «все бегут —
      // никто не открыт»: в кадре ТВ-плана 320×240 зритель не успевает прочесть
      // ни одного замысла, потому что их пять одновременно
      const OB = CONFIG.ai.attack.offBall;
      const budget = this.runBudget();
      // Потолок задаёт ФАЗА: при розыгрыше от своих ворот бежать вперёд некуда
      // и незачем (там нужны короткие адресаты, а не глубина), в завершении —
      // наоборот, чем больше тел врывается, тем лучше
      const cfg = this.phaseCfg();
      // Стиль команды бюджет рывков НЕ трогает, и это осознанно: потолки здесь
      // целые и крошечные (2 и 1), любой множитель из реального диапазона
      // inSpaceBias (0.61…0.86) округляется в то же самое целое — то есть
      // рычаг был бы мёртвым полем. Ось «в пространство против в ноги» живёт
      // там, где шкала непрерывна: в оценке кандидатов паса (choosePass)
      const maxInSpace = Math.min(OB.maxInSpace, cfg.maxInSpace);
      // Пора ли кому-то рвануть за спину защите
      if (!this.runner && this._runCheckTimer <= 0 && budget.inSpace < maxInSpace) {
        this._runCheckTimer = CONFIG.ai.attack.runs.checkSec;
        this.tryStartRun(ball);
      }
      // Мяч у широкого игрока — крайний защитник подключается по бровке.
      // В розыгрыше и в успокоении фулбека вперёд не пускаем: именно его
      // подключение и стоит гола на контратаке
      if (!this.overlapper && cfg.overlapOk && budget.inSpace < maxInSpace) this.tryOverlap();
      // Владельца прессингуют, безопасного паса нет — партнёр показывается
      // накоротке (главный источник передач под давлением). У прихода в ноги
      // СВОЙ бюджет: реальный сплит рывков — 72 % в пространство, 28 % в ноги
      if (budget.toFeet < OB.maxToFeet) this.tryComingShort(ball);
      // Настоящий рывок уже назначен — кто-то обязан увести его опекуна.
      // Обманщик считается рывком в пространство и тратит тот же бюджет
      if (!this.decoy && budget.inSpace < maxInSpace) this.tryDecoy(ball);
    }

    // Поддержка атаки: ближний к «точке открывания» полузащитник/нападающий
    this.supporter = this.attacking ? this.pickSupporter(ball) : null;

    // Оборонительные назначения: страхующий за спиной прессингующего
    // (sweeper/cover из PES Defence System) и персональный разбор в своей трети
    this.coverer = this.attacking ? null : this.pickCoverer(ball);
    this.updateMarks(ball);
    this.trackRunners();

    // Врывания под навес: мяч на нашем фланге в финальной трети —
    // форварды рывками занимают штанги и точку 11 м
    this.updateBoxRuns(ball);
  }

  // ===== ФАЗЫ ВЛАДЕНИЯ (31.07.2026) =====
  // Жалоба заказчика «даже на Профессионале ИИ играет сумбурно, без осмысленных
  // атак» была не про силу ИИ, а про ОТСУТСТВИЕ ЗАМЫСЛА. В коде существовало
  // ровно одно состояние атаки — булев `attacking`, — и девять независимых
  // механик (забег, оверлап, игра третьего, обманщик, приход в ноги, четыре
  // точки в штрафной), каждая со своим триггером и таймером. Они не знали друг
  // о друге НИЧЕГО, и команда не знала, что она сейчас делает: разыгрывает от
  // своих ворот, продвигает мяч или уже завершает. Отсюда и картинка: игра
  // одинаковая на всех участках поля и на любой секунде владения.
  //
  // Фаза — это НЕ новая ветка логики. Она МОДУЛИРУЕТ уже написанные формулы:
  // риск паса, порог отсева, температуру софтмакса, множители семейств, темп
  // и бюджет рывков. Поэтому PROGRESS — это тождество (все коэффициенты 1.0),
  // и с ним игра ведёт себя ровно так, как вела до правки. Проверка приёмки
  // прямая: `ai.phase.enabled = false` обязано давать прежние числа.
  //
  // Числа фаз — из реального футбола (см. 21-Тактика): 89 % серий владения
  // укладываются в 1–5 передач, средняя серия АПЛ живёт 9.6–10.4 с и
  // продвигает мяч на 12.1–12.6 м; контратака как фаза живёт 5–10 секунд,
  // дальше она либо становится позиционной атакой, либо кончается.
  updatePhase(ball) {
    const P = CONFIG.ai.phase;
    const won = this._justWon;
    this._justWon = false;
    if (!P.enabled) {
      this.phase = 'PROGRESS';
      return;
    }
    if (!this.attacking) {
      // Без мяча фазы нет. Держим PROGRESS (тождество), чтобы обороняющаяся
      // команда жила ровно по прежним числам
      this.setPhase('PROGRESS', 0);
      this.counterT = 0;
      return;
    }

    // МОМЕНТ ОТБОРА. Соперник впереди мяча ещё не построился — это контратака,
    // и она перебивает любые зоны: бежать надо сейчас, а не когда мяч дойдёт
    // до чужой трети
    // Острота контратаки — командный рычаг стиля: Италия-98 при своём самом
    // плотном блоке имела и самый быстрый переход (три фигуры, летящие вперёд
    // за две передачи), Германия-98 — наоборот
    if (won && this.oppBehindBall(ball) < P.counter.maxBehind * this.style.counterK) {
      this.setPhase('COUNTER', P.hold);
      this.counterT = P.counter.window * this.style.counterK;
      return;
    }
    // Контратака живёт своим окном и КОЛИЧЕСТВОМ ПЕРЕДАЧ: после четвёртой это
    // уже не контратака, а позиционная атака, как её ни называй
    if (this.phase === 'COUNTER') {
      if (this.counterT > 0 && this.seqPasses < P.counter.maxPasses) return;
      this.counterT = 0;
    }

    if (this.phaseLock > 0) return;   // обязательство: фазу не пересматриваем

    // Атака в финальной трети заглохла и передачи лучше порога нет — надо не
    // лезть напролом, а ОТКАТИТЬ и перестроиться. Без этой фазы владелец под
    // опекой обязан был либо терять мяч, либо бить с плохой позиции
    if (this.phase === 'CREATE' && this.phaseT > P.calm.stall &&
        (this._passBest || 0) < P.calm.passFloor) {
      this.setPhase('CALM', P.calm.ttl);
      return;
    }
    if (this.phase === 'CALM' && this.phaseT < P.calm.ttl) return;

    // Розыгрыш от своих ворот под прессингом, короткого паса нет — длинный
    // вперёд. Это осознанный выбор, а не отчаяние: прямая игра — такой же
    // способ развития атаки, как позиционная
    const zone = this.zonePhase(ball);
    if (zone === 'BUILD' && (this._passBest || 0) < P.direct.passFloor) {
      this.setPhase('DIRECT', P.direct.ttl);
      return;
    }
    if (this.phase === 'DIRECT' && this.phaseT < P.direct.ttl) return;

    this.setPhase(zone, P.hold);
  }

  // Зона мяча с ГИСТЕРЕЗИСОМ: граница трети, пройденная туда-сюда, не должна
  // перещёлкивать фазу. Тот же приём, что у флага «широкий» и у опеки
  zonePhase(ball) {
    const P = CONFIG.ai.phase;
    const F = CONFIG.field;
    // 0 = наша лицевая, 105 = чужая
    const depth = this.side * ball.mesh.position.x + F.length / 2;
    const h = P.zoneHyst;
    const buildTo = this.phase === 'BUILD' ? P.buildTo + h : P.buildTo - h;
    const createFrom = this.phase === 'CREATE' ? P.createFrom - h : P.createFrom + h;
    if (depth < buildTo) return 'BUILD';
    if (depth > createFrom) return 'CREATE';
    return 'PROGRESS';
  }

  setPhase(id, lock) {
    if (this.phase !== id) {
      this.phase = id;
      this.phaseT = 0;
    }
    this.phaseLock = Math.max(this.phaseLock, lock);
  }

  // Коэффициенты текущей фазы. Один вход для всех потребителей — и он же
  // выключатель ablation: `ai.phase.enabled = false` возвращает тождество
  phaseCfg() {
    const P = CONFIG.ai.phase;
    if (!P.enabled) return P.levels.PROGRESS;
    return P.levels[this.phase] || P.levels.PROGRESS;
  }

  // Сколько соперников успело вернуться за линию мяча. Это и есть мера
  // «построился ли блок»: контратака имеет смысл, только пока их мало
  oppBehindBall(ball) {
    const bx = ball.mesh.position.x;
    let n = 0;
    for (const o of this.opponents) {
      if (o.isKeeper) continue;
      if (this.side * (o.group.position.x - bx) > 0) n++;
    }
    return n;
  }

  // ===== РОЗЫГРЫШ УГЛОВОГО (31.07.2026) =====
  // Расстановка АТАКУЮЩЕЙ команды по выбранной схеме. Точки кладём в ту же
  // карту `boxRuns`, которой пользуется подача с игры, — исполнение в
  // fieldplayer.js уже написано (arrive + спринт), новой ветки движения не
  // нужно ни одной. Исполнитель углового в раздачу не входит: он у флажка.
  //
  // Раздаём ВЕНГЕРСКИ-ПРОСТО: точка достаётся тому, кто до неё ближе, и по
  // порядку важности ролей в схеме. Точной оптимизации тут не нужно — важно,
  // чтобы на ближней штанге стоял ОДИН, а не трое, и чтобы дальняя не осталась
  // пустой: именно это, а не миллиметры, отличает розыгрыш от толпы
  armCornerAttack(restart, routine) {
    const F = CONFIG.field;
    this.boxRuns.clear();
    if (!routine || !routine.spots || !routine.spots.length) return;
    const pool = this.fieldPlayers.filter((p) => p !== restart.taker);
    for (const spot of routine.spots) {
      if (!pool.length) break;
      const w = spotToWorld(spot, this.side, restart.z, F.length / 2);
      let bi = 0;
      let bd = Infinity;
      pool.forEach((p, i) => {
        const pp = p.group.position;
        let d = Math.hypot(pp.x - w.x, pp.z - w.z);
        // Нападающие идут в штрафную, защитники остаются сзади: без этого
        // на дальнюю штангу приезжал центральный защитник, а форвард шёл
        // сторожить свою половину — розыгрыш выглядел бы случайным
        d += (p.homeIdx <= 4 ? 22 : 0);
        if (d < bd) { bd = d; bi = i; }
      });
      this.boxRuns.set(pool[bi], w);
      pool.splice(bi, 1);
    }
    this._setPieceT = CONFIG.ai.setPiece.ttl;
  }

  // Расстановка ОБОРОНЯЮЩЕЙСЯ команды. Точки — в `airGuards`, ту же карту
  // использует выход на подачу с игры, и ветка движения там тоже готова.
  // Точки нарочно НЕ покрывают всю штрафную: смешанная оборона — это двое
  // зонально плюс штанга, остальное доигрывает обычная персональная опека.
  // Накрой всё зонально — и подача перестанет иметь смысл в принципе
  armCornerDefend(restart) {
    const F = CONFIG.field;
    const D = setPieces().corner.defend;
    this.airGuards.clear();
    if (!D || !D.spots || !D.spots.length) return;
    // Обороняющаяся команда защищает СВОИ ворота, а координаты схемы заданы
    // от атакуемой лицевой. Сторона у нас −side, поэтому знак берём свой
    const pool = this.fieldPlayers.slice();
    for (const spot of D.spots) {
      if (!pool.length) break;
      const w = spotToWorld(spot, -this.side, restart.z, F.length / 2);
      let bi = 0;
      let bd = Infinity;
      pool.forEach((p, i) => {
        const pp = p.group.position;
        let d = Math.hypot(pp.x - w.x, pp.z - w.z);
        // Здесь наоборот: на штанги и в зону идут ЗАЩИТНИКИ
        d += (p.homeIdx >= 9 ? 22 : 0);
        if (d < bd) { bd = d; bi = i; }
      });
      this.airGuards.set(pool[bi], w);
      pool.splice(bi, 1);
    }
    this.airGuardT = CONFIG.ai.setPiece.ttl;
    this._setPieceT = CONFIG.ai.setPiece.ttl;
  }

  // Сколько движений без мяча идёт ПРЯМО СЕЙЧАС. Считается по живым слотам,
  // а не по счётчику запусков: рывок, который уже кончился, бюджет не занимает.
  // Игра третьего считается в бюджете и ЗАРЯДОМ (_thirdArm) — иначе между
  // взводом связки и первым касанием адресата слот выглядит свободным, и
  // тренер успевает назначить поверх неё ещё один забег
  runBudget() {
    let inSpace = 0;
    if (this.runner) inSpace++;
    if (this.overlapper) inSpace++;
    if (this.thirdMan || this._thirdArm) inSpace++;
    if (this.decoy) inSpace++;
    return { inSpace, toFeet: this.shortRunner ? 1 : 0 };
  }

  // СЕРИЯ ВЛАДЕНИЯ. Открывается, как только мяч стал нашим, и закрывается на
  // потере — тогда же её итоги уходят в статистику. Это не украшение отчёта:
  // счёт голов «сумбур» не ловит (замер 31.07: 1.5 гола за матч и на сборке
  // до правок, и после), а вот «сколько передач живёт наша атака и на сколько
  // метров она продвигает мяч» — ловит сразу. Эталоны реального футбола:
  // 89 % серий укладываются в 1–5 передач, средняя серия АПЛ живёт 9.6–10.4 с
  // и продвигает мяч на 12.1–12.6 м вперёд (Opta Analyst 2024/25 и 2025/26).
  updateSequence(dt, ball) {
    // Таймеры фазы идут КАЖДЫЙ КАДР, а решение о смене принимается на такте
    // тренера: обязательство, которое тает раз в четверть секунды, — это не
    // обязательство
    this.phaseT += dt;
    if (this.phaseLock > 0) this.phaseLock -= dt;
    if (this.counterT > 0) this.counterT -= dt;

    // ИСХОД ПЕРЕДАЧИ СЧИТАЕТСЯ ПО ПЕРВОМУ КАСАНИЮ ПОСЛЕ НЕЁ, а не через слот
    // приёма (правка 31.07.2026). Прежняя запись закрывала передачу только
    // когда снимался `this.receiver` — а его ПЕРЕЗАПИСЫВАЕТ следующий пас в
    // серии. Пока серии жили по 1.4 передачи, это почти не мешало; как только
    // они стали настоящими (3.3 передачи), большинство передач перекрывалось
    // следующей и не засчитывалось вовсе, и «точность» рухнула с 38 до 25 %
    // на игре, которая стала ЛУЧШЕ. Метрика, ломающаяся ровно тогда, когда
    // улучшается измеряемое, хуже отсутствия метрики
    // Закрывает передачу КАСАНИЕ СВОЕГО или СМЕНА ВЛАДЕНИЯ — но не касание
    // соперника само по себе. Причина та же, по которой владению дали
    // гистерезис: `toucher` — это ближайший к мячу в 1.35 м, и катящийся мимо
    // защитника пас на миг «принадлежит» ему, хотя спокойно доезжает до своего
    const w = this._passWait;
    if (w) {
      w.t -= dt;
      const t = this.match.toucher;
      if (t && t !== w.from && t.team === this) {
        if (t === w.mate) this.bump('passOk');
        this.bump('passKept');
        this._passWait = null;
      } else if (this.match.possession !== this || w.t <= 0) {
        this._passWait = null;   // мяч потерян, ушёл в аут или никем не найден
      }
    }

    const mine = this.match.possession === this;
    const bx = ball.mesh.position.x;
    if (mine && !this.seqLive) {
      this.seqLive = true;
      this._justWon = true;
      this.seqPasses = 0;
      this.seqT = 0;
      this.seqStartX = bx;
      this.bump('seq');
    } else if (mine) {
      this.seqT += dt;
    } else if (this.seqLive) {
      this.seqLive = false;
      // Десятые доли секунды — чтобы сумма осталась целым числом и не копила
      // ошибку сложения дробей за 8 матчей автосимуляции
      this.bump('seqTime', Math.round(this.seqT * 10));
      // Продвижение считается ПО ХОДУ АТАКИ (side), поэтому откат назад
      // честно уходит в минус: серия, вернувшая мяч своему вратарю, не
      // должна выглядеть такой же полезной, как доведшая его до штрафной
      this.bump('seqProg', Math.round(this.side * (bx - this.seqStartX)));
      if (this.seqPasses >= 4) this.bump('seqLong');
    }
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
    // Расстановка по схеме розыгрыша (угловой) — тоже. Она живёт в этой же
    // карте, и общий пересчёт стёр бы её в первом же кадре: мяч на угловом
    // лежит далеко от штрафной, а значит ни один из триггеров ниже не пройдёт
    if (this._setPieceT > 0) return;
    const prev = new Map(this.boxRuns);
    this.boxRuns.clear();
    if (!this.attacking) return;
    const bp = ball.mesh.position;
    const goalX = this.attackGoalX;
    // Триггер — по ГЛУБИНЕ мяча, а не радиусом от центра ворот: радиус съедала
    // ширина, и с фланга финальной трети (классическая позиция для подачи)
    // штрафную не занимал НИКТО — подавать было некому
    if (this.side * bp.x < F.length / 2 - B.fromGoal) return;
    if (Math.abs(bp.z) > B.maxZ) return;

    const s = Math.sign(bp.z || 1); // «ближняя» штанга — со стороны мяча
    // Порядок = ценность. Кандидатов почти всегда меньше четырёх, и раньше
    // пустым оставался ИМЕННО трейлер — тот, кто замыкает прострел (6.4 гола
    // на 100 против 2.5 у навеса). Теперь первым занимают его
    // Сколько тел вообще занимает штрафную — командный рычаг стиля: Германия-98
    // грузила туда всех, Италия-98 оставляла двоих и страховала контратаку.
    // По умолчанию 4 — прежнее поведение
    const targets = [
      { x: goalX - this.side * B.trailer.x, z: B.trailer.z },
      { x: goalX - this.side * B.golden.x, z: B.golden.z },
      { x: goalX - this.side * B.nearPost.x, z: s * B.nearPost.z },
      { x: goalX - this.side * B.farPost.x, z: s * B.farPost.z },
    ].slice(0, this.style.boxRunners);
    // Кандидаты: атакующая шестёрка, кроме занятых ролями. Поддерживающего
    // НЕ забираем: если в штрафную уйдут все, владельцу некому отдать, он
    // упрётся в защитника и потеряет мяч — замер показал падение ударов
    // втрое, когда в коробку врывались четверо из шести.
    // Раннера и подключившегося фулбека тоже исключаем: их ветки в
    // fieldplayer.js стоят ВЫШЕ boxRuns, и назначенная точка просто пропадала.
    // А вот догоняющего (chaser) исключать нельзя: при мяче у партнёра его
    // ветка всё равно не работает, а игрока из штрафной он забирал
    const pool = this.players.slice(5)
      .filter((p) => p !== this.match.toucher && p !== this.match.controlled &&
        p !== this.receiver && p !== this.shortRunner && p !== this.supporter &&
        p !== this.runner && p !== this.overlapper);
    // Мяч у самой лицевой — подключаем и крайних защитников: в штрафной
    // должны быть тела, иначе подача уходит в никуда
    if (this.side * bp.x > F.length / 2 - 20) {
      for (const i of [1, 4]) {
        const fb = this.players[i];
        if (fb && fb !== this.match.toucher && fb !== this.overlapper) pool.push(fb);
      }
    }
    for (const t of targets) {
      if (!pool.length) break;
      let bi = 0;
      let bd = Infinity;
      pool.forEach((p, i) => {
        const pp = p.group.position;
        // Фора прежнему исполнителю ЭТОЙ ЖЕ точки: назначения пересчитываются
        // каждые coachTick, и без гистерезиса игроки меняются точками на бегу
        const was = prev.get(p);
        const same = was && Math.abs(was.x - t.x) < 0.6 && Math.abs(was.z - t.z) < 0.6;
        // Ролевая фора и гистерезис — обе в МЕТРАХ и складываются: рывок под
        // подачу даёт 7 голов на 100 обслуженных, вдвое больше рывка за спину,
        // поэтому столб и поачер обязаны выигрывать конкурс за точку у опорного
        const d = Math.hypot(pp.x - t.x, pp.z - t.z)
          - p.mods.bBox - (same ? B.stickBonus : 0);
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

    // Уже есть надёжная опция — открываться накоротке незачем. Смотрим ЛУЧШИЙ
    // счёт последней оценки (this._passBest), а не результат нового вызова:
    // choosePass возвращает вариант, вытянутый софтмаксом, и сравнение с
    // порогом превращалось в бросок монеты (плюс лишний полный проход по
    // одиннадцати партнёрам каждый такт тренера)
    if ((this._passBest || 0) >= S.safeOption) return;

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
      if (d < S.minGap || d > S.maxGap) continue;
      // Гейты считаются по СЫРОЙ дистанции, а ролевая фора — только в конкурсе:
      // приход в ноги это 3.72 рывка за 90 минут у опорного против 0.41 у
      // центрального защитника, то есть разница в восемь раз
      const cost = d - p.mods.bShort;
      if (cost < bestD) {
        bestD = cost;
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
    best.runCd = C.cooldown * best.mods.runCdK;
    this.bump('short');
  }

  // ИГРА ТРЕТЬЕГО (third man run). Взводится в момент паса А→В: если пас
  // короткий и «в ноги», а на В висит опекун, то мяч дальше пойдёт не назад к
  // А (это читается), а ТРЕТЬЕМУ — С, который стартует по первому касанию В.
  // По Coaches' Voice: «игрок, получающий решающий пас, — не тот, на кого
  // пасующий смотрел первым». Против низкого блока это работает там, где
  // забегание за спину бессмысленно: пространства за линией просто нет.
  armThirdMan(a, b, dist) {
    const C = CONFIG.ai.combo.thirdMan;
    if (this.thirdMan || this._thirdArm) return;
    if (!a || !b || b.isKeeper || dist > C.maxFirstPass) return;
    const bp = b.group.position;
    const ap = a.group.position;

    // Комбинация нужна только когда В под опекой — иначе он развернётся сам
    let marker = Infinity;
    for (const o of this.opponents) {
      if (o.isKeeper) continue;
      const op = o.group.position;
      marker = Math.min(marker, Math.hypot(op.x - bp.x, op.z - bp.z));
    }
    if (marker > C.markerDist) return;

    // Третий — свободный атакующий, не занятый другой ролью
    let best = null;
    let bestD = Infinity;
    for (const p of this.players.slice(5)) {
      if (p === a || p === b || p.runCd > 0) continue;
      if (p === this.receiver || p === this.runner || p === this.overlapper ||
          p === this.shortRunner || p === this.match.controlled) continue;
      const d = Math.hypot(p.group.position.x - bp.x, p.group.position.z - bp.z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (!best) return;

    // Цель — вперёд от В по линии паса, довёрнутой к воротам: третий выходит
    // ЗА спину опекуну В, а не бежит в ту же точку
    const dx = bp.x - ap.x;
    const dz = bp.z - ap.z;
    const dl = Math.hypot(dx, dz) || 1;
    const turn = (C.turnDeg * Math.PI) / 180 * (bp.z > 0 ? -1 : 1);
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const ux = (dx / dl) * cos - (dz / dl) * sin;
    const uz = (dx / dl) * sin + (dz / dl) * cos;
    const F = CONFIG.field;
    this._thirdArm = {
      b,
      c: best,
      t: C.armTtl,
      target: {
        x: Math.max(-F.length / 2 + 5,
          Math.min(F.length / 2 - 5, bp.x + ux * C.runAhead)),
        z: Math.max(-F.width / 2 + 4,
          Math.min(F.width / 2 - 4, bp.z + uz * C.runAhead)),
      },
    };
  }

  // ЛОЖНЫЙ РЫВОК. Единственное движение в игре, которое оптимизирует
  // пространство ПАРТНЁРА: обманщик уводит своего опекуна вбок из канала, куда
  // бежит настоящий раннер. Мяч он не просит НИКОГДА (choosePass его
  // пропускает) — иначе обман превращается в обычное открывание.
  tryDecoy(ball) {
    const C = CONFIG.ai.combo.decoy;
    const F = CONFIG.field;
    const main = this.runner || this.thirdMan || this.overlapper;
    const target = this.runnerTarget || this.thirdManTarget || this.overlapTarget;
    if (!main || !target) return;
    const bp = ball.mesh.position;
    if (this.side * bp.x < F.length / 2 - 40) return; // только у чужих ворот

    let best = null;
    let bestD = Infinity;
    for (const p of this.players.slice(5)) {
      if (p === main || p.runCd > 0 || p === this.match.toucher) continue;
      if (p === this.receiver || p === this.shortRunner ||
          p === this.match.controlled || this.boxRuns.has(p)) continue;
      const pp = p.group.position;
      const d = Math.hypot(pp.x - target.x, pp.z - target.z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (!best) return;

    // Уводим ПРОЧЬ от канала настоящего рывка и вперёд — опекун идёт следом
    const pp = best.group.position;
    const away = Math.sign(pp.z - target.z) || (Math.random() < 0.5 ? -1 : 1);
    this.decoy = best;
    this.decoyTarget = {
      x: Math.max(-F.length / 2 + 5,
        Math.min(F.length / 2 - 5, pp.x + this.side * C.dist * 0.6)),
      z: Math.max(-F.width / 2 + 3,
        Math.min(F.width / 2 - 3, pp.z + away * C.awayZ)),
    };
    this.decoyTimer = C.ttl;
    best.runCd = CONFIG.ai.attack.offBall.cooldown;
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

    // Соперник обязан узнать о подаче ТУТ ЖЕ, и раньше собственных наших
    // проверок: даже если замыкать некому, обороне на этот мяч выходить.
    // Вызовов onCrossStruck четыре (match.js, player.js, fieldplayer.js), и
    // вешать защитную половину на каждый — верный способ забыть один: новый
    // вид подачи молча остался бы без сопротивления. Поэтому зеркало здесь
    const foe = this.match.otherTeam(this);
    if (foe && foe.onCrossDefend) foe.onCrossDefend(ball, land);

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
    this.receiveSpace = false;
    this.receiveTarget = { x: land.x, z: land.z };
    this.receiveTimer = Math.max(CONFIG.ai.receiveGiveUp, land.t + 0.8);
    return best;
  }

  // ВЫХОД ЗАЩИТНИКА НА ПОДАЧУ — зеркало onCrossStruck для обороняющихся.
  // Кто-то обязан играть В МЯЧ, а не в человека: персональная опека ставит
  // защитника goal-side, то есть ЗА спиной врывающегося, и на верховой мяч он
  // не претендует вовсе (замер tools/defence-rig.js → crossDuel до правки:
  // атака 60 %, оборона 0 %, вратарь 0 %).
  //
  // Выбираем по тому же критерию, что атака, — минимальному времени прихода
  // в точку прилёта. Вратарь сюда не входит: у него своя ветка выхода
  // (tryClaim), и две логики на один мяч уже ловились в проекте как «двое
  // бегут, никто не играет». Управляемый человеком тоже не входит — за него
  // решает Олег, и это заодно делает механику компьютерной по построению.
  onCrossDefend(ball, land) {
    const G = this.defence.aerialGuard;
    this.airGuards.clear();
    this.airGuardT = 0;
    if (!G || G.count <= 0 || !land) return;
    // Подача не в нашу зону — не наше дело
    const F = CONFIG.field;
    const depth = F.length / 2 + this.side * land.x;   // м от НАШИХ ворот
    if (depth > G.range) return;

    const spd = CONFIG.player.speed * CONFIG.player.sprintFactor * CONFIG.ai.speedFactor;
    const pool = this.players.filter((p) =>
      !p.isKeeper && p !== this.match.controlled && p.downT <= 0 && p.tackleT <= 0);
    const cand = [];
    for (const p of pool) {
      const pp = p.group.position;
      const need = Math.hypot(land.x - pp.x, land.z - pp.z) / spd;
      // ЕДИНСТВЕННОЕ УСЛОВИЕ — УСПЕТЬ К МЯЧУ, а не «успеть раньше соперника».
      // Первая редакция требовала выиграть гонку у ближайшего атакующего, и
      // замер показал, чего это стоит: выбрасывалось 0.1 защитника из двух
      // заказанных, то есть механика не работала вовсе. Иначе и быть не могло —
      // подача летит РОВНО туда, где уже стоит врывающийся, и «раньше него» не
      // успевает никто. Но борьба на втором этаже и есть встреча двоих в одной
      // точке: защитник не обязан выигрывать гонку, он обязан ПРИЙТИ.
      // Предохранитель остаётся, только он теперь про безнадёжность: опоздал
      // больше чем на `late` — не беги, оголишь зону, а мяч всё равно не тронешь
      if (need > land.t + G.late) continue;
      cand.push({ p, cost: need });
    }
    if (!cand.length) return;
    cand.sort((a, b) => a.cost - b.cost);
    for (const c of cand.slice(0, G.count)) {
      this.airGuards.set(c.p, { x: land.x, z: land.z });
    }
    if (this.airGuards.size) this.airGuardT = land.t + G.ttl;
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
      // Ролевая фора: рывок за спину — самое сильное отличие ролей в футболе
      // вообще (нападающий 5.13 раза за 90 минут против 0.06 у центрального
      // защитника, разница в 85 раз). При весе 0.5 фора ровно 0 м
      const d = Math.hypot(p.group.position.x - fx, p.group.position.z - op.z)
        - p.mods.bBehind;
      if (d < bd) {
        bd = d;
        runner = p;
      }
    }
    if (!runner) return;

    const rp = runner.group.position;
    const dOwner = Math.hypot(rp.x - op.x, rp.z - op.z);
    const distanceRating = Math.sqrt(Math.max(0, 1 - dOwner / R.maxDist));

    // Цель — за фактическую линию защиты соперника, ближе к центру (канал)
    const oppTeam = this.match.otherTeam(this);
    let tx = oppTeam.defLineX + this.side * R.behindLine;
    const maxDepth = F.length / 2 - 8; // не в объятия вратаря
    if (this.side * tx > maxDepth) tx = this.side * maxDepth;
    const tz = Math.max(-18, Math.min(18, rp.z * 0.6));

    // Плотность считаем В ЦЕЛИ РЫВКА, а не за спиной раннера: прежний замер
    // стоял ровно там, ОТКУДА игрок уходит, — то есть в самой гуще блока, и
    // произведение выходило втрое ниже порога. Рывок за спину не запускался
    // в финальной трети никогда
    const nearest = this.opponents
      .map((o) => Math.hypot(o.group.position.x - tx, o.group.position.z - tz))
      .sort((a, b) => a - b)
      .slice(0, 4);
    let density = 1;
    for (const d of nearest) {
      density -= R.densityPenalty * Math.sqrt(Math.max(0, 1 - d / R.densityRadius));
    }
    // Множитель роли стоит на УЖЕ ВЫБРАННОМ раннере, а не на пороге: порог
    // R.trigger перекрыт уровнем сложности в обоих уровнях, и правка порога
    // подралась бы с ним. При весе 0.5 множитель ровно 1.0
    if (distanceRating * density * runner.mods.gBehind < R.trigger) return;

    this.runner = runner;
    this.runnerTarget = { x: tx, z: tz };
    this.runnerTimer = R.durationSec;
    // Кулдаун: без него один и тот же нападающий рвал за спину раз в полсекунды.
    // Работоспособность игрока (work) укорачивает или удлиняет паузу
    runner.runCd = CONFIG.ai.attack.offBall.cooldown * runner.mods.runCdK;
    this.bump('run');
  }

  // ОТКРЫВАНИЕ ПОД ПАС, ПОКА КНОПКА ЕЩЁ ЗАЖАТА (правило с 28.07.2026).
  // Просьба Олега про заброс: «чтобы игроки хорошо открывались под него».
  // В FC это отдельная кнопка (Trigger Run на L1/LB), но заводить её некуда и
  // незачем: ЗАМАХ И ЕСТЬ СИГНАЛ НАМЕРЕНИЯ. Человек держит W — тренер заранее
  // отправляет одного партнёра в сектор прицела, и к моменту отпускания кнопки
  // тот уже разогнан. Это ровно тайминг из футбольной методики: бегущий
  // стартует ВО ВРЕМЯ замаха, а не после паса, иначе приезжает на полсекунды
  // позже и упирается в линию.
  //
  // Триггер — БОНУС К ТОЧНОСТИ открывания, а не выключатель: обычные рывки
  // tryStartRun продолжают идти сами по своему таймеру. FC 26 официально шёл
  // ровно в эту сторону — «increased attacking runs to reduce reliance on
  // triggered runs»: если без кнопки никто не бежит, атака ощущается мёртвой.
  armSpaceRun(passer, aim, charge01) {
    const R = CONFIG.ai.attack.runs;
    if (!passer || passer.isKeeper) return;
    if (charge01 < R.armFrom) return;          // тап — это накат, рывок ни к чему
    if (this._armCd > 0 || this.runner) return;
    const F = CONFIG.field;
    const pp = passer.group.position;
    const ax = aim ? aim.x : this.side;
    const az = aim ? aim.z : 0;
    const al = Math.hypot(ax, az) || 1;
    let best = null;
    let bestScore = -Infinity;
    for (const p of this.players) {
      if (p === passer || p.isKeeper || p === this.match.controlled) continue;
      if (p.downT > 0 || p.tackleT > 0) continue;
      const mp = p.group.position;
      const d = Math.hypot(mp.x - pp.x, mp.z - pp.z);
      if (d < 6 || d > R.maxDist) continue;
      const cos = ((mp.x - pp.x) * ax / al + (mp.z - pp.z) * az / al) / d;
      if (cos < R.armCone) continue;
      // Ценим направление по прицелу и свободу зоны ЗА игроком — туда он и побежит
      const tx0 = mp.x + this.side * R.behindLine;
      const score = cos * 10 + freeSpace(tx0, mp.z, this.opponents) * 6 - d * 0.05;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (!best) return;
    const rp = best.group.position;
    const oppLine = this.match.otherTeam(this).defLineX;
    let tx = oppLine + this.side * R.behindLine;
    // Рывок обязан быть ВПЕРЁД относительно самого бегущего, иначе «открывание»
    // выродится в бег назад к своим воротам
    if (this.side * (tx - rp.x) < R.armMinGain) tx = rp.x + this.side * R.armMinGain;
    const maxDepth = F.length / 2 - 8; // не в объятия вратарю
    if (this.side * tx > maxDepth) tx = this.side * maxDepth;
    this.runner = best;
    this.runnerTarget = { x: tx, z: Math.max(-20, Math.min(20, rp.z * 0.75)) };
    this.runnerTimer = R.armTtl;
    this._armCd = R.armCd;
  }

  // Пас отдан — пасующий предлагает СТЕНОЧКУ (give-and-go, ресёрч 14):
  // после короткого паса под прессингом рвануть за спину опекуну и получить
  // мяч обратно на ход. Использует общий слот runner — choosePass уже умеет
  // кормить бегущего с приоритетом (passBonus) и упреждением (leadRun),
  // а человеку возврат кладёт пас на ход (W) с обычным ассистом.
  tryFollowRun(passer, passDist) {
    const C = CONFIG.ai.combo.oneTwo;
    if (this.runner || !passer || passer.isKeeper) return;
    // БЮДЖЕТ И КУЛДАУН (31.07.2026). Замер вскрыл, что ВСЕ 79 «рывков» за матч
    // на «Профессионале» — это стеночка, а не забегание за спину: она бралась
    // с каждого короткого паса под прессингом (chance 0.95), занимала ОБЩИЙ
    // слот runner и тем самым глушила tryStartRun начисто. То есть главная
    // атакующая механика игры — рывок за спину линии — не запускалась почти
    // никогда, а вместо неё шёл нескончаемый «отдал и побежал», один каждые
    // 4.5 секунды. Ни то ни другое зритель прочесть не успевал
    if (passer.runCd > 0) return;
    const cfg = this.phaseCfg();
    if (this.runBudget().inSpace >= Math.min(CONFIG.ai.attack.offBall.maxInSpace,
      cfg.maxInSpace)) return;
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
    passer.runCd = CONFIG.ai.attack.offBall.cooldown;
    // Считаем ОТДЕЛЬНО от забегания за спину: пока стеночка бумпила общий
    // счётчик `run`, отчёт показывал «79 рывков за матч» и выглядел здоровым,
    // хотя забеганий за спину среди них не было почти ни одного
    this.bump('oneTwo');
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
    // Ролевой вес забегания И командный fullbackPush — оба сидят в gOverlap.
    // У Бразилии-98 ширину атаки давали ИМЕННО фулбеки (вингеров в схеме нет),
    // у Италии-98 они почти не подключались. При нейтрали множитель ровно 1.0
    const okv = fb.mods.gOverlap;
    if (Math.hypot(fp.x - op.x, fp.z - op.z) > C.triggerDist * okv) return;
    if (this.side * (fp.x - op.x) > 2) return;  // фулбек уже глубже владельца
    // ГЛУБИНА забега ослаблена нарочно. Триггеру множитель идёт целиком (у
    // латераля 3.2 — то есть подключается почти всегда, и это правда про
    // Кафу), а вот глубина при том же множителе давала 48 м и упиралась в
    // кламп: забег переставал быть решением и становился телепортом к лицевой
    const tx = Math.max(-F.length / 2 + 6, Math.min(F.length / 2 - 6,
      op.x + this.side * C.ahead * (1 + (okv - 1) * C.aheadRoleK)));
    // ОВЕРЛАП ИЛИ АНДЕРЛАП — по занятости коридоров (ресёрч 14 §1.4): занята
    // бровка → забегаем ВНУТРЬ, в полупространство; занято полупространство →
    // идём снаружи. Внешнее подключение кончается подачей, внутреннее — УДАРОМ,
    // и именно оно работает против низкого блока
    const wideZ = Math.sign(op.z) * (F.width / 2 - C.wideZ);
    const innerZ = Math.sign(op.z) * C.underlapZ;
    const tz = freeSpace(tx, innerZ, this.opponents) + C.underlapBias >=
      freeSpace(tx, wideZ, this.opponents) ? innerZ : wideZ;
    this.overlapper = fb;
    this.overlapTarget = { x: tx, z: tz };
    this.overlapTimer = C.durationSec;
    // Личный кулдаун ставился в приходе в ноги, ложном рывке и игре третьего,
    // а в подключении фулбека и забеге за спину — НЕТ. Один и тот же крайний
    // защитник мог подключаться подряд весь матч
    fb.runCd = CONFIG.ai.attack.offBall.cooldown * fb.mods.runCdK;
    this.bump('overlap');
  }

  // Высота линии защиты — считается ОТ МЯЧА (ресёрч 09: формула UvA/RoboCup):
  // мяч у чужих ворот — линия у центра, мяч катится к нам — линия отступает,
  // но никогда не прижимается к ленточке (lineMinDepth). Лечит фидбек Олега
  // «защитники жмутся к линии ворот».
  defLineTarget(ball) {
    const D = this.defence;
    const F = CONFIG.field;
    const bp = ball.mesh.position;
    // Продвижение мяча: 0 = у наших ворот, 1 = у чужих
    const ballDepth = this.side * bp.x + F.length / 2;
    const adv = Math.max(0, Math.min(1, ballDepth / F.length));
    // Высота линии — главный командный рычаг стиля. В data/styles.json она
    // задана В МЕТРАХ (26 катеначчо … 40 Голландия-98), чтобы таблицу можно
    // было сверять с ресёрчем напрямую; сюда приходит множителем к mentality.
    // Уровень сложности при этом остаётся единственным писателем самого поля
    let depth = D.lineMinDepth + D.lineRange * adv * D.mentality * this.style.lineK;
    // Линия держится глубже мяча (goal-side) минимум на зазор
    depth = Math.min(depth, ballDepth - D.lineBallGap);
    depth = Math.max(D.lineMinDepth, Math.min(F.length / 2 + 8, depth));
    return this.ownGoalX + this.side * depth;
  }

  // Страхующий (cover): второй по близости к мячу полевой — встаёт за спиной
  // прессингующего под углом к центру, ловит обыгрыш и прострел
  pickCoverer(ball) {
    const D = this.defence;
    let best = null;
    let bestD = Infinity;
    for (const p of this.fieldPlayers) {
      if (p === this.match.controlled || p === this.chaser) continue;
      // Роль входит в стоимость: раньше страхующим становился просто второй по
      // близости к мячу, то есть регулярно НАПАДАЮЩИЙ — он уезжал за спину
      // прессингующему, и при отборе впереди не оставалось никого, кому отдать
      const d = distToBall(p, ball) +
        CONFIG.formation.roles[p.homeIdx].defOff * D.coverRoleK;
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
    const D = this.defence;
    const F = CONFIG.field;
    // Прежний разбор снимаем ДО очистки: при досрочном выходе (мы в атаке, мяч
    // ещё далеко) карта обязана обнулиться вместе с самой опекой, иначе через
    // минуту защитник получит фору за подопечного из прошлого эпизода
    this._markPrev = new Map(this.marks);
    this.marks.clear();
    if (this.attacking) { this._markPrev.clear(); return; }
    const bp = ball.mesh.position;
    const ballDepth = this.side * bp.x + F.length / 2;
    // Командный press: где вообще начинается персональный разбор. Уровень
    // сложности перекрывает само поле (35/42/50 м), стиль множит поверх
    if (ballDepth > D.markThird * this.style.pressK) return;

    const gx = this.ownGoalX;
    const threats = this.opponents
      .filter((o) => !o.isKeeper && this.side * o.group.position.x < 2)
      .sort((a, b) =>
        Math.hypot(a.group.position.x - gx, a.group.position.z) -
        Math.hypot(b.group.position.x - gx, b.group.position.z));
    // Защитники (индексы 1–4), не занятые прессингом/страховкой/человеком
    const free = this.players.slice(1, 5).filter((p) =>
      p !== this.chaser && p !== this.coverer && p !== this.match.controlled);
    // ГИСТЕРЕЗИС ОПЕКИ (31.07.2026). Карта разбора пересобиралась С НУЛЯ на
    // каждом такте тренера (4–6 раз в секунду), и два защитника с почти равной
    // дистанцией до соперника менялись подопечными столько же раз в секунду.
    // На экране это читается как «оборона суетится»: фигуры дёргаются между
    // двумя целями, ни одна из них по-настоящему не закрыта. Приём тот же, что
    // уже написан ниже в trackRunners: прежнему опекуну даётся фора в метрах.
    // Заводить таймер не нужно — фора в дистанции сама по себе делает смену
    // подопечного событием, а не дрожанием
    const prev = this._markPrev;
    for (const t of threats) {
      if (!free.length) break;
      const tp = t.group.position;
      let bi = 0;
      let bd = Infinity;
      free.forEach((d, i) => {
        const dp = d.group.position;
        let dd = Math.hypot(dp.x - tp.x, dp.z - tp.z);
        if (prev.get(d) === t) dd -= D.markHold;
        if (dd < bd) {
          bd = dd;
          bi = i;
        }
      });
      this.marks.set(free[bi], t);
      free.splice(bi, 1);
    }
  }

  // ТРЕКИНГ ЗАБЕГАЮЩИХ (ресёрч 09). Персональный разбор (updateMarks) включался
  // только когда мяч уже ближе markThird к нашим воротам и разбирал БЛИЖНИХ К
  // ВОРОТАМ соперников. Игрока, который в этот момент спринтует из середины
  // поля за спину линии, не брал никто: он далеко от ворот — значит в сортировке
  // последний, а мяч ещё дальше порога, значит функция вообще не работала.
  // Ровно поэтому поднятая линия обороны без этого прохода = тир.
  // Пишем в ту же карту marks — исполнение в fieldplayer.js не меняется.
  trackRunners() {
    const T = this.defence.track;
    if (this.attacking) return;
    const gx = this.ownGoalX;
    const opp = this.match.otherTeam(this);

    // Угроза — соперник, РЕАЛЬНО сближающийся с нашими воротами, плюс явно
    // назначенные тренером соперника раннер и подключившийся фулбек
    const threats = [];
    for (const o of opp.players) {
      if (o.isKeeper || o.downT > 0) continue;
      if (this.marks.size && [...this.marks.values()].includes(o)) continue;
      const op = o.group.position;
      const dx = gx - op.x;
      const dz = -op.z;
      const l = Math.hypot(dx, dz) || 1;
      if (l > T.range * this.style.pressK) continue;
      const closing = (o.vel.x * dx + o.vel.z * dz) / l;
      if (closing < T.speed && o !== opp.runner && o !== opp.overlapper) continue;
      threats.push({ o, l });
    }
    if (!threats.length) return;
    threats.sort((a, b) => a.l - b.l);

    // Свободные игроки оборонительных линий (форварды назад не возвращаются —
    // они и есть выход из обороны)
    const free = this.players.slice(1).filter((p) =>
      !this.marks.has(p) && p !== this.chaser && p !== this.coverer &&
      p !== this.match.controlled && p.downT <= 0 &&
      CONFIG.formation.roles[p.homeIdx].defOff <= 12);

    const prev = this._trackPrev || new Map();
    const next = new Map();
    for (const t of threats) {
      if (!free.length) break;
      const tp = t.o.group.position;
      let bi = 0;
      let bd = Infinity;
      free.forEach((d, i) => {
        const dp = d.group.position;
        // Фора прежнему опекуну: без гистерезиса защитники меняются
        // подопечными каждые coachTick прямо на бегу
        const cost = Math.hypot(dp.x - tp.x, dp.z - tp.z) -
          (prev.get(d) === t.o ? T.hold : 0);
        if (cost < bd) {
          bd = cost;
          bi = i;
        }
      });
      this.marks.set(free[bi], t.o);
      next.set(free[bi], t.o);
      free.splice(bi, 1);
    }
    this._trackPrev = next;
  }

  // Кто бежит к мячу: ближний полевой игрок. Управляемого человеком не
  // назначаем — за него решает Олег (авто-переключение и так отдаст ему
  // ближнего). Вратарь гонится только по своей логике (goalkeeper.js).
  pickChaser(ball) {
    if (this.match.state === 'restart') return null; // мёртвый мяч не догоняют
    const D = this.defence;
    const bp = ball.mesh.position;
    const gx = this.ownGoalX;
    let best = null;
    let bestCost = Infinity;
    for (const p of this.fieldPlayers) {
      if (p === this.match.controlled) continue;
      const d = distToBall(p, ball);
      // В ОБОРОНЕ роль первого защитника — не «кто ближе», а «кто между мячом и
      // воротами». Раньше обыгранный защитник, бегущий за спиной у владельца,
      // оставался ближайшим и держал роль, а страхующий пассивно стоял позади:
      // страховки при обыгрыше не было вовсе. Плюс гистерезис — два
      // равноудалённых защитника мигали ролью каждый кадр
      // Ролевой press: «выбрасываться на мяч» против «держать позицию».
      // Деление стоит ДО метровых поправок, чтобы штраф и фора остались
      // метрическими. При press 0.5 множитель ровно 1.0 — прежний выбор
      let cost = d - p.mods.bPress;
      if (!this.attacking) {
        const pp = p.group.position;
        const goalSide =
          (gx - bp.x) * (pp.x - bp.x) + (0 - bp.z) * (pp.z - bp.z) > 0;
        if (!goalSide) cost += D.chaseBehindPen;
        if (p === this.chaser) cost -= D.chaseHold;
      }
      if (cost < bestCost) {
        bestCost = cost;
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
    // Сторона держится, пока мяч не ушёл ЗАМЕТНО за ось: прежняя запись
    // переключала цель с −8 на +12 (двадцать метров) каждый раз, как мяч
    // пересекал |z| = 8, а мяч там и живёт большую часть эпизода
    if (Math.abs(bp.z) > 8) this._supportSide = -Math.sign(bp.z);
    else if (Math.abs(bp.z) < 4) this._supportSide = Math.sign(bp.z || 1) * -1;
    const side = this._supportSide || 1;
    const z = side * (Math.abs(bp.z) > 8 ? 8 : 12);
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
      // Ролевая фора «поддержка сзади и рывок вперёд»: у челнока она есть,
      // у столба почти нет — тот ждёт подачу в штрафной, а не открывается
      const d = Math.hypot(spot.x - p.group.position.x, spot.z - p.group.position.z)
        - p.mods.bAhead;
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
      // Сравнивать надо в ОДНОЙ шкале: у кандидата дистанция уже взвешена
      // ролевой форой, значит и у действующего суппорта её надо учесть —
      // иначе гистерезис сравнивал бы метры с метрами минус фора
      const curD = Math.hypot(spot.x - sp.x, spot.z - sp.z) - this.supporter.mods.bAhead;
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
    const D = this.defence;
    const base = CONFIG.formation.roles[p.homeIdx];
    const bp = ball.mesh.position;

    if (p.isKeeper) {
      // Вратарь регионами не живёт — его точку даёт goalkeeper.js;
      // сюда попадает только при расстановке на кикофф
      return { x: this.side * base.x * (F.length / 2), z: 0 };
    }

    // РОЛЬ И СТИЛЬ (ресёрч 21 §8). Это самое заметное с телекамеры ролевое
    // отличие вообще: сдвиг домашней точки на 6–14 м — это 120–280 пикселей,
    // два роста фигуры. При нейтральной роли сдвиги ровно нулевые, а
    // множитель ширины ровно 1.0, то есть выражение остаётся прежним
    const M = p.mods;
    const S = this.style;

    let x;
    let z;
    if (this.attacking) {
      x = this.side * (base.x + AI.attackShift) * (F.length / 2) + bp.x * AI.ballPullX
        + this.side * M.depth;
      // Вингеры держат ширину у бровки и НЕ стягиваются к мячу — растяжка
      // обороны и адресат для перевода на пустой фланг (ресёрч 10 + PES).
      // Плюс они стоят ГЛУБЖЕ остальных: без этого домашняя точка вингера
      // не доходила до зоны подачи, и навешивать он мог, только сам ведя мяч
      if (base.id === 'LM' || base.id === 'RM') {
        x += this.side * CONFIG.ai.attack.wingerPush;
        z = base.z * (F.width / 2) * CONFIG.ai.attack.wingerWide * S.widthK;
      } else {
        z = base.z * (F.width / 2) * CONFIG.ai.attack.homeWide * S.widthK
          + bp.z * AI.ballPullZ;
      }
      // Ролевая ширина — СДВИГ В МЕТРАХ к своей бровке или в полупространство.
      // Именно этим 4-4-2 превращается в 4-2-2-2: «десятки» уходят с бровок в
      // полупространства, а ширину вместо них дают крайние защитники.
      // Сдвинуть игрока НА ЧУЖУЮ сторону поля роль не имеет права — иначе
      // левый инсайд оказался бы правым (проверка ниже)
      if (M.width) {
        const s = Math.sign(base.z) || 1;
        const zw = z + M.width * s;
        z = zw * s < 0 ? 0 : zw;
      }
    } else {
      // Возврат в оборону. Ролевой defOff ПРИБАВЛЯЕТСЯ, а не множится:
      // «поачер не возвращается» означает, что он остаётся ВЫШЕ своей точки в
      // блоке, а множитель при trackBack 0.15 притянул бы его к линии защиты,
      // то есть дал бы ровно обратный смысл
      x = this.defLineX + this.side * (base.defOff + M.defOff);
      // Узость блока — командный рычаг: Франция-98 держала центральный коридор
      // втроём и осознанно оставляла бровки, Голландия-98 перекрывала всю
      // ширину. При compact 1.0 выражение прежнее
      z = base.z * (F.width / 2) * D.zCompact * S.compactK;
      // Четвёрка защитников не разъезжается шире компактного блока
      if (base.defOff === 0) {
        const half = D.defWidth * S.compactK / 2;
        z = Math.max(-half, Math.min(half, z));
      }
      // Блок СПОЛЗАЕТ к мячу заметнее, чем строится атака (своя константа):
      // при мяче у бровки сдвиг 9.5 м вместо 5.5 — так и открывается перевод
      z += bp.z * D.ballShiftZ;
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
    const cfg = this.phaseCfg();   // коэффициенты фазы владения
    // ЛИЧНОСТЬ ПАСУЮЩЕГО и СТИЛЬ КОМАНДЫ — третий и четвёртый слои поверх
    // уровня сложности (он пишет CONFIG) и фазы владения (она множит). При
    // нейтральной роли и нейтральном стиле все четыре величины равны 1.0,
    // то есть формула остаётся прежней бит в бит
    const mods = from.mods || NEUTRAL_MODS;
    const vision = mods.visionK;
    const style = this.style;
    const xtFrom = xThreat(fp.x, fp.z, this.side);
    // Владелец уже в финальной трети — порог риска мягче (см. finalThirdK)
    const inFinalThird = this.side * fp.x > F.length / 2 - 32;

    const options = [];
    for (const mate of this.players) {
      if (mate === from) continue;
      if (mate.downT > 0 || mate.tackleT > 0) continue;
      // Обманщик мяч НЕ просит: получи он пас — и весь смысл ложного рывка
      // (увести опекуна из чужой зоны) исчезает
      if (mate === this.decoy) continue;
      const mp = mate.group.position;
      const straight = Math.hypot(mp.x - fp.x, mp.z - fp.z);
      // ВИДЕНИЕ ПОЛЯ — самая заметная из личных правок. До неё список
      // кандидатов был один на всех, и ДЛИННОГО ПАСА НЕ СУЩЕСТВОВАЛО КАК
      // ЯВЛЕНИЯ: не потому, что он плохо оценивался, а потому что партнёр
      // дальше 36 м не попадал в список вовсе. Диагональ через полполя
      // читается с телекамеры мгновенно
      // ВИДЕНИЕ ПОЛЯ упирается в ФИЗИКУ, и потолок берётся из неё, а не из
      // головы: мяч, пущенный с максимальной силой, прокатится ровно
      // `passSpeedMax / λ` метров, и всё, что дальше, отсеет проверка
      // достижимости ниже. Без этого потолка комментарий «до 54 м» врал бы:
      // разница между зрением 0.65 и 0.95 равнялась бы нулю, а рычаг умел бы
      // только УХУДШАТЬ. Ровно та же грабля, что backMaxLift и missRadius —
      // порог, в который реальное распределение величины не попадает
      if (straight < AI.passMin ||
          straight > Math.min(AI.passMax * vision, AI.passSpeedMax / ROLL_LAMBDA)) continue;

      // Два кандидата на каждого партнёра: «в ноги с упреждением» и «на ход».
      // Пас на ход кладётся ПЕРЕД бегущим (+2 м фикс), иначе мяч приходит
      // в пятки и адресат вынужден тормозить — ровно то, что убивает темп
      const cands = [{ kind: 'feet', lead: 0.8, ahead: 0 }];
      const runSpeed = Math.hypot(mate.vel.x, mate.vel.z);
      if (runSpeed > 1.5 || mate === this.runner || mate === this.overlapper) {
        cands.push({ kind: 'through', lead: 1.5, ahead: 2.0 });
      }
      // ПАС НА ПЕРСПЕКТИВУ. Отличается от `through` не числом, а ПРИРОДОЙ
      // ТОЧКИ: у `through` она выводится из СКОРОСТИ адресата, и у стоящего
      // партнёра вариант вырождается в пас в ноги (ровно это EA и признаёт про
      // свой through ball: «if they remain stationary, these techniques will
      // not work»). Здесь точка берётся из направления АТАКИ и свободного
      // места — то есть мяч можно положить в зону ПЕРВЫМ, а партнёр побежит
      // туда уже под отданный пас. Просьба Олега 28.07.2026: «пасы в прострел
      // и закиды должны работать как пас на перспективу, когда ты
      // догадываешься, что футболист туда забежит, а не когда он уже там».
      // Замер до правки: AI выбирал `through` в 55 % случаев, и средняя
      // дистанция доставки у него была 20.1 м против 19.9 м у паса в ноги —
      // то есть это был один и тот же пас с разными подписями.
      if (this.side * (mate.group.position.x - fp.x) > -4) {
        cands.push({ kind: 'space', lead: 0, ahead: PM.spaceAhead, space: true });
      }

      for (const c of cands) {
        const arrive = c.kind === 'feet' && !underPressure
          ? AI.passArriveNormal : AI.passArriveDriven;
        // Направление выноса. У паса на ход — по бегу адресата; у паса В ЗОНУ —
        // по атаке (бегущему всё равно доверяем его вектор: он уже показал,
        // куда собрался). Иначе точка легла бы за спину бегущему партнёру
        let ux = runSpeed > 0.3 ? mate.vel.x / runSpeed : 0;
        let uz = runSpeed > 0.3 ? mate.vel.z / runSpeed : 0;
        if (c.kind === 'space' && runSpeed <= 1.5) {
          ux = this.side;
          uz = 0;
        }
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
          tx = mp.x + mate.vel.x * flight * c.lead + ux * c.ahead;
          tz = mp.z + mate.vel.z * flight * c.lead + uz * c.ahead;
          dist = Math.hypot(tx - fp.x, tz - fp.z) || 1;
        }
        if (!isFinite(flight)) continue;
        if (Math.abs(tx) > F.length / 2 - 1.5 || Math.abs(tz) > F.width / 2 - 1.5) continue;
        // ДОСТИЖИМОСТЬ ЦЕЛИ ПРОВЕРЯЕТСЯ ЧЕСТНО. Итерация неподвижной точки
        // считает power и flight по дистанции ПРЕДЫДУЩЕГО шага, а `dist`
        // обновляет в самом конце — то есть последняя цель не проверена ничем.
        // Замер на двух матчах: 1.7 % выбранных пасов летели дальше предела
        // v0/λ (медиана недолёта 7.2 м, максимум 23.2), и качество приёма у них
        // выходило МАКСИМАЛЬНЫМ — приходящая скорость считалась нулевой, то
        // есть модель награждала пас, умирающий на полпути
        if (dist > (power / ROLL_LAMBDA) * 0.98) continue;
        // Успеет ли адресат в точку? Для паса в зону это не украшение, а
        // условие: мяч кладётся туда, где партнёра ЕЩЁ НЕТ
        if (c.kind === 'space') {
          const dm2 = Math.hypot(tx - mp.x, tz - mp.z);
          const vMate = CONFIG.player.speed * CONFIG.player.sprintFactor * AI.speedFactor;
          const tMate = PM.spaceReact + dm2 / vMate;
          if (tMate > flight + PM.spaceWait) continue;
        }

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
        // Мяч, положенный ПЕРЕД бегущим, он принимает не теряя скорости — это
        // бонус. А мяч, выкаченный в ПУСТОЕ МЕСТО, адресат догоняет на ходу,
        // часто спиной к воротам и с подтягивающимся защитником — это худший
        // приём, а не лучший (ablation: с бонусом механика стоила +0.75 гола)
        q *= c.kind === 'feet'
          ? (runSpeed > 3 ? PM.qFeetToRunner : 1)
          : (c.kind === 'space' ? PM.qSpace : PM.qRunBonus);

        // ПЕРЕВОД ФЛАНГА — геометрия считается ЗДЕСЬ, потому что она нужна и
        // ценности V (свой пол), и семейству F. Дешёвая проверка стоит первой,
        // дорогая (freeSpace по одиннадцати соперникам) — за ней
        const isSwitchZ = Math.abs(tz - fp.z) > PM.switchMinZ && tz * fp.z < 0 &&
          this.side * (tx - fp.x) > -6;
        const isSwitch = isSwitchZ && freeSpace(tx, tz, opponents) > PM.switchFree;

        // --- V: прирост ценности позиции ---
        const dxt = xThreat(tx, tz, this.side) - xtFrom;
        // Перевод фланга — единственная передача, которой пол ценности МЕШАЕТ:
        // по xT он всегда около нуля (мяч не приблизился к воротам), то есть
        // упирается в valueMin и обнуляет собственный бонус семейства. Смысл
        // перевода не в текущем приросте, а в том, что после него блок не
        // успевает перестроиться — это плата за следующий пас, а не за этот
        const vMin = isSwitchZ ? PM.valueMinSwitch : PM.valueMin;
        // Прямолинейность команды: во сколько дороже продвижение мяча вперёд.
        // Клампы не трогаем — они и есть предохранители
        const v = Math.max(vMin,
          Math.min(PM.valueMax, 1 + PM.valueK * style.directness * dxt));

        // --- F: семейство передачи ---
        let f = PM.fNormal;
        const oppLine = this.match.otherTeam(this).defLineX;
        const behindLine = this.side * (tx - oppLine) > 0;
        // ЗОНА ЗАВЕРШЕНИЯ шире штрафной: трейлер у её линии (16–18 м) — тот,
        // кто замыкает прострел, — иначе выпадал из семейства и получал
        // скромный fProgress вместо fIntoBox/fCutback
        const inFinish = this.side * tx > F.length / 2 - PM.finishZone &&
          Math.abs(tz) < 20.16;
        // ПРОСТРЕЛ: мяч из глубины фланга НАЗАД в зону перед воротами.
        // Второе по опасности действие в футболе после разреза — и главный
        // недостающий инструмент нашей игры (ресёрч 15, раздел 9). Геометрия
        // ослаблена до полуфланга: прежние «угол штрафной» (13 м от лицевой,
        // 13 м от оси) не выполнялись ни разу за матч
        const fromDeepWide = this.side * fp.x > F.length / 2 - 20 && Math.abs(fp.z) > 10;
        const isCutback = fromDeepWide && inFinish &&
          this.side * (fp.x - tx) > 0 && Math.abs(tz) < Math.abs(fp.z) - 4;
        // Перевод стоит В КОНЦЕ лестницы семейств нарочно: он не конкурирует
        // ни с прострелом, ни с разрезом, ни с доставкой в штрафную — если
        // есть хоть одно из них, переводить незачем
        if (isCutback) f = PM.fCutback;
        else if (behindLine && c.kind !== 'feet') f = PM.fThrough;
        else if (inFinish && this.side * (tx - fp.x) > 0) f = PM.fIntoBox;
        else if (isSwitch) f = PM.fSwitch;
        else if (this.side * (tx - fp.x) > 6) f = PM.fProgress;
        if (mate.isKeeper) f *= PM.fKeeper;
        if (mate === this.runner || mate === this.thirdMan) f *= PM.fRunner;
        if (mate === this.overlapper) f *= PM.fOverlap;

        // ФАЗА — МНОЖИТЕЛЬ ПОВЕРХ семейства, а не подмена. Уровень сложности
        // уже задаёт базу (`difficulty.json` перекрывает fThrough/fIntoBox/
        // fCutback), и если бы фаза их ПОДМЕНЯЛА, получилось бы два писателя
        // одного числа — грабля, на которой проект уже обжигался с ползунком
        // помощи и с ручками грейдинга. Так уровень задаёт СИЛУ, фаза — ФОРМУ,
        // и они не дерутся. У PROGRESS все множители 1.0, то есть это точное
        // тождество сегодняшнему поведению
        if (isCutback) f *= cfg.fCutbackK;
        else if (behindLine && c.kind !== 'feet') f *= cfg.fThroughK;
        else if (inFinish) f *= cfg.fIntoBoxK;
        else if (isSwitch) f *= cfg.fSwitchK;
        // Пас НАЗАД — отдельный рычаг фазы. В розыгрыше откат назад это
        // нормальный инструмент (перевести игру, вытянуть блок), а на
        // контратаке он её убивает
        if (this.side * (tx - fp.x) < -3) f *= cfg.fBackK;
        // Личная склонность подающего: вингер любит прострел, разыгрывающий —
        // перевод. Множитель ставится ПОСЛЕ фазы тем же приёмом
        if (isCutback || isSwitch) f *= mods.crossBias;
        // ОСЬ «В ПРОСТРАНСТВО ПРОТИВ В НОГИ» — командный inSpaceBias (CIES,
        // 3 261 матч: 0.61 у Бёрнли … 0.86 у Серкль Брюгге). Одного скаляра
        // хватает, чтобы воспроизвести всю палитру от позиционной игры до
        // непрерывных забросов за спину. При 0.72 оба множителя ровно 1.0
        f *= c.kind === 'feet' ? style.shortK : style.spaceK;

        // Степень при P — это и есть «насколько команда сейчас осторожна».
        // Фаза множит её, стиль команды и смелость самого игрока — тоже:
        // при розыгрыше от своих ворот потеря стоит гола, на контратаке —
        // наоборот, риск и есть смысл момента. Уровень сложности при этом
        // остаётся единственным писателем самого PM.safety
        let score = Math.pow(p, PM.safety * cfg.safetyK * style.patience * mods.riskK)
          * q * v * f;
        // ИНЕРЦИЯ АДРЕСАТА (31.07.2026). Softmax честно отдаёт лучшему варианту
        // около двух третей случаев — но два-три близких по счёту адресата на
        // пяти тактах подряд дают почти гарантированную чехарду: «смотрю на
        // левого — на правого — снова на левого». Прежде выбранному партнёру
        // даётся фора в счёте, и решение живёт, пока не появится ЗАМЕТНО
        // лучшее. Тот же приём уже применён к догоняющему (chaseHold), к
        // поддерживающему (switchHysteresis), к точкам в штрафной (stickBonus)
        // и к трекингу забегающих (track.hold) — у владельца мяча его не было
        const it = from.ai && from.ai.intent;
        if (it && it.t > 0 && it.mate === mate && it.kind === c.kind) {
          score *= 1 + AI.intentInertia;
        }
        options.push({
          score,
          mate,
          target: { x: tx, z: tz },
          dir: { x: nx, z: nz },
          power,
          lift: dist > AI.longPassDist ? AI.longPassLift : 0.4,
          kind: c.kind,
          flight,           // нужно поиску цепочек: на столько экстраполируем поле
          space: !!c.space, // адресат побежит в ТОЧКУ, а не за мячом
        });
      }
    }

    // Лучший счёт запоминаем ДО отсева и софтмакса: им пользуются
    // tryComingShort («есть ли надёжная опция») и aiCross («стоит ли навес
    // дороже передачи»). Раньше они спрашивали choosePass повторно и
    // сравнивали с порогом СЛУЧАЙНО вытянутый софтмаксом вариант
    this._passBest = 0;
    for (const o of options) this._passBest = Math.max(this._passBest, o.score);

    // ПОИСК ЦЕПОЧЕК ДЕЙСТВИЙ (Action Chain, ресёрч 21 §6.1 и §6.7). Главная
    // находка разбора чужих движков: у agent2d/HELIOS сила не в оценке одного
    // действия, а в ГОРИЗОНТЕ — он считает, что будет ПОСЛЕ передачи. У нас
    // формула S правильная и отлаженная, ей не хватало ровно этого.
    // Глубина 2 и никакой рекурсии: для лучших кандидатов смотрим, насколько
    // опасным окажется СЛЕДУЮЩЕЕ действие адресата. Побочный эффект — ровно
    // тот, что нужен: игрок начинает отдавать «пас под пас», а это и есть
    // комбинация. Считается ПОСЛЕ _passBest нарочно: пороги навеса, финта и
    // прихода в ноги калиброваны по старой шкале, и сдвигать её нельзя
    if (PM.chainWeight > 0 && options.length > 1) {
      options.sort((a, b) => b.score - a.score);
      const wasTop = options[0];
      const top = Math.min(options.length, PM.chainTop);
      for (let i = 0; i < top; i++) {
        const o = options[i];
        o.score *= 1 + PM.chainWeight * this.nextValue(o, from);
      }
      // Механику надо мерить ПРЯМО: сколько раз горизонт РЕАЛЬНО поменял
      // лучшего кандидата. Без этого счётчика «пас под пас» остаётся словами —
      // косвенные метрики (точность, длина серии) его не различают
      let nowTop = options[0];
      for (let i = 1; i < top; i++) if (options[i].score > nowTop.score) nowTop = options[i];
      if (nowTop !== wasTop) this.bump('chain');
    }

    if (!options.length) return null;
    const minScore = PM.minScore * (underPressure ? PM.pressScoreK : 1) *
      (inFinalThird ? PM.finalThirdK : 1) * cfg.minScoreK * style.patience * mods.riskK;
    const live = options.filter((o) => o.score >= minScore);
    if (!live.length) return null;

    // Softmax по S: лучший вариант выигрывает примерно в 2/3 случаев,
    // остальное достаётся близким по ценности — игра перестаёт быть роботом
    let top = -Infinity;
    for (const o of live) top = Math.max(top, o.score);
    let sum = 0;
    // Температура тоже от фазы: при розыгрыше выбор почти детерминирован
    // (безопасный пас один и тот же), в завершении наоборот шире — там
    // предсказуемость наказывается сразу
    const temp = PM.temperature * cfg.tempK;
    for (const o of live) {
      o._w = Math.exp((o.score - top) / temp);
      sum += o._w;
    }
    let r = Math.random() * sum;
    let picked = live[live.length - 1];
    for (const o of live) {
      r -= o._w;
      if (r <= 0) { picked = o; break; }
    }
    // Запоминаем намерение: следующий такт даст этому адресату фору. Пишем
    // ТОЛЬКО для AI-веток — у человека адресата выбирает он сам
    if (from.ai) from.ai.intent = { mate: picked.mate, kind: picked.kind, t: AI.intentCommit };
    return picked;
  }

  // ЦЕННОСТЬ СЛЕДУЮЩЕГО ДЕЙСТВИЯ (второй уровень цепочки). Возвращает 0…1:
  // насколько опасным окажется положение, когда мяч дойдёт до адресата.
  // Считается ДЁШЕВО и без рекурсии — только два вида продолжения:
  //   1) удар с точки приёма (его ценность и есть xT этой точки),
  //   2) лучшая следующая передача — партнёр, экстраполированный на время
  //      полёта, взвешенный свободой его зоны.
  // Поле экстраполируется линейно: за 0.4–1.2 с полёта мяча этого достаточно,
  // а честная мини-симуляция стоила бы вдвое дороже всей функции выбора паса.
  nextValue(o, from) {
    const AI = CONFIG.ai;
    const tx = o.target.x;
    const tz = o.target.z;
    const t = o.flight || 0;
    const opponents = this.opponents;
    // Удар с точки приёма: ценность позиции, если оттуда вообще бьют
    const dGoal = Math.hypot(this.attackGoalX - tx, tz);
    let best = dGoal < AI.shootRange ? xThreat(tx, tz, this.side) : 0;
    // Лучшее продолжение передачей.
    // ПАСУЮЩИЙ ИЗ КАНДИДАТОВ ИСКЛЮЧЁН (31.07.2026). Возврат мяча САМОМУ СЕБЕ —
    // это откат, а не прогресс атаки, и засчитывать его горизонту нельзя.
    // Разбор жалобы «вышел один на один и отдал назад» поймал это в самом
    // остром виде: у передачи назад лучшим продолжением оказывался ровно тот
    // игрок, который на выходе и был (его xT самый высокий на поле), горизонт
    // добавлял ей +8.6 %, и на «Новичке» этого хватало, чтобы перевести пас
    // назад через порог отсева — 0.382 против порога 0.385 без горизонта и
    // 0.415 с ним. То есть механика «пас под пас» работала как «отдай назад,
    // потом тебе вернут»
    for (const m of this.players) {
      if (m === o.mate || m === from || m.isKeeper) continue;
      const mp = m.group.position;
      const px = mp.x + m.vel.x * t;
      const pz = mp.z + m.vel.z * t;
      const d = Math.hypot(px - tx, pz - tz);
      if (d < AI.passMin || d > AI.passMax) continue;
      const val = xThreat(px, pz, this.side) * freeSpace(px, pz, opponents);
      if (val > best) best = val;
    }
    return Math.max(0, Math.min(1, best));
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
      // ПОСЛЕДНИЙ МЕТР ПРИНАДЛЕЖИТ АДРЕСАТУ. Персональный опекун стоит
      // goal-side, то есть ЗА адресатом; раньше он попадал в окно проверки,
      // получал зажатую координату a = D и «время добегания ноль» — модель
      // выдавала 69% перехвата на мяч, который придёт к адресату РАНЬШЕ.
      // Это и был главный кран воронки: пас в штрафную отвергался всегда
      if (a > D - PM.receiverOwn) continue;
      if (b < PM.onLine) return 0;                 // физически стоит на линии
      near.push({ a, b });
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
    this.receiveSpace = !!pass.space;
    this.receiveTarget = pass.target;
    this.receiveTimer = CONFIG.ai.receiveGiveUp;
    this.bump('pass');
    // Ждём, кто первым тронет мяч: он и решит судьбу передачи
    if (from) this._passWait = { mate: pass.mate, from, t: CONFIG.ai.receiveGiveUp };
    // Передача в серии + перевод фланга. Перевод считаем ПО ЗАМЫСЛУ, а не по
    // факту приёма: важно, сколько раз команда решила сменить фланг
    this.seqPasses++;
    this.bump('seqPass');
    if (from) {
      const fz = from.group.position.z;
      const dz = Math.abs(pass.target.z - fz);
      if (dz > CONFIG.ai.passModel.switchMinZ && pass.target.z * fz < 0) {
        this.bump('switchPass');
      }
    }
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
      const dist = Math.hypot(pass.target.x - fp.x, pass.target.z - fp.z);
      this.tryFollowRun(from, dist);
      // Пас в ноги под опекой — заготовка «игры третьего»: мяч пойдёт дальше,
      // а не назад пасующему (стеночку взводит tryFollowRun выше)
      if (pass.kind === 'feet') this.armThirdMan(from, pass.mate, dist);
    }
  }
}
