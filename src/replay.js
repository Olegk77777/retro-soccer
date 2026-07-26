// Повтор гола — как в трансляции: серия эпизодов с РАЗНЫХ камер.
//
// Правила Олега:
//   1) видна ВСЯ КОМБИНАЦИЯ, а не только удар (26.07.2026);
//   2) повторов несколько и ракурсы разные, а не один и тот же (26.07.2026);
//   3) камера должна ВЕСТИ МЯЧ и понимать, где событие: любая камера здесь
//      орбитальная — она построена ВОКРУГ цели и всегда смотрит на неё, так
//      что «объектив в рекламные щиты» физически невозможен;
//   4) повтор не обрывается на голе: запись идёт дальше, в неё попадают мяч
//      в сетке и празднование, и они тоже показываются — крупным планом.
//
// Пишем «позы», а не физику: позиция, поворот, наклон и кадр анимации каждого
// игрока плюс мяч. Воспроизведение расставляет тела по буферу, поэтому повтор
// ничего не пересчитывает и не может разойтись с тем, что было.

import * as THREE from 'three';
import { CONFIG } from './config.js';

// Сколько чисел на одного игрока в кадре: x, y, z, поворот, наклон,
// индекс клипа, время внутри клипа.
const PER_PLAYER = 7;
// Мяч: позиция + углы вращения (на замедлении видно, как он крутится)
const BALL_SLOTS = 6;
// Плюс одно число на кадр — кто владел мячом (индекс команды или -1)

// --- Ракурсы -------------------------------------------------------------
//
// Каждый ракурс — только ГЕОМЕТРИЯ точки съёмки относительно цели. Куда
// смотреть, решает не он: взгляд всегда ведёт цель (мяч или автор гола).
// place(ctx) → {x, y, z} камеры. ctx: {t, target, vel, goalX, goalSide,
// nearSide (в какую сторону по Z ушёл эпизод), field}.
const ANGLES = {
  // Низкая камера у бровки: классический ракурс телевизионного повтора
  sideline: {
    id: 'sideline',
    place(ctx) {
      const side = ctx.nearSide;
      return {
        x: ctx.target.x - ctx.goalSide * (10 - 4 * ctx.t),
        y: 9.5 - 2.6 * ctx.t,
        z: side * (31 - 7 * ctx.t),
      };
    },
  },
  // Из-за ворот: видно, как мяч заходит в створ
  behindGoal: {
    id: 'behindGoal',
    place(ctx) {
      return {
        x: ctx.goalX + ctx.goalSide * (15 - 4 * ctx.t),
        y: 7.4 - 1.9 * ctx.t,
        z: ctx.target.z * 0.35 + ctx.nearSide * 4,
      };
    },
  },
  // Дальняя бровка: обратный план, зрителю видно то, что скрывала ТВ-камера
  reverse: {
    id: 'reverse',
    place(ctx) {
      const side = -ctx.nearSide;
      return {
        x: ctx.target.x + ctx.goalSide * (6 - 3 * ctx.t),
        y: 7.0 - 1.6 * ctx.t,
        z: side * (30 - 6 * ctx.t),
      };
    },
  },
  // Высокий тактический план: вся комбинация целиком, видно движение линий
  highWide: {
    id: 'highWide',
    place(ctx) {
      return {
        x: ctx.target.x * 0.85 - ctx.goalSide * 4,
        y: 20 - 4 * ctx.t,
        z: ctx.nearSide * (38 - 6 * ctx.t),
      };
    },
  },
  // Догоняющая: камера идёт позади атаки вдоль её оси, как стедикам
  chase: {
    id: 'chase',
    place(ctx) {
      const back = 17 - 5 * ctx.t;
      return {
        x: ctx.target.x - ctx.goalSide * back,
        y: 5.6 + 1.0 * ctx.t,
        z: ctx.target.z * 0.55 + ctx.nearSide * 7,
      };
    },
  },
  // Крупный план: празднование, лица и жесты — камера почти на газоне
  closeup: {
    id: 'closeup',
    place(ctx) {
      const d = 13.5 - 2.5 * ctx.t;
      const vx = ctx.vel.x, vz = ctx.vel.z;
      const s = Math.hypot(vx, vz);
      // Заходим спереди-сбоку от бегущего: видно фигуру, а не спину
      const fx = s > 0.4 ? vx / s : ctx.goalSide;
      const fz = s > 0.4 ? vz / s : 0;
      return {
        x: ctx.target.x + fx * d * 0.75 + fz * d * 0.5,
        y: 3.6 - 0.5 * ctx.t,
        z: ctx.target.z + fz * d * 0.75 - fx * d * 0.5,
      };
    },
  },
};

