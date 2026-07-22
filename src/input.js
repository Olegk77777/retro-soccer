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

  cancel() {
    this.held = false;
    this.t = 0;
    this._edge = null;
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
    // Пас и пас на ход — своя БЫСТРАЯ шкала (passChargeTime): тап = резкая
    // передача, держать долго не нужно. Навес остаётся на медленной полоске
    this.pass = new ChargeAction(CONFIG.player.passChargeTime, cap);    // S / геймпад A
    this.through = new ChargeAction(CONFIG.player.passChargeTime, cap); // W / геймпад Y
    this.shot = new ChargeAction(CONFIG.shot.chargeTime, cap);          // D / геймпад X

    // Навес (A / геймпад B) — своя стейт-машина, как в PES: полоска, затем
    // окно «замаха ноги», где доп. тапы меняют тип навеса (×1 / ×2 / ×3)
    this._cross = { state: 'idle', charge: 0, taps: 0, timer: 0, prevHeld: false };
    this._crossEvent = null;
    this._crossPressEdge = false; // фронт нажатия: в обороне это ПОДКАТ

    this.sprint = false; // E / ⚡ на таче / RB на геймпаде — мяч хуже контролируется

    this._padMove = { x: 0, z: 0 };
    this._pad = { pass: false, shot: false, cross: false, through: false, sprint: false };
    this._touch = { pass: false, shot: false, sprint: false, cross: false, through: false };
    this._swipeEvent = null; // свайп-удар с тача: {dir, power, curl}

    // Смена управляемого игрока (Фаза 2): Q / LB — событие-«фронт», не удержание.
    // Та же кнопка УДЕРЖАНИЕМ работает модификатором СТЕНОЧКИ (Q+ПАС)
    this._switchQueued = false;
    this._padSwitchPrev = false;
    this._padSwitchHeld = false;

    window.addEventListener('keydown', (e) => {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyQ') this._switchQueued = true;
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
    bindHold('btn-sprint', 'sprint');

    // Кнопка ⇄ — смена игрока: событие по касанию (как Q), не удержание
    const switchBtn = document.getElementById('btn-switch');
    if (switchBtn) {
      switchBtn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this._switchQueued = true;
      });
    }
    // Навесы и пас на ход на таче — только жестом-свайпом («как нарисовал, так и полетело»)

    this._initSwipe();
  }

  // Два жеста с общей визуализацией:
  // - круг НАВЕС: свободный росчерк в правой зоне;
  // - кнопка УДАР: тап/удержание сохраняет обычный удар, а движение пальца
  //   превращает кнопку в направленный удар с нарисованной траекторией.
  // Направление пальца — куда, длина — сила, ИЗГИБ — подкрутка.
  _initSwipe() {
    this._swipe = { id: null, pts: [], kind: null, active: false };

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

    const shotBtn = document.getElementById('btn-shoot');
    shotBtn.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || this._swipe.id !== null) return;
      e.preventDefault();
      e.stopPropagation();
      shotBtn.setPointerCapture?.(e.pointerId);
      shotBtn.classList.add('gesture-active');
      this._touch.shot = true; // пока палец стоит — прежний замах кнопкой
      this._swipe.id = e.pointerId;
      this._swipe.kind = 'shot';
      this._swipe.active = false;
      this._swipe.pts = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }];
    });

    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      if (e.clientX <= window.innerWidth * 0.55) return; // левая зона — стик
      if (e.target && e.target.classList && e.target.classList.contains('tbtn')) return;
      if (this._swipe.id !== null) return;
      this._swipe.id = e.pointerId;
      this._swipe.kind = 'cross';
      this._swipe.active = true;
      this._swipe.pts = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }];
    });
    window.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._swipe.id) return;
      this._swipe.pts.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
      if (this._swipe.kind === 'shot' && !this._swipe.active) {
        const a = this._swipe.pts[0];
        if (Math.hypot(e.clientX - a.x, e.clientY - a.y) < 28) return;
        // Палец явно пошёл рисовать: отменяем накопленный обычный замах,
        // чтобы после жеста не вылетели два мяча подряд.
        this._swipe.active = true;
        this._touch.shot = false;
        this.shot.cancel();
      }
      drawViz();
    });
    const endSwipe = (e, cancelled = false) => {
      if (e.pointerId !== this._swipe.id) return;
      const pts = this._swipe.pts;
      const kind = this._swipe.kind;
      const active = this._swipe.active;
      this._swipe.id = null;
      this._swipe.kind = null;
      this._swipe.active = false;
      if (kind === 'shot') {
        this._touch.shot = false;
        if (cancelled) this.shot.cancel();
        shotBtn.classList.remove('gesture-active');
      }
      clearViz(); // жест закончен — след убираем сразу
      if (cancelled || (kind === 'shot' && !active)) return;
      if (pts.length < 2) {
        // Тап без движения в правой зоне: в обороне это подкат (круг ПОДКАТ)
        if (kind === 'cross') this._crossPressEdge = true;
        return;
      }
      const a = pts[0];
      const b = pts[pts.length - 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < (kind === 'shot' ? 28 : 36)) {
        // Короткий росчерк-тап — тоже подкат в обороне, не свайп
        if (kind === 'cross') this._crossPressEdge = true;
        return;
      }

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
        kind,
        dir: { x: dx / len, z: dy / len },
        power,
        speed,
        curl: curl01,
      };
    };
    window.addEventListener('pointerup', (e) => endSwipe(e));
    window.addEventListener('pointercancel', (e) => endSwipe(e, true));
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
    this._padSwitchHeld = false;
    if (!p) return;
    const ax = p.axes[0] || 0;
    const ay = p.axes[1] || 0;
    if (Math.hypot(ax, ay) > 0.22) { this._padMove.x = ax; this._padMove.z = ay; }
    const btn = (i) => !!(p.buttons[i] && p.buttons[i].pressed);
    // Правый триггер RT/R2 (7) — аналоговый: считаем нажатым и по value,
    // чтобы спринт ловился от лёгкого выжима, а не только «до упора».
    const trig = (i) => { const b = p.buttons[i]; return !!b && (b.pressed || b.value > 0.35); };
    this._pad.pass = btn(0);    // A / крест — пас
    this._pad.shot = btn(1);    // B / круг — удар (по просьбе Олега поменян местами с навесом)
    this._pad.cross = btn(2);   // X / квадрат — навес (поменян местами с ударом)
    this._pad.through = btn(3); // Y / треугольник — пас на ход
    this._pad.sprint = trig(7); // RT / R2 (дальний правый курок) — спринт, перенесён с бампера RB
    // LB / L1 — смена управляемого игрока (по фронту нажатия, как Q);
    // удержание LB — модификатор стеночки (LB+пас)
    const sw = btn(4);
    if (sw && !this._padSwitchPrev) this._switchQueued = true;
    this._padSwitchPrev = sw;
    this._padSwitchHeld = sw;
  }

  // Модификатор комбо: Q (клавиатура) или LB/L1 (геймпад) удерживается.
  // С мячом Q+ПАС / LB+ПАС = СТЕНОЧКА: отдал — и рванул вперёд
  get comboHeld() {
    return this.keys.has('KeyQ') || this._padSwitchHeld;
  }

  // Смена игрока: одноразовое событие (Q / LB); на планшете — только авто
  consumeSwitch() {
    const v = this._switchQueued;
    this._switchQueued = false;
    return v;
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
    if (justPressed) this._crossPressEdge = true; // мгновенный смысл кнопки (подкат)

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

  // Фронт нажатия кнопки навеса: в обороне это ПОДКАТ (исполняется по
  // нажатию, как ○ в PES, — ждать отпускания полоски нельзя)
  consumeCrossPress() {
    const v = this._crossPressEdge;
    this._crossPressEdge = false;
    return v;
  }

  // Нажатие ушло в подкат — полоску навеса гасим, чтобы на отпускании
  // не вылетел невольный навес из положения лёжа
  cancelCross() {
    const c = this._cross;
    c.state = c.prevHeld ? 'blocked' : 'idle';
    c.charge = 0;
    c.taps = 0;
    this._crossEvent = null;
  }

  // Кнопка действия уже обещает удар по мячу, даже если событие ещё не
  // выпущено. Для навеса сюда входит и 0,3-секундное окно второго/третьего
  // тапа: ноги не должны принять стрелки прицела за новый курс бега.
  get strikeCommitted() {
    return this.pass.held || this.pass.consumePeek() !== null ||
      this.through.held || this.through.consumePeek() !== null ||
      this.shot.held || this.shot.consumePeek() !== null ||
      this._cross.state === 'charging' || this._cross.state === 'window' ||
      this._crossEvent !== null;
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
