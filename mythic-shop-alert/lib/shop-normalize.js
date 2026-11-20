'use strict';

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

function normalizeShop(apiPayload, now = new Date()) {
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
  for (const item of [...upcomingItems, ...currentItems]) catalogMap.set(item.key, item);

  return {
    game: source.game || 'league-of-legends',
    shopDate: source.shopDate || null,
    updatedAt: source.updatedAt || null,
    expiresAt: source.expiresAt || null,
    stale: Boolean(source.stale),
    fetchedAt: apiPayload.meta?.generatedAt || now.toISOString(),
    localDate: kstDate(now),
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

module.exports = { toNormalItem, normalizeShop };