export class Replay {
  constructor(players, ball) {
    const R = CONFIG.replay;
    this.players = players;
    this.ball = ball;
    this.rate = R.rate;
    this.stride = BALL_SLOTS + players.length * PER_PLAYER + 1;
    this.cap = Math.ceil(R.memory * R.rate);
    this.data = new Float32Array(this.cap * this.stride);
    this.head = 0;        // куда пишем следующий кадр
    this.count = 0;       // сколько кадров реально записано (≤ cap)
    this.acc = 0;         // накопитель времени до следующего снимка
    this.playing = false;
    this.cam = null;      // {pos, look} — камера повтора, читает main.js
    this.goalFrame = -1;  // абсолютный индекс кадра, в котором влетел гол
    this.scorerIndex = -1; // кто празднует: за ним ведёт камера крупного плана
    this.segments = [];
    this.segIndex = -1;

    // Порядок клипов одинаков у всех клонов (модель одна) — значит имя клипа
    // можно писать одним числом. Список берём у первого, кто уже загрузился.
    this._clipNames = null;
    this._look = new THREE.Vector3();
    this._smoothTarget = new THREE.Vector3();
    this._smoothVel = new THREE.Vector3();
  }

  _names() {
    if (!this._clipNames) {
      const p = this.players.find((x) => x.actions && Object.keys(x.actions).length);
      if (p) this._clipNames = Object.keys(p.actions);
    }
    return this._clipNames;
  }

  // Снимок игровой сцены. Зовётся каждый кадр, пишет с частотой rate.
  // Пишем и после гола: празднование — тоже часть эпизода.
  record(dt, possessionIdx) {
    if (this.playing) return;
    this.acc += dt;
    const step = 1 / this.rate;
    if (this.acc < step) return;
    this.acc = Math.min(this.acc - step, step); // не копим долг после лага

    const names = this._names();
    const d = this.data;
    let o = this.head * this.stride;

    const bp = this.ball.mesh.position;
    const br = this.ball.mesh.rotation;
    d[o++] = bp.x; d[o++] = bp.y; d[o++] = bp.z;
    d[o++] = br.x; d[o++] = br.y; d[o++] = br.z;

    for (const p of this.players) {
      const g = p.group.position;
      d[o++] = g.x; d[o++] = g.y; d[o++] = g.z;
      d[o++] = p.group.rotation.y;
      d[o++] = p.group.rotation.x;
      const idx = names && p.currentName ? names.indexOf(p.currentName) : -1;
      d[o++] = idx;
      d[o++] = p.currentAction ? p.currentAction.time : 0;
    }
    d[o] = possessionIdx;

    this.head = (this.head + 1) % this.cap;
    if (this.count < this.cap) this.count++;
    else if (this.goalFrame >= 0) this.goalFrame--; // буфер уехал — метка вместе с ним
  }

  // Момент гола: с него режутся все сегменты серии
  markGoal(scorerIndex = -1) {
    this.goalFrame = Math.max(0, this.count - 1);
    this.scorerIndex = scorerIndex;
  }

