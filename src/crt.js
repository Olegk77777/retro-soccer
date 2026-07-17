// CRT-пайплайн: сцена рендерится в маленькую текстуру (~320×240, «разрешение PS1»),
// затем ОДИН шейдерный проход рисует её на весь экран с эффектами кинескопа.
// Один проход — принципиально: каждый лишний бьёт по GPU планшета (см. База-знаний).

import * as THREE from 'three';
import { CONFIG } from './config.js';

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision mediump float;
  uniform sampler2D tDiffuse;
  uniform float uTime;
  uniform vec2 uRes;          // разрешение внутреннего рендера
  uniform float uCurvature;   // кривизна кинескопа
  uniform float uScanline;    // сила полос развёртки
  uniform float uNoise;       // зерно
  uniform float uRgbShift;    // расхождение цветов (хроматическая аберрация)
  uniform float uSaturation;
  uniform float uBrightness;
  uniform vec3  uTint;        // цветовой оттенок «канала»
  uniform float uVignette;
  uniform float uJitter;      // VHS-дрожание строк
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
    float lineId = floor(uv.y * uRes.y);
    float glitch = step(1.0 - uJitter * 0.006, rand(vec2(lineId, floor(uTime * 13.0))));
    uv.x += glitch * (rand(vec2(lineId, uTime)) - 0.5) * 0.08;

    // Расхождение RGB-каналов по краям
    vec2 shift = vec2(uRgbShift, 0.0);
    vec3 col;
    col.r = texture2D(tDiffuse, uv + shift).r;
    col.g = texture2D(tDiffuse, uv).g;
    col.b = texture2D(tDiffuse, uv - shift).b;

    // Полосы развёртки
    float s = sin(uv.y * uRes.y * 3.14159);
    col *= 1.0 - uScanline * s * s;

    // Зерно
    col += (rand(uv * uRes + vec2(uTime * 60.0)) - 0.5) * uNoise;

    // Насыщенность и оттенок канала
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(luma), col, uSaturation) * uTint * uBrightness;

    // Виньетка по углам
    float vig = 1.0 - uVignette * dot(cc, cc) * 0.7;
    col *= vig;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export class CRTPipeline {
  constructor(renderer) {
    this.renderer = renderer;
    this.target = new THREE.WebGLRenderTarget(320, 240, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        tDiffuse: { value: this.target.texture },
        uTime: { value: 0 },
        uRes: { value: new THREE.Vector2(320, 240) },
        uCurvature: { value: 0.1 },
        uScanline: { value: 0.3 },
        uNoise: { value: 0.05 },
        uRgbShift: { value: 0.0015 },
        uSaturation: { value: 1.0 },
        uBrightness: { value: 1.0 },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
        uVignette: { value: 0.35 },
        uJitter: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.quadScene = new THREE.Scene();
    this.quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  // Пересчитать размер внутреннего рендера под аспект окна
  resize(width, height) {
    const aspect = Math.min(width / height, CONFIG.render.maxAspect);
    const h = CONFIG.render.targetHeight;
    const w = Math.round(h * aspect);
    this.target.setSize(w, h);
    this.material.uniforms.uRes.value.set(w, h);
  }

  // Применить ТВ-пресет (объект из data/tv-presets.json)
  setPreset(p) {
    const u = this.material.uniforms;
    u.uCurvature.value = p.curvature;
    u.uScanline.value = p.scanline;
    u.uNoise.value = p.noise;
    u.uRgbShift.value = p.rgbShift;
    u.uSaturation.value = p.saturation;
    u.uBrightness.value = p.brightness;
    u.uVignette.value = p.vignette;
    u.uJitter.value = p.jitter;
    u.uTint.value.set(p.tint[0], p.tint[1], p.tint[2]);
  }

  render(scene, camera, time) {
    this.material.uniforms.uTime.value = time;
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCam);
  }
}
