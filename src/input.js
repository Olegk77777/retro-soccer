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

    this.sprint = false; // E / ⚡ на таче / RB на геймпаде — мяч хуже контролируется

    this._padMove = { x: 0, z: 0 };
    this._pad = { pass: false, shot: false, cross: false, through: false, sprint: false };
    this._touch = { pass: false, shot: false, sprint: false, cross: false, through: false };
    this._swipeEvent = null; // свайп-удар с тача: {dir, power, curl}

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
    bindHold('btn-sprint', 'sprint');
    // Навесы и пас на ход на таче — только жестом-свайпом («как нарисовал, так и полетело»)

    this._initSwipe();
  }

  // Свайп-удар в правой зоне экрана (как в FIFA Mobile / Score! Hero):
  // направление пальца — куда, длина — сила, ИЗГИБ траектории — подкрутка.
  // Пока палец рисует — на #gesture-viz след и кольцо силы (ненавязчиво).
  _initSwipe() {
    this._swipe = { id: null, pts: [] };

    const viz = document.getElementById('gesture-viz');
    const vctx = viz ? viz.getContext('2d') : null;
    const fitViz = () => {
      if (viz) { viz.width = window.innerWidth; viz.height = window.innerHeight; }
    };
    fitViz();
    window.addEventListener('resize', fitViz);
    const clearViz = () => { if (vctx) vctx.clearRect(0, 0, viz.width, viz.height); };
    const drawViz = () => {
      if (!vctx) return;
      const pts = this._swipe.pts;
      clearViz();
      if (pts.length < 2) return;
      const a = pts[0];
      const b = pts[pts.length - 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const power = Math.min(1.3, len / (window.innerHeight * 0.35));
      // цвета шкалы замаха: жёлтый, в передержке — красный
      const col = power > 1 ? 'rgba(224,74,48,0.85)' : 'rgba(232,212,77,0.7)';
      // след пальца — сама траектория (изгиб = подкрутка виден глазами)
      vctx.beginPath();
      vctx.moveTo(pts[0].x, pts[0].y);
      for (const p of pts) vctx.lineTo(p.x, p.y);
      vctx.strokeStyle = col;
      vctx.lineWidth = 5;
      vctx.lineCap = 'round';
      vctx.lineJoin = 'round';
      vctx.stroke();
      // кольцо силы вокруг начальной точки: заполняется с длиной свайпа
      vctx.beginPath();
      vctx.arc(a.x, a.y, 26, -Math.PI / 2, -Math.PI / 2 + (power / 1.3) * Math.PI * 2);
      vctx.strokeStyle = col;
      vctx.lineWidth = 3;
      vctx.stroke();
      // точка-кончик
      vctx.beginPath();
      vctx.arc(b.x, b.y, 6, 0, Math.PI * 2);
      vctx.fillStyle = col;
      vctx.fill();
    };

    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      if (e.clientX <= window.innerWidth * 0.55) return; // левая зона — стик
      if (e.target && e.target.classList && e.target.classList.contains('tbtn')) return;
      if (this._swipe.id !== null) return;
      this._swipe.id = e.pointerId;
      this._swipe.pts = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }];
    });
    window.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._swipe.id) return;
      this._swipe.pts.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
      drawViz();
    });
    const endSwipe = (e) => {
      if (e.pointerId !== this._swipe.id) return;
      const pts = this._swipe.pts;
      this._swipe.id = null;
      clearViz(); // жест закончен — след убираем сразу
      if (pts.length < 3) return;
      const a = pts[0];
      const b = pts[pts.length - 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 36) return; // слишком короткий — не свайп

      // Сила: длина свайпа относительно трети экрана
      const power = Math.min(1.3, Math.max(0.2, len / (window.innerHeight * 0.35)));

      // Скорость жеста (экранов в секунду): медленный — свеча, резкий — прострел
      const durMs = Math.max(1, (pts[pts.length - 1].t || 0) - (a.t || 0));
      let speed = (len / window.innerHeight) / (durMs / 1000);
      if (durMs < 40) speed = 2; // защита от синтетических событий

      // Подкрутка: насколько середина траектории отклонилась от прямой (со знаком)
      const m = pts[(pts.length / 2) | 0];
      const devSigned = ((m.x - a.x) * dy - (m.y - a.y) * dx) / len; // px, >0 — палец гнул вправо
      const curl01 = Math.max(-1, Math.min(1, devSigned / (len * 0.25)));

      // Экран → мир: вправо = +X, вверх экрана = -Z
      this._swipeEvent = {
        dir: { x: dx / len, z: dy / len },
        power,
        speed,
        curl: curl01,
      };
    };
    window.addEventListener('pointerup', endSwipe);
    window.addEventListener('pointercancel', endSwipe);
  }

  consumeSwipe() {
    const v = this._swipeEvent;
    this._swipeEvent = null;
    return v;
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
    this._pad.sprint = btn(5);  // RB / R1 — спринт, как в PES
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
    this.through.feed(dt, this.keys.has('KeyW') || this._pad.through || this._touch.through);
    this.shot.feed(dt, this.keys.has('KeyD') || this._pad.shot || this._touch.shot);

    // Навес: полоска → окно тапов → событие {charge, taps}
    this._feedCross(dt, this.keys.has('KeyA') || this._pad.cross || this._touch.cross);

    // Спринт — простое удержание
    this.sprint = this.keys.has('KeyE') || this._pad.sprint || this._touch.sprint;

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
