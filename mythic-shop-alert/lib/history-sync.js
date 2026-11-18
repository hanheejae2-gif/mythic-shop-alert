'use strict';

const BASE_URL = 'https://itemshop.gg/api/v1';
const GAME = 'league-of-legends';
const USER_AGENT = 'Mythic-Shop-Alert/1.1 (+self-hosted PWA)';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function ensureHistoryTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_items (
      item_key TEXT PRIMARY KEY,
      item_json TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS history_days (
      shop_date TEXT PRIMARY KEY,
      source_shop_date TEXT,
      exact INTEGER NOT NULL DEFAULT 1,
      imported_at TEXT NOT NULL,
      item_count INTEGER NOT NULL DEFAULT 0
    );
  `);
}

async function getJson(url, apiKey, maxRetries = 4) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': USER_AGENT
      },
      signal: AbortSignal.timeout(30000)
    });

    if (response.status === 429) {
      if (attempt === maxRetries) throw new Error(`itemshop.gg 요청 제한(429): 재시도 한도 초과`);
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 3000 * (attempt + 1);
      console.warn(`[history] rate limited; retrying in ${Math.ceil(waitMs / 1000)}s`);
      await sleep(waitMs + 150);
      continue;
    }

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const code = body?.error?.code || response.status;
      const message = body?.error?.message || response.statusText;
      throw new Error(`itemshop.gg ${code}: ${message}`);
    }
    if (!body || !Object.prototype.hasOwnProperty.call(body, 'data')) {
      throw new Error(`itemshop.gg 응답 형식 오류: ${url}`);
    }
    return body;
  }
  throw new Error('API 요청 재시도 한도 초과');
}

function mergeHistoryItem(db, item, sectionTitle, shopDate, exact, importedAt) {
  // itemKey가 없는 예외 목록도 카탈로그에 표시하되, 안정적인 즐겨찾기/알림 추적은 비활성화합니다.
  const stableKey = item.itemKey || item.id;
  if (!stableKey) return false;

  const prior = db.prepare('SELECT item_json, first_seen, active FROM catalog_items WHERE item_key = ?').get(stableKey);
  let old = {};
  if (prior) {
    try { old = JSON.parse(prior.item_json); } catch { old = {}; }
  }

  const availability = item.availability || {};
  const eventStart = availability.from || null;
  const eventEnd = availability.until || null;
  const upcoming = false; // 과거 스냅샷은 판매 이력으로만 적재합니다.
  const salesHistory = Array.isArray(old.salesHistory) ? [...old.salesHistory] : [];

  if (!upcoming) {
    // 동일한 판매 기간이 여러 상점 스냅샷에 반복되어도 한 번의 판매 체류로 집계합니다.
    const periodKey = `${eventStart || shopDate}|${eventEnd || 'open'}|${sectionTitle}`;
    const existingIndex = salesHistory.findIndex(entry => entry.periodKey === periodKey);
    const event = {
      periodKey,
      shopDate,
      sectionTitle,
      start: eventStart,
      end: eventEnd,
      price: item.price?.amount ?? null,
      currency: item.price?.currency ?? null,
      exact: Boolean(exact)
    };
    if (existingIndex >= 0) salesHistory[existingIndex] = { ...salesHistory[existingIndex], ...event };
    else salesHistory.push(event);
  }

  const firstSeenDate = [old.firstSeenDate, shopDate].filter(Boolean).sort()[0] || shopDate;
  const lastSeenDate = [old.lastSeenDate, shopDate].filter(Boolean).sort().slice(-1)[0] || shopDate;
  const sections = [...new Set([...(old.sections || []), sectionTitle])];
  // Keep a currently active row's fresher live-shop fields while adding the historical stay data.
  const sourceFields = prior?.active ? { ...item, ...old } : { ...old, ...item };

  const bestFields = prior?.active ? old : item;
  const merged = {
    ...sourceFields,
    key: stableKey,
    id: bestFields.id || item.id || old.id || null,
    itemKey: item.itemKey || old.itemKey || null,
    name: bestFields.name || item.name || old.name || '이름 없는 상품',
    type: bestFields.type || item.type || old.type || '기타',
    rarity: bestFields.rarity ?? item.rarity ?? old.rarity ?? null,
    price: bestFields.price ?? item.price ?? old.price ?? null,
    images: bestFields.images ?? item.images ?? old.images ?? { card: null, render: null },
    availability: bestFields.availability ?? item.availability ?? old.availability ?? { from: null, until: null },
    soldOut: prior?.active ? Boolean(old.soldOut) : Boolean(item.soldOut),
    sectionTitle,
    sections,
    upcoming: false,
    isUpcoming: false,
    trackable: Boolean(item.itemKey),
    salesHistory,
    historyCount: salesHistory.length,
    firstSeenDate,
    lastSeenDate,
    lastHistoryDate: lastSeenDate
  };

  db.prepare(`INSERT INTO catalog_items(item_key, item_json, first_seen, last_seen, active)
    VALUES(?, ?, ?, ?, 0)
    ON CONFLICT(item_key) DO UPDATE SET
      item_json = excluded.item_json,
      last_seen = excluded.last_seen`).run(
        stableKey,
        JSON.stringify(merged),
        prior?.first_seen || `${firstSeenDate}T00:00:00.000Z`,
        importedAt
      );
  return true;
}

/**
 * Imports all recorded LoL shop-change snapshots and builds a deduplicated
 * Mythic Shop catalog. The history endpoint only contains records itemshop.gg
 * has collected; it is not a complete all-time Riot archive.
 */
async function syncHistoryCatalog(db, options = {}) {
  const apiKey = options.apiKey || process.env.ITEMSHOP_API_KEY || '';
  if (!apiKey) return { skipped: true, reason: 'ITEMSHOP_API_KEY가 설정되지 않았습니다.' };

  ensureHistoryTables(db);
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : 200;
  const listUrl = `${BASE_URL}/history/${GAME}`;
  const historyList = await getJson(listUrl, apiKey);
  const dates = Array.isArray(historyList.data) ? [...new Set(historyList.data)] : null;
  if (!dates) throw new Error('history API의 data가 날짜 배열이 아닙니다.');

  const alreadyImported = new Set(db.prepare('SELECT shop_date FROM history_days').all().map(row => row.shop_date));
  const pending = dates.filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date) && !alreadyImported.has(date)).sort();
  const insertDay = db.prepare(`INSERT OR REPLACE INTO history_days(shop_date, source_shop_date, exact, imported_at, item_count)
    VALUES(?, ?, ?, ?, ?)`);

  let importedDays = 0;
  let importedItems = 0;
  const errors = [];

  for (const date of pending) {
    const response = await getJson(`${BASE_URL}/history/${GAME}/${date}`, apiKey);
    const envelope = response.data || {};
    const shop = envelope.shop;
    if (!shop || !Array.isArray(shop.sections)) {
      throw new Error(`${date} 응답에서 data.shop.sections를 찾지 못했습니다.`);
    }

    const sourceShopDate = envelope.shopDate || shop.shopDate || date;
    const exact = envelope.exact !== false;
    const now = new Date().toISOString();
    let count = 0;
    const transaction = db.transaction(() => {
      for (const section of shop.sections) {
        if (!/^mythic shop:/i.test(section.title || '')) continue;
        // Historical upcoming sections are not treated as sold. Only actual shop entries build salesHistory.
        if (section.upcoming) continue;
        for (const item of section.items || []) {
          if (item.soldOut) continue;
          if (mergeHistoryItem(db, item, section.title, sourceShopDate, exact, now)) count += 1;
        }
      }
      insertDay.run(date, sourceShopDate, exact ? 1 : 0, now, count);
    });
    transaction();

    importedDays += 1;
    importedItems += count;
    console.log(`[history] ${date}: ${count} Mythic Shop item entries imported.`);
    await sleep(delayMs);
  }

  const stats = db.prepare(`SELECT COUNT(*) AS itemCount FROM catalog_items`).get();
  const dayStats = db.prepare(`SELECT COUNT(*) AS dayCount, MIN(shop_date) AS fromDate, MAX(shop_date) AS toDate FROM history_days`).get();
  const syncAt = new Date().toISOString();
  return {
    skipped: false,
    availableHistoryDays: dates.length,
    newlyImportedDays: importedDays,
    itemEntriesProcessed: importedItems,
    catalogItems: stats.itemCount,
    importedDays: dayStats.dayCount,
    historyFrom: dayStats.fromDate,
    historyThrough: dayStats.toDate,
    syncedAt: syncAt,
    errors
  };
}

module.exports = { ensureHistoryTables, syncHistoryCatalog };
