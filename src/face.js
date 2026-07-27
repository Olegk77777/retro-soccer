// Лицо игрока — ТЕКСТУРА, нарисованная кодом из данных состава.
//
// Почему текстурой, а не геометрией. На голове 212 треугольников, а в кадре она
// занимает 7 пикселей с рабочей ТВ-камеры и 56 на повторе крупным планом. Глаза
// и рот такого размера невозможно вылепить рельефом — их РИСОВАЛИ, ровно так же
// делали лица на PS1 и PS2. Геометрия даёт только крупную форму: нос, надбровье,
// подбородок (см. NOSE/BROW в tools/build-player-mesh.py).
//
// РАЗВЁРТКА ГОЛОВЫ (задана там же, build_head). Цилиндрическая:
//   u — угол вокруг головы, 0.5 РОВНО ПО ЦЕНТРУ ЛИЦА, дальше по кругу;
//       грань занимает 1/12 оборота, шов уходит на затылок и закрывается
//       RepeatWrapping — поэтому текстура обязана быть бесшовной по краям,
//       то есть слева и справа у неё ровный тон кожи.
//   v — высота: 0 подбородок, 1 макушка.
// Уши берут точку (1.0, 0.55) — затылок на середине высоты, там чистая кожа.
//
// Внешность — ДАННЫЕ (data/teams/*.json → squad): skin, hair, hairColor, beard.
// Мелкие отличия (расстановка глаз, толщина бровей, ширина рта) выводятся из
// ХЕША ФАМИЛИИ: 22 лица в кадре не должны быть одним лицом, но и заводить на
// каждую бровь поле в JSON незачем.
import * as THREE from 'three';

export const FACE = {
  size: 128,          // px. Лицо в кадре повтора ≈ 26 px шириной, спереди
                      // головы лежит 42 текселя — запас есть, а 256 уже впустую.
  // Высоты в долях развёртки (v): 0 — подбородок, 1 — макушка
  vMouth: 0.20,
  vNose: 0.31,
  vEye: 0.425,
  vBrow: 0.495,
  vHair: 0.745,       // линия волос
  vTemple: 0.55,
  // Полуширина лица в долях оборота: ±60° = ±1/6
  uFace: 1 / 6,
  eyeGap: 0.070,      // доля оборота от центра до зрачка (замер: asin(3.2/7.7))
};

// --- мелкая утварь -----------------------------------------------------------
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Детерминированный «кубик» 0..1 по фамилии и номеру канала. */
function roll(seed, k) {
  const h = Math.imul(seed ^ Math.imul(k + 1, 0x9e3779b1), 0x85ebca6b) >>> 0;
  return h / 4294967296;
}

