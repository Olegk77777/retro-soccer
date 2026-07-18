// Слой «голова» полевого игрока (стейт-машина по Бакленду, упрощённая):
// с мячом — веду/пасую/бью; назначен на приём — бегу к точке паса;
// назначен догоняющим — преследую мяч; назначен в поддержку — открываюсь;
// иначе — возвращаюсь в домашний регион и смотрю на мяч.
// Решения — здесь, само движение исполняет player.aiUpdate («ноги»).

import { CONFIG } from '../config.js';
import { arrive, seek, pursuitBall, separation, distToBall } from './steering.js';

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

  if (p.isToucher) {
    move = withBall(p, ball);
  } else {
    p.ai.dribDir = null;
    if (team.receiver === p && team.receiveTarget) {
      // Приём паса: бегу к точке адреса, у самой точки — навстречу мячу
      const t = team.receiveTarget;
      move = myBallDist < 6
        ? pursuitBall(pos.x, pos.z, ball, CONFIG.player.speed)
        : seek(pos.x, pos.z, t.x, t.z);
      sprint = myBallDist > AI.sprintDist;
    } else if (team.chaser === p && !mateHasBall) {
      // Первый защитник (pressure): свободный мяч догоняем, владеющего
      // соперника прессингуем по-PES — агрессивно в чужой половине,
      // сдерживанием (jockey) в своей
      const r = pressBall(p, ball, match);
      move = r.move;
      sprint = r.sprint;
      face = r.face;
      speedCap = r.speedCap;
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
function pressBall(p, ball, match) {
  const AI = CONFIG.ai;
  const D = AI.defence;
  const P = CONFIG.player;
  const team = p.team;
  const pos = p.group.position;
  const bp = ball.mesh.position;
  const owner = match.toucher;
  const myBallDist = distToBall(p, ball);

  // Мяч свободен или у своего (страховка) — обычная погоня
  if (!owner || owner.team === team) {
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
    // Ошибка владельца — бросаемся в отбор
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
    if (oppD < AI.passPressure || Math.random() < AI.passUrge) {
      const pass = team.choosePass(p, ball);
      if (pass) {
        p.aiKick(ball, pass.dir, pass.power, pass.lift);
        team.commitPass(pass);
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
