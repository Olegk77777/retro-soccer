// Единый слой ввода: клавиатура + геймпад + тач (виртуальный стик и кнопки).
// Наружу отдаёт вектор движения move (-1..1) и события: пас, удар (с силой замаха).

import { CONFIG } from './config.js';

export class Input {
  constructor() {
    this.keys = new Set();
    this.move = { x: 0, z: 0 };
    this.charge = 0;         // сколько секунд держится кнопка удара
    this.charging = false;
    this._passEdge = false;  // «пас нажат» (одноразовое событие)
    this._shotEdge = null;   // сила удара 0..1 в момент отпускания
    this._kbShoot = false;
    this._padShoot = false;
    this._touchShoot = false;
    this._padMove = { x: 0, z: 0 };
    this._padPassPrev = false;

    window.addEventListener('keydown', (e) => {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyX' || e.code === 'KeyK') this._passEdge = true;
      if (e.code === 'Space' || e.code === 'KeyL') this._kbShoot = true;
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Space' || e.code === 'KeyL') this._kbShoot = false;
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

    const pass = document.getElementById('btn-pass');
    const shoot = document.getElementById('btn-shoot');
    pass.addEventListener('pointerdown', (e) => { e.stopPropagation(); this._passEdge = true; });
    const shootUp = (e) => { e.stopPropagation(); this._touchShoot = false; };
    shoot.addEventListener('pointerdown', (e) => { e.stopPropagation(); this._touchShoot = true; });
    shoot.addEventListener('pointerup', shootUp);
    shoot.addEventListener('pointercancel', shootUp);
  }

  _pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const p = Array.from(pads).find((g) => g && g.connected);
    this._padMove.x = 0;
    this._padMove.z = 0;
    this._padShoot = false;
    if (!p) return;
    const ax = p.axes[0] || 0;
    const ay = p.axes[1] || 0;
    if (Math.hypot(ax, ay) > 0.22) { this._padMove.x = ax; this._padMove.z = ay; }
    const passBtn = !!(p.buttons[0] && p.buttons[0].pressed);  // A / крест — пас
    this._padShoot = !!(p.buttons[2] && p.buttons[2].pressed); // X / квадрат — удар
    if (passBtn && !this._padPassPrev) this._passEdge = true;
    this._padPassPrev = passBtn;
  }

  update(dt) {
    this._pollGamepad();

    // Складываем все источники движения (экран: вверх = от камеры, то есть -Z)
    let x = 0;
    let z = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) z -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) z += 1;
    x += this._padMove.x + this._stick.x;
    z += this._padMove.z + this._stick.y;
    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }
    this.move.x = x;
    this.move.z = z;

    // Замах удара: держим — копится сила, отпустили — событие с силой 0..1
    const held = this._kbShoot || this._padShoot || this._touchShoot;
    if (held) {
      this.charging = true;
      this.charge = Math.min(this.charge + dt, CONFIG.player.chargeTime);
    } else if (this.charging) {
      this._shotEdge = this.charge / CONFIG.player.chargeTime;
      this.charging = false;
      this.charge = 0;
    }
  }

  consumePass() {
    const v = this._passEdge;
    this._passEdge = false;
    return v;
  }

  consumeShot() {
    const v = this._shotEdge;
    this._shotEdge = null;
    return v; // null, если удара не было; иначе сила 0..1
  }
}
