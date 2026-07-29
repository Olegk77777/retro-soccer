// Точка входа: собирает сцену, мяч, CRT-пайплайн, управление и игровой цикл.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { PACK } from './pack.js';
import { buildStadium } from './scene.js';
import { Ball } from './ball.js';
import { Match } from './match.js';
import { Input } from './input.js';
import { CRTPipeline } from './crt.js';
import { Knob, screenRect, invalidateScreenRect } from './tvset.js';
import { clothTime } from './cloth.js';
import { updateRim } from './rimlight.js';

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false }); // ступеньки = стиль PS1
renderer.setPixelRatio(1); // рендерим в маленькую текстуру, ретина не нужна

const scene = buildStadium();

// Уровень пиротехники читаем ЗДЕСЬ, а не вместе с остальными настройками
// ниже: заставка матча зажигает файеры прямо в конструкторе Match, который
// создаётся через десяток строк. Прочитай позже — и «выкл» успеет только
// погасить уже зажжённое, вместе с прозвучавшим шипением.
// Number(null) === 0, а 0 — это законное значение «выкл», поэтому проверять
// надо СЫРУЮ строку. Ровно на этом уже горел износ газона: пустой
// localStorage читался как выбранный ноль.
const savedPyroRaw = localStorage.getItem('f98.pyro');
const savedPyro = Number(savedPyroRaw);
const pyroLevel = (savedPyroRaw !== null && Number.isFinite(savedPyro)
  && savedPyro >= 0 && savedPyro <= 150) ? savedPyro : 100;
if (scene.userData.flares) scene.userData.flares.setLevel(pyroLevel / 100);
if (scene.userData.confetti) scene.userData.confetti.setLevel(pyroLevel / 100);

const goals = scene.userData.goals;
const ball = new Ball(scene, goals);
const input = new Input();
const crt = new CRTPipeline(renderer);

// Матч 11×11: команды приходят из пака атрибутики (см. src/pack.js).
// Пак уже загружен к этому моменту — модуль ждёт его на верхнем уровне.
let match = null;
if (PACK.teams) {
  match = new Match(scene, ball, goals, input, PACK.teams);
} else {
  console.error('Пак без составов: матч не запущен.');
}

const camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, 16 / 9, 0.5, 400);
// Сразу ставим камеру на позицию ТВ-оператора (lerp в цикле — только для слежения за мячом)
camera.position.set(0, CONFIG.camera.height, CONFIG.camera.distance);
camera.lookAt(0, 1, 0);

// --- Жучок телеканала в левом верхнем углу ---
// Картинку назначает ПАК атрибутики: у своей сборки реальный УТ-1, у публичной
// вымышленный УГ-1 (правило лицензионного слоя — брендов в коде нет).
// Пак без логотипа — блок молча не показывается.
const channelLogo = document.getElementById('channel-logo');
if (channelLogo && PACK.textures.channelLogo) {
  channelLogo.addEventListener('load', () => channelLogo.classList.add('show'));
  channelLogo.addEventListener('error', () => {
    console.warn('Не загрузился логотип канала:', PACK.textures.channelLogo);
  });
  channelLogo.src = PACK.textures.channelLogo;
}

// ===== Панель телевизора =====
// Настройки картинки живут на КОРПУСЕ, а не в меню: канал, яркость, контраст
// и цвет — аналоговые ручки, чёткость и износ газона — клавиши. В меню
// осталось только то, чего на телевизоре 98-го быть не могло (геймплей,
// камера, справочник управления).

const remember = (key, value) => {
  try { localStorage.setItem(key, String(value)); } catch (e) { /* приватный режим */ }
};

// --- Клавиша ЧЁТКОСТЬ: перебор ступеней внутреннего рендера ---
// Строчность кинескопа и зерно к разрешению НЕ привязаны
// (CONFIG.render.scanLines / grainRes), поэтому 720p не съедает ретро-дух.
const keySharp = document.getElementById('key-sharp');
const HEIGHTS = CONFIG.render.heights;
let qualityIdx = 0;

