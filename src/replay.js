// Повтор гола — как в трансляции: замедленная запись с другой камеры.
//
// Правило Олега (26.07.2026): показывать ВСЮ КОМБИНАЦИЮ, а не только удар.
// Поэтому мы всё время пишем кольцевой буфер, а при голе отматываем назад до
// момента, когда мяч ЗАБРАЛА забившая команда, — и повтор начинается оттуда.
//
// Пишем «позы», а не физику: позиция, поворот, наклон и кадр анимации каждого
// игрока плюс мяч. Воспроизведение просто расставляет тела по буферу, поэтому
// повтор ничего не пересчитывает и не может разойтись с тем, что было.

import * as THREE from 'three';
import { CONFIG } from './config.js';

// Сколько чисел на одного игрока в кадре: x, y, z, поворот, наклон,
// индекс клипа, время внутри клипа.
const PER_PLAYER = 7;
// Мяч: позиция + углы вращения (на замедлении видно, как он крутится)
const BALL_SLOTS = 6;
// Плюс одно число на кадр — кто владел мячом (индекс команды или -1)

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

    // Порядок клипов одинаков у всех клонов (модель одна) — значит имя клипа
    // можно писать одним числом. Список берём у первого, кто уже загрузился.
    this._clipNames = null;
  }

  _names() {
    if (!this._clipNames) {
      const p = this.players.find((x) => x.actions && Object.keys(x.actions).length);
      if (p) this._clipNames = Object.keys(p.actions);
    }
    return this._clipNames;
  }

  // Снимок игровой сцены. Зовётся каждый кадр, пишет с частотой rate.
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
  }

  // Абсолютный индекс i (0 — самый старый в буфере) → смещение в массиве
  _at(i) {
    const start = (this.head - this.count + this.cap) % this.cap;
    return ((start + i) % this.cap) * this.stride;
  }

  // Запуск повтора гола. scorerIdx — кто забил: отматываем назад, пока мяч
  // был у него, чтобы в кадр попала вся атака, а не последний удар.
  start(scorerIdx) {
    const R = CONFIG.replay;
    if (this.count < R.minSeconds * this.rate) return false;

    const possSlot = this.stride - 1;
    const maxBack = Math.min(this.count - 1, Math.round(R.maxSeconds * this.rate));
    const minBack = Math.round(R.minSeconds * this.rate);
    const last = this.count - 1;

    let back = 0;
    while (back < maxBack) {
      const owner = this.data[this._at(last - back) + possSlot];
      if (owner !== scorerIdx && owner >= 0) break; // здесь мяч отобрали — начало атаки
      back++;
    }
    // Прихватываем секунду ДО отбора: видно, как мяч перешёл к нам
    back = Math.min(maxBack, back + Math.round(R.preRoll * this.rate));
    back = Math.max(minBack, back);

    this.from = last - back;
    this.to = last;
    this.pos = 0;         // позиция воспроизведения в КАДРАХ записи
    this.playing = true;
    this.cam = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
    // Ракурс выбираем от того, в какие ворота забили: камера уходит на ту же
    // половину и смотрит вдоль атаки — как низкая камера у углового флага.
    this._side = Math.sign(this.data[this._at(this.to)]) || 1;
    this._camSide = this.data[this._at(this.to) + 2] >= 0 ? 1 : -1;
    return true;
  }

  get seconds() {
    return (this.to - this.from) / this.rate;
  }

  // Возвращает false, когда повтор доигран
  update(dt) {
    if (!this.playing) return false;
    const R = CONFIG.replay;
    const frames = this.to - this.from;
    // Темп как в трансляции: комбинация идёт в своей скорости, а последние
    // slowTail секунд (выход на удар и сам удар) уходят в слоу-мо.
    const toEnd = (frames - this.pos) / this.rate;
    const tail = Math.max(0, Math.min(1, toEnd / R.slowTail));
    const speed = R.slowSpeed + (R.speed - R.slowSpeed) * (tail * tail * (3 - 2 * tail));
    this.pos += dt * this.rate * speed;
    const pos = this.pos;
    if (pos >= frames) {
      this.stop();
      return false;
    }

    const i0 = this.from + Math.floor(pos);
    const i1 = Math.min(this.to, i0 + 1);
    const k = pos - Math.floor(pos);
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

    this._updateCam(pos / frames);
    return true;
  }

  // Камера повтора: низкая, у бровки со стороны эпизода, ведёт мяч и
  // медленно подъезжает — не игровая ТВ-точка, а «вторая камера».
  _updateCam(k) {
    const R = CONFIG.replay;
    const b = this.ball.mesh.position;
    const dist = R.camDistance - R.camPush * k;   // подъезжаем по ходу повтора
    this.cam.pos.set(
      b.x - this._side * R.camBehind,
      R.camHeight - R.camDrop * k,
      this._camSide * dist,
    );
    this.cam.look.set(b.x, Math.max(0.6, b.y * 0.6 + 0.7), b.z * 0.65);
  }

  stop() {
    this.playing = false;
    this.cam = null;
    // Буфер обнуляем: следующий гол не должен утащить в повтор старую атаку
    this.count = 0;
    this.head = 0;
    this.acc = 0;
    for (const p of this.players) p.endReplayPose();
  }
}
