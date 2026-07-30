// Причёски: геометрия кодом плюс пружина для длинных волос.
//
// ПОЧЕМУ КОДОМ, А НЕ В МОДЕЛИ. Внешность у нас — данные (CLAUDE.md): стиль и
// цвет приходят из squad в data/packs/*/teams/*.json. Держать в glb пять
// вариантов шапки и прятать четыре — платить памятью и усложнять пересборку
// модели ради того, что строится тридцатью строками. К тому же голова у всех
// одна, а значит и посадка волос считается один раз.
//
// ПОЧЕМУ ПРУЖИНА, А НЕ КОСТИ. Добавить кости в риг Mixamo можно, но тогда все
// 25 клипов надо пересобирать, а в них новых костей нет — хвост будет стоять
// колом. Пружина на подвесе даёт то же самое (хвост отстаёт при разгоне и
// догоняет при остановке), не трогая ни одного клипа.
//
// ПОРЯДОК В КАДРЕ КРИТИЧЕН: updateLoco → mixer.update → updatePose → updateHair.
// Раньше нельзя — микшер и слой «живой корпус» перепишут поворот головы, и
// волосы поедут относительно черепа.
//
// ОСИ КОСТИ ГОЛОВЫ (замерены по риггу, а не угаданы):
//   локальный +Y — ВВЕРХ вдоль кости,
//   локальный +Z — ВПЕРЁД, в лицо,
//   локальный +X — влево.
// Первый заход считал перёд за −Z, и вся причёска встала задом наперёд:
// высокий край линии роста волос уехал на затылок, низкий налез на лоб —
// на экране это читалось повязкой на голове (фидбек Олега 27.07.2026).
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { addRim } from './rimlight.js';

// Профиль головы, СВЕРЕННЫЙ с tools/build-player-mesh.py → HEAD.
// (мировая высота в метрах, полуширина по X, полуглубина по Y, сдвиг по Y).
// Меняешь голову там — правь и здесь, иначе шапка сползёт с черепа.
const HEAD_PROFILE = [
  [1.574, 0.048, 0.060, -0.012],
  [1.604, 0.065, 0.084, -0.010],
  [1.640, 0.078, 0.096, -0.007],
  [1.682, 0.083, 0.100, -0.004],
  [1.724, 0.081, 0.098, 0.000],
  [1.766, 0.074, 0.090, 0.005],
  [1.800, 0.053, 0.064, 0.007],
  [1.815, 0.025, 0.031, 0.007],
];
const HEAD_BONE_Z = 1.6209;   // высота кости mixamorig:Head в рест-позе

export const HAIR = {
  // Пружина хвоста. freq — как часто он качается, damp — сколько раз перейдёт
  // через покой после остановки. Рабочая точка: 2–4 перехода. Один — палка,
  // шесть — резиновый шланг.
  freq: 1.75,        // Гц
  damp: 0.32,        // безразмерное затухание ζ
  gravity: 2.6,      // м/с², приведённая: полное g кладёт хвост вертикально
  maxTilt: 0.85,     // рад: дальше хвост не отклоняется (иначе уходит в череп)
  step: 0.008,       // с: шаг интегрирования, дальше дробим кадр на подшаги
  dtMax: 0.10,       // с: провал кадра длиннее просто пропускаем
  teleport: 1.5,     // м за кадр: больше — это смена ракурса повтора, не бег
  // Граней по кругу шапки. ОБЯЗАНО идти следом за HEAD_N в сборщике сетки
  // (tools/build-player-mesh.py): шапка сидит на том же профиле черепа, и если
  // она грубее головы, на крупном плане получаются волосы гранёнее лба.
  // Голова 30.07.2026 поднята с 12 сегментов до 24 — шапка идёт с 10 до 20.
  // Протыкания это не добавляет: обе фигуры ВПИСАНЫ в свои эллипсы, то есть
  // максимальный радиус головы от плотности не меняется вовсе, а минимальный
  // радиус шапки от неё только РАСТЁТ — то есть зазор увеличивается.
  segments: 20,
};

