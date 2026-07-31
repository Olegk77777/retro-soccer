// РОЛИ ИГРОКОВ И СТИЛИ КОМАНД (ресёрч 21 §8, правило с 31.07.2026).
//
// Зачем. До этого модуля все 22 фигуры на поле были одинаковыми: разными их
// делали только рост, причёска и фамилия. Роль — это не украшение и не «+10 к
// пасу», а способ РАЗВЕСТИ функцию оценки между игроками: кто рвёт за спину,
// кто приходит в ноги, кто остаётся впереди, когда команда обороняется. Форма
// атаки после этого возникает сама, без единой скриптованной комбинации.
//
// ГЛАВНОЕ АРХИТЕКТУРНОЕ ОТЛИЧИЕ ОТ УРОВНЕЙ СЛОЖНОСТИ. `difficulty.js` пишет
// В ЖИВОЙ CONFIG и потому обязан хранить снимок базы. Роли так делать НЕ ИМЕЮТ
// ПРАВА: они ПОИГРОЦКИЕ, а CONFIG один на всю игру — два писателя в одно поле
// в проекте уже стреляли дважды (ползунок помощи, ручки грейдинга). Поэтому
// здесь всё считается ОДИН раз при создании команды и кладётся в `p.mods` и
// `team.style`, а формулы в team.js/fieldplayer.js читают эти множители
// ЛОКАЛЬНО. Иерархия получается непротиворечивой:
//   уровень сложности задаёт СИЛУ (пишет CONFIG)
//   фаза владения задаёт ФОРМУ  (множитель поверх)
//   роль и стиль задают ЛИЧНОСТЬ (ещё один множитель поверх)
//
// ПРАВИЛО БАЗЫ. Нейтральный набор обязан давать множители РОВНО 1.0 (и сдвиги
// ровно 0 м), то есть игрок без роли и команда без стиля ведут себя бит в бит
// как до появления этого файла. Это одновременно и приёмка, и выключатель
// ablation: `CONFIG.ai.roles.enabled = false` возвращает прежние числа
// автосимуляции без единой правки кода.

import { CONFIG } from './config.js';

const ROLES_URL = './data/roles.json';
const STYLES_URL = './data/styles.json';

// Нейтраль. Всё, чего нет в роли, берётся отсюда — и при этих значениях
// КАЖДЫЙ рычаг ниже вырождается в тождество
const NEUTRAL_ROLE = Object.freeze({
  depth: 0,          // м вдоль поля (+ вперёд)
  width: 0,          // −1 внутрь … +1 на бровку
  trackBack: 1,      // 1 = возвращается как все
  runBehind: 0.5,    // веса рывков: 0.5 = «как все»
  runAhead: 0.5,
  runShort: 0.5,
  runOverlap: 0.5,
  runBox: 0.5,
  shoot: 1,          // множители: 1 = как все
  crossBias: 1,
  press: 0.5,
  // Личные атрибуты (0.5 = средний игрок)
  vision: 0.5,
  risk: 0.5,
  touch: 0.5,
  work: 0.5,
  composure: 0.5,
});
// СКОРОСТИ (`pace`) в наборе НЕТ, и это осознанно. Ресёрч разрешает ей ±6 % и
// не больше (на скорости висят шесть моделей времени — проходимость паса,
// гонки вратаря, перехват), а ±6 % — это 0.9 м на десятиметровом рывке, то
// есть 18 пикселей: НИЖЕ порога различимости с телекамеры по собственному
// критерию проекта (меньше метра не видно). Поле, которое работает только на
// счёт и рискует шестью моделями времени, — это мёртвый рычаг с побочкой,
// и заводить его до отдельного замера нельзя.