function applyQuality(height, save = false) {
  const i = HEIGHTS.findIndex(([h]) => h === height);
  qualityIdx = i >= 0 ? i : HEIGHTS.findIndex(([h]) => h === CONFIG.render.targetHeight);
  if (qualityIdx < 0) qualityIdx = 0;
  const h = HEIGHTS[qualityIdx][0];
  keySharp.querySelector('b').textContent = `${h}p`;
  crt.setHeight(h);
  // Вспышки меряют себя в метрах, а рисуются в пикселях буфера — им нужно
  // знать новую высоту, иначе на 720p они станут вдвое крупнее.
  if (scene.userData.flashes) scene.userData.flashes.setRenderHeight(h);
  // Мошкара меряется в метрах ровно так же, как вспышки
  if (scene.userData.midges) scene.userData.midges.setRenderHeight(h);
  if (save) remember('f98.renderHeight', h);
}

const savedQuality = Number(localStorage.getItem('f98.renderHeight'));
applyQuality(Number.isFinite(savedQuality) && savedQuality > 0
  ? savedQuality : CONFIG.render.targetHeight);
keySharp.addEventListener('click', () => {
  applyQuality(HEIGHTS[(qualityIdx + 1) % HEIGHTS.length][0], true);
});

// --- Клавиша ГАЗОН: износ поля пятью ступенями ---
// Плавный ползунок никуда не делся по сути — три карты по-прежнему
// смешиваются в CanvasTexture, просто щёлкаем по круглым значениям.
const keyPitch = document.getElementById('key-pitch');
const WEARS = [0, 25, 50, 75, 100];
let wearIdx = 2;

function wearLabel(v) {
  if (v === 50) return 'середина';
  if (v <= 15) return 'ухожен';
  if (v <= 35) return 'лёгкий';
  if (v <= 65) return 'умерен.';
  if (v <= 85) return 'поношен';
  return 'вытоптан';
}

function applyPitchWear(value, save = false) {
  const v = WEARS.reduce((a, b) => (Math.abs(b - value) < Math.abs(a - value) ? b : a), WEARS[2]);
  wearIdx = WEARS.indexOf(v);
  keyPitch.querySelector('b').textContent = `${v}% ${wearLabel(v)}`;
  scene.userData.setPitchWear(v / 100);
  if (save) remember('f98.pitchWear', v);
}

// Number(null) === 0, поэтому проверять надо СЫРУЮ строку: без этого пустой
// localStorage читался как «износ 0%» и поле стартовало ухоженным.
const savedWearRaw = localStorage.getItem('f98.pitchWear');
const savedWear = Number(savedWearRaw);
applyPitchWear(savedWearRaw !== null && Number.isFinite(savedWear) &&
  savedWear >= 0 && savedWear <= 100
  ? savedWear : CONFIG.atmosphere.pitchWear.default * 100);
keyPitch.addEventListener('click', () => {
  applyPitchWear(WEARS[(wearIdx + 1) % WEARS.length], true);
});

// --- Ручки картинки: множители ПОВЕРХ пресета ---
// Пресет задаёт характер канала, ручка правит его под свою комнату — ровно
// как на настоящем телевизоре. Смена канала ручки не сбрасывает.
//
// СБРОС ПРИ ПЕРЕБАЗИРОВКЕ ГРЕЙДИНГА. Когда положение ручек впечатывают в
// каналы (28.07.2026: ЯРКОСТЬ −1, КОНТРАСТ −2, ЦВЕТ +1 стали нулём), у всех,
// кто эти ручки уже покрутил, в localStorage лежит старая поправка — и она
// НАЛОЖИТСЯ на новую базу, удвоив эффект. Поэтому у базы есть версия: сменилась
// — ручки один раз возвращаются в ноль. Правишь brightness/contrast/saturation
// пресетов вслед за ручками — обязательно меняй и эту строку.
const GRADE_BASE = '2026-07-28';
if (localStorage.getItem('f98.gradeBase') !== GRADE_BASE) {
  for (const key of ['gain', 'contrast', 'color']) localStorage.removeItem(`f98.knob.${key}`);
  remember('f98.gradeBase', GRADE_BASE);
}

