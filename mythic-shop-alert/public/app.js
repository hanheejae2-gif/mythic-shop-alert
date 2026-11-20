'use strict';

const API = '';
const $ = selector => document.querySelector(selector);
const state = {
  deviceId: getDeviceId(),
  favorites: new Set(),
  catalog: [],
  shop: null,
  config: null,
  pushEnabled: false,
  tab: new URLSearchParams(location.search).get('tab') === 'today' ? 'today' : 'favorites',
  starredOnly: false,
  serviceWorker: null,
  toastTimer: null,
  championAliases: {},
  skinAliases: {},
  itemAliases: {}
};
let historyCatalogPollTimer = null;
let shopAutoRefreshTimer = null;
let shopRefreshInProgress = false;

function getDeviceId() {
  try {
    let id = localStorage.getItem('msa-device-id');
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/-/g, '');
      localStorage.setItem('msa-device-id', id);
    }
    return id;
  } catch {
    return `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('visible'), 2800);
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    cache: options.cache || 'no-store',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `요청 실패 (${response.status})`);
  return payload;
}

function categoryOf(item) {
  const prefix = (item.id || '').split(':')[1];
  if (prefix === 'skin') return 'skin';
  if (prefix === 'chroma') return 'chroma';
  if (prefix === 'emote') return 'emote';
  if (prefix === 'icon') return 'icon';
  if (prefix === 'ward') return 'ward';
  const text = `${item.type || ''} ${item.name || ''}`.toLowerCase();
  if (text.includes('chroma') || text.includes('크로마')) return 'chroma';
  if (text.includes('emote') || text.includes('감정표현')) return 'emote';
  if (text.includes('icon') || text.includes('아이콘')) return 'icon';
  if (text.includes('ward') || text.includes('와드')) return 'ward';
  if (item.rarity?.name === 'Mythic' || text.includes('skin')) return 'skin';
  return 'other';
}

function categoryLabel(item) {
  return ({ skin: '스킨', chroma: '크로마', emote: '감정표현', icon: '소환사 아이콘', ward: '와드 스킨', other: '기타' })[categoryOf(item)];
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function priceText(item) {
  const price = item.price;
  if (!price || price.amount == null) return price?.label || '가격 정보 없음';
  const currency = price.currency === 'Mythic Essence' ? 'ME' : (price.currency || '');
  return `${Number(price.amount).toLocaleString('ko-KR')} ${currency}`.trim();
}

function formatDateTime(value) {
  if (!value) return '일정 정보 없음';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '일정 정보 없음';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date);
}

function itemCard(item, context = 'catalog') {
  const isFavorite = state.favorites.has(item.key);
  const image = item.images?.card || item.images?.render;
  const numericId = String(item.id || item.key || '').split(':').pop();
  const localizedAlias = state.itemAliases[item.key] || state.itemAliases[item.itemKey];
  const displayName = (localizedAlias && localizedAlias.source !== 'generated-ko-alias' ? localizedAlias.name : '') || state.skinAliases[numericId]?.name || item.name;
  const displayType = championAlias(item.type) || item.type || '상품';
  const rarity = item.rarity?.name ? `<span class="item-rarity">${escapeHtml(item.rarity.name)}</span>` : '';
  const historyCount = Array.isArray(item.salesHistory) ? item.salesHistory.length : Number(item.historyCount || 0);
  const dateLabel = item.lastSeenDate ? ` · 최근 기록 ${escapeHtml(item.lastSeenDate)}` : '';
  const poolStatus = item.masterPool?.eligibilityStatus || 'confirmed';
  const catalogState = item.active ? '현재 판매 중' : (item.isUpcoming || item.upcoming ? '판매 예정' : (historyCount ? `역대 판매 기록 ${historyCount}회` : (poolStatus === 'candidate' ? '판매 후보 · 이력 미확인' : '상점 기록 상품')));
  const meta = context === 'today'
    ? `판매 종료 ${escapeHtml(formatDateTime(item.availability?.until))}`
    : `${escapeHtml(displayType)} · ${catalogState}${dateLabel}`;
  return `
    <article class="item-card">
      <div class="item-art">${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(displayName)}" loading="lazy" onerror="this.remove()">` : '✦'}</div>
      <div class="item-info">
        <div class="item-topline"><span class="item-category">${escapeHtml(categoryLabel(item))}</span>${rarity}</div>
        <h3 class="item-name">${escapeHtml(displayName)}</h3>
        <div class="item-meta">${meta}</div>
        <div class="item-price"><span class="me-gem">✧</span>${escapeHtml(priceText(item))}</div>
      </div>
      <button class="star-button ${isFavorite ? 'selected' : ''}" data-star-key="${escapeHtml(item.key)}" type="button"
        aria-label="${isFavorite ? '즐겨찾기 해제' : '즐겨찾기 추가'}: ${escapeHtml(item.name)}"
        aria-pressed="${isFavorite}" ${item.trackable === false ? 'disabled title="안정적인 상품 식별자가 없어 알림 추적을 지원하지 않습니다."' : ''}>${isFavorite ? '★' : '☆'}</button>
    </article>`;
}

function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('ko-KR')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function compactSearchText(value) {
  return normalizeSearchText(value).replace(/\s+/g, '');
}

function championAlias(type) {
  const normalized = compactSearchText(type);
  if (!normalized) return '';
  const overrides = {
    'jarvaniv': '자르반 4세',
    'kaisa': '카이사',
    'kogmaw': '코그모',
    'ksante': '크산테',
    'renataglasc': '레나타 글라스크',
    'masteryi': '마스터 이',
    'leesin': '리 신',
    'xinzhao': '신 짜오',
    'twistedfate': '트위스티드 페이트',
    'wukong': '오공',
    'monkeyking': '오공',
    'chogath': '초가스',
    'velkoz': '벨코즈',
    'reksai': '렉사이',
    'aurelionsol': '아우렐리온 솔',
    'nunuandwillump': '누누와 윌럼프',
    'missfortune': '미스 포츈'
  };
  return overrides[normalized] || state.championAliases[normalized] || '';
}

const KOREAN_NAME_ALIASES = [
  ['prestige', '프레스티지'],
  ['hextech', '마법공학'],
  ['ashen', '재의'],
  ['mythic', '신화 신화급'],
  ['dark cosmic', '암흑 우주'],
  ['star guardian', '별 수호자'],
  ['spirit blossom', '영혼의 꽃'],
  ['true damage', '트루 데미지'],
  ['winterblessed', '겨울의 축복'],
  ['battle academia', '전투사관학교'],
  ['mecha kingdoms', '메카 삼국'],
  ['k/da', 'kda 케이디에이'],
  ['emote', '감정표현'],
  ['chroma', '크로마'],
  ['ward', '와드'],
  ['icon', '아이콘']
];

function localizedItemAlias(item) {
  const rawId = String(item.id || item.key || '');
  const numericId = rawId.split(':').pop();
  const alias = state.itemAliases[item.key] || state.itemAliases[item.itemKey] || state.skinAliases[numericId];
  if (!alias) return '';
  if (typeof alias === 'string') return alias;
  return [alias.name, ...(alias.aliases || []), alias.description].filter(Boolean).join(' ');
}

function searchableItemText(item) {
  const values = [
    item.name,
    item.type,
    championAlias(item.type),
    localizedItemAlias(item),
    categoryLabel(item),
    categoryOf(item) === 'chroma' ? '크로마 색상 변형' : '',
    categoryOf(item) === 'emote' ? '감정표현 이모트' : '',
    categoryOf(item) === 'icon' ? '소환사 아이콘 아이콘' : '',
    categoryOf(item) === 'ward' ? '와드 와드스킨' : '',
    item.rarity?.name,
    item.rarity?.name === 'Mythic' ? '신화 신화급' : ''
  ];
  const englishName = String(item.name || '').toLocaleLowerCase('en-US');
  for (const [english, korean] of KOREAN_NAME_ALIASES) {
    if (englishName.includes(english)) values.push(korean);
  }
  return normalizeSearchText(values.filter(Boolean).join(' '));
}

function matchesSearch(item, query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;
  const itemText = searchableItemText(item);
  const itemCompact = compactSearchText(itemText);
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  return tokens.every(token => itemText.includes(token) || itemCompact.includes(token.replace(/\s+/g, '')));
}

function renderCatalog() {
  const query = $('#searchInput').value;
  const category = $('#categoryFilter').value;
  let items = state.catalog.filter(item => {
    return matchesSearch(item, query) && (category === 'all' || categoryOf(item) === category) &&
      (!state.starredOnly || state.favorites.has(item.key));
  });
  items.sort((a, b) => Number(state.favorites.has(b.key)) - Number(state.favorites.has(a.key)) || a.name.localeCompare(b.name));
  $('#resultCount').textContent = `${items.length}개 표시`;
  $('#catalogCount').textContent = `${state.catalog.length}개 상품`;
  $('#favoriteCount').textContent = state.favorites.size;
  if (!items.length) {
    $('#catalogList').innerHTML = `<div class="empty-state"><strong>${state.starredOnly ? '아직 즐겨찾기한 상품이 없어요.' : '검색 결과가 없어요.'}</strong>${state.starredOnly ? '상품 카드의 별표를 눌러 관심 상품을 추가하세요.' : '한국어 스킨명·챔피언명 또는 영문 상품명으로 검색해 보세요.'}</div>`;
  } else {
    $('#catalogList').innerHTML = items.map(item => itemCard(item)).join('');
  }
}

function sectionLabel(title) {
  const suffix = (title.split(':')[1] || '').trim().toLowerCase();
  return ({ featured: '주요 상품', biweekly: '2주 로테이션', weekly: '주간 상품', daily: '일일 상품' })[suffix] || title;
}

function renderToday() {
  if (!state.shop) return;
  $('#todayItemCount').textContent = `${state.shop.mythicItemCount}개 상품`;
  const sections = state.shop.sections || [];
  if (!sections.length) {
    $('#todaySections').innerHTML = '<div class="empty-state"><strong>현재 표시할 신화 정수 상품이 없어요.</strong>상점 데이터가 갱신됐는지 잠시 후 다시 확인해 주세요.</div>';
    return;
  }

  // Pin all currently available favourites into one section above the normal rotation groups.
  const favoriteMap = new Map();
  for (const section of sections) {
    for (const item of section.items || []) {
      if (state.favorites.has(item.key)) favoriteMap.set(item.key, item);
    }
  }
  const favoriteItems = [...favoriteMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  const favoriteKeys = new Set(favoriteItems.map(item => item.key));
  const favoriteSection = favoriteItems.length ? `
    <section class="section-block today-favorites-block">
      <div class="section-block-header"><h3>★ 즐겨찾기 상품</h3><span>${favoriteItems.length}개 입고</span></div>
      <div class="item-list">${favoriteItems.map(item => itemCard(item, 'today')).join('')}</div>
    </section>` : '';

  const regularSections = sections.map(section => ({
    ...section,
    items: (section.items || []).filter(item => !favoriteKeys.has(item.key))
  })).filter(section => section.items.length > 0);
  const regularMarkup = regularSections.map(section => `
    <section class="section-block">
      <div class="section-block-header"><h3>${escapeHtml(sectionLabel(section.title))}</h3><span>${section.items.length}개 상품</span></div>
      <div class="item-list">${section.items.map(item => itemCard(item, 'today')).join('')}</div>
    </section>`).join('');
  $('#todaySections').innerHTML = favoriteSection + regularMarkup || '<div class="empty-state"><strong>현재 표시할 상품이 없어요.</strong></div>';
}

function renderStatus() {
  if (!state.shop) return;
  $('#todayDate').textContent = state.shop.localDate || '오늘';
  $('#shopStatus').textContent = state.shop.stale ? '이전 데이터' : '최신 데이터';
  $('#shopStatus').classList.toggle('warn', Boolean(state.shop.stale));
  $('#lastUpdated').textContent = `API 확인 ${formatDateTime(state.shop.lastFetchedAt)}`;
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab-button').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  $('#favoritesPanel').classList.toggle('active', tab === 'favorites');
  $('#todayPanel').classList.toggle('active', tab === 'today');
  $('#favoritesPanel').hidden = tab !== 'favorites';
  $('#todayPanel').hidden = tab !== 'today';
  const url = new URL(location.href);
  if (tab === 'today') url.searchParams.set('tab', 'today'); else url.searchParams.delete('tab');
  history.replaceState({}, '', url);
}

async function saveFavorites() {
  const favorites = [...state.favorites];
  try { localStorage.setItem('msa-favorites', JSON.stringify(favorites)); } catch { /* server copy still works */ }
  renderCatalog();
  renderToday();
  try {
    await api(`/api/preferences/${encodeURIComponent(state.deviceId)}`, {
      method: 'PUT', body: JSON.stringify({ favorites })
    });
  } catch (error) { showToast(`기기 간 저장 실패: ${error.message}`); }
}

async function toggleFavorite(key) {
  const item = state.catalog.find(entry => entry.key === key) || state.shop?.items.find(entry => entry.key === key);
  if (item?.trackable === false) return showToast('이 상품은 안정적인 식별자가 없어 입고 알림을 설정할 수 없어요.');
  if (state.favorites.has(key)) state.favorites.delete(key); else state.favorites.add(key);
  await saveFavorites();
  showToast(state.favorites.has(key) ? '즐겨찾기에 추가했어요.' : '즐겨찾기에서 삭제했어요.');
}

function base64UrlToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(char => char.charCodeAt(0)));
}

function isIos() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }
function isStandalone() { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }

function setNotificationStateUI() {
  const button = $('#enableNotifications');
  button.disabled = false;
  button.classList.toggle('notification-enabled', state.pushEnabled);
  button.textContent = state.pushEnabled ? '알림 끄기' : '알림 켜기';
  $('#notificationTitle').textContent = state.pushEnabled
    ? '즐겨찾기 입고 알림이 켜져 있어요'
    : '즐겨찾기 입고 알림이 꺼져 있어요';
  $('#notificationDescription').textContent = state.pushEnabled
    ? '관심 상품이 새 로테이션에 등장하면 이 기기로 알림을 보내드려요. 버튼을 누르면 알림을 해제할 수 있어요.'
    : '알림을 켜면 즐겨찾기 상품이 새 로테이션에 등장할 때 이 기기로 알려드려요.';
}

async function setupPush() {
  const button = $('#enableNotifications');
  if (!('serviceWorker' in navigator)) {
    button.disabled = true;
    button.textContent = '푸시 미지원';
    $('#notificationDescription').textContent = '현재 브라우저에서는 서비스 워커를 지원하지 않아요.';
    return;
  }
  try {
    state.config = await api('/api/config');
    if (!state.config.notificationsEnabled) {
      state.pushEnabled = false;
      button.disabled = true;
      button.textContent = '서버 설정 필요';
      $('#notificationDescription').textContent = '서버 관리자가 VAPID 키를 설정하면 알림을 사용할 수 있어요.';
      return;
    }
    if (!('PushManager' in window) || !('Notification' in window)) {
      button.disabled = true;
      button.textContent = '푸시 미지원';
      $('#notificationDescription').textContent = '현재 브라우저에서는 웹 푸시를 지원하지 않아요. 최신 Chrome 또는 홈 화면 앱을 이용해 주세요.';
      return;
    }
    state.serviceWorker = await navigator.serviceWorker.register('/sw.js?v=1.5');
    await navigator.serviceWorker.ready;
    const [subscription, preferences] = await Promise.all([
      state.serviceWorker.pushManager.getSubscription(),
      api(`/api/preferences/${encodeURIComponent(state.deviceId)}`)
    ]);
    state.pushEnabled = Boolean(preferences.pushEnabled && subscription && Notification.permission === 'granted');
    if (preferences.pushEnabled && (!subscription || Notification.permission !== 'granted')) {
      // A browser-side subscription can disappear or permission can be revoked.
      await api(`/api/push/subscribe/${encodeURIComponent(state.deviceId)}`, { method: 'DELETE' });
      if (subscription) await subscription.unsubscribe().catch(() => false);
      state.pushEnabled = false;
    }
    if (isIos() && !isStandalone()) {
      button.textContent = state.pushEnabled ? '알림 끄기' : '설치 후 알림 켜기';
      $('#notificationDescription').textContent = 'iPhone은 Safari 공유 버튼 → 홈 화면에 추가 → 설치된 앱을 실행한 뒤 알림을 켜세요.';
      return;
    }
    setNotificationStateUI();
  } catch (error) {
    button.disabled = true;
    button.textContent = '알림 준비 실패';
    $('#notificationDescription').textContent = error.message;
  }
}

async function enablePush() {
  if (isIos() && !isStandalone()) {
    showToast('iPhone은 먼저 공유 메뉴에서 “홈 화면에 추가”를 해주세요.');
    $('#notificationDescription').textContent = 'iPhone: Safari 공유 버튼 → 홈 화면에 추가 → 추가된 앱을 실행한 뒤 알림을 켜세요.';
    return;
  }
  if (!state.config?.notificationsEnabled) return showToast('서버의 VAPID 설정이 필요해요.');
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      $('#notificationDescription').textContent = '브라우저의 사이트 알림 권한을 허용해야 알림을 받을 수 있어요.';
      return showToast('알림 권한이 허용되지 않았어요. 브라우저 설정을 확인해 주세요.');
    }
    const registration = state.serviceWorker || await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8Array(state.config.vapidPublicKey)
      });
    }
    await api('/api/push/subscribe', {
      method: 'POST', body: JSON.stringify({ deviceId: state.deviceId, subscription: subscription.toJSON() })
    });
    state.pushEnabled = true;
    setNotificationStateUI();
    showToast('이 기기의 입고 알림을 켰어요.');
  } catch (error) {
    showToast(`알림 등록 실패: ${error.message}`);
  }
}

async function disablePush() {
  try {
    // Delete the server-side endpoint first so no further pushes are sent to this device.
    await api(`/api/push/subscribe/${encodeURIComponent(state.deviceId)}`, { method: 'DELETE' });
    try {
      const registration = state.serviceWorker || await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();
    } catch (unsubscribeError) {
      console.warn('[push] browser unsubscribe warning:', unsubscribeError.message);
    }
    state.pushEnabled = false;
    setNotificationStateUI();
    showToast('이 기기의 즐겨찾기 입고 알림을 해제했어요.');
  } catch (error) {
    showToast(`알림 해제 실패: ${error.message}`);
  }
}

function stopHistoryCatalogPolling() {
  if (historyCatalogPollTimer) clearInterval(historyCatalogPollTimer);
  historyCatalogPollTimer = null;
}

function startHistoryCatalogPolling(historyInfo) {
  stopHistoryCatalogPolling();
  if (!historyInfo?.apiKeyConfigured) return;
  const needsFirstAttempt = !historyInfo.lastAttemptAt;
  const needsMoreHistory = Number(historyInfo.pendingDays || 0) > 0;
  if (!historyInfo.syncing && !needsFirstAttempt && !needsMoreHistory) return;
  let attempts = 0;
  historyCatalogPollTimer = setInterval(async () => {
    attempts += 1;
    try {
      const result = await api('/api/catalog');
      state.catalog = result.items || [];
      $('#catalogNote').textContent = result.catalogNote || '';
      renderCatalog();
      const info = result.history || {};
      const done = !info.syncing && Boolean(info.lastAttemptAt) && Number(info.pendingDays || 0) === 0;
      const failed = !info.syncing && Boolean(info.lastError);
      if (done || failed || attempts >= 90) {
        stopHistoryCatalogPolling();
        if (done) showToast(`역대 상품 ${state.catalog.length}개를 불러왔어요.`);
        if (failed) showToast('일부 역대 판매 기록을 가져오지 못했어요. 서버 로그를 확인해 주세요.');
      }
    } catch (error) {
      if (attempts >= 90) stopHistoryCatalogPolling();
    }
  }, 5000);
}

function shopContentSignature(shop) {
  return (shop?.items || []).map(item => item.key).sort().join('|');
}

async function refreshShopView({ notify = false, force = false } = {}) {
  if (shopRefreshInProgress) return { success: false, skipped: true, reason: 'already-refreshing' };
  if (!state.shop && !force) return { success: false, skipped: true, reason: 'shop-not-loaded' };
  shopRefreshInProgress = true;
  const oldSignature = shopContentSignature(state.shop);
  const oldUpdatedAt = state.shop?.updatedAt || null;
  try {
    // force=1 is handled on the server and bypasses freshness checks: one manual
    // refresh click always asks itemshop.gg for a new shop snapshot.
    const shopResult = await api(force ? '/api/shop/today?force=1' : '/api/shop/today');
    const catalogResult = await api('/api/catalog');
    // A rotation can add new catalog IDs. Refresh the cached Korean alias index
    // when the Master Pool count changes so newly observed items are searchable.
    try {
      const aliasResult = await api('/api/search-aliases');
      state.itemAliases = aliasResult.aliases || state.itemAliases;
    } catch (aliasError) {
      console.warn('[search-aliases] refresh after shop sync failed:', aliasError.message);
    }
    state.shop = {
      ...shopResult.shop,
      lastFetchedAt: shopResult.lastFetchedAt || shopResult.fetchedAt || shopResult.shop.lastFetchedAt || null
    };
    state.catalog = catalogResult.items || state.catalog;
    renderStatus();
    renderCatalog();
    renderToday();
    $('#catalogNote').textContent = catalogResult.catalogNote || '';
    const changed = oldSignature !== shopContentSignature(state.shop) || oldUpdatedAt !== (state.shop.updatedAt || null);
    const refreshError = shopResult.refresh?.error || null;
    if (refreshError || shopResult.refresh?.stale || state.shop.stale) {
      const message = refreshError || '외부 상점 API가 이전 데이터를 반환했습니다.';
      if (force) showToast(`상점 갱신에 실패했어요. 이전 데이터를 유지합니다. (${message})`);
      return { success: false, updated: false, stale: true, changed, error: message };
    }
    if (force) {
      showToast(changed
        ? '외부 API에서 최신 상점 데이터를 가져왔어요.'
        : '외부 API 확인 완료 · 현재 상점 상품은 동일해요.');
    } else if (notify && changed) {
      showToast('신화 정수 상점 정보가 새로 갱신됐어요.');
    }
    return { success: true, updated: Boolean(shopResult.refresh?.updated), changed, stale: false };
  } catch (error) {
    console.warn('[shop] background refresh failed:', error.message);
    if (force) showToast(`상점 새로고침 실패: ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    shopRefreshInProgress = false;
  }
}

