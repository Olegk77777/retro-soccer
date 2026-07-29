// Слой «голова» полевого игрока (стейт-машина по Бакленду, упрощённая):
// с мячом — веду/пасую/бью; назначен на приём — бегу к точке паса;
// назначен догоняющим — преследую мяч; назначен в поддержку — открываюсь;
// иначе — возвращаюсь в домашний регион и смотрю на мяч.
// Решения — здесь, само движение исполняет player.aiUpdate («ноги»).

import { CONFIG } from '../config.js';
import { arrive, seek, pursuitBall, separation, distToBall, freeSpace, predictLanding, passStrikeKind } from './steering.js';

// Приёмник точки встречи (Player.meetPoint) — один на всех, чтобы не сорить
// объектами в кадре: игрок в этой ветке ровно один за проход
const _meet = { x: 0, z: 0 };

export function updateFieldPlayer(p, dt, ball) {
  const AI = CONFIG.ai;
  const team = p.team;
  const match = team.match;
  const pos = p.group.position;
  if (!p.ai) p.ai = { decideCd: 0, dribDir: null };
  if (p.ai.decideCd > 0) p.ai.decideCd -= dt;

  const bp = ball.mesh.position;
  const myBallDist = distToBall(p, ball);
  const mateHasBall = match.toucher && match.toucher.team === team && match.toucher !== p;

  let move = { x: 0, z: 0 };
  let sprint = false;
  let face = null;
  let speedCap = null;

  // Розыгрыш с центра: AI замирает по местам лицом к мячу — мяч трогает
  // только разыгрывающий (человек или скриптовый пас тренера в match.js)
  if (match.state === 'kickoff') {
    p.ai.dribDir = null;
    p.aiUpdate(dt, { x: 0, z: 0 }, { face: Math.atan2(bp.x - pos.x, bp.z - pos.z) });
    return;
  }

  // Замыкание в одно касание уже идёт (замах): новых решений не принимаем,
  // но и НЕ ЗАМИРАЕМ — ноги добегают до точки контакта. Стойка на месте гасила
  // врывание (в PES мощь кивка даёт именно разбег) и выглядела как ступор
  // посреди эпизода (фидбек Олега 24.07)
  // Вплотную к точке ноги переходят на ДОБОР КУРСА, а не на стоп: замыкание —
  // встреча на ходу (Player.strikeApproach, тот же код, что у человека). Раньше
  // здесь стояло жёсткое обнуление внутри strikeHoldRadius, и AI в замахе
  // вкапывался столбом — то есть ровно те 22 фигуры, на которые смотрит зритель
  if (p.aerialStrike) {
    const as = p.aerialStrike;
    const ap = as.point;
    // Темп подхода — от оставшегося до встречи времени: успеваю с запасом,
    // значит иду шагом и прихожу ровно к мячу, а не проскакиваю точку
    p.aiUpdate(dt, ap ? p.strikeApproach(ap.x, ap.z, as.hitAt - as.t) : { x: 0, z: 0 }, {});
    return;
  }

  // Лежим после броска — только встаём, никаких решений
  if (p.downT > 0) {
    p.aiUpdate(dt, { x: 0, z: 0 }, {});
    return;
  }

  // В подкате: скольжение и контакты считает updateTackle, руль отключён
  if (p.tackleT > 0) {
    p.updateTackle(dt, ball);
    p.aiUpdate(dt, { x: 0, z: 0 }, {});
    return;
  }

  // Стандарт (аут/угловой/от ворот): мяч мёртв. Соперники не давят точку —
  // держат дистанцию (дух правила 9,15 м); расстановка обеих команд дальше
  // живёт обычной логикой регионов, исполнителя ведёт Match
  if (match.state === 'restart' && match.restart) {
    const r = match.restart;
    if (p.team !== r.team) {
      const ddx = pos.x - r.x;
      const ddz = pos.z - r.z;
      const dd = Math.hypot(ddx, ddz) || 1;
      if (dd < CONFIG.restart.keepAway) {
        p.aiUpdate(dt, { x: ddx / dd, z: ddz / dd },
          { face: Math.atan2(r.x - pos.x, r.z - pos.z) });
        return;
      }
    }
  }

  // Вратарь соперника держит мяч в руках: не мешаем вводу (правило + фикс
  // рикошета вратарского выброса от прилипшего соперника в свои ворота,
  // фидбек Олега 22.07). Отходим на keeper.oppKeepAway и ждём ввода —
  // как только вратарь выбросил/выбил, обычная логика возобновится.
  const oppKeeper = match.toucher;
  if (oppKeeper && oppKeeper.isKeeper && oppKeeper !== p &&
      oppKeeper.ai && oppKeeper.ai.holding && oppKeeper.team !== team) {
    const kp = oppKeeper.group.position;
    const dxk = pos.x - kp.x;
    const dzk = pos.z - kp.z;
    const dk = Math.hypot(dxk, dzk) || 1;
    const KA = CONFIG.ai.keeper.oppKeepAway;
    let mv;
    if (dk < KA) {
      mv = { x: dxk / dk, z: dzk / dk }; // отступаем от вратаря
    } else {
      const home = team.homeTarget(p, ball); // ждём ввода на своей позиции
      mv = arrive(pos.x, pos.z, home.x, home.z, AI.homeSlow);
    }
    const sepK = separation(p, match.allPlayers, AI.separationRadius, AI.separationPush);
    p.aiUpdate(dt, { x: mv.x + sepK.x, z: mv.z + sepK.z },
      { face: Math.atan2(kp.x - pos.x, kp.z - pos.z) });
    return;
  }

  // Второй этаж (ресёрч 11): верховой мяч в досягаемости — играем В ОДНО
  // КАСАНИЕ. Своя треть — вынос; у чужих ворот — замыкание в створ (сила
  // от разбега!); середина — скидка вперёд. Летящий вверх мяч не трогаем.
  // В броске (ласточка) зона контакта — вытянутый корпус (dive.stretch)
  const AP = CONFIG.player.aerial;
  const diving = p.diveT > 0;
  // Замах начинается с той же дистанции, что у человека (prepareRadius), и по
  // ПРОГНОЗНОЙ высоте контакта. На прежних 1.5 м AI решался, когда мяч уже был
  // на ноге: замах не успевал прочитаться, а ноги не успевали встать под удар
  // Адресат нашей верховой передачи ПРИНИМАЕТ мяч, а не бьёт по нему: он
  // ждёт настоящего касания корпусом и до этого продолжает бежать к точке
  const isTrapper = !diving && team.receiver === p &&
    Math.hypot(team.attackGoalX - pos.x, pos.z) >= AI.aerial.headerRange;
  const aerialOk = diving
    ? (myBallDist < AP.reach + AP.dive.stretch &&
        bp.y >= AP.dive.minY && bp.y <= AP.dive.maxY)
    : isTrapper
      ? p.bodyContactPoint(bp).reachable
      : (myBallDist < AP.prepareRadius &&
        (() => {
          // Замах только если прогноз нашёл НАСТОЯЩИЙ контакт: мяч действительно
          // придёт на бутсу/лоб. Без этой проверки AI начинал замах под любой
          // пролетающий мимо мяч и молотил воздух (замер симуляцией матча)
          const pre = p.predictAerialContact(ball, AP.readHorizon);
          return pre.y > CONFIG.player.kickMaxBallY && pre.y <= AP.maxY &&
            pre.dist <= AP.sync.hitRadius * 1.5;
        })());
  if (p.kickCooldown <= 0 && aerialOk && match.state !== 'restart' && ball.vel.y < 2 &&
      // Полная скорость: крутая перекидка почти без горизонтали, но падает
      // быстро — иначе адресат не принимал её и мяч «отскакивал» мимо ног
      ball.vel.length() > 4) {
    aerialPlay(p, ball, diving);
    // Замах создан — ноги в тот же кадр идут к его точке, а не встают. Стоячее
    // замыкание в PES слабее и шумнее по построению (aerial.standNoise), и
    // терять разбег на ровном месте нельзя
    const as0 = p.aerialStrike;
    const ap0 = as0 && as0.point;
    p.aiUpdate(dt, ap0 ? p.strikeApproach(ap0.x, ap0.z, as0.hitAt - as0.t) : { x: 0, z: 0 }, {});
    return;
  }
  // Бросок в падении (как у человека): назначенный замыкающий у чужих
  // ворот не успевает на ноги, мяч пролетает мимо — ласточка
  if (!diving && p.kickCooldown <= 0 && team.receiver === p &&
      bp.y >= AP.dive.minY && bp.y <= AP.dive.maxY &&
      myBallDist >= AP.reach && myBallDist < AP.dive.reach &&
      Math.hypot(team.attackGoalX - pos.x, pos.z) < AI.aerial.headerRange + 4) {
    const sp2 = ball.vel.x * ball.vel.x + ball.vel.z * ball.vel.z;
    if (sp2 > 9) {
      const relX = bp.x - pos.x;
      const relZ = bp.z - pos.z;
      const tCa = Math.max(0, -(relX * ball.vel.x + relZ * ball.vel.z) / sp2);
      const closest = Math.hypot(relX + ball.vel.x * tCa, relZ + ball.vel.z * tCa);
      if (closest > AP.reach * 0.75) {
        p.startDive(relX / myBallDist, relZ / myBallDist, bp.y);
      }
    }
  }

  // Прострел/скидка пришла назначенному под подачу у чужих ворот — замыкание
  // НОГОЙ в ОДНО касание, без такта решений: низовые подачи завершаются
  // ударом с ходу, а не «отскакивают от деревянного» (фидбек Олега 22.07)
  const FT = AI.firstTouch;
  if (team.receiver === p && p.kickCooldown <= 0 && match.state !== 'restart' &&
      myBallDist < CONFIG.player.kickRadius && bp.y < CONFIG.player.kickMaxBallY) {
    const relV = Math.hypot(ball.vel.x - p.vel.x, ball.vel.z - p.vel.z);
    const dg = Math.hypot(team.attackGoalX - pos.x, pos.z);
    if (relV > FT.minRel && dg < FT.shotRange && Math.abs(pos.z) < AI.shootMaxZ) {
      aiShoot(p, ball, team.attackGoalX, dg);
      p.aiUpdate(dt, { x: 0, z: 0 }, {});
      return;
    }
  }

  // Пас уже летит нашему адресату — остальные НЕ бросаются на мяч толпой:
  // доверяем передаче (принцип PES), эпизод у мяча остаётся за receiver'ом.
  // Соперники не в счёт — у них свой receiver (null) и погоня за перехватом
  const passEnRoute = team.receiver && team.receiver !== p &&
    team.receiveTimer > 0.3 &&
    Math.hypot(ball.vel.x, ball.vel.z) > 3 &&
    (ball.vel.x * (team.receiver.group.position.x - bp.x) +
     ball.vel.z * (team.receiver.group.position.z - bp.z)) > 0;

  if (p.isToucher) {
    move = withBall(p, ball);
    sprint = (p.ai.dribFree || 0) > AI.dribbleSprintFree;
  } else {
    p.ai.dribDir = null;
    if (team.receiver === p && team.receiveTarget) {
      // Приём паса: бегу к точке адреса, у самой точки — навстречу мячу.
      // Верховой мяч (навес) — строго к точке прилёта: врывание на прилёт,
      // погоня за тенью мяча увела бы с траектории.
      // У точки — arrive вместо seek и стойка лицом к мячу: seek без радиуса
      // прибытия дрожал на месте (фидбек Олега 22.07 «адресат дёргается»)
      // Точка прилёта ПЕРЕСЧИТЫВАЕТСЯ каждый кадр, пока мяч в воздухе: за
      // время полёта drag и Магнус сдвигают её на метры, а приём теперь
      // требует настоящего касания корпусом — стоять «примерно там» мало
      // (замер 24.07: мяч проходил в метре от ждущего, и приёма не было)
      let t = team.receiveTarget;
      let airLeft = 0;
      if (bp.y > CONFIG.player.kickMaxBallY && ball.vel.y < 3) {
        const land = predictLanding(ball, CONFIG.player.aerial.contactY);
        if (land) { t = land; airLeft = land.t || 0; }
      }
      const dT = Math.hypot(t.x - pos.x, t.z - pos.z);
      // ТАЙМИНГ ЗАБЕГА (правка 29.07.2026). Раньше адресат летел к точке прилёта
      // на полной, приезжал за секунду до мяча и вставал — 52 % замыканий
      // исполнялись «стоя» (замер, aerial-rig → contactStats). Пока времени в
      // запасе много, целимся в ОТСТУП от точки по своему же курсу; отступ тает
      // вместе с оставшимся временем, и на мяч игрок приходит НА ХОДУ.
      if (airLeft > 0) t = p.meetPoint(_meet, t.x, t.z, airLeft);
      // Погоня за мячом — только когда мяч УЖЕ НИЗОМ. Пока он в воздухе, ноги
      // стоят на точке прилёта: прежний порог 1.2 м срывал адресата с места
      // ровно на последних метрах (pursuit целится с упреждением ВПЕРЁД мяча),
      // и опускающийся мяч проходил у него за спиной
      // ПАС В ЗОНУ ДЕРЖИТ АДРЕСАТА НА ТОЧКЕ ДОЛЬШЕ. Мяч там идёт низом с самого
      // начала, и обычное правило «ближе 6 м — гонись за мячом» срывало бегущего
      // с линии на полпути: pursuit целится с упреждением ВПЕРЁД мяча, то есть
      // уводит наперерез — а мяч и так едет в ту самую точку, в которую бежит
      // адресат. Переключаемся на погоню, только когда мяч уже почти на месте
      const ballToT = Math.hypot(t.x - bp.x, t.z - bp.z);
      const holdLine = team.receiveSpace && ballToT > 2.5;
      if (myBallDist < 6 && bp.y < CONFIG.player.kickMaxBallY && !holdLine) {
        move = pursuitBall(pos.x, pos.z, ball, CONFIG.player.speed);
      } else {
        move = arrive(pos.x, pos.z, t.x, t.z, 1.6);
        if (dT < 0.5) face = Math.atan2(bp.x - pos.x, bp.z - pos.z);
      }
      sprint = myBallDist > AI.sprintDist || (bp.y > 1.2 && dT > 2) ||
        (holdLine && dT > 1.5);
    } else if (team.chaser === p && !mateHasBall && !passEnRoute) {
      // Первый защитник (pressure): свободный мяч догоняем, владеющего
      // соперника прессингуем по-PES — агрессивно в чужой половине,
      // сдерживанием (jockey) в своей
      const r = pressBall(p, dt, ball, match);
      move = r.move;
      sprint = r.sprint;
      face = r.face;
      speedCap = r.speedCap;
    } else if (team.shortRunner === p && team.shortTarget) {
      // Приход в ноги: показаться накоротке владельцу под прессингом.
      // Спринтом и лицом к мячу — иначе пас придёт в спину и его не примут
      const t = team.shortTarget;
      move = arrive(pos.x, pos.z, t.x, t.z, 1.5);
      sprint = Math.hypot(t.x - pos.x, t.z - pos.z) > 2;
      if (!sprint) face = Math.atan2(bp.x - pos.x, bp.z - pos.z);
    } else if (team.thirdMan === p && team.thirdManTarget) {
      // Игра третьего: рывок стартовал по первому касанию партнёра — бежим
      // за спину его опекуну, туда, куда пасующий даже не смотрел
      move = seek(pos.x, pos.z, team.thirdManTarget.x, team.thirdManTarget.z);
      sprint = true;
    } else if (team.decoy === p && team.decoyTarget) {
      // Ложный рывок: уводим своего опекуна прочь из канала настоящего
      // раннера. Мяча не просим — его нам и не дадут (choosePass пропускает)
      move = seek(pos.x, pos.z, team.decoyTarget.x, team.decoyTarget.z);
      sprint = true;
    } else if (team.runner === p && team.runnerTarget) {
      // Забегание за спину: спринт в зону за линией защиты — владелец
      // увидит рывок и положит мяч на ход (приоритет в choosePass).
      // Сюда же попадает стеночка: пасующий рвёт вперёд за возвратом
      move = seek(pos.x, pos.z, team.runnerTarget.x, team.runnerTarget.z);
      sprint = true;
    } else if (team.overlapper === p && team.overlapTarget) {
      // Подключение по бровке (overlap): фулбек спринтует снаружи за линию
      // мяча — растяжка обороны, адресат для паса в коридор (ресёрч 14)
      move = seek(pos.x, pos.z, team.overlapTarget.x, team.overlapTarget.z);
      sprint = true;
    } else if (team.boxRuns.get(p)) {
      // Врывание в штрафную под навес: рывком на штангу / 11 метров
      const t = team.boxRuns.get(p);
      move = arrive(pos.x, pos.z, t.x, t.z, 2);
      sprint = Math.hypot(t.x - pos.x, t.z - pos.z) > 3;
    } else if (team.coverer === p && !team.attacking && match.toucher && match.toucher.team !== team) {
      // Второй защитник (cover): за спиной прессингующего, под углом
      // к центру — ловит обыгрыш и закрывает прострел (ресёрч 09 + PES sweeper)
      const D = AI.defence;
      const gx = team.ownGoalX;
      const F = CONFIG.field;
      let tx;
      let tz;
      // ЭКРАН ПЕРЕД ВОРОТАМИ. Обычная точка страхующего считается ОТ МЯЧА и
      // вместе с ним уезжает в глубину фланга — зона 11 метров пустела ровно
      // тогда, когда туда идёт прострел (а прострел даёт 6.4 гола на 100
      // против 2.5 у навеса). Мяч в нашей трети и широко — держим зону, а не
      // бежим за мячом
      const ballDepth = team.side * bp.x + F.length / 2;
      if (ballDepth < D.screen.depth && Math.abs(bp.z) > D.screen.wideZ) {
        tx = gx + team.side * D.screen.x;
        tz = bp.z * 0.25;
      } else {
        const dgx = gx - bp.x;
        const dgz = -bp.z;
        const dgl = Math.hypot(dgx, dgz) || 1;
        tx = bp.x + (dgx / dgl) * D.coverDist;
        tz = bp.z + (dgz / dgl) * D.coverDist - Math.sign(bp.z || 1) * D.coverSide;
      }
      move = arrive(pos.x, pos.z, tx, tz, 2.5);
      sprint = Math.hypot(tx - pos.x, tz - pos.z) > 8;
      face = Math.atan2(bp.x - pos.x, bp.z - pos.z);
    } else if (team.marks.get(p)) {
      // Персональный разбор в своей трети: встать goal-side — между
      // подопечным и воротами, чуть в сторону мяча (успеть на прострел)
      const D = AI.defence;
      const mp = team.marks.get(p).group.position;
      const gx = team.ownGoalX;
      let dx = gx - mp.x;
      let dz = -mp.z;
      const dl = Math.hypot(dx, dz) || 1;
      let tx = mp.x + (dx / dl) * D.markDist;
      let tz = mp.z + (dz / dl) * D.markDist;
      const bx = bp.x - mp.x;
      const bz = bp.z - mp.z;
      const bl = Math.hypot(bx, bz) || 1;
      tx += (bx / bl) * D.markBallSide;
      tz += (bz / bl) * D.markBallSide;
      move = arrive(pos.x, pos.z, tx, tz, 2);
      sprint = Math.hypot(tx - pos.x, tz - pos.z) > 8;
      if (!sprint) face = Math.atan2(bp.x - pos.x, bp.z - pos.z);
    } else if (team.supporter === p) {
      const spot = team.supportSpot(ball);
      move = arrive(pos.x, pos.z, spot.x, spot.z, AI.homeSlow);
    } else {
      const home = team.homeTarget(p, ball);
      move = arrive(pos.x, pos.z, home.x, home.z, AI.homeSlow);
      if (AI.waitFaceBall && Math.hypot(move.x, move.z) < 0.2) {
        face = Math.atan2(bp.x - pos.x, bp.z - pos.z); // стоя дома — лицом к мячу
      }
    }
  }

  // Расталкивание со всеми игроками: у мяча не вырастает куча-мала.
  // Владельцу — вполсилы: в толчее штрафной боковой пинок съедал долю его
  // вектора вперёд и буквально выталкивал его из зоны удара
  const sep = separation(p, match.allPlayers, AI.separationRadius,
    p.isToucher ? AI.separationPush * 0.4 : AI.separationPush);
  move = { x: move.x + sep.x, z: move.z + sep.z };

  p.aiUpdate(dt, move, { sprint, face, speedCap });

  // Ведение: контроль мяча у ноги в сторону текущего курса
  if (p.isToucher && p.ai.dribDir) {
    p.aiDribble(dt, ball, p.ai.dribDir.x, p.ai.dribDir.z);
  }
}

