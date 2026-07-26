// Бригада арбитров: главный судья на поле и двое боковых.
//
// Зачем: в кадре на поле ровно 22 фигуры и больше никого — это первое, что
// выдаёт «не трансляцию». Судья, бегущий по диагонали за эпизодом, и лайнсмен,
// приставным шагом держащий линию офсайда, стоят копейки, а кадр оживляют.
//
// Это ЧИСТО ВИЗУАЛЬНЫЕ фигуры: они не в командах, не участвуют в арбитраже
// владения, не сталкиваются с мячом и игроками. Свистки и офсайды — отдельная
// тема (Фаза 5), здесь только тела.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Player } from './player.js';

class Official {
  constructor(scene, color) {
    this.body = new Player(scene, { kitColor: color });
    this.vel = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.face = 0;
  }

  // Простое steering: разгон к желаемой скорости, поворот корпуса на мяч.
  // Анимацию выбираем сами (Player.update завязан на ввод и мяч).
  step(dt, speed, lookAt) {
    const p = this.body.group.position;
    const dx = this.target.x - p.x;
    const dz = this.target.z - p.z;
    const dist = Math.hypot(dx, dz);
    // У цели притормаживаем — иначе арбитр дрожит вокруг точки
    const want = dist > 0.35 ? Math.min(speed, dist * 2.2) : 0;
    const wx = dist > 0.001 ? (dx / dist) * want : 0;
    const wz = dist > 0.001 ? (dz / dist) * want : 0;
    const k = Math.min(1, CONFIG.officials.accel * dt);
    this.vel.x += (wx - this.vel.x) * k;
    this.vel.z += (wz - this.vel.z) * k;
    p.x += this.vel.x * dt;
    p.z += this.vel.z * dt;

    // Корпус развёрнут на мяч, как у настоящего арбитра
    let want2 = Math.atan2(lookAt.x - p.x, lookAt.z - p.z);
    let diff = want2 - this.face;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.face += diff * Math.min(1, 8 * dt);
    this.body.group.rotation.y = this.face;

    this.body.shadow.position.x = p.x;
    this.body.shadow.position.z = p.z;
    this._animate(dt);
  }

  // Клип по направлению бега относительно взгляда: вперёд — бег, вбок —
  // приставные шаги (лайнсмен вдоль бровки бегает именно так), назад — спиной
  _animate(dt) {
    const b = this.body;
    if (!b.mixer) return;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (speed < 0.5) {
      b.playAction('idle', 0.2);
    } else {
      const fx = Math.sin(this.face);
      const fz = Math.cos(this.face);
      const fwd = this.vel.x * fx + this.vel.z * fz;
      const side = fx * this.vel.z - fz * this.vel.x;
      let clip = 'run';
      if (Math.abs(fwd) < speed * 0.5 && b.actions.strafe_l) {
        clip = side > 0 ? 'strafe_r' : 'strafe_l';
      } else if (fwd < -speed * 0.5 && b.actions.run_back) {
        clip = 'run_back';
      }
      b.playAction(clip, 0.14);
      if (b.actions[clip]) {
        b.actions[clip].timeScale = Math.min(1.8, Math.max(0.6, speed / 4.0));
      }
    }
    b.mixer.update(dt);
  }
}

export class Officials {
  constructor(scene) {
    const O = CONFIG.officials;
    this.referee = new Official(scene, O.refereeColor);
    this.lines = [new Official(scene, O.linesmanColor), new Official(scene, O.linesmanColor)];
    // Боковые стоят за противоположными бровками и отвечают каждый за свою
    // половину поля — как в настоящей бригаде
    this.lines[0].side = 1;
    this.lines[1].side = -1;
    const F = CONFIG.field;
    this.referee.body.group.position.set(0, 0, 8);
    this.lines[0].body.group.position.set(20, 0, F.width / 2 + O.lineOffset);
    this.lines[1].body.group.position.set(-20, 0, -(F.width / 2 + O.lineOffset));
  }

  // teams нужны только для линии офсайда — второго с конца защитника
  update(dt, ball, teams) {
    const O = CONFIG.officials;
    const F = CONFIG.field;
    const b = ball.mesh.position;

    // Главный судья: держится позади-сбоку от мяча по ходу атаки и не лезет
    // в эпизод — классическая диагональ, по которой судья бегает всю игру
    const dir = Math.abs(ball.vel.x) > 1 ? Math.sign(ball.vel.x) : 1;
    const r = this.referee;
    r.target.set(
      clamp(b.x - dir * O.trailX, -F.length / 2 + 3, F.length / 2 - 3),
      0,
      clamp(b.z + O.diagonalZ, -F.width / 2 + 2, F.width / 2 - 2),
    );
    // Совсем близко к мячу судья не подходит — иначе лезет в кадр эпизода
    const dr = Math.hypot(r.target.x - b.x, r.target.z - b.z);
    if (dr < O.keepAway) {
      const k = O.keepAway / Math.max(0.001, dr);
      r.target.x = b.x + (r.target.x - b.x) * k;
      r.target.z = b.z + (r.target.z - b.z) * k;
    }
    r.step(dt, O.refereeSpeed, b);

    // Боковые: стоят за бровкой и держат линию офсайда своей половины —
    // это X второго с конца игрока обороняющейся команды (или мяч, если он
    // ближе к воротам). Ограничены своей половиной поля.
    for (const l of this.lines) {
      const defending = teams.find((t) => t.side === -l.side) || teams[0];
      const line = offsideLine(defending, l.side);
      const x = l.side > 0
        ? clamp(Math.max(line, Math.min(b.x, F.length / 2 - 1)), 0, F.length / 2 - 1)
        : clamp(Math.min(line, Math.max(b.x, -F.length / 2 + 1)), -F.length / 2 + 1, 0);
      l.target.set(x, 0, l.body.group.position.z);
      l.step(dt, O.linesmanSpeed, b);
    }
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// Линия офсайда: второй с конца полевой игрок обороняющейся команды.
// side > 0 — обороняются у ворот +X, значит нас интересуют самые большие X.
function offsideLine(team, side) {
  let first = -Infinity;
  let second = -Infinity;
  for (const p of team.players) {
    if (p.isKeeper) continue;
    const x = p.group.position.x * side;
    if (x > first) { second = first; first = x; } else if (x > second) { second = x; }
  }
  return (second === -Infinity ? 0 : second) * side;
}