  // Абсолютный индекс i (0 — самый старый в буфере) → смещение в массиве
  _at(i) {
    const start = (this.head - this.count + this.cap) % this.cap;
    return ((start + i) % this.cap) * this.stride;
  }

  // Где началась атака: отматываем назад, пока мяч был у забившей команды
  _attackStart(scorerIdx, fromFrame) {
    const R = CONFIG.replay;
    const possSlot = this.stride - 1;
    const maxBack = Math.min(fromFrame, Math.round(R.maxSeconds * this.rate));
    let back = 0;
    while (back < maxBack) {
      const owner = this.data[this._at(fromFrame - back) + possSlot];
      if (owner !== scorerIdx && owner >= 0) break; // здесь мяч отобрали — начало атаки
      back++;
    }
    // Прихватываем секунду ДО отбора: видно, как мяч перешёл к нам
    back = Math.min(maxBack, back + Math.round(R.preRoll * this.rate));
    back = Math.max(Math.round(R.minSeconds * this.rate), back);
    return Math.max(0, fromFrame - back);
  }

  // Запуск СЕРИИ повторов. Каждый сегмент — свой кусок записи, свой ракурс
  // и свой темп: сначала вся комбинация, потом завершение крупнее и медленнее,
  // потом празднование. Ракурсы не повторяются внутри серии.
  start(scorerIdx) {
    const R = CONFIG.replay;
    if (this.count < R.minSeconds * this.rate) return false;

    const last = this.count - 1;
    const goal = this.goalFrame >= 0 ? Math.min(this.goalFrame, last) : last;
    const sec = (s) => Math.round(s * this.rate);
    const clamp = (i) => Math.max(0, Math.min(last, i));

    // Пул ракурсов для комбинации и для завершения: тасуем, чтобы серия
    // каждый раз выглядела по-новому, но внутри серии не повторялась
    const wide = shuffled(['sideline', 'highWide', 'reverse', 'chase']);
    const finish = shuffled(['behindGoal', 'sideline', 'chase', 'reverse'])
      .filter((a) => a !== wide[0]);

    const segments = [];
    // 1. Вся комбинация: от отбора до момента, когда мяч уже в сетке
    segments.push({
      from: this._attackStart(scorerIdx, goal),
      to: clamp(goal + sec(R.afterGoal)),
      angle: wide[0],
      speed: R.speed,
      slowFrom: clamp(goal - sec(R.slowTail)),
      slowSpeed: R.slowSpeed,
      target: 'ball',
    });
    // 2. Завершение крупнее и медленнее — другой ракурс
    const finishFrom = clamp(goal - sec(R.finishLead));
    if (goal - finishFrom > sec(0.8)) {
      segments.push({
        from: finishFrom,
        to: clamp(goal + sec(R.afterGoal)),
        angle: finish[0] || 'behindGoal',
        speed: R.finishSpeed,
        slowFrom: clamp(goal - sec(R.slowTail * 0.7)),
        slowSpeed: R.slowSpeed * 0.8,
        target: 'ball',
      });
    }
    // 3. Празднование крупным планом — если запись успела его захватить
    const partyFrom = clamp(goal + sec(R.afterGoal * 0.6));
    if (last - partyFrom > sec(1.2) && this.scorerIndex >= 0) {
      segments.push({
        from: partyFrom,
        to: clamp(Math.min(last, partyFrom + sec(R.partyMax))),
        angle: 'closeup',
        speed: R.partySpeed,
        slowFrom: null,
        slowSpeed: R.partySpeed,
        target: 'scorer',
      });
    }

    this.segments = segments;
    this.segIndex = -1;
    this.cam = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
    this.playing = true;
    // Куда ушёл эпизод по Z — на ту сторону и уходят камеры «у бровки»
    this._nearSide = this.data[this._at(goal) + 2] >= 0 ? 1 : -1;
    this._goalX = this.data[this._at(goal)];
    this._goalSide = Math.sign(this._goalX) || 1;
    this._camInit = false;
    this._nextSegment();
    return true;
  }

