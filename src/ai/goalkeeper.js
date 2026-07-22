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

  // Мяч в руках ведёт Match.updateKeeperHold (держит/выбивает/бросает рукой) —
  // сюда кипер попадает, только пока мяч в игре и ещё не пойман.

  // Мяч досягаем — ЛОВЛЯ: гасим его в руках, клип по характеру мяча
  // (пушка — в броске, верховой — корпусом, низовой — подбор). Что делать с
  // пойманным мячом дальше — решает Match.updateKeeperHold
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
    p.ai.holding = true;   // мяч в руках — дальше ведёт Match.updateKeeperHold
    p.ai.holdAge = 0;
    p.ai.act = null;
    p.ai.dropkickStarted = false;
    p.rot = Math.atan2(team.side, 0); // разворачивается с мячом в поле
    p.aiUpdate(dt, { x: 0, z: 0 }, {});
    // Мяч гасится В КИСТЯХ уже в кадр ловли (следует за анимацией — бросок,
    // падение, подъём; без отскока «как от дерева» и без «мяча в центре»)
    p.holdBallInHands(ball, AI.holdY);
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