// Первый защитник у мяча (ресёрч 09 + гайд PES 5: «closing down, standing
// off, goal-side»): свободный мяч — погоня; владеющий соперник в чужой
// половине — агрессивный прессинг на курс дриблинга; в своей — сдерживание
// (jockey): блок-точка между владельцем и воротами, скорость зеркалит
// владельца, не выбрасываемся. Мяч отлетел от ноги (плохое касание) —
// окно отбора: рывок в мяч. Отбор и случается на этой ошибке.
function pressBall(p, dt, ball, match) {
  const AI = CONFIG.ai;
  const D = AI.defence;
  const P = CONFIG.player;
  const team = p.team;
  const pos = p.group.position;
  const bp = ball.mesh.position;
  const owner = match.toucher;
  const myBallDist = distToBall(p, ball);

  // Мяч свободен или у своего (страховка) — обычная погоня.
  // Летящий верхом мяч (навес/вынос) — бежим к точке ПРИЗЕМЛЕНИЯ:
  // защитник встречает подачу, а не бегает за тенью мяча
  if (!owner || owner.team === team) {
    if (bp.y > 1.2) {
      const land = predictLanding(ball, 0.4);
      if (land) {
        return {
          move: seek(pos.x, pos.z, land.x, land.z),
          sprint: Math.hypot(land.x - pos.x, land.z - pos.z) > 3,
          face: null,
          speedCap: null,
        };
      }
    }
    // ЗАВЕРШЕНИЕ В ПАДЕНИИ. Мяч свободен, я ближе всех и уже у чужих ворот, но
    // ногой стоя не достаю — иду в слайд и пробую дотянуться. Условия сидят
    // внутри trySlideFinish и узкие нарочно: падать по всему полю нельзя.
    if (p.trySlideFinish && p.trySlideFinish(ball)) {
      return { move: { x: 0, z: 0 }, sprint: false, face: null, speedCap: null };
    }
    return {
      move: pursuitBall(pos.x, pos.z, ball, P.speed),
      sprint: myBallDist > AI.sprintDist,
      face: null,
      speedCap: null,
    };
  }

  const op = owner.group.position;
  const badTouch = Math.hypot(bp.x - op.x, bp.z - op.z) > D.badTouchDist;

  // Окно отбора. Классическое — ОШИБКА ВЛАДЕЛЬЦА (мяч отскочил от ноги), там
  // решаются охотно. Но ждать только её нельзя: AI-ведение держит мяч в 0.9 м
  // от ноги, и «плохое касание» не наступает практически никогда — замер
  // 24.07 дал 0.1% кадров ведения и НОЛЬ подкатов AI за 20 минут. Поэтому
  // добавлено обычное окно: слайд идёт, когда он ФИЗИЧЕСКИ достаёт мяч сбоку.
  const TKA = D.tackle;
  if (p.tackleCd <= 0 && p.kickCooldown <= 0 && p.downT <= 0 && p.diveT <= 0 &&
      bp.y < P.tackle.ballMaxY &&
      myBallDist > TKA.rangeMin && myBallDist < TKA.range &&
      p.tackleReachable(ball)) {
    // Упреждение на приход НОГИ — целим, где мяч БУДЕТ (та же математика,
    // что у человека: вынос ноги укорачивает путь корпуса)
    const aim = p.tackleAim(ball);
    const dl = Math.hypot(aim.x, aim.z) || 1;
    const behind =
      (aim.x / dl) * owner.facing.x + (aim.z / dl) * owner.facing.z > P.tackle.backCos;
    // Ближе к своим воротам решаются злее — там цена потери выше
    const ownDepth = Math.hypot(pos.x - team.ownGoalX, pos.z);
    const rate = (badTouch ? TKA.ratePerSec : TKA.rateNormal) *
      (ownDepth < TKA.desperateDepth ? TKA.desperateK : 1);
    if (!behind && Math.random() < rate * dt) {
      p.startTackle(aim.x, aim.z);
      return { move: { x: 0, z: 0 }, sprint: false, face: null, speedCap: null };
    }
  }

  if (badTouch) {
    // Владелец потерял касание — рывок в мяч
    return {
      move: pursuitBall(pos.x, pos.z, ball, P.speed),
      sprint: true,
      face: null,
      speedCap: null,
    };
  }

  const inOurHalf = team.side * bp.x < 0;
  if (!inOurHalf) {
    // Высокий прессинг: на владельца с упреждением по его курсу (soccer.py)
    const ospd = Math.hypot(owner.vel.x, owner.vel.z);
    const odx = ospd > 1 ? owner.vel.x / ospd : owner.facing.x;
    const odz = ospd > 1 ? owner.vel.z / ospd : owner.facing.z;
    return {
      move: seek(pos.x, pos.z, op.x + odx * D.presserLead, op.z + odz * D.presserLead),
      sprint: myBallDist > AI.sprintDist,
      face: null,
      speedCap: null,
    };
  }

  // Сдерживание: блок-точка между владельцем и нашими воротами (MarliK)
  const gx = team.ownGoalX;
  const dgx = gx - op.x;
  const dgz = -op.z;
  const dgl = Math.hypot(dgx, dgz) || 1;
  const tx = op.x + (dgx / dgl) * D.jockeyDist;
  const tz = op.z + (dgz / dgl) * D.jockeyDist;
  const toBlock = Math.hypot(tx - pos.x, tz - pos.z);
  let speedCap = null;
  if (toBlock < D.jockeyDist * 1.5) {
    // У блок-точки пятимся в темпе владельца — не выбрасываемся на финт
    const ownerSpeed = Math.hypot(owner.vel.x, owner.vel.z);
    speedCap = Math.max(2.5, ownerSpeed * D.jockeyMirror);
  }
  return {
    move: arrive(pos.x, pos.z, tx, tz, 1.4),
    sprint: toBlock > 7,
    face: Math.atan2(op.x - pos.x, op.z - pos.z), // лицом к владельцу
    speedCap,
  };
}

