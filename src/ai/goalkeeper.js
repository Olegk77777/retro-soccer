// Слой «голова» вратаря (по Бакленду: TendGoal → InterceptBall → вынос).
// Держится между мячом и воротами чуть перед линией; мяч вкатился в штрафную
// и кипер ближе всех — выходит забирать; дотянулся — немедленный вынос
// на фланг. Реакция на удары и статы кипера придут в Фазе 3 (мини-xG).

import { CONFIG } from '../config.js';
import { arrive, pursuitBall, interposePoint, distToBall } from './steering.js';

export function updateKeeper(p, dt, ball) {
  const AI = CONFIG.ai.keeper;
  const P = CONFIG.player;
  const F = CONFIG.field;
  const team = p.team;
  const pos = p.group.position;
  const bp = ball.mesh.position;
  const goalX = team.ownGoalX;

  const ballDist = distToBall(p, ball);

  // Мяч в руках/в ногах — вынос: сильный удар в сторону фланга своей атаки.
  // Анимация — вратарская (фидбек Олега: «отбивает ногами»): пушку снимает
  // броском (gk_dive), верховой ловит корпусом (gk_catch), низовой
  // подбирает и выбивает с рук (gk_dropkick).
  const reachable =
    (ballDist < AI.catchRadius && bp.y < AI.catchMaxY) ||
    (ballDist < P.kickRadius && bp.y < P.kickMaxBallY);
  if (p.kickCooldown <= 0 && reachable) {
    const zSign = Math.abs(bp.z) > 2 ? Math.sign(bp.z) : (Math.random() < 0.5 ? -1 : 1);
    const shotSpeed = Math.hypot(ball.vel.x, ball.vel.z);
    const anim = shotSpeed > 14
      ? { name: 'gk_dive', ts: 1.3, at: 0.12 }
      : bp.y > 1.0
        ? { name: 'gk_catch', ts: 1.2, at: 0.10 }
        : { name: 'gk_dropkick', ts: 1.3, at: 0.18 };
    p.aiKick(ball, { x: team.side, z: zSign * 0.55 }, AI.clearPower, AI.clearLift, 0, anim);
    p.aiUpdate(dt, { x: 0, z: 0 }, {});
    return;
  }

  // Выход на перехват: мяч в нашей штрафной, недалеко, не летит пушкой,
  // и никто из своих не успевает раньше
  const inBox = -team.side * bp.x > F.length / 2 - 16.5 && Math.abs(bp.z) < 20.16;
  const chaserD = team.chaser ? distToBall(team.chaser, ball) : Infinity;
  const ballSpeed = Math.hypot(ball.vel.x, ball.vel.z);

  let move;
  let face = null;
  let sprint = false;
  if (inBox && ballDist < AI.interceptRange && ballDist < chaserD + 2 && ballSpeed < 16) {
    move = pursuitBall(pos.x, pos.z, ball, P.speed);
    sprint = true;
  } else {
    // Дом: точка между мячом и центром ворот, чуть перед линией
    const t = interposePoint(goalX, 0, bp.x, bp.z, AI.depth);
    t.z = Math.max(-AI.wanderZ, Math.min(AI.wanderZ, t.z + bp.z * 0.12));
    move = arrive(pos.x, pos.z, t.x, t.z, 2.2);
    face = Math.atan2(bp.x - pos.x, bp.z - pos.z);
  }
  p.aiUpdate(dt, move, { face, sprint });
}
