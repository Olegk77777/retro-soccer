// РОЗЫГРЫШИ СТАНДАРТОВ (правило с 31.07.2026).
//
// До этого модуля угловой был самым примитивным кодом в проекте: одна ветка в
// Match.executeAIRestart навешивала на своего с самой свободной зоной, а тела
// в штрафной расставлял общий updateBoxRuns — тот же, что при подаче с игры,
// и он вдобавок сбрасывался на каждом такте тренера. Розыгрыша как явления не
// существовало, хотя в реальном футболе со стандартов приходит 20–27 % всех
// голов, а точность подач со стандарта 33.9 % против 20.5 % с игры.
//
// Форма файла — как у ТВ-пресетов и уровней сложности: данные отдельно
// (data/setpieces.json), код только исполняет. Новая схема = новая запись.
// Игра обязана открыться и с битым JSON — тогда работает прежнее поведение.

const URL = './data/setpieces.json';

// Замороженный фолбэк: без файла угловой разыгрывается как раньше (одна
// подача на дальнюю штангу), и это ровно то, что было до правки
const FALLBACK = Object.freeze({
  corner: Object.freeze({
    routines: [Object.freeze({
      id: 'far-post', name: 'на дальнюю штангу', weight: 1,
      aim: Object.freeze({ x: 6, z: -5 }), lift: 22, spots: Object.freeze([]),
    })],
    defend: Object.freeze({ spots: Object.freeze([]) }),
  }),
  throwin: Object.freeze({ back: 0.55, square: 0.30, forward: 0.15 }),
});

// Грузим на ВЕРХНЕМ УРОВНЕ (top-level await), как пак атрибутики: схема
// нужна уже в конструкторе Match, а ждать её через колбэк значило бы
// разыграть первый же угловой матча по фолбэку
const DATA = await fetch(URL)
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((j) => {
    if (!j || !j.corner || !Array.isArray(j.corner.routines) || !j.corner.routines.length) {
      throw new Error('в setpieces.json нет ни одной схемы углового');
    }
    return j;
  })
  .catch((e) => {
    console.warn('Ф-98 · setpieces.json не прочитан, работают прежние стандарты:', e.message);
    return FALLBACK;
  });

export function setPieces() {
  return DATA;
}

// Схема углового по весам. Вес — это ДОЛЯ, с которой схема встречается: у
// коротких углових в АПЛ 11–18 %, и именно столько их должно быть у нас.
// Строгий максимум здесь не годится по той же причине, что и в выборе паса:
// предсказуемый угловой читается соперником с первого раза
export function pickCornerRoutine() {
  const list = DATA.corner.routines;
  let sum = 0;
  for (const r of list) sum += (r.weight || 0);
  if (sum <= 0) return list[0];
  let x = Math.random() * sum;
  for (const r of list) {
    x -= (r.weight || 0);
    if (x <= 0) return r;
  }
  return list[list.length - 1];
}

// Перевод точки схемы в мировые координаты.
// x — метры от ЛИЦЕВОЙ ЛИНИИ атакуемых ворот, z — метры от оси, знак «+» =
// сторона мяча. Одна запись работает на все четыре угла и обе команды, и это
// не украшение: четыре набора координат руками разошлись бы на первой правке
export function spotToWorld(spot, side, ballZ, halfLength) {
  const near = Math.sign(ballZ) || 1;
  return { x: side * (halfLength - spot.x), z: near * spot.z };
}