const knobs = {};
const KNOBS = [
  ['gain', 'knob-gain', 0.70, 1.35],
  ['contrast', 'knob-contrast', 0.72, 1.32],
  ['color', 'knob-color', 0.00, 1.70],
];
for (const [key, id, min, max] of KNOBS) {
  const saved = Number(localStorage.getItem(`f98.knob.${key}`));
  knobs[key] = new Knob(document.getElementById(id), {
    min, max, def: 1, value: Number.isFinite(saved) && saved > 0 ? saved : 1,
    // На шкале телевизора не проценты, а отклонение от нуля-середины
    format: (v) => {
      const n = Math.round((v - 1) * 20);
      return n === 0 ? '0' : (n > 0 ? `+${n}` : String(n));
    },
    onChange: (v) => {
      crt.setKnobs({ [key]: v });
      remember(`f98.knob.${key}`, v.toFixed(3));
    },
  });
}
crt.setKnobs({ gain: knobs.gain.value, contrast: knobs.contrast.value, color: knobs.color.value });

// --- Ручка КАНАЛ: перебор ТВ-пресетов ---
// Стартовая картинка — чистый RGB («оригинал»): пусть игрок сам решит, когда
// накинуть эфирный шум или VHS. Какой пресет стартовый — решают ДАННЫЕ
// (tv-presets.json → "default"), а выбор игрока переживает перезапуск.
// Пресеты с "hidden": true остаются в файле, но в переборе не участвуют.
let presets = [];
let channelKnob = null;

fetch('./data/tv-presets.json')
  .then((r) => r.json())
  .then((data) => {
    presets = data.presets.filter((p) => !p.hidden);
    if (!presets.length) throw new Error('в tv-presets.json не осталось видимых пресетов');
    const saved = localStorage.getItem('f98.tvPreset');
    const savedIdx = presets.findIndex((p) => p.id === saved);
    const defIdx = presets.findIndex((p) => p.id === data.default);
    const start = savedIdx >= 0 ? savedIdx : Math.max(0, defIdx);
    channelKnob = new Knob(document.getElementById('knob-channel'), {
      min: 0, max: presets.length - 1, step: 1, def: Math.max(0, defIdx), value: start,
      format: (i) => presets[i].name,
      onChange: (i) => {
        crt.setPreset(presets[i]);
        remember('f98.tvPreset', presets[i].id);
      },
    });
    crt.setPreset(presets[start]);
  })
  .catch((e) => console.error('Не удалось загрузить ТВ-пресеты:', e));

// --- Клавиша ВО ВЕСЬ ЭКРАН ---
// Панель ручек уезжает, рамка корпуса схлопывается, картинка занимает всё окно.
// Стекло при этом МЕНЯЕТ РАЗМЕР без события resize у окна, поэтому кэш
// прямоугольника надо сбросить руками — иначе управление и холст рендера
// останутся жить по старым границам (src/tvset.js → invalidateScreenRect).
// Настоящий полноэкранный режим браузера просим сверху, но лишь по
// возможности: на iPad он для обычных элементов не работает, а прятать
// панель это не мешает.
const fsExit = document.getElementById('fs-exit');

function setFullscreen(on, save = true) {
  document.body.classList.toggle('tv-full', on);
  invalidateScreenRect();
  resize();
  if (save) remember('f98.fullscreen', on ? '1' : '0');
}

function toggleFullscreen() {
  const on = !document.body.classList.contains('tv-full');
  setFullscreen(on);
  if (on) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

document.getElementById('key-full').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleFullscreen();
});
// Кнопка живёт на стекле, а слушатели управления — на window: без остановки
// всплытия тап по ней заодно взводил бы игровой жест (та же грабля, что с ручками)
fsExit.addEventListener('pointerdown', (e) => e.stopPropagation());
fsExit.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleFullscreen();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('tv-full')) toggleFullscreen();
});
// Браузер вышел из полноэкранного сам (Esc, свайп) — возвращаем корпус
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && document.body.classList.contains('tv-full')) setFullscreen(false);
});
// Режим переживает перезапуск: снимать ролики удобнее без лишнего клика.
// Настоящий полноэкранный режим браузера при загрузке не попросишь — он
// требует жеста пользователя, поэтому восстанавливаем только спрятанный корпус.
if (localStorage.getItem('f98.fullscreen') === '1') setFullscreen(true, false);

