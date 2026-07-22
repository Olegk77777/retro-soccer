// Слой «голова» полевого игрока (стейт-машина по Бакленду, упрощённая):
// с мячом — веду/пасую/бью; назначен на приём — бегу к точке паса;
// назначен догоняющим — преследую мяч; назначен в поддержку — открываюсь;
// иначе — возвращаюсь в домашний регион и смотрю на мяч.
// Решения — здесь, само движение исполняет player.aiUpdate («ноги»).

import { CONFIG } from '../config.js';
import { arrive, seek, pursuitBall, separation, distToBall, freeSpace, predictLanding } from './steering.js';

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

  // Второй этаж (ресёрч 11): верховой мяч в досягаемости — играем В ОДНО
  // КАСАНИЕ. Своя треть — вынос; у чужих ворот — замыкание в створ (сила
  // от разбега!); середина — скидка вперёд. Летящий вверх мяч не трогаем.
  // В броске (ласточка) зона контакта — вытянутый корпус (dive.stretch)
  const AP = CONFIG.player.aerial;
  const diving = p.diveT > 0;
  const aerialOk = diving
    ? (myBallDist < AP.reach + AP.dive.stretch &&
        bp.y >= AP.dive.minY && bp.y <= AP.dive.maxY)
    : (myBallDist < AP.reach &&
        bp.y > CONFIG.player.kickMaxBallY && bp.y <= AP.maxY);
  if (p.kickCooldown <= 0 && aerialOk && match.state !== 'restart' && ball.vel.y < 2 &&
      Math.hypot(ball.vel.x, ball.vel.z) > 4) {
    aerialPlay(p, ball, diving);
    p.aiUpdate(dt, { x: 0, z: 0 }, {});
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
  } else {
    p.ai.dribDir = null;
    if (team.receiver === p && team.receiveTarget) {
      // Приём паса: бегу к точке адреса, у самой точки — навстречу мячу.
      // Верховой мяч (навес) — строго к точке прилёта: врывание на прилёт,
      // погоня за тенью мяча увела бы с траектории.
      // У точки — arrive вместо seek и стойка лицом к мячу: seek без радиуса
      // прибытия дрожал на месте (фидбек Олега 22.07 «адресат дёргается»)
      const t = team.receiveTarget;
      const dT = Math.hypot(t.x - pos.x, t.z - pos.z);
      if (myBallDist < 6 && bp.y < 1.2) {
        move = pursuitBall(pos.x, pos.z, ball, CONFIG.player.speed);
      } else {
        move = arrive(pos.x, pos.z, t.x, t.z, 1.6);
        if (dT < 0.5) face = Math.atan2(bp.x - pos.x, bp.z - pos.z);
      }
      sprint = myBallDist > AI.sprintDist || (bp.y > 1.2 && dT > 2);
    } else if (team.chaser === p && !mateHasBall && !passEnRoute) {
      // Первый защитник (pressure): свободный мяч догоняем, владеющего
      // соперника прессингуем по-PES — агрессивно в чужой половине,
      // сдерживанием (jockey) в своей
      const r = pressBall(p, dt, ball, match);
      move = r.move;
      sprint = r.sprint;
      face = r.face;
      speedCap = r.speedCap;
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
      const dgx = gx - bp.x;
      const dgz = -bp.z;
      const dgl = Math.hypot(dgx, dgz) || 1;
      const tx = bp.x + (dgx / dgl) * D.coverDist;
      const tz = bp.z + (dgz / dgl) * D.coverDist - Math.sign(bp.z || 1) * D.coverSide;
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

  // Расталкивание со всеми игроками: у мяча не вырастает куча-мала
  const sep = separation(p, match.allPlayers, AI.separationRadius, AI.separationPush);
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
    return {
      move: pursuitBall(pos.x, pos.z, ball, P.speed),
      sprint: myBallDist > AI.sprintDist,
      face: null,
      speedCap: null,
    };
  }

  const op = owner.group.position;
  const badTouch = Math.hypot(bp.x - op.x, bp.z - op.z) > D.badTouchDist;
  if (badTouch) {
    // Ошибка владельца — окно отбора. Из зоны досягаемости 90-е решают
    // грубо: подкат в мяч (сбоку, никогда в спину — дух фолов PES)
    const TKA = D.tackle;
    if (p.tackleCd <= 0 && p.kickCooldown <= 0 && p.downT <= 0 && p.diveT <= 0 &&
        bp.y < P.tackle.ballMaxY &&
        myBallDist > TKA.rangeMin && myBallDist < TKA.range &&
        Math.random() < TKA.ratePerSec * dt) {
      // Упреждение на время долёта слайда — целим, где мяч БУДЕТ
      const lead = Math.min(P.tackle.aimLeadMax, myBallDist / P.tackle.speedMin);
      const dx = bp.x + ball.vel.x * lead - pos.x;
      const dz = bp.z + ball.vel.z * lead - pos.z;
      const dl = Math.hypot(dx, dz) || 1;
      const behind =
        (dx / dl) * owner.facing.x + (dz / dl) * owner.facing.z > P.tackle.backCos;
      if (!behind) {
        p.startTackle(dx, dz);
        return { move: { x: 0, z: 0 }, sprint: false, face: null, speedCap: null };
      }
    }
    // Иначе — обычный рывок в мяч
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
    if (distGoal < AI.shootRange && Math.abs(pos.z) < AI.shootMaxZ) {
      aiShoot(p, ball, goalX, distGoal);
      p.ai.dribDir = null;
      return { x: 0, z: 0 };
    }
    if (aiCross(p, ball, oppD)) {
      p.ai.dribDir = null;
      return { x: 0, z: 0 };
    }
    if (oppD < AI.passPressure || Math.random() < AI.passUrge) {
      const pass = team.choosePass(p, ball);
      if (pass) {
        p.aiKick(ball, pass.dir, pass.power, pass.lift);
        team.commitPass(pass, p); // короткий пас под прессингом → стеночка
        p.ai.dribDir = null;
        return { x: 0, z: 0 };
      }
    }
  }

  // Ведение к воротам, чуть к центру; соперник рядом — скользим в сторону
  let dx = goalX - pos.x;
  let dz = -pos.z * 0.35;
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
  return { x: dx, z: dz };
}

