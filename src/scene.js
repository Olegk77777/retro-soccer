// Сцена стадиона: газон с разметкой, ворота, трибуны, прожекторы.
// Геометрия — из примитивов, а крупные цветовые карты дают фактуру 1998-го.
// Если PNG не загрузился, canvas-заглушка остаётся: белого/чёрного экрана нет.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { PACK } from './pack.js';
import { GoalSystem } from './goal.js';
import {
  mastPositions, paintPitchLight, buildFloodlightHalos, buildLightShafts,
  CameraFlashes, GroundShadows, Midges, CrowdWave,
} from './atmosphere.js';
import { Flares } from './flares.js';
import { Confetti } from './confetti.js';
import { initRim, addRim } from './rimlight.js';

const STADIUM_TEXTURES = Object.freeze({
  pitchBalanced: './textures/stadium/pitch-balanced-98.png',
  pitchWorn: './textures/stadium/pitch-worn-98.png',
  grass: './textures/stadium/grass-98.png',
  crowd: './textures/stadium/crowd-night-98-fine.png',
  // Щиты — часть атрибутики: их назначает пак (src/pack.js). null = остаются
  // процедурные щиты с выдуманными марками эпохи, нарисованные ниже на canvas.
  boards: PACK.textures.boards,
});

// Один Image на файл: текстуры грузятся и для поля, и для окружения асинхронно,
// но один и тот же PNG дважды качать незачем.
const imageCache = new Map();
const textureClones = new WeakMap();
function loadTextureImage(path) {
  if (!imageCache.has(path)) {
    imageCache.set(path, new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Не загрузилась текстура: ${path}`));
      img.src = path;
    }));
  }
  return imageCache.get(path);
}

function configureColorTexture(tex, { wrap = false, anisotropy = 4 } = {}) {
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.colorSpace = THREE.SRGBColorSpace;
  if (wrap) {
    tex.wrapS = THREE.MirroredRepeatWrapping;
    tex.wrapT = THREE.MirroredRepeatWrapping;
  }
  return tex;
}

function markTextureDirty(tex) {
  tex.needsUpdate = true;
  for (const clone of textureClones.get(tex) || []) clone.needsUpdate = true;
}

// Чередуем обычную и зеркальную плитку: даже если края AI-текстуры не идеальны,
// стыки совпадают пиксель-в-пиксель и не рисуют клетку на поле.
function drawMirroredTiles(ctx, img, width, height, tileSize) {
  for (let y = 0, iy = 0; y < height; y += tileSize, iy++) {
    for (let x = 0, ix = 0; x < width; x += tileSize, ix++) {
      const flipX = ix % 2 === 1;
      const flipY = iy % 2 === 1;
      ctx.save();
      ctx.translate(x + (flipX ? tileSize : 0), y + (flipY ? tileSize : 0));
      ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
      ctx.drawImage(img, 0, 0, tileSize, tileSize);
      ctx.restore();
    }
  }
}

// Текстура газона: три степени износа плавно смешиваются на canvas.
// 0% — прежняя ухоженная плитка; 50% — умеренная карта всего поля;
// 100% — сильно вытоптанная. Разметка остаётся кодом: так её размеры всегда
// точны, а на дальней камере линии не мигают.
/**
 * Развести яркость травы от её СОБСТВЕННОЙ средней. Зовётся один раз при
 * сборке текстуры (и при смене износа), поэтому в кадре не стоит ничего.
 *
 * Пивот считается по самой карте, а не берётся 0.5: газон живёт около 0.35
 * по яркости, и разведение вокруг середины шкалы просто утопило бы его.
 * Считаем по ЯРКОСТИ и масштабируем все три канала одинаково — иначе тёмные
 * места уходят в грязно-бурый, а светлые в кислотный салат.
 */
function boostGrassContrast(ctx, w, h) {
  const k = CONFIG.atmosphere.pitchTexture.contrast;
  if (!(k > 1.001)) return;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const pivot = sum / (d.length / 4);
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    // Множитель на канал: сохраняет оттенок, меняет только светлоту
    const s = y > 0.5 ? (pivot + (y - pivot) * k) / y : 1;
    d[i] = Math.max(0, Math.min(255, d[i] * s));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] * s));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] * s));
  }
  ctx.putImageData(img, 0, 0);
}

// Покос — отдельный лёгкий слой поверх любой карты износа. Прямой вариант
// рисуется полосами от бровки до бровки; круговой — концентрическими кольцами
// вокруг центра поля, которые на каждой половине читаются полукругами.
function paintMowingPattern(ctx, w, h, pattern, mow, scale, fallback = false) {
  const toneStyle = (tone, index) => {
    if (fallback) return index % 2 === 0 ? '#4d9038' : '#5aa344';
    const value = tone * mow;
    return value < 0
      ? `rgba(0,0,0,${-value})`
      : `rgba(255,255,215,${value})`;
  };

  if (pattern.kind === 'rings') {
    const bandW = pattern.bandMeters * scale;
    const maxR = Math.hypot(w / 2, h / 2);
    const bands = Math.ceil(maxR / bandW);
    ctx.save();
    ctx.lineWidth = bandW + 1;
    for (let i = bands - 1; i >= 0; i--) {
      ctx.strokeStyle = toneStyle(pattern.tones[i % pattern.tones.length], i);
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, (i + 0.5) * bandW, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  const stripeW = w / pattern.tones.length;
  for (let i = 0; i < pattern.tones.length; i++) {
    ctx.fillStyle = toneStyle(pattern.tones[i], i);
    ctx.fillRect(i * stripeW, 0, stripeW + 1, h);
  }
}

function createPitchTexture() {
  const F = CONFIG.field;
  const scale = 10; // пикселей на метр
  const w = F.length * scale;
  const h = F.width * scale;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const m = (v) => v * scale;
  const cx = w / 2;
  const cy = h / 2;
  const layers = { clean: null, balanced: null, worn: null };
  let wear = Math.max(0, Math.min(1, CONFIG.atmosphere.pitchWear.default));
  const patternConfig = CONFIG.atmosphere.pitchTexture;
  const findPattern = (id) => patternConfig.patterns.find((item) => item.id === id);
  let pattern = (findPattern(patternConfig.defaultPattern) || patternConfig.patterns[0]).id;

  // Каждую исходную карту заранее приводим к одной яркости. Старая плитка
  // темнее полноразмерных карт и требует той же подсветки, что была у неё
  // до появления ползунка; иначе ползунок менял бы не износ, а экспозицию.
  const buildLayer = (img, kind) => {
    const layer = document.createElement('canvas');
    layer.width = w;
    layer.height = h;
    const lctx = layer.getContext('2d');
    lctx.imageSmoothingEnabled = true;
    if (kind === 'clean') drawMirroredTiles(lctx, img, w, h, m(18));
    else lctx.drawImage(img, 0, 0, w, h);

    lctx.save();
    lctx.globalCompositeOperation = 'screen';
    if (kind === 'clean') lctx.fillStyle = 'rgba(95,185,65,0.46)';
    else if (kind === 'balanced') lctx.fillStyle = 'rgba(95,150,65,0.42)';
    else lctx.fillStyle = 'rgba(70,140,55,0.12)';
    lctx.fillRect(0, 0, w, h);
    lctx.restore();
    return layer;
  };

  const drawWearBase = () => {
    const clean = layers.clean || layers.balanced || layers.worn;
    const balanced = layers.balanced || clean || layers.worn;
    const worn = layers.worn || balanced || clean;
    if (!clean && !balanced && !worn) return false;

    let from;
    let to;
    let mix;
    if (wear <= 0.5) {
      from = clean;
      to = balanced;
      mix = wear * 2;
    } else {
      from = balanced;
      to = worn;
      mix = (wear - 0.5) * 2;
    }

    const first = from || to;
    const second = to || from;
    ctx.globalAlpha = 1;
    ctx.drawImage(first, 0, 0);
    if (second && second !== first && mix > 0) {
      ctx.globalAlpha = mix;
      ctx.drawImage(second, 0, 0);
      ctx.globalAlpha = 1;
    }
    return true;
  };

  const paint = () => {
    ctx.clearRect(0, 0, w, h);

    if (drawWearBase()) {
      // Полосы не идеальная шахматка: сила каждой немного отличается, как после
      // реальной стрижки и нескольких матчей, но ритм телеполя 90-х сохраняется.
      //
      // ПОРЯДОК ВАЖЕН: полосы кладутся ДО boostGrassContrast, потому что покос
      // — это и есть газон, и разводить их яркость надо вместе с зернистостью
      // травы. 28.07.2026 они стояли ПОСЛЕ, и Олег сразу это увидел: «полосы
      // поперёк поля почти незаметны — их съела текстура газона». Замер
      // подтвердил арифметику. Перепад между соседними полосами не изменился
      // (6.19 → 6.37 из 255), а зерно вокруг них выросло вместе с контрастом
      // (7.59 → 10.25), и полосы утонули: отношение полосы/зерно упало с 0.81
      // до 0.62, а размах полос в кадре — с 8.6 % средней яркости до 5.5 %.
      // Под общим множителем оба числа растут заодно, и отношение держится
      // само — при любой будущей правке pitchTexture.contrast.
      paintMowingPattern(ctx, w, h, findPattern(pattern), patternConfig.mow, scale);

      // Собственный контраст ТРАВЫ — до света мачт и разметки, чтобы тронуть
      // только сам газон (правило с 28.07.2026, фидбек Олега «газон раньше был
      // не так равномерно освещён, это давало больший объём»).
      //
      // Замер объяснил жалобу точнее, чем она была сформулирована. Пятна
      // прожекторов НЕ ослабли — локальный контраст поперёк кадра даже вырос
      // (27.5% → 30.8%). Просела ФАКТУРА: абсолютный градиент яркости остался
      // прежним (10.58 → 10.39), а средняя яркость газона поднялась с 86 до
      // 105, и та же зернистость на более светлом основании читается на пятую
      // часть слабее (12.3% → 9.9%). Трава превратилась в ровное сукно.
      //
      // Лечится в ИСТОЧНИКЕ, а не экспозицией: тянуть вниз весь кадр — значит
      // снова похоронить трибуну, которую только что вытащили. Разводим
      // яркость от СРЕДНЕЙ ПО КАРТЕ (не от 0.5: газон живёт около 0.35, и
      // пивот в середине шкалы просто затемнил бы его целиком).
      boostGrassContrast(ctx, w, h);

      // Свет мачт: четыре пятна и потемневшие края. Ровное зелёное сукно —
      // первый признак «примитивной» картинки, ночью так не бывает.
      // Стоит ПОСЛЕ разведения: контраст пятен уже выставлен (30.8 %), и
      // усиливать его заодно с травой нельзя — свет станет пятнистым.
      paintPitchLight(ctx, w, h);
    } else {
      // Мгновенный фолбэк на время загрузки PNG и на случай 404.
      ctx.fillStyle = '#559b3e';
      ctx.fillRect(0, 0, w, h);
      paintMowingPattern(ctx, w, h, findPattern(pattern), 1, scale, true);
      for (let i = 0; i < 9000; i++) {
        const x = Math.random() * w;
        const y = Math.random() * h;
        ctx.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.05)';
        ctx.fillRect(x, y, 2, 2);
      }
    }

    // Разметка (белые линии). Размеры — стандарт ФИФА, в метрах × scale.
    // Линии толще реальных (0.3 м): при сжатии кадра тонкие бьются в пунктир.
    ctx.strokeStyle = '#e8e8e4';
    ctx.fillStyle = '#e8e8e4';
    ctx.lineWidth = 0.3 * scale;

    ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, w - ctx.lineWidth * 2, h - ctx.lineWidth * 2);
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, m(9.15), 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, m(0.22), 0, Math.PI * 2); ctx.fill();

    for (const side of [0, 1]) {
      const dir = side === 0 ? 1 : -1;
      const gx = side === 0 ? 0 : w;
      ctx.strokeRect(side === 0 ? 0 : w - m(16.5), cy - m(20.16), m(16.5), m(40.32));
      ctx.strokeRect(side === 0 ? 0 : w - m(5.5), cy - m(9.16), m(5.5), m(18.32));
      ctx.beginPath(); ctx.arc(gx + dir * m(11), cy, m(0.22), 0, Math.PI * 2); ctx.fill();
      ctx.beginPath();
      const a = Math.acos(m(5.5) / m(9.15));
      if (side === 0) ctx.arc(gx + m(11), cy, m(9.15), -a, a);
      else ctx.arc(gx - m(11), cy, m(9.15), Math.PI - a, Math.PI + a);
      ctx.stroke();
    }
  };

  paint();
  const tex = configureColorTexture(new THREE.CanvasTexture(c));
  tex.userData.setWear = (value) => {
    wear = Math.max(0, Math.min(1, Number(value) || 0));
    paint();
    markTextureDirty(tex);
  };
  tex.userData.getWear = () => wear;
  tex.userData.setPattern = (value) => {
    const next = findPattern(String(value));
    if (!next || next.id === pattern) return;
    pattern = next.id;
    paint();
    markTextureDirty(tex);
  };
  tex.userData.getPattern = () => pattern;

  const sources = [
    ['clean', STADIUM_TEXTURES.grass],
    ['balanced', STADIUM_TEXTURES.pitchBalanced],
    ['worn', STADIUM_TEXTURES.pitchWorn],
  ];
  for (const [kind, path] of sources) {
    loadTextureImage(path)
      .then((img) => {
        layers[kind] = buildLayer(img, kind);
        paint();
        markTextureDirty(tex);
      })
      .catch((e) => console.warn(e.message));
  }
  return tex;
}

// Общая карта пола за бровкой: тёмная трава + олимпийская дорожка в одном
// непрозрачном canvas. Так нет второго draw call, прозрачной сортировки и
// z-fighting; асинхронная загрузка травы каждый раз перерисовывает весь слой.
function createApronTexture() {
  const F = CONFIG.field;
  const T = CONFIG.track;
  const apronW = F.length + 150;
  const apronD = F.width + 130;
  const pxPerM = 4;
  const c = document.createElement('canvas');
  c.width = apronW * pxPerM;
  c.height = apronD * pxPerM;
  const ctx = c.getContext('2d');
  const m = (v) => v * pxPerM;
  const cx = c.width / 2;
  const cz = c.height / 2;
  const laneOuter = T.innerRadius + T.lanes * T.laneWidth;
  const fullOuter = laneOuter + T.shoulder;

  // Замкнутый «стадион»: две прямые и две полуокружности.
  const ovalSubpath = (radius) => {
    const h = m(T.straightHalf);
    const r = m(radius);
    ctx.moveTo(cx - h, cz - r);
    ctx.lineTo(cx + h, cz - r);
    ctx.arc(cx + h, cz, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(cx - h, cz + r);
    ctx.arc(cx - h, cz, r, Math.PI / 2, Math.PI * 1.5);
    ctx.closePath();
  };

  const fillBand = (outer, inner, color) => {
    ctx.beginPath();
    ovalSubpath(outer);
    ovalSubpath(inner);
    ctx.fillStyle = color;
    ctx.fill('evenodd');
  };

  const paint = (grass = null) => {
    ctx.clearRect(0, 0, c.width, c.height);
    if (grass) {
      drawMirroredTiles(ctx, grass, c.width, c.height, m(18));
      ctx.fillStyle = 'rgba(10,24,10,0.43)';
      ctx.fillRect(0, 0, c.width, c.height);
    } else {
      ctx.fillStyle = '#315d25';
      ctx.fillRect(0, 0, c.width, c.height);
      // Детерминированные тёмные/светлые точки — фолбэк тоже не однотонный.
      for (let i = 0; i < 4200; i++) {
        const x = (i * 73) % c.width;
        const y = (i * 151 + (i >> 4) * 19) % c.height;
        ctx.fillStyle = i % 2 ? 'rgba(180,190,145,0.035)' : 'rgba(0,0,0,0.045)';
        ctx.fillRect(x, y, 2, 2);
      }
    }

    // Сначала тёмный внешний ран-аут до основания трибун, затем восемь полос.
    fillBand(fullOuter, laneOuter, T.shoulderColor);
    fillBand(laneOuter, T.innerRadius, T.color);

    // Широкие слабые пятна износа: резина матовая, но не шумит в 480p.
    ctx.save();
    ctx.beginPath();
    ovalSubpath(laneOuter);
    ovalSubpath(T.innerRadius);
    ctx.clip('evenodd');
    for (let i = 0; i < 90; i++) {
      const x = (i * 113 + 47) % c.width;
      const y = (i * 197 + 83) % c.height;
      ctx.fillStyle = i % 3 ? 'rgba(255,210,205,0.025)' : 'rgba(40,0,10,0.035)';
      ctx.beginPath();
      ctx.ellipse(x, y, 5 + (i % 11), 2 + (i % 4), 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Кремовые разделители: выцветшая краска конца 90-х, не ярче поля/рекламы.
    ctx.strokeStyle = T.lineColor;
    ctx.globalAlpha = 0.88;
    ctx.lineWidth = Math.max(1, m(T.lineWidth));
    for (let lane = 0; lane <= T.lanes; lane++) {
      ctx.beginPath();
      ovalSubpath(T.innerRadius + lane * T.laneWidth);
      ctx.stroke();
    }

    // Финишная черта на дальней прямой делает покрытие именно дорожкой.
    const finishX = cx + m(10);
    ctx.globalAlpha = 0.82;
    ctx.lineWidth = Math.max(1.2, m(T.lineWidth) * 1.35);
    ctx.beginPath();
    ctx.moveTo(finishX, cz - m(T.innerRadius));
    ctx.lineTo(finishX, cz - m(laneOuter));
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  paint();

  const tex = configureColorTexture(new THREE.CanvasTexture(c), { anisotropy: 4 });
  tex.magFilter = THREE.LinearFilter; // дуги гладкие, а не ступенчатые
  loadTextureImage(STADIUM_TEXTURES.grass)
    .then((img) => { paint(img); markTextureDirty(tex); })
    .catch((e) => console.warn(e.message));
  return tex;
}

// Текстура толпы: тысячи МЕЛКИХ фигур. Крупные лица превращали дальнюю трибуну
// в стену великанов — в кадре зритель был почти одного роста с футболистом.
function createCrowdTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1c2030';
  ctx.fillRect(0, 0, c.width, c.height);
  const palette = ['#c9b598', '#8898b8', '#b06858', '#d8d0c0', '#587858', '#6878a8', '#a8a098', '#404858'];
  for (let i = 0; i < 6000; i++) {
    ctx.fillStyle = palette[(Math.random() * palette.length) | 0];
    ctx.fillRect(Math.random() * c.width, Math.random() * c.height, 2, 3);
  }
  const tex = configureColorTexture(new THREE.CanvasTexture(c), { anisotropy: 2 });
  // Зеркальный повтор сшивает край пиксель-в-пиксель, даже если генератор
  // картинки не сделал математически бесшовную текстуру.
  tex.wrapS = THREE.MirroredRepeatWrapping;
  textureClones.set(tex, []);
  loadTextureImage(STADIUM_TEXTURES.crowd)
    .then((img) => {
      ctx.drawImage(img, 0, 0, c.width, c.height);
      // Дальний сектор остаётся тёмным, но отдельные головы и флаги должны пережить CRT.
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = 'rgba(90,95,115,0.18)';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.restore();
      markTextureDirty(tex);
    })
    .catch((e) => console.warn(e.message));
  return tex;
}

// Возвращает четыре сектора: по ним потом рассыпаются вспышки фотокамер.
function buildStands(scene) {
  const T = CONFIG.track;
  const S = CONFIG.atmosphere.stands;
  const crowd = createCrowdTexture();

  const standH = S.height;
  const tilt = S.tilt;
  const a = Math.abs(tilt);
  // Трибуна — видимое наклонное полотно, а не закрытый бокс. Невидимые торцы,
  // задник и низ прежнего бокса давали по шесть draw call на сектор и сами же
  // выглядывали в стыках чёрными полосами. Плоскость рисуется одним вызовом.
  const standY = -0.02 + (standH / 2) * Math.cos(a);
  const faceInset = (standH / 2) * Math.sin(a);
  const trackOuter = T.innerRadius + T.lanes * T.laneWidth + T.shoulder;
  const bowlRadius = trackOuter - S.trackInset;
  const stands = [];
  let texturePhase = 0;

  // boundary — точка НИЖНЕГО ряда; inward — единичный вектор к полю.
  // Центр полотна уходит наружу на faceInset, поэтому геометрия не залезает
  // на дорожку. Соседние хорды слегка перекрываются и закрывают тёмные торцы.
  const addSection = (boundaryX, boundaryZ, inwardX, inwardZ, rawLen) => {
    const len = rawLen + S.seamOverlap;
    const phase = texturePhase;
    const tex = crowd.clone();
    tex.needsUpdate = true;
    tex.repeat.set(len / S.textureWorldWidth, 1);
    tex.offset.set(phase / S.textureWorldWidth, 0);
    textureClones.get(crowd).push(tex);
    texturePhase += rawLen;

    // Свет уже «запечён» в изображении; Basic не гасит наклонный сектор.
    // Экспозиция трибуны: камера выставлена ПО ПОЛЮ, а зрительские секторы
    // светят в 5–10 раз слабее газона — значит в эфире они обязаны уходить
    // в нижнюю треть яркости. Базовый уровень запоминаем в userData: вспышки
    // фотокамер после гола пишут color АБСОЛЮТНО и иначе сотрут затемнение.
    const standMat = new THREE.MeshBasicMaterial({
      map: tex,
      side: THREE.DoubleSide,
    });
    standMat.color.setScalar(S.exposure);
    standMat.userData.baseDim = S.exposure;
    const stand = new THREE.Mesh(new THREE.PlaneGeometry(len, standH), standMat);
    stand.rotation.order = 'YXZ';
    stand.rotation.y = Math.atan2(inwardX, inwardZ);
    stand.rotation.x = tilt;
    stand.position.set(
      boundaryX - inwardX * faceInset,
      standY,
      boundaryZ - inwardZ * faceInset,
    );
    scene.add(stand);
    stands.push(stand);
  };

  // Две прямые и две многогранные полуокружности повторяют олимпийский овал.
  // Прежние четыре прямоугольника сходились торцами и раскрывали в углах
  // чёрные щели. Теперь у чаши нет открытых углов.
  const straightLen = T.straightHalf * 2;
  addSection(0, -bowlRadius, 0, 1, straightLen);

  const step = Math.PI / S.curveSegments;
  const chord = 2 * bowlRadius * Math.sin(step / 2);
  const addCap = (centerX, fromAngle) => {
    for (let i = 0; i < S.curveSegments; i++) {
      const angle = fromAngle + (i + 0.5) * step;
      const outwardX = Math.cos(angle);
      const outwardZ = Math.sin(angle);
      addSection(
        centerX + bowlRadius * outwardX,
        bowlRadius * outwardZ,
        -outwardX,
        -outwardZ,
        chord,
      );
    }
  };

  addCap(T.straightHalf, -Math.PI / 2);
  addSection(0, bowlRadius, 0, -1, straightLen);
  addCap(-T.straightHalf, Math.PI / 2);

  return stands;
}

function buildFloodlights(scene) {
  // Столбам мачт кайма нужна не меньше, чем фигурам: серая труба на фоне
  // чёрного неба без неё вообще не читается как объём.
  const poleMat = addRim(
    new THREE.MeshLambertMaterial({ color: 0x555c66 }),
    CONFIG.atmosphere.rim.gearScale,
  );
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff8dd }); // светится сам, без освещения
  const lampGeo = new THREE.BoxGeometry(4.5, 3, 0.8);

  // Мачты стоят там, где их видят пятна на газоне и веер теней —
  // координаты приходят из одного места (CONFIG.atmosphere.masts).
  for (const m of mastPositions()) {
    const poleGeo = new THREE.CylinderGeometry(0.35, 0.5, m.y - 0.5, 6);
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(m.x, (m.y - 0.5) / 2, m.z);
    scene.add(pole);
    const lamp = new THREE.Mesh(lampGeo, lampMat);
    lamp.position.set(m.x, m.y, m.z);
    lamp.lookAt(0, 0, 0);
    scene.add(lamp);
  }
  buildFloodlightHalos(scene);
  buildLightShafts(scene);
}

// До публичного релиза используем настоящие бренды эпохи: они сразу продают кадр как трансляцию 1998-го.
// При подготовке релиза PNG можно заменить без правки геометрии или физики.
function createBoardTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  // Щит имеет пропорцию примерно 48:1. Старые 1024×128 давали вертикальную
  // плотность в шесть раз выше горизонтальной: mipmap выбирался слишком грубый
  // и стирал буквы ещё ДО CRT. 1024×32 ближе к физической пропорции и резче.
  c.height = 32;
  const ctx = c.getContext('2d');
  const ads = [
    ['#c0341d', '#fff', 'СПОРТ·ТВ'],
    ['#f2f2f2', '#1a2a6b', 'КИНЕСКОП'],
    ['#12507a', '#ffd23f', 'ВОЛНА'],
    ['#1f2d1a', '#7fd642', 'ЭФИР 98'],
    ['#e8b21a', '#3a1a00', 'МЕТЕОР'],
    ['#2a2a2a', '#e0e0e0', 'ОРБИТА·888'],
  ];
  const secW = c.width / ads.length;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ads.forEach(([bg, fg, text], i) => {
    ctx.fillStyle = bg;
    ctx.fillRect(i * secW, 0, secW, c.height);
    ctx.fillStyle = fg;
    ctx.font = 'bold 22px "Arial Narrow", Arial, sans-serif';
    ctx.fillText(text, i * secW + secW / 2, c.height / 2 + 2);
  });
  const tex = configureColorTexture(new THREE.CanvasTexture(c), { anisotropy: 8 });
  // Для тонкой полосы щитов trilinear смешивал два mip-уровня и снова мыл
  // буквы. Берём один ближайший mip, но внутри него оставляем linear — резче,
  // без пиксельного мерцания при движении ТВ-камеры.
  tex.minFilter = THREE.LinearMipmapNearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  textureClones.set(tex, []);
  if (STADIUM_TEXTURES.boards) {
    loadTextureImage(STADIUM_TEXTURES.boards)
      .then((img) => {
        ctx.drawImage(img, 0, 0, c.width, c.height);
        markTextureDirty(tex);
      })
      .catch((e) => console.warn(e.message));
  }
  return tex;
}

function buildBoards(scene) {
  const F = CONFIG.field;
  const BD = CONFIG.boards;
  const base = createBoardTexture();
  const bx = F.length / 2 + BD.marginX; // позиция торцевых щитов по X
  const bz = F.width / 2 + BD.marginZ;  // боковых по Z
  const visualH = BD.visualHeight || BD.height;
  const repeatPerMeter = 1 / 48;        // шесть бортов по ~8 м: логотипы читаются крупно, как в 1998-м

  // Один щит: физическая высота остаётся в BD.height, визуальная слегка
  // преувеличена для читаемости с ТВ-камеры (тот же принцип, что у мяча/сетки).
  const board = (len, horizontal) => {
    const tex = base.clone();
    tex.needsUpdate = true;
    tex.repeat.set(len * repeatPerMeter, 1);
    textureClones.get(base).push(tex);
    // Печатные щиты стоят прямо под прожекторами; Basic сохраняет их крупные цвета
    // после CRT и стоит дешевле освещаемого материала.
    const mat = new THREE.MeshBasicMaterial({ map: tex });
    const dark = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
    const geo = new THREE.BoxGeometry(len, visualH, 0.25);
    // текстура — на широкие грани (±Z бокса), торцы тёмные
    const m = new THREE.Mesh(geo, [dark, dark, dark, dark, mat, mat]);
    if (!horizontal) m.rotation.y = Math.PI / 2;
    return m;
  };

  // Северный и южный (вдоль длины поля)
  for (const z of [-bz, bz]) {
    const b = board(F.length + BD.marginX * 2, true);
    b.position.set(0, visualH / 2, z);
    scene.add(b);
  }
  // Западный и восточный (за воротами)
  for (const x of [-bx, bx]) {
    const b = board(F.width + BD.marginZ * 2, false);
    b.position.set(x, visualH / 2, 0);
    scene.add(b);
  }
}

// Ночное небо: не плоская чернота, а зарево стадиона — над чашей висит
// подсвеченная прожекторами дымка, выше она гаснет. Низкие камеры повторов
// смотрят прямо в него, и «дыра» из чёрного цвета выдавала бы примитив.
function createSkyTexture() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, c.height);
  g.addColorStop(0, '#04060e');     // зенит
  g.addColorStop(0.55, '#0a1024');
  g.addColorStop(0.82, '#18243d');
  g.addColorStop(1, '#2b3552');     // зарево над трибунами
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildStadium() {
  const F = CONFIG.field;
  const scene = new THREE.Scene();
  scene.background = createSkyTexture(); // вечернее небо — матч под прожекторами
  // Дымка. Прежние 130 м начинались ДАЛЬШЕ всего, что видно с ТВ-камеры
  // (дальняя трибуна — метров 120), поэтому воздушной перспективы не было
  // вовсе: дальняя половина поля читалась так же контрастно, как ближняя,
  // и кадр выглядел макетом. Теперь дымка стартует сразу за дальней бровкой.
  const HZ = CONFIG.atmosphere.haze;
  scene.fog = new THREE.Fog(HZ.color, HZ.near, HZ.far);

  // Газон с разметкой. MeshBasic = без освещения: яркая «запечённая» картинка,
  // как на PS1 — там свет на поле тоже был нарисован, а не посчитан.
  const pitchTexture = createPitchTexture();
  const pitch = new THREE.Mesh(
    new THREE.PlaneGeometry(F.length, F.width),
    new THREE.MeshBasicMaterial({ map: pitchTexture }),
  );
  pitch.rotation.x = -Math.PI / 2;
  scene.add(pitch);
  scene.userData.setPitchWear = (value) => pitchTexture.userData.setWear(value);
  scene.userData.getPitchWear = () => pitchTexture.userData.getWear();
  scene.userData.setPitchPattern = (value) => pitchTexture.userData.setPattern(value);
  scene.userData.getPitchPattern = () => pitchTexture.userData.getPattern();

  // Газон-отбивка вокруг разметки: большой, чтобы низ кадра при наклоне камеры
  // к ближней бровке всегда был травой, а не чёрной пустотой. Дальний край
  // растворяется в тумане (fog) — жёсткой границы не видно.
  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(F.length + 150, F.width + 130),
    new THREE.MeshBasicMaterial({ map: createApronTexture() }),
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.02;
  scene.add(apron);

  scene.userData.goals = new GoalSystem(scene);
  buildBoards(scene);
  const stands = buildStands(scene);
  buildFloodlights(scene);

  // Живой стадион: щелчки фотоаппаратов на трибунах, веер теней под
  // игроками и пиротехника фанатских секторов. Обновляются раз в кадр
  // из main.js, зажигаются событиями матча.
  scene.userData.flashes = new CameraFlashes(scene, stands);
  scene.userData.shadows = new GroundShadows(scene);
  scene.userData.flares = new Flares(scene, stands);
  scene.userData.midges = new Midges(scene);
  scene.userData.wave = new CrowdWave(stands);
  // Бумага берёт фанатские секторы у пиротехники — сектор у них общий
  scene.userData.confetti = new Confetti(scene, scene.userData.flares);

  // Свет. Раньше тут стояли два выдуманных источника из (-40,60,30) и
  // (40,40,-30), не связанных с мачтами ничем. Теперь лампы стоят В МАЧТАХ:
  // от одних и тех же координат считаются столбы, гало, пятна на газоне,
  // конусы, веер теней и контровая кайма — расходиться им нельзя.
  const LT = CONFIG.atmosphere.light;
  mastPositions().forEach((m, i) => {
    // distance = 0, decay = 0: затухание ровно 1.0, то есть яркость постоянная,
    // а личным у каждой лампы остаётся НАПРАВЛЕНИЕ — ради него всё и делается.
    // Честное затухание разошлось бы с пятнами, запечёнными в текстуру газона.
    const lamp = new THREE.PointLight(
      LT.mastColor, LT.mastIntensity * (LT.weights[i] ?? 1), 0, 0,
    );
    lamp.position.set(m.x, m.y, m.z);
    scene.add(lamp);
  });

  // Небо и отражение от газона. Верх берём из ДЫМКИ, низ — пипеткой из готовой
  // текстуры газона: если задать их независимыми числами, фигура и воздух
  // вокруг неё окажутся разного цвета, и игрок прочитается наклейкой.
  const hemiSky = new THREE.Color(LT.hemiSky ?? HZ.color);
  const hemiGround = LT.hemiGround !== null && LT.hemiGround !== undefined
    ? new THREE.Color(LT.hemiGround)
    : samplePitchColor(pitchTexture).multiplyScalar(LT.hemiGroundMul);
  scene.add(new THREE.HemisphereLight(hemiSky, hemiGround, LT.hemiIntensity));

  initRim();

  return scene;
}

/**
 * Пипетка по текстуре газона: средний цвет травы для нижней полусферы ambient.
 * Читаем из САМОЙ текстуры, а не пересчитываем формулу пятен второй раз —
 * иначе при правке рисунка газона цвет отражённого света молча разъедется
 * (та же грабля, что с профилем черепа, продублированным в hair.js).
 */
function samplePitchColor(tex) {
  const fallback = new THREE.Color(0x2f4a24);
  const canvas = tex && tex.image;
  if (!canvas || !canvas.getContext) return fallback;
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // Четыре точки в стороне от разметки и от центрального круга
    const pts = [[0.22, 0.28], [0.22, 0.72], [0.78, 0.28], [0.78, 0.72]];
    let r = 0; let g = 0; let b = 0;
    for (const [u, v] of pts) {
      const d = ctx.getImageData((canvas.width * u) | 0, (canvas.height * v) | 0, 1, 1).data;
      r += d[0]; g += d[1]; b += d[2];
    }
    const n = pts.length * 255;
    // Текстура нарисована в sRGB, а свет считается в линейном
    return new THREE.Color().setRGB(r / n, g / n, b / n, THREE.SRGBColorSpace);
  } catch (e) {
    console.warn('Пипетка по газону не сработала, ambient снизу по умолчанию:', e);
    return fallback;
  }
}
