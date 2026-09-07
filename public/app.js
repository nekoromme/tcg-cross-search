import { renderHistory, renderRows, renderStatuses, saveHistory } from './ui.js?v=0.3.0';

const els = {
  form: document.querySelector('#searchForm'),
  query: document.querySelector('#query'),
  searchButton: document.querySelector('#searchButton'),
  unitFilter: document.querySelector('#unitFilter'),
  sortOrder: document.querySelector('#sortOrder'),
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
};

let stores = [];
let storeResults = new Map();
let searching = false;
let currentRun = 0;
let hasSearched = false;

init();

async function init() {
  // 表示条件だけを保存。検索結果や個人情報をサーバーへ保存しない。
  try {
    const saved = JSON.parse(localStorage.getItem('tcg-display-options') || '{}');
    if (['box', 'sealed', 'all'].includes(saved.unit)) els.unitFilter.value = saved.unit;
    if (['price_asc', 'price_desc', 'stock', 'store'].includes(saved.sort)) els.sortOrder.value = saved.sort;
    els.inStockOnly.checked = saved.inStockOnly === true;
  } catch { /* 保存された設定が読めなくても初期値で続ける。 */ }
  refreshHistory();
  try {
    const response = await fetch('/api/stores', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    stores = data.stores || [];
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
for (const control of [els.unitFilter, els.sortOrder, els.inStockOnly]) {
  control.addEventListener('change', () => {
    try { localStorage.setItem('tcg-display-options', JSON.stringify(displayOptions())); } catch {}
    updateResults();
  });
}

function displayOptions() {
  return { unit: els.unitFilter.value, sort: els.sortOrder.value, inStockOnly: els.inStockOnly.checked };
}

function updateResults() {
  renderRows(els.results, els.resultCount, storeResults, { ...displayOptions(), searching, hasSearched,
    reviewPanel: els.reviewPanel, reviewSummary: els.reviewSummary, reviewContainer: els.reviewContainer });
}

async function startSearch() {
  if (searching || !stores.length) return;
  const query = els.query.value.trim();
  if (!query) return;

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
  updateResults();
  els.resultCount.textContent = '';

  let completed = 0;
  updateProgress(completed);
  renderStatuses(els.statuses, stores, storeResults, searching);

  const queue = [...stores];
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
          v: '0.3.0',
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
        renderStatuses(els.statuses, stores, storeResults, searching);
      }
    }
  });

  await Promise.all(workers);
  if (runId !== currentRun) return;
  searching = false;
  els.searchButton.disabled = false;
  els.forceRefresh.checked = false;
  updateProgress(completed, true);
  updateResults();
  renderStatuses(els.statuses, stores, storeResults, searching);
}

function updateProgress(completed, done = false) {
  els.progress.textContent = done ? `${stores.length}売り場の検索完了。` : `検索中 ${completed}/${stores.length}`;
}

function refreshHistory() {
  renderHistory(els.history, (query) => {
    els.query.value = query;
    els.query.focus();
  });
}
