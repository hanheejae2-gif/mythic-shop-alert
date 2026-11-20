'use strict';

const { upsertMasterPoolItem } = require('./master-pool');
const { parseCommunityDragonJson } = require('./search-aliases');

const CDRAGON_ICON_DATA_URL =
  'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/ko_kr/v1/summoner-icons.json';
const CDRAGON_IMAGE_ROOT =
  'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/ko_kr';

// CommunityDragon's Riot rarity code 4 maps to Mythic; IDs 7350 and 7352
// were cross-checked against the current Mythic Shop icon records.
const MYTHIC_ICON_RARITY = 4;
const MYTHIC_COLOR = '#b98a36';

function isRiotMythicIcon(record) {
  return Array.isArray(record?.rarities) && record.rarities.some(entry =>
    String(entry.region || '').toLowerCase() === 'riot' &&
    Number(entry.rarity) === MYTHIC_ICON_RARITY
  );
}

function toMasterPoolIcon(record) {
  if (!Number.isInteger(Number(record?.id)) || !record.title) return null;
  const id = String(record.id);
  const key = `lol:item:icon:${id}`;
  const imagePath = typeof record.imagePath === 'string' ? record.imagePath : '';
  const imageUrl = imagePath.startsWith('/')
    ? `${CDRAGON_IMAGE_ROOT}${imagePath}`
    : `${CDRAGON_IMAGE_ROOT}/lol-game-data/assets/v1/profile-icons/${id}.jpg`;

  return {
    key,
    id: `item:icon:${id}`,
    itemKey: key,
    name: record.title,
    type: 'Summoner icon',
    rarity: { name: 'Mythic', color: MYTHIC_COLOR },
    price: null,
    images: { card: imageUrl, render: imageUrl },
    availability: { from: null, until: null },
    soldOut: false,
    sectionTitle: 'Master Pool · Mythic 희귀도 아이콘 후보',
    sections: [],
    upcoming: false,
    isUpcoming: false,
    trackable: true,
    salesHistory: [],
    historyCount: 0,
    firstSeenDate: null,
    lastSeenDate: null,
    masterPool: {
      eligibilityStatus: 'candidate',
      source: 'CommunityDragon ko_KR summoner-icons · Riot rarity=4',
      sourceNote: 'CommunityDragon 한국어 소환사 아이콘 데이터에서 Riot rarity=4(Mythic)로 분류된 아이콘입니다. 희귀도 후보이며 실제 신화 정수 상점 판매는 API/판매 이력에서 관측되기 전까지 확정하지 않습니다.',
      yearReleased: record.yearReleased ?? null,
      legacy: Boolean(record.isLegacy)
    }
  };
}

async function syncMythicIconCandidates(db, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(CDRAGON_ICON_DATA_URL, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mythic-Shop-Alert/1.5.3 (+self-hosted PWA)'
    },
    signal: AbortSignal.timeout(options.timeoutMs || 45_000)
  });
  if (!response.ok) throw new Error(`CommunityDragon summoner-icons.json HTTP ${response.status}`);

  const records = parseCommunityDragonJson(await response.text());
  if (!Array.isArray(records)) throw new Error('CommunityDragon summoner-icons.json 응답이 배열이 아닙니다.');

  const candidates = records.filter(isRiotMythicIcon).map(toMasterPoolIcon).filter(Boolean);
  if (!candidates.length) throw new Error('CommunityDragon에서 Mythic 소환사 아이콘 후보를 찾지 못했습니다.');

  const now = options.now || new Date().toISOString();
  let inserted = 0;
  let alreadyPresent = 0;
  const transaction = db.transaction(() => {
    for (const item of candidates) {
      const existed = Boolean(db.prepare('SELECT 1 AS found FROM master_pool_items WHERE item_key = ?').get(item.key));
      const ok = upsertMasterPoolItem(db, item, {
        eligibilityStatus: 'candidate',
        source: item.masterPool.source,
        sourceNote: item.masterPool.sourceNote,
        now
      });
      if (!ok) continue;
      if (existed) alreadyPresent += 1;
      else inserted += 1;
    }
  });
  transaction();

  return {
    discovered: candidates.length,
    imported: inserted + alreadyPresent,
    inserted,
    alreadyPresent,
    source: CDRAGON_ICON_DATA_URL
  };
}

module.exports = {
  CDRAGON_ICON_DATA_URL,
  isRiotMythicIcon,
  toMasterPoolIcon,
  syncMythicIconCandidates
};