// С мячом: такт решений (не каждый кадр) — удар, пас или продолжаем вести
function withBall(p, ball) {
  const AI = CONFIG.ai;
  const P = CONFIG.player;
  const team = p.team;
  const pos = p.group.position;
  const bp = ball.mesh.position;
  const goalX = team.attackGoalX;
  const distGoal = Math.hypot(goalX - pos.x, pos.z);

  // Ближайший соперник — мера давления
  let oppD = Infinity;
  let opp = null;
  for (const o of team.opponents) {
    const op = o.group.position;
    const d = Math.hypot(op.x - pos.x, op.z - pos.z);
    if (d < oppD) {
      oppD = d;
      opp = o;
    }
  }

  const canKick = p.kickCooldown <= 0 && distToBall(p, ball) < P.kickRadius && bp.y < P.kickMaxBallY;
  if (canKick && p.ai.decideCd <= 0) {
    p.ai.decideCd = AI.decideInterval;
    // РЕШЕНИЕ БИТЬ — не «попал в радиус», а качество момента. Прежний код
    // стрелял при первой же возможности с 28 м, и замер дал 7 ударов за матч,
    // из них НИ ОДНОГО ближе 11 м: атака гибла на дальнем ударе, а вратарь
    // спокойно забирал (0 голов за 4 матча). Теперь дальний удар — редкость,
    // а команда доводит мяч до убойной зоны, где и живёт прострел.
    if (distGoal < AI.shootRange && Math.abs(pos.z) < AI.shootMaxZ) {
      // Качество момента: 1 в убойной зоне, тает с дистанцией и углом
      let quality = Math.max(0, Math.min(1,
        (AI.shootRange - distGoal) / Math.max(1, AI.shootRange - AI.shootBest)));
      quality = Math.pow(quality, AI.shootFalloff);
      quality *= 1 - 0.55 * Math.min(1, Math.abs(pos.z) / AI.shootMaxZ);
      // Защитник МЕЖДУ мной и воротами — момент испорчен. Но опекун вплотную
      // (ближе shotBlockMin вдоль линии удара) — это не блок, а ДАВЛЕНИЕ:
      // сдерживающий защитник по построению стоит ровно на линии удара к
      // центру ворот, и «блок» находился почти в каждом эпизоде. Плотная
      // опека обязана резать ТОЧНОСТЬ, а не отменять удар (принцип PES)
      let blocked = false;
      let pressed = false;
      for (const o of team.opponents) {
        if (o.isKeeper) continue;
        const op = o.group.position;
        const ax = (op.x - pos.x) * ((goalX - pos.x) / distGoal) +
          (op.z - pos.z) * (-pos.z / distGoal);
        if (ax < 0.5 || ax > distGoal) continue;
        const perp = Math.abs(-(op.x - pos.x) * (-pos.z / distGoal) +
          (op.z - pos.z) * ((goalX - pos.x) / distGoal));
        if (perp >= AI.shotBlockWidth) continue;
        if (ax < AI.shotBlockMin) pressed = true;
        else { blocked = true; break; }
      }
      if (blocked) quality *= AI.shotBlockedK;
      // В убойной зоне удар ОБЯЗАТЕЛЕН: вероятностный гейт иногда «прокатывал»
      // момент из штрафной, и атака вырождалась в бесконечное перекатывание
      // мяча (замер 26.07: 0 ударов за матч). Под блоком — с полом, а не с 1
      if (distGoal < AI.shootBest) {
        quality = Math.max(quality, blocked ? AI.shootKillFloor : 1);
      }
      if (Math.random() < quality) {
        aiShoot(p, ball, goalX, distGoal, pressed);
        p.ai.dribDir = null;
        return { x: 0, z: 0 };
      }
    }
    // Пас считаем ВСЕГДА: его лучший счёт нужен и навесу (сравнить, что
    // ценнее), и тренеру (tryComingShort). Исполняем — под давлением или по
    // собственному почину (passUrge)
    const pass = team.choosePass(p, ball);
    // Навес больше не имеет абсолютного приоритета: раньше он стоял ВЫШЕ паса
    // и не проходил через модель вовсе, хотя даёт 2.5 гола на 100 против 6.4
    // у прострела. Теперь подаём, только если передачи лучше нет
    if (aiCross(p, ball, oppD, pass)) {
      p.ai.dribDir = null;
      return { x: 0, z: 0 };
    }
    if (pass && (oppD < AI.passPressure || Math.random() < AI.passUrge)) {
      p.aiKick(ball, pass.dir, pass.power, pass.lift, 0, passStrikeKind(pass));
      team.commitPass(pass, p); // короткий пас под прессингом → стеночка
      p.ai.dribDir = null;
      return { x: 0, z: 0 };
    }
  }

  // Ведение к воротам, чуть к центру; соперник рядом — скользим в сторону.
  // ИСКЛЮЧЕНИЕ — широкий игрок в финальной трети: он продавливает к ЛИЦЕВОЙ
  // под прострел, а не сворачивает на центр в объятия блока. Без этого
  // геометрия прострела (fCutback 1.6, второе оружие игры) была недостижима:
  // мяч в угол штрафной никто не доводил ни разу за матч
  const CB = CONFIG.ai.attack.cross;
  const wide = Math.abs(pos.z) > CB.flankZ &&
    team.side * pos.x > CONFIG.field.length / 2 - CB.finalThird;
  let dx;
  let dz;
  if (wide) {
    dx = team.side * (CONFIG.field.length / 2 - 4) - pos.x;
    dz = Math.sign(pos.z) * 16 - pos.z;
  } else {
    dx = goalX - pos.x;
    dz = -pos.z * 0.35;
  }
  let dl = Math.hypot(dx, dz) || 1;
  dx /= dl;
  dz /= dl;
  if (opp && oppD < AI.dribbleAvoidDist && oppD > 0.01) {
    const op = opp.group.position;
    const k = (1 - oppD / AI.dribbleAvoidDist) * 1.2;
    dx += ((pos.x - op.x) / oppD) * k;
    dz += ((pos.z - op.z) / oppD) * k;
    dl = Math.hypot(dx, dz) || 1;
    dx /= dl;
    dz /= dl;
  }
  p.ai.dribDir = { x: dx, z: dz };
  // Чистота коридора ПО КУРСУ: владелец включает спринт, только когда впереди
  // никого. Общий гандикап дриблинга (dribbleSpeedFactor) не трогаем — по духу
  // PES дриблинг не должен выигрывать у паса; но и убегать от прессинга после
  // стеночки владелец обязан, иначе весь прогресс мяча упирается в передачу
  let ahead = Infinity;
  for (const o of team.opponents) {
    if (o.isKeeper) continue;
    const op = o.group.position;
    const rx = op.x - pos.x;
    const rz = op.z - pos.z;
    const along = rx * dx + rz * dz;
    if (along <= 0) continue;
    const side = Math.abs(rx * dz - rz * dx);
    if (side > 3.5) continue;
    ahead = Math.min(ahead, along);
  }
  p.ai.dribFree = ahead;
  return { x: dx, z: dz };
}

