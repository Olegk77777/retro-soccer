// Корпус телевизора: аналоговые ручки и геометрия стекла.
//
// Здесь ровно две вещи, и обе — про то, что игра теперь живёт ВНУТРИ рамки,
// а не во весь экран:
//   1) screenRect() — прямоугольник стекла. Всё, что считалось от размеров
//      окна (виртуальный стик, зоны свайпа, сила жеста), обязано считаться
//      от него, иначе половина управления уедет под пластик корпуса.
//   2) Knob — живая ручка. Крутится мышью, пальцем и колесом, двойной щелчок
//      возвращает в середину; значение отдаётся наружу колбэком.
//
// Смысл ручек задаёт main.js — здесь только механика, как и положено виджету.

// --- Геометрия стекла ------------------------------------------------------

let _el = null;
let _rect = { left: 0, top: 0, width: 1, height: 1 };
let _dirty = true;

function markDirty() { _dirty = true; }
window.addEventListener('resize', markDirty);
window.addEventListener('orientationchange', markDirty);

// Прямоугольник экрана телевизора в координатах окна. Кэшируется: его дёргают
// на каждом касании, а getBoundingClientRect заставляет браузер пересчитывать
// раскладку. Сбрасывается только по resize.
export function screenRect() {
  if (!_el) _el = document.getElementById('tv-screen');
  if (_dirty && _el) {
    const r = _el.getBoundingClientRect();
    _rect = { left: r.left, top: r.top, width: r.width || 1, height: r.height || 1 };
    _dirty = false;
  }
  return _rect;
}

// Палец лёг НА СТЕКЛО, а не на корпус? Панель ручек лежит вне экрана, но
// слушатели управления висят на window — без этой проверки касание ручки на
// планшете заодно взводило бы жест навеса.
export function onScreen(e) {
  const r = screenRect();
  const p = toScreen(e);
  return p.x >= 0 && p.y >= 0 && p.x <= r.width && p.y <= r.height;
}

// Событие указателя → координаты ВНУТРИ стекла. Оверлей игры прибит к стеклу
// (см. #tv-screen в index.html), а clientX/clientY приходят от окна.
export function toScreen(e) {
  const r = screenRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// --- Аналоговая ручка ------------------------------------------------------

const SWEEP = 280;                    // градусов от упора до упора
const HALF = SWEEP / 2;

export class Knob {
  // opts: { min, max, value, def, step, format(v), onChange(v) }
  // step > 0 делает ручку ДИСКРЕТНОЙ (щёлкает по позициям) — так устроен «канал».
  constructor(el, opts) {
    this.el = el;
    this.min = opts.min ?? 0;
    this.max = opts.max ?? 1;
    this.step = opts.step || 0;
    this.def = opts.def ?? opts.value ?? this.min;
    this.format = opts.format || ((v) => String(Math.round(v)));
    this.onChange = opts.onChange || (() => {});

    el.innerHTML =
      '<div class="knob-dial"><div class="knob-cap"></div></div>' +
      `<div class="knob-name">${el.dataset.name || ''}</div>` +
      '<div class="knob-val"></div>';
    this.cap = el.querySelector('.knob-cap');
    this.valEl = el.querySelector('.knob-val');

    this._drag = null;
    el.addEventListener('pointerdown', (e) => this._down(e));
    el.addEventListener('pointermove', (e) => this._move(e));
    el.addEventListener('pointerup', (e) => this._up(e));
    el.addEventListener('pointercancel', (e) => this._up(e));
    el.addEventListener('dblclick', () => this.set(this.def));
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = e.deltaY < 0 ? 1 : -1;
      this.set(this.value + d * (this.step || (this.max - this.min) / 40));
    }, { passive: false });

    this.set(opts.value ?? this.def, false);
  }

  // Диапазон у «канала» кольцевой: с последнего щелчка возвращаемся на первый,
  // как на барабане переключателя. У плавных ручек — обычные упоры.
  _clamp(v) {
    if (this.step) {
      const n = Math.round((this.max - this.min) / this.step) + 1;
      let i = Math.round((v - this.min) / this.step);
      i = ((i % n) + n) % n;
      return this.min + i * this.step;
    }
    return Math.max(this.min, Math.min(this.max, v));
  }

  set(v, notify = true) {
    const nv = this._clamp(v);
    const changed = nv !== this.value;
    this.value = nv;
    const t = (nv - this.min) / (this.max - this.min || 1);
    this.cap.style.transform = `rotate(${-HALF + t * SWEEP}deg)`;
    this.valEl.textContent = this.format(nv);
    if (notify && changed) this.onChange(nv);
  }

  // Угол пальца относительно центра шайбы
  _angle(e) {
    const r = this.cap.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    // Вплотную к центру угол шумит и ручка дёргается — там жест не считаем
    if (Math.hypot(dx, dy) < 9) return null;
    return Math.atan2(dy, dx);
  }

  _down(e) {
    this.el.setPointerCapture?.(e.pointerId);
    this._drag = { id: e.pointerId, prev: this._angle(e), acc: 0, base: this.value };
    e.preventDefault();
  }

  // Крутим по НАКОПЛЕННОМУ углу, а не по абсолютному: иначе ручка прыгает в
  // положение пальца в момент захвата, и плавно подвести значение невозможно.
  _move(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    const a = this._angle(e);
    if (a === null) return;
    if (d.prev === null) { d.prev = a; return; }
    let da = a - d.prev;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    d.prev = a;
    d.acc += da * 180 / Math.PI;
    this.set(d.base + (d.acc / SWEEP) * (this.max - this.min));
  }

  _up(e) {
    if (this._drag && e.pointerId === this._drag.id) this._drag = null;
  }
}
