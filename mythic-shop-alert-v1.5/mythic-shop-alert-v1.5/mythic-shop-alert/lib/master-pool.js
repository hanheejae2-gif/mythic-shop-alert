'use strict';

const fs = require('fs');
const path = require('path');

function ensureMasterPoolTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS master_pool_items (
      item_key TEXT PRIMARY KEY,
      item_json TEXT NOT NULL,
      eligibility_status TEXT NOT NULL DEFAULT 'confirmed',
      source TEXT NOT NULL DEFAULT 'unknown',
      source_note TEXT,
      active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_observed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_master_pool_status ON master_pool_items(eligibility_status);
    CREATE INDEX IF NOT EXISTS idx_master_pool_active ON master_pool_items(active);
  `);
}

const STATUS_PRIORITY = { candidate: 1, confirmed: 2, excluded: 3 };

function upsertMasterPoolItem(db, item, options = {}) {
  if (!item || typeof item !== 'object') return false;
  const itemKey = item.itemKey || item.key || (item.id ? `lol:${item.id}` : null);
  if (!itemKey || typeof itemKey !== 'string') return false;
  const prior = db.prepare(`SELECT item_json, eligibility_status, source, source_note, active,
      created_at, last_observed_at FROM master_pool_items WHERE item_key = ?`).get(itemKey);
  let old = {};
  if (prior) {
    try { old = JSON.parse(prior.item_json); } catch { old = {}; }
  }

  const requestedStatus = options.eligibilityStatus || item.masterPool?.eligibilityStatus || 'confirmed';
  const oldStatus = prior?.eligibility_status || old.masterPool?.eligibilityStatus || null;
  const status = !oldStatus || (STATUS_PRIORITY[requestedStatus] || 0) >= (STATUS_PRIORITY[oldStatus] || 0)
    ? requestedStatus
    : oldStatus;
  const source = status === oldStatus && prior?.source ? prior.source : (options.source || item.masterPool?.source || 'itemshop.gg');
  const sourceNote = status === oldStatus && prior?.source_note
    ? prior.source_note
    : (options.sourceNote || item.masterPool?.sourceNote || null);
  const now = options.now || new Date().toISOString();
  const active = options.active === undefined ? (prior ? prior.active : Number(Boolean(item.active))) : Number(Boolean(options.active));
  const observedAt = options.observedAt || (options.observed ? now : prior?.last_observed_at || null);

  const merged = {
    ...old,
    ...item,
    key: itemKey,
    itemKey: item.itemKey || old.itemKey || (itemKey.startsWith('lol:') ? itemKey : null),
    salesHistory: Array.isArray(item.salesHistory) ? item.salesHistory : (Array.isArray(old.salesHistory) ? old.salesHistory : []),
    historyCount: Array.isArray(item.salesHistory) ? item.salesHistory.length : (old.historyCount || 0),
    active: Boolean(active),
    masterPool: {
      ...(old.masterPool || {}),
      ...(item.masterPool || {}),
      eligibilityStatus: status,
      source,
      sourceNote,
      createdAt: prior?.created_at || now,
      updatedAt: now,
      lastObservedAt: observedAt
    }
  };

  db.prepare(`INSERT INTO master_pool_items(
      item_key, item_json, eligibility_status, source, source_note, active, created_at, updated_at, last_observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_key) DO UPDATE SET
      item_json = excluded.item_json,
      eligibility_status = excluded.eligibility_status,
      source = excluded.source,
      source_note = excluded.source_note,
      active = excluded.active,
      updated_at = excluded.updated_at,
      last_observed_at = COALESCE(excluded.last_observed_at, master_pool_items.last_observed_at)`)
    .run(
      itemKey,
      JSON.stringify(merged),
      status,
      source,
      sourceNote,
      active,
      prior?.created_at || now,
      now,
      observedAt
    );
  return true;
}

function migrateLegacyCatalogToMasterPool(db) {
  ensureMasterPoolTable(db);
  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'catalog_items'`).get();
  if (!tableExists) return 0;
  const rows = db.prepare('SELECT item_key, item_json, active, first_seen, last_seen FROM catalog_items').all();
  let migrated = 0;
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    for (const row of rows) {
      let item;
      try { item = JSON.parse(row.item_json); } catch { continue; }
      item.key = item.key || row.item_key;
      item.firstSeen = item.firstSeen || row.first_seen;
      item.lastSeen = item.lastSeen || row.last_seen;
      item.active = Boolean(row.active);
      const hasHistory = Array.isArray(item.salesHistory) && item.salesHistory.length > 0;
      const source = hasHistory ? 'itemshop.gg-history' : (row.active ? 'itemshop.gg-live-shop' : 'v1.3-existing-catalog');
      if (upsertMasterPoolItem(db, item, {
        eligibilityStatus: 'confirmed',
        source,
        sourceNote: '기존 v1.3 카탈로그에서 이전한 실제 상점 관측 상품',
        active: Boolean(row.active),
        observedAt: row.last_seen || now,
        now
      })) migrated += 1;
    }
  });
  transaction();
  return migrated;
}

function importMasterPoolSeed(db, seedPath = path.join(__dirname, '..', 'data', 'master-pool-seed.json')) {
  ensureMasterPoolTable(db);
  if (!fs.existsSync(seedPath)) return { imported: 0, skipped: true };
  let seed;
  try { seed = JSON.parse(fs.readFileSync(seedPath, 'utf8')); }
  catch (error) { throw new Error(`Master Pool seed JSON을 읽을 수 없습니다: ${error.message}`); }
  if (!Array.isArray(seed)) throw new Error('master-pool-seed.json은 상품 객체 배열이어야 합니다.');

  let imported = 0;
  let inserted = 0;
  let alreadyPresent = 0;
  let invalid = 0;
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    for (const item of seed) {
      const itemKey = item?.itemKey || item?.key || (item?.id ? `lol:${item.id}` : null);
      if (!itemKey || typeof itemKey !== 'string') {
        invalid += 1;
        continue;
      }
      const existed = Boolean(db.prepare('SELECT 1 AS found FROM master_pool_items WHERE item_key = ?').get(itemKey));
      const ok = upsertMasterPoolItem(db, item, {
        eligibilityStatus: item.masterPool?.eligibilityStatus || 'candidate',
        source: item.masterPool?.source || 'manual-curated-seed',
        sourceNote: item.masterPool?.sourceNote || '운영자가 확인한 판매 후보 상품',
        now
      });
      if (ok) {
        imported += 1;
        if (existed) alreadyPresent += 1;
        else inserted += 1;
      } else {
        invalid += 1;
      }
    }
  });
  transaction();
  return { imported, inserted, alreadyPresent, invalid, skipped: false };
}

function getMasterPoolStats(db) {
  ensureMasterPoolTable(db);
  const total = db.prepare('SELECT COUNT(*) AS count FROM master_pool_items').get().count;
  const confirmed = db.prepare("SELECT COUNT(*) AS count FROM master_pool_items WHERE eligibility_status = 'confirmed'").get().count;
  const candidate = db.prepare("SELECT COUNT(*) AS count FROM master_pool_items WHERE eligibility_status = 'candidate'").get().count;
  const active = db.prepare('SELECT COUNT(*) AS count FROM master_pool_items WHERE active = 1').get().count;
  return { total, confirmed, candidate, active };
}

module.exports = {
  ensureMasterPoolTable,
  upsertMasterPoolItem,
  migrateLegacyCatalogToMasterPool,
  importMasterPoolSeed,
  getMasterPoolStats
};
