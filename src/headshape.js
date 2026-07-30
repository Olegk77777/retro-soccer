// Форма черепа — ЛИЧНАЯ у каждого игрока, при ОДНОЙ общей геометрии.
//
// ЗАЧЕМ. Рост, сложение, тон кожи, причёска и лицо уже разные (см. squad в
// data/packs/*/teams/*.json), а череп у всех двадцати двух — один. На плане
// повтора (голова ~43 пикселя) это заметно: фигуры отличаются цветом и
// размером, но не КОСТЯКОМ. Крупная форма головы — то немногое, что читается
// на таком размере, потому что мелкие черты лица там уже не различить.
//
// ПОЧЕМУ МОРФЫ, А НЕ ГЕОМЕТРИЯ НА ИГРОКА. Геометрия у всех 22 фигур ОДНА:
// SkeletonUtils.clone делит её по ссылке (см. комментарий в player.js). А веса
// морфов живут в МЕШЕ, у каждого клона свои. Значит личная форма достаётся
// бесплатно по памяти: восемь форм на голове из 768 вершин — 51 КБ на всю
// игру, и ни одной лишней шейдерной программы (число морфов входит в ключ
// программы, но берётся из ОБЩЕЙ геометрии, то есть у всех совпадает).
//
// ПОЧЕМУ СЧИТАЕМ В JS, А НЕ ПЕЧЁМ В GLB. `export_morph=False` стоит в ТРЁХ
// экспортёрах (build-player-mesh.py, rebuild-player-clips.py,
// add-mixamo-clips.py), а шейп-ключей нет ни в одной подписи приёмки. Запеки
// морфы в glb — и следующая же пересборка стёрла бы их МОЛЧА, а оба
// приёмочных скрипта отрапортовали бы «расхождений нет». Здесь они строятся
// из позиций вершин после загрузки, и пересборка модели им не страшна.
//
// ГЛАВНОЕ ОГРАНИЧЕНИЕ — ПРИЧЁСКА. Шапка волос (src/hair.js) строится по
// СТАТИЧНОМУ профилю черепа, и зазор между черепом и шапкой у самой линии
// роста волос всего 1.2 мм у стрижки `thin` (там толщина набирается всего на
// 12% от st.grow). Морф в 9% сдвинет череп на 6-7 мм и протыкает шапку
// насквозь — ровно «повязка на голове» из фидбека 27.07.2026. Поэтому морфы
// формы черепа — ЧИСТЫЕ АНИЗОТРОПНЫЕ МАСШТАБЫ вокруг высоты кости головы, а
// не произвольные смещения: тогда шапке достаточно тех же множителей в
// scale, и она повторяет череп ТОЧНО, без пересборки геометрии и без раздутия
// кэша стрижек. Исключение — челюсть: она гаснет ниже линии роста волос, то
// есть шапки не касается вовсе.
import * as THREE from 'three';

export const HEADSHAPE = {
  // Размах каждой формы, доля размера. Влияние идёт от −1 до +1, поэтому
  // «узкий» и «широкий» череп — это ОДИН морф с разным знаком, а не два.
  amp: {
    wide: 0.090,   // ширина черепа: ±9% от полуширины (±7 мм на скулах)
    long: 0.075,   // вытянутость по высоте: ±7.5% (±15 мм на макушке)
    jaw: 0.150,    // тяжесть челюсти: ±15% в самом низу
  },
  // Высота кости mixamorigHead в осях модели. Вокруг НЕЁ идёт растяжение по
  // высоте — тогда шапка волос, у которой локальный ноль ровно здесь,
  // повторяет его собственным scale.y без всяких поправок.
  boneY: 1.6209,
  // Челюсть работает только НИЖЕ волос: полный вес до jawFull, ноль выше
  // jawTop. Самая низкая линия роста волос среди стрижек — 1.656 (`long`,
  // затылок), поэтому потолок стоит заведомо ниже неё.
  jawFull: 1.600,
  jawTop: 1.648,
  // Насколько сильно разводит фигуры хеш фамилии, когда в составе форма не задана.
  spread: 0.85,
};

const ORDER = ['wide', 'long', 'jaw'];

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Детерминированный «кубик» −1..1 по фамилии и номеру канала. */
function roll(seed, k) {
  const h = Math.imul(seed ^ Math.imul(k + 1, 0x9e3779b1), 0x85ebca6b) >>> 0;
  return h / 2147483648 - 1;
}

function clamp1(v) {
  return Math.max(-1, Math.min(1, v));
}

