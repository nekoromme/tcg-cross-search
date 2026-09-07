import { productKind, isSpecialSet, KIND_LABELS } from './product-kind.js';
import { comparePrice, withinPriceLimit, explicitGame, identifyProduct } from './catalog.js';
import { groupProductRows, comparisonConditions } from './comparison-groups.js';

// 取得順に左右されない並び替え。同価格のときは店名・商品URLで安定させる。
export function flattenRows(storeResults, sort = 'price_asc') {
  const rows = [];
  const seen = new Set();
  for (const result of storeResults.values()) {
    for (const item of result.results || []) {
      const key = `${result.store.id}:${item.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ ...item, comparison: comparePrice(item), kind: isSpecialSet(item.title) ? productKind(item.title) : item.kind || productKind(item.title),
        price: Number.isFinite(item.price) && item.price > 0 ? item.price : null,
        storeId: result.store.id, storeName: result.store.name, storeNote: result.store.note || '',
        searchedAt: result.searchedAt });
    }
  }
  const stockOrder = { in_stock: 0, preorder: 1, unknown: 2, out_of_stock: 3 };
  return rows.sort((a, b) => {
    if (sort === 'discount') {
      const av = a.comparison.status === 'known' ? a.comparison.percent : Infinity;
      const bv = b.comparison.status === 'known' ? b.comparison.percent : Infinity;
      if (av !== bv) return av - bv;
    }
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
  const { unit = 'box', sort = 'price_asc', inStockOnly = false, priceLimit = 'all', includeUnknown = true,
    maxPrice = null, includePreorders = true, game = '' } = options;
  const rows = flattenRows(storeResults, sort);
  const main = [], review = [];
  let hidden = 0;
  let priceHidden = 0, priceUnknown = 0;
  for (const row of rows) {
    const identifiedGame = explicitGame(row.title) || identifyProduct(row.title)?.game;
    if (game && identifiedGame && identifiedGame !== game) { hidden++; continue; }
    if ((unit === 'box' && ['carton', 'bundle', 'pack', 'special'].includes(row.kind)) ||
        (unit === 'sealed' && row.kind === 'pack') ||
        (!includePreorders && row.stock === 'preorder') ||
        (inStockOnly && row.stock !== 'in_stock')) { hidden++; continue; }
    const comp = row.comparison;
    if (comp.status !== 'known') priceUnknown++;
    if ((comp.status !== 'known' && !includeUnknown) || (priceLimit !== 'all' && comp.status === 'known' && !withinPriceLimit(row, comp, Number(priceLimit)))) { hidden++; priceHidden++; continue; }
    if (maxPrice > 0 && (row.price == null || row.price > maxPrice)) { hidden++; priceHidden++; continue; }
    if (!row.detailChecked || row.price == null || row.stock === 'unknown' || row.kind === 'unknown') review.push(row);
    else main.push(row);
  }
  return { main, review, hidden, priceHidden, priceUnknown };
}

export function renderRows(container, countEl, storeResults, options = {}) {
  const { main, review, hidden, priceHidden } = selectRows(storeResults, options);
  const grouped = options.view === 'grouped';
  const groups = grouped ? groupProductRows(main) : [];
  const groupedCount = groups.filter(g => g.comparable).length;
  const individualCount = groups.length - groupedCount;
  countEl.textContent = `${main.length}件表示${grouped && main.length ? `（${groupedCount}商品に集約${individualCount ? `・個別${individualCount}件` : ''}）` : ''}${review.length ? `・要確認${review.length}件` : ''}${hidden ? `・非表示${hidden}件（価格条件${priceHidden}件）` : ''}`;
  container.innerHTML = main.length ? (grouped ? groups.map(renderProductGroup).join('') : main.map(row => renderCard(row)).join('')) : `<div class="empty">${options.searching
    ? '条件に合う商品を探しています…'
    : !options.hasSearched ? '商品名・型番を入力して検索してください。'
    : review.length ? '確実に比較できる商品はありません。「確認が必要な候補」を開いて確認できます。'
    : hidden ? '表示条件に合う商品はありません。価格・販売単位・在庫の条件を変更できます。'
    : '候補を抽出できませんでした。短い商品名や型番で再検索するか、下の店内検索リンクから確認できます。'}</div>`;
  if (options.reviewPanel) {
    options.reviewPanel.hidden = review.length === 0;
    options.reviewSummary.textContent = `確認が必要な候補（${review.length}件）`;
    options.reviewContainer.innerHTML = review.map(row => renderCard(row)).join('');
  }
}

function renderProductGroup(group) {
  // 同一商品と確認できないものは、価格の安い海外版や複数BOXと混ぜない。
  if (!group.comparable) return `<section class="individualOffer"><div class="help">同一BOXと確認できないため個別表示</div>${renderCard(group.rows[0])}</section>`;
  return `<section class="productGroup" aria-label="${escapeAttr(group.name)}の店舗比較">
    <div class="groupHeader"><h2>${escapeHtml(group.name)} <span class="unitBadge">日本語版1BOX</span></h2>
      <div class="groupSummary"><span>${group.storeCount}店・${group.rows.length}件／在庫あり ${group.availableStores}店</span>
        <strong>${group.availableMinPrice == null ? '在庫ありの掲載なし' : `表示中・在庫あり最安 ${formatPrice(group.availableMinPrice)}`}</strong></div>
      <div class="help">表示中の最安 ${formatPrice(group.minPrice)}（売切・予約を含む）／BOX基準 ${formatPrice(group.referencePrice)}<br>商品価格・送料別。外装や受取条件は店ごとに確認してください。</div>
    </div>
    <div class="groupOffers">${group.rows.map(row => renderCard(row, true)).join('')}</div>
  </section>`;
}

function renderCard(row, compact = false) {
  const reasons = [];
  if (!row.detailChecked) reasons.push(row.reviewReason || '商品詳細は未確認');
  if (row.price == null) reasons.push('価格不明');
  if (row.stock === 'unknown') reasons.push('在庫不明');
  if (row.kind === 'unknown') reasons.push('販売単位不明');
  const time = row.searchedAt && !Number.isNaN(Date.parse(row.searchedAt))
    ? new Date(row.searchedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '';
  const conditions = compact ? comparisonConditions(row) : row.conditions;
  return `<article class="result${compact ? ' comparisonOffer' : ''}" data-kind="${escapeAttr(row.kind)}">
    <div class="storeInfo"><div class="store">${escapeHtml(row.storeName)}</div></div>
    <div class="title"><span class="unitBadge">${KIND_LABELS[row.kind] || KIND_LABELS.unknown}</span>
      ${compact ? '<details class="offerTitle"><summary>元の商品名・確認情報</summary>' : ''}
      <a href="${escapeAttr(row.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.title)}</a>
      <div class="checked">${escapeHtml(reasons.join('・') || `${time ? time + ' ' : ''}商品ページで確認`)}</div>
      ${compact ? '</details>' : ''}
    </div>
    <div class="priceCell"><div class="price">${formatPrice(row.price)}</div>${renderComparison(row)}<div class="checked">送料別・送料未確認</div></div>
    <div class="stockCell">${stockBadge(row.stock, row.stockQty)}</div>
    <a class="open" href="${escapeAttr(row.url)}" target="_blank" rel="noopener noreferrer">商品ページ ↗</a>
    ${conditions?.length ? `<div class="conditions">${escapeHtml(conditions.join('・'))}</div>` : ''}
  </article>`;
}

function renderComparison(row) {
  const c = row.comparison || comparePrice(row);
  if (c.status !== 'known') return `<div class="priceComparison muted" title="${escapeAttr(c.reason)}">定価未確認</div>`;
  const delta = c.difference === 0 ? '定価と同じ' : `${c.difference > 0 ? '+' : '−'}${Math.abs(c.difference).toLocaleString('ja-JP')}円（${c.percent > 0 ? '+' : ''}${c.percent.toFixed(1)}%）`;
  return `<div class="priceComparison ${c.difference > 0 ? 'above' : 'below'}">${escapeHtml(delta)}</div><details class="priceSource"><summary>BOX基準 ${formatPrice(c.referencePrice)}</summary><div>税込・${c.basis === 'official_box' ? '公式BOX価格' : 'パック定価×確認済み入数'}<br>確認日 ${escapeHtml(c.checkedAt)}</div>${(c.sources || []).map(s => `<a href="${escapeAttr(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.label)} ↗</a>`).join('<br>')}</details>`;
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
    const c = result.coverage;
    const message = [result.error, result.results?.length ? `${result.results.length}候補` : '', c ? `${c.pagesRead}ページ・詳細${c.detailChecks}件確認` : '',
      describeSearchEvidence(result), c?.fallback === 'box_keyword' ? 'BOXで絞り込む補助検索を実施' : '', ...(c?.partialReasons || [])].filter(Boolean).join('／');
    return statusRow(store, label, message, result.manualSearchUrl || store.home);
  }).join('');
}

export function describeSearchEvidence(result) {
  if (result.status !== 'no_hit') return '';
  const c = result.coverage, evidence = c?.listing;
  if (!evidence) return '';
  if (c.candidateCount > 0) return '商品詳細を確認した結果、検索条件に合う候補なし';
  if (evidence.excludedSingles > 0) return '確認した範囲ではシングル等を除外し、BOX候補なし';
  if (evidence.excludedOther > 0) return '確認した範囲では用品等を除外し、BOX候補なし';
  if (evidence.productLinks > 0) return '商品リンクを読み取ったが、検索語に一致する候補なし';
  return '商品リンクを読み取れず。検索結果なし・ページ構造の違いは手動確認';
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
  if (stock === 'preorder') return '<span class="stock unknown">予約受付</span>';
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
