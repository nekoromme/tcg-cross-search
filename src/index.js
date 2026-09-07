import { STORE_MAP, STORES, buildStoreSearchUrl } from './stores.js';
import { findCandidateProducts, parseProductDetail, sanitizeQuery } from './search.js';
import { isJunkTitle, looksLikeSingleCard, makeQueryTokens, normalizeText, textMatchesQuery } from './search-common.js';
import { productKind } from '../public/product-kind.js';

const APP_VERSION = '0.3.0';
const MAX_QUERY_LENGTH = 100;
const CACHE_SECONDS = 600;
const FETCH_TIMEOUT_MS = 12_000;
const SEARCH_HTML_MAX_BYTES = 1_500_000;
const DETAIL_HTML_MAX_BYTES = 900_000;

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; PersonalTCGCrossSearch/0.3.0; +https://github.com/nekoromme/tcg-cross-search)',
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
        stores: STORES.map(({ id, name, home, note }) => ({ id, name, home, note })),
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

  const manualSearchUrl = buildStoreSearchUrl(store, query);
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
  };

  try {
    const searchResponse = await fetchHtml(manualSearchUrl, SEARCH_HTML_MAX_BYTES);
    baseResult.httpStatus = searchResponse.status;

    if (searchResponse.status === 403 || searchResponse.status === 429) {
      baseResult.status = 'blocked';
      baseResult.error = 'サイト側が自動取得を拒否しました。回避せず手動確認に切り替えます。';
    } else if (searchResponse.status < 200 || searchResponse.status >= 400) {
      baseResult.status = 'error';
      baseResult.error = `HTTP ${searchResponse.status}`;
    } else {
      const candidates = findCandidateProducts(
        searchResponse.text,
        searchResponse.finalUrl || manualSearchUrl,
        query,
        sealedOnly,
        8,
        true,
      );
      // BOXを先に確保してから詳細確認。カートンが候補枠を独占しない。
      candidates.sort((a, b) => Number(b.kind === 'box') - Number(a.kind === 'box') || b.score - a.score);
      const selected = candidates.slice(0, 8);
      baseResult.candidateLimit = 8;

      if (!candidates.length) {
        baseResult.status = 'no_hit';
      } else {
        baseResult.results = await Promise.all(
          selected.map(async (candidate, index) => {
            // 一度に外へ接続しすぎないよう、詳細は最大4件。残りは要確認欄へ。
            if (index >= 4) return { ...candidate, reviewReason: '商品詳細は未確認' };
            try {
              const detailResponse = await fetchHtml(candidate.url, DETAIL_HTML_MAX_BYTES);
              if (detailResponse.status < 200 || detailResponse.status >= 400) return { ...candidate, reviewReason: '商品詳細を取得できませんでした' };
              const refined = parseProductDetail(detailResponse.text);
              // 詳細で別の商品・シングル・用品だと分かった候補は捨てる。
              if (refined.title && (!textMatchesQuery(normalizeText(refined.title), '', normalizeText(query), makeQueryTokens(query))
                || (sealedOnly && (isJunkTitle(refined.title) || looksLikeSingleCard(refined.title))))) return null;
              return {
                ...candidate,
                title: refined.title || candidate.title,
                // 詳細で不明だった値を、一覧の隣の商品由来かもしれない値で補わない。
                price: refined.price,
                stock: refined.stock,
                stockQty: refined.stockQty,
                kind: productKind(refined.title || candidate.title),
                detailChecked: Boolean(refined.title),
              };
            } catch {
              return { ...candidate, reviewReason: '商品詳細を取得できませんでした' };
            }
          }),
        );
        baseResult.results = baseResult.results.filter(Boolean);
        if (!baseResult.results.length) baseResult.status = 'no_hit';
      }
    }
  } catch (error) {
    baseResult.status = 'error';
    baseResult.error = safeErrorMessage(error);
  }

  baseResult.elapsedMs = Date.now() - startedAt;
  const response = jsonResponse(baseResult);
  response.headers.set('Cache-Control', forceRefresh ? 'no-store' : `public, max-age=${CACHE_SECONDS}`);
  return response;
}

async function fetchHtml(url, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: HTTP_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
      cache: 'no-store',
    });
    const bytes = await readBodyLimited(response, maxBytes);
    const text = decodeBytes(bytes, response.headers.get('content-type') || '');
    return { status: response.status, finalUrl: response.url || url, text };
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
