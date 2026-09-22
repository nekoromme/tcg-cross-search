// 手動の切り分け用。公開ページだけを最大6回取得し、商品リンクと件数を確認する。
// Cookieや認証情報は送信せず、応答ヘッダー全体やページ全文もログに出さない。
import { findCandidateProducts } from '../src/search-results.js';
import { emptySearchEvidence } from '../src/search-evidence.js';
const cases = [
  ['cardmax', 'https://www.cardmax.jp/shop/shopbrand.html?search=Phantom+Aria', 'GD04'],
  ['dayya-original', 'https://www.tcg-dayya.com/products/list?name=GD04', 'GD04'],
  ['dayya-form', 'https://www.tcg-dayya.com/products/list?category_id=&name=GD04', 'GD04'],
  ['torecolo-original', 'https://www.torecolo.jp/shop/goods/search.aspx?keyword=GD04', 'GD04'],
  ['torecolo-form', 'https://www.torecolo.jp/shop/goods/search.aspx?search=x&keyword=GD04', 'GD04'],
  ['tcgacademy-empty', 'https://www.tcgacademy.com/product-list?keyword=GD04', 'GD04'],
  ['papy-empty', 'https://papysougouten.ocnk.net/product-list?keyword=GD04', 'GD04'],
  ['suns-empty', 'https://store.shopping.yahoo.co.jp/suns-online-store/search.html?p=GD04', 'GD04'],
];
for (const [store, url, query] of cases) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const header = response.headers.get('content-type') || '';
    const ascii = new TextDecoder().decode(bytes.slice(0, 4096));
    const charset = header.match(/charset=([^;\s]+)/i)?.[1] || ascii.match(/charset=["']?([^"'\s;>]+)/i)?.[1] || 'utf-8';
    const html = new TextDecoder(charset).decode(bytes);
    const stats = {};
    const rows = findCandidateProducts(html, url, query, true, 8, true, stats);
    const productLinks = [...html.matchAll(/<a\b[^>]*href[^>]*>/gi)].map(m=>m[0]).filter(s=>/211454|products\/detail/.test(s)).slice(0,2);
    console.log(JSON.stringify({ store, status: response.status, header, charset, bytes: bytes.length, stats,
      rows: rows.map(r=>({title:r.title,url:r.url})), productLinks,
      empty: emptySearchEvidence(html),
      emptyMarkup: [...html.matchAll(/.{0,120}(?:0<\/span>|0件|見つかりません|見つかりませんでした|該当する商品).{0,140}/g)].slice(0,3).map(m=>m[0]) }));
  } catch (e) { console.log(JSON.stringify({store,error:e.message})); }
}
