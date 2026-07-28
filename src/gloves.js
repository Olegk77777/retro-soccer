// Вратарские перчатки: геометрия кодом, посадка на кости кистей.
//
// ПОЧЕМУ НЕ В МОДЕЛИ. Перчатки нужны ровно двоим из двадцати двух, а любая
// правка `models/player.glb` — это пересборка headless-Blender'ом с пятью
// известными граблями (CLAUDE.md: fps сцены, веса data_transfer, полосы NLA,
// масштаб арматуры, переворот V) и обязательной сверкой всех 25 клипов.
// Платить этим за две варежки нельзя. Причёски живут в коде ровно по той же
// причине (src/hair.js) — перчатки просто следуют готовому образцу.
//
// ПОЧЕМУ НЕ ТЕКСТУРОЙ. Кисть в сборщике сетки (tools/build-player-mesh.py →
// build_hand) свёрнута в ОДНУ точку атласа кожи — uv (0.5, 0.5). Вся кисть
// берёт один тексель, и перекрасить её отдельно от остального тела нельзя в
// принципе: поменяется тон кожи целиком. Отдельная накладка — единственный
// способ, не трогая развёртку.
//
// МАСШТАБ — ТА ЖЕ ГРАБЛЯ, ЧТО У ВОЛОС. Гасим РОВНО масштаб арматуры (0.01),
// беря матрицу кости ОТНОСИТЕЛЬНО МОДЕЛИ. Возьмёшь масштаб из мировой матрицы
// кости — погасишь заодно личные рост и сложение (model.scale = 1.07…1.24), и
// перчатка не вырастет вместе с фигурой: у крупного вратаря сквозь неё полезут
// пальцы, у мелкого она повиснет мешком.
//
// ОСИ КОСТИ КИСТИ (замерены по риггу, а не угаданы): у mixamorigLeftHand и
// mixamorigRightHand локальный +Y идёт ВДОЛЬ кости, от запястья к пальцам,
// у обеих рук одинаково. Проверка — в консоли:
//   const b = k.model.getObjectByName('mixamorigRightHand');
//   b.updateWorldMatrix(true,false); /* сравнить позиции b и его потомка */
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { addRim } from './rimlight.js';

// Профиль перчатки вдоль кости, СВЕРЕННЫЙ с tools/build-player-mesh.py → HAND.
// Там кисть идёт по |x| от 0.775 (запястье) до 0.885 (кончики пальцев) в
// координатах модели; сюда те же числа переведены в ОТСТУП ОТ КОСТИ.
// Кость Hand начинается на 0.7503 — отсюда и отсчёт.
// [вдоль кости (м), полутолщина (м), полуширина (м)]
const HAND_BONE = 0.7503;
const PROFILE = [
  [0.775 - HAND_BONE - 0.045, 0.042, 0.036],  // раструб манжеты, заходит на предплечье
  [0.775 - HAND_BONE - 0.012, 0.047, 0.040],  // край манжеты — самое широкое место
  [0.775 - HAND_BONE + 0.004, 0.043, 0.037],  // запястье под манжетой
  [0.808 - HAND_BONE, 0.058, 0.043],          // ладонь: перчатка ЗАМЕТНО толще кисти
  [0.843 - HAND_BONE, 0.058, 0.042],
  [0.869 - HAND_BONE, 0.051, 0.036],
  [0.890 - HAND_BONE, 0.034, 0.024],          // кончики пальцев, чуть длиннее кисти
];
const SEGMENTS = 8;

// Большой палец перчатки — короткий прилив, как у самой кисти
const THUMB = {
  from: 0.789 - HAND_BONE, to: 0.828 - HAND_BONE,
  side: -0.052, out: -0.004, r0: 0.024, r1: 0.017, n: 6,
};

export const GLOVES = {
  // Цвет по умолчанию — вратарский латексный, спокойный: в эфире 98-го
  // кислотные перчатки были, но их видно ровно в двух матчах из ста
  color: '#e8e4d8',
  cuff: '#c8402f',   // манжета контрастная — по ней перчатка и читается
};