// AI-навес с фланга (ресёрч 10 + PES): вингер в финальной трети упёрся
// в защитника — подача в штрафную на самого свободного из своих; никого
// нет — на дальнюю штангу (PES-дефолт). Сила — баллистикой под дистанцию.
// Возвращает true, если навес исполнен.
function aiCross(p, ball, oppD, pass = null) {
  const AI = CONFIG.ai;
  const AC = AI.attack.cross;
  const F = CONFIG.field;
  const B = CONFIG.ball;
  const team = p.team;
  const pos = p.group.position;

  const inFlank = Math.abs(pos.z) > AC.flankZ;
  const inFinalThird = team.side * pos.x > F.length / 2 - AC.finalThird;
  if (!inFlank || !inFinalThird || oppD > AC.blockedDist) return false;
  // Передача ценнее подачи — отдаём её. Навес остаётся тем, чем он является в
  // статистике: последним доводом, когда прохода и паса нет
  if (pass && pass.score >= AC.overPass) return false;

  // Адресат: свой в штрафной соперника с максимально свободной зоной
  const boxX = F.length / 2 - 16.5;
  let target = null;
  let bestSpace = -1;
  for (const m of team.players) {
    if (m === p || m.isKeeper) continue;
    const mp = m.group.position;
    if (team.side * mp.x < boxX || Math.abs(mp.z) > 20.16) continue;
    const space = freeSpace(mp.x, mp.z, team.opponents);
    if (space > bestSpace) {
      bestSpace = space;
      target = { x: mp.x + m.vel.x * 0.6, z: mp.z + m.vel.z * 0.6 };
    }
  }
  if (!target) {
    // В штрафной пусто, но туда уже бегут (рывок/врывания)? Подождём их.
    if (team.runner || team.receiver || team.boxRuns.size) return false;
    target = { x: team.side * (F.length / 2 - 5.5), z: -Math.sign(pos.z) * AC.farPostZ };
  }

  const dx = target.x - pos.x;
  const dz = target.z - pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < AC.minDist) return false;

  // Баллистика под адрес (как crossSolution): скорость из угла дуги.
  // Разнообразие подач: продавился к самой лицевой — режет низом (прострел),
  // подаёт из глубины фланга — обычная дуга под голову
  const nearByline = team.side * pos.x > F.length / 2 - AC.deepX;
  const theta = ((nearByline ? AC.lowAngle : AC.angle) * Math.PI) / 180;
  const g = -B.gravity;
  let power = Math.sqrt((g * dist) / (2 * Math.tan(theta))) * 1.15;
  power = Math.max(14, Math.min(30, power));
  const lift = power * Math.tan(theta);
  team.bump('cross');
  p.aiKick(ball, { x: dx / dist, z: dz / dist }, power, lift, 0, 'cross');
  // Замыкающего назначает тренер по точке прилёта (врывание на прилёт)
  team.onCrossStruck(ball);
  return true;
}

