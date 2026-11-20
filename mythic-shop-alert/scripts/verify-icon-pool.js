'use strict';

const assert = require('node:assert/strict');
const {
  isRiotMythicIcon,
  toMasterPoolIcon
} = require('../lib/icon-pool-sync');
const { upsertMasterPoolItem } = require('../lib/master-pool');

const liveMythicIcon = {
  id: 7350,
  title: 'DJ 소나 얼티밋 리믹스 Live My Life 아이콘',
  yearReleased: 2026,
  isLegacy: false,
  imagePath: '/lol-game-data/assets/v1/profile-icons/7350.jpg',
  rarities: [{ region: 'riot', rarity: 4 }]
};
const nonMythicIcon = {
  id: 7351,
  title: '일반 아이콘',
  rarities: [{ region: 'riot', rarity: 1 }]
};
const nonRiotMythic = {
  id: 7353,
  title: '다른 지역 전용 아이콘',
  rarities: [{ region: 'TW', rarity: 4 }]
};

assert.equal(isRiotMythicIcon(liveMythicIcon), true);
assert.equal(isRiotMythicIcon(nonMythicIcon), false);
assert.equal(isRiotMythicIcon(nonRiotMythic), false);

const candidate = toMasterPoolIcon(liveMythicIcon);
assert.equal(candidate.key, 'lol:item:icon:7350');
assert.equal(candidate.itemKey, candidate.key);
assert.equal(candidate.id, 'item:icon:7350');
assert.equal(candidate.type, 'Summoner icon');
assert.equal(candidate.rarity.name, 'Mythic');
assert.match(candidate.images.card, /profile-icons\/7350\.jpg$/);
assert.equal(candidate.masterPool.eligibilityStatus, 'candidate');
assert.equal(candidate.price, null);
assert.deepEqual(candidate.salesHistory, []);

// Verify that re-importing a candidate cannot downgrade confirmed metadata or erase sales history.
let saved = null;
const priorItem = {
  key: candidate.key,
  itemKey: candidate.key,
  name: 'DJ Sona Ultimate Remix Live My Life Icon',
  type: 'Summoner icon',
  price: { amount: 5, currency: 'Mythic Essence' },
  images: { card: 'https://cdn.source.gs/league-of-legends/img/icon-7350-existing.webp', render: null },
  salesHistory: [{ periodKey: '2026-11-18|2027-01-07|Mythic Shop: Featured', shopDate: '2026-11-18', price: 5 }],
  historyCount: 1,
  masterPool: { eligibilityStatus: 'confirmed' }
};
const priorRow = {
  item_json: JSON.stringify(priorItem),
  eligibility_status: 'confirmed',
  source: 'itemshop.gg-live-shop',
  source_note: '실제 상점 관측',
  active: 0,
  created_at: '2026-11-18T00:00:00.000Z',
  last_observed_at: '2026-11-18T00:00:00.000Z'
};
const db = {
  prepare(sql) {
    if (sql.includes('SELECT item_json, eligibility_status')) return { get: () => priorRow };
    if (sql.includes('INSERT INTO master_pool_items')) return { run: (...args) => { saved = args; } };
    throw new Error(`Unexpected SQL: ${sql}`);
  }
};
assert.equal(upsertMasterPoolItem(db, candidate, { eligibilityStatus: 'candidate', now: '2026-11-20T00:00:00.000Z' }), true);
const merged = JSON.parse(saved[1]);
assert.equal(saved[2], 'confirmed');
assert.equal(merged.name, priorItem.name);
assert.deepEqual(merged.price, priorItem.price);
assert.equal(merged.salesHistory.length, 1);
assert.equal(merged.historyCount, 1);

console.log('Mythic icon pool verification passed: Riot Mythic filtering, stable icon keys, image paths, and confirmed sales-history preservation.');
