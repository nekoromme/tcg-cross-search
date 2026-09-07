import { STORE_MAP, STORES, buildStoreSearchUrl } from './stores.js';
import { findCandidateProducts, parseProductDetail, sanitizeQuery } from './search.js';
import { isJunkTitle, looksLikeSingleCard } from './search-common.js';
import { productKind } from '../public/product-kind.js';
import { matchesQuery, searchTerms, identifyProduct, comparePrice } from '../public/catalog.js';
import { findNextSearchPage } from './pagination.js';

const APP_VERSION = '0.4.2';
const MAX_QUERY_LENGTH = 100;
const CACHE_SECONDS = 600;
const FETCH_TIMEOUT_MS = 9_000;
const SEARCH_HTML_MAX_BYTES = 1_500_000;
const DETAIL_HTML_MAX_BYTES = 900_000;

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; PersonalTCGCrossSearch/0.4.2; +https://github.com/nekoromme/tcg-cross-search)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja,en-US;q=0.8,en;q=0.6',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return jsonResponse({ ok: true, version: APP_VERSION, stores: STORES.length });
    }

    if (url.pathname === '/api/stores') {
      return jsonResponse({
        version: APP_VERSION,
        stores: STORES.map(({ id, name, home, note, games }) => ({ id, name, home, note, games })),
      });
    }

    if (url.pathname === '/api/search') {
      return handleStoreSearch(request);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};

