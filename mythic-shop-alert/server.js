'use strict';

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const Database = require('better-sqlite3');
const webpush = require('web-push');
const path = require('path');
const fs = require('fs');
const { ensureHistoryTables, syncHistoryCatalog } = require('./lib/history-sync');

const PORT = Number(process.env.PORT || 3000);
const API_SHOP = 'https://itemshop.gg/api/v1/shop/league-of-legends';
const API_ROTATIONS = 'https://itemshop.gg/api/v1/rotations';
const PROJECT_UA = 'Mythic-Shop-Alert/1.1 (+self-hosted PWA)';
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

let syncInProgress = false;
async function syncShop({ reason = 'poll', notify = true } = {}) {
  if (syncInProgress) return { skipped: true, reason: 'sync already in progress' };
  syncInProgress = true;
  try {
    const apiPayload = await getJson(API_SHOP);
    const normalized = normalizeShop(apiPayload);
    if (normalized.stale) {
      console.warn('[shop] API returned stale data; keeping previous snapshot.');
      return { updated: false, stale: true };
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
    });
    transaction();

    if (notify && !isFirstSnapshot && newlyAdded.length) {
      await sendFavoritesPush(newlyAdded);
    }
    console.log(`[shop] ${reason}: ${normalized.mythicItemCount} Mythic Shop entries, ${newlyAdded.length} newly rotated.`);
    return { updated: true, payload: normalized, newlyAdded: newlyAdded.length };
  } catch (error) {
    console.error(`[shop] ${reason} failed:`, error.message);
    return { updated: false, error: error.message };
  } finally {
    syncInProgress = false;
  }
}

async function pollRotations() {
  try {
    const payload = await getJson(API_ROTATIONS);
    const league = payload.data?.['league-of-legends'];
    if (!league?.fingerprint) return;
    const oldFingerprint = stateValue('rotation_fingerprint');
    if (oldFingerprint !== league.fingerprint) {
      const result = await syncShop({ reason: 'rotation-change', notify: true });
      if (result.updated) {
        setState.run('rotation_fingerprint', league.fingerprint);
        // Keep the long-term catalog close to real rotation changes, not just a daily batch.
        if (process.env.ITEMSHOP_API_KEY) void runHistoryCatalogSync('rotation-change');
      }
    }
  } catch (error) {
    console.error('[rotations] poll failed:', error.message);
  }
}

let historySyncInProgress = false;
async function runHistoryCatalogSync(reason = 'scheduled') {
  if (!process.env.ITEMSHOP_API_KEY) return { skipped: true, reason: 'ITEMSHOP_API_KEY is not configured' };
  if (historySyncInProgress) return { skipped: true, reason: 'history sync already in progress' };
  historySyncInProgress = true;
  try {
    const result = await syncHistoryCatalog(db, { apiKey: process.env.ITEMSHOP_API_KEY, delayMs: 200 });
    if (!result.skipped) {
      setState.run('history_catalog_synced_at', result.syncedAt);
      setState.run('history_catalog_error', '');
      console.log(`[history] ${reason}: imported ${result.newlyImportedDays} new days; catalog has ${result.catalogItems} items.`);
    }
    return result;
  } catch (error) {
    setState.run('history_catalog_error', error.message);
    console.error(`[history] ${reason} failed:`, error.message);
    return { skipped: false, error: error.message };
  } finally {
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
  const shop = db.prepare('SELECT fetched_at FROM current_shop WHERE singleton = 1').get();
  res.json({ ok: true, shopFetchedAt: shop?.fetched_at || null, serverTime: new Date().toISOString(), timezone: 'Asia/Seoul' });
});

app.get('/api/shop/today', (req, res) => {
  const row = db.prepare('SELECT fetched_at, payload_json FROM current_shop WHERE singleton = 1').get();
  if (!row) return res.status(503).json({ error: '아직 상점 데이터를 받지 못했습니다. 잠시 후 다시 시도해 주세요.' });
  res.json({ fetchedAt: row.fetched_at, shop: JSON.parse(row.payload_json) });
});