  _nextSegment() {
    this.segIndex++;
    if (this.segIndex >= this.segments.length) {
      this.stop();
      return false;
    }
    this.seg = this.segments[this.segIndex];
    this.pos = this.seg.from;   // позиция воспроизведения в КАДРАХ записи
    this._camInit = false;      // новый ракурс встаёт сразу, без «переезда»
    return true;
  }

  // Кнопка действия во время повтора: уходим к следующему ракурсу.
  // Возвращает false, когда пропускать больше нечего — серия окончена.
  skipSegment() {
    if (!this.playing) return false;
    return this._nextSegment();
  }

  // Номер текущего повтора в серии (для плашки в углу)
  get segmentNumber() {
    return this.segIndex + 1;
  }

  get segmentCount() {
    return this.segments.length;
  }

  get seconds() {
    return this.seg ? (this.seg.to - this.seg.from) / this.rate : 0;
  }

  // Возвращает false, когда ВСЯ серия доиграна
  update(dt) {
    if (!this.playing || !this.seg) return false;
    const seg = this.seg;

    // Темп как в трансляции: основная часть в своей скорости, а последние
    // кадры перед голом уходят в слоу-мо
    let speed = seg.speed;
    if (seg.slowFrom != null && this.pos > seg.slowFrom) {
      const k = Math.min(1, (this.pos - seg.slowFrom) / Math.max(1, seg.to - seg.slowFrom));
      speed = seg.speed + (seg.slowSpeed - seg.speed) * (k * k * (3 - 2 * k));
    }
    this.pos += dt * this.rate * speed;
    if (this.pos >= seg.to) {
      if (!this._nextSegment()) return false;
      return true;
    }

    const i0 = Math.floor(this.pos);
    const i1 = Math.min(seg.to, i0 + 1);
    const k = this.pos - i0;
    const a = this._at(i0);
    const b = this._at(i1);
    const d = this.data;
    const lerp = (o, j) => d[a + o + j] + (d[b + o + j] - d[a + o + j]) * k;
    // Поворот интерполируем по кратчайшей дуге — иначе на переходе через π
    // игрок делает полный оборот вокруг себя
    const lerpAng = (o, j) => {
      const s = d[a + o + j];
      let diff = d[b + o + j] - s;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      return s + diff * k;
    };

    this.ball.mesh.position.set(lerp(0, 0), lerp(0, 1), lerp(0, 2));
    this.ball.mesh.rotation.set(lerp(0, 3), lerp(0, 4), lerp(0, 5));
    if (this.ball.shadow) {
      this.ball.shadow.position.x = this.ball.mesh.position.x;
      this.ball.shadow.position.z = this.ball.mesh.position.z;
    }

    const names = this._names();
    for (let n = 0; n < this.players.length; n++) {
      const p = this.players[n];
      const o = BALL_SLOTS + n * PER_PLAYER;
      p.group.position.set(lerp(o, 0), lerp(o, 1), lerp(o, 2));
      p.group.rotation.y = lerpAng(o, 3);
      p.group.rotation.x = lerp(o, 4);
      p.shadow.position.x = p.group.position.x;
      p.shadow.position.z = p.group.position.z;
      // Кадр анимации берём из ближайшего снимка: интерполировать время
      // клипа нельзя — на стыке клипов оно прыгает с нуля
      const clip = d[a + o + 5];
      if (names && clip >= 0) p.setReplayPose(names[clip | 0], d[a + o + 6]);
    }

    this._updateCam(dt, (this.pos - seg.from) / Math.max(1, seg.to - seg.from));
    return true;
  }

