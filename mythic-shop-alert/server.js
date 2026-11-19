'use strict';

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const Database = require('better-sqlite3');
const webpush = require('web-push');
const path = require('path');
const fs = require('fs');
const { ensureHistoryTables, syncHistoryCatalog } = require('./lib/history-sync');
const { ensureMasterPoolTable, upsertMasterPoolItem, migrateLegacyCatalogToMasterPool, importMasterPoolSeed, getMasterPoolStats } = require('./lib/master-pool');
const { syncLocalizedSearchAliases } = require('./lib/search-aliases');

const PORT = Number(process.env.PORT || 3000);
const API_SHOP = 'https://itemshop.gg/api/v1/shop/league-of-legends';
const API_ROTATIONS = 'https://itemshop.gg/api/v1/rotations';
const PROJECT_UA = 'Mythic-Shop-Alert/1.5.2 (+self-hosted PWA)';
const ROOT = __dirname;
const DB_PATH = path.resolve(ROOT, process.env.DATABASE_PATH || './data/mythic-shop.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS catalog_items (
    item_key TEXT PRIMARY KEY,
    item_json TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    favorites_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    device_id TEXT PRIMARY KEY,
    subscription_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(device_id) REFERENCES devices(device_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS daily_snapshots (
    shop_day TEXT PRIMARY KEY,
    fetched_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS current_shop (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    fetched_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );
`);
ensureHistoryTables(db);
ensureMasterPoolTable(db);

const vapidPublic = process.env.VAPID_PUBLIC_KEY || '';
const vapidPrivate = process.env.VAPID_PRIVATE_KEY || '';
const vapidReady = Boolean(vapidPublic && vapidPrivate);
if (vapidReady) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    vapidPublic,
    vapidPrivate
  );
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
// API responses are live data. Never let a browser, service worker, or proxy reuse yesterday's shop.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.use(express.static(path.join(ROOT, 'public'), { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));

const getState = db.prepare('SELECT value FROM app_state WHERE key = ?');
const setState = db.prepare(`INSERT INTO app_state(key, value) VALUES(?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
const upsertCatalog = db.prepare(`INSERT INTO catalog_items(item_key, item_json, first_seen, last_seen, active)
  VALUES(@item_key, @item_json, @first_seen, @last_seen, @active)
  ON CONFLICT(item_key) DO UPDATE SET
    item_json = excluded.item_json,
    last_seen = excluded.last_seen,
    active = excluded.active`);

function bootstrapSeedIfEmpty() {
  const current = db.prepare('SELECT singleton FROM current_shop WHERE singleton = 1').get();
  if (current) return;
  const seedPath = path.join(ROOT, 'data', 'seed-shop.json');
  if (!fs.existsSync(seedPath)) return;
  try {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    const normalized = normalizeShop(seed);
    normalized.stale = true;
    const timestamp = seed.data?.updatedAt || new Date().toISOString();
    const keys = normalized.items.map(item => item.key);
    const transaction = db.transaction(() => {
      for (const item of normalized.items) {
        upsertCatalog.run({ item_key: item.key, item_json: JSON.stringify(item), first_seen: timestamp, last_seen: timestamp, active: 1 });
      }
      db.prepare('INSERT OR REPLACE INTO current_shop(singleton, fetched_at, payload_json) VALUES(1, ?, ?)')
        .run(timestamp, JSON.stringify(normalized));
      setState.run('active_item_keys', JSON.stringify(keys));
      setState.run('seed_loaded_at', new Date().toISOString());
    });
    transaction();
    console.log(`[seed] loaded ${normalized.mythicItemCount} snapshot items as an offline fallback.`);
  } catch (error) {
    console.error('[seed] could not load fallback snapshot:', error.message);
  }
}

function stateValue(key, fallback = null) {
  const row = getState.get(key);
  return row ? row.value : fallback;
}

let localizedSearchAliasSyncPromise = null;
async function refreshLocalizedSearchAliases(reason = 'manual') {
  if (localizedSearchAliasSyncPromise) return localizedSearchAliasSyncPromise;
  localizedSearchAliasSyncPromise = (async () => {
    try {
      const payload = await syncLocalizedSearchAliases(db);
      setState.run('localized_search_aliases_ko', JSON.stringify(payload));
      setState.run('localized_search_aliases_error', '');
      console.log(`[search-aliases] ${reason}: localized ${payload.localizedCount}/${payload.itemCount} items; CommunityDragon ${payload.communityDragonCount}; generated chroma aliases ${payload.generatedChromaCount}; unmatched ${payload.unmatchedCount}.`);
      return payload;
    } catch (error) {
      setState.run('localized_search_aliases_error', error.message);
      console.error(`[search-aliases] ${reason} failed:`, error.message);
      const cached = stateValue('localized_search_aliases_ko');
      if (cached) {
        try { return JSON.parse(cached); } catch { /* keep the new error visible */ }
      }
      return null;
    } finally {
      localizedSearchAliasSyncPromise = null;
    }
  })();
  return localizedSearchAliasSyncPromise;
}

function getLocalizedSearchAliases() {
  try {
    const raw = stateValue('localized_search_aliases_ko');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function kstDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

function toNormalItem(item, sectionTitle) {
  const stableKey = item.itemKey || item.id;
  if (!stableKey) return null;
  return {
    key: stableKey,
    id: item.id || null,
    itemKey: item.itemKey || null,
    name: item.name || '이름 없는 상품',
    type: item.type || '기타',
    rarity: item.rarity || null,
    price: item.price || null,
    images: item.images || { card: null, render: null },
    availability: item.availability || { from: null, until: null },
    soldOut: Boolean(item.soldOut),
    sectionTitle,
    trackable: Boolean(item.itemKey)
  };
}

function normalizeShop(apiPayload) {
  if (!apiPayload || !apiPayload.data || !Array.isArray(apiPayload.data.sections)) {
    throw new Error('itemshop.gg 응답에 data.sections가 없습니다.');
  }
  const source = apiPayload.data;
  const mythicSourceSections = source.sections.filter(section => /^mythic shop:/i.test(section.title || ''));

  function normalizeSection(section) {
    return {
      title: section.title,
      upcoming: Boolean(section.upcoming),
      endsAt: section.endsAt || null,
      items: (section.items || [])
        .filter(item => !item.soldOut)
        .map(item => toNormalItem(item, section.title))
        .filter(Boolean)
        .map(item => ({ ...item, upcoming: Boolean(section.upcoming) }))
    };
  }

  const sections = mythicSourceSections.filter(section => !section.upcoming).map(normalizeSection);
  const upcomingSections = mythicSourceSections.filter(section => section.upcoming).map(normalizeSection);

  function dedupe(items) {
    const map = new Map();
    for (const item of items) {
      const existing = map.get(item.key);
      if (existing) {
        existing.sections = [...new Set([...(existing.sections || [existing.sectionTitle]), ...(item.sections || [item.sectionTitle])])];
        // If an item is in an active section and an upcoming section, active wins.
        existing.upcoming = existing.upcoming && item.upcoming;
      } else {
        item.sections = [item.sectionTitle];
        map.set(item.key, item);
      }
    }
    return [...map.values()];
  }

  const currentItems = dedupe(sections.flatMap(section => section.items));
  const upcomingItems = dedupe(upcomingSections.flatMap(section => section.items));
  const catalogMap = new Map();
  for (const item of [...upcomingItems, ...currentItems]) catalogMap.set(item.key, item); // Current item overwrites planned entry.

  return {
    game: source.game || 'league-of-legends',
    shopDate: source.shopDate || null,
    updatedAt: source.updatedAt || null,
    expiresAt: source.expiresAt || null,
    stale: Boolean(source.stale),
    fetchedAt: apiPayload.meta?.generatedAt || new Date().toISOString(),
    localDate: kstDate(),
    totalShopItems: source.itemCount ?? null,
    mythicItemCount: currentItems.length,
    sections,
    upcomingSections,
    items: currentItems,
    upcomingItems,
    catalogItems: [...catalogMap.values()],
    attribution: apiPayload.meta?.attribution || {
      text: 'Data from itemshop.gg',
      url: 'https://itemshop.gg/league-of-legends'
    },
    terms: apiPayload.meta?.terms || 'https://itemshop.gg/terms#api'
  };
}

async function getJson(url, extraHeaders = {}) {
  const response = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': PROJECT_UA, ...extraHeaders },
    signal: AbortSignal.timeout(25000)
  });
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after') || 'unknown';
    throw new Error(`itemshop.gg 요청 제한(429). Retry-After: ${retryAfter}`);
  }
  if (!response.ok) throw new Error(`itemshop.gg HTTP ${response.status}`);
  return response.json();
}

async function sendFavoritesPush(newItems) {
  if (!vapidReady || newItems.length === 0) return;
  const newKeys = new Set(newItems.map(item => item.key));
  const rows = db.prepare(`SELECT d.device_id, d.favorites_json, p.subscription_json
    FROM devices d JOIN push_subscriptions p ON p.device_id = d.device_id`).all();

  const jobs = [];
  for (const row of rows) {
    let favorites;
    let subscription;
    try {
      favorites = JSON.parse(row.favorites_json || '[]');
      subscription = JSON.parse(row.subscription_json);
    } catch {
      continue;
    }
    const matched = newItems.filter(item => newKeys.has(item.key) && favorites.includes(item.key));
    if (!matched.length) continue;

    const names = matched.slice(0, 3).map(item => item.name);
    const extra = matched.length > 3 ? ` 외 ${matched.length - 3}개` : '';
    const payload = {
      title: '즐겨찾기 상품이 입고됐어요!',
      body: `${names.join(', ')}${extra} · 신화 정수 상점을 확인해 보세요.`,
      url: '/?tab=today',
      tag: `mythic-shop-${kstDate()}`
    };
    jobs.push(webpush.sendNotification(subscription, JSON.stringify(payload)).catch(error => {
      if (error.statusCode === 404 || error.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').run(row.device_id);
      }
      console.error(`[push] ${row.device_id}:`, error.message);
    }));
  }
  await Promise.all(jobs);
}

const SHOP_REFRESH_MAX_AGE_MS = Math.max(60_000, Number(process.env.SHOP_REFRESH_MAX_AGE_MS || 5 * 60 * 1000));
let activeShopSyncPromise = null;

// One shared promise means concurrent page loads wait for the same refresh instead of
// receiving the old DB snapshot while the startup refresh is still running.
function syncShop(options = {}) {
  if (activeShopSyncPromise) return activeShopSyncPromise;
  activeShopSyncPromise = performShopSync(options).finally(() => { activeShopSyncPromise = null; });
  return activeShopSyncPromise;
}

async function performShopSync({ reason = 'poll', notify = true } = {}) {
  const attemptedAt = new Date().toISOString();
  setState.run('shop_sync_attempted_at', attemptedAt);
  setState.run('shop_sync_error', '');
  try {
    const apiPayload = await getJson(API_SHOP);
    const normalized = normalizeShop(apiPayload);
    if (normalized.stale) {
      const message = 'itemshop.gg가 stale=true인 이전 데이터를 반환했습니다.';
      setState.run('shop_sync_error', message);
      console.warn('[shop] API returned stale data; keeping previous snapshot.');
      return { updated: false, stale: true, error: message };
    }

    const previousRaw = stateValue('active_item_keys');
    let previousKeys = [];
    if (previousRaw) {
      try { previousKeys = JSON.parse(previousRaw); } catch { previousKeys = []; }
    }
    const isFirstSnapshot = previousRaw === null;
    const previousSet = new Set(previousKeys);
    const currentKeys = normalized.items.map(item => item.key);
    const newlyAdded = isFirstSnapshot ? [] : normalized.items.filter(item => !previousSet.has(item.key));
    const now = new Date().toISOString();
    const currentSet = new Set(currentKeys);

    const transaction = db.transaction(() => {
      db.prepare('UPDATE catalog_items SET active = 0').run();
      db.prepare('UPDATE master_pool_items SET active = 0').run();
      // A previously planned section must not remain marked as upcoming after it disappears.
      const priorRows = db.prepare('SELECT item_key, item_json FROM catalog_items').all();
      const updateItemJson = db.prepare('UPDATE catalog_items SET item_json = ? WHERE item_key = ?');
      for (const row of priorRows) {
        try {
          const old = JSON.parse(row.item_json);
          if (old.isUpcoming || old.upcoming) {
            old.isUpcoming = false;
            old.upcoming = false;
            updateItemJson.run(JSON.stringify(old), row.item_key);
          }
        } catch { /* ignore malformed historical row */ }
      }

      const catalogCandidates = normalized.catalogItems || normalized.items;
      for (const item of catalogCandidates) {
        const prior = db.prepare('SELECT item_json, first_seen FROM catalog_items WHERE item_key = ?').get(item.key);
        let old = {};
        if (prior) {
          try { old = JSON.parse(prior.item_json); } catch { old = {}; }
        }
        const isActive = currentSet.has(item.key);
        const merged = {
          ...old,
          ...item,
          sections: [...new Set([...(old.sections || []), ...(item.sections || [])])],
          salesHistory: Array.isArray(old.salesHistory) ? old.salesHistory : [],
          historyCount: Array.isArray(old.salesHistory) ? old.salesHistory.length : (old.historyCount || 0),
          firstSeenDate: old.firstSeenDate || (item.availability?.from ? item.availability.from.slice(0, 10) : null),
          lastSeenDate: item.availability?.from ? item.availability.from.slice(0, 10) : old.lastSeenDate || null,
          isUpcoming: !isActive && Boolean(item.upcoming),
          upcoming: !isActive && Boolean(item.upcoming)
        };
        upsertCatalog.run({
          item_key: item.key,
          item_json: JSON.stringify(merged),
          first_seen: prior?.first_seen || now,
          last_seen: now,
          active: isActive ? 1 : 0
        });
        upsertMasterPoolItem(db, merged, {
          eligibilityStatus: 'confirmed',
          source: 'itemshop.gg-live-shop',
          sourceNote: '현재 또는 예정 Mythic Shop API 응답에서 확인된 상품',
          active: isActive,
          observed: true,
          now
        });
      }
      db.prepare(`INSERT INTO current_shop(singleton, fetched_at, payload_json) VALUES(1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET fetched_at = excluded.fetched_at, payload_json = excluded.payload_json`)
        .run(now, JSON.stringify(normalized));
      const day = kstDate();
      db.prepare(`INSERT INTO daily_snapshots(shop_day, fetched_at, payload_json) VALUES(?, ?, ?)
        ON CONFLICT(shop_day) DO UPDATE SET fetched_at = excluded.fetched_at, payload_json = excluded.payload_json`)
        .run(day, now, JSON.stringify(normalized));
      setState.run('active_item_keys', JSON.stringify(currentKeys));
      setState.run('last_shop_sync', now);
      setState.run('last_sync_reason', reason);
      setState.run('shop_sync_error', '');
    });
    transaction();

    if (notify && !isFirstSnapshot && newlyAdded.length) {
      await sendFavoritesPush(newlyAdded);
    }
    console.log(`[shop] ${reason}: ${normalized.mythicItemCount} Mythic Shop entries, ${newlyAdded.length} newly rotated.`);
    return { updated: true, payload: normalized, newlyAdded: newlyAdded.length };
  } catch (error) {
    setState.run('shop_sync_error', error.message);
    console.error(`[shop] ${reason} failed:`, error.message);
    return { updated: false, error: error.message };
  }
}

async function ensureShopFresh(reason = 'request', force = false) {
  const current = db.prepare('SELECT fetched_at FROM current_shop WHERE singleton = 1').get();
  const lastSuccess = stateValue('last_shop_sync') || current?.fetched_at || null;
  const lastTime = lastSuccess ? Date.parse(lastSuccess) : 0;
  const ageMs = lastTime ? Date.now() - lastTime : Infinity;
  const needsTodaySnapshot = !lastSuccess || kstDate(new Date(lastSuccess)) !== kstDate();
  if (force) {
    // A deliberate user refresh always requests a new upstream shop snapshot.
    // Concurrent requests still share activeShopSyncPromise, preventing duplicate calls.
    setState.run('shop_manual_refresh_at', new Date().toISOString());
  }
  const needsRefresh = force || !current || needsTodaySnapshot || ageMs >= SHOP_REFRESH_MAX_AGE_MS;
  if (!needsRefresh) return { skipped: true, reason: 'snapshot is fresh', ageMs };
  return syncShop({ reason, notify: Boolean(current) });
}

let activeRotationPollPromise = null;
function pollRotations() {
  if (activeRotationPollPromise) return activeRotationPollPromise;
  activeRotationPollPromise = performRotationPoll().finally(() => { activeRotationPollPromise = null; });
  return activeRotationPollPromise;
}

async function performRotationPoll() {
  const attemptedAt = new Date().toISOString();
  setState.run('rotation_check_attempted_at', attemptedAt);
  try {
    const payload = await getJson(API_ROTATIONS);
    const league = payload.data?.['league-of-legends'];
    if (!league?.fingerprint) throw new Error('rotations 응답에서 League of Legends fingerprint를 찾지 못했습니다.');
    setState.run('rotation_check_error', '');
    setState.run('rotation_checked_at', new Date().toISOString());
    const oldFingerprint = stateValue('rotation_fingerprint');
    if (oldFingerprint !== league.fingerprint) {
      const result = await syncShop({ reason: 'rotation-change', notify: true });
      if (result.updated) {
        setState.run('rotation_fingerprint', league.fingerprint);
        // Keep the long-term catalog close to real rotation changes, not just a daily batch.
        if (process.env.ITEMSHOP_API_KEY) void runHistoryCatalogSync('rotation-change');
      }
      return result;
    }
    return { updated: false, unchanged: true };
  } catch (error) {
    setState.run('rotation_check_error', error.message);
    console.error('[rotations] poll failed:', error.message);
    return { updated: false, error: error.message };
  }
}

let historySyncInProgress = false;
async function runHistoryCatalogSync(reason = 'scheduled') {
  if (!process.env.ITEMSHOP_API_KEY) return { skipped: true, reason: 'ITEMSHOP_API_KEY is not configured' };
  if (historySyncInProgress) return { skipped: true, reason: 'history sync already in progress' };
  historySyncInProgress = true;
  const startedAt = new Date().toISOString();
  setState.run('history_catalog_syncing', '1');
  setState.run('history_catalog_attempted_at', startedAt);
  setState.run('history_catalog_error', '');
  try {
    const result = await syncHistoryCatalog(db, { apiKey: process.env.ITEMSHOP_API_KEY, delayMs: 200 });
    if (!result.skipped) {
      setState.run('history_catalog_synced_at', result.syncedAt);
      setState.run('history_available_days', String(result.availableHistoryDays));
      setState.run('history_pending_days', String(result.pendingDays));
      setState.run('history_catalog_error', result.errors?.length
        ? `${result.errors.length}개 날짜 수집 실패: ${result.errors.slice(0, 3).map(entry => `${entry.date} ${entry.message}`).join(' / ')}`
        : '');
      console.log(`[history] ${reason}: imported ${result.newlyImportedDays} new days; pending ${result.pendingDays}; catalog has ${result.catalogItems} items.`);
    }
    return result;
  } catch (error) {
    setState.run('history_catalog_error', error.message);
    console.error(`[history] ${reason} failed:`, error.message);
    return { skipped: false, error: error.message };
  } finally {
    setState.run('history_catalog_syncing', '0');
    historySyncInProgress = false;
  }
}

function validDeviceId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{12,100}$/.test(value);
}

function validSubscription(value) {
  return value && typeof value === 'object' &&
    typeof value.endpoint === 'string' && value.endpoint.startsWith('https://') &&
    value.keys && typeof value.keys.p256dh === 'string' && typeof value.keys.auth === 'string';
}

app.get('/api/config', (req, res) => {
  res.json({ notificationsEnabled: vapidReady, vapidPublicKey: vapidReady ? vapidPublic : null });
});

app.get('/api/health', (req, res) => {
  const row = db.prepare('SELECT fetched_at, payload_json FROM current_shop WHERE singleton = 1').get();
  let snapshot = null;
  try { snapshot = row ? JSON.parse(row.payload_json) : null; } catch { /* report timestamps even if old JSON is malformed */ }
  const lastShopSync = stateValue('last_shop_sync') || row?.fetched_at || null;
  const lastShopSyncAgeMs = lastShopSync ? Math.max(0, Date.now() - Date.parse(lastShopSync)) : null;
  res.json({
    ok: true,
    serverTime: new Date().toISOString(),
    timezone: 'Asia/Seoul',
    shopFetchedAt: row?.fetched_at || null,
    shopDate: snapshot?.shopDate || null,
    shopApiUpdatedAt: snapshot?.updatedAt || null,
    shopLocalDate: snapshot?.localDate || null,
    lastShopSync,
    lastShopSyncAgeMs,
    shopSyncAttemptedAt: stateValue('shop_sync_attempted_at'),
    shopSyncError: stateValue('shop_sync_error'),
    lastSyncReason: stateValue('last_sync_reason'),
    rotationCheckedAt: stateValue('rotation_checked_at'),
    rotationCheckAttemptedAt: stateValue('rotation_check_attempted_at'),
    rotationCheckError: stateValue('rotation_check_error'),
    refreshMaxAgeMs: SHOP_REFRESH_MAX_AGE_MS,
    localizedSearchAliasesUpdatedAt: getLocalizedSearchAliases()?.updatedAt || null,
    localizedSearchAliasCount: getLocalizedSearchAliases()?.localizedCount || 0,
    localizedSearchAliasItemCount: getLocalizedSearchAliases()?.itemCount || 0,
    localizedSearchAliasUnmatchedCount: getLocalizedSearchAliases()?.unmatchedCount || 0,
    localizedSearchAliasesError: stateValue('localized_search_aliases_error'),
    historySyncing: stateValue('history_catalog_syncing', '0') === '1',
    historyError: stateValue('history_catalog_error')
  });
});

app.get('/api/shop/today', async (req, res) => {
  const force = req.query.force === '1';
  // For a manual refresh, skip the preliminary fingerprint request and call the
  // shop API directly so one button press produces one fresh shop API request.
  if (!force) {
    const lastRotationCheck = Date.parse(stateValue('rotation_checked_at') || '') || 0;
    if (Date.now() - lastRotationCheck >= 60_000) await pollRotations();
  }
  const refresh = await ensureShopFresh(force ? 'manual-refresh' : 'request-freshness-check', force);
  const row = db.prepare('SELECT fetched_at, payload_json FROM current_shop WHERE singleton = 1').get();
  if (!row) return res.status(503).json({ error: '상점 데이터를 가져오지 못했습니다.', refresh, detail: stateValue('shop_sync_error') });
  const shop = JSON.parse(row.payload_json);
  if (refresh?.error || refresh?.stale) shop.stale = true;
  res.json({ fetchedAt: row.fetched_at, shop, refresh: { updated: Boolean(refresh?.updated), stale: Boolean(refresh?.stale), error: refresh?.error || null } });
});

app.get('/api/catalog', (req, res) => {
  const rows = db.prepare("SELECT item_json, active, eligibility_status, source, source_note, created_at, updated_at, last_observed_at FROM master_pool_items ORDER BY json_extract(item_json, '$.name') COLLATE NOCASE").all();
  const items = rows.map(row => {
    const item = JSON.parse(row.item_json);
    return {
      ...item,
      active: Boolean(row.active),
      firstSeen: item.firstSeen || row.created_at,
      lastSeen: item.lastSeen || row.last_observed_at || row.updated_at,
      masterPool: {
        ...(item.masterPool || {}),
        eligibilityStatus: row.eligibility_status,
        source: row.source,
        sourceNote: row.source_note,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastObservedAt: row.last_observed_at
      }
    };
  });
  const masterPoolStats = getMasterPoolStats(db);
  const historyStats = db.prepare(`SELECT COUNT(*) AS dayCount, MIN(shop_date) AS fromDate, MAX(shop_date) AS toDate FROM history_days`).get();
  const apiKeyConfigured = Boolean(process.env.ITEMSHOP_API_KEY);
  let seedImport = null;
  try { seedImport = JSON.parse(stateValue('master_pool_seed_import', 'null')); } catch { seedImport = null; }
  const availableDays = Number(stateValue('history_available_days', '0')) || 0;
  const pendingDays = Math.max(0, availableDays - historyStats.dayCount);
  const isSyncing = stateValue('history_catalog_syncing', '0') === '1';
  const lastError = stateValue('history_catalog_error');
  const noteParts = [
    `Master Pool ${masterPoolStats.total}개 상품: 실제 상점에서 확인된 상품 ${masterPoolStats.confirmed}개, 판매 후보(이력 미확인) ${masterPoolStats.candidate}개입니다.`,
    seedImport ? `v1.5 데이터 병합 결과: 이번 seed에 포함된 ${seedImport.imported}개 중 기존 DB와 중복되지 않아 새로 추가된 항목 ${seedImport.inserted}개, 기존에 있어 병합된 항목 ${seedImport.alreadyPresent}개입니다.` : '',
    historyStats.dayCount > 0
      ? `itemshop.gg가 기록한 ${historyStats.dayCount}개 상점 변경일(${historyStats.fromDate} ~ ${historyStats.toDate})의 이력을 반영했습니다.`
      : (apiKeyConfigured ? (isSyncing ? '과거 상점 기록을 가져오는 중입니다.' : '과거 상점 이력 동기화를 준비 중입니다.') : 'ITEMSHOP_API_KEY가 없으면 과거 이력은 자동 수집되지 않습니다.'),
    pendingDays > 0 ? `아직 ${pendingDays}개 기록일을 가져오는 중입니다.` : '',
    'API 기록 시작일 이전의 상품은 별도 후보 데이터로 보완해야 하며, 모든 역대 상품이 완전하게 확보됐다는 뜻은 아닙니다.'
  ].filter(Boolean);
  const note = noteParts.join(' ');
  res.json({
    items,
    count: items.length,
    masterPool: masterPoolStats,
    seedImport,
    history: {
      apiKeyConfigured,
      syncing: isSyncing,
      availableDays,
      pendingDays,
      importedDays: historyStats.dayCount,
      fromDate: historyStats.fromDate,
      throughDate: historyStats.toDate,
      lastAttemptAt: stateValue('history_catalog_attempted_at'),
      lastSyncedAt: stateValue('history_catalog_synced_at'),
      lastError
    },
    catalogNote: note
  });
});

app.get('/api/search-aliases', async (req, res) => {
  let payload = getLocalizedSearchAliases();
  const currentItemCount = Number(db.prepare('SELECT COUNT(*) AS count FROM master_pool_items').get()?.count || 0);
  if (!payload || Number(payload.itemCount || 0) !== currentItemCount) {
    payload = await refreshLocalizedSearchAliases('first-request-or-master-pool-changed');
  } else {
    const updatedAt = Date.parse(payload.updatedAt || '') || 0;
    if (Date.now() - updatedAt > 24 * 60 * 60 * 1000) void refreshLocalizedSearchAliases('stale-search-alias-cache');
  }
  if (!payload) {
    return res.json({
      schemaVersion: 1, locale: 'ko_KR', aliases: {}, localizedCount: 0,
      itemCount: 0, error: stateValue('localized_search_aliases_error') || '한국어 검색 사전을 아직 준비하지 못했습니다.'
    });
  }
  res.json({
    schemaVersion: payload.schemaVersion,
    locale: payload.locale,
    source: payload.source,
    updatedAt: payload.updatedAt,
    itemCount: payload.itemCount,
    localizedCount: payload.localizedCount,
    communityDragonCount: payload.communityDragonCount,
    generatedChromaCount: payload.generatedChromaCount,
    unmatchedCount: payload.unmatchedCount,
    aliases: payload.aliases,
    error: stateValue('localized_search_aliases_error') || null
  });
});

app.get('/api/preferences/:deviceId', (req, res) => {
  if (!validDeviceId(req.params.deviceId)) return res.status(400).json({ error: '잘못된 기기 식별자입니다.' });
  const row = db.prepare('SELECT favorites_json FROM devices WHERE device_id = ?').get(req.params.deviceId);
  const push = db.prepare('SELECT device_id FROM push_subscriptions WHERE device_id = ?').get(req.params.deviceId);
  res.json({ favorites: row ? JSON.parse(row.favorites_json) : [], hasPreferences: Boolean(row), pushEnabled: Boolean(push) });
});

app.put('/api/preferences/:deviceId', (req, res) => {
  const deviceId = req.params.deviceId;
  if (!validDeviceId(deviceId)) return res.status(400).json({ error: '잘못된 기기 식별자입니다.' });
  const favorites = req.body?.favorites;
  if (!Array.isArray(favorites) || favorites.length > 1000 || !favorites.every(v => typeof v === 'string' && v.length <= 200)) {
    return res.status(400).json({ error: 'favorites는 문자열 배열이어야 합니다.' });
  }
  const uniqueFavorites = [...new Set(favorites)];
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO devices(device_id, favorites_json, updated_at) VALUES(?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET favorites_json = excluded.favorites_json, updated_at = excluded.updated_at`)
    .run(deviceId, JSON.stringify(uniqueFavorites), now);
  res.json({ ok: true, count: uniqueFavorites.length });
});

app.post('/api/push/subscribe', (req, res) => {
  if (!vapidReady) return res.status(503).json({ error: '서버에 VAPID 키가 설정되지 않았습니다.' });
  const { deviceId, subscription } = req.body || {};
  if (!validDeviceId(deviceId) || !validSubscription(subscription)) {
    return res.status(400).json({ error: '기기 ID 또는 푸시 구독 정보가 올바르지 않습니다.' });
  }
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO devices(device_id, favorites_json, updated_at) VALUES(?, '[]', ?)
    ON CONFLICT(device_id) DO UPDATE SET updated_at = excluded.updated_at`).run(deviceId, now);
  db.prepare(`INSERT INTO push_subscriptions(device_id, subscription_json, updated_at) VALUES(?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET subscription_json = excluded.subscription_json, updated_at = excluded.updated_at`)
    .run(deviceId, JSON.stringify(subscription), now);
  res.json({ ok: true });
});

app.delete('/api/push/subscribe/:deviceId', (req, res) => {
  if (!validDeviceId(req.params.deviceId)) return res.status(400).json({ error: '잘못된 기기 식별자입니다.' });
  db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').run(req.params.deviceId);
  res.json({ ok: true, pushEnabled: false });
});

app.post('/api/push/test', async (req, res) => {
  if (!vapidReady) return res.status(503).json({ error: '서버에 VAPID 키가 설정되지 않았습니다.' });
  const { deviceId } = req.body || {};
  if (!validDeviceId(deviceId)) return res.status(400).json({ error: '잘못된 기기 식별자입니다.' });
  const row = db.prepare('SELECT subscription_json FROM push_subscriptions WHERE device_id = ?').get(deviceId);
  if (!row) return res.status(404).json({ error: '등록된 푸시 구독이 없습니다.' });
  try {
    await webpush.sendNotification(JSON.parse(row.subscription_json), JSON.stringify({
      title: '신화 상점 알리미', body: '알림이 정상적으로 설정됐어요. 즐겨찾기 상품의 입고를 알려드릴게요.', url: '/', tag: 'mythic-shop-test'
    }));
    res.json({ ok: true });
  } catch (error) {
    res.status(502).json({ error: `테스트 알림 전송 실패: ${error.message}` });
  }
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  console.error('[http]', error);
  res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
});

bootstrapSeedIfEmpty();
const migratedMasterItems = migrateLegacyCatalogToMasterPool(db);
const seededMasterItems = importMasterPoolSeed(db);
// Keep the first import's reconciliation result so it remains visible after later restarts.
if (seededMasterItems.inserted > 0 || !stateValue('master_pool_seed_import')) {
  setState.run('master_pool_seed_import', JSON.stringify({
    ...seededMasterItems,
    capturedDataset: 'itemshop.gg Mythic rarity / SKIN catalogue, 2026-11-18',
    importedAt: new Date().toISOString()
  }));
}
console.log(`[master-pool] ready: migrated ${migratedMasterItems} legacy entries; seed processed ${seededMasterItems.imported} entries (${seededMasterItems.inserted} new, ${seededMasterItems.alreadyPresent} already present).`);

const server = app.listen(PORT, () => {
  console.log(`Mythic Shop Alert listening on http://localhost:${PORT}`);

  // itemshop.gg has no fixed LoL shop reset. Poll the rotation fingerprint every minute.
  setInterval(() => { void pollRotations(); }, 60 * 1000).unref();

  // Safety net: retry every five minutes when the API request failed, the app missed
  // midnight, or the latest successful snapshot is too old. The request route above
  // provides the same recovery when a sleeping instance is first opened.
  cron.schedule('*/5 * * * *', () => { void ensureShopFresh('scheduled-freshness-retry'); }, { timezone: 'Asia/Seoul' });

  // Refresh the Korean names for every Master Pool item once per day.
  // The localized data is cached in SQLite; page views do not download these files.
  setTimeout(() => { void refreshLocalizedSearchAliases('startup'); }, 1800).unref();
  cron.schedule('10 4 * * *', () => { void refreshLocalizedSearchAliases('daily-localization-refresh'); }, { timezone: 'Asia/Seoul' });

  // Import any newly recorded historical rotations at startup and once daily.
  if (process.env.ITEMSHOP_API_KEY) {
    setTimeout(() => runHistoryCatalogSync('startup-backfill'), 2500).unref();
    cron.schedule('20 0 * * *', () => runHistoryCatalogSync('daily-history-backfill'), { timezone: 'Asia/Seoul' });
  }

  // Initial snapshot is fetched in the background, while the HTTP route can await it
  // through the shared sync promise if a user opens the app during startup.
  void (async () => {
    const existing = db.prepare('SELECT singleton FROM current_shop WHERE singleton = 1').get();
    const result = await syncShop({ reason: 'startup', notify: Boolean(existing) });
    if (result.updated) {
      try {
        const rotations = await getJson(API_ROTATIONS);
        const fingerprint = rotations.data?.['league-of-legends']?.fingerprint;
        if (fingerprint) setState.run('rotation_fingerprint', fingerprint);
        setState.run('rotation_checked_at', new Date().toISOString());
        setState.run('rotation_check_error', '');
      } catch (error) {
        setState.run('rotation_check_error', error.message);
        console.error('[rotations] initial read failed:', error.message);
      }
    }
  })();
});

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
