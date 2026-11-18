'use strict';

const API = '';
const $ = selector => document.querySelector(selector);
const state = {
  deviceId: getDeviceId(),
  favorites: new Set(),
  catalog: [],
  shop: null,
  config: null,
  tab: new URLSearchParams(location.search).get('tab') === 'today' ? 'today' : 'favorites',
  starredOnly: false,
  serviceWorker: null,
  toastTimer: null
};

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
  const rarity = item.rarity?.name ? `<span class="item-rarity">${escapeHtml(item.rarity.name)}</span>` : '';
  const historyCount = Array.isArray(item.salesHistory) ? item.salesHistory.length : Number(item.historyCount || 0);
  const dateLabel = item.lastSeenDate ? ` · 최근 기록 ${escapeHtml(item.lastSeenDate)}` : '';
  const catalogState = item.active ? '현재 판매 중' : (item.isUpcoming || item.upcoming ? '판매 예정' : (historyCount ? `역대 판매 기록 ${historyCount}회` : '상점 기록 상품'));
  const meta = context === 'today'
    ? `판매 종료 ${escapeHtml(formatDateTime(item.availability?.until))}`
    : `${escapeHtml(item.type || '상품')} · ${catalogState}${dateLabel}`;
  return `
    <article class="item-card">
      <div class="item-art">${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(item.name)}" loading="lazy" onerror="this.remove()">` : '✦'}</div>
      <div class="item-info">
        <div class="item-topline"><span class="item-category">${escapeHtml(categoryLabel(item))}</span>${rarity}</div>
        <h3 class="item-name">${escapeHtml(item.name)}</h3>
        <div class="item-meta">${meta}</div>
        <div class="item-price"><span class="me-gem">✧</span>${escapeHtml(priceText(item))}</div>
      </div>
      <button class="star-button ${isFavorite ? 'selected' : ''}" data-star-key="${escapeHtml(item.key)}" type="button"
        aria-label="${isFavorite ? '즐겨찾기 해제' : '즐겨찾기 추가'}: ${escapeHtml(item.name)}"
        aria-pressed="${isFavorite}" ${item.trackable === false ? 'disabled title="안정적인 상품 식별자가 없어 알림 추적을 지원하지 않습니다."' : ''}>${isFavorite ? '★' : '☆'}</button>
    </article>`;
}

function renderCatalog() {
  const query = $('#searchInput').value.trim().toLocaleLowerCase();
  const category = $('#categoryFilter').value;
  let items = state.catalog.filter(item => {
    const text = `${item.name} ${item.type || ''}`.toLocaleLowerCase();
    return (!query || text.includes(query)) && (category === 'all' || categoryOf(item) === category) &&
      (!state.starredOnly || state.favorites.has(item.key));
  });
  items.sort((a, b) => Number(state.favorites.has(b.key)) - Number(state.favorites.has(a.key)) || a.name.localeCompare(b.name));
  $('#resultCount').textContent = `${items.length}개 표시`;
  $('#catalogCount').textContent = `${state.catalog.length}개 상품`;
  $('#favoriteCount').textContent = state.favorites.size;
  if (!items.length) {
    $('#catalogList').innerHTML = `<div class="empty-state"><strong>${state.starredOnly ? '아직 즐겨찾기한 상품이 없어요.' : '검색 결과가 없어요.'}</strong>${state.starredOnly ? '상품 카드의 별표를 눌러 관심 상품을 추가하세요.' : '검색어나 상품 종류를 바꿔보세요.'}</div>`;
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
  $('#todaySections').innerHTML = sections.map(section => `
    <section class="section-block">
      <div class="section-block-header"><h3>${escapeHtml(sectionLabel(section.title))}</h3><span>${section.items.length}개 상품</span></div>
      <div class="item-list">${section.items.map(item => itemCard(item, 'today')).join('')}</div>
    </section>`).join('');
}

function renderStatus() {
  if (!state.shop) return;
  $('#todayDate').textContent = state.shop.localDate || '오늘';
  $('#shopStatus').textContent = state.shop.stale ? '이전 데이터' : '최신 데이터';
  $('#shopStatus').classList.toggle('warn', Boolean(state.shop.stale));
  $('#lastUpdated').textContent = `API 갱신 ${formatDateTime(state.shop.updatedAt || state.shop.fetchedAt)}`;
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
      button.disabled = true;
      button.textContent = '서버 설정 필요';
      $('#notificationDescription').textContent = '서버 관리자가 VAPID 키를 설정하면 알림을 사용할 수 있어요.';
      return;
    }
    if (isIos() && !isStandalone()) {
      button.textContent = '설치 후 알림 켜기';
      $('#notificationDescription').textContent = 'iPhone: Safari 공유 버튼 → 홈 화면에 추가 → 설치된 앱을 실행해 알림을 켜세요.';
      return;
    }
    if (!('PushManager' in window) || !('Notification' in window)) {
      button.disabled = true;
      button.textContent = '푸시 미지원';
      $('#notificationDescription').textContent = '현재 브라우저에서는 웹 푸시를 지원하지 않아요. 최신 Chrome 또는 홈 화면 앱을 이용해 주세요.';
      return;
    }
    state.serviceWorker = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const subscription = await state.serviceWorker.pushManager.getSubscription();
    if (subscription && Notification.permission === 'granted') setNotificationEnabledUI();
  } catch (error) {
    button.disabled = true;
    button.textContent = '알림 준비 실패';
    $('#notificationDescription').textContent = error.message;
  }
}

function setNotificationEnabledUI() {
  $('#enableNotifications').textContent = '알림 켜짐';
  $('#enableNotifications').disabled = true;
  $('#notificationTitle').textContent = '즐겨찾기 입고 알림이 켜져 있어요';
  $('#notificationDescription').textContent = '관심 상품이 새 로테이션에 등장하면 이 기기로 알림을 보내드려요.';
}

async function enablePush() {
  if (isIos() && !isStandalone()) {
    showToast('iPhone은 먼저 공유 메뉴에서 “홈 화면에 추가”를 해주세요.');
    $('#notificationDescription').textContent = 'iPhone: Safari 공유 버튼 → 홈 화면에 추가 → 추가된 앱을 실행한 뒤 알림을 켜세요.';
    return;
  }
  if (!state.config?.notificationsEnabled) return showToast('서버의 푸시 설정이 필요해요.');
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return showToast('알림 권한이 허용되지 않았어요. 브라우저 설정에서 바꿀 수 있어요.');
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
    setNotificationEnabledUI();
    showToast('이 기기의 입고 알림을 등록했어요.');
  } catch (error) {
    showToast(`알림 등록 실패: ${error.message}`);
  }
}

async function loadApp() {
  try {
    const stored = localStorage.getItem('msa-favorites');
    if (stored) state.favorites = new Set(JSON.parse(stored));
  } catch { /* ignore invalid local storage */ }

  try {
    const [shopResult, catalogResult, preferences] = await Promise.all([
      api('/api/shop/today'), api('/api/catalog'), api(`/api/preferences/${encodeURIComponent(state.deviceId)}`)
    ]);
    state.shop = shopResult.shop;
    state.catalog = catalogResult.items || [];
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
  $('#enableNotifications').addEventListener('click', enablePush);
  $('#refreshButton').addEventListener('click', async () => {
    $('#refreshButton').classList.add('spinning');
    await loadApp();
    $('#refreshButton').classList.remove('spinning');
    showToast('상점 정보를 새로 확인했어요.');
  });
}

attachEvents();
setTab(state.tab);
loadApp();
setupPush();