// AI-навес с фланга (ресёрч 10 + PES): вингер в финальной трети упёрся
// в защитника — подача в штрафную на самого свободного из своих; никого
// нет — на дальнюю штангу (PES-дефолт). Сила — баллистикой под дистанцию.
// Возвращает true, если навес исполнен.
function aiCross(p, ball, oppD) {
  const AI = CONFIG.ai;
  const AC = AI.attack.cross;
  const F = CONFIG.field;
  const B = CONFIG.ball;
  const team = p.team;
  const pos = p.group.position;

  const inFlank = Math.abs(pos.z) > AC.flankZ;
  const inFinalThird = team.side * pos.x > F.length / 2 - AC.finalThird;
  if (!inFlank || !inFinalThird || oppD > AC.blockedDist) return false;

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

  // Баллистика под адрес (как crossSolution): скорость из угла дуги
  const theta = (AC.angle * Math.PI) / 180;
  const g = -B.gravity;
  let power = Math.sqrt((g * dist) / (2 * Math.tan(theta))) * 1.15;
  power = Math.max(14, Math.min(30, power));
  const lift = power * Math.tan(theta);
  p.aiKick(ball, { x: dx / dist, z: dz / dist }, power, lift, 0,
    { name: 'kick', ts: 1.2, at: 0.16 }); // навес — с проводкой
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

  const ownDepth = Math.hypot(pos.x - ownGoalX, pos.z);
  if (ownDepth < AIR.clearThird) {
    // Вынос: от своих ворот в сторону ближнего фланга
    const zs = pos.z !== 0 ? Math.sign(pos.z) : (Math.random() < 0.5 ? -1 : 1);
    p.aiAerial(ball, { x: team.side, z: zs * 0.9 }, AIR.clearPower * DF, AIR.clearLift);
    return;
  }

  const distGoal = Math.hypot(goalX - pos.x, pos.z);
  if (distGoal < AIR.headerRange && Math.abs(pos.z) < 16) {
    // Замыкание в створ: прицел со случайной точкой и шумом (рычаг
    // «голы не дешевеют»), сила — от скорости разбега в момент контакта
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
    let vy = (AIR.headerTargetY - bp.y) / t - 0.5 * CONFIG.ball.gravity * t;
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
function aiShoot(p, ball, goalX, distGoal) {
  const AI = CONFIG.ai;
  const G = CONFIG.goal;
  const pos = p.group.position;
  const inner = G.width / 2 - 0.6;
  const noise = AI.shotNoise * (0.5 + distGoal / AI.shootRange);
  const targetZ = (Math.random() * 2 - 1) * inner + (Math.random() * 2 - 1) * noise;
  const dx = goalX - pos.x;
  const dz = targetZ - pos.z;
  const d = Math.hypot(dx, dz) || 1;
  const power = Math.min(AI.shotPowerMax, AI.shotPowerBase + distGoal * AI.shotPowerPerM);
  const lift = Math.min(7, 1.2 + distGoal * 0.12 + Math.random() * 1.5);
  p.aiKick(ball, { x: dx / d, z: dz / d }, power, lift);
}