async function handleStoreSearch(request) {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const storeId = url.searchParams.get('store') || '';
  const query = sanitizeQuery(url.searchParams.get('q'));
  const sealedOnly = url.searchParams.get('sealed') !== '0';
  const forceRefresh = url.searchParams.get('refresh') === '1';

  const store = STORE_MAP.get(storeId);
  if (!store) return jsonResponse({ error: 'Unknown store.' }, 400);
  if (!query) return jsonResponse({ error: '検索語を入力して。' }, 400);
  if (query.length > MAX_QUERY_LENGTH) return jsonResponse({ error: '検索語は100文字以内にして。' }, 400);

  const terms = searchTerms(query);
  const manualSearchUrl = buildStoreSearchUrl(store, terms[0]);
  const pageLimit = url.searchParams.get('depth') === 'wide' ? 3 : 1;
  // 検索＋詳細を合わせて25秒・最大12通信で打ち切る。負荷を無制限に増やさない。
  const budget = { deadline: Date.now() + 25_000, requests: 0 };
  const baseResult = {
    version: APP_VERSION,
    query,
    store: {
      id: store.id,
      name: store.name,
      home: store.home,
      note: store.note || '',
    },
    manualSearchUrl,
    status: 'ok',
    httpStatus: null,
    results: [],
    error: '',
    searchedAt: new Date().toISOString(),
    elapsedMs: 0,
    coverage: { pagesRead: 0, searchRequests: 0, detailChecks: 0, candidateCount: 0, partialReasons: [], nextPageUrl: null },
  };

  try {
    const candidatesByUrl = new Map();
    let searchUrl = manualSearchUrl;
    let searchResponse;
    let continuationFailed = false;
    const visited = new Set();
    // 通常は先頭ページだけ。「広く探す」の時も、店が示した続きだけを最大3ページ読む。
    while (searchUrl && baseResult.coverage.pagesRead < pageLimit) {
      if (visited.has(searchUrl)) break;
      visited.add(searchUrl);
      let nextResponse;
      try { nextResponse = await fetchHtml(searchUrl, SEARCH_HTML_MAX_BYTES, budget); }
      catch (error) {
        if (!searchResponse) throw error;
        continuationFailed = true;
        baseResult.coverage.partialReasons.push('続きのページを取得できず'); break;
      }
      baseResult.coverage.searchRequests++;
      if (nextResponse.status < 200 || nextResponse.status >= 400) {
        continuationFailed = true;
        if (!searchResponse) searchResponse = nextResponse;
        else baseResult.coverage.partialReasons.push(`続きのページ HTTP ${nextResponse.status}`);
        break;
      }
      searchResponse = nextResponse;
      baseResult.coverage.pagesRead++;
      if (searchResponse.truncated) baseResult.coverage.partialReasons.push('ページの容量上限');
      for (const candidate of findCandidateProducts(searchResponse.text, searchResponse.finalUrl || searchUrl, query, sealedOnly, 100, true)) {
        // 店側の追跡用引数だけで同じ商品が重複しないよう、商品URLでまとめる。
        const key = new URL(candidate.url); key.search = ''; key.hash = '';
        if (!candidatesByUrl.has(key.href)) candidatesByUrl.set(key.href, candidate);
      }
      const next = findNextSearchPage(searchResponse.text, searchResponse.finalUrl || searchUrl, store);
      baseResult.coverage.nextPageUrl = next;
      if (candidatesByUrl.size >= 8 || !next) break;
      if (Date.now() + 10_000 >= budget.deadline) { baseResult.coverage.partialReasons.push('検索時間の上限'); break; }
      searchUrl = next;
    }
    // 正式名でしか検索できない店のための1回だけの補助検索。拒否された店では行わない。
    if (!candidatesByUrl.size && !continuationFailed && terms.length > 1 && searchResponse?.status === 200 && Date.now() + 10_000 < budget.deadline) {
      const alternate = buildStoreSearchUrl(store, terms[1]);
      let extra;
      try { extra = await fetchHtml(alternate, SEARCH_HTML_MAX_BYTES, budget); }
      catch { baseResult.coverage.partialReasons.push('別表記の検索を取得できず'); }
      baseResult.coverage.searchRequests++;
      if (extra?.status === 200) {
        baseResult.coverage.pagesRead++;
        for (const c of findCandidateProducts(extra.text, extra.finalUrl || alternate, query, sealedOnly, 100, true)) candidatesByUrl.set(c.url, c);
        baseResult.coverage.nextPageUrl ||= findNextSearchPage(extra.text, extra.finalUrl || alternate, store);
        if (extra.truncated) baseResult.coverage.partialReasons.push('ページの容量上限');
      } else if (extra) baseResult.coverage.partialReasons.push(`別表記の検索 HTTP ${extra.status}`);
    }
    baseResult.httpStatus = searchResponse.status;

    if (searchResponse.status === 403 || searchResponse.status === 429) {
      baseResult.status = 'blocked';
      baseResult.error = 'サイト側が自動取得を拒否しました。回避せず手動確認に切り替えます。';
    } else if (searchResponse.status < 200 || searchResponse.status >= 400) {
      baseResult.status = 'error';
      baseResult.error = `HTTP ${searchResponse.status}`;
    } else {
      const candidates = [...candidatesByUrl.values()];
      // BOXを先に確保してから詳細確認。カートンが候補枠を独占しない。
      candidates.sort((a, b) => Number(b.kind === 'box') - Number(a.kind === 'box') || b.score - a.score);
      const selected = candidates.slice(0, 8);
      baseResult.candidateLimit = 8;
      baseResult.coverage.candidateCount = candidates.length;
      if (baseResult.coverage.nextPageUrl) baseResult.coverage.partialReasons.push('検索結果の続きは未確認');
      if (candidates.length > 8) baseResult.coverage.partialReasons.push('候補件数の上限');

      if (!candidates.length) {
        baseResult.status = 'no_hit';
      } else {
        baseResult.results = await Promise.all(
          selected.map(async (candidate, index) => {
            // 一度に外へ接続しすぎないよう、詳細は最大4件。残りは要確認欄へ。
            if (index >= 4) return { ...candidate, reviewReason: '商品詳細は未確認' };
            try {
              const detailResponse = await fetchHtml(candidate.url, DETAIL_HTML_MAX_BYTES, budget);
              baseResult.coverage.detailChecks++;
              if (detailResponse.status < 200 || detailResponse.status >= 400) return { ...candidate, reviewReason: '商品詳細を取得できませんでした' };
              const refined = parseProductDetail(detailResponse.text);
              // 詳細で別の商品・シングル・用品だと分かった候補は捨てる。
              if (refined.title && (!matchesQuery(refined.title, query)
                || (sealedOnly && (isJunkTitle(refined.title) || looksLikeSingleCard(refined.title))))) return null;
              const row = {
                ...candidate,
                ...refined,
                title: refined.title || candidate.title,
                // 詳細で不明だった値を、一覧の隣の商品由来かもしれない値で補わない。
                price: refined.price,
                stock: refined.stock,
                stockQty: refined.stockQty,
                kind: productKind(refined.title || candidate.title),
                detailChecked: Boolean(refined.title),
              };
              const product = identifyProduct(row.title);
              // 発売前の商品を、即納できる在庫として表示しない。
              if (row.stock === 'in_stock' && product?.releaseDate && product.releaseDate > new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })) row.stock = 'preorder';
              row.comparison = comparePrice(row);
              return row;
            } catch {
              return { ...candidate, reviewReason: '商品詳細を取得できませんでした' };
            }
          }),
        );
        baseResult.results = baseResult.results.filter(Boolean);
        if (baseResult.results.some(row => !row.detailChecked)) baseResult.coverage.partialReasons.push('商品詳細の未確認あり');
        if (!baseResult.results.length) baseResult.status = 'no_hit';
      }
    }
  } catch (error) {
    baseResult.status = 'error';
    baseResult.error = safeErrorMessage(error);
  }

  baseResult.elapsedMs = Date.now() - startedAt;
  baseResult.coverage.requests = budget.requests;
  baseResult.coverage.partialReasons = [...new Set(baseResult.coverage.partialReasons)];
  // 検索語や認証情報はログへ出さず、故障の切り分けに必要な店・件数・時間を残す。
  console.info(JSON.stringify({ event: 'store_search', version: APP_VERSION, store: store.id, status: baseResult.status,
    pages: baseResult.coverage.pagesRead, details: baseResult.coverage.detailChecks, requests: budget.requests, elapsedMs: baseResult.elapsedMs }));
  const response = jsonResponse(baseResult);
  response.headers.set('Cache-Control', forceRefresh ? 'no-store' : `public, max-age=${CACHE_SECONDS}`);
  return response;
}