  // Камера повтора. Главное правило: она СТРОИТСЯ ВОКРУГ ЦЕЛИ и всегда на неё
  // смотрит. Цель — мяч (в эпизоде) или автор гола (в празновании); её
  // положение сглаживается, иначе рикошет дёргает кадр.
  _updateCam(dt, t01) {
    const R = CONFIG.replay;
    const seg = this.seg;

    // Цель кадра
    let tx, ty, tz;
    if (seg.target === 'scorer' && this.scorerIndex >= 0) {
      const p = this.players[this.scorerIndex].group.position;
      tx = p.x; ty = p.y + 1.1; tz = p.z;
    } else {
      const b = this.ball.mesh.position;
      tx = b.x; ty = b.y; tz = b.z;
    }

    if (!this._camInit) {
      this._smoothTarget.set(tx, ty, tz);
      this._smoothVel.set(0, 0, 0);
      this._camInit = true;
    } else {
      const k = Math.min(1, R.camSmooth * dt);
      const px = this._smoothTarget.x, pz = this._smoothTarget.z;
      this._smoothTarget.x += (tx - this._smoothTarget.x) * k;
      this._smoothTarget.y += (ty - this._smoothTarget.y) * k;
      this._smoothTarget.z += (tz - this._smoothTarget.z) * k;
      if (dt > 0) {
        const vk = Math.min(1, 2.5 * dt);
        this._smoothVel.x += ((this._smoothTarget.x - px) / dt - this._smoothVel.x) * vk;
        this._smoothVel.z += ((this._smoothTarget.z - pz) / dt - this._smoothVel.z) * vk;
      }
    }

    const ctx = {
      t: t01,
      target: this._smoothTarget,
      vel: this._smoothVel,
      goalX: this._goalX,
      goalSide: this._goalSide,
      nearSide: this._nearSide,
    };
    const angle = ANGLES[seg.angle] || ANGLES.sideline;
    const want = angle.place(ctx);

    // Камера обязана остаться СНАРУЖИ игры и ВНУТРИ стадиона: не в газоне,
    // не в трибуне и не дальше, чем берёт объектив
    const F = CONFIG.field;
    want.y = Math.max(R.camMinY, want.y);
    want.z = clampAbs(want.z, F.width / 2 + R.camMaxOut);
    want.x = clampAbs(want.x, F.length / 2 + R.camMaxOut);
    const dx = want.x - this._smoothTarget.x;
    const dz = want.z - this._smoothTarget.z;
    const dist = Math.hypot(dx, dz);
    if (dist < R.camMinDist) {
      // Слишком близко — отодвигаем по той же линии, чтобы цель не «влезла в объектив»
      const s = R.camMinDist / Math.max(0.001, dist);
      want.x = this._smoothTarget.x + dx * s;
      want.z = this._smoothTarget.z + dz * s;
    }

    // Внутри одного сегмента камера едет плавно (доводка), на стыке — режем
    if (this.cam.pos.lengthSq() === 0 || t01 < 0.02) {
      this.cam.pos.set(want.x, want.y, want.z);
    } else {
      this.cam.pos.lerp(this._look.set(want.x, want.y, want.z), Math.min(1, R.camEase * dt));
    }
    // Взгляд ведёт цель с лёгким упреждением — оператор смотрит туда, куда всё едет
    this.cam.look.set(
      this._smoothTarget.x + this._smoothVel.x * R.camLead,
      Math.max(0.7, this._smoothTarget.y * 0.7 + 0.7),
      this._smoothTarget.z + this._smoothVel.z * R.camLead,
    );
  }

  stop() {
    this.playing = false;
    this.cam = null;
    this.seg = null;
    this.segments = [];
    this.segIndex = -1;
    // Буфер обнуляем: следующий гол не должен утащить в повтор старую атаку
    this.count = 0;
    this.head = 0;
    this.acc = 0;
    this.goalFrame = -1;
    this.scorerIndex = -1;
    for (const p of this.players) p.endReplayPose();
  }
}

function clampAbs(v, limit) {
  return v > limit ? limit : (v < -limit ? -limit : v);
}

// Тасовка без Math.random-зависимости от порядка: обычный Фишер–Йетс
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
