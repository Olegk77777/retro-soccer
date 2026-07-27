// CRT-пайплайн: сцена рендерится во внутреннюю текстуру (высота — CONFIG.render
// .targetHeight), затем ОДИН полноэкранный шейдерный проход рисует её на весь
// экран с эффектами кинескопа.
//
// Полноэкранный проход по-прежнему один — это принципиально, каждый лишний
// бьёт по GPU планшета (см. База-знаний). Halation («расплывание» белого в
// стекле экрана) считают три МИКРОпрохода на четверти разрешения: вместе они
// стоят меньше 5% от главного прохода, а без них картинка остаётся плоской.
//
// Строчность и зерно НЕ привязаны к разрешению рендера: кинескоп 90-х — это
// ~480 строк, сколько бы пикселей мы ни рисовали. Иначе подъём до 720p делает
// полосы тоньше пикселя монитора и превращает их в муар.

import * as THREE from 'three';
import { CONFIG } from './config.js';

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Яркая часть кадра с мягким порогом. Заодно уменьшение вчетверо: берём
// четыре билинейных отсчёта, поэтому усредняем сразу 16 исходных пикселей.
const BRIGHT_FRAG = /* glsl */ `
  precision mediump float;
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;        // размер пикселя ИСХОДНОГО буфера
  uniform float uThreshold;
  uniform float uKnee;
  varying vec2 vUv;

  void main() {
    vec3 c = texture2D(tDiffuse, vUv + uTexel * vec2(-1.0, -1.0)).rgb
           + texture2D(tDiffuse, vUv + uTexel * vec2( 1.0, -1.0)).rgb
           + texture2D(tDiffuse, vUv + uTexel * vec2(-1.0,  1.0)).rgb
           + texture2D(tDiffuse, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
    c *= 0.25;

    float luma = max(c.r, max(c.g, c.b));
    // Мягкое колено вместо ступеньки: иначе на границе порога видна «фольга»
    float soft = clamp(luma - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 0.0001);
    float w = max(soft, luma - uThreshold) / max(luma, 0.0001);
    gl_FragColor = vec4(c * w, 1.0);
  }
`;