// --- Клавиша НАСТРОЙКИ: меню на стекле ---
const settingsPanel = document.getElementById('settings');
document.getElementById('key-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  settingsPanel.classList.toggle('show');
});
document.getElementById('settings-close').addEventListener('click', (e) => {
  e.stopPropagation();
  settingsPanel.classList.remove('show');
});

// --- Складные разделы меню ---
// Разметку собираем КОДОМ: каждый <h3> забирает под себя всё до следующего
// <h3>. Так новый раздел не требует ни строчки вёрстки — написал заголовок,
// и он уже складывается. Стартовое состояние берётся из data-open (длинный
// справочник управления свёрнут), выбор игрока переживает перезапуск.
const foldBtn = document.getElementById('settings-fold');
const sections = [];
for (const head of [...settingsPanel.querySelectorAll('h3')]) {
  const body = document.createElement('div');
  body.className = 'sect';
  let node = head.nextSibling;
  while (node && !(node.nodeType === 1 && node.tagName === 'H3')) {
    const next = node.nextSibling;
    body.appendChild(node);
    node = next;
  }
  head.after(body);
  const key = `f98.fold.${head.textContent.trim()}`;
  const saved = localStorage.getItem(key);
  const open = saved !== null ? saved === '1' : head.dataset.open !== '0';
  head.classList.toggle('folded', !open);
  head.addEventListener('click', () => {
    head.classList.toggle('folded');
    remember(key, head.classList.contains('folded') ? '0' : '1');
    syncFoldBtn();
  });
  sections.push({ head, key });
}

function syncFoldBtn() {
  const anyOpen = sections.some((s) => !s.head.classList.contains('folded'));
  foldBtn.textContent = anyOpen ? 'СВЕРНУТЬ ВСЁ' : 'РАЗВЕРНУТЬ ВСЁ';
}

foldBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const fold = sections.some((s) => !s.head.classList.contains('folded'));
  for (const s of sections) {
    s.head.classList.toggle('folded', fold);
    remember(s.key, fold ? '0' : '1');
  }
  syncFoldBtn();
  settingsPanel.scrollTop = 0;
});
syncFoldBtn();

