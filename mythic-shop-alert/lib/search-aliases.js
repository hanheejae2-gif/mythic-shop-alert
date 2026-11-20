'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CDRAGON_BASE = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/ko_kr/v1/';
const CDRAGON_FILES = {
  skins: 'skins.json',
  emotes: 'summoner-emotes.json',
  icons: 'summoner-icons.json',
  wards: 'ward-skins.json'
};

// Korean names for chroma labels and a few catalogue-only names not represented
// as standalone records in CommunityDragon's localized item tables.
const ENGLISH_TO_KOREAN = [
  ['Crime City Nightmare', '범죄 도시 악몽'],
  ['Battle Academia', '전투사관학교'],
  ['Battle Bunny', '전투 토끼'],
  ['Battle Boss', '전투 보스'],
  ['Dark Cosmic', '암흑 우주'],
  ['Dark Star', '암흑의 별'],
  ['Dawnbringer', '빛의 인도자'],
  ['Elderwood', '나무정령'],
  ['Faerie Court', '요정 왕국'],
  ['Lunar Empress', '달의 여제'],
  ['Lunar Wraith', '달의 유령'],
  ['Mecha Kingdoms', '메카 삼국'],
  ['Music Fan', '음악 팬'],
  ['Spirit Blossom', '영혼의 꽃'],
  ['Star Guardian', '별 수호자'],
  ['True Damage', '트루 데미지'],
  ['K/DA ALL OUT', 'K/DA 올 아웃'],
  ['K/DA', 'K/DA'],
  ['High Noon', '하이 눈'],
  ['La Ilusión', '환상'],
  ['Porcelain', '도자기'],
  ['Prestige', '프레스티지'],
  ['PROJECT', '프로젝트'],
  ['Pulsefire', '펄스 건'],
  ['Snow Day', '눈싸움'],
  ['Astronaut', '우주비행사'],
  ['Challenger', '도전자'],
  ['Empyrean', '창공'],
  ['HEARTSTEEL', '하트스틸'],
  ['Heavenscale', '천상비늘'],
  ['Odyssey', '오디세이'],
  ['Ruined', '몰락한'],
  ['Zombie', '좀비'],
  ['Chrono', '크로노'],
  ['Rebelguard', '반역 수호자'],
  ['Golden Tiger', '황금 호랑이'],
  ['Golden', '황금'],
  ['Underground', '지하'],
  ['Antimatter', '반물질'],
  ['Quasar', '퀘이사'],
  ['Lifebringer', '생명력 인도자'],
  ['Emberwood', '불씨 나무정령'],
  ['Neon Flare', '네온 플레어'],
  ['Winsome', '사랑스러운'],
  ['Rockstar', '록스타'],
  ['Lustrous', '찬란한'],
  ['Nomad', '유목민'],
  ['Noonday', '한낮'],
  ['BADDEST', '배디스트'],
  ['Vivida', '비비다'],
  ['Resplendent', '찬란한'],
  ['Peacekeeper', '평화 수호자'],
  ['FIRESTARTER', '점화'],
  ['Merc', '용병'],
  ['Opulent', '화려한'],
  ['Stellar', '별빛'],
  ['Vivid', '선명한'],
  ['Reckoning', '심판'],
  ['K.O.', 'K.O.'],
  ['Classic Baron', '클래식 바론'],
  ['Light the Match', '불을 밝혀'],
  ['Time For Triumph', '승리의 순간'],
  ['Know My Name', '내 이름을 알아봐']
];

const CATEGORY_TERMS = {
  skin: ['스킨', '신화 정수 스킨'],
  chroma: ['크로마', '색상 변형'],
  emote: ['감정표현', '이모트'],
  icon: ['소환사 아이콘', '아이콘'],
  ward: ['와드', '와드 스킨'],
  other: ['기타 상품', '신화 정수 상품']
};

function normalizeKey(value) {
  return String(value || '').toLocaleLowerCase('en-US').replace(/[^a-z0-9]/g, '');
}

