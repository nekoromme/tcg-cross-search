import { renderHistory, renderRows, renderStatuses, saveHistory } from './ui.js?v=0.5.0';
import { PRODUCTS, GAMES, CATALOG_UPDATED, identifyProduct } from './catalog.js';

const els = {
  form: document.querySelector('#searchForm'),
  query: document.querySelector('#query'),
  searchButton: document.querySelector('#searchButton'),
  searchSettings: document.querySelector('#searchSettings'),
  unitFilter: document.querySelector('#unitFilter'),
  sortOrder: document.querySelector('#sortOrder'),
  resultView: document.querySelector('#resultView'),
  reviewPanel: document.querySelector('#reviewPanel'),
  reviewSummary: document.querySelector('#reviewSummary'),
  reviewContainer: document.querySelector('#reviewResults'),
  forceRefresh: document.querySelector('#forceRefresh'),
  inStockOnly: document.querySelector('#inStockOnly'),
  history: document.querySelector('#history'),
  progress: document.querySelector('#progress'),
  resultCount: document.querySelector('#resultCount'),
  results: document.querySelector('#results'),
  statuses: document.querySelector('#storeStatuses'),
  gameFilter: document.querySelector('#gameFilter'),
  searchDepth: document.querySelector('#searchDepth'),
  priceLimit: document.querySelector('#priceLimit'),
  maxPrice: document.querySelector('#maxPrice'),
  includeUnknown: document.querySelector('#includeUnknown'),
  includePreorders: document.querySelector('#includePreorders'),
  searchHint: document.querySelector('#searchHint'),
};

let stores = [];
let storeResults = new Map();
let searching = false;
let currentRun = 0;
let hasSearched = false;
let activeStores = [];

init();

async function init() {
  // 表示条件だけを保存。検索結果や個人情報をサーバーへ保存しない。
  try {
    const saved = JSON.parse(localStorage.getItem('tcg-display-options') || '{}');
    if (['box', 'sealed', 'all'].includes(saved.unit)) els.unitFilter.value = saved.unit;
    if (['grouped', 'list'].includes(saved.view)) els.resultView.value = saved.view;
    if (['price_asc', 'price_desc', 'stock', 'store', 'discount'].includes(saved.sort)) els.sortOrder.value = saved.sort;
    els.inStockOnly.checked = saved.inStockOnly === true;
    if (['100','105','110','all'].includes(saved.priceLimit)) els.priceLimit.value = saved.priceLimit;
    if (saved.maxPrice > 0) els.maxPrice.value = saved.maxPrice;
    els.includeUnknown.checked = saved.includeUnknown !== false;
    els.includePreorders.checked = saved.includePreorders !== false;
    if (GAMES[saved.game]) els.gameFilter.value = saved.game;
  } catch { /* 保存された設定が読めなくても初期値で続ける。 */ }
  renderCatalog();
  updateQueryHint();
  refreshHistory();
  try {
    const response = await fetch('/api/stores', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    stores = data.stores || [];
    activeStores = stores;
    els.progress.textContent = `${stores.length}売り場を検索できる。`;
    renderStatuses(els.statuses, stores, storeResults, searching);
  } catch (error) {
    els.progress.textContent = `ショップ一覧の取得に失敗: ${error.message}`;
  }
}

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  startSearch();
});
// 並び替え・表示の変更は取得済みの結果だけで行い、店へ再アクセスしない。
for (const control of [els.resultView, els.unitFilter, els.sortOrder, els.inStockOnly, els.priceLimit, els.maxPrice, els.includeUnknown, els.includePreorders, els.gameFilter]) {
  control.addEventListener(control === els.maxPrice ? 'input' : 'change', () => {
    try { localStorage.setItem('tcg-display-options', JSON.stringify(displayOptions())); } catch {}
    updateResults();
    updateQueryHint();
  });
}

function displayOptions() {
  return { view: els.resultView.value, unit: els.unitFilter.value, sort: els.sortOrder.value, inStockOnly: els.inStockOnly.checked,
    priceLimit: els.priceLimit.value, maxPrice: Number(els.maxPrice.value) || null,
    includeUnknown: els.includeUnknown.checked, includePreorders: els.includePreorders.checked, game: els.gameFilter.value };
}

function updateResults() {
  renderRows(els.results, els.resultCount, storeResults, { ...displayOptions(), searching, hasSearched,
    reviewPanel: els.reviewPanel, reviewSummary: els.reviewSummary, reviewContainer: els.reviewContainer });
}

