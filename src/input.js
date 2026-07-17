// Единый слой ввода: клавиатура + геймпад + тач (виртуальный стик и кнопки).
// Классическая раскладка (решение Олега, 17.07.2026), у кнопок два смысла —
// в атаке и в обороне (оборонительные придут с AI в Фазе 2–3):
//   стрелки — движение (и прицел по створу во время удара)
//   S — пас            / в защите: сопровождение владеющего мячом
//   D — удар (держать) / в защите: отбор
//   A — навес          / в защите: подкат
//   W — пас на ход
//   Пробел — зарезервирован: игра в стеночку (будущее)
// ВСЕ действия — с замахом: держишь кнопку — сила растёт, отпустил — исполнение.

import { CONFIG } from './config.js';

// Кнопка с замахом: копит силу, пока держится; на отпускании отдаёт силу 0..overCap.
// Значение выше 1.0 = ПЕРЕДЕРЖКА: исполнение сильнее задуманного (мяч за поле).
class ChargeAction {
  constructor(chargeTime, overCap = 1.3) {
    this.chargeTime = chargeTime;
    this.overCap = overCap;
    this.held = false;
    this.t = 0;
    this._edge = null;
  }

  feed(dt, heldNow) {
    if (heldNow) {
      this.held = true;
      this.t = Math.min(this.t + dt, this.chargeTime * this.overCap);
    } else if (this.held) {
      this._edge = Math.max(0.15, this.t / this.chargeTime); // короткий тап = слабое, но не нулевое
      this.held = false;
      this.t = 0;
    }
  }

  consume() {
    const v = this._edge;
    this._edge = null;
    return v; // null, если не было; иначе сила 0..1
  }

  consumePeek() {
    return this._edge; // посмотреть, не забирая
  }

  get charge01() {
    return this.t / this.chargeTime;
  }
}

export class Input {
  constructor() {
    this.keys = new Set();
    this.move = { x: 0, z: 0 };

    const cap = CONFIG.player.chargeOverCap;
    this.pass = new ChargeAction(CONFIG.player.chargeTime, cap);     // S / геймпад A
    this.through = new ChargeAction(CONFIG.player.chargeTime, cap);  // W / геймпад Y
    this.shot = new ChargeAction(CONFIG.shot.chargeTime, cap);       // D / геймпад X

    // Навес (A / геймпад B) — своя стейт-машина, как в PES: полоска, затем
    // окно «замаха ноги», где доп. тапы меняют тип навеса (×1 / ×2 / ×3)
    this._cross = { state: 'idle', charge: 0, taps: 0, timer: 0, prevHeld: false };
    this._crossEvent = null;

    this._padMove = { x: 0, z: 0 };
    this._pad = { pass: false, shot: false, cross: false, through: false };
    this._touch = { pass: false, shot: false };

    window.addEventListener('keydown', (e) => {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });

    this._initTouch();
  }