async function fetchHtml(url, maxBytes, budget) {
  if (budget.requests >= 12 || Date.now() >= budget.deadline) throw new Error('検索の通信・時間上限に達しました');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), Math.min(FETCH_TIMEOUT_MS, budget.deadline - Date.now()));
  try {
    const initial = new URL(url);
    let target = initial.href;
    let response;
    for (let redirect = 0; redirect < 4; redirect++) {
      if (budget.requests >= 12) throw new Error('検索の通信上限に達しました');
      budget.requests++;
      response = await fetch(target, {
      method: 'GET',
      headers: HTTP_HEADERS,
      redirect: 'manual',
      signal: controller.signal,
      cache: 'no-store',
      });
      if (![301,302,303,307,308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('転送先を確認できませんでした');
      const next = new URL(location, target);
      if (next.protocol !== 'https:' || next.username || next.password || next.port || next.hostname.replace(/^www\./,'') !== initial.hostname.replace(/^www\./,'')) throw new Error('店舗外への転送のため手動確認が必要です');
      target = next.href;
      if (redirect === 3) throw new Error('転送回数の上限に達しました');
    }
    const bytes = await readBodyLimited(response, maxBytes);
    const text = decodeBytes(bytes, response.headers.get('content-type') || '');
    return { status: response.status, finalUrl: response.url || target, text, truncated: bytes.byteLength >= maxBytes };
  } finally {
    clearTimeout(timer);
  }
}

async function readBodyLimited(response, maxBytes) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      const remaining = maxBytes - total;
      if (remaining <= 0) break;
      const part = value.length > remaining ? value.subarray(0, remaining) : value;
      chunks.push(part);
      total += part.length;
      if (total >= maxBytes) break;
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function decodeBytes(bytes, contentType) {
  const charsetMatch = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  const rawCharset = (charsetMatch?.[1] || 'utf-8').toLowerCase();
  const aliases = {
    sjis: 'shift_jis',
    'shift-jis': 'shift_jis',
    'windows-31j': 'shift_jis',
    'x-sjis': 'shift_jis',
    'euc-jp': 'euc-jp',
  };
  const charset = aliases[rawCharset] || rawCharset;
  try { return new TextDecoder(charset).decode(bytes); }
  catch { return new TextDecoder('utf-8').decode(bytes); }
}

function safeErrorMessage(error) {
  if (error?.name === 'AbortError') return '取得がタイムアウトしました。';
  return String(error?.message || error || '取得失敗').slice(0, 300);
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