function startShopAutoRefresh() {
  if (shopAutoRefreshTimer) clearInterval(shopAutoRefreshTimer);
  // Refresh the server-backed snapshot every five minutes while the app is open.
  shopAutoRefreshTimer = setInterval(() => {
    if (!document.hidden) void refreshShopView({ notify: true });
  }, 5 * 60 * 1000);
}

function resumeShopRefresh() {
  if (!document.hidden) void refreshShopView({ notify: true });
}

document.addEventListener('visibilitychange', resumeShopRefresh);
window.addEventListener('focus', resumeShopRefresh);

async function loadChampionAliases() {
  try {
    const response = await fetch('/champion-aliases-ko.json?v=1.5.3', { cache: 'force-cache' });
    if (!response.ok) return;
    const aliases = await response.json();
    state.championAliases = Object.fromEntries(
      Object.entries(aliases).map(([name, korean]) => [compactSearchText(name), korean])
    );
  } catch { /* English-name search remains available if alias data is offline. */ }
}

async function loadSkinAliases() {
  try {
    const response = await fetch('/skin-aliases-ko.json?v=1.5.3', { cache: 'force-cache' });
    if (response.ok) {
      const payload = await response.json();
      state.skinAliases = payload.items || payload;
    }
  } catch { /* The server-side locale alias endpoint can still supply names. */ }
  try {
    const payload = await api('/api/search-aliases');
    state.itemAliases = payload.aliases || {};
    if (payload.error) console.warn('[search-aliases]', payload.error);
  } catch (error) {
    console.warn('[search-aliases] Korean item aliases unavailable:', error.message);
  }
}

