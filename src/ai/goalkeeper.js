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
  if (!p.ai) p.ai = {};

  const ballDist = distToBall(p, ball);

  // === Мяч в руках: держим holdTime, затем вынос с маха (фидбек Олега:
  // мяч больше не отскакивает «как от дерева» в тот же кадр) ===
  if (p.ai.holdT > 0) {
    p.ai.holdT -= dt;
    // Мяч живёт в руках: перед грудью, без скорости — полевые не дотянутся
    const f = p.facing;
    bp.set(pos.x + f.x * 0.5, AI.holdY, pos.z + f.z * 0.5);
    ball.vel.set(0, 0, 0);
    ball.spin = 0;
    if (p.ai.holdT <= AI.dropkickLead && !p.ai.dropkickStarted) {
      // Мах начинается заранее — нога встретит мяч в момент вылета
      p.ai.dropkickStarted = true;
      p.playOneShot('gk_dropkick', 1.6, 1.15);
    }
    if (p.ai.holdT <= 0) {
      // Вынос: сильным ударом на фланг своей атаки
      const zSign = Math.abs(pos.z) > 2 ? Math.sign(pos.z) : (Math.random() < 0.5 ? -1 : 1);
      const d = Math.hypot(team.side, zSign * 0.55) || 1;
      ball.strike({ x: team.side / d, z: (zSign * 0.55) / d }, AI.clearPower, AI.clearLift);
      p.kickCooldown = P.kickCooldown * 2; // выбитый мяч не ловим тут же обратно
      p.ai.dropkickStarted = false;
    }
    p.aiUpdate(dt, { x: 0, z: 0 }, { face: Math.atan2(team.side, 0) });
    return;
  }

  // Мяч досягаем — ЛОВЛЯ: гасим его в руках, клип по характеру мяча
  // (пушка — бросок, верховой — корпусом, низовой — подбор)
  const reachable =
    (ballDist < AI.catchRadius && bp.y < AI.catchMaxY) ||
    (ballDist < P.kickRadius && bp.y < P.kickMaxBallY);
  if (p.kickCooldown <= 0 && reachable) {
    const shotSpeed = Math.hypot(ball.vel.x, ball.vel.z);
    const clip = shotSpeed > 14
      ? { name: 'gk_dive', ts: 1.5, at: 0.25 }
      : bp.y > 0.8
        ? { name: 'gk_catch', ts: 1.4, at: 0.45 }
        : { name: 'gk_scoop', ts: 1.4, at: 0.35 };
    p.playOneShot(clip.name, clip.ts, clip.at);
    p.ai.holdT = AI.holdTime;
    p.ai.dropkickStarted = false;
    p.rot = Math.atan2(team.side, 0); // разворачивается с мячом в поле
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
