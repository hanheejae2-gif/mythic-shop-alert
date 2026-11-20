'use strict';

const assert = require('node:assert/strict');
const { normalizeShop } = require('../lib/shop-normalize');

const payload = {
  data: {
    game: 'league-of-legends',
    shopDate: '2026-11-20',
    updatedAt: '2026-11-19T01:00:00.000Z',
    itemCount: 3,
    stale: false,
    sections: [
      {
        title: 'Mythic Shop: featured',
        upcoming: false,
        items: [
          {
            id: 'item:skin:96065',
            itemKey: 'lol:item:skin:96065',
            name: 'Prestige Classic Baron Kog’Maw',
            type: 'Kog’Maw',
            price: { amount: 150, currency: 'Mythic Essence' },
            images: { card: 'https://example.test/skin.webp', render: null },
            soldOut: false
          },
          {
            id: 'item:icon:7350',
            itemKey: 'lol:item:icon:7350',
            name: 'DJ Sona Ultimate Remix Live My Life Icon',
            type: 'Summoner icon',
            price: { amount: 5, currency: 'Mythic Essence' },
            images: { card: 'https://example.test/icon.webp', render: null },
            availability: { from: '2026-11-18T00:00:00Z', until: '2027-01-07T00:00:00Z' },
            soldOut: false
          },
          {
            id: 'item:icon:9999',
            itemKey: 'lol:item:icon:9999',
            name: 'Sold Out Icon',
            type: 'Summoner icon',
            soldOut: true
          }
        ]
      },
      {
        title: 'Skin sale this week',
        upcoming: false,
        items: [{ id: 'item:skin:123', itemKey: 'lol:item:skin:123', name: 'Unrelated skin' }]
      },
      {
        title: 'Mythic Shop: biweekly',
        upcoming: true,
        items: [{ id: 'item:icon:7352', itemKey: 'lol:item:icon:7352', name: 'DJ Sona FIRESTARTER Icon', type: 'Summoner icon' }]
      }
    ]
  },
  meta: { generatedAt: '2026-11-20T12:00:00.000Z' }
};
const normalized = normalizeShop(payload, new Date('2026-11-20T12:01:00.000Z'));
const icon = normalized.items.find(item => item.itemKey === 'lol:item:icon:7350');
assert.ok(icon, 'current Mythic icon should be included');
assert.equal(icon.id, 'item:icon:7350');
assert.equal(icon.type, 'Summoner icon');
assert.equal(icon.price.amount, 5);
assert.equal(icon.images.card, 'https://example.test/icon.webp');
assert.equal(normalized.items.length, 2, 'sold-out items should be omitted and skin+icon retained');
assert.equal(normalized.catalogItems.length, 3, 'upcoming icon should be retained in catalog candidates');
assert.equal(normalized.upcomingItems[0].itemKey, 'lol:item:icon:7352');
assert.equal(normalized.updatedAt, '2026-11-19T01:00:00.000Z');
assert.equal(normalized.fetchedAt, '2026-11-20T12:00:00.000Z');

console.log('Shop normalization verification passed: mixed skin/icon sections, item fields, upcoming icons, and source timestamps.');