function parseHex(hex) {
  const n = Number.parseInt(String(hex).replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Смешать два цвета в sRGB-байтах. Работаем именно в байтах: canvas живёт
 *  в sRGB, и попытка считать здесь «по-линейному» даёт грязь. */
function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function css(c, alpha = 1) {
  return alpha >= 1
    ? `rgb(${c[0]},${c[1]},${c[2]})`
    : `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

// --- рисование ---------------------------------------------------------------
const cache = new Map();

/**
 * Текстура лица под внешность игрока.
 * @param look — объект из squad: { name, skin, hair, hairColor, beard }
 */
export function faceTexture(look = {}) {
  const key = [look.name || '', look.skin || '', look.hair || '', look.hairColor || '',
    look.beard || ''].join('|');
  if (cache.has(key)) return cache.get(key);

  const S = FACE.size;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d');

  const skin = parseHex(look.skin || '#c49b7c');
  const hairCol = parseHex(look.hairColor || '#241812');
  const seed = hash(look.name || 'без имени');

  // Тени и света лица строим ОТ ТОНА КОЖИ, а не фиксированными серыми: на
  // смуглом лице серая тень читается грязью, а затемнение своего же тона — нет.
  const dark = mix(skin, [0, 0, 0], 0.30);
  const deep = mix(skin, [0, 0, 0], 0.52);
  const lite = mix(skin, [255, 245, 230], 0.16);

  // Холст в координатах развёртки: X = u·S, Y = (1 − v)·S.
  // Текстура грузится с flipY по умолчанию, поэтому макушка рисуется СВЕРХУ.
  const X = (u) => u * S;
  const Y = (v) => (1 - v) * S;
  const W = (du) => du * S;

  g.fillStyle = css(skin);
  g.fillRect(0, 0, S, S);

  // 1. Крупная форма: виски темнее, скулы и лоб светлее. Это то, что реально
  //    читается на общем плане, когда глаз и рта уже не различить.
  const gradSide = g.createLinearGradient(0, 0, S, 0);
  gradSide.addColorStop(0.00, css(dark, 0.55));
  gradSide.addColorStop(0.17, css(dark, 0.30));
  gradSide.addColorStop(0.33, css(skin, 0.0));
  gradSide.addColorStop(0.50, css(lite, 0.35));
  gradSide.addColorStop(0.67, css(skin, 0.0));
  gradSide.addColorStop(0.83, css(dark, 0.30));
  gradSide.addColorStop(1.00, css(dark, 0.55));
  g.fillStyle = gradSide;
  g.fillRect(0, 0, S, S);

  // Подбородок и шея снизу в тени, лоб чуть светлее — вертикальная лепка
  const gradV = g.createLinearGradient(0, Y(0), 0, Y(1));
  gradV.addColorStop(0.00, css(dark, 0.42));
  gradV.addColorStop(0.18, css(skin, 0.0));
  gradV.addColorStop(0.62, css(lite, 0.18));
  gradV.addColorStop(1.00, css(dark, 0.22));
  g.fillStyle = gradV;
  g.fillRect(0, 0, S, S);

  const uc = 0.5;                                  // центр лица
  const gap = FACE.eyeGap + (roll(seed, 1) - 0.5) * 0.010;
  const eyeW = W(0.030 + roll(seed, 2) * 0.007);
  const eyeH = Math.max(2, Math.round(S * 0.016));
  const browT = Math.max(2, Math.round(S * (0.014 + roll(seed, 3) * 0.008)));

  // 2. Скулы и щёки. Крупная лепка важнее черт: с эфирного плана глаз и рта
  //    не разобрать вовсе, а вот «под скулой темнее» держит объём головы.
  for (const s of [-1, 1]) {
    // Тень идёт ПОД скулой и вытянута к челюсти, и обязательно РАСТУШЁВАННАЯ:
    // ровное пятно на щеке читается синяком, а не лепкой (первый прогон
    // стенда именно так и выглядел).
    const cx0 = X(uc + s * 0.105);
    const cy0 = Y(FACE.vNose - 0.05);
    const rg = g.createRadialGradient(cx0, cy0, 1, cx0, cy0, S * 0.10);
    rg.addColorStop(0, css(deep, 0.09));
    rg.addColorStop(1, css(deep, 0.0));
    g.fillStyle = rg;
    g.beginPath();
    g.ellipse(cx0, cy0, W(0.050), S * 0.10, s * 0.22, 0, 6.2832);
    g.fill();
  }

  // 3. Глазницы — лёгкая тень шире самих глаз. Без неё глаза выглядят
  //    наклейками, а с ней лицо получает объём даже на 8 пикселях.
  g.fillStyle = css(deep, 0.24);
  for (const s of [-1, 1]) {
    g.beginPath();
    g.ellipse(X(uc + s * gap), Y(FACE.vEye + 0.005), eyeW * 1.05, eyeH * 1.5, 0, 0, 6.2832);
    g.fill();
  }

  // 4. Глаза. Тёмная щель плюс блик снизу: на PS1 рисовали именно так —
  //    белок целиком делает лицо мультяшным и «пучеглазым».
  for (const s of [-1, 1]) {
    const x = X(uc + s * gap) - eyeW / 2;
    g.fillStyle = css(mix(skin, [18, 12, 9], 0.9));
    g.fillRect(x, Y(FACE.vEye) - eyeH / 2, eyeW, eyeH);
    g.fillStyle = css(lite, 0.45);
    g.fillRect(x, Y(FACE.vEye) + eyeH / 2, eyeW, 1);
  }

  // 5. Брови. На общем плане именно они держат выражение: глаза схлопываются
  //    в точку, а бровь остаётся штрихом. Но штрих должен быть КОРОТКИМ — во
  //    всю ширину лица он читается сплошной полосой, будто наличник.
  const browCol = mix(hairCol, skin, 0.18);
  const browW = eyeW * 1.25;
  g.fillStyle = css(browCol, 0.9);
  for (const s of [-1, 1]) {
    const cx = X(uc + s * gap);
    g.beginPath();
    // Наклон: внутренний конец ниже внешнего — так лицо не выходит удивлённым
    g.moveTo(cx - s * browW * 0.55, Y(FACE.vBrow) + browT * 0.4);
    g.lineTo(cx + s * browW * 0.55, Y(FACE.vBrow) - browT * 0.3);
    g.lineTo(cx + s * browW * 0.55, Y(FACE.vBrow) - browT * 0.3 + browT);
    g.lineTo(cx - s * browW * 0.55, Y(FACE.vBrow) + browT * 0.4 + browT);
    g.closePath();
    g.fill();
  }

  // 6. Нос: геометрия уже даёт гребень, текстура добавляет тень сбоку и
  //    ноздрю. Рисуем только тень — нарисованный «контур носа» читается клювом.
  const nx = X(uc);
  // Тень вдоль крыла носа. Держим её КОРОТКОЙ: тянущаяся ото лба до рта
  // полоса читается швом развёртки, а не носом.
  const ng = g.createLinearGradient(0, Y(FACE.vBrow - 0.03), 0, Y(FACE.vNose + 0.01));
  ng.addColorStop(0, css(deep, 0.0));
  ng.addColorStop(0.45, css(deep, 0.15));
  ng.addColorStop(1, css(deep, 0.0));
  g.fillStyle = ng;
  g.fillRect(nx + W(0.010), Y(FACE.vBrow - 0.03), W(0.015),
             Y(FACE.vNose + 0.01) - Y(FACE.vBrow - 0.03));
  g.fillStyle = css(deep, 0.30);
  g.fillRect(nx - W(0.020), Y(FACE.vNose), W(0.040), Math.max(1, Math.round(S * 0.010)));

  // 7. Рот — одна тёмная линия. Всё, что сложнее, на 26 пикселях ширины лица
  //    превращается в грязное пятно.
  const mw = W(0.042 + roll(seed, 4) * 0.012);
  g.fillStyle = css(mix(skin, [58, 24, 24], 0.55), 0.8);
  g.fillRect(nx - mw / 2, Y(FACE.vMouth), mw, Math.max(1, Math.round(S * 0.012)));
  // тень под нижней губой — подбородок отделяется от рта
  g.fillStyle = css(deep, 0.16);
  g.fillRect(nx - mw / 2, Y(FACE.vMouth - 0.035), mw, Math.max(1, Math.round(S * 0.014)));

  // 8. Линия волос и виски. Голову закрывает отдельная «шапка» (см. attachHair),
  //    но БЕЗ подложки под ней между шапкой и лицом остаётся полоса голой кожи.
  //    Лысым (hair: none) подложка не нужна — это тоже примета внешности.
  if ((look.hair || 'short') !== 'none') {
    // Линия волос не прямая: над висками она опускается, над лбом поднимается.
    // Рисуем дугой, иначе получается парик, надетый по линейке.
    const yTop = Y(FACE.vHair + 0.16);
    const yMid = Y(FACE.vHair);
    g.fillStyle = css(hairCol, 0.92);
    g.beginPath();
    g.moveTo(0, yTop);
    g.lineTo(S, yTop);
    g.lineTo(S, Y(FACE.vHair - 0.10));
    for (let i = S; i >= 0; i -= 4) {
      const d = Math.abs(i / S - uc);                 // 0 в центре лица
      const dip = Math.min(1, Math.max(0, (0.20 - d) / 0.20));
      g.lineTo(i, yMid - dip * S * 0.055);
    }
    g.closePath();
    g.fill();
    // Растушёвка нижнего края: жёсткая граница читается надетым париком.
    const soft = g.createLinearGradient(0, yMid - S * 0.055, 0, yMid + S * 0.045);
    soft.addColorStop(0, css(hairCol, 0.55));
    soft.addColorStop(1, css(hairCol, 0.0));
    g.fillStyle = soft;
    g.fillRect(0, yMid - S * 0.055, S, S * 0.10);
    // бакенбарды по бокам лица
    g.fillStyle = css(hairCol, 0.45);
    for (const s of [-1, 1]) {
      g.fillRect(X(uc + s * 0.138) - W(0.009), Y(FACE.vTemple + 0.10),
                 W(0.018), Y(FACE.vBrow) - Y(FACE.vTemple + 0.10));
    }
  }

  // 8. Щетина/борода. Дешёвый способ развести 22 лица, и очень к месту:
  //    в 98-м небритых на поле было предостаточно.
  const beard = look.beard || 'none';
  if (beard !== 'none') {
    const bc = mix(hairCol, skin, 0.35);
    g.fillStyle = css(bc, beard === 'full' ? 0.72 : 0.34);
    const top = beard === 'goatee' ? FACE.vNose - 0.02 : FACE.vMouth + 0.14;
    const half = beard === 'goatee' ? 0.045 : FACE.uFace;
    g.fillRect(X(uc - half), Y(top), W(half * 2), Y(0) - Y(top));
    if (beard === 'full') {
      g.fillStyle = css(bc, 0.5);
      g.fillRect(X(uc - FACE.uFace), Y(FACE.vEye - 0.02),
                 W(FACE.uFace * 2), Y(FACE.vMouth) - Y(FACE.vEye - 0.02));
    }
  }

  const tex = new THREE.CanvasTexture(c);
  // flipY = false, как и у атласа формы. Экспортёр glTF переворачивает V
  // (в glTF ось V смотрит вниз), поэтому макушка, лежащая в Blender на v = 1,
  // приезжает в браузер как v = 0 — то есть как ПЕРВАЯ строка картинки.
  // С включённым flipY лицо встаёт вверх ногами: линия волос оказывается
  // под подбородком, и это ровно то, что было видно на стенде.
  tex.flipY = false;
  // Шов развёртки уходит за затылок и закрывается повтором по горизонтали.
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  // МИПМАПЫ ОБЯЗАТЕЛЬНЫ, в отличие от формы. С рабочей ТВ-камеры голова
  // занимает ~7 пикселей: без мипов 128 текселей лица падают в эти 7, и глаза
  // с бровями превращаются в мерцающую кашу при каждом шаге игрока. Крупный
  // план при этом остаётся пиксельным — за это отвечает magFilter.
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 1;
  cache.set(key, tex);
  return tex;
}
