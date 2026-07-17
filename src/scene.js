// Сцена стадиона: газон с разметкой, ворота, трибуны, прожекторы.
// Всё из примитивов и canvas-текстур — ни одного внешнего файла (стиль PS1).

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { GoalSystem } from './goal.js';

// Текстура газона: полосы покоса + вся разметка рисуются на одном canvas.
// Отдельные PNG не нужны — Олегу ничего генерировать не надо.
function createPitchTexture() {
  const F = CONFIG.field;
  const scale = 10; // пикселей на метр
  const w = F.length * scale;
  const h = F.width * scale;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');

  // Полосы покоса: 14 полос вдоль поля, два оттенка зелёного
  const stripes = 14;
  const stripeW = w / stripes;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#4d9038' : '#5aa344';
    ctx.fillRect(i * stripeW, 0, stripeW + 1, h);
  }

  // Лёгкое зерно, чтобы газон не был «пластиковым»
  for (let i = 0; i < 9000; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    ctx.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.05)';
    ctx.fillRect(x, y, 2, 2);
  }

  // Разметка (белые линии). Размеры — стандарт ФИФА, в метрах × scale.
  // Линии толще реальных (0.3 м): при сжатии кадра тонкие бьются в пунктир.
  ctx.strokeStyle = '#e8e8e8';
  ctx.fillStyle = '#e8e8e8';
  ctx.lineWidth = 0.3 * scale;

  const m = (v) => v * scale;
  const cx = w / 2;
  const cy = h / 2;

  ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, w - ctx.lineWidth * 2, h - ctx.lineWidth * 2); // границы
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();                        // центральная
  ctx.beginPath(); ctx.arc(cx, cy, m(9.15), 0, Math.PI * 2); ctx.stroke();                    // центральный круг
  ctx.beginPath(); ctx.arc(cx, cy, m(0.22), 0, Math.PI * 2); ctx.fill();                      // центральная точка

  // Штрафные, вратарские, точки пенальти и дуги — для обоих ворот
  for (const side of [0, 1]) {
    const dir = side === 0 ? 1 : -1;
    const gx = side === 0 ? 0 : w;
    // Штрафная 16.5 × 40.32
    ctx.strokeRect(
      side === 0 ? 0 : w - m(16.5), cy - m(20.16), m(16.5), m(40.32),
    );
    // Вратарская 5.5 × 18.32
    ctx.strokeRect(
      side === 0 ? 0 : w - m(5.5), cy - m(9.16), m(5.5), m(18.32),
    );
    // Точка пенальти
    ctx.beginPath(); ctx.arc(gx + dir * m(11), cy, m(0.22), 0, Math.PI * 2); ctx.fill();
    // Дуга штрафной
    ctx.beginPath();
    const a = Math.acos(m(5.5) / m(9.15)); // угол, где дуга упирается в линию штрафной
    if (side === 0) ctx.arc(gx + m(11), cy, m(9.15), -a, a);
    else ctx.arc(gx - m(11), cy, m(9.15), Math.PI - a, Math.PI + a);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  // Вблизи — жёсткие пиксели (PS1), вдали — мипмапы: без них линии
  // разметки бьются в пунктир и мигают при движении камеры (муар).
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Текстура толпы: шумные цветные точки — с ТВ-дистанции читается как трибуна
function createCrowdTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1c2030';
  ctx.fillRect(0, 0, c.width, c.height);
  const palette = ['#c9b598', '#8898b8', '#b06858', '#d8d0c0', '#587858', '#6878a8', '#a8a098', '#404858'];
  for (let i = 0; i < 6000; i++) {
    ctx.fillStyle = palette[(Math.random() * palette.length) | 0];
    ctx.fillRect(Math.random() * c.width, Math.random() * c.height, 2, 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter; // толпа тоже не должна «кипеть»
  tex.generateMipmaps = true;
  tex.wrapS = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildStands(scene) {
  const F = CONFIG.field;
  const crowd = createCrowdTexture();
  const standMat = new THREE.MeshLambertMaterial({ map: crowd });
  const sideMat = new THREE.MeshLambertMaterial({ color: 0x232838 });

  const standH = 17;
  const standD = 18;
  const tilt = -0.42; // наклон трибуны к полю

  const make = (len) => {
    const geo = new THREE.BoxGeometry(len, standH, standD);
    // Толпа — только на широкой грани, торцы тёмные
    return new THREE.Mesh(geo, [sideMat, sideMat, sideMat, sideMat, standMat, standMat]);
  };

  const long = F.length + 46;
  const short = F.width + 46;
  // Трибуны вынесены наружу так, чтобы ТВ-камера (z≈58) была ВНУТРИ ближней
  // трибуны, как настоящая телекамера, а не за ней (иначе видно её тёмную изнанку)
  const dz = F.width / 2 + F.apron + 20;
  const dx = F.length / 2 + F.apron + 20;

  const north = make(long);
  north.position.set(0, standH / 2 + 1, -dz);
  north.rotation.x = tilt;
  scene.add(north);

  const south = make(long);
  south.position.set(0, standH / 2 + 1, dz);
  south.rotation.x = -tilt;
  scene.add(south);

  const west = make(short);
  west.rotation.y = Math.PI / 2;
  west.rotation.x = tilt;
  west.position.set(-dx, standH / 2 + 1, 0);
  scene.add(west);

  const east = make(short);
  east.rotation.y = -Math.PI / 2;
  east.rotation.x = tilt;
  east.position.set(dx, standH / 2 + 1, 0);
  scene.add(east);
}

function buildFloodlights(scene) {
  const F = CONFIG.field;
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x555c66 });
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff8dd }); // светится сам, без освещения
  const poleGeo = new THREE.CylinderGeometry(0.35, 0.5, 28, 6);
  const lampGeo = new THREE.BoxGeometry(4.5, 3, 0.8);

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * (F.length / 2 + F.apron + 4);
      const z = sz * (F.width / 2 + F.apron + 4);
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(x, 14, z);
      scene.add(pole);
      const lamp = new THREE.Mesh(lampGeo, lampMat);
      lamp.position.set(x, 28.5, z);
      lamp.lookAt(0, 0, 0);
      scene.add(lamp);
    }
  }
}

