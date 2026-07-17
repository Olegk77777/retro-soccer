// Точка входа: собирает сцену, мяч, CRT-пайплайн, управление и игровой цикл.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { buildStadium } from './scene.js';
import { Ball } from './ball.js';
import { Player } from './player.js';
import { Input } from './input.js';
import { CRTPipeline } from './crt.js';

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false }); // ступеньки = стиль PS1
renderer.setPixelRatio(1); // рендерим в маленькую текстуру, ретина не нужна

const scene = buildStadium();
const ball = new Ball(scene);
const player = new Player(scene);
const input = new Input();
const crt = new CRTPipeline(renderer);

const camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, 16 / 9, 0.5, 400);
// Сразу ставим камеру на позицию ТВ-оператора (lerp в цикле — только для слежения за мячом)
camera.position.set(0, CONFIG.camera.height, CONFIG.camera.distance);
camera.lookAt(0, 1, 0);

// --- ТВ-пресеты ---
let presets = [];
let presetIndex = 0;
const presetBtn = document.getElementById('preset-btn');

fetch('./data/tv-presets.json')
  .then((r) => r.json())
  .then((data) => {
    presets = data.presets;
    applyPreset(0);
  })
  .catch((e) => console.error('Не удалось загрузить ТВ-пресеты:', e));

function applyPreset(i) {
  if (!presets.length) return;
  presetIndex = ((i % presets.length) + presets.length) % presets.length;
  crt.setPreset(presets[presetIndex]);
  presetBtn.textContent = 'ТВ: ' + presets[presetIndex].name;
}

presetBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  applyPreset(presetIndex + 1);
});

// --- «ГОЛ!» ---
const goalFlash = document.getElementById('goal-flash');
let goalTimer = 0;

function onGoal() {
  goalFlash.classList.add('show');
  goalTimer = 2.0;
  ball.reset();
  player.reset();
}

// --- Шкала замаха ---
const powerEl = document.getElementById('power');
const powerFill = document.getElementById('power-fill');

// --- Размер окна ---
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  crt.resize(w, h);
}
window.addEventListener('resize', resize);
resize();

// --- Потеря WebGL-контекста (грабля iOS — см. База-знаний) ---
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  console.warn('WebGL-контекст потерян — ждём восстановления');
});

// --- Игровой цикл ---
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3(0, 1, 0);
const clock = new THREE.Clock();

function frame() {
  const dt = Math.min(clock.getDelta(), 1 / 30); // защита от рывка после сворачивания вкладки
  const t = clock.elapsedTime;

  input.update(dt);
  player.update(dt, input, ball);
  const event = ball.update(dt);
  if (event === 'goal' && goalTimer <= 0) onGoal();

  // Шкала замаха видна, пока держится кнопка удара
  if (input.charging) {
    powerEl.style.display = 'block';
    powerFill.style.width = `${(input.charge / CONFIG.player.chargeTime) * 100}%`;
  } else {
    powerEl.style.display = 'none';
  }

  if (goalTimer > 0) {
    goalTimer -= dt;
    if (goalTimer <= 0) goalFlash.classList.remove('show');
  }

  // ТВ-камера: стоит на боковой линии, плавно провожает мяч
  const C = CONFIG.camera;
  const bx = ball.mesh.position.x;
  const bz = ball.mesh.position.z;
  camPos.set(bx * C.followFactor, C.height, C.distance);
  camera.position.lerp(camPos, C.lerp * 60 * dt);
  camLook.lerp(new THREE.Vector3(bx * 0.8, 1, bz * 0.45), C.lerp * 60 * dt);
  camera.lookAt(camLook);

  if (NO_CRT) renderer.render(scene, camera);
  else crt.render(scene, camera, t);
  requestAnimationFrame(frame);
}

// Отладка: ?nocrt в адресе — рендер без CRT-прохода
const NO_CRT = location.search.includes('nocrt');
window.DBG = { scene, camera, ball, player, input, crt, renderer };

frame();