// Темп игры: множитель хода игрового времени (Game Speed из PES).
// Пишем прямо в живой CONFIG — frame() читает его каждый кадр, поэтому
// ползунок меняет темп на ходу, без перезапуска матча.
const tempoSlider = document.getElementById('set-tempo');
const tempoVal = document.getElementById('set-tempo-val');
const TEMPO_LABEL = { 70: 'очень размеренный', 80: 'размеренный', 90: 'спокойный', 100: 'обычный', 110: 'быстрый' };
const savedTempo = Number(localStorage.getItem('f98.gameSpeed'));
if (savedTempo >= 70 && savedTempo <= 110) CONFIG.gameSpeed = savedTempo / 100;
tempoSlider.value = Math.round(CONFIG.gameSpeed * 100);
tempoVal.textContent = TEMPO_LABEL[tempoSlider.value] || `${tempoSlider.value}%`;
tempoSlider.addEventListener('input', () => {
  CONFIG.gameSpeed = Number(tempoSlider.value) / 100;
  tempoVal.textContent = TEMPO_LABEL[tempoSlider.value] || `${tempoSlider.value}%`;
  remember('f98.gameSpeed', tempoSlider.value);
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

// Пиротехника: множитель бюджета файеров. 0 — выкл (дым — самая дорогая
// часть кадра на планшете), 100% — как задумано, 150% — вовсю.
// Само значение уже прочитано и применено выше, до создания матча.
const pyroSlider = document.getElementById('set-pyro');
const pyroVal = document.getElementById('set-pyro-val');
const PYRO_LABEL = { 0: 'выкл', 50: 'редко', 100: 'как в эфире', 150: 'вовсю' };

function applyPyro(v, save = false) {
  pyroSlider.value = v;
  pyroVal.textContent = PYRO_LABEL[v] || `${v}%`;
  if (scene.userData.flares) scene.userData.flares.setLevel(v / 100);
  // Серпантин — часть того же зрелища, что и файеры: одна ручка на оба
  if (scene.userData.confetti) scene.userData.confetti.setLevel(v / 100);
  if (save) remember('f98.pyro', v);
}

applyPyro(pyroLevel);
pyroSlider.addEventListener('input', () => applyPyro(Number(pyroSlider.value), true));

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

// --- Размер стекла ---
// Считаем от ЭКРАНА ТЕЛЕВИЗОРА, а не от окна: вокруг него теперь корпус
// с панелью ручек, и окно заметно шире кадра (src/tvset.js → screenRect).
function resize() {
  const r = screenRect();
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  crt.resize(w, h);
}
// screenRect кэширует прямоугольник и сбрасывает кэш по своему слушателю
// resize; наш обработчик обязан идти ПОСЛЕ него, иначе прочитаем старый размер.
window.addEventListener('resize', () => requestAnimationFrame(resize));
window.addEventListener('orientationchange', () => setTimeout(resize, 120));
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

// Сглаженные позиция и скорость мяча ДЛЯ КАМЕРЫ (фидбек Олега 22.07: «дёрганная»).
// Сырые ball.pos/ball.vel скачут на каждом касании/отскоке — камера рвала кадр.
// Низкочастотный фильтр даёт плавную цель слежения и упреждения.
const camBallPos = new THREE.Vector3();
const camBallVel = new THREE.Vector3();
let camInit = false;

// Ловля монтажных склеек для ТВ-прохода (см. конец frame()).
// 4 м за кадр камера в игре не проходит никогда: доводка идёт долей от 60 Гц,
// а цель отстоит от неё на единицы метров. Поворот на 25° (косинус 0.906) —
// тоже заведомо больше, чем даёт панорама за живым мячом.
const CUT_DIST = 4;
const CUT_DOT = 0.906;
const prevCamPos = new THREE.Vector3(0, CONFIG.camera.height, CONFIG.camera.distance);
const prevCamDir = new THREE.Vector3(0, 0, -1);
const camDir = new THREE.Vector3();

// Плавная кривая 0..1 для выхода из ТВ-заставки (копия smooth01 из match.js)
function smooth01(t) {
  const k = Math.max(0, Math.min(1, t));
  return k * k * (3 - 2 * k);
}

function frame() {
  const dt = Math.min(clock.getDelta(), 1 / 30); // защита от рывка после сворачивания вкладки
  // ТЕМП ИГРЫ. Кадр делится надвое: ИГРОВОЕ время (gdt) и РЕАЛЬНОЕ (dt).
  // По игровому живёт всё, что относится к матчу, — ввод, 22 игрока с их
  // анимацией, мяч, ворота, часы, повтор. По реальному — стадион и стекло
  // кинескопа: трибуна, файеры, мошкара, ветер в футболках, доводка камеры,
  // послесвечение ТВ-прохода. Их темп к футболу отношения не имеет, и
  // замедлять дым вместе с игрой значило бы объявлять слоу-мо всему кадру.
  const gdt = dt * CONFIG.gameSpeed;
  // Часы ветра в футболках — ОДИН объект на весь матч. Все 22 материала
  // формы держат на него ссылку, поэтому это присваивание заменяет
  // двадцать два обновления юниформа.
  clothTime.value += dt;
  const t = clock.elapsedTime;

  input.update(gdt);
  if (match) match.update(gdt); // 22 игрока: человек + AI-мозги
  // На повторе физика молчит: тела и мяч расставляет запись (src/replay.js).
  // В празднование мяч уже в сетке — его физику тоже не трогаем.
  const replaying = !!(match && (match.state === 'replay' || match.state === 'celebration'));
  const event = replaying ? null : ball.update(gdt);
  if (!replaying) goals.update(gdt);
  // Атмосфера: веер теней ставится ПОСЛЕ движения игроков, вспышки живут сами
  if (scene.userData.shadows) scene.userData.shadows.update();
  if (scene.userData.flashes) scene.userData.flashes.update(dt);
  if (scene.userData.flares) scene.userData.flares.update(dt);
  if (scene.userData.midges) scene.userData.midges.update(dt);
  if (scene.userData.wave) scene.userData.wave.update(dt);
  if (scene.userData.confetti) scene.userData.confetti.update(dt);
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

  // Низкочастотный фильтр позиции и скорости мяча: убирает дрожь от касаний
  // и отскоков, из-за которой камера дёргалась (фидбек Олега 22.07).
  if (!camInit) {
    camBallPos.copy(ball.mesh.position);
    camBallVel.copy(ball.vel);
    camInit = true;
  } else {
    const posK = Math.min(1, C.followSmooth * dt);
    const velK = Math.min(1, C.leadSmooth * dt);
    camBallPos.x += (ball.mesh.position.x - camBallPos.x) * posK;
    camBallPos.z += (ball.mesh.position.z - camBallPos.z) * posK;
    camBallVel.x += (ball.vel.x - camBallVel.x) * velK;
    camBallVel.z += (ball.vel.z - camBallVel.z) * velK;
  }
  const bx = camBallPos.x;
  const bz = camBallPos.z;
  const ballSpeed = Math.hypot(camBallVel.x, camBallVel.z);
  // Упреждение: фокус-точка смещена туда, куда мяч летит (по сглаженной скорости)
  const leadX = Math.max(-C.leadMax, Math.min(C.leadMax, camBallVel.x * C.lead));
  const leadZ = Math.max(-C.leadMax * 0.6, Math.min(C.leadMax * 0.6, camBallVel.z * C.lead * 0.6));
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
  // Приоритет камер: повтор → празднование → ТВ-заставка → живая ТВ-камера.
  // У повтора и празднования камеры свои и уже плавные, поэтому обычное
  // сглаживание тут только смазало бы кадр.
  const rc = (match && match.replay && match.replay.cam)
    || (match && match.celebration && match.celebration.cam);
  const ic = match && match.introCam;
  if (rc) {
    camera.position.copy(rc.pos);
    camLook.copy(rc.look);
  } else if (ic) {
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
  // Мачты в пространство вида — ПОСЛЕ lookAt, иначе кайма отстанет на кадр и
  // на облёте камеры повтора будет «плавать». Четыре вектора на всю сцену,
  // а не на игрока: сам контровик считается в шейдере (src/rimlight.js).
  camera.updateMatrixWorld();
  updateRim(camera);

  // СКЛЕЙКА. У ТВ-прохода есть буфер истории (послесвечение люминофора и
  // чересстрочность), и на монтажном стыке — смене ракурса повтора, старте
  // празднования, прыжке на стандарт — он потянул бы старый план через новый
  // наплывом. Ловим прыжок здесь, по самой камере, а не расставляем вызовы по
  // match.js и replay.js: так ни один будущий ракурс не забудут подключить.
  // Порог с запасом: в игре камера едет доводкой и за кадр проходит меньше
  // метра, повтор же прыгает на десятки.
  // Направление считаем ДО проверки, а не внутри неё: при `||` короткое
  // замыкание пропустило бы getWorldDirection на кадре, где сработал порог по
  // расстоянию, и в prevCamDir уехало бы позавчерашнее значение.
  camera.getWorldDirection(camDir);
  const jump = camera.position.distanceToSquared(prevCamPos) > CUT_DIST * CUT_DIST
    || camDir.dot(prevCamDir) < CUT_DOT;
  if (jump) crt.cut();
  prevCamPos.copy(camera.position);
  prevCamDir.copy(camDir);

  if (NO_CRT) renderer.render(scene, camera);
  else crt.render(scene, camera, t);
  requestAnimationFrame(frame);
}

// Отладка: ?nocrt в адресе — рендер без CRT-прохода
const NO_CRT = location.search.includes('nocrt');
window.DBG = { scene, camera, camLook, ball, input, crt, renderer, goals, CONFIG, match, PACK };

frame();