// Игра на втором этаже (ресёрч 11): верховой мяч в досягаемости играется
// в одно касание. Контекст решает: своя треть — ВЫНОС на фланг; у чужих
// ворот — удар головой/с лёта в створ, где сила растёт от разбега
// (врывание бьёт сильнее, чем статичный прыжок — принцип PES); середина
// поля — скидка вперёд (борьба за подбор после выносов).
function aerialPlay(p, ball, diving = false) {
  const AIR = CONFIG.ai.aerial;
  const team = p.team;
  const pos = p.group.position;
  const bp = ball.mesh.position;
  const goalX = team.attackGoalX;
  const ownGoalX = team.ownGoalX;
  // В падении бьёшь без опоры: слабее и шумнее (та же цена, что у человека)
  const DF = diving ? CONFIG.player.aerial.dive.powerFactor : 1;
  const DN = diving ? CONFIG.player.aerial.dive.noise : 1;

  const isReceiver = team.receiver === p;
  const distGoal = Math.hypot(goalX - pos.x, pos.z);
  // Прицел считаем по ПРОГНОЗНОЙ высоте контакта, а не по высоте мяча сейчас:
  // замах начинается заранее, и за это время мяч успевает заметно опуститься
  const contactY = diving ? bp.y : p.predictAerialContact(ball).y;

  // Приём (фидбек Олега 22–23.07.2026): адресат нашей верховой передачи
  // гасит опускающийся мяч себе в ноги на ЛЮБОЙ досягаемой высоте — а не
  // «упрыгивает» от него скидкой в прыжке (прыжок jumpT уносил меш от тени
  // и звезды — читалось как поломанная анимация приёма). У чужих ворот
  // приём не включается: там подачу ЗАМЫКАЮТ.
  if (!diving && isReceiver && distGoal >= AIR.headerRange) {
    // ПАС В КАСАНИЕ. Прежде адресат верховой передачи ВСЕГДА принимал мяч —
    // игры в касание у компьютера не существовало вовсе. Играем её там, где
    // она и нужна: опекун рядом (принимать некогда) и есть надёжный вариант
    const FT = CONFIG.ai.firstTouch;
    let press = Infinity;
    for (const o of team.opponents) {
      if (o.isKeeper) continue;
      const op = o.group.position;
      press = Math.min(press, Math.hypot(op.x - pos.x, op.z - pos.z));
    }
    if (p.kickCooldown <= 0 && press < FT.passPress) {
      const pass = team.choosePass(p, ball);
      if (pass && pass.score >= FT.passScore) {
        p.aiAerial(ball, pass.dir, pass.power * FT.passPowerK, pass.lift);
        team.commitPass(pass, p);
        return;
      }
    }
    // Гасим ТОЛЬКО когда мяч реально коснулся корпуса: раньше приём срабатывал,
    // едва мяч влетал в радиус 1.5 м, и мяч менял курс в метре от груди.
    // Направление первого касания у AI — В СТОРОНУ АТАКИ: принимая спиной к
    // чужим воротам, он подрабатывает мяч себе на разворот, а не гасит намертво
    const tgx = goalX - pos.x;
    const tgz = -pos.z;
    const tgl = Math.hypot(tgx, tgz) || 1;
    p.trapBall(ball, p.bodyContactPoint(bp), { x: tgx / tgl, z: tgz / tgl });
    return;
  }

  const ownDepth = Math.hypot(pos.x - ownGoalX, pos.z);
  if (ownDepth < AIR.clearThird && !isReceiver) {
    // Вынос: от своих ворот в сторону ближнего фланга (свой адресат паса
    // вратаря/защитника мяч не выносит — он его принимает выше или ждёт)
    const zs = pos.z !== 0 ? Math.sign(pos.z) : (Math.random() < 0.5 ? -1 : 1);
    p.aiAerial(ball, { x: team.side, z: zs * 0.9 }, AIR.clearPower * DF, AIR.clearLift);
    return;
  }

  if (distGoal < AIR.headerRange && Math.abs(pos.z) < 16) {
    // Замыкание в створ: прицел со случайной точкой и шумом (рычаг
    // «голы не дешевеют»), сила — от скорости разбега в момент контакта.
    // Это УДАР — статистика матча обязана его видеть, иначе замер конверсии
    // врёт (голы головой и с лёта в счётчик ударов не попадали вовсе)
    team.bump('shot');
    const G = CONFIG.goal;
    const spd = Math.hypot(p.vel.x, p.vel.z);
    const noise = AIR.headerNoise * (0.6 + distGoal / AIR.headerRange) * DN;
    const tz = (Math.random() * 2 - 1) * (G.width / 2 - 0.5) +
      (Math.random() * 2 - 1) * noise;
    const dx = goalX - pos.x;
    const dz = tz - pos.z;
    const d = Math.hypot(dx, dz) || 1;
    const power = Math.min(AIR.headerPowerMax,
      AIR.headerPower + spd * AIR.headerPowerRun) * DF;
    // Вертикаль: прийти к воротам на высоте headerTargetY (кивок вниз можно)
    const t = d / (power * 0.85);
    let vy = (AIR.headerTargetY - contactY) / t - 0.5 * CONFIG.ball.gravity * t;
    vy = Math.max(-6, Math.min(5, vy));
    p.aiAerial(ball, { x: dx / d, z: dz / d }, power, vy);
    return;
  }

  // Середина поля: скидка головой вперёд, к центру — партнёры подберут
  p.aiAerial(ball, { x: team.side, z: pos.z > 0 ? -0.3 : 0.3 },
    AIR.flickPower * DF, AIR.flickLift);
}