app.get('/api/catalog', (req, res) => {
  const rows = db.prepare("SELECT item_json, active, first_seen, last_seen FROM catalog_items ORDER BY json_extract(item_json, '$.name') COLLATE NOCASE").all();
  const items = rows.map(row => ({ ...JSON.parse(row.item_json), active: Boolean(row.active), firstSeen: row.first_seen, lastSeen: row.last_seen }));
  const historyStats = db.prepare(`SELECT COUNT(*) AS dayCount, MIN(shop_date) AS fromDate, MAX(shop_date) AS toDate FROM history_days`).get();
  const note = historyStats.dayCount > 0
    ? `itemshop.gg가 기록한 ${historyStats.dayCount}개 상점 변경일(${historyStats.fromDate} ~ ${historyStats.toDate})의 신화 상점 상품을 합친 목록입니다. 현재 판매/판매 예정 상품도 포함합니다. 기록 시작 이전의 역대 상품은 포함되지 않을 수 있습니다.`
    : (process.env.ITEMSHOP_API_KEY
      ? '과거 상점 이력 동기화를 준비 중입니다. 잠시 후 새로고침하거나 서버 로그를 확인해 주세요.'
      : '현재 판매 및 판매 예정 상품만 수집된 상태입니다. 과거 전체 기록을 추가하려면 서버에 ITEMSHOP_API_KEY를 설정하고 history 동기화를 실행하세요.');
  res.json({
    items,
    count: items.length,
    history: {
      apiKeyConfigured: Boolean(process.env.ITEMSHOP_API_KEY),
      importedDays: historyStats.dayCount,
      fromDate: historyStats.fromDate,
      throughDate: historyStats.toDate,
      lastSyncedAt: stateValue('history_catalog_synced_at'),
      lastError: stateValue('history_catalog_error')
    },
    catalogNote: note
  });
});

app.get('/api/preferences/:deviceId', (req, res) => {
  if (!validDeviceId(req.params.deviceId)) return res.status(400).json({ error: '잘못된 기기 식별자입니다.' });
  const row = db.prepare('SELECT favorites_json FROM devices WHERE device_id = ?').get(req.params.deviceId);
  res.json({ favorites: row ? JSON.parse(row.favorites_json) : [], hasPreferences: Boolean(row) });
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
  res.json({ ok: true });
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

const server = app.listen(PORT, async () => {
  console.log(`Mythic Shop Alert listening on http://localhost:${PORT}`);
  // One initial fetch establishes the first baseline without sending a push.
  const existing = db.prepare('SELECT singleton FROM current_shop WHERE singleton = 1').get();
  const result = await syncShop({ reason: 'startup', notify: Boolean(existing) });
  if (result.updated) {
    try {
      const rotations = await getJson(API_ROTATIONS);
      const fingerprint = rotations.data?.['league-of-legends']?.fingerprint;
      if (fingerprint) setState.run('rotation_fingerprint', fingerprint);
    } catch (error) { console.error('[rotations] initial read failed:', error.message); }
  }
  // itemshop.gg recommends checking rotations once a minute; fetch the full shop only on fingerprint changes.
  setInterval(pollRotations, 60 * 1000).unref();
  // Keep a daily KST snapshot at 00:05, even when there was no rotation that day.
  cron.schedule('5 0 * * *', () => syncShop({ reason: 'daily-kst-snapshot', notify: true }), { timezone: 'Asia/Seoul' });

  // Import any newly recorded historical rotations at startup and once daily.
  if (process.env.ITEMSHOP_API_KEY) {
    setTimeout(() => runHistoryCatalogSync('startup-backfill'), 2500).unref();
    cron.schedule('20 0 * * *', () => runHistoryCatalogSync('daily-history-backfill'), { timezone: 'Asia/Seoul' });
  }
});

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
