import { productKind, KIND_LABELS } from './product-kind.js';

// 取得順に左右されない並び替え。同価格のときは店名・商品URLで安定させる。
export function flattenRows(storeResults, sort = 'price_asc') {
  const rows = [];
  const seen = new Set();
  for (const result of storeResults.values()) {
    for (const item of result.results || []) {
      const key = `${result.store.id}:${item.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ ...item, kind: item.kind || productKind(item.title),
        price: Number.isFinite(item.price) && item.price > 0 ? item.price : null,
        storeId: result.store.id, storeName: result.store.name, storeNote: result.store.note || '',
        searchedAt: result.searchedAt });
    }
  }
  const stockOrder = { in_stock: 0, unknown: 1, out_of_stock: 2 };
  return rows.sort((a, b) => {
    if (sort === 'stock' && a.stock !== b.stock) return (stockOrder[a.stock] ?? 1) - (stockOrder[b.stock] ?? 1);
    if (sort === 'store') {
      const byStore = a.storeName.localeCompare(b.storeName, 'ja');
      if (byStore) return byStore;
    }
    // 価格不明は、安い順でも高い順でも最後にする。
    if ((a.price == null) !== (b.price == null)) return a.price == null ? 1 : -1;
    if (a.price !== b.price) return (a.price - b.price) * (sort === 'price_desc' ? -1 : 1);
    return a.storeName.localeCompare(b.storeName, 'ja') || a.url.localeCompare(b.url);
  });
}

export function selectRows(storeResults, options = {}) {
  const { unit = 'box', sort = 'price_asc', inStockOnly = false } = options;
  const rows = flattenRows(storeResults, sort);
  const main = [], review = [];
  let hidden = 0;
  for (const row of rows) {
    if ((unit === 'box' && ['carton', 'bundle', 'pack'].includes(row.kind)) ||
        (unit === 'sealed' && row.kind === 'pack') ||
        (inStockOnly && row.stock !== 'in_stock')) { hidden++; continue; }
    if (!row.detailChecked || row.price == null || row.stock === 'unknown' || row.kind === 'unknown') review.push(row);
    else main.push(row);
  }
  return { main, review, hidden };
}

export function renderRows(container, countEl, storeResults, options = {}) {
  const { main, review, hidden } = selectRows(storeResults, options);
  countEl.textContent = `${main.length}件表示${review.length ? `・要確認${review.length}件` : ''}${hidden ? `・条件で非表示${hidden}件` : ''}`;
  container.innerHTML = main.length ? main.map(renderCard).join('') : `<div class="empty">${options.searching
    ? '条件に合う商品を探しています…'
    : !options.hasSearched ? '商品名・型番を入力して検索してください。'
    : review.length ? '確実に比較できる商品はありません。「確認が必要な候補」を開いて確認できます。'
    : hidden ? '表示条件に合う商品はありません。販売単位や在庫の条件を変更できます。'
    : '候補を抽出できませんでした。短い商品名や型番で再検索するか、下の店内検索リンクから確認できます。'}</div>`;
  if (options.reviewPanel) {
    options.reviewPanel.hidden = review.length === 0;
    options.reviewSummary.textContent = `確認が必要な候補（${review.length}件）`;
    options.reviewContainer.innerHTML = review.map(renderCard).join('');
  }
}

function renderCard(row) {
  const reasons = [];
  if (!row.detailChecked) reasons.push(row.reviewReason || '商品詳細は未確認');
  if (row.price == null) reasons.push('価格不明');
  if (row.stock === 'unknown') reasons.push('在庫不明');
  if (row.kind === 'unknown') reasons.push('販売単位不明');
  const time = row.searchedAt && !Number.isNaN(Date.parse(row.searchedAt))
    ? new Date(row.searchedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '';
  return `<article class="result" data-kind="${escapeAttr(row.kind)}">
    <div class="storeInfo"><div class="store">${escapeHtml(row.storeName)}</div></div>
    <div class="title"><span class="unitBadge">${KIND_LABELS[row.kind] || KIND_LABELS.unknown}</span>
      <a href="${escapeAttr(row.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.title)}</a>
      <div class="checked">${escapeHtml(reasons.join('・') || `${time ? time + ' ' : ''}商品ページで確認`)}</div>
    </div>
    <div class="price">${formatPrice(row.price)}</div>
    <div class="stockCell">${stockBadge(row.stock, row.stockQty)}</div>
    <a class="open" href="${escapeAttr(row.url)}" target="_blank" rel="noopener noreferrer">商品ページ ↗</a>
  </article>`;
}

export function renderStatuses(container, stores, storeResults, searching) {
  if (!stores.length) {
    container.innerHTML = '<div>読み込み中…</div>';
    return;
  }
  container.innerHTML = stores.map((store) => {
    const result = storeResults.get(store.id);
    if (!result) return statusRow(store, searching ? '待機' : '未検索', '', store.home);
    const labels = { ok: '候補あり', no_hit: '候補を抽出できず', blocked: '取得拒否', error: 'エラー' };
    const label = labels[result.status] || result.status || '不明';
    const message = result.error || (result.results?.length ? `${result.results.length}件` : '');
    return statusRow(store, label, message, result.manualSearchUrl || store.home);
  }).join('');
}

function statusRow(store, label, message, manualUrl) {
  return `
    <div class="statusRow">
      <strong>${escapeHtml(store.name)}</strong>
      <span class="statusBadge">${escapeHtml(label)}</span>
      <span class="message">${escapeHtml(message || '')}</span>
      <a class="manual" href="${escapeAttr(manualUrl)}" target="_blank" rel="noopener noreferrer">手動確認 ↗</a>
    </div>
  `;
}

function stockBadge(stock, qty) {
  if (stock === 'in_stock') return `<span class="stock in_stock">在庫あり${qty != null ? ` ${qty}` : ''}</span>`;
  if (stock === 'out_of_stock') return '<span class="stock out_of_stock">在庫なし</span>';
  return '<span class="stock unknown">在庫不明</span>';
}

function formatPrice(price) {
  return price == null ? '価格不明' : `${Number(price).toLocaleString('ja-JP')}円`;
}

export function loadHistory() {
  try {
    const value = JSON.parse(localStorage.getItem('tcg-search-history') || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function saveHistory(query) {
  const previous = loadHistory().filter((item) => item !== query);
  previous.unshift(query);
  try { localStorage.setItem('tcg-search-history', JSON.stringify(previous.slice(0, 10))); } catch { /* 保存不可でも検索は続ける。 */ }
}

export function renderHistory(container, onSelect) {
  const history = loadHistory();
  container.innerHTML = history.map((query) => `<button class="chip" type="button" data-query="${escapeAttr(query)}">${escapeHtml(query)}</button>`).join('');
  for (const chip of container.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => onSelect(chip.dataset.query || ''));
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}
