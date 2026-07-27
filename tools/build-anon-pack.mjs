// Сборка публичного пака из реального.
//
// Читает пак с реальной атрибутикой (data/packs/wc98-real), накладывает карту
// псевдонимов (data/packs/retro-legends/aliases.json) и пишет готовый публичный
// пак. Реальные составы остаются единственным источником истины: правим их —
// перезапускаем скрипт, публичный пак обновляется сам.
//
// Запуск:  node tools/build-anon-pack.mjs
//
// Скрипт НАМЕРЕННО падает, если у игрока нет псевдонима: молчаливая утечка
// реальной фамилии в публичный билд — ровно то, ради чего всё это затевалось.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKS = resolve(ROOT, 'data/packs');
const TARGET = 'retro-legends';

const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJSON = (p, o) => writeFileSync(p, `${JSON.stringify(o, null, 2)}\n`);

const aliases = readJSON(resolve(PACKS, TARGET, 'aliases.json'));
const srcDir = resolve(PACKS, aliases.source);
const srcPack = readJSON(resolve(srcDir, 'pack.json'));

const missing = [];

function anonTeam(side) {
  const team = readJSON(resolve(srcDir, srcPack.teams[side]));
  const swap = aliases.teams[side];

  return {
    ...team,
    name: swap.name,
    short: swap.short,
    kits: swap.kits,
    _комментарий: `Публичная версия: цвета и силуэт эпохи без эмблем, спонсоров и знаков производителя. Собрано автоматически из ${aliases.source} — руками не править, правь исходный пак и aliases.json.`,
    squad: team.squad.map((p) => {
      const alias = aliases.players[p.name];
      if (!alias) missing.push(`${swap.name}: ${p.name}`);
      return { ...p, name: alias || p.name };
    }),
  };
}

const teams = { home: anonTeam('home'), away: anonTeam('away') };

if (missing.length) {
  console.error('ОШИБКА: нет псевдонима для игроков — реальные фамилии попали бы в публичный пак:');
  missing.forEach((m) => console.error(`  • ${m}`));
  console.error('\nДобавь их в data/packs/retro-legends/aliases.json → players и запусти снова.');
  process.exit(1);
}

mkdirSync(resolve(PACKS, TARGET, 'teams'), { recursive: true });
writeJSON(resolve(PACKS, TARGET, 'teams/home.json'), teams.home);
writeJSON(resolve(PACKS, TARGET, 'teams/away.json'), teams.away);

writeJSON(resolve(PACKS, TARGET, 'pack.json'), {
  id: aliases.id,
  title: aliases.title,
  licensing: 'clean',
  _licensing: 'clean = ни реальных фамилий, ни эмблем, ни марок спонсоров. Этот пак идёт в публичный релиз и в ролики на YouTube.',
  _собрано: `Автоматически из пака ${aliases.source} скриптом tools/build-anon-pack.mjs. Руками не править.`,
  venue: aliases.venue,
  teams: { home: 'teams/home.json', away: 'teams/away.json' },
  textures: {
    boards: aliases.textures.boards,
    ball: aliases.textures.ball,
    channelLogo: aliases.textures.channelLogo,
  },
});

console.log(`Готово: пак ${TARGET} собран из ${aliases.source}.`);
console.log(`  команды: ${teams.home.name} — ${teams.away.name}`);
console.log(`  заменено фамилий: ${Object.keys(aliases.players).length}`);