// Текстура рекламного борта: цветные секции с выдуманными брендами
// в духе телерекламы 90-х (реальные бренды по правилу проекта — нельзя)
function createBoardTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 64;
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
    ctx.font = 'bold 34px "Arial Narrow", Arial, sans-serif';
    ctx.fillText(text, i * secW + secW / 2, c.height / 2 + 2);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildBoards(scene) {
  const F = CONFIG.field;
  const BD = CONFIG.boards;
  const base = createBoardTexture();
  const bx = F.length / 2 + BD.marginX; // позиция торцевых щитов по X
  const bz = F.width / 2 + BD.marginZ;  // боковых по Z
  const repeatPerMeter = 1 / 8;         // одна «простыня» рекламы на 8 м

  // Один щит: длинная тонкая доска высотой BD.height, текстурой внутрь и наружу
  const board = (len, horizontal) => {
    const tex = base.clone();
    tex.needsUpdate = true;
    tex.repeat.set(len * repeatPerMeter, 1);
    const mat = new THREE.MeshLambertMaterial({ map: tex, emissive: 0x222222 });
    const dark = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
    const geo = new THREE.BoxGeometry(len, BD.height, 0.25);
    // текстура — на широкие грани (±Z бокса), торцы тёмные
    const m = new THREE.Mesh(geo, [dark, dark, dark, dark, mat, mat]);
    if (!horizontal) m.rotation.y = Math.PI / 2;
    return m;
  };

  // Северный и южный (вдоль длины поля)
  for (const z of [-bz, bz]) {
    const b = board(F.length + BD.marginX * 2, true);
    b.position.set(0, BD.height / 2, z);
    scene.add(b);
  }
  // Западный и восточный (за воротами)
  for (const x of [-bx, bx]) {
    const b = board(F.width + BD.marginZ * 2, false);
    b.position.set(x, BD.height / 2, 0);
    scene.add(b);
  }
}

export function buildStadium() {
  const F = CONFIG.field;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1020); // вечернее небо — матч под прожекторами
  scene.fog = new THREE.Fog(0x0b1020, 130, 260);

  // Газон с разметкой. MeshBasic = без освещения: яркая «запечённая» картинка,
  // как на PS1 — там свет на поле тоже был нарисован, а не посчитан.
  const pitch = new THREE.Mesh(
    new THREE.PlaneGeometry(F.length, F.width),
    new THREE.MeshBasicMaterial({ map: createPitchTexture() }),
  );
  pitch.rotation.x = -Math.PI / 2;
  scene.add(pitch);

  // Газон-отбивка вокруг разметки: большой, чтобы низ кадра при наклоне камеры
  // к ближней бровке всегда был травой, а не чёрной пустотой. Дальний край
  // растворяется в тумане (fog) — жёсткой границы не видно.
  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(F.length + 150, F.width + 130),
    new THREE.MeshBasicMaterial({ color: 0x336324 }),
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.02;
  scene.add(apron);

  scene.userData.goals = new GoalSystem(scene);
  buildBoards(scene);
  buildStands(scene);
  buildFloodlights(scene);

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
