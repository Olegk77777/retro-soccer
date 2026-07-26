// Сцена стадиона: газон с разметкой, ворота, трибуны, прожекторы.
// Геометрия — из примитивов, а крупные цветовые карты дают фактуру 1998-го.
// Если PNG не загрузился, canvas-заглушка остаётся: белого/чёрного экрана нет.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { PACK } from './pack.js';
import { GoalSystem } from './goal.js';
import {
  mastPositions, paintPitchLight, buildFloodlightHalos,
  CameraFlashes, GroundShadows,
} from './atmosphere.js';

const STADIUM_TEXTURES = Object.freeze({
  pitchBalanced: './textures/stadium/pitch-balanced-98.png',
  pitchWorn: './textures/stadium/pitch-worn-98.png',
  grass: './textures/stadium/grass-98.png',
  crowd: './textures/stadium/crowd-night-98.png',
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
      const stripeTone = [
        -0.035, 0.022, -0.024, 0.016, -0.032, 0.012, -0.020,
        0.018, -0.028, 0.010, -0.018, 0.020, -0.030, 0.014,
      ];
      const stripeW = w / stripeTone.length;
      for (let i = 0; i < stripeTone.length; i++) {
        const tone = stripeTone[i];
        ctx.fillStyle = tone < 0
          ? `rgba(0,0,0,${-tone})`
          : `rgba(255,255,215,${tone})`;
        ctx.fillRect(i * stripeW, 0, stripeW + 1, h);
      }

      // Свет мачт: четыре пятна и потемневшие края. Ровное зелёное сукно —
      // первый признак «примитивной» картинки, ночью так не бывает.
      paintPitchLight(ctx, w, h);
    } else {
      // Мгновенный фолбэк на время загрузки PNG и на случай 404.
      const stripes = 14;
      const stripeW = w / stripes;
      for (let i = 0; i < stripes; i++) {
        ctx.fillStyle = i % 2 === 0 ? '#4d9038' : '#5aa344';
        ctx.fillRect(i * stripeW, 0, stripeW + 1, h);
      }
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

// Текстура толпы: шумные цветные точки — с ТВ-дистанции читается как трибуна
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
  tex.wrapS = THREE.RepeatWrapping;
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
  const F = CONFIG.field;
  const crowd = createCrowdTexture();
  // Свет уже «запечён» в изображении сектора; Basic не даёт наклону бокса
  // случайно погасить толпу и стоит дешевле на планшете.
  const standMat = new THREE.MeshBasicMaterial({ map: crowd });
  const sideMat = new THREE.MeshLambertMaterial({ color: 0x232838 });

  const standH = 17;
  const standD = 18;
  const tilt = -0.42; // наклон трибуны к полю
  const a = Math.abs(tilt);
  // Нижний ряд сам доходит до поверхности y=-0.02, без отдельного забора.
  // Размер сектора не растягиваем: толпа сохраняет прежний масштаб.
  const standY = -0.02
    + (standH / 2) * Math.cos(a)
    - (standD / 2) * Math.sin(a);

  const make = (len) => {
    const geo = new THREE.BoxGeometry(len, standH, standD);
    // Толпа — только на широкой грани, торцы тёмные
    return new THREE.Mesh(geo, [sideMat, sideMat, sideMat, sideMat, standMat, standMat]);
  };

  // Овал шире футбольной коробки у ворот. Чаша подстраивается под его внешний
  // край, иначе торцевые сектора срезали бы белые линии на рабочих кадрах.
  const faceInset = (standH / 2) * Math.sin(a) + (standD / 2) * Math.cos(a);
  const trackOuter = CONFIG.track.innerRadius
    + CONFIG.track.lanes * CONFIG.track.laneWidth
    + CONFIG.track.shoulder;
  const trackEnd = CONFIG.track.straightHalf + trackOuter;
  const bowlOverlap = 2.5;
  const long = (trackEnd + bowlOverlap) * 2;
  const short = F.width + 46;
  // Трибуны вынесены наружу так, чтобы ТВ-камера (z≈58) была ВНУТРИ ближней
  // трибуны, как настоящая телекамера, а не за ней (иначе видно её тёмную изнанку)
  const dz = F.width / 2 + F.apron + 20;
  const dx = trackEnd + faceInset;

  const north = make(long);
  north.position.set(0, standY, -dz);
  north.rotation.x = tilt;
  scene.add(north);

  const south = make(long);
  south.position.set(0, standY, dz);
  south.rotation.x = -tilt;
  scene.add(south);

  const west = make(short);
  west.rotation.order = 'YXZ'; // сначала развернуть торец, затем наклонить весь ряд ровно
  west.rotation.y = Math.PI / 2;
  west.rotation.x = tilt;
  west.position.set(-dx, standY, 0);
  scene.add(west);

  const east = make(short);
  east.rotation.order = 'YXZ';
  east.rotation.y = -Math.PI / 2;
  east.rotation.x = tilt;
  east.position.set(dx, standY, 0);
  scene.add(east);

  return [north, south, west, east];
}

function buildFloodlights(scene) {
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x555c66 });
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
  scene.fog = new THREE.Fog(0x141c33, 130, 260);

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

  // Живой стадион: щелчки фотоаппаратов на трибунах и веер теней под
  // игроками. Обновляются раз в кадр из main.js.
  scene.userData.flashes = new CameraFlashes(scene, stands);
  scene.userData.shadows = new GroundShadows(scene);

  // Свет (для объёмных объектов: мяч, ворота, трибуны): ночь + мощные прожекторы
  scene.add(new THREE.HemisphereLight(0x99aacc, 0x334422, 0.9));
  const sun = new THREE.DirectionalLight(0xfff2d0, 1.9);
  sun.position.set(-40, 60, 30);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xbfd0ff, 0.6);
  fill.position.set(40, 40, -30);
  scene.add(fill);

  return scene;
}