// Стили. lowFront/lowBack — мировая высота нижнего края волос спереди и сзади
// (спереди линия выше: это и есть линия роста волос). grow — насколько шапка
// толще черепа. lift — приподнятая макушка (копна).
// ТОЛЩИНА ВОЛОС. Первый заход давал 9 мм — это не причёска, а купальная
// шапочка: на общем плане она читается тёмным пятном, натянутым на череп.
// Настоящая короткая стрижка добавляет 2 см и имеет ВИДИМЫЙ край.
const STYLES = {
  none: null,
  thin: { lowFront: 1.776, lowBack: 1.706, grow: 0.010, lift: 0.002 },
  short: { lowFront: 1.748, lowBack: 1.678, grow: 0.020, lift: 0.010 },
  afro: { lowFront: 1.738, lowBack: 1.672, grow: 0.044, lift: 0.036 },
  long: {
    lowFront: 1.744, lowBack: 1.656, grow: 0.024, lift: 0.012,
    // Хвост: подвес на затылке, длина и толщина в метрах
    // Замер показал, что при длине 14.5 см хвост сливался с шапкой и в
    // кадре не читался вовсе. 19 см — это как раз «собрал в хвост».
    tail: { z: 1.690, y: 0.098, len: 0.195, w: 0.062, thick: 0.046 },
  },
};

function profileAt(z) {
  const P = HEAD_PROFILE;
  if (z <= P[0][0]) return P[0];
  for (let i = 1; i < P.length; i += 1) {
    if (z <= P[i][0]) {
      const t = (z - P[i - 1][0]) / (P[i][0] - P[i - 1][0]);
      return [z,
        P[i - 1][1] + (P[i][1] - P[i - 1][1]) * t,
        P[i - 1][2] + (P[i][2] - P[i - 1][2]) * t,
        P[i - 1][3] + (P[i][3] - P[i - 1][3]) * t];
    }
  }
  return P[P.length - 1];
}

// Геометрия кэшируется по стилю: 22 игрока делят четыре буфера вместо
// сорока четырёх своих. Материал — по цвету волос.
const geoCache = new Map();
const matCache = new Map();


/**
 * Развернуть все треугольники НАРУЖУ от центра объёма.
 *
 * Зачем не следить за порядком обхода руками. Первый заход собирал шапку
 * поясами и веером на макушке, и весь набор оказался вывернут внутрь. Замер:
 * нормаль веера макушки [0, −1, 0], то есть строго ВНИЗ. Материал у нас
 * односторонний (так и надо: двусторонний вдвое дороже и ловит z-fighting),
 * поэтому вывернутые грани просто отсекаются — на экране это лысая макушка
 * при кольце волос вокруг головы, ровно «повязка» из фидбека Олега.
 * Здесь то же самое, что делает recalc_face_normals в Blender: считаем, куда
 * смотрит грань относительно центра, и при несогласии переворачиваем ВЕСЬ
 * набор (у выпуклой шапки и у хвоста ориентация общая).
 */
function orientOutward(verts, idx) {
  let cx = 0, cy = 0, cz = 0;
  const n = verts.length / 3;
  for (let i = 0; i < n; i += 1) {
    cx += verts[i * 3]; cy += verts[i * 3 + 1]; cz += verts[i * 3 + 2];
  }
  cx /= n; cy /= n; cz /= n;
  let vote = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2];
    const vx = verts[c] - verts[a], vy = verts[c + 1] - verts[a + 1], vz = verts[c + 2] - verts[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const dx = (verts[a] + verts[b] + verts[c]) / 3 - cx;
    const dy = (verts[a + 1] + verts[b + 1] + verts[c + 1]) / 3 - cy;
    const dz = (verts[a + 2] + verts[b + 2] + verts[c + 2]) / 3 - cz;
    vote += Math.sign(nx * dx + ny * dy + nz * dz);
  }
  if (vote < 0) {
    for (let t = 0; t < idx.length; t += 3) {
      const tmp = idx[t + 1];
      idx[t + 1] = idx[t + 2];
      idx[t + 2] = tmp;
    }
  }
  return idx;
}

/** Шапка волос: облегает череп, снизу обрезана по линии роста волос.
 *
 *  ТОЛЩИНА НАБИРАЕТСЯ ПОСТЕПЕННО, а не стоит одинаковой от края до макушки.
 *  У самой линии роста волосы сходят на нет — если там держать полные 2 см,
 *  край шапки повисает над лбом козырьком, а по бокам вылезают острые углы
 *  граней (замер на стенде 27.07.2026). Множители ниже — доля от st.grow по
 *  кольцам снизу вверх.
 */
const GROW_AT = [0.12, 0.62, 1.0, 1.0];

