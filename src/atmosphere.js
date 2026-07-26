// Ночная атмосфера трансляции: свет четырёх мачт и то, что он делает с кадром.
// Три вещи, которые продают «футбол по телевизору в 1998-м»:
//   1) газон освещён НЕРАВНОМЕРНО — под мачтами пятна, по краям темнее;
//   2) на трибунах постоянно щёлкают фотоаппараты;
//   3) под каждым игроком не одна тень, а веер из четырёх — по одной на мачту.
// Всё считается от ОДНИХ координат мачт (CONFIG.atmosphere.masts), поэтому
// свет, гало и тени всегда согласованы между собой.

import * as THREE from 'three';
import { CONFIG } from './config.js';

// Четыре мачты по углам стадиона. Единственный источник правды о том,
// откуда светит: столбы, гало, пятна на газоне и тени берут это.
export function mastPositions() {
  const F = CONFIG.field;
  const M = CONFIG.atmosphere.masts;
  const out = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      out.push({
        x: sx * (F.length / 2 + F.apron + M.marginX),
        y: M.height,
        z: sz * (F.width / 2 + F.apron + M.marginZ),
      });
    }
  }
  return out;
}

// Пятна прожекторов, впечатанные прямо в текстуру газона: в рантайме
// бесплатно, а поле перестаёт быть ровным зелёным сукном.
// ctx уже содержит траву и полосы покоса; разметка рисуется ПОСЛЕ.
export function paintPitchLight(ctx, w, h) {
  const L = CONFIG.atmosphere.pitchLight;

  // Мягкое затемнение к краям: дальние углы поля до мачт не достают
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  const dark = ctx.createRadialGradient(w / 2, h / 2, w * 0.18, w / 2, h / 2, w * 0.62);
  dark.addColorStop(0, 'rgba(255,255,255,1)');
  dark.addColorStop(1, `rgba(${Math.round(255 * (1 - L.falloff))},${Math.round(255 * (1 - L.falloff))},${Math.round(255 * (1 - L.falloff * 0.85))},1)`);
  ctx.fillStyle = dark;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  // Четыре пятна: лампы стоят по углам и бьют внутрь, поэтому центр пятна
  // смещён от угла к середине поля.
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const cx = w / 2 + sx * w * L.poolInset;
      const cy = h / 2 + sz * h * L.poolInset;
      const r = w * L.poolRadius;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, `rgba(255,250,225,${L.pool})`);
      g.addColorStop(0.45, `rgba(240,245,220,${L.pool * 0.42})`);
      g.addColorStop(1, 'rgba(200,220,190,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
  }
  ctx.restore();
}

