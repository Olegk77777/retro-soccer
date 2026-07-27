// Серпантин и бумажный дождь на выходе команд.
//
// Примета трансляций 90-х не хуже файеров: фанатский сектор встречает своих
// тучей бумаги — длинные ленты рулонов и мелкие клочки. Летит это с трибуны
// на дорожку и частью до газона, кувыркается и оседает.
//
// Кувыркание сделано БЕЗ вращения в пространстве: у ленты, повёрнутой ребром
// к камере, видимая ШИРИНА сжимается до нуля и обратно. Отсюда фирменное
// мерцание падающей бумаги — и стоит оно один косинус на частицу, а не
// матрицу поворота.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { QuadPool } from './quadpool.js';

export class Confetti {
  // flares — источник фанатских секторов: у пиротехники и бумаги они одни
  // и те же, и знать их должен кто-то один.
  constructor(scene, flares) {
    const C = CONFIG.atmosphere.confetti;
    this.cfg = C;
    this.flares = flares;
    this.level = 1;
    this.time = 0;

    this.pool = new QuadPool(scene, C.max, {
      kind: 'flat',
      renderOrder: 5,
    });

    this.bits = [];
    for (let i = 0; i < C.max; i++) {
      this.bits.push({
        life: 0, span: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        w: 0, h: 0, rot: 0, spin: 0, flip: 0, flipRate: 0,
        r: 1, g: 1, b: 1, swayX: 0, swayZ: 0, sway: 0, swayRate: 0,
      });
    }
    this.next = 0;
  }

  setLevel(k) {
    this.level = Math.max(0, k);
  }

  get active() {
    let n = 0;
    for (const b of this.bits) if (b.life > 0) n++;
    return n;
  }

  // Залп с фанатского сектора стороны side. colors — цвета формы команды;
  // белый подмешивается всегда, газетная бумага была основным «снарядом».
  burst({ side = 0, count = 0, colors = null } = {}) {
    const C = this.cfg;
    const n = Math.round((count || C.burstCount) * this.level);
    if (n <= 0 || !this.flares) return 0;
    const spots = this.flares.sectorSpots(side);
    if (!spots.length) return 0;

    const palette = [];
    for (const c of (colors && colors.length ? colors : [C.fallback])) {
      const col = new THREE.Color(c);
      palette.push([col.r, col.g, col.b]);
    }
    // Белый идёт с весом: рулон серпантина цветной, а бумажный дождь — нет
    for (let i = 0; i < C.whiteShare; i++) palette.push(C.white);

    let born = 0;
    for (let i = 0; i < n; i++) {
      const s = spots[(Math.random() * spots.length) | 0];
      const col = palette[(Math.random() * palette.length) | 0];
      // Лента или клочок: доля лент задана в конфиге
      const ribbon = Math.random() < C.ribbonShare;
      this._spawn(s, col, ribbon);
      born++;
    }
    return born;
  }

  _spawn(s, col, ribbon) {
    const C = this.cfg;
    const b = this.bits[this.next];
    this.next = (this.next + 1) % this.bits.length;

    b.span = (ribbon ? C.ribbonLife : C.bitLife) * (0.7 + Math.random() * 0.6);
    b.life = b.span;
    // Бросают с трибуны вперёд и вверх, с приличным разбросом
    b.x = s.x + (Math.random() - 0.5) * C.spread;
    b.y = s.y + (Math.random() - 0.5) * C.spread * 0.5;
    b.z = s.z + (Math.random() - 0.5) * C.spread;
    const push = C.throw * (0.5 + Math.random());
    b.vx = s.inX * push + (Math.random() - 0.5) * 1.2;
    b.vz = s.inZ * push + (Math.random() - 0.5) * 1.2;
    b.vy = C.throwUp * (0.4 + Math.random());

    b.w = ribbon ? C.ribbonWidth : C.bitSize * (0.7 + Math.random() * 0.6);
    b.h = ribbon ? C.ribbonLength * (0.6 + Math.random() * 0.8) : b.w * (0.6 + Math.random() * 0.5);
    // Лента ПАДАЕТ, поэтому висит почти вертикально и лишь покачивается;
    // свободный поворот превращает полсотни лент в рассыпанный коробок спичек.
    // Клочок бумаги мелкий и вертится как угодно.
    b.ribbon = ribbon;
    b.rot = ribbon
      ? (Math.random() - 0.5) * C.ribbonTilt
      : Math.random() * Math.PI * 2;
    b.rot0 = b.rot;
    // Лента не ВРАЩАЕТСЯ, а качается около своего наклона: непрерывное
    // вращение за секунду уводит её в горизонталь, и падение снова читается
    // разбросанными палками.
    b.spin = ribbon ? 0 : (Math.random() - 0.5) * C.bitSpin;
    b.flip = Math.random() * Math.PI * 2;
    b.flipRate = C.flipRate * (0.5 + Math.random()) * (ribbon ? 0.6 : 1);
    b.r = col[0];
    b.g = col[1];
    b.b = col[2];
    // Ось качания при падении — своя у каждого клочка
    const a = Math.random() * Math.PI * 2;
    b.swayX = Math.cos(a);
    b.swayZ = Math.sin(a);
    b.sway = C.sway * (0.4 + Math.random());
    b.swayRate = C.swayRate * (0.6 + Math.random() * 0.8);
  }

  update(dt) {
    const C = this.cfg;
    this.time += dt;
    this.pool.begin();

    for (const b of this.bits) {
      if (b.life <= 0) continue;
      b.life -= dt;
      if (b.life <= 0) continue;

      // Бумага почти не весит: гравитация слабая, сопротивление сильное
      b.vy -= C.gravity * dt;
      const drag = Math.max(0, 1 - C.drag * dt);
      b.vx *= drag;
      b.vz *= drag;
      b.vy = Math.max(b.vy * drag, -C.fallMax);
      const sway = Math.sin(this.time * b.swayRate + b.flip) * b.sway;
      b.x += (b.vx + sway * b.swayX) * dt;
      b.y += b.vy * dt;
      b.z += (b.vz + sway * b.swayZ) * dt;
      b.flip += b.flipRate * dt;
      b.rot = b.ribbon
        ? b.rot0 + Math.sin(this.time * C.ribbonSwayRate + b.flip) * C.ribbonSway
        : b.rot + b.spin * dt;

      // Долетевшее до газона лежит и медленно гаснет — уборщики придут потом
      if (b.y <= C.restY) {
        b.y = C.restY;
        b.vx *= 0.82;
        b.vz *= 0.82;
        b.vy = 0;
        b.spin *= 0.9;
      }

      const k = 1 - b.life / b.span;
      const a = C.alpha * Math.min(1, (1 - k) / C.fade);
      if (a <= 0.004) continue;
      // Кувыркание: видимая ширина сжимается, когда клочок повернулся ребром
      const w = b.w * Math.max(C.edge, Math.abs(Math.cos(b.flip)));
      this.pool.push(b.x, b.y, b.z, w, b.h, b.rot, b.r, b.g, b.b, a);
    }

    this.pool.end();
  }
}