let geoCache = null;
const matCache = new Map();

// Развернуть все грани наружу — тот же приём, что recalc_face_normals в
// Blender и orientOutward в src/hair.js. Материал односторонний (двусторонний
// вдвое дороже и ловит z-fighting), поэтому вывернутый набор просто исчезнет.
function orientOutward(pos, idx) {
  let cx = 0; let cy = 0; let cz = 0;
  const n = pos.length / 3;
  for (let i = 0; i < n; i += 1) {
    cx += pos[i * 3]; cy += pos[i * 3 + 1]; cz += pos[i * 3 + 2];
  }
  cx /= n; cy /= n; cz /= n;
  let vote = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3; const b = idx[t + 1] * 3; const c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a]; const uy = pos[b + 1] - pos[a + 1]; const uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a]; const vy = pos[c + 1] - pos[a + 1]; const vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy; const ny = uz * vx - ux * vz; const nz = ux * vy - uy * vx;
    const dx = (pos[a] + pos[b] + pos[c]) / 3 - cx;
    const dy = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3 - cy;
    const dz = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3 - cz;
    vote += Math.sign(nx * dx + ny * dy + nz * dz);
  }
  if (vote < 0) {
    for (let t = 0; t < idx.length; t += 3) {
      const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp;
    }
  }
}

// Геометрия одна на всех вратарей: 22 клона делят один буфер.
// Строится в осях КОСТИ: +Y вдоль пальцев, X — толщина, Z — ширина ладони.
function gloveGeometry() {
  if (geoCache) return geoCache;
  const pos = [];
  const uvs = [];
  const idx = [];
  const rings = [];

  const ring = (along, rx, rz, uy) => {
    const start = pos.length / 3;
    for (let i = 0; i < SEGMENTS; i += 1) {
      const a = (Math.PI * 2 * i) / SEGMENTS;
      pos.push(Math.cos(a) * rx, along, Math.sin(a) * rz);
      uvs.push(i / SEGMENTS, uy);
    }
    return start;
  };

  for (let i = 0; i < PROFILE.length; i += 1) {
    const [along, rx, rz] = PROFILE[i];
    // u/v ложатся так, что нижние два кольца — манжета: по ним и красим
    rings.push(ring(along, rx, rz, i / (PROFILE.length - 1)));
  }
  for (let i = 0; i < rings.length - 1; i += 1) {
    const a = rings[i]; const b = rings[i + 1];
    for (let k = 0; k < SEGMENTS; k += 1) {
      const k1 = (k + 1) % SEGMENTS;
      idx.push(a + k, a + k1, b + k1);
      idx.push(a + k, b + k1, b + k);
    }
  }
  // Крышки: кончик пальцев и торец манжеты. Вершину купола ставим ВЫШЕ
  // последнего кольца — «купол» на одной высоте вырождается в плоский диск
  // (грабля из src/hair.js), и любая ошибка ориентации оставляет дырку.
  const capAt = (ringStart, along, flip) => {
    const c = pos.length / 3;
    pos.push(0, along, 0);
    uvs.push(0.5, flip ? 0 : 1);
    for (let k = 0; k < SEGMENTS; k += 1) {
      const k1 = (k + 1) % SEGMENTS;
      if (flip) idx.push(c, ringStart + k1, ringStart + k);
      else idx.push(c, ringStart + k, ringStart + k1);
    }
  };
  capAt(rings[rings.length - 1], PROFILE[PROFILE.length - 1][0] + 0.014, false);
  capAt(rings[0], PROFILE[0][0] - 0.010, true);

  // Большой палец
  const T = THUMB;
  const thumbRing = (along, r, drop) => {
    const start = pos.length / 3;
    for (let i = 0; i < T.n; i += 1) {
      const a = (Math.PI * 2 * i) / T.n;
      pos.push(Math.cos(a) * r + T.out, along, Math.sin(a) * r + T.side + drop);
      uvs.push(i / T.n, 0.6);
    }
    return start;
  };
  const t0 = thumbRing(T.from, T.r0, 0);
  const t1 = thumbRing(T.to, T.r1, -0.010);
  for (let k = 0; k < T.n; k += 1) {
    const k1 = (k + 1) % T.n;
    idx.push(t0 + k, t0 + k1, t1 + k1);
    idx.push(t0 + k, t1 + k1, t1 + k);
  }
  const tc = pos.length / 3;
  pos.push(T.out, T.to + 0.010, T.side - 0.010);
  uvs.push(0.5, 0.6);
  for (let k = 0; k < T.n; k += 1) idx.push(tc, t1 + k, t1 + ((k + 1) % T.n));

  const posArr = new Float32Array(pos);
  const idxArr = new Uint16Array(idx);
  orientOutward(posArr, idxArr);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  g.setIndex(new THREE.BufferAttribute(idxArr, 1));
  g.computeVertexNormals();
  geoCache = g;
  return g;
}