function localizedChampion(type, championAliases) {
  const normalized = normalizeKey(type);
  if (!normalized) return '';
  if (normalized === 'aurelionsol') return championAliases.AurelionSol || '아우렐리온 솔';
  if (normalized === 'chogath') return championAliases.Chogath || '초가스';
  if (normalized === 'jarvaniv') return championAliases.JarvanIV || '자르반 4세';
  if (normalized === 'kaisa') return championAliases.Kaisa || '카이사';
  if (normalized === 'ksante') return championAliases.KSante || '크산테';
  if (normalized === 'khazix') return championAliases.Khazix || '카직스';
  if (normalized === 'kogmaw') return championAliases.KogMaw || '코그모';
  if (normalized === 'leesin') return championAliases.LeeSin || '리 신';
  if (normalized === 'masteryi') return championAliases.MasterYi || '마스터 이';
  if (normalized === 'missfortune') return championAliases.MissFortune || '미스 포츈';
  if (normalized === 'renataglasc') return championAliases.Renata || '레나타 글라스크';
  if (normalized === 'twistedfate') return championAliases.TwistedFate || '트위스티드 페이트';
  if (normalized === 'wukong' || normalized === 'monkeyking') return championAliases.MonkeyKing || '오공';
  if (normalized === 'xinzhao') return championAliases.XinZhao || '신 짜오';
  const match = Object.entries(championAliases).find(([name]) => normalizeKey(name) === normalized);
  return match?.[1] || '';
}

function translateCatalogueName(name) {
  let result = String(name || '');
  for (const [english, korean] of [...ENGLISH_TO_KOREAN].sort((a, b) => b[0].length - a[0].length)) {
    const escaped = english.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'gi'), korean);
  }
  return result.replace(/\s+/g, ' ').trim();
}

// CommunityDragon's localized JSON contains literal newlines in some free-text
// fields and non-standard backslash escapes in asset paths. Normalize those
// without changing valid JSON escapes so names can still be parsed reliably.
function parseCommunityDragonJson(raw) {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (!inString) {
      output += char;
      if (char === '"') inString = true;
      continue;
    }
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === '"') {
      output += char;
      inString = false;
      continue;
    }
    if (char === '\\') {
      const next = raw[i + 1] || '';
      if ('"\\/bfnrtu'.includes(next)) {
        output += char;
        escaped = true;
      } else {
        output += '\\\\';
      }
      continue;
    }
    if (char === '\n') { output += '\\n'; continue; }
    if (char === '\r') { output += '\\r'; continue; }
    if (char === '\t') { output += '\\t'; continue; }
    output += char;
  }
  return JSON.parse(output);
}