const NEUTRAL_STYLE = Object.freeze({
  lineHeight: 32,    // м: высота линии обороны. 32 = сегодняшняя
  press: 1,          // множитель зоны разбора и охоты идти в отбор
  pressLine: 0,      // м вглубь СВОЕЙ половины, где ещё отбираем (аддитивно!)
  fullbackPush: 0.5, // 0 = фулбек сидит дома … 1 = живёт у чужого флажка
  crossBias: 1,      // командная склонность к подаче
  counterSpeed: 1,   // острота контратаки
  attWidth: 1,       // ширина атаки
  compact: 1,        // узость оборонительного блока (меньше — плотнее центр)
  inSpaceBias: 0.72, // доля рывков «в пространство» (CIES: 0.61…0.86)
  patience: 1,       // осторожность передач (степень при P)
  directness: 1,     // прямолинейность: цена продвижения вперёд
  boxRunners: 4,     // сколько тел занимает штрафную под подачу
});

const fetchJSON = (url) => fetch(url).then((r) => {
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
});

// Игра обязана открыться даже с битым JSON: без ролей это просто прежнее
// поведение. Та же страховка, что у пака атрибутики и уровней сложности
const [ROLE_DATA, STYLE_DATA] = await Promise.all([
  fetchJSON(ROLES_URL).catch((e) => {
    console.error('Не удалось загрузить роли:', e);
    return { default: 'balanced', roles: [] };
  }),
  fetchJSON(STYLES_URL).catch((e) => {
    console.error('Не удалось загрузить стили команд:', e);
    return { default: 'neutral', styles: [] };
  }),
]);

// Ловушка опечаток — прямой аналог `writePath` в difficulty.js: ключ, которого
// нет в нейтрали, молча ничего не сделает, а выглядеть будет рычагом. Ровно на
// этом в проекте уже терялся день
function checkKeys(kind, id, set, neutral) {
  for (const key of Object.keys(set || {})) {
    if (key in neutral || key[0] === '_') continue;
    console.warn(`[${kind}] в наборе "${id}" есть поле "${key}", которого нет ` +
      'среди рабочих чисел — оно НЕ РАБОТАЕТ');
  }
}

const ROLES = new Map();
for (const r of ROLE_DATA.roles || []) {
  if (!r || !r.id) continue;
  checkKeys('роли', r.id, r.set, NEUTRAL_ROLE);
  ROLES.set(r.id, Object.freeze({ ...NEUTRAL_ROLE, ...(r.set || {}) }));
}
const STYLES = new Map();
for (const s of STYLE_DATA.styles || []) {
  if (!s || !s.id) continue;
  checkKeys('стили', s.id, s.set, NEUTRAL_STYLE);
  STYLES.set(s.id, Object.freeze({ ...NEUTRAL_STYLE, ...(s.set || {}) }));
}

export const ROLE_LIST = [...ROLES.keys()];
export const STYLE_LIST = [...STYLES.keys()];

// Незнакомый id не молчит: «покрутил, а эффекта нет» — самая дорогая ошибка в
// таких таблицах (записанная грабля уровней сложности)
function roleSet(id) {
  if (!id) return NEUTRAL_ROLE;
  const r = ROLES.get(id);
  if (!r) {
    console.warn(`[роли] неизвестная роль "${id}" — игрок останется универсалом`);
    return NEUTRAL_ROLE;
  }
  return r;
}

export function styleSet(id) {
  if (!id) return NEUTRAL_STYLE;
  const s = STYLES.get(id);
  if (!s) {
    console.warn(`[стили] неизвестный стиль "${id}" — команда будет нейтральной`);
    return NEUTRAL_STYLE;
  }
  return s;
}

// Слот формации → «это крайний защитник?». Командный рычаг fullbackPush
// действует только на них: у Бразилии-98 ширину атаки давали ИМЕННО фулбеки
const FULLBACK = new Set(['LB', 'RB']);

// Поля состава, которые к ролям отношения не имеют (внешность, имя, вратарские
// навыки). Всё остальное, чего нет в NEUTRAL_ROLE, — ОПЕЧАТКА, и молчать о ней
// нельзя: «покрутил, а эффекта нет» — самая дорогая ошибка в таких таблицах,
// и в проекте она уже стоила дня на мёртвых полях конфига
const LOOK_KEYS = new Set(['name', 'number', 'height', 'build', 'skin', 'hair',
  'hairColor', 'beard', 'gloves', 'glovesCuff', 'gk', 'role', 'head']);

