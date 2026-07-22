// Точка входа: собирает сцену, мяч, CRT-пайплайн, управление и игровой цикл.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { buildStadium } from './scene.js';
import { Ball } from './ball.js';
import { Match } from './match.js';
import { Input } from './input.js';
import { CRTPipeline } from './crt.js';

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false }); // ступеньки = стиль PS1
renderer.setPixelRatio(1); // рендерим в маленькую текстуру, ретина не нужна

const scene = buildStadium();
const goals = scene.userData.goals;
const ball = new Ball(scene, goals);
const input = new Input();
const crt = new CRTPipeline(renderer);

// Матч 11×11: команды — файлы данных (правило «данные ≠ код»).
// Пока JSON не догрузился, кадры идут без матча (доли секунды).
let match = null;
Promise.all([
  fetch('./data/teams/home.json').then((r) => r.json()),
  fetch('./data/teams/away.json').then((r) => r.json()),
])
  .then((teamsData) => {
    match = new Match(scene, ball, goals, input, teamsData);
    window.DBG.match = match;
  })
  .catch((e) => console.error('Не удалось загрузить команды:', e));

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

// --- Панель настроек ---
const settingsPanel = document.getElementById('settings');
document.getElementById('settings-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  settingsPanel.classList.add('show');
});
document.getElementById('settings-close').addEventListener('click', (e) => {
  e.stopPropagation();
  settingsPanel.classList.remove('show');
});

// Помощь в ударах: слайдер 10–30%, живёт в CONFIG.shot.assist.level,
// запоминается в localStorage — на iPad настройка переживает перезапуск
const assistSlider = document.getElementById('set-assist');
const assistVal = document.getElementById('set-assist-val');
const savedAssist = Number(localStorage.getItem('f98.shotAssist'));
if (savedAssist >= 10 && savedAssist <= 30) {
  CONFIG.shot.assist.level = savedAssist / 100;
}
assistSlider.value = Math.round(CONFIG.shot.assist.level * 100);
assistVal.textContent = assistSlider.value;
assistSlider.addEventListener('input', () => {
  CONFIG.shot.assist.level = Number(assistSlider.value) / 100;
  assistVal.textContent = assistSlider.value;
  try { localStorage.setItem('f98.shotAssist', assistSlider.value); } catch (e) { /* приватный режим */ }
});

// Помощь в пасах: слайдер 10–30%, живёт в CONFIG.ai.humanPass.assist.level,
// запоминается в localStorage (та же схема, что помощь в ударах)
const passSlider = document.getElementById('set-pass-assist');
const passVal = document.getElementById('set-pass-assist-val');
const savedPass = Number(localStorage.getItem('f98.passAssist'));
if (savedPass >= 10 && savedPass <= 30) {
  CONFIG.ai.humanPass.assist.level = savedPass / 100;
}
passSlider.value = Math.round(CONFIG.ai.humanPass.assist.level * 100);
passVal.textContent = passSlider.value;
passSlider.addEventListener('input', () => {
  CONFIG.ai.humanPass.assist.level = Number(passSlider.value) / 100;
  passVal.textContent = passSlider.value;
  try { localStorage.setItem('f98.passAssist', passSlider.value); } catch (e) { /* приватный режим */ }
});

// Настройка камеры: подлёт к дальней бровке (пишем прямо в живой CONFIG)
const farSlider = document.getElementById('set-far');
const farVal = document.getElementById('set-far-val');
farSlider.value = CONFIG.camera.farApproach;
farVal.textContent = CONFIG.camera.farApproach;
farSlider.addEventListener('input', () => {
  CONFIG.camera.farApproach = Number(farSlider.value);
  farVal.textContent = farSlider.value;
});

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
const camLookTarget = new THREE.Vector3();
const clock = new THREE.Clock();

// Плавная кривая 0..1 для выхода из ТВ-заставки (копия smooth01 из match.js)
function smooth01(t) {
  const k = Math.max(0, Math.min(1, t));
  return k * k * (3 - 2 * k);
}

function frame() {
  const dt = Math.min(clock.getDelta(), 1 / 30); // защита от рывка после сворачивания вкладки
  const t = clock.elapsedTime;

  input.update(dt);
  if (match) match.update(dt); // 22 игрока: человек + AI-мозги
  const event = ball.update(dt);
  goals.update(dt);
  if (event === 'goal' && match) match.onGoal();

  // Шкала замаха видна, пока держится любая кнопка действия.
  // Больше 100% — красная зона: передержка, исполнение уйдёт сильнее задуманного.
  if (input.charging) {
    powerEl.style.display = 'block';
    powerFill.style.width = `${Math.min(input.chargeLevel, 1) * 100}%`;
    powerFill.classList.toggle('over', input.chargeLevel > 1);
  } else {
    powerEl.style.display = 'none';
  }

  // ТВ-камера «живой оператор» (дух «Как обычно» из FC 25/26, 22.07.2026):
  // стоит на боковой линии, провожает мяч по X и глубине, панорама УПРЕЖДАЕТ
  // полёт мяча, а скорость доводки растёт с темпом эпизода. Подлёты: к дальней
  // бровке (дальний игрок не мельчает) и в финальную треть (атака крупнее).
  const C = CONFIG.camera;
  const F = CONFIG.field;
  const bx = ball.mesh.position.x;
  const bz = ball.mesh.position.z;
  const ballSpeed = Math.hypot(ball.vel.x, ball.vel.z);
  // Упреждение: фокус-точка смещена туда, куда мяч летит (панорама дышит)
  const leadX = Math.max(-C.leadMax, Math.min(C.leadMax, ball.vel.x * C.lead));
  const leadZ = Math.max(-C.leadMax * 0.6, Math.min(C.leadMax * 0.6, ball.vel.z * C.lead * 0.6));
  const fx = bx + leadX;
  const fz = bz + leadZ;
  const far01 = Math.min(1, Math.max(0, -bz / (F.width / 2)));
  const atk01 = Math.min(1, Math.max(0,
    (Math.abs(bx) - F.length * C.attackFrom) / (F.length * C.attackSpan)));
  camPos.set(
    fx * C.followFactor,
    C.height - C.farLower * far01 - C.attackLower * atk01,
    C.distance - C.farApproach * far01 - C.attackApproach * atk01,
  );
  camLookTarget.set(fx * 0.8, C.lookHeight, fz * C.followZ);
  const ic = match && match.introCam;
  if (ic) {
    // ТВ-заставка: камеру ведёт параметрический путь интро; на выходе
    // (mix 1→0) кадр плавно перетекает в живую игровую ТВ-камеру
    const k = smooth01(ic.mix);
    camera.position.lerpVectors(camPos, ic.pos, k);
    camLook.lerpVectors(camLookTarget, ic.look, k);
  } else {
    // Быстрый эпизод (прострел, дальний перевод) — камера живее, штиль — плавнее
    const kCam = Math.min(1,
      (C.lerp + (C.lerpFast - C.lerp) * Math.min(1, ballSpeed / C.speedRef)) * 60 * dt);
    camera.position.lerp(camPos, kCam);
    camLook.lerp(camLookTarget, kCam);
  }
  camera.lookAt(camLook);

  if (NO_CRT) renderer.render(scene, camera);
  else crt.render(scene, camera, t);
  requestAnimationFrame(frame);
}

// Отладка: ?nocrt в адресе — рендер без CRT-прохода
const NO_CRT = location.search.includes('nocrt');
window.DBG = { scene, camera, camLook, ball, input, crt, renderer, goals, CONFIG };

frame();