/** Плавная ступенька 0..1 (нулевая производная на концах — без излома). */
function smooth(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/**
 * Личная форма черепа: −1…+1 по каждой оси.
 *
 * Приоритет у ДАННЫХ: если в составе задан `head`, берём его. Иначе выводим
 * из хеша ФАМИЛИИ — по той же причине, по которой так сделано лицо: 22 черепа
 * в кадре не должны быть одним черепом, но заводить на каждую скулу поле в
 * JSON незачем. И это работает в публичном паке само собой: там фамилии
 * другие, значит и черепа другие.
 */
export function headShapeOf(look) {
  const out = { wide: 0, long: 0, jaw: 0 };
  const given = look && look.head;
  const seed = hash((look && look.name) || 'без имени');
  ORDER.forEach((key, i) => {
    out[key] = given && typeof given[key] === 'number'
      ? clamp1(given[key])
      : clamp1(roll(seed, i + 11) * HEADSHAPE.spread);
  });
  return out;
}

/**
 * Пристроить морфы формы черепа к ЗАГРУЖЕННОЙ модели. Вызывать ОДИН раз на
 * общий gltf, до создания клонов: морф-атрибуты живут в геометрии (одни на
 * всех), а веса — в меше (свои у каждого клона), и `Mesh.copy` копирует веса
 * только если они уже есть у источника.
 */
export function buildHeadMorphs(gltf) {
  if (!gltf || !gltf.scene) return gltf;
  if (gltf.userData && gltf.userData.headMorphs) return gltf;

  let head = null;
  gltf.scene.traverse((o) => {
    if (o.isMesh && o.material && o.material.name === 'head') head = o;
  });
  if (!head) {
    console.warn('headshape: меш головы не найден — форма черепа выключена');
    return gltf;
  }

  const geo = head.geometry;
  const pos = geo.getAttribute('position');
  const n = pos.count;
  const A = HEADSHAPE.amp;

  // Центр по глубине берём У САМОЙ ГЕОМЕТРИИ, а не константой: голова
  // смещена по Y (лицо впереди, затылок глубже), и масштабирование вокруг
  // нуля увело бы её вперёд целиком вместо утолщения челюсти.
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const zc = (bb.min.z + bb.max.z) * 0.5;

  const wide = new Float32Array(n * 3);
  const long = new Float32Array(n * 3);
  const jaw = new Float32Array(n * 3);

  for (let i = 0; i < n; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);

    // Ширина: чистое масштабирование по X вокруг оси симметрии.
    wide[i * 3] = x * A.wide;

    // Высота: масштабирование вокруг ВЫСОТЫ КОСТИ — см. шапку файла.
    long[i * 3 + 1] = (y - HEADSHAPE.boneY) * A.long;

    // Челюсть: то же масштабирование в плане, но с весом, гаснущим к волосам.
    const w = 1 - smooth((y - HEADSHAPE.jawFull)
      / (HEADSHAPE.jawTop - HEADSHAPE.jawFull));
    if (w > 0.0005) {
      jaw[i * 3] = x * A.jaw * w;
      jaw[i * 3 + 2] = (z - zc) * A.jaw * w;
    }
  }

  // Относительные морфы: в атрибутах лежат СМЕЩЕНИЯ, а не готовые позиции.
  geo.morphTargetsRelative = true;
  const mk = (arr, name) => {
    const a = new THREE.BufferAttribute(arr, 3);
    a.name = name;
    return a;
  };
  geo.morphAttributes.position = [
    mk(wide, 'wide'), mk(long, 'long'), mk(jaw, 'jaw'),
  ];
  head.updateMorphTargets();

  if (!gltf.userData) gltf.userData = {};
  gltf.userData.headMorphs = true;
  return gltf;
}

/**
 * Назначить форму черепа клону и вернуть множители для причёски.
 *
 * Возвращает {x, y, z} — во столько раз череп раздался по осям КОСТИ ГОЛОВЫ
 * (у неё +X влево, +Y вверх вдоль кости, +Z вперёд в лицо — замерено 27.07).
 * Эти же числа обязана взять шапка волос, иначе череп её проткнёт.
 */
export function applyHeadShape(model, look) {
  const s = headShapeOf(look);
  const A = HEADSHAPE.amp;
  const scale = { x: 1 + A.wide * s.wide, y: 1 + A.long * s.long, z: 1 };
  if (!model) return scale;

  let found = false;
  model.traverse((o) => {
    if (!o.isMesh || !o.material || o.material.name !== 'head') return;
    if (!o.morphTargetInfluences) o.updateMorphTargets();
    const d = o.morphTargetDictionary;
    if (!d || !o.morphTargetInfluences) return;
    ORDER.forEach((key) => {
      const i = d[key];
      if (i !== undefined) o.morphTargetInfluences[i] = s[key];
    });
    found = true;
  });
  if (!found) return { x: 1, y: 1, z: 1 };
  return scale;
}