function capGeometry(st) {
  const n = HAIR.segments;
  const levels = [1.762, 1.796, 1.812 + st.lift];
  const verts = [];
  const idx = [];

  const ring = (z, mul) => {
    const p = profileAt(z);
    const start = verts.length / 3;
    for (let k = 0; k < n; k += 1) {
      const a = (k / n) * Math.PI * 2;                    // 0 = ВПЕРЁД (+Z кости)
      const g = st.grow * mul;
      // p[3] — сдвиг профиля по Y в Blender, где вперёд это −Y; в осях кости
      // вперёд это +Z, поэтому знак переворачивается.
      verts.push((p[1] + g) * Math.sin(a),
                 z - HEAD_BONE_Z,
                 (p[2] + g) * Math.cos(a) - p[3]);
    }
    return start;
  };

  // Нижний край идёт волной: спереди высоко (лоб открыт), сзади низко (шея).
  const low = [];
  for (let k = 0; k < n; k += 1) {
    const a = (k / n) * Math.PI * 2;
    const w = (1 - Math.cos(a)) * 0.5;                    // 0 спереди, 1 сзади
    const z = st.lowFront + (st.lowBack - st.lowFront) * w;
    const p = profileAt(z);
    const g = st.grow * GROW_AT[0];
    low.push([(p[1] + g) * Math.sin(a), z - HEAD_BONE_Z,
              (p[2] + g) * Math.cos(a) - p[3]]);
  }
  const lowStart = verts.length / 3;
  for (const v of low) verts.push(v[0], v[1], v[2]);

  const rings = [lowStart];
  levels.forEach((z, i) => rings.push(ring(z, GROW_AT[i + 1])));
  // макушка — одна вершина
  const topP = profileAt(1.815);
  const top = verts.length / 3;
  // Вершина ВЫШЕ последнего кольца: иначе «купол» вырождается в плоский
  // диск, и любая ошибка ориентации сразу оставляет дырку на макушке.
  verts.push(0, 1.828 + st.lift - HEAD_BONE_Z, -topP[3]);

  for (let r = 0; r < rings.length - 1; r += 1) {
    const a = rings[r];
    const b = rings[r + 1];
    for (let k = 0; k < n; k += 1) {
      const k1 = (k + 1) % n;
      idx.push(a + k, b + k, b + k1);
      idx.push(a + k, b + k1, a + k1);
    }
  }
  const lastRing = rings[rings.length - 1];
  for (let k = 0; k < n; k += 1) {
    idx.push(lastRing + k, top, lastRing + ((k + 1) % n));
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(orientOutward(verts, idx));
  geo.computeVertexNormals();
  return geo;
}

/** Хвост: сплюснутый клин, висит от подвеса вниз-назад. Ось Y — ВДОЛЬ хвоста,
 *  чтобы пружине оставалось только повернуть объект. */
function tailGeometry(t) {
  const w = t.w * 0.5;
  const d = t.thick * 0.5;
  const L = t.len;
  const v = [
    -w, 0, -d, w, 0, -d, w, 0, d, -w, 0, d,                     // основание
    -w * 0.8, -L * 0.55, -d * 0.9, w * 0.8, -L * 0.55, -d * 0.9,
    w * 0.8, -L * 0.55, d * 0.9, -w * 0.8, -L * 0.55, d * 0.9,  // середина
    -w * 0.35, -L, -d * 0.5, w * 0.35, -L, -d * 0.5,
    w * 0.35, -L, d * 0.5, -w * 0.35, -L, d * 0.5,              // кончик
  ];
  const idx = [];
  for (let r = 0; r < 2; r += 1) {
    const a = r * 4;
    const b = a + 4;
    for (let k = 0; k < 4; k += 1) {
      const k1 = (k + 1) % 4;
      idx.push(a + k, b + k, b + k1, a + k, b + k1, a + k1);
    }
  }
  idx.push(8, 10, 9, 8, 11, 10);          // торец кончика
  idx.push(0, 1, 2, 0, 2, 3);             // торец основания
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  geo.setIndex(orientOutward(v, idx));
  geo.computeVertexNormals();
  return geo;
}

function material(colorHex) {
  const key = colorHex || '#241812';
  if (matCache.has(key)) return matCache.get(key);
  const col = new THREE.Color(key);
  const m = new THREE.MeshLambertMaterial({
    color: col,
    // Тот же уровень, что у кожи: без него причёска на вечернем поле
    // проваливается в чёрный силуэт. Число одно на обоих — CONFIG.player.emissive.
    emissive: col.clone().multiplyScalar(CONFIG.player.emissive.skin),
  });
  // Макушка — то место, где контровик от мачт читается лучше всего.
  addRim(m, CONFIG.atmosphere.rim.hairScale);
  matCache.set(key, m);
  return m;
}

// Временные — свои на каждую роль. Один общий вектор здесь недопустим:
// направление покоя нужно ЖИВЫМ до самого конца шага, а его легко затереть.
const _anchor = new THREE.Vector3();
const _rest = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _qBone = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
const _mRel = new THREE.Matrix4();

/**
 * Причёска игрока. Живёт на кости головы; хвост качается на пружине.
 * Возвращает null, если стиль «лысый» или кости нет.
 */
export class HairRig {
  /**
   * @param headScale {x,y,z} — во столько раз личный морф раздул череп по
   *   осям кости (см. src/headshape.js). Шапка ОБЯЗАНА повторить эти
   *   множители: она построена по СТАТИЧНОМУ профилю черепа, а зазор у линии
   *   роста волос всего 1.2 мм у стрижки `thin` — расширенный морфом череп
   *   проткнул бы её насквозь, и вышла бы «повязка на голове» (фидбек
   *   27.07.2026). Работает это только потому, что морфы формы черепа —
   *   ЧИСТЫЕ масштабы вокруг высоты кости, а локальный ноль шапки лежит
   *   ровно на ней: значит достаточно перемножить, без пересборки геометрии
   *   и без раздутия кэша стрижек.
   */
  constructor(model, look, headScale) {
    const st = STYLES[(look && look.hair) || 'short'];
    const hs = headScale || { x: 1, y: 1, z: 1 };
    this.bone = model.getObjectByName('mixamorigHead');
    this.tail = null;
    if (!st || !this.bone) return;

    model.updateMatrixWorld(true);
    // Кость Mixamo живёт в своём масштабе (сантиметры), и его надо погасить,
    // иначе геометрия в метрах приедет в сто раз больше.
    //
    // ГАСИМ РОВНО МАСШТАБ АРМАТУРЫ, А НЕ ВЕСЬ МИРОВОЙ. Первый заход снимал
    // масштаб из МИРОВОЙ матрицы кости, а в ней сидят ещё и личные рост со
    // сложением игрока (model.scale = modelScale·tall·wide), — шапка получалась
    // строго в метрах и НЕ росла вместе с фигурой. Замер в игре: у крупного
    // игрока (scale 1.24) макушка головы торчала над куполом шапки на 1 см, а
    // на уровне лба между черепом и шапкой оставалось 0.6 мм при том, что у
    // гранёных колец рассинхрон граней сам по себе больше. Череп протыкал
    // шапку, от неё оставался пояс вокруг головы — ровно «повязка на голове»
    // из фидбека Олега 27.07.2026. Матрица кости ОТНОСИТЕЛЬНО МОДЕЛИ даёт
    // чистый масштаб арматуры (0.01), и причёска дальше масштабируется
    // model.scale заодно с головой — то есть всегда точно по черепу.
    const rel = _mRel.copy(model.matrixWorld).invert().multiply(this.bone.matrixWorld);
    const e = rel.elements;
    const sx = Math.hypot(e[0], e[1], e[2]) || 1;
    const sy = Math.hypot(e[4], e[5], e[6]) || 1;
    const sz = Math.hypot(e[8], e[9], e[10]) || 1;

    const color = (look && look.hairColor) || '#241812';
    const mat = material(color);

    const key = `${look && look.hair}|${st.lift}`;
    if (!geoCache.has(key)) geoCache.set(key, capGeometry(st));
    const cap = new THREE.Mesh(geoCache.get(key), mat);
    cap.scale.set(hs.x / sx, hs.y / sy, hs.z / sz);
    cap.frustumCulled = false;
    this.bone.add(cap);
    this.cap = cap;

    if (st.tail) {
      const tk = `tail|${look && look.hair}`;
      if (!geoCache.has(tk)) geoCache.set(tk, tailGeometry(st.tail));
      const pivot = new THREE.Object3D();
      // Минус: подвес хвоста на ЗАТЫЛКЕ, а +Z кости смотрит в лицо.
      pivot.position.set(0, hs.y * (st.tail.z - HEAD_BONE_Z) / sy,
                         -hs.z * st.tail.y / sz);
      pivot.scale.set(hs.x / sx, hs.y / sy, hs.z / sz);
      const mesh = new THREE.Mesh(geoCache.get(tk), mat);
      mesh.frustumCulled = false;
      pivot.add(mesh);
      this.bone.add(pivot);
      // В покое хвост висит вниз и НАЗАД — как лёг бы под своим весом.
      this.rest = new THREE.Vector3(0, -1, -0.34).normalize();
      this.len = st.tail.len;
      this.tail = pivot;
      this.tip = new THREE.Vector3();
      this.vel = new THREE.Vector3();
      this.ready = false;
    }
  }

  /** Сбрасывать при телепорте: старт матча, вход/выход из повтора, смена
   *  ракурса в серии повторов. Иначе хвост подбрасывает от «скачка» на 45 м. */
  reset() {
    if (this.tail) this.ready = false;
  }

  update(dt) {
    if (!this.tail) return;
    const t = this.tail;
    t.updateWorldMatrix(true, false);
    // Точка подвеса берётся из мировой матрицы подвеса: она зависит от позиции,
    // а не от поворота, поэтому наш же прошлый поворот её не портит.
    const anchor = _anchor.setFromMatrixPosition(t.matrixWorld);
    // Хвост построен в координатах МОДЕЛИ, а пружина считается в МИРЕ: длину
    // берём из масштаба подвеса (ось Y локально идёт вдоль хвоста). Иначе у
    // высокого игрока пружина тянула бы кончик к точке короче самого меша.
    const me = t.matrixWorld.elements;
    const len = this.len * (Math.hypot(me[4], me[5], me[6]) || 1);
    // А вот направление ПОКОЯ обязано считаться от КОСТИ ГОЛОВЫ, а не от
    // подвеса: подвес мы сами вращаем каждый кадр, и «покой», взятый из него,
    // поехал бы следом за хвостом — пружина считала бы себя всегда в покое.
    this.bone.getWorldQuaternion(_qBone);
    const restW = _rest.copy(this.rest).applyQuaternion(_qBone).normalize();
    const restTipX = anchor.x + restW.x * len;
    const restTipY = anchor.y + restW.y * len;
    const restTipZ = anchor.z + restW.z * len;

    if (!this.ready) {
      this.tip.set(restTipX, restTipY, restTipZ);
      this.vel.set(0, 0, 0);
      this.ready = true;
      return;
    }
    // Телепорт (повтор, новый ракурс, начало матча) — не разгон, а разрыв
    if (this.tip.distanceToSquared(anchor) > HAIR.teleport * HAIR.teleport) {
      this.tip.set(restTipX, restTipY, restTipZ);
      this.vel.set(0, 0, 0);
      return;
    }

    const w = Math.PI * 2 * HAIR.freq;
    const k = w * w;
    const c = 2 * HAIR.damp * w;
    let left = Math.min(dt, HAIR.dtMax);
    // Подшаги фиксированной длины: на 30 fps планшета и 60 fps ПК причёска
    // обязана вести себя ОДИНАКОВО, иначе размах уезжает вдвое.
    const steps = Math.max(1, Math.ceil(left / HAIR.step));
    const h = left / steps;
    for (let i = 0; i < steps; i += 1) {
      this.vel.x += (k * (restTipX - this.tip.x) - c * this.vel.x) * h;
      this.vel.y += (k * (restTipY - this.tip.y) - c * this.vel.y - HAIR.gravity) * h;
      this.vel.z += (k * (restTipZ - this.tip.z) - c * this.vel.z) * h;
      this.tip.x += this.vel.x * h;
      this.tip.y += this.vel.y * h;
      this.tip.z += this.vel.z * h;
    }

    // Жёсткая длина: волосы не резиновые
    _dir.set(this.tip.x - anchor.x, this.tip.y - anchor.y, this.tip.z - anchor.z);
    const d = _dir.length() || 1;
    _dir.multiplyScalar(1 / d);

    // Ограничение угла: без него хвост на резком развороте уходит в череп
    const dot = Math.max(-1, Math.min(1, _dir.dot(restW)));
    const ang = Math.acos(dot);
    if (ang > HAIR.maxTilt) {
      _dir.lerp(restW, 1 - HAIR.maxTilt / ang).normalize();
    }
    this.tip.set(anchor.x + _dir.x * len,
                 anchor.y + _dir.y * len,
                 anchor.z + _dir.z * len);

    // Поворот подвеса: из направления покоя в текущее, в ЛОКАЛЬНЫХ осях кости
    _qInv.copy(_qBone).invert();
    _dir.applyQuaternion(_qInv).normalize();
    t.quaternion.setFromUnitVectors(this.rest, _dir);
  }
}