  // Виртуальный стик: появляется там, где лёг палец (левые 55% экрана)
  _initTouch() {
    const base = document.getElementById('stick-base');
    const knob = document.getElementById('stick-knob');
    this._stick = { id: null, ox: 0, oy: 0, x: 0, y: 0 };
    const R = 45; // радиус хода стика в пикселях

    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      if (e.clientX > window.innerWidth * 0.55) return; // правая зона — под кнопки
      if (this._stick.id !== null) return;
      this._stick.id = e.pointerId;
      this._stick.ox = e.clientX;
      this._stick.oy = e.clientY;
      base.style.display = 'block';
      base.style.left = (e.clientX - 60) + 'px';
      base.style.top = (e.clientY - 60) + 'px';
      knob.style.transform = 'translate(0px, 0px)';
    });
    window.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._stick.id) return;
      let dx = e.clientX - this._stick.ox;
      let dy = e.clientY - this._stick.oy;
      const len = Math.hypot(dx, dy);
      if (len > R) { dx = (dx / len) * R; dy = (dy / len) * R; }
      this._stick.x = dx / R;
      this._stick.y = dy / R;
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
    });
    const endStick = (e) => {
      if (e.pointerId !== this._stick.id) return;
      this._stick.id = null;
      this._stick.x = 0;
      this._stick.y = 0;
      base.style.display = 'none';
    };
    window.addEventListener('pointerup', endStick);
    window.addEventListener('pointercancel', endStick);

    // Тач-кнопки теперь тоже с замахом: держишь — копится сила
    const bindHold = (id, flag) => {
      const el = document.getElementById(id);
      el.addEventListener('pointerdown', (e) => { e.stopPropagation(); this._touch[flag] = true; });
      const up = (e) => { e.stopPropagation(); this._touch[flag] = false; };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('pointerleave', up);
    };
    bindHold('btn-pass', 'pass');
    bindHold('btn-shoot', 'shot');
  }

  _pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const p = Array.from(pads).find((g) => g && g.connected);
    this._padMove.x = 0;
    this._padMove.z = 0;
    this._pad.pass = this._pad.shot = this._pad.cross = this._pad.through = false;
    if (!p) return;
    const ax = p.axes[0] || 0;
    const ay = p.axes[1] || 0;
    if (Math.hypot(ax, ay) > 0.22) { this._padMove.x = ax; this._padMove.z = ay; }
    const btn = (i) => !!(p.buttons[i] && p.buttons[i].pressed);
    this._pad.pass = btn(0);    // A / крест — пас
    this._pad.cross = btn(1);   // B / круг — навес
    this._pad.shot = btn(2);    // X / квадрат — удар
    this._pad.through = btn(3); // Y / треугольник — пас на ход
  }

  update(dt) {
    this._pollGamepad();

    // Движение: стрелки + геймпад + стик (вверх экрана = -Z)
    let x = 0;
    let z = 0;
    if (this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('ArrowUp')) z -= 1;
    if (this.keys.has('ArrowDown')) z += 1;
    x += this._padMove.x + this._stick.x;
    z += this._padMove.z + this._stick.y;
    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }
    this.move.x = x;
    this.move.z = z;

    // Замахи паса, паса на ход и удара
    this.pass.feed(dt, this.keys.has('KeyS') || this._pad.pass || this._touch.pass);
    this.through.feed(dt, this.keys.has('KeyW') || this._pad.through);
    this.shot.feed(dt, this.keys.has('KeyD') || this._pad.shot || this._touch.shot);

    // Навес: полоска → окно тапов → событие {charge, taps}
    this._feedCross(dt, this.keys.has('KeyA') || this._pad.cross);

    // Прицел удара: пока держится замах, запоминаем последнее направление
    // стрелок — сработает, даже если стрелку отпустили чуть раньше кнопки
    if (this.shot.held) {
      if (Math.hypot(x, z) > 0.3) this.shotAim = { x, z };
    } else if (this.shot.consumePeek() === null) {
      this.shotAim = null; // замаха нет и удар не ждёт исполнения — прицел сброшен
    }
  }

  // Стейт-машина навеса (PES): удержание A копит полоску; после отпускания —
  // окно tapWindow («замах ноги»), каждый новый тап A повышает тип: ×1 высокий,
  // ×2 настильный, ×3 низовой прострел. По истечении окна — событие.
  _feedCross(dt, heldNow) {
    const c = this._cross;
    const justPressed = heldNow && !c.prevHeld;
    c.prevHeld = heldNow;

    const CT = CONFIG.player.chargeTime;
    const cap = CONFIG.player.chargeOverCap;

    switch (c.state) {
      case 'idle':
        if (justPressed) {
          c.state = 'charging';
          c.charge = 0;
          c.taps = 1;
        }
        break;
      case 'charging':
        if (heldNow) {
          c.charge = Math.min(c.charge + dt / CT, cap);
        } else {
          c.state = 'window';
          c.timer = CONFIG.cross.tapWindow;
        }
        break;
      case 'window':
        if (justPressed) c.taps = Math.min(c.taps + 1, 3);
        c.timer -= dt;
        if (c.timer <= 0) {
          this._crossEvent = { charge: Math.max(0.15, c.charge), taps: c.taps };
          c.state = heldNow ? 'blocked' : 'idle'; // дожатую A не считаем новой полоской
        }
        break;
      case 'blocked':
        if (!heldNow) c.state = 'idle';
        break;
    }
  }

  consumeCross() {
    const v = this._crossEvent;
    this._crossEvent = null;
    return v; // null или {charge: 0.15..1.3, taps: 1..3}
  }

  // Для шкалы силы в UI
  get charging() {
    return this.pass.held || this.through.held || this.shot.held || this._cross.state === 'charging';
  }

  get chargeLevel() {
    let m = 0;
    for (const a of [this.pass, this.through, this.shot]) {
      if (a.held) m = Math.max(m, a.charge01);
    }
    if (this._cross.state === 'charging') m = Math.max(m, this._cross.charge);
    return m;
  }
}