async function loadApp() {
  try {
    const stored = localStorage.getItem('msa-favorites');
    if (stored) state.favorites = new Set(JSON.parse(stored));
  } catch { /* ignore invalid local storage */ }

  try {
    const [shopResult, catalogResult, preferences] = await Promise.all([
      api('/api/shop/today'), api('/api/catalog'), api(`/api/preferences/${encodeURIComponent(state.deviceId)}`), loadChampionAliases()
    ]);
    state.shop = {
      ...shopResult.shop,
      lastFetchedAt: shopResult.lastFetchedAt || shopResult.fetchedAt || shopResult.shop.lastFetchedAt || null
    };
    state.catalog = catalogResult.items || [];
    state.pushEnabled = Boolean(preferences.pushEnabled);
    // The server copy is the source of truth after this device has synced preferences.
    if (preferences.hasPreferences) {
      state.favorites = new Set(preferences.favorites || []);
      try { localStorage.setItem('msa-favorites', JSON.stringify([...state.favorites])); } catch { /* ignore */ }
    } else if (state.favorites.size) {
      await api(`/api/preferences/${encodeURIComponent(state.deviceId)}`, {
        method: 'PUT', body: JSON.stringify({ favorites: [...state.favorites] })
      });
    }
    renderStatus();
    renderCatalog();
    renderToday();
    $('#catalogNote').textContent = catalogResult.catalogNote || '';
    startHistoryCatalogPolling(catalogResult.history);
    startShopAutoRefresh();
    // Do not block first paint on the larger localized item index. English search
    // works immediately; Korean aliases hydrate in the background and rerender.
    void loadSkinAliases().then(() => renderCatalog());
    if (state.shop.stale) showToast('현재 API가 이전 데이터를 반환하고 있어요.');
  } catch (error) {
    $('#catalogList').innerHTML = `<div class="empty-state"><strong>상점 데이터를 불러오지 못했어요.</strong>${escapeHtml(error.message)}<br>서버가 실행 중인지 확인하고 새로고침해 주세요.</div>`;
    $('#todaySections').innerHTML = `<div class="empty-state"><strong>오늘의 상점을 불러오지 못했어요.</strong>${escapeHtml(error.message)}</div>`;
    showToast('서버 연결을 확인해 주세요.');
  }
}

