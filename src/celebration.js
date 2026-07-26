// Празднование гола.
//
// Зачем: без него эпизод обрывался ровно на мяче в сетке — гол «случался», но
// не переживался. Теперь автор бежит к бровке, партнёры догоняют и обступают
// его, пропустившие бредут к центру, а камера идёт низко и близко. Всё это
// пишется в буфер повтора, поэтому потом показывается ещё раз крупным планом.
//
// Игроков ведём вручную через Player.aiUpdate (направление + опции) — обычные
// мозги AI на паузе строят команду к центру, а тут нужен совсем другой рисунок.

import * as THREE from 'three';
import { CONFIG } from './config.js';

export class Celebration {
  constructor() {
    this.active = false;
    this.t = 0;
    this.cam = null;
    this.scorer = null;
    this._jumpT = 0;
    this._target = new THREE.Vector3();
    this._camWant = new THREE.Vector3();
  }

  // scorer — автор гола (может быть null: тогда празднует вся команда «в поле»),
  // team/other — команды забившая и пропустившая
  start(scorer, team, other) {
    const C = CONFIG.celebration;
    this.active = true;
    this.t = 0;
    this.scorer = scorer;
    this.team = team;
    this.other = other;
    this.cam = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
    this._camInit = false;
    this._jumpT = 0;

    // Куда бежит автор: к ближней (телевизионной) бровке на своей половине
    // атаки — так празднование гарантированно попадает в кадр
    const gx = team ? team.attackGoalX : 0;
    this._runTarget = {
      x: gx * 0.62,
      z: C.runTo * (scorer && scorer.group.position.z < -8 ? -1 : 1),
    };

    // Кто бежит обнимать: ближайшие к автору партнёры (вратарь остаётся у себя)
    this.joiners = [];
    if (scorer && team) {
      const mates = team.players.filter((p) => p !== scorer && !p.isKeeper);
      mates.sort((a, b) => dist2(a, scorer) - dist2(b, scorer));
      this.joiners = mates.slice(0, C.joinCount);
    }
  }

  update(dt, players) {
    if (!this.active) return false;
    const C = CONFIG.celebration;
    this.t += dt;

    const scorer = this.scorer;
    if (scorer) {
      // Автор бежит к бровке и подпрыгивает на бегу
      const p = scorer.group.position;
      const dx = this._runTarget.x - p.x;
      const dz = this._runTarget.z - p.z;
      const d = Math.hypot(dx, dz);
      const move = d > 1.5 ? { x: dx / d, z: dz / d } : { x: 0, z: 0 };
      scorer.aiUpdate(dt, move, { sprint: d > 6 });

      // Подскок радости: короткая дуга поверх обычной анимации бега
      this._jumpT += dt;
      const phase = this._jumpT % C.jumpEvery;
      const jump = phase < 0.42 ? Math.sin((phase / 0.42) * Math.PI) : 0;
      p.y = jump * C.jumpHeight;
    }

    // Партнёры окружают автора кольцом — не наступая ему на пятки
    this.joiners.forEach((mate, i) => {
      if (!scorer) return;
      const a = (i / Math.max(1, this.joiners.length)) * Math.PI * 2;
      const tx = scorer.group.position.x + Math.sin(a) * C.joinRadius;
      const tz = scorer.group.position.z + Math.cos(a) * C.joinRadius;
      const p = mate.group.position;
      const dx = tx - p.x;
      const dz = tz - p.z;
      const d = Math.hypot(dx, dz);
      const move = d > 0.6 ? { x: dx / d, z: dz / d } : { x: 0, z: 0 };
      mate.aiUpdate(dt, move, {
        sprint: d > 8,
        face: d > 0.6 ? null : Math.atan2(scorer.group.position.x - p.x, scorer.group.position.z - p.z),
      });
      p.y = 0;
    });

    // Все остальные — трусцой к центру: пропустившие понуро, забившие спокойно
    const busy = new Set(this.joiners);
    for (const p of players) {
      if (p === scorer || busy.has(p)) continue;
      const pos = p.group.position;
      const homeX = p.team ? -p.team.side * 12 : 0;
      const dx = homeX - pos.x;
      const dz = -pos.z * 0.5;
      const d = Math.hypot(dx, dz);
      const move = d > 2 ? { x: dx / d * 0.55, z: dz / d * 0.55 } : { x: 0, z: 0 };
      p.aiUpdate(dt, move, {});
      pos.y = 0;
    }

    this._updateCam(dt);
    return this.t < CONFIG.celebration.time;
  }

  // Живая камера празднования: низкая, близкая, ведёт автора. Тот же принцип,
  // что в повторе, — строится вокруг цели и всегда на неё смотрит.
  _updateCam(dt) {
    const C = CONFIG.celebration;
    // Автора празднования нам обязан дать матч. Если его всё-таки нет,
    // показываем ворота с мячом — но НЕ центр поля: камера, уехавшая в центр,
    // выхватывает случайных бегущих, и празднование пропадает из кадра.
    const target = this.scorer
      ? this.scorer.group.position
      : this._target.set(this.team ? this.team.attackGoalX * 0.9 : 0, 0, 0);
    // Камера заходит со стороны ближней бровки — там же, где ТВ-камера
    const side = target.z >= 0 ? 1 : -1;
    this._camWant.set(
      target.x - Math.sign(target.x || 1) * C.camDist * 0.45,
      C.camHeight,
      target.z + side * C.camDist * 0.8,
    );
    const F = CONFIG.field;
    this._camWant.z = Math.max(-(F.width / 2 + 10), Math.min(F.width / 2 + 10, this._camWant.z));
    this._camWant.x = Math.max(-(F.length / 2 + 8), Math.min(F.length / 2 + 8, this._camWant.x));

    if (!this._camInit) {
      this.cam.pos.copy(this._camWant);
      this._camInit = true;
    } else {
      this.cam.pos.lerp(this._camWant, Math.min(1, C.camEase * dt));
    }
    this.cam.look.set(target.x, target.y + 1.15, target.z);
  }

  stop() {
    this.active = false;
    this.cam = null;
    if (this.scorer) this.scorer.group.position.y = 0;
  }
}

function dist2(a, b) {
  const dx = a.group.position.x - b.group.position.x;
  const dz = a.group.position.z - b.group.position.z;
  return dx * dx + dz * dz;
}
