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
    this.chaser = null;       // кто бежит к свободному мячу / прессингует
    this.coverer = null;      // кто страхует за спиной прессингующего (cover)
    this.marks = new Map();   // персональный разбор в своей трети: защитник → соперник
    this.receiver = null;     // кто ждёт адресованный ему пас
    this.receiveTarget = null; // куда этот пас летит
    this.receiveTimer = 0;
    this.supporter = null;    // кто открывается впереди под пас
    this.defLineX = -side * (CONFIG.field.length / 2 - 25); // линия защиты (мир)
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

    // Линия защиты «дышит»: плавно едет к расчётной высоте (не телепорт) —
    // push up за мячом, drop off к своим воротам (ресёрч 09, lineSpeed)
    const lt = this.defLineTarget(ball);
    const step = CONFIG.ai.defence.lineSpeed * dt;
    const dl = lt - this.defLineX;
    this.defLineX += Math.abs(dl) < step ? dl : Math.sign(dl) * step;

    this._coachTimer -= dt;
    if (this._coachTimer > 0) return;
    this._coachTimer = AI.coachTick;

    // Владение — по последнему касанию (считает Match)
    this.attacking = this.match.possession === this;

    // Поддержка атаки: ближний к «точке открывания» полузащитник/нападающий
    this.supporter = this.attacking ? this.pickSupporter(ball) : null;

    // Оборонительные назначения: страхующий за спиной прессингующего
    // (sweeper/cover из PES Defence System) и персональный разбор в своей трети
    this.coverer = this.attacking ? null : this.pickCoverer(ball);
    this.updateMarks(ball);
  }

  // Высота линии защиты — считается ОТ МЯЧА (ресёрч 09: формула UvA/RoboCup):
  // мяч у чужих ворот — линия у центра, мяч катится к нам — линия отступает,
  // но никогда не прижимается к ленточке (lineMinDepth). Лечит фидбек Олега
  // «защитники жмутся к линии ворот».
  defLineTarget(ball) {
    const D = CONFIG.ai.defence;
    const F = CONFIG.field;
    const bp = ball.mesh.position;
    // Продвижение мяча: 0 = у наших ворот, 1 = у чужих
    const ballDepth = this.side * bp.x + F.length / 2;
    const adv = Math.max(0, Math.min(1, ballDepth / F.length));
    let depth = D.lineMinDepth + D.lineRange * adv * D.mentality;
    // Линия держится глубже мяча (goal-side) минимум на зазор
    depth = Math.min(depth, ballDepth - D.lineBallGap);
    depth = Math.max(D.lineMinDepth, Math.min(F.length / 2 + 8, depth));
    return this.ownGoalX + this.side * depth;
  }

  // Страхующий (cover): второй по близости к мячу полевой — встаёт за спиной
  // прессингующего под углом к центру, ловит обыгрыш и прострел
  pickCoverer(ball) {
    let best = null;
    let bestD = Infinity;
    for (const p of this.fieldPlayers) {
      if (p === this.match.controlled || p === this.chaser) continue;
      const d = distToBall(p, ball);
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
    const D = CONFIG.ai.defence;
    const F = CONFIG.field;
    this.marks.clear();
    if (this.attacking) return;
    const bp = ball.mesh.position;
    const ballDepth = this.side * bp.x + F.length / 2;
    if (ballDepth > D.markThird) return;

    const gx = this.ownGoalX;
    const threats = this.opponents
      .filter((o) => !o.isKeeper && this.side * o.group.position.x < 2)
      .sort((a, b) =>
        Math.hypot(a.group.position.x - gx, a.group.position.z) -
        Math.hypot(b.group.position.x - gx, b.group.position.z));
    // Защитники (индексы 1–4), не занятые прессингом/страховкой/человеком
    const free = this.players.slice(1, 5).filter((p) =>
      p !== this.chaser && p !== this.coverer && p !== this.match.controlled);
    for (const t of threats) {
      if (!free.length) break;
      const tp = t.group.position;
      let bi = 0;
      let bd = Infinity;
      free.forEach((d, i) => {
        const dp = d.group.position;
        const dd = Math.hypot(dp.x - tp.x, dp.z - tp.z);
        if (dd < bd) {
          bd = dd;
          bi = i;
        }
      });
      this.marks.set(free[bi], t);
      free.splice(bi, 1);
    }
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

  // Домашняя точка игрока. В атаке — регион формации, сдвинутый вперёд и
  // притянутый к мячу. В обороне — строимся ОТ ЛИНИИ ЗАЩИТЫ (ресёрч 09):
  // защитники стоят на линии (плоская четвёрка), опорные — второй линией
  // (defOff), форварды остаются выше под контратаку; все сжимаются к мячу
  // по ширине (компактность).
  homeTarget(p, ball) {
    const F = CONFIG.field;
    const AI = CONFIG.ai;
    const D = AI.defence;
    const base = CONFIG.formation.roles[p.homeIdx];
    const bp = ball.mesh.position;

    if (p.isKeeper) {
      // Вратарь регионами не живёт — его точку даёт goalkeeper.js;
      // сюда попадает только при расстановке на кикофф
      return { x: this.side * base.x * (F.length / 2), z: 0 };
    }

    let x;
    let z;
    if (this.attacking) {
      x = this.side * (base.x + AI.attackShift) * (F.length / 2) + bp.x * AI.ballPullX;
      z = base.z * (F.width / 2) * 0.92 + bp.z * AI.ballPullZ;
    } else {
      x = this.defLineX + this.side * base.defOff;
      z = base.z * (F.width / 2) * D.zCompact;
      // Четвёрка защитников не разъезжается шире компактного блока
      if (base.defOff === 0) {
        z = Math.max(-D.defWidth / 2, Math.min(D.defWidth / 2, z));
      }
      z += bp.z * AI.ballPullZ;
    }

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
