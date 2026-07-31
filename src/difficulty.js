// УРОВНИ СЛОЖНОСТИ (правило с 31.07.2026).
//
// Уровень — это НАБОР ОТЛИЧИЙ от базового конфига, а не отдельная ветка кода.
// Форма один в один как у ТВ-пресетов (data/tv-presets.json): «Новичок» — это
// ПУСТОЙ набор отличий, то есть игра ровно такая, какой она была до введения
// уровней (просьба Олега: «то, что сейчас, берём за самый лёгкий уровень, он
// хорош для тестов»). Любое новое поведение обязано иметь число, при котором
// оно выключено, и на «Новичке» стоять именно в нём.
//
// ГЛАВНАЯ ЛОВУШКА, ради которой этот модуль вообще нужен. ТВ-пресеты уходят в
// шейдер и «сбрасываются» сами, а уровень пишет В ЖИВОЙ CONFIG, и обратного
// пути в проекте нет нигде, кроме ручного снимка в tools/sim.js. Если просто
// накатывать перекрытия друг на друга, переключение Профессионал → Новичок
// оставит в CONFIG числа профессионала, и «Новичок = как сейчас» перестанет
// быть правдой — незаметно, без единой ошибки в консоли. Ровно так уже
// обжигались на ручках грейдинга (GRADE_BASE в main.js). Поэтому:
//   1) при первом применении снимаем БАЗУ по всем путям, какие вообще
//      упоминает хоть один уровень;
//   2) каждое применение сперва ВОССТАНАВЛИВАЕТ базу целиком и только потом
//      кладёт перекрытия выбранного уровня.
//
// Пути — плоские, с точками: "ai.defence.jockeyDist". Несуществующий путь не
// молчит, а ругается в консоль: в конфиге хватает МЁРТВЫХ полей (их нашлось
// с десяток при разборе), и «покрутил, а эффекта нет» — самая дорогая из
// возможных ошибок в такой таблице.

import { CONFIG } from './config.js';

const REGISTRY = './data/difficulty.json';

// Игра обязана открыться даже с битым JSON: без уровней это просто прежний
// баланс, то есть «Новичок». Замороженный фолбэк — та же страховка, что у пака
const FALLBACK = Object.freeze({
  default: 'rookie',
  levels: [Object.freeze({
    id: 'rookie', name: 'НОВИЧОК', comment: 'базовый баланс', overrides: {},
  })],
});

const fetchJSON = (url) => fetch(url).then((r) => {
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
});

const DATA = await fetchJSON(REGISTRY).catch((e) => {
  console.error('Не удалось загрузить уровни сложности:', e);
  return FALLBACK;
});

export const LEVELS = (DATA.levels || []).filter((l) => l && l.id && !l.hidden);

// --- База: снимок исходных значений всех путей, какие трогают уровни ---
const BASE = new Map();

function readPath(path) {
  let node = CONFIG;
  const keys = path.split('.');
  for (let i = 0; i < keys.length - 1; i += 1) {
    node = node && node[keys[i]];
    if (node == null || typeof node !== 'object') return undefined;
  }
  return node ? node[keys[keys.length - 1]] : undefined;
}

function writePath(path, value) {
  let node = CONFIG;
  const keys = path.split('.');
  for (let i = 0; i < keys.length - 1; i += 1) {
    node = node && node[keys[i]];
    if (node == null || typeof node !== 'object') return false;
  }
  if (!node || !(keys[keys.length - 1] in node)) return false;
  node[keys[keys.length - 1]] = value;
  return true;
}

// Снимаем базу ОДИН раз и сразу по объединению всех путей всех уровней: если
// снимать лениво, по мере применения, то первое же переключение «сложный →
// лёгкий» восстановит только те поля, которые успел тронуть лёгкий уровень
function snapshotBase() {
  if (BASE.size) return;
  for (const level of LEVELS) {
    for (const path of Object.keys(level.overrides || {})) {
      if (BASE.has(path)) continue;
      const v = readPath(path);
      if (v === undefined) {
        console.warn(`[сложность] в CONFIG нет пути "${path}" — уровень ` +
          `"${level.id}" его молча не применит`);
        continue;
      }
      BASE.set(path, v);
    }
  }
}

let current = null;

export function currentLevel() {
  return current;
}

// Применить уровень по id. Возвращает применённый уровень (или базовый,
// если id неизвестен) — вызывающему это нужно, чтобы подписать контрол.
export function applyDifficulty(id) {
  snapshotBase();
  const level = LEVELS.find((l) => l.id === id) ||
    LEVELS.find((l) => l.id === DATA.default) || LEVELS[0];
  if (!level) return null;

  // Сперва — ПОЛНЫЙ откат к базе, и только потом перекрытия уровня
  for (const [path, value] of BASE) writePath(path, value);
  for (const [path, value] of Object.entries(level.overrides || {})) {
    if (!writePath(path, value)) {
      console.warn(`[сложность] путь "${path}" не записался (уровень "${level.id}")`);
    }
  }
  current = level;
  return level;
}

// ?difficulty=pro в адресе — посмотреть уровень, не трогая настройку.
// Нужно стендам и записи роликов, как ?pack= у атрибутики
export function askedLevel() {
  const asked = new URLSearchParams(location.search).get('difficulty');
  return asked && LEVELS.some((l) => l.id === asked) ? asked : null;
}

export const DEFAULT_LEVEL = DATA.default || (LEVELS[0] && LEVELS[0].id) || 'rookie';