// Вес рывка (0…1) → МЕТРОВАЯ фора в конкурсе исполнителей. Метры выбраны
// нарочно: рядом уже живут метровые гистерезисы (stickBonus 5 м, chaseHold
// 1.5 м, markHold 2 м), и новая величина обязана быть с ними в одной шкале.
// При весе 0.5 фора равна нулю — то есть прежний выбор «кто ближе»
const bias = (w, k) => (w - 0.5) * 2 * k;

// Вес рывка → МНОЖИТЕЛЬ порога. 0.5 → ровно 1.0
const gate = (w) => w / 0.5;

// Личный атрибут (0…1) → множитель вокруг единицы. 0.5 → ровно 1.0
const attr = (a, k) => 1 + (a - 0.5) * 2 * k;

// Собрать эффективные множители игрока. Зовётся ОДИН раз на игрока при
// создании команды: в кадре это чтение готовых чисел, без единой аллокации
export function buildMods(player, slotId, style) {
  const R = CONFIG.ai.roles;
  const look = player.look || {};
  // Личные поля перекрывают роль ПОВЕРХ — это Role+/Role++ у EA: роль задаёт
  // архетип, а конкретный человек может отличаться от него одним числом
  const base = roleSet(look.role);
  const s = {};
  for (const key of Object.keys(NEUTRAL_ROLE)) {
    s[key] = look[key] != null ? look[key] : base[key];
  }
  for (const key of Object.keys(look)) {
    if (!LOOK_KEYS.has(key) && !(key in NEUTRAL_ROLE) && key[0] !== '_') {
      console.warn(`[роли] в составе есть поле "${key}" (${look.name || '?'}), ` +
        'которого нет ни во внешности, ни в ролевых числах — оно НЕ РАБОТАЕТ');
    }
  }

  if (!R.enabled) {
    player.mods = Object.freeze(neutralMods());
    return player.mods;
  }

  // Командный рычаг «как высоко идут крайние защитники» действует только на
  // фулбеков и множит ИМЕННО их ролевую глубину. Шкала ресёрча 0…1 переводится
  // в множитель так, чтобы 0.5 дало ровно 1.0
  const fbK = FULLBACK.has(slotId) ? 0.4 + 1.2 * style.src.fullbackPush : 1;

  player.mods = Object.freeze({
    // --- позиция (метры, 0 = как было) ---
    // Командный рычаг ЗАЖИМАЕТ роль, а не разгоняет её: и роль «латераль»
    // (+14 м), и стиль «ширину дают фулбеки» говорят ОДНО И ТО ЖЕ, и без
    // потолка они перемножались в 22 м — крайний защитник уезжал за среднюю
    // линию и оставлял за собой не дыру, а пропасть. Потолок равен краю
    // ролевого каталога (−8…+14 м): дальше него роли не заходят по замыслу
    depth: Math.max(-R.depthMin, Math.min(R.depthMax, s.depth * fbK)),
    width: s.width * R.widthM,
    // Возврат в оборону. trackBack 1 = как все; меньше — игрок ОСТАЁТСЯ выше,
    // поэтому число прибавляется к defOff, а не множит его: множитель при 0.15
    // ПРИТЯНУЛ БЫ поачера к линии защиты, то есть дал бы ровно обратный смысл
    defOff: (1 - s.trackBack) * R.trackM,

    // --- конкурс исполнителей: метровая фора (0 при весе 0.5) ---
    bBehind: bias(s.runBehind, R.runBias),
    bAhead: bias(s.runAhead, R.runBias),
    bShort: bias(s.runShort, R.runBias),
    bBox: bias(s.runBox, R.runBias),
    // Первый защитник выбирается по МЕТРАМ, и ролевая фора обязана быть в той
    // же шкале, что соседние поправки (chaseBehindPen 4 м, chaseHold 1.5 м).
    // Множитель здесь был бы вдвое сильнее любой из них и ломал бы структуру
    bPress: bias(s.press, R.pressBias),
    // --- пороги запуска (1.0 при весе 0.5) ---
    gBehind: gate(s.runBehind),
    gOverlap: gate(s.runOverlap) * fbK,
    gPress: gate(s.press),

    // --- прямые множители ---
    shoot: s.shoot,
    crossBias: s.crossBias * style.crossBias,

    // --- личные атрибуты, уже переведённые в множители ---
    // Видение поля: дальность списка кандидатов на пас. Это самая заметная
    // ролевая правка вообще — сейчас длинного паса не существует как явления
    // не потому, что он плохо оценивается, а потому что он не попадает в список
    visionK: attr(s.vision, R.visionK),
    // Смелость: степень при вероятности доставки. Меньше степень — рискованнее
    riskK: 1 / attr(s.risk, R.riskK),
    // Хладнокровие: терпит соперника ближе и дольше держит своё решение
    pressureK: attr(s.composure, -R.composureK),
    carryK: attr(s.composure, R.composureK),
    // Техника: охота обыгрывать
    touchK: attr(s.touch, R.touchK),
    // Характер: как часто игрок вообще готов рвануть
    runCdK: attr(s.work, -R.workK),
    // Сырые значения — на случай формул, которым нужен сам атрибут
    raw: s,
  });
  return player.mods;
}

