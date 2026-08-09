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

// ===== ПОКОМАНДНЫЙ СЛОЙ: НАДБАВКА СОПЕРНИКУ ЧЕЛОВЕКА (31.07.2026) =====
//
// ЗАЧЕМ. Всё, что выше, пишет в ОДИН глобальный CONFIG, то есть достаётся
// ОБЕИМ командам — и одиннадцати соперникам, и десяти AI-партнёрам человека.
// Разбор 31.07.2026 посчитал дифференциал: человек заменяет собой ОДНУ фигуру
// из одиннадцати, значит симметричная прибавка доходит до 10/11 его состава и
// гасится почти целиком — остаётся 1/11 = 9 % разницы. Автосимуляция это и
// печатала: 1.69 / 1.63 / 1.81 гола на трёх уровнях, то есть уровень менял
// что угодно, кроме силы соперника ОТНОСИТЕЛЬНО человека. Единственный
// по-настоящему асимметричный рычаг, `ai.speedFactor`, на «Профи» уже стоит
// 1.00 — он ИСЧЕРПАН, дальше двигать нечего. Отсюда и жалоба Олега
// 31.07.2026: «по-прежнему очень слабая игра у ИИ даже в „Профессионале“,
// выигрываю с разгромным счётом».
//
// ЧТО ЭТО ТАКОЕ. Раздел `foe` уровня — НАДБАВКА, которую получает только та
// команда, против которой играет человек. Именно надбавка, а не перераспре-
// деление: команда человека сохраняет всё, что у неё есть сейчас, и ничего не
// теряет. Иначе «Профи» ухудшал бы своих же защитников, и это читалось бы
// как «мои игроки поглупели», а просили обратное.
//
// ПОЧЕМУ НЕ ЧЕРЕЗ CONFIG. По той же причине, по которой так не делают роли
// (см. шапку src/roles.js): CONFIG один на игру, а надбавка покомандная, и два
// писателя в одно поле в проекте стреляли уже трижды. Слой отдаёт ГОТОВЫЙ
// объект, а команда выбирает его сама (`Team.defence`).
//
// ГЛАВНАЯ ЛОВУШКА — АВТОСИМУЛЯЦИЯ. `tools/sim.js` подменяет `match.humanTeam`
// ПУСТЫШКОЙ уже после конструктора матча, чтобы человека в симуляции не было
// вовсе. Если решать «кто соперник» один раз при создании команды, то в
// симуляции надбавку молча получила бы `teams[1]` — и все записанные эталоны
// AI против AI поехали бы, причём незаметно. Поэтому команда выбирает набор
// НА ЛЕТУ и по условию «команда человека — это одна из ДВУХ играющих»: у
// пустышки этого свойства нет, надбавку не получает никто, и симуляция
// остаётся бит-в-бит прежней. Это же и приёмка слоя, ровно как у speedFactor:
// на AI против AI он обязан не менять НИЧЕГО.
//
// Пути те же плоские, что у `overrides`, но поддерживается пока одно поддерево
// — `ai.defence.*`. Оно выбрано не по удобству: разбор показал, что дуэль с
// человеком решает именно оборона (стенд `runPast`: человек проходил
// защитника в 65 % случаев на «Профи»). Остальные подсистемы (вратарь, атака)
// подключаются сюда же и тем же способом, порциями со своим замером.
const FOE_PREFIX = 'ai.defence.';

function deepClone(src) {
  if (src == null || typeof src !== 'object') return src;
  if (Array.isArray(src)) return src.map(deepClone);
  const out = {};
  for (const k of Object.keys(src)) out[k] = deepClone(src[k]);
  return out;
}

// Собрать надбавку соперника для уровня. Возвращает объект той же формы, что
// CONFIG.ai.defence, или null, если у уровня надбавки нет («Новичок»)
export function buildFoeDefence(levelId) {
  const level = LEVELS.find((l) => l.id === levelId);
  const foe = level && level.foe;
  if (!foe || !Object.keys(foe).length) return null;
  if (!CONFIG.ai.foeLayer) return null;   // выключатель ablation одним числом
  const out = deepClone(CONFIG.ai.defence);
  for (const [path, value] of Object.entries(foe)) {
    if (!path.startsWith(FOE_PREFIX)) {
      console.warn(`[сложность] надбавка соперника пока умеет только ` +
        `"${FOE_PREFIX}*", а получила "${path}" — поле НЕ РАБОТАЕТ`);
      continue;
    }
    const keys = path.slice(FOE_PREFIX.length).split('.');
    let node = out;
    let ok = true;
    for (let i = 0; i < keys.length - 1; i += 1) {
      node = node && node[keys[i]];
      if (node == null || typeof node !== 'object') { ok = false; break; }
    }
    const last = keys[keys.length - 1];
    // Та же ловушка опечаток, что у writePath и checkKeys в roles.js:
    // несуществующее поле обязано ругаться, а не молча ничего не делать
    if (!ok || !node || !(last in node)) {
      console.warn(`[сложность] в CONFIG нет пути "${path}" — надбавка ` +
        `соперника его НЕ ПРИМЕНИТ`);
      continue;
    }
    node[last] = value;
  }
  return Object.freeze(out);
}

// ?difficulty=pro в адресе — посмотреть уровень, не трогая настройку.
// Нужно стендам и записи роликов, как ?pack= у атрибутики
export function askedLevel() {
  const asked = new URLSearchParams(location.search).get('difficulty');
  return asked && LEVELS.some((l) => l.id === asked) ? asked : null;
}

export const DEFAULT_LEVEL = DATA.default || (LEVELS[0] && LEVELS[0].id) || 'rookie';
