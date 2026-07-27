// Пиротехника на трибунах: фанатский сектор зажигает файеры.
//
// Почему это сделано руками, а не «эффектом огня из three.js»: в three.js
// НЕТ и никогда не было готовых систем огня и дыма (проверено на r185,
// последней версии на 27.07.2026). Есть узловые материалы TSL и WebGPU —
// это инструмент, чтобы написать такой эффект самому, а не сам эффект.
// Нам это и не нужно: физически честное пламя противоречит камертону.
// Файер в трансляции 1998-го — это ПЕРЕСВЕТ на кинескопе: ослепительное
// белое ядро, цветной ореол вокруг него и столб дыма, который сносит ветром
// через лучи прожекторов. Именно это здесь и рисуется.
//
// Устройство: три пула квадов из src/quadpool.js — огонь (аддитивный),
// клубы дыма и стелющаяся пелена (лежачие квады), по одному draw call на
// каждый. Почему квады, а не THREE.Points, — там же, в шапке пула.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { QuadPool } from './quadpool.js';

// Рваное облачко дыма. Один радиальный градиент читается мыльным шариком,
// поэтому клуб набирается из нескольких смещённых пятен разной плотности.
function createSmokeTexture(size = 64) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  const r = size / 2;

  const blob = (cx, cy, rad, a) => {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(0.55, `rgba(255,255,255,${a * 0.45})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  };

  blob(r, r, r * 0.92, 0.55);
  // Четыре спутника делают силуэт неровным — облако, а не шар
  const sats = [[0.30, 0.34, 0.40], [0.70, 0.30, 0.34], [0.34, 0.70, 0.36], [0.68, 0.66, 0.42]];
  for (const [u, v, rad] of sats) blob(u * size, v * size, r * rad, 0.42);

  // Края обязаны прийти в ноль: иначе на квадрате видно шов текстуры
  const fade = ctx.getImageData(0, 0, size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - r + 0.5, y - r + 0.5) / r;
      const k = d >= 1 ? 0 : Math.min(1, (1 - d) * 3.2);
      fade.data[(y * size + x) * 4 + 3] *= k;
    }
  }
  ctx.putImageData(fade, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

// --- Места на трибунах ----------------------------------------------------

// Фанатский сектор — это компактная группа, а не «весь стадион». Берём точки
// на полотнах, попавших в нужную зону, и запоминаем для каждой направление
// «к полю»: туда файер светит и туда же сносит дым.
function collectSpots(stands, want, filter) {
  const F = CONFIG.atmosphere.flares;
  const spots = [];
  if (!stands || !stands.length) return spots;
  const local = new THREE.Vector3();

  for (const stand of stands) {
    if (!filter(stand)) continue;
    stand.updateMatrixWorld(true);
    const par = stand.geometry.parameters;
    // «Внутрь» = к центру чаши. Полотно наклонено, поэтому по горизонтали
    // берём именно направление от сектора к центру поля, а не нормаль меша.
    const inX = -stand.position.x;
    const inZ = -stand.position.z;
    const len = Math.hypot(inX, inZ) || 1;

    for (let i = 0; i < want; i++) {
      const u = (Math.random() - 0.5) * F.groupWidth;
      const v = F.minRow + Math.random() * (F.maxRow - F.minRow) - 0.5;
      // Отступ от полотна обязан быть БОЛЬШЕ, чем перекрытие соседних
      // секторов (stands.seamOverlap): полотна заходят друг за друга, и
      // факел, посаженный вплотную, у соседнего сектора оказывается ЗА ним.
      // На экране это резкая диагональ, режущая столб дыма пополам.
      local.set(u * par.width, v * par.height, F.standOffset);
      stand.localToWorld(local);
      spots.push({
        x: local.x, y: local.y, z: local.z,
        inX: inX / len, inZ: inZ / len,
      });
    }
  }
  return spots;
}

// --- Система ---------------------------------------------------------------

export class Flares {
  constructor(scene, stands) {
    const F = CONFIG.atmosphere.flares;
    this.cfg = F;
    this.stands = stands || [];
    this.time = 0;
    this.level = 1;           // множитель бюджета: настройка «Пиротехника»

    const smokeTex = createSmokeTexture();   // одна карта на клубы и на пелену
    this.smoke = new QuadPool(scene, F.smokeMax, {
      kind: 'smoke',
      map: smokeTex,
      renderOrder: 5,         // дым под огнём: сначала клубы, потом ядро
    });
    this.fire = new QuadPool(scene, F.fireMax, {
      kind: 'fire',
      renderOrder: 6,
    });
    // Пелена лежит на газоне и рисуется ПЕРВОЙ: всё остальное — над ней
    this.haze = new QuadPool(scene, F.hazeMax, {
      kind: 'smoke',
      map: smokeTex,
      renderOrder: 4,
      ground: true,
    });

    this.flares = [];
    this._sections = {};      // фанатский сектор каждой стороны, найденный раз
    // Частицы дыма — плоский пул объектов, чтобы в кадре ничего не выделять
    this.puffs = [];
    for (let i = 0; i < F.smokeMax; i++) {
      this.puffs.push({
        life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        rot: 0, spin: 0, seed: 0, wind: 1, swirlX: 0, swirlZ: 0,
      });
    }
    this.nextPuff = 0;

    // Пелена — отдельный пул: она живёт втрое дольше клуба и ведёт себя иначе
    this.hazes = [];
    for (let i = 0; i < F.hazeMax; i++) {
      this.hazes.push({ life: 0, x: 0, y: 0, z: 0, vx: 0, vz: 0, rot: 0, spin: 0 });
    }
    this.nextHaze = 0;
  }

  // Фанатский сектор стороны side (±1 по X) — ОДИН И ТОТ ЖЕ весь матч.
  // Раньше точки собирались со всех полотен виража, и пятеро с файерами
  // расползались по трети стадиона: так пиротехника не выглядит НИКОГДА,
  // фанатский вираж — это плотная кучка в одном секторе.
  _sectionFor(side) {
    const T = CONFIG.track;
    const F = this.cfg;
    const key = side >= 0 ? 'plus' : 'minus';
    if (this._sections[key]) return this._sections[key];

    // Целимся в стык дальней прямой с виражом: строго за воротами сектор с
    // рабочей ТВ-камеры почти не виден, а этот угол попадает в кадр при
    // любой атаке на те ворота.
    const aimX = Math.sign(side || 1) * (T.straightHalf + 10);
    const aimZ = -T.innerRadius;
    let best = null;
    let bestD = Infinity;
    for (const st of this.stands) {
      if (Math.sign(st.position.x) !== Math.sign(side || 1)) continue;
      if (Math.abs(st.position.x) < T.straightHalf * F.curveFrom) continue;
      const d = Math.hypot(st.position.x - aimX, st.position.z - aimZ);
      if (d < bestD) {
        bestD = d;
        best = st;
      }
    }
    this._sections[key] = best ? [best] : [];
    return this._sections[key];
  }

  sectorSpots(side) {
    const section = this._sectionFor(side);
    if (!section.length) return [];
    return collectSpots(section, this.cfg.spotsPerSection, () => true);
  }

  // Зажечь группу файеров. side — половина стадиона (±1), color — цвет
  // ореола (обычно форма команды; ядро всегда белое, как у магния).
  ignite({ side = 0, count = 0, color = null } = {}) {
    const F = this.cfg;
    const n = Math.round((count || F.burstCount) * this.level);
    if (n <= 0) return 0;
    const spots = this.sectorSpots(side);
    if (!spots.length) return 0;

    const tint = new THREE.Color(color !== null && color !== undefined ? color : F.color);
    // Слишком тёмная форма даёт грязный ореол: файер — источник СВЕТА,
    // он всегда яркий, цвет только подкрашивает его.
    const hsl = { h: 0, s: 0, l: 0 };
    tint.getHSL(hsl);
    tint.setHSL(hsl.h, Math.min(1, hsl.s * F.tintSat), Math.max(F.tintMinL, hsl.l));

    // Тасуем и берём подряд: случайный выбор с возвратом сажал два факела
    // в одну точку, и они складывались в одно пятно двойной яркости.
    for (let i = spots.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = spots[i];
      spots[i] = spots[j];
      spots[j] = t;
    }

    let lit = 0;
    for (let i = 0; i < n && i < spots.length; i++) {
      if (this.flares.length >= F.maxLive) break;
      const s = spots[i];
      this.flares.push({
        x: s.x, y: s.y, z: s.z,
        inX: s.inX, inZ: s.inZ,
        age: -Math.random() * F.igniteSpread,     // зажигают не разом
        life: F.life * (0.75 + Math.random() * 0.5),
        seed: Math.random() * 100,
        debt: 0,                                  // накопленная доля частицы дыма
        hazeDebt: 0,                              // то же для пелены
        r: tint.r, g: tint.g, b: tint.b,
      });
      lit++;
    }
    return lit;
  }

  // Настройка «Пиротехника»: 0 — выкл, 1 — как задумано, 1.6 — вовсю
  setLevel(k) {
    this.level = Math.max(0, k);
    if (this.level === 0) this.flares.length = 0;
  }

  get active() {
    return this.flares.length;
  }

  update(dt) {
    const F = this.cfg;
    this.time += dt;
    this.smoke.begin();
    this.fire.begin();
    this.haze.begin();

    // 1) Файеры: горение, дрожание пламени, рождение дыма
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i];
      f.age += dt;
      if (f.age >= f.life) {
        this.flares.splice(i, 1);
        continue;
      }
      if (f.age < 0) continue;                    // ещё не подожгли

      // Огибающая: резкая вспышка поджига, ровное горение, спад в конце
      const ignite = Math.min(1, f.age / F.igniteTime);
      const flash = 1 + (1 - ignite) * (1 - ignite) * F.igniteFlash;
      const tail = Math.min(1, (f.life - f.age) / F.fadeTime);
      // Шипящее пламя никогда не стоит ровно: две несоизмеримые синусоиды
      // дают неповторяющееся дрожание без единого вызова random в кадре
      const t = this.time * F.flicker + f.seed;
      const jitter = 1 + F.flickerDepth * (Math.sin(t) * 0.6 + Math.sin(t * 2.37) * 0.4);
      const power = ignite * tail * flash * jitter;

      const y = f.y;
      // Три слоя одного источника: широкое зарево на секторе, ореол пламени
      // и добела раскалённое ядро. Порядок от большого к малому.
      this.fire.push(f.x, y, f.z, F.glowSize, F.glowSize, 0, f.r, f.g, f.b, F.glowAlpha * power);
      const halo = F.haloSize * (0.9 + 0.2 * jitter);
      this.fire.push(f.x, y, f.z, halo, halo, 0, f.r, f.g, f.b, F.haloAlpha * power);
      // Ядро файера — самая яркая точка кадра и единственный настоящий
      // источник на трибуне. Оно уходит ВЫШЕ единицы (coreGain), поэтому
      // тонмаппинг сводит его плечом в горячее белое с тёплым ореолом,
      // а не срезает в плоский блин. Ореол и зарево остаются в LDR: они
      // и есть рассеянный свет этого ядра, второй раз светить им нечем.
      const cg = F.coreGain;
      this.fire.push(f.x, y, f.z, F.coreSize, F.coreSize, 0, cg, cg * 0.96, cg * 0.90, Math.min(1, power));

      // Дым: копим дробную часть, иначе на низком темпе частицы не родятся
      f.debt += F.smokeRate * dt * ignite * tail;
      while (f.debt >= 1) {
        f.debt -= 1;
        this._spawnPuff(f);
      }
      // И редкая порция пелены: остывший дым сползает с трибуны на поле
      f.hazeDebt += F.hazeRate * dt * ignite * tail;
      while (f.hazeDebt >= 1) {
        f.hazeDebt -= 1;
        this._spawnHaze(f);
      }
    }

    // 2) Дым: подъём, снос ветром, рост и растворение
    const W = F.wind;
    for (const p of this.puffs) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy += F.buoyancy * dt;                    // тёплый дым разгоняется вверх
      // Ветер у каждого клуба свой (p.wind — личная доля): один общий вектор
      // выстраивал все клубы в ровную струю из шланга.
      p.vx += (W.x * p.wind - p.vx) * Math.min(1, F.windGrab * dt);
      p.vz += (W.z * p.wind - p.vz) * Math.min(1, F.windGrab * dt);
      // Турбулентность: клуб блуждает вбок по своей фазе. Дешёвая замена
      // завихрениям — без неё столб дыма стоит колом.
      const sw = Math.sin(this.time * F.swirlRate + p.seed) * F.swirl;
      p.x += (p.vx + sw * p.swirlX) * dt;
      p.y += p.vy * dt;
      p.z += (p.vz + sw * p.swirlZ) * dt;
      p.rot += p.spin * dt;

      const k = 1 - p.life / F.smokeLife;         // 0 родился → 1 растаял
      const size = F.smokeSize + (F.smokeGrow - F.smokeSize) * k;
      // Плотность: быстро набирает и долго тает — так и ведёт себя клуб
      const a = F.smokeAlpha * Math.min(1, k / F.smokeRise) * (1 - k) * (1 - k);
      if (a <= 0.004) continue;
      // Дым белеет кверху: внизу его красит сам файер, выше — только мачты
      const lift = Math.min(1, k / 0.45);
      const r = F.smokeLow[0] + (F.smokeHigh[0] - F.smokeLow[0]) * lift;
      const g = F.smokeLow[1] + (F.smokeHigh[1] - F.smokeLow[1]) * lift;
      const b = F.smokeLow[2] + (F.smokeHigh[2] - F.smokeLow[2]) * lift;
      this.smoke.push(p.x, p.y, p.z, size, size, p.rot, r, g, b, a);
    }

    // 3) Пелена: медленно наползает на газон, растекается и тает
    for (const h of this.hazes) {
      if (h.life <= 0) continue;
      h.life -= dt;
      if (h.life <= 0) continue;
      // Трение о газон: пелена не летит, а расползается и останавливается
      const drag = Math.max(0, 1 - F.hazeDrag * dt);
      h.vx *= drag;
      h.vz *= drag;
      h.x += h.vx * dt;
      h.z += h.vz * dt;
      h.rot += h.spin * dt;

      const k = 1 - h.life / F.hazeLife;
      const size = F.hazeSize + (F.hazeGrow - F.hazeSize) * k;
      // Трапеция, а не колокол: пелена проступает, ДЕРЖИТСЯ и тает. Прежний
      // множитель (1-k)² давил её уже к середине жизни — на ночном газоне
      // от заявленных 0.22 оставалось 0.05, то есть ничего.
      const a = F.hazeAlpha
        * Math.min(1, k / F.hazeRise)
        * Math.min(1, (1 - k) / F.hazeFade);
      if (a <= 0.004) continue;
      this.haze.push(h.x, F.hazeY, h.z, size, size, h.rot,
        F.hazeColor[0], F.hazeColor[1], F.hazeColor[2], a);
    }

    this.haze.end();
    this.smoke.end();
    this.fire.end();
  }

  // Пелена рождается НЕ у факела, а внизу под сектором: это остывший дым,
  // уже сползший вдоль трибуны. Так у неё нет фазы «горизонтальный блин
  // висит в воздухе», которая выдала бы приём с первого взгляда.
  _spawnHaze(f) {
    const F = this.cfg;
    const h = this.hazes[this.nextHaze];
    this.nextHaze = (this.nextHaze + 1) % this.hazes.length;
    const out = F.hazeStart + Math.random() * F.hazeStartSpread;
    h.life = F.hazeLife;
    h.x = f.x + f.inX * out;
    h.z = f.z + f.inZ * out;
    // Ползёт к полю, слегка вдоль — ветер тот же, что несёт дым наверху
    h.vx = f.inX * F.hazeDrift + F.wind.x * F.hazeWind;
    h.vz = f.inZ * F.hazeDrift + F.wind.z * F.hazeWind;
    h.rot = Math.random() * Math.PI * 2;
    h.spin = (Math.random() - 0.5) * F.hazeSpin;
  }

  _spawnPuff(f) {
    const F = this.cfg;
    // Кольцевой буфер: самый старый клуб уступает место новому. Так система
    // не может «захлебнуться» и не требует ни одного выделения памяти в кадре.
    const p = this.puffs[this.nextPuff];
    this.nextPuff = (this.nextPuff + 1) % this.puffs.length;
    p.life = F.smokeLife;
    p.x = f.x + (Math.random() - 0.5) * 0.5;
    p.y = f.y + 0.3;
    p.z = f.z + (Math.random() - 0.5) * 0.5;
    // Стартовый толчок — от факела к полю и вверх, дальше решает ветер
    p.vx = f.inX * F.smokePush + (Math.random() - 0.5) * 0.6;
    p.vz = f.inZ * F.smokePush + (Math.random() - 0.5) * 0.6;
    p.vy = F.smokeUp * (0.7 + Math.random() * 0.6);
    p.rot = Math.random() * Math.PI * 2;
    p.spin = (Math.random() - 0.5) * F.smokeSpin;
    p.seed = Math.random() * 100;
    p.wind = 1 + (Math.random() - 0.5) * 2 * F.windVary;
    // Ось блуждания у каждого клуба своя, но по горизонтали: вверх его
    // ведёт подъёмная сила, и добавлять туда шум незачем.
    const ang = Math.random() * Math.PI * 2;
    p.swirlX = Math.cos(ang);
    p.swirlZ = Math.sin(ang);
  }
}
