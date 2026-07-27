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
// Устройство: два пула billboard-квадов (дым и огонь) — по одному draw call
// на каждый. Точек (THREE.Points) намеренно НЕТ: gl_PointSize упирается в
// потолок драйвера, а точка целиком пропадает, когда её ЦЕНТР уходит за край
// экрана, — на большом зареве это выглядит как «моргнул весь сектор».

import * as THREE from 'three';
import { CONFIG } from './config.js';

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

// --- Общий пул billboard-квадов ------------------------------------------

const QUAD_VERT = /* glsl */ `
  attribute vec2 aCorner;    // угол квада в долях (-0.5…0.5)
  attribute float aSize;     // сторона квада В МЕТРАХ
  attribute float aRot;      // поворот вокруг взгляда, рад
  attribute vec3 aColor;
  attribute float aAlpha;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vFog;
  uniform float uFogNear;
  uniform float uFogFar;
  void main() {
    vUv = aCorner + 0.5;
    vColor = aColor;
    vAlpha = aAlpha;
    // Разворот к камере: смещаем угол уже В ПРОСТРАНСТВЕ ВИДА, поэтому квад
    // всегда плоскостью на объектив и никаким поворотом камеры его не «схлопнет».
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float s = sin(aRot);
    float c = cos(aRot);
    mv.xy += vec2(aCorner.x * c - aCorner.y * s, aCorner.x * s + aCorner.y * c) * aSize;
    // Дымку считаем САМИ: у ShaderMaterial нет автоматического фога, а без
    // него частицы на дальней трибуне встанут контрастнее самой трибуны.
    vFog = clamp((-mv.z - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const SMOKE_FRAG = /* glsl */ `
  precision mediump float;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vFog;
  uniform sampler2D uMap;
  uniform vec3 uFogColor;
  void main() {
    float a = texture2D(uMap, vUv).a * vAlpha;
    if (a <= 0.004) discard;
    gl_FragColor = vec4(mix(vColor, uFogColor, vFog), a);
  }
`;

const FIRE_FRAG = /* glsl */ `
  precision mediump float;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vFog;
  uniform float uFogKill;
  void main() {
    vec2 d = vUv - 0.5;
    float r2 = dot(d, d) * 4.0;
    if (r2 >= 1.0) discard;
    float k = 1.0 - r2;
    // Цвет на альфу НЕ умножаем: аддитивный бленд three.js — это
    // src.rgb * src.a + dst, множитель уже внутри (грабля из atmosphere.js).
    float a = vAlpha * k * k * (1.0 - vFog * uFogKill);
    if (a <= 0.004) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

class QuadPool {
  constructor(scene, max, { additive, map, renderOrder }) {
    this.max = max;
    const HZ = CONFIG.atmosphere.haze;

    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(max * 4 * 3);
    const corner = new Float32Array(max * 4 * 2);
    const size = new Float32Array(max * 4);
    const rot = new Float32Array(max * 4);
    const color = new Float32Array(max * 4 * 3);
    const alpha = new Float32Array(max * 4);
    const index = new Uint16Array(max * 6);

    // Углы квада одни и те же на всю жизнь пула — пишем один раз
    const CORNERS = [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5];
    for (let q = 0; q < max; q++) {
      for (let v = 0; v < 4; v++) {
        corner[(q * 4 + v) * 2] = CORNERS[v * 2];
        corner[(q * 4 + v) * 2 + 1] = CORNERS[v * 2 + 1];
      }
      const b = q * 4;
      index.set([b, b + 1, b + 2, b, b + 2, b + 3], q * 6);
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aRot', new THREE.BufferAttribute(rot, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.setDrawRange(0, 0);

    const uniforms = {
      uFogNear: { value: HZ.near },
      uFogFar: { value: HZ.far },
    };
    if (additive) {
      uniforms.uFogKill = { value: CONFIG.atmosphere.flares.fogKill };
    } else {
      uniforms.uMap = { value: map };
      uniforms.uFogColor = { value: new THREE.Color(HZ.color) };
    }

    const mat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: additive ? FIRE_FRAG : SMOKE_FRAG,
      uniforms,
      transparent: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false; // центры живут в буфере, рамка отсечения врёт
    this.mesh.renderOrder = renderOrder;
    scene.add(this.mesh);

    this.geo = geo;
    this.pos = pos;
    this.size = size;
    this.rot = rot;
    this.color = color;
    this.alpha = alpha;
    this.used = 0;
  }

  // Начало кадра: пул набирается заново, живые частицы пишут себя сами
  begin() {
    this.used = 0;
  }

  // Вернёт false, когда пул кончился — вызывающий просто пропускает частицу
  push(x, y, z, size, rot, r, g, b, a) {
    if (this.used >= this.max) return false;
    const q = this.used++;
    for (let v = 0; v < 4; v++) {
      const i = (q * 4 + v);
      this.pos[i * 3] = x;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] = z;
      this.size[i] = size;
      this.rot[i] = rot;
      this.color[i * 3] = r;
      this.color[i * 3 + 1] = g;
      this.color[i * 3 + 2] = b;
      this.alpha[i] = a;
    }
    return true;
  }

  end() {
    const n = this.used;
    this.geo.setDrawRange(0, n * 6);
    if (!n) return;
    const upto = n * 4;
    // Грузим на GPU только занятую часть буфера: пул рассчитан на пик, а в
    // обычном кадре живых частиц втрое меньше. three.js сам чистит диапазоны
    // после загрузки, поэтому копить их между кадрами не приходится.
    for (const name of ['position', 'aSize', 'aRot', 'aColor', 'aAlpha']) {
      const attr = this.geo.attributes[name];
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, upto * attr.itemSize);
      attr.needsUpdate = true;
    }
  }
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

    this.smoke = new QuadPool(scene, F.smokeMax, {
      additive: false,
      map: createSmokeTexture(),
      renderOrder: 5,         // дым под огнём: сначала клубы, потом ядро
    });
    this.fire = new QuadPool(scene, F.fireMax, {
      additive: true,
      renderOrder: 6,
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

  _spotsFor(side) {
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
    const spots = this._spotsFor(side);
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
      this.fire.push(f.x, y, f.z, F.glowSize, 0, f.r, f.g, f.b, F.glowAlpha * power);
      this.fire.push(f.x, y, f.z, F.haloSize * (0.9 + 0.2 * jitter), 0,
        f.r, f.g, f.b, F.haloAlpha * power);
      this.fire.push(f.x, y, f.z, F.coreSize, 0, 1, 0.96, 0.90, Math.min(1, power));

      // Дым: копим дробную часть, иначе на низком темпе частицы не родятся
      f.debt += F.smokeRate * dt * ignite * tail;
      while (f.debt >= 1) {
        f.debt -= 1;
        this._spawnPuff(f);
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
      this.smoke.push(p.x, p.y, p.z, size, p.rot, r, g, b, a);
    }

    this.smoke.end();
    this.fire.end();
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