// Разделимое гауссово размытие: 9 отсчётов, шаг задаётся uDir.
const BLUR_FRAG = /* glsl */ `
  precision mediump float;
  uniform sampler2D tDiffuse;
  uniform vec2 uDir;          // шаг в UV: (texel.x*r, 0) или (0, texel.y*r)
  varying vec2 vUv;

  void main() {
    vec3 c = texture2D(tDiffuse, vUv).rgb * 0.2270270;
    c += (texture2D(tDiffuse, vUv + uDir * 1.3846153).rgb
        + texture2D(tDiffuse, vUv - uDir * 1.3846153).rgb) * 0.3162162;
    c += (texture2D(tDiffuse, vUv + uDir * 3.2307692).rgb
        + texture2D(tDiffuse, vUv - uDir * 3.2307692).rgb) * 0.0702702;
    gl_FragColor = vec4(c, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision mediump float;
  uniform sampler2D tDiffuse;
  uniform sampler2D tBloom;
  uniform float uTime;
  uniform float uScanRes;     // сколько строк рисует «кинескоп» (НЕ равно высоте рендера)
  uniform float uGrainRes;    // крупность зерна (тоже своя, не от разрешения)
  uniform float uCurvature;   // кривизна кинескопа
  uniform float uScanline;    // сила полос развёртки
  uniform float uNoise;       // зерно
  uniform float uRgbShift;    // расхождение цветов (хроматическая аберрация)
  uniform float uSaturation;
  uniform float uBrightness;
  uniform vec3  uTint;        // цветовой оттенок «канала»
  uniform float uVignette;
  uniform float uJitter;      // VHS-дрожание строк
  uniform float uBloom;       // сила halation
  uniform float uContrast;    // S-контраст вокруг средних тонов
  uniform float uLift;        // подъём чёрного: стекло кинескопа не бывает чёрным
  uniform float uWarmth;      // раздел тонов: света теплее, тени холоднее
  varying vec2 vUv;

  float rand(vec2 co) {
    return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    // Кривизна: выпуклый экран кинескопа
    vec2 cc = vUv * 2.0 - 1.0;
    cc *= 1.0 + uCurvature * dot(cc, cc);
    vec2 uv = cc * 0.5 + 0.5;

    // За пределами «стекла» — чёрная рамка
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    // VHS: редкие горизонтальные срывы строк
    float lineId = floor(uv.y * uScanRes);
    float glitch = step(1.0 - uJitter * 0.006, rand(vec2(lineId, floor(uTime * 13.0))));
    uv.x += glitch * (rand(vec2(lineId, uTime)) - 0.5) * 0.08;

    // Расхождение RGB-каналов по краям
    vec2 shift = vec2(uRgbShift, 0.0);
    vec3 col;
    col.r = texture2D(tDiffuse, uv + shift).r;
    col.g = texture2D(tDiffuse, uv).g;
    col.b = texture2D(tDiffuse, uv - shift).b;

    // Halation: свет от ярких мест растекается в стекле экрана. Ореол чуть
    // теплее источника — так ведёт себя люминофор, и так выглядит эфир 90-х.
    vec3 glow = texture2D(tBloom, uv).rgb;
    col += glow * uBloom * vec3(1.06, 1.0, 0.92);

    // Насыщенность и оттенок канала
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(luma), col, uSaturation) * uTint * uBrightness;

    // Контраст вокруг средних тонов: главный рычаг «сочности»
    col = (col - 0.5) * uContrast + 0.5;

    // Разделение тонов: света уходят в тёплый, тени — в синеву стадионной ночи
    float l2 = clamp(dot(col, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);
    float hi = smoothstep(0.28, 0.92, l2);
    vec3 warm = vec3(1.0 + uWarmth * 0.5, 1.0, 1.0 - uWarmth * 0.42);
    vec3 cool = vec3(1.0 - uWarmth * 0.30, 1.0 - uWarmth * 0.08, 1.0 + uWarmth * 0.44);
    col *= mix(cool, warm, hi);

    // Полосы развёртки — структура самого экрана, поэтому ПОСЛЕ грейдинга
    float s = sin(uv.y * uScanRes * 3.14159);
    col *= 1.0 - uScanline * s * s;

    // Зерно
    col += (rand(uv * uGrainRes + vec2(uTime * 60.0)) - 0.5) * uNoise;

    // Виньетка по углам
    float vig = 1.0 - uVignette * dot(cc, cc) * 0.7;
    col *= vig;

    // Подъём чёрного: стекло кинескопа всегда чуть светится и отражает комнату
    col = max(col, vec3(0.0)) * (1.0 - uLift) + vec3(uLift * 0.85, uLift * 0.88, uLift);

    gl_FragColor = vec4(col, 1.0);
  }
`;

// Общая заготовка микропрохода: полноэкранный треугольник-квад + материал
function makeQuad(material) {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  return scene;
}

export class CRTPipeline {
  constructor(renderer) {
    this.renderer = renderer;
    this.height = CONFIG.render.targetHeight;
    this.size = new THREE.Vector2(320, 240);

    this.target = new THREE.WebGLRenderTarget(320, 240, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });

    // Буферы halation: живут на 1/downscale от главного. Фильтр линейный —
    // размытие обязано «размазывать», а не тиражировать пиксели.
    const rtOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.bloomA = new THREE.WebGLRenderTarget(80, 60, rtOpts);
    this.bloomB = new THREE.WebGLRenderTarget(80, 60, rtOpts);
    // Значение по умолчанию под стартовые 80×60: render() до первого resize()
    // не должен падать на undefined (отладочные стенды рендерят без ресайза).
    this._bloomTexel = new THREE.Vector2(1 / 80, 1 / 60);