// Удар AI: случайная точка створа + шум промаха, растущий с дистанцией.
// Шум (CONFIG.ai.shotNoise) — главный рычаг против дешёвых голов;
// в Фазе 3 сюда встанет вероятностная модель (мини-xG).
// Удар AI. ЦЕЛИТСЯ В УГОЛ МИМО ВРАТАРЯ, а не в случайную точку створа:
// равномерный прицел давал в основном мячи по центру, которые кипер после
// переработки берёт все подряд (замер 26.07: 4 удара — 4 сейва, 0 голов за
// четыре матча). Реальный бьющий выбирает дальний от вратаря угол; шум
// прицела остаётся главным рычагом «голы не дешевеют».
function aiShoot(p, ball, goalX, distGoal, pressed = false) {
  const AI = CONFIG.ai;
  if (p.team) p.team.bump('shot');
  const G = CONFIG.goal;
  const pos = p.group.position;
  const inner = G.width / 2 - 0.5;

  // Дальний от вратаря угол; кипера нет в поле зрения — выбираем сторону,
  // противоположную своему сносу к бровке (уходим от острого угла)
  const keeper = p.team ? p.team.match.otherTeam(p.team).keeper : null;
  const kz = keeper ? keeper.group.position.z : 0;
  // Дальний угол — это половина створа, ПРОТИВОПОЛОЖНАЯ вратарю. Прежнее
  // сравнение шло с z БЬЮЩЕГО, а вратарь всегда стоит на биссектрисе, то есть
  // по ту же сторону от центра, но ближе к оси — знак всегда совпадал, и AI
  // на самом деле лупил в БЛИЖНИЙ угол, который вратарю легче на два kz
  let side = kz >= 0 ? -1 : 1;
  if (Math.abs(kz) < 0.4) side = Math.random() < 0.5 ? -1 : 1;
  // Иногда бьём в ближний — иначе вратарь читал бы удар по одной схеме
  if (Math.random() < AI.shotNearSide) side = -side;

  const aim = inner * (AI.shotCornerMin + (1 - AI.shotCornerMin) * Math.random());
  // Опекун вплотную не запрещает удар, но режет точность — Physical Pressure
  const noise = AI.shotNoise * (0.5 + distGoal / AI.shootRange) +
    (pressed ? AI.shotPressNoise : 0);
  const targetZ = side * aim + (Math.random() * 2 - 1) * noise;
  const dx = goalX - pos.x;
  const dz = targetZ - pos.z;
  const d = Math.hypot(dx, dz) || 1;
  const power = Math.min(AI.shotPowerMax, AI.shotPowerBase + distGoal * AI.shotPowerPerM);
  // Низом в угол — самый результативный удар в футболе; свечи оставляем редкими
  const lowShot = Math.random() > AI.shotHighChance;
  const lift = lowShot
    ? Math.min(3.5, 0.4 + distGoal * 0.075)
    : Math.min(7, 1.2 + distGoal * 0.12 + Math.random() * 1.5);
  // Клип по манере удара: на разбеге — полный мах подъёмом, с места — щёчка
  const running = Math.hypot(p.vel.x, p.vel.z) > CONFIG.shot.styles.instep.minRunSpeed;
  p.aiKick(ball, { x: dx / d, z: dz / d }, power, lift, 0, running ? 'instep' : 'side');
}
