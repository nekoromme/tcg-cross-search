// Yahooのブラウザー表示とサーバー応答の差を調べる、手動の公開ページ取得。
import { parseProductDetail } from '../src/product-detail.js';
const response = await fetch('https://store.shopping.yahoo.co.jp/suns-online-store/v8-am46-9usj.html', {
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PersonalTCGCrossSearch/0.6.2; +https://github.com/nekoromme/tcg-cross-search)', 'Accept-Language':'ja,en-US;q=0.8,en;q=0.6' },
  signal: AbortSignal.timeout(12000),
});
const html = await response.text();
const stripped = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
console.log(JSON.stringify({status:response.status,bytes:html.length,parsed:parseProductDetail(html),
  headings:[...stripped.matchAll(/<(?:h[1-3]|p)\b[^>]*>[^<]*BRIGHTNESS[^<]*<\/(?:h[1-3]|p)>/g)].map(m=>m[0]),
  stock:[...stripped.matchAll(/.{0,180}(?:在庫なし|在庫がありません).{0,120}/g)].slice(0,4).map(m=>m[0])}));