async function startSearch() {
  if (searching || !stores.length) return;
  const query = els.query.value.trim();
  if (!query) return;
  // 明確に別ゲーム専用の売り場だけ省く。取り扱い未調査の総合店は検索対象に残す。
  const game = els.gameFilter.value;
  activeStores = stores.filter(store => !game || !store.games || store.games.includes(game));
  els.gameFilter.disabled = true;
  els.searchDepth.disabled = true;

  // 設定を閉じ、スマホのキーボードも閉じる。結果へ自動スクロールはしない。
  // 履歴が増えても閉じた設定内なので、検索ボタンの下を押し下げない。
  els.searchSettings.open = false;
  if (document.activeElement === els.query) els.query.blur();
  saveHistory(query);
  refreshHistory();
  storeResults = new Map();
  searching = true;
  hasSearched = true;
  els.reviewPanel.open = false;
  const runId = ++currentRun;
  const forceRefresh = els.forceRefresh.checked;
  const cacheBust = forceRefresh ? String(Date.now()) : '';
  els.searchButton.disabled = true;
  els.searchButton.textContent = '検索中…';
  updateResults();

  let completed = 0;
  updateProgress(completed);
  renderStatuses(els.statuses, activeStores, storeResults, searching);

  const queue = [...activeStores];
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length && runId === currentRun) {
      const store = queue.shift();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 35_000);
      try {
        const params = new URLSearchParams({
          store: store.id,
          q: query,
          sealed: '1',
          v: '0.5.0',
          depth: els.searchDepth.value,
          refresh: forceRefresh ? '1' : '0',
        });
        if (cacheBust) params.set('_bust', cacheBust);
        const response = await fetch(`/api/search?${params}`, {
          cache: forceRefresh ? 'no-store' : 'default', signal: controller.signal,
        });
        if (!response.ok) throw new Error(`検索サービスから HTTP ${response.status} が返りました`);
        const data = await response.json();
        storeResults.set(store.id, data);
      } catch (error) {
        storeResults.set(store.id, {
          query,
          store,
          status: 'error',
          results: [],
          error: error.name === 'AbortError' ? '応答に時間がかかっています。店内検索から確認できます。' : error.message || String(error),
          manualSearchUrl: store.home,
        });
      } finally {
        clearTimeout(timeout);
        completed += 1;
        updateProgress(completed);
        updateResults();
        renderStatuses(els.statuses, activeStores, storeResults, searching);
      }
    }
  });

  await Promise.all(workers);
  if (runId !== currentRun) return;
  searching = false;
  els.searchButton.disabled = false;
  els.searchButton.textContent = '横断検索';
  els.gameFilter.disabled = false;
  els.searchDepth.disabled = false;
  els.forceRefresh.checked = false;
  updateProgress(completed, true);
  updateResults();
  renderStatuses(els.statuses, activeStores, storeResults, searching);
}

function updateProgress(completed, done = false) {
  const partial = [...storeResults.values()].filter(r => r.status !== 'ok' || r.coverage?.partialReasons?.length).length;
  els.progress.textContent = done ? `検索完了 ${completed}/${activeStores.length}${partial ? `・一部未確認 ${partial}店` : ''}` : `検索中 ${completed}/${activeStores.length}`;
}

function refreshHistory() {
  renderHistory(els.history, (query) => {
    els.query.value = query;
    updateQueryHint();
    els.query.focus();
  });
}

els.query.addEventListener('input', updateQueryHint);
function updateQueryHint() {
  const p = identifyProduct(els.query.value, els.gameFilter.value);
  els.searchHint.textContent = p ? `${GAMES[p.game]}／${p.name}：${p.boxPrice ? `BOX基準 ${p.boxPrice.toLocaleString('ja-JP')}円` : 'BOX定価の資料を確認中'}` : '型番・正式名に対応。定価台帳から商品を選んで検索することもできます。';
}
function renderCatalog() {
  const confirmed = PRODUCTS.filter(p => p.boxPrice > 0);
  document.querySelector('#catalogSummary').textContent = `定価台帳：${confirmed.length}商品登録（台帳更新 ${CATALOG_UPDATED}）`;
  const datalist = document.querySelector('#catalogSuggestions');
  const list = document.querySelector('#catalogList');
  for (const [game, label] of Object.entries(GAMES)) {
    const section = document.createElement('section');
    const heading = document.createElement('h3');
    heading.textContent = `${label}（${confirmed.filter(p => p.game === game).length}商品）`;
    section.append(heading);
    for (const p of PRODUCTS.filter(p => p.game === game)) {
      const option = document.createElement('option'); option.value = p.name; option.label = p.code || label; datalist.append(option);
      const button = document.createElement('button'); button.type = 'button'; button.className = 'catalogProduct';
      button.textContent = `${p.code ? p.code + ' ' : ''}${p.name}　${p.boxPrice ? p.boxPrice.toLocaleString('ja-JP') + '円' : '定価確認中'}`;
      button.addEventListener('click', () => { if (searching) return; els.query.value = p.name; els.gameFilter.value = p.game; updateQueryHint(); els.query.focus(); els.query.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
      section.append(button);
    }
    list.append(section);
  }
}