// Мягкое круглое пятно с крестовым бликом — текстура гало ламп.
// Крест «звезды» — типичная засветка ТВ-оптики на ярком источнике.
function createHaloTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,250,225,1)');
  g.addColorStop(0.18, 'rgba(255,244,205,0.55)');
  g.addColorStop(0.5, 'rgba(210,225,255,0.14)');
  g.addColorStop(1, 'rgba(160,190,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);

  // Крест бликов: горизонталь заметнее вертикали, как на ТВ-оптике
  ctx.globalCompositeOperation = 'lighter';
  const beam = (w, hh) => {
    const bg = ctx.createLinearGradient(64 - w / 2, 0, 64 + w / 2, 0);
    bg.addColorStop(0, 'rgba(255,248,220,0)');
    bg.addColorStop(0.5, 'rgba(255,248,220,0.5)');
    bg.addColorStop(1, 'rgba(255,248,220,0)');
    ctx.fillStyle = bg;
    ctx.fillRect(64 - w / 2, 64 - hh / 2, w, hh);
  };
  beam(112, 4);
  ctx.save();
  ctx.translate(64, 64);
  ctx.rotate(Math.PI / 2);
  ctx.translate(-64, -64);
  beam(46, 3);   // вертикаль заметно короче: иначе луч режет весь кадр
  ctx.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Гало вокруг ламп: спрайты всегда лицом к камере, аддитивно — как ореол
// вокруг яркого источника на кинескопе.
export function buildFloodlightHalos(scene) {
  const H = CONFIG.atmosphere.halo;
  const tex = createHaloTexture();
  for (const m of mastPositions()) {
    const mat = new THREE.SpriteMaterial({
      map: tex,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: H.opacity,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(m.x, m.y, m.z);
    sprite.scale.set(H.size, H.size, 1);
    scene.add(sprite);
  }
}

// --- Вспышки фотокамер на трибунах ---------------------------------------

const FLASH_VERT = /* glsl */ `
  attribute float aAlpha;
  varying float vAlpha;
  uniform float uScale;   // пиксель-на-метр на дистанции 1 м (из fov и высоты рендера)
  uniform float uSize;    // видимый размер вспышки в метрах
  void main() {
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = max(1.5, uSize * uScale / max(1.0, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const FLASH_FRAG = /* glsl */ `
  precision mediump float;
  varying float vAlpha;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = min(1.0, dot(d, d) * 4.0);
    float a = vAlpha * (1.0 - r) * (1.0 - r);   // мягкое ядро, быстрый спад
    if (a <= 0.003) discard;
    gl_FragColor = vec4(1.0, 0.97, 0.92, a);
  }
`;

export class CameraFlashes {
  // stands — меши трибун (боксы). Вспышки садятся на ту грань каждого
  // сектора, что смотрит на поле: щёлкают ведь оттуда, где сидят люди.
  constructor(scene, stands) {
    const A = CONFIG.atmosphere.flashes;
    this.cfg = A;
    this.spots = collectStandSpots(stands, 600);

    const n = Math.min(A.count, Math.max(1, this.spots.length));
    const pos = new Float32Array(n * 3);
    const alpha = new Float32Array(n);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    // Точки живут на трибунах и никуда не уезжают — рамка отсечения не нужна
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 400);

    // Масштаб точки: сколько пикселей занимает метр на дистанции 1 м.
    // Считается из fov камеры и высоты внутреннего рендера — если поменяем
    // targetHeight, вспышки останутся того же физического размера.
    const uScale = CONFIG.render.targetHeight
      / (2 * Math.tan(THREE.MathUtils.degToRad(CONFIG.camera.fov) / 2));

    this.material = new THREE.ShaderMaterial({
      vertexShader: FLASH_VERT,
      fragmentShader: FLASH_FRAG,
      uniforms: {
        uScale: { value: uScale },
        uSize: { value: A.size },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);

    // Каждая вспышка живёт своим циклом: горит life секунд, потом ждёт
    // случайную паузу. Средний темп по стадиону = A.rate вспышек/сек.
    this.life = new Float32Array(n);
    this.wait = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.wait[i] = this._nextPause(n) * Math.random(); // разводим старт по фазе
      this._place(i);
    }
    this.count = n;
  }

  _nextPause(n) {
    const A = this.cfg;
    return (n / Math.max(0.1, A.rate)) * (0.35 + Math.random() * 1.3);
  }

  _place(i) {
    if (!this.spots.length) return;
    const s = this.spots[(Math.random() * this.spots.length) | 0];
    const p = this.points.geometry.attributes.position.array;
    p[i * 3] = s.x;
    p[i * 3 + 1] = s.y;
    p[i * 3 + 2] = s.z;
  }

  update(dt) {
    if (!this.count) return;
    const A = this.cfg;
    const alpha = this.points.geometry.attributes.aAlpha;
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] > 0) {
        this.life[i] -= dt;
        const k = Math.max(0, this.life[i] / A.life);
        alpha.array[i] = k * k; // резкий пик и быстрый спад — это фотовспышка
      } else {
        alpha.array[i] = 0;
        this.wait[i] -= dt;
        if (this.wait[i] <= 0) {
          this._place(i);
          this.life[i] = A.life;
          this.wait[i] = this._nextPause(this.count);
        }
      }
    }
    alpha.needsUpdate = true;
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

// Точки на «лицевой» грани каждого сектора: берём ту грань бокса, чья
// нормаль в мире смотрит к центру поля, и раскидываем по ней сетку мест.
function collectStandSpots(stands, want) {
  const A = CONFIG.atmosphere.flashes;
  const spots = [];
  if (!stands || !stands.length) return spots;
  const perStand = Math.ceil(want / stands.length);
  const normal = new THREE.Vector3();
  const toCenter = new THREE.Vector3();
  const local = new THREE.Vector3();

  for (const stand of stands) {
    stand.updateMatrixWorld(true);
    const par = stand.geometry.parameters;
    normal.set(0, 0, 1).transformDirection(stand.matrixWorld);
    toCenter.set(-stand.position.x, 0, -stand.position.z).normalize();
    const face = normal.dot(toCenter) >= 0 ? 1 : -1;

    for (let i = 0; i < perStand; i++) {
      const u = Math.random() - 0.5;
      const v = A.minRow + Math.random() * (A.maxRow - A.minRow) - 0.5;
      local.set(u * par.width, v * par.height, face * (par.depth / 2 + 0.15));
      stand.localToWorld(local);
      spots.push({ x: local.x, y: local.y, z: local.z });
    }
  }
  return spots;
}

// --- Веер теней от четырёх мачт ------------------------------------------

// Мягкое пятно, вытянутое от ног игрока: у начала плотное, к хвосту тает.
function createShadowAlphaMap() {
  const w = 32;
  const h = 96;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);                 // 0 у ног → 1 в конце тени
    const spread = 1 + 0.55 * v;           // хвост расплывается, как настоящая полутень
    const fade = Math.pow(1 - v, 2.2);     // и быстро тает: чёткая тень только под ногами
    for (let x = 0; x < w; x++) {
      const u = (x / (w - 1) - 0.5) * 2 / spread;
      const core = Math.max(0, 1 - u * u);
      const a = core * core * fade;
      const idx = (y * w + x) * 4;
      img.data[idx] = 255;
      img.data[idx + 1] = 255;
      img.data[idx + 2] = 255;
      img.data[idx + 3] = Math.round(255 * Math.min(1, a));
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

export class GroundShadows {
  // Один InstancedMesh на все тени всех игроков: 88 пятен — один draw call.
  constructor(scene, maxCasters = 40) {   // 22 игрока + запас на замены
    const S = CONFIG.atmosphere.shadows;
    this.cfg = S;
    this.masts = mastPositions();
    this.casters = [];
    this.maxCasters = maxCasters;

    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);   // кладём на газон
    geo.translate(0, 0, 0.5);    // начало тени — в точке ног, растёт вдоль +Z

    const mat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      alphaMap: createShadowAlphaMap(),
      transparent: true,
      opacity: S.opacity,
      depthWrite: false,
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, maxCasters * this.masts.length);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
    this._dummy = new THREE.Object3D();
  }

  // Возвращает пустышку-«якорь»: игрок двигает её position, остальное наше
  // дело. Object3D — чтобы старый код (scene.add, .position.x) не менялся.
  create(height = CONFIG.player.height) {
    const anchor = new THREE.Object3D();
    anchor.userData.shadowHeight = height;
    if (this.casters.length < this.maxCasters) this.casters.push(anchor);
    return anchor;
  }

  update() {
    const S = this.cfg;
    const d = this._dummy;
    let i = 0;
    for (const a of this.casters) {
      const px = a.position.x;
      const pz = a.position.z;
      const hgt = a.userData.shadowHeight || CONFIG.player.height;
      for (const m of this.masts) {
        const dx = px - m.x;
        const dz = pz - m.z;
        const dist = Math.hypot(dx, dz) || 0.001;
        // Классическая геометрия тени: рост × дистанция / высота лампы
        const len = Math.min(S.maxLength,
          Math.max(S.minLength, (hgt * dist / m.y) * S.lengthScale));
        d.position.set(px, 0.02, pz);
        d.rotation.set(0, Math.atan2(dx / dist, dz / dist), 0);
        d.scale.set(S.width + S.widthGrow * len, 1, len);
        d.updateMatrix();
        this.mesh.setMatrixAt(i++, d.matrix);
      }
    }
    this.mesh.count = i;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
