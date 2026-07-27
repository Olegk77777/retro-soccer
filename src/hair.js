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
import * as THREE from 'three';

// Профиль головы, СВЕРЕННЫЙ с tools/build-player-mesh.py → HEAD.
// (мировая высота в метрах, полуширина по X, полуглубина по Y, сдвиг по Y).
// Меняешь голову там — правь и здесь, иначе шапка сползёт с черепа.
const HEAD_PROFILE = [
  [1.584, 0.038, 0.057, -0.011],
  [1.610, 0.056, 0.079, -0.009],
  [1.641, 0.069, 0.091, -0.006],
  [1.676, 0.074, 0.096, -0.004],
  [1.714, 0.072, 0.093, 0.000],
  [1.752, 0.066, 0.083, 0.004],
  [1.784, 0.047, 0.058, 0.006],
  [1.800, 0.022, 0.027, 0.006],
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
  segments: 10,      // граней по кругу шапки
};

// Стили. lowFront/lowBack — мировая высота нижнего края волос спереди и сзади
// (спереди линия выше: это и есть линия роста волос). grow — насколько шапка
// толще черепа. lift — приподнятая макушка (копна).
const STYLES = {
  none: null,
  thin: { lowFront: 1.762, lowBack: 1.694, grow: 0.004, lift: 0.000 },
  short: { lowFront: 1.734, lowBack: 1.668, grow: 0.009, lift: 0.005 },
  afro: { lowFront: 1.724, lowBack: 1.662, grow: 0.030, lift: 0.028 },
  long: {
    lowFront: 1.730, lowBack: 1.648, grow: 0.011, lift: 0.006,
    // Хвост: подвес на затылке, длина и толщина в метрах
    tail: { z: 1.672, y: 0.088, len: 0.145, w: 0.052, thick: 0.036 },
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

/** Шапка волос: облегает череп, снизу обрезана по линии роста волос. */
function capGeometry(st) {
  const n = HAIR.segments;
  const levels = [1.752, 1.784, 1.801 + st.lift];
  const verts = [];
  const idx = [];

  const ring = (z, extra) => {
    const p = profileAt(z);
    const start = verts.length / 3;
    for (let k = 0; k < n; k += 1) {
      const a = (k / n) * Math.PI * 2;                    // 0 = вперёд (-Z в мире модели)
      const g = st.grow + extra;
      verts.push(p[1] === 0 ? 0 : (p[1] + g) * Math.sin(a),
                 z - HEAD_BONE_Z,
                 -((p[2] + g) * Math.cos(a)) + p[3]);
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
    const g = st.grow;
    low.push([(p[1] + g) * Math.sin(a), z - HEAD_BONE_Z,
              -((p[2] + g) * Math.cos(a)) + p[3]]);
  }
  const lowStart = verts.length / 3;
  for (const v of low) verts.push(v[0], v[1], v[2]);

  const rings = [lowStart];
  for (const z of levels) rings.push(ring(z, 0));
  // макушка — одна вершина
  const topP = profileAt(1.800);
  const top = verts.length / 3;
  verts.push(0, 1.801 + st.lift - HEAD_BONE_Z, topP[3]);

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
  geo.setIndex(idx);
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
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function material(colorHex) {
  const key = colorHex || '#241812';
  if (matCache.has(key)) return matCache.get(key);
  const col = new THREE.Color(key);
  const m = new THREE.MeshLambertMaterial({
    color: col,
    // Тот же уровень, что у кожи (0.45 в линейном): без него причёска на
    // вечернем поле проваливается в чёрный силуэт.
    emissive: col.clone().multiplyScalar(0.45),
  });
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

/**
 * Причёска игрока. Живёт на кости головы; хвост качается на пружине.
 * Возвращает null, если стиль «лысый» или кости нет.
 */
export class HairRig {
  constructor(model, look) {
    const st = STYLES[(look && look.hair) || 'short'];
    this.bone = model.getObjectByName('mixamorigHead');
    this.tail = null;
    if (!st || !this.bone) return;

    model.updateMatrixWorld(true);
    // Кость Mixamo живёт в своём масштабе (сантиметры), да ещё умноженном на
    // рост и сложение игрока — причём НЕРАВНОМЕРНО (scale = tall·wide, tall,
    // tall·wide). Снимаем масштаб ПОКОЛОНОЧНО: один общий множитель врал бы
    // процентов на десять у плотного игрока.
    const e = this.bone.matrixWorld.elements;
    const sx = Math.hypot(e[0], e[1], e[2]) || 1;
    const sy = Math.hypot(e[4], e[5], e[6]) || 1;
    const sz = Math.hypot(e[8], e[9], e[10]) || 1;

    const color = (look && look.hairColor) || '#241812';
    const mat = material(color);

    const key = `${look && look.hair}|${st.lift}`;
    if (!geoCache.has(key)) geoCache.set(key, capGeometry(st));
    const cap = new THREE.Mesh(geoCache.get(key), mat);
    cap.scale.set(1 / sx, 1 / sy, 1 / sz);
    cap.frustumCulled = false;
    this.bone.add(cap);
    this.cap = cap;

    if (st.tail) {
      const tk = `tail|${look && look.hair}`;
      if (!geoCache.has(tk)) geoCache.set(tk, tailGeometry(st.tail));
      const pivot = new THREE.Object3D();
      pivot.position.set(0, (st.tail.z - HEAD_BONE_Z) / sy, st.tail.y / sz);
      pivot.scale.set(1 / sx, 1 / sy, 1 / sz);
      const mesh = new THREE.Mesh(geoCache.get(tk), mat);
      mesh.frustumCulled = false;
      pivot.add(mesh);
      this.bone.add(pivot);
      // Хвост в покое висит вниз и чуть назад — как лежал бы под своим весом.
      this.rest = new THREE.Vector3(0, -1, 0.34).normalize();
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
    // А вот направление ПОКОЯ обязано считаться от КОСТИ ГОЛОВЫ, а не от
    // подвеса: подвес мы сами вращаем каждый кадр, и «покой», взятый из него,
    // поехал бы следом за хвостом — пружина считала бы себя всегда в покое.
    this.bone.getWorldQuaternion(_qBone);
    const restW = _rest.copy(this.rest).applyQuaternion(_qBone).normalize();
    const restTipX = anchor.x + restW.x * this.len;
    const restTipY = anchor.y + restW.y * this.len;
    const restTipZ = anchor.z + restW.z * this.len;

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
    this.tip.set(anchor.x + _dir.x * this.len,
                 anchor.y + _dir.y * this.len,
                 anchor.z + _dir.z * this.len);

    // Поворот подвеса: из направления покоя в текущее, в ЛОКАЛЬНЫХ осях кости
    _qInv.copy(_qBone).invert();
    _dir.applyQuaternion(_qInv).normalize();
    t.quaternion.setFromUnitVectors(this.rest, _dir);
  }
}