// Текстура перчатки: латексная ладонь и цветная манжета. Рисуется кодом —
// та же логика, что у лица (src/face.js): один canvas, никаких файлов.
// v = 0 — манжета, v = 1 — кончики пальцев (см. раскладку в gloveGeometry).
function gloveTexture(color, cuff) {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 32, 32);
  // Манжета — нижняя треть развёртки
  ctx.fillStyle = cuff;
  ctx.fillRect(0, 0, 32, 11);
  // Тёмная полоска-липучка и шов у основания пальцев: с ТВ-дистанции именно
  // они и делают варежку «перчаткой», а не куском поролона
  ctx.fillStyle = 'rgba(0,0,0,0.30)';
  ctx.fillRect(0, 8, 32, 2);
  ctx.fillRect(0, 24, 32, 1);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;      // крупный план остаётся пиксельным
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;                         // все наши текстуры так (см. CLAUDE.md)
  return tex;
}

function material(color, cuff) {
  const key = `${color}|${cuff}`;
  if (matCache.has(key)) return matCache.get(key);
  const tex = gloveTexture(color, cuff);
  const m = new THREE.MeshLambertMaterial({ map: tex, emissiveMap: tex });
  // Тот же уровень самосвечения, что у формы: перчатка — снаряжение, а не кожа
  m.emissive.setScalar(CONFIG.player.emissive.kit);
  addRim(m, CONFIG.atmosphere.rim.gearScale);
  matCache.set(key, m);
  return m;
}

const _mRel = new THREE.Matrix4();

/**
 * Посадить перчатки на кисти вратаря. Возвращает массив мешей (пустой, если
 * костей нет — тогда игрок просто остаётся без перчаток, а не падает).
 * look.gloves / look.glovesCuff в составе задают цвета; нет данных — базовые.
 */
export function attachGloves(model, look) {
  const out = [];
  model.updateMatrixWorld(true);
  const geo = gloveGeometry();
  const mat = material(
    (look && look.gloves) || GLOVES.color,
    (look && look.glovesCuff) || GLOVES.cuff,
  );
  for (const side of ['Left', 'Right']) {
    const bone = model.getObjectByName(`mixamorig${side}Hand`);
    if (!bone) continue;
    // Масштаб арматуры — из матрицы кости ОТНОСИТЕЛЬНО МОДЕЛИ (см. шапку)
    const rel = _mRel.copy(model.matrixWorld).invert().multiply(bone.matrixWorld);
    const e = rel.elements;
    const sx = Math.hypot(e[0], e[1], e[2]) || 1;
    const sy = Math.hypot(e[4], e[5], e[6]) || 1;
    const sz = Math.hypot(e[8], e[9], e[10]) || 1;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.set(1 / sx, 1 / sy, 1 / sz);
    // Левая и правая — зеркальные: большой палец обязан смотреть внутрь, к
    // корпусу, а не наружу. Зеркалим по оси ШИРИНЫ ладони (Z кости).
    if (side === 'Left') mesh.scale.z *= -1;
    mesh.frustumCulled = false;   // скелет уводит вершины мимо исходной рамки
    bone.add(mesh);
    out.push(mesh);
  }
  return out;
}
