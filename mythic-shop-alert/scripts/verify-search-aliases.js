'use strict';

const assert = require('node:assert/strict');
const {
  parseCommunityDragonJson,
  makeLocalizedSearchAliases,
  translateCatalogueName
} = require('../lib/search-aliases');

const looseJson = '{"path":"skin\\_tile.webp","text":"line one\nline two"}';
const parsed = parseCommunityDragonJson(looseJson);
assert.equal(parsed.path, 'skin\\_tile.webp');
assert.equal(parsed.text, 'line one\nline two');

const championAliases = { Poppy: '뽀삐', Akali: '아칼리', Bard: '바드', KogMaw: '코그모', Xayah: '자야' };
const items = [
  { key: 'lol:item:skin:78015', itemKey: 'lol:item:skin:78015', id: 'item:skin:78015', name: 'Hextech Poppy', type: 'Poppy' },
  { key: 'lol:item:chroma:96066', itemKey: 'lol:item:chroma:96066', id: 'item:chroma:96066', name: "Prestige Classic Baron Kog'Maw (Vivid)", type: "Kog'Maw" },
  { key: 'lol:item:emote:10005', itemKey: 'lol:item:emote:10005', id: 'item:emote:10005', name: 'Pleeease!', type: 'Emote' },
  { key: 'lol:item:icon:4759', itemKey: 'lol:item:icon:4759', id: 'item:icon:4759', name: 'K/DA Icon', type: 'Summoner icon' },
  { key: 'lol:item:ward:205', itemKey: 'lol:item:ward:205', id: 'item:ward:205', name: 'K/DA Ward', type: 'Ward skin' },
  { key: 'lol:item:chroma:432016', itemKey: 'lol:item:chroma:432016', id: 'item:chroma:432016', name: 'Astronaut Bard (Chrono)', type: 'Bard' },
  { key: 'lol:item:chroma:498062', itemKey: 'lol:item:chroma:498062', id: 'item:chroma:498062', name: 'Battle Academia Xayah (Rebelguard)', type: 'Xayah' },
  { key: 'lol:item:other:match', itemKey: 'lol:item:other:match', id: 'entry:match', name: 'Light the Match', type: 'Other' },
  { key: 'lol:item:other:triumph', itemKey: 'lol:item:other:triumph', id: 'entry:triumph', name: 'Time For Triumph', type: 'Other' }
];
const localeData = {
  skins: { '78015': { id: 78015, name: '마법공학 뽀삐' } },
  emotes: [{ id: 10005, name: '제에에발!' }],
  icons: [{ id: 4759, title: 'K/DA 아이콘' }],
  wards: [{ id: 205, name: 'K/DA ALL OUT 와드' }]
};
const result = makeLocalizedSearchAliases(items, localeData, championAliases, {});
assert.equal(result.itemCount, 9);
assert.equal(result.localizedCount, 9);
assert.equal(result.communityDragonCount, 4);
assert.equal(result.unmatchedCount, 0);
assert.match(result.aliases['lol:item:skin:78015'].name, /마법공학 뽀삐/);
assert.match(result.aliases['lol:item:chroma:96066'].aliases.join(' '), /코그모/);
assert.match(result.aliases['lol:item:emote:10005'].name, /제에에발/);
assert.match(result.aliases['lol:item:icon:4759'].name, /아이콘/);
assert.match(result.aliases['lol:item:ward:205'].name, /와드/);
assert.match(result.aliases['lol:item:chroma:432016'].aliases.join(' '), /우주비행사.*바드.*크로노/);
assert.match(result.aliases['lol:item:chroma:498062'].aliases.join(' '), /전투사관학교.*자야.*반역 수호자/);
assert.match(result.aliases['lol:item:other:match'].aliases.join(' '), /불을 밝혀/);
assert.match(result.aliases['lol:item:other:triumph'].aliases.join(' '), /승리의 순간/);
assert.match(translateCatalogueName('Astronaut Bard (Chrono)'), /우주비행사/);

console.log(`Search alias verification passed: ${result.localizedCount}/${result.itemCount} localized in fixture (skin/chroma/emote/icon/ward/other).`);
