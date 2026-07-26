// Пак атрибутики: слой, который решает, ЧЕЙ это матч.
//
// Всё, что делает игру «Бразилия — Франция, Стад де Франс, 1998», собрано в
// один манифест данных: названия команд, фамилии, формы, рекламные щиты, мяч,
// подпись стадиона. Код об этом не знает — он спрашивает у пака.
// Смена релизного билда = одна строка в data/packs.json, логика не трогается
// (правило «данные ≠ код»; зачем это нужно — База-знаний/Исследования/17).
//
// Модуль грузит пак на верхнем уровне (top-level await): все, кто его
// импортирует, получают уже готовые данные и не городят промисы у себя.

const REGISTRY = './data/packs.json';

// Если паки не прочитались, игра обязана открыться: стадион, мяч и управление
// не зависят от атрибутики. Матча не будет — ровно как раньше при битом JSON.
const FALLBACK = Object.freeze({
  id: 'fallback',
  title: 'МАТЧ',
  venue: 'ТОВАРИЩЕСКИЙ МАТЧ',
  textures: { boards: null, ball: null },
  teams: null,
});

const fetchJSON = (url) => fetch(url).then((r) => {
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
});

async function loadPack() {
  const registry = await fetchJSON(REGISTRY);

  // ?pack=retro-legends — посмотреть публичный билд, не трогая файл.
  // Удобно для записи роликов: ссылка сразу открывает чистую версию.
  const asked = new URLSearchParams(location.search).get('pack');
  const id = asked && registry.packs?.includes(asked) ? asked : registry.active;

  const base = `./data/packs/${id}/`;
  const pack = await fetchJSON(`${base}pack.json`);
  // Пути к составам — относительно папки пака (это его данные),
  // пути к текстурам — от корня сайта (они общие для всех паков).
  const teams = await Promise.all([
    fetchJSON(base + pack.teams.home),
    fetchJSON(base + pack.teams.away),
  ]);

  return {
    id,
    title: pack.title || FALLBACK.title,
    venue: pack.venue || FALLBACK.venue,
    textures: { boards: null, ball: null, ...(pack.textures || {}) },
    teams,
  };
}

export const PACK = await loadPack().catch((e) => {
  console.error('Не удалось загрузить пак атрибутики:', e);
  return FALLBACK;
});