function attachEvents() {
  document.querySelectorAll('.tab-button').forEach(button => button.addEventListener('click', () => setTab(button.dataset.tab)));
  $('#catalogList').addEventListener('click', event => {
    const button = event.target.closest('[data-star-key]');
    if (button) toggleFavorite(button.dataset.starKey);
  });
  $('#todaySections').addEventListener('click', event => {
    const button = event.target.closest('[data-star-key]');
    if (button) toggleFavorite(button.dataset.starKey);
  });
  $('#searchInput').addEventListener('input', renderCatalog);
  $('#categoryFilter').addEventListener('change', renderCatalog);
  $('#allItemsFilter').addEventListener('click', () => {
    state.starredOnly = false;
    $('#allItemsFilter').classList.add('selected');
    $('#starredItemsFilter').classList.remove('selected');
    renderCatalog();
  });
  $('#starredItemsFilter').addEventListener('click', () => {
    state.starredOnly = true;
    $('#starredItemsFilter').classList.add('selected');
    $('#allItemsFilter').classList.remove('selected');
    renderCatalog();
  });
  $('#enableNotifications').addEventListener('click', () => state.pushEnabled ? disablePush() : enablePush());
  $('#refreshButton').addEventListener('click', async () => {
    const button = $('#refreshButton');
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add('spinning');
    try {
      const result = await refreshShopView({ notify: true, force: true });
      if (result?.skipped && result.reason === 'already-refreshing') showToast('이미 상점을 갱신하고 있어요.');
    } finally {
      button.disabled = false;
      button.classList.remove('spinning');
    }
  });
}

attachEvents();
setTab(state.tab);
loadApp();
setupPush();
