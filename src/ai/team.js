// Слой «тренер» (стейт-машина команды по Бакленду): владеем — регионы едут
// вперёд, потеряли — назад; назначает, кто гонится за мячом, кто принимает
// пас, кто открывается в поддержку. Сам никого не двигает — только раздаёт
// назначения, «головы» игроков (fieldplayer.js) их исполняют.

import { CONFIG } from '../config.js';
import { distToBall, passLaneClearance } from './steering.js';

export class Team {
  // side: +1 — атакуем ворота на +X, −1 — на −X. players[0] — вратарь.
  constructor(match, side, data, players) {
    this.match = match;
    this.side = side;
    this.data = data;
    this.players = players;
    players.forEach((p, i) => {
      p.team = this;
      p.homeIdx = i;
      p.role = CONFIG.formation.roles[i].id;
      p.isKeeper = i === 0;
    });

    this.attacking = false;   // владеем ли мячом (по мнению тренера)
    this.chaser = null;       // кто бежит к свободному мячу
    this.receiver = null;     // кто ждёт адресованный ему пас
    this.receiveTarget = null; // куда этот пас летит
    this.receiveTimer = 0;
    this.supporter = null;    // кто открывается впереди под пас
    this._coachTimer = 0;
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

  update(dt, ball) {
    const AI = CONFIG.ai;

    // Приём паса: живёт, пока мяч летит адресату. Снимаем, когда адресат
    // принял, соперник перехватил или время вышло. Важно: НЕ снимаем от
    // касания пасующего — сразу после удара он ещё пару кадров «ближайший».
    if (this.receiver) {
      this.receiveTimer -= dt;
      const done = this.receiveTimer <= 0 ||
        this.match.possession === this.match.otherTeam(this) ||
        this.match.toucher === this.receiver;
      if (done) {
        this.receiver = null;
        this.receiveTarget = null;
      }
    }

    // Догоняющий пересчитывается каждый кадр — это дёшево (11 дистанций),
    // а реакция на отскок мгновенная, как у Бакленда в ChaseBall
    this.chaser = this.pickChaser(ball);

    this._coachTimer -= dt;
    if (this._coachTimer > 0) return;
    this._coachTimer = AI.coachTick;

    // Владение — по последнему касанию (считает Match)
    this.attacking = this.match.possession === this;

    // Поддержка атаки: ближний к «точке открывания» полузащитник/нападающий
    this.supporter = this.attacking ? this.pickSupporter(ball) : null;
  }

  // Кто бежит к мячу: ближний полевой игрок. Управляемого человеком не
  // назначаем — за него решает Олег (авто-переключение и так отдаст ему
  // ближнего). Вратарь гонится только по своей логике (goalkeeper.js).
  pickChaser(ball) {
    let best = null;
    let bestD = Infinity;
    for (const p of this.fieldPlayers) {
      if (p === this.match.controlled) continue;
      const d = distToBall(p, ball);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  // Упрощённые support spots Бакленда: точка впереди мяча ближе к центру
  // (подача с фланга найдёт адресата, прострел — набегающего)
  supportSpot(ball) {
    const F = CONFIG.field;
    const AI = CONFIG.ai;
    const bp = ball.mesh.position;
    const x = Math.max(
      -F.length / 2 + 4,
      Math.min(F.length / 2 - 4, bp.x + this.side * AI.supportDist),
    );
    const z = Math.abs(bp.z) > 8 ? -Math.sign(bp.z) * 8 : Math.sign(bp.z || 1) * -12;
    return { x, z };
  }

  pickSupporter(ball) {
    const spot = this.supportSpot(ball);
    let best = null;
    let bestD = Infinity;
    // Открываются атакующие роли (полузащита и нападение — индексы 5..10)
    for (const p of this.players.slice(5)) {
      if (p === this.match.controlled || p === this.chaser || p === this.receiver) continue;
      const d = Math.hypot(spot.x - p.group.position.x, spot.z - p.group.position.z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  // Домашняя точка игрока: регион формации, сдвинутый состоянием команды
  // (атака/оборона) и притянутый к мячу — линии «дышат», команда компактна
  homeTarget(p, ball) {
    const F = CONFIG.field;
    const AI = CONFIG.ai;
    const base = CONFIG.formation.roles[p.homeIdx];
    const bp = ball.mesh.position;

    if (p.isKeeper) {
      // Вратарь регионами не живёт — его точку даёт goalkeeper.js;
      // сюда попадает только при расстановке на кикофф
      return { x: this.side * base.x * (F.length / 2), z: 0 };
    }

    const shift = this.attacking ? AI.attackShift : -AI.defendShift;
    let x = this.side * (base.x + shift) * (F.length / 2);
    x += bp.x * AI.ballPullX;
    let z = base.z * (F.width / 2) * 0.92;
    z += bp.z * AI.ballPullZ;

    x = Math.max(-F.length / 2 + 2, Math.min(F.length / 2 - 2, x));
    z = Math.max(-F.width / 2 + 1.5, Math.min(F.width / 2 - 1.5, z));
    return { x, z };
  }

  // Выбор паса для игрока с мячом: вперёд, в чистый коридор, на ход.
  // Возвращает готовое решение {mate, dir, power, lift, target} или null.
  choosePass(from, ball) {
    const AI = CONFIG.ai;
    const fp = from.group.position;
    const opponents = this.opponents;
    let best = null;
    let bestScore = -Infinity;

    for (const mate of this.players) {
      if (mate === from || mate.isKeeper) continue;
      const mp = mate.group.position;
      const dist = Math.hypot(mp.x - fp.x, mp.z - fp.z);
      if (dist < AI.passMin || dist > AI.passMax) continue;

      // Упреждение: пас на ход бегущему, а не в точку, где он был
      const speed = Math.min(AI.passSpeedMax,
        Math.max(AI.passSpeedMin, dist * AI.passSpeedK + AI.passSpeedMin * 0.5));
      const t = dist / speed;
      const tx = mp.x + mate.vel.x * t * 0.7;
      const tz = mp.z + mate.vel.z * t * 0.7;

      const clearance = passLaneClearance(fp.x, fp.z, tx, tz, opponents);
      if (clearance < AI.passOpenRadius) continue;

      // Ценим продвижение к чужим воротам и чистоту коридора
      const forward = this.side * (tx - fp.x);
      const score = forward + clearance * 1.5 - dist * 0.08;
      if (score > bestScore) {
        bestScore = score;
        const d = Math.hypot(tx - fp.x, tz - fp.z) || 1;
        best = {
          mate,
          target: { x: tx, z: tz },
          dir: { x: (tx - fp.x) / d, z: (tz - fp.z) / d },
          power: speed,
          lift: dist > AI.longPassDist ? AI.longPassLift : 0.6,
        };
      }
    }
    return best;
  }

  // Зафиксировать пас: адресат бросается на мяч, тренер помнит назначение
  commitPass(pass) {
    this.receiver = pass.mate;
    this.receiveTarget = pass.target;
    this.receiveTimer = CONFIG.ai.receiveGiveUp;
  }
}
