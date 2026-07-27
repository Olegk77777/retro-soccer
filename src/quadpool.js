// Пул billboard-квадов: общий движок для всего, что рисуется плоскими
// картинками — дым файеров, пламя, стелющаяся пелена, серпантин.
//
// Почему не THREE.Points: у gl_PointSize есть потолок драйвера (на мобильных
// GPU часто 511 или 1023 пикселя), а точка отсекается по своему ЦЕНТРУ —
// как только он уходит за край экрана, пропадает вся точка целиком. На
// крупной частице это читается как «моргнуло». У квадов ни того, ни другого.
//
// Один пул = один draw call, сколько бы частиц в нём ни жило. Буфер
// набирается заново каждый кадр: begin() → push(...) → end().

import * as THREE from 'three';
import { CONFIG } from './config.js';

// Разворот к камере: угол смещается уже В ПРОСТРАНСТВЕ ВИДА, поэтому квад
// всегда плоскостью на объектив, и никаким поворотом камеры его не «схлопнуть».
export const QUAD_VERT = /* glsl */ `
  attribute vec2 aCorner;    // угол квада в долях (-0.5…0.5)
  attribute vec2 aSize;      // ширина и высота В МЕТРАХ
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
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Сначала масштаб по осям квада, ПОТОМ поворот: иначе у неквадратной
    // ленты поворот растянул бы её по диагонали.
    vec2 sc = aCorner * aSize;
    float s = sin(aRot);
    float c = cos(aRot);
    mv.xy += vec2(sc.x * c - sc.y * s, sc.x * s + sc.y * c);
    // Дымку считаем САМИ: у ShaderMaterial нет автоматического фога, а без
    // него частицы на дальней трибуне встанут контрастнее самой трибуны.
    vFog = clamp((-mv.z - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

// Квад, ЛЕЖАЩИЙ на земле. Так ведёт себя остывший дым, и так же он дешевле:
// ТВ-камера смотрит на газон сверху, и лежащий квад занимает вдвое-втрое
// меньше пикселей, чем вертикальный billboard того же размера.
export const GROUND_VERT = /* glsl */ `
  attribute vec2 aCorner;
  attribute vec2 aSize;
  attribute float aRot;
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
    vec2 sc = aCorner * aSize;
    float s = sin(aRot);
    float c = cos(aRot);
    vec2 off = vec2(sc.x * c - sc.y * s, sc.x * s + sc.y * c);
    vec4 mv = modelViewMatrix * vec4(position + vec3(off.x, 0.0, off.y), 1.0);
    vFog = clamp((-mv.z - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

// Клуб дыма: форма берётся из карты, цвет садится в дымку
export const SMOKE_FRAG = /* glsl */ `
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

// Источник света: круглое ядро, гаснущее в дымке
export const FIRE_FRAG = /* glsl */ `
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
    // src.rgb * src.a + dst, множитель уже внутри.
    float a = vAlpha * k * k * (1.0 - vFog * uFogKill);
    if (a <= 0.004) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

// Клочок бумаги: плоская заливка с чуть мягкими торцами. Карта не нужна —
// на дистанции трибун это две-три точки, вся форма в пропорции квада.
export const FLAT_FRAG = /* glsl */ `
  precision mediump float;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vFog;
  uniform vec3 uFogColor;
  void main() {
    // Смягчаем края: жёсткий прямоугольник на тёмной трибуне читается
    // палкой, а не бумагой. По длине смягчение сильнее — там торцы.
    float edgeY = smoothstep(0.0, 0.14, min(vUv.y, 1.0 - vUv.y));
    float edgeX = smoothstep(0.0, 0.3, min(vUv.x, 1.0 - vUv.x));
    float a = vAlpha * edgeY * edgeX;
    if (a <= 0.004) discard;
    gl_FragColor = vec4(mix(vColor, uFogColor, vFog), a);
  }
`;

export class QuadPool {
  // kind: 'smoke' (карта + обычный бленд) | 'fire' (аддитив) | 'flat' (заливка)
  constructor(scene, max, { kind, map, renderOrder, ground }) {
    this.max = max;
    const HZ = CONFIG.atmosphere.haze;

    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(max * 4 * 3);
    const corner = new Float32Array(max * 4 * 2);
    const size = new Float32Array(max * 4 * 2);
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
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 2));
    geo.setAttribute('aRot', new THREE.BufferAttribute(rot, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.setDrawRange(0, 0);

    const uniforms = {
      uFogNear: { value: HZ.near },
      uFogFar: { value: HZ.far },
    };
    if (kind === 'fire') {
      uniforms.uFogKill = { value: CONFIG.atmosphere.flares.fogKill };
    } else {
      uniforms.uFogColor = { value: new THREE.Color(HZ.color) };
      if (kind === 'smoke') uniforms.uMap = { value: map };
    }

    const frag = kind === 'fire' ? FIRE_FRAG : (kind === 'flat' ? FLAT_FRAG : SMOKE_FRAG);
    const mat = new THREE.ShaderMaterial({
      vertexShader: ground ? GROUND_VERT : QUAD_VERT,
      fragmentShader: frag,
      uniforms,
      transparent: true,
      blending: kind === 'fire' ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false,
      // ГРАБЛЯ (27.07.2026): у ЛЕЖАЧЕГО квада тот же порядок обхода вершин
      // даёт нормаль ВНИЗ — (v1−v0)×(v2−v0) = (0,−1,0), — и камера, которая
      // смотрит на газон сверху, видит заднюю грань. Односторонний материал
      // отсекал пелену целиком: в кадре её не было ВООБЩЕ, хотя в буфере
      // лежали правильные позиции, размеры и альфа. У billboard-квадов такого
      // не бывает — они разворачиваются в пространстве вида и всегда лицом.
      // Ленты серпантина двусторонние по той же причине: они кувыркаются.
      side: (ground || kind === 'flat') ? THREE.DoubleSide : THREE.FrontSide,
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
  push(x, y, z, w, h, rot, r, g, b, a) {
    if (this.used >= this.max) return false;
    const q = this.used++;
    for (let v = 0; v < 4; v++) {
      const i = (q * 4 + v);
      this.pos[i * 3] = x;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] = z;
      this.size[i * 2] = w;
      this.size[i * 2 + 1] = h;
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