async function fetchLocalizedData(fetchImpl = fetch) {
  const entries = await Promise.all(Object.entries(CDRAGON_FILES).map(async ([kind, filename]) => {
    const response = await fetchImpl(`${CDRAGON_BASE}${filename}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mythic-Shop-Alert/1.5.3' },
      signal: AbortSignal.timeout(45_000)
    });
    if (!response.ok) throw new Error(`CommunityDragon ${filename} HTTP ${response.status}`);
    const parsed = parseCommunityDragonJson(await response.text());
    return [kind, parsed];
  }));
  return Object.fromEntries(entries);
}

function recordsToMap(records) {
  return new Map(records.map(record => [String(record.id), record]));
}

function getItemIdentity(item) {
  const raw = String(item.itemKey || item.key || item.id || '');
  const match = raw.match(/(?:^|:)(skin|chroma|emote|icon|ward):(\d+)$/i);
  if (!match) return { key: item.key || raw, type: 'other', id: '' };
  return { key: item.key || item.itemKey || raw, type: match[1].toLowerCase(), id: match[2] };
}

function makeLocalizedSearchAliases(items, localeData, championAliases = {}, fallbackSkinAliases = {}) {
  const skinMap = new Map(Object.values(localeData.skins || {}).map(record => [String(record.id), record]));
  const emoteMap = recordsToMap(localeData.emotes || []);
  const iconMap = recordsToMap(localeData.icons || []);
  const wardMap = recordsToMap(localeData.wards || []);
  const aliases = {};
  const baseSkinNames = new Map();
  for (const item of items) {
    const identity = getItemIdentity(item);
    if (identity.type !== 'skin') continue;
    const record = skinMap.get(identity.id);
    const legacy = fallbackSkinAliases[identity.id];
    const localized = record?.name || legacy?.name || '';
    if (localized && /[가-힣]/.test(localized)) baseSkinNames.set(String(item.name || '').toLocaleLowerCase('en-US').trim(), localized);
  }
  let localizedCount = 0;
  let cdragonCount = 0;
  let generatedChromaCount = 0;
  const unmatched = [];

  for (const item of items) {
    const { key, type, id } = getItemIdentity(item);
    const numericId = id || String(item.id || '').split(':').pop();
    let record = null;
    if (type === 'skin' || type === 'chroma') record = skinMap.get(numericId) || null;
    else if (type === 'emote') record = emoteMap.get(numericId) || null;
    else if (type === 'icon') record = iconMap.get(numericId) || null;
    else if (type === 'ward') record = wardMap.get(numericId) || null;

    const description = (record?.description || (Array.isArray(record?.descriptions)
      ? record.descriptions.map(entry => entry.description).filter(Boolean).join(' ')
      : '')).slice(0, 220);
    let localizedName = record?.name || record?.title || '';
    let source = record ? 'communitydragon-ko_KR' : 'generated-ko-alias';
    if (!localizedName && fallbackSkinAliases[numericId]?.name) {
      localizedName = fallbackSkinAliases[numericId].name;
      source = 'legacy-datadragon-alias';
    }

    const champ = localizedChampion(item.type, championAliases);
    if (!localizedName || !/[가-힣]/.test(localizedName)) {
      const rawName = String(item.name || '');
      if (type === 'chroma') {
        const baseName = rawName.replace(/\s+\([^()]*\)\s*$/, '').toLocaleLowerCase('en-US').trim();
        const baseLocalized = baseSkinNames.get(baseName);
        const variantMatch = rawName.match(/\(([^()]*)\)\s*$/);
        if (baseLocalized && variantMatch) {
          localizedName = `${baseLocalized} (${translateCatalogueName(variantMatch[1])})`;
        }
      }
      if (!localizedName || !/[가-힣]/.test(localizedName)) {
        let translationInput = rawName;
        const englishChampion = String(item.type || '');
        if (champ && englishChampion) {
          const escapedChampion = englishChampion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          translationInput = translationInput.replace(new RegExp(`\\s+${escapedChampion}(?=\\s*(?:\\([^)]*\\))?$)`, 'i'), '');
        }
        localizedName = translateCatalogueName(translationInput);
      }
      if (champ && !localizedName.includes(champ)) {
        const variantMatch = rawName.match(/\(([^()]*)\)\s*$/);
        if (variantMatch && type === 'chroma') {
          localizedName = `${localizedName.replace(/\s*\([^()]*\)\s*$/, '')} ${champ} (${translateCatalogueName(variantMatch[1])})`.trim();
        } else {
          localizedName = `${localizedName} ${champ}`.trim();
        }
      }
      if (type === 'chroma') generatedChromaCount += 1;
    }
    if (/[가-힣]/.test(localizedName)) localizedCount += 1;
    if (record) cdragonCount += 1;
    if (!/[가-힣]/.test(localizedName)) unmatched.push({ key, name: item.name || '', type });

    const categoryTerms = CATEGORY_TERMS[type] || CATEGORY_TERMS.other;
    const searchValues = [
      localizedName,
      champ,
      description,
      ...(categoryTerms || []),
      type === 'skin' ? '신화 신화급 프레스티지 마법공학' : '',
      item.name || '',
      item.type || ''
    ].filter(Boolean);
    aliases[key] = {
      name: localizedName || item.name || '',
      aliases: [...new Set(searchValues)],
      description: description || '',
      source
    };
  }

  return {
    schemaVersion: 1,
    locale: 'ko_KR',
    source: 'CommunityDragon ko_KR + Riot/Data Dragon champion aliases',
    updatedAt: new Date().toISOString(),
    itemCount: items.length,
    localizedCount,
    communityDragonCount: cdragonCount,
    generatedChromaCount,
    unmatchedCount: unmatched.length,
    unmatched,
    aliases
  };
}

async function syncLocalizedSearchAliases(db, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const root = options.root || path.resolve(__dirname, '..');
  const championFile = path.join(root, 'public', 'champion-aliases-ko.json');
  const fallbackFile = path.join(root, 'public', 'skin-aliases-ko.json');
  const championAliases = JSON.parse(fs.readFileSync(championFile, 'utf8'));
  const fallbackPayload = JSON.parse(fs.readFileSync(fallbackFile, 'utf8'));
  const fallbackSkinAliases = fallbackPayload.items || fallbackPayload;
  const rows = db.prepare('SELECT item_key, item_json FROM master_pool_items').all();
  const items = rows.map(row => {
    const parsed = JSON.parse(row.item_json);
    return { ...parsed, key: parsed.key || parsed.itemKey || row.item_key, itemKey: parsed.itemKey || row.item_key };
  });
  const localeData = await fetchLocalizedData(fetchImpl);
  const payload = makeLocalizedSearchAliases(items, localeData, championAliases, fallbackSkinAliases);
  return payload;
}

module.exports = {
  CDRAGON_BASE,
  parseCommunityDragonJson,
  makeLocalizedSearchAliases,
  syncLocalizedSearchAliases,
  translateCatalogueName
};
