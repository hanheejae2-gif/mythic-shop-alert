'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const seed = JSON.parse(fs.readFileSync(path.join(root, 'data/master-pool-seed.json'), 'utf8'));
const catalogue = JSON.parse(fs.readFileSync(path.join(root, 'data/master-pool-catalogue.json'), 'utf8'));
const audit = JSON.parse(fs.readFileSync(path.join(root, 'data/master-pool-v1.5-audit.json'), 'utf8'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(Array.isArray(seed), 'master-pool-seed.json must be an array');
assert(seed.length === 159, `Expected 159 seed entries, received ${seed.length}`);
assert(catalogue.items.length === 159, 'Catalogue item count must be 159');
assert(audit.counts.catalogueListings === 173, 'Raw catalogue listing count must be 173');
assert(audit.counts.uniqueSkinIds === 159, 'Unique skin ID count must be 159');
assert(audit.counts.duplicateListingsRemoved === 14, 'Deduplication count must be 14');

const keys = new Set();
for (const item of seed) {
  assert(item && typeof item === 'object', 'Seed row must be an object');
  assert(/^lol:item:skin:\d+$/.test(item.key), `Invalid key: ${item.key}`);
  assert(item.key === item.itemKey, `key/itemKey mismatch for ${item.key}`);
  assert(item.id === item.key.replace(/^lol:/, ''), `id mismatch for ${item.key}`);
  assert(!keys.has(item.key), `Duplicate key: ${item.key}`);
  keys.add(item.key);
  assert(item.masterPool?.eligibilityStatus === 'candidate', `Unexpected status for ${item.key}`);
  assert(item.rarity?.name === 'Mythic', `Unexpected rarity for ${item.key}`);
  assert(item.images?.card?.startsWith('https://cdn.source.gs/league-of-legends/img/skin-'), `Missing image for ${item.key}`);
  assert(Array.isArray(item.salesHistory) && item.salesHistory.length === 0, `Unverified sales history for ${item.key}`);
  assert(item.price === null, `Unverified price for ${item.key}`);
}

console.log(`Master Pool v1.5 data verified: ${seed.length} unique Mythic-rarity skin candidates (${audit.counts.catalogueListings} catalogue listings, ${audit.counts.duplicateListingsRemoved} duplicate listings removed).`);