// Пересобрать роли и стиль ЖИВОЙ команды. Нужно ровно для одного —
// для ablation: правило проекта требует, чтобы механику можно было выключить
// ОДНИМ ЧИСЛОМ в конфиге, без правки кода. А `p.mods` считаются один раз при
// создании команды, и без пересборки флаг `roles.enabled` подействовал бы
// только после перезагрузки страницы
export function rebuildTeam(team) {
  team.style = buildStyle(team.data && team.data.style);
  team.players.forEach((p) => {
    p.mods = p.isKeeper ? NEUTRAL_MODS : buildMods(p, p.role, team.style);
  });
}

function neutralMods() {
  return {
    depth: 0, width: 0, defOff: 0,
    bBehind: 0, bAhead: 0, bShort: 0, bBox: 0, bPress: 0,
    gBehind: 1, gOverlap: 1, gPress: 1,
    shoot: 1, crossBias: 1,
    visionK: 1, riskK: 1, pressureK: 1, carryK: 1, touchK: 1, runCdK: 1,
    raw: NEUTRAL_ROLE,
  };
}

// Нейтральные модификаторы для тех, у кого их не построили (арбитры, запасные
// фигуры, любой будущий потребитель). Один общий замороженный объект
export const NEUTRAL_MODS = Object.freeze(neutralMods());
export const NEUTRAL_TEAM_STYLE = NEUTRAL_STYLE;

// Стиль команды → готовые множители, которые читает team.js. Считается один
// раз на команду
export function buildStyle(id) {
  const s = styleSet(id);
  const R = CONFIG.ai.roles;
  if (!R.enabled) {
    return Object.freeze({ id: 'neutral', name: 'НЕЙТРАЛЬНЫЙ', src: NEUTRAL_STYLE,
      lineK: 1, pressK: 1, pressLine: 0, crossBias: 1, counterK: 1, widthK: 1, compactK: 1,
      spaceK: 1, shortK: 1, patience: 1, directness: 1, boxRunners: 4 });
  }
  const meta = (STYLE_DATA.styles || []).find((x) => x.id === id) || {};
  return Object.freeze({
    id: STYLES.has(id) ? id : 'neutral',
    name: meta.name || 'НЕЙТРАЛЬНЫЙ',
    src: s,
    // Высота линии задана В МЕТРАХ, чтобы таблицу стилей можно было сверять с
    // ресёрчем напрямую; в код она приходит множителем к mentality
    lineK: s.lineHeight / NEUTRAL_STYLE.lineHeight,
    pressK: s.press,
    pressLine: s.pressLine,
    crossBias: s.crossBias,
    counterK: s.counterSpeed,
    widthK: s.attWidth,
    compactK: s.compact,
    // Доля рывков «в пространство»: чем выше, тем охотнее команда бросает мяч
    // за спину и тем реже показывается в ноги
    spaceK: 1 + (s.inSpaceBias - NEUTRAL_STYLE.inSpaceBias) * R.spaceK,
    shortK: 1 - (s.inSpaceBias - NEUTRAL_STYLE.inSpaceBias) * R.spaceK,
    patience: s.patience,
    directness: s.directness,
    boxRunners: s.boxRunners,
  });
}