    const B = CONFIG.render.bloom;
    this.brightMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: BRIGHT_FRAG,
      uniforms: {
        tDiffuse: { value: this.target.texture },
        uTexel: { value: new THREE.Vector2(1 / 320, 1 / 240) },
        uThreshold: { value: B.threshold },
        uKnee: { value: B.knee },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: BLUR_FRAG,
      uniforms: {
        tDiffuse: { value: null },
        uDir: { value: new THREE.Vector2() },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        tDiffuse: { value: this.target.texture },
        tBloom: { value: this.bloomA.texture },
        uTime: { value: 0 },
        uScanRes: { value: CONFIG.render.scanLines },
        uGrainRes: { value: CONFIG.render.grainRes },
        uCurvature: { value: 0.1 },
        uScanline: { value: 0.3 },
        uNoise: { value: 0.05 },
        uRgbShift: { value: 0.0015 },
        uSaturation: { value: 1.0 },
        uBrightness: { value: 1.0 },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
        uVignette: { value: 0.35 },
        uJitter: { value: 0 },
        uBloom: { value: B.enabled ? B.strength : 0 },
        uContrast: { value: 1.0 },
        uLift: { value: 0.0 },
        uWarmth: { value: 0.0 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.brightScene = makeQuad(this.brightMat);
    this.blurScene = makeQuad(this.blurMat);
    this.quadScene = makeQuad(this.material);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._winW = 1;
    this._winH = 1;
  }

  // Пересчитать размер внутреннего рендера под аспект окна
  resize(width, height) {
    this._winW = width || this._winW;
    this._winH = height || this._winH;
    const aspect = Math.min(this._winW / this._winH, CONFIG.render.maxAspect);
    const h = this.height;
    const w = Math.round(h * aspect);
    this.size.set(w, h);
    this.target.setSize(w, h);
    this.brightMat.uniforms.uTexel.value.set(1 / w, 1 / h);

    // Ступеньки PS1 держим только на низких разрешениях. На 720p+ NEAREST
    // при апскейле в некратное разрешение даёт рваные строки, и полосы
    // развёртки начинают «дышать» при движении камеры.
    // Менять фильтр можно ТОЛЬКО сразу после setSize: он уже уничтожил старый
    // буфер, и текстура создастся заново с новыми параметрами. Ставить
    // needsUpdate на текстуру рендер-таргета нельзя — three попробует залить
    // её как обычную картинку и порвёт привязку к фреймбуферу.
    const filter = h > 480 ? THREE.LinearFilter : THREE.NearestFilter;
    this.target.texture.magFilter = filter;
    this.target.texture.minFilter = filter;

    const k = Math.max(2, CONFIG.render.bloom.downscale);
    const bw = Math.max(8, Math.round(w / k));
    const bh = Math.max(8, Math.round(h / k));
    this.bloomA.setSize(bw, bh);
    this.bloomB.setSize(bw, bh);
    this._bloomTexel = new THREE.Vector2(1 / bw, 1 / bh);
  }

  // Сменить высоту внутреннего рендера (селектор «Чёткость» в настройках)
  setHeight(h) {
    this.height = Math.max(120, Math.round(h) || CONFIG.render.targetHeight);
    CONFIG.render.targetHeight = this.height;
    this.resize();
  }

  // Применить ТВ-пресет (объект из data/tv-presets.json).
  // Новые поля грейдинга необязательны: старый пресет без них получает
  // значения по умолчанию и выглядит ровно как раньше плюс halation.
  setPreset(p) {
    const u = this.material.uniforms;
    const B = CONFIG.render.bloom;
    u.uCurvature.value = p.curvature;
    u.uScanline.value = p.scanline;
    u.uNoise.value = p.noise;
    u.uRgbShift.value = p.rgbShift;
    u.uSaturation.value = p.saturation;
    u.uBrightness.value = p.brightness;
    u.uVignette.value = p.vignette;
    u.uJitter.value = p.jitter;
    u.uTint.value.set(p.tint[0], p.tint[1], p.tint[2]);
    u.uBloom.value = B.enabled ? (p.bloom ?? B.strength) : 0;
    u.uContrast.value = p.contrast ?? 1.0;
    u.uLift.value = p.lift ?? 0.0;
    u.uWarmth.value = p.warmth ?? 0.0;
  }

  // Три микропрохода на 1/downscale: яркая часть → размытие по X → по Y.
  // Результат остаётся в bloomA, откуда его читает главный проход.
  _renderBloom() {
    const B = CONFIG.render.bloom;
    if (!B.enabled || this.material.uniforms.uBloom.value <= 0) return;
    const r = this.renderer;
    const t = this._bloomTexel;

    r.setRenderTarget(this.bloomA);
    r.render(this.brightScene, this.quadCam);

    this.blurMat.uniforms.tDiffuse.value = this.bloomA.texture;
    this.blurMat.uniforms.uDir.value.set(t.x * B.radius, 0);
    r.setRenderTarget(this.bloomB);
    r.render(this.blurScene, this.quadCam);

    this.blurMat.uniforms.tDiffuse.value = this.bloomB.texture;
    this.blurMat.uniforms.uDir.value.set(0, t.y * B.radius);
    r.setRenderTarget(this.bloomA);
    r.render(this.blurScene, this.quadCam);
  }

  render(scene, camera, time) {
    this.material.uniforms.uTime.value = time;
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(scene, camera);
    this._renderBloom();
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCam);
  }
}
