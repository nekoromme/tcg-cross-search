export function sanitizeQuery(query) {
  return String(query ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function normalizeText(value) {
  let text = String(value ?? '');
  try { text = text.normalize('NFKC'); } catch {}
  return text.toLowerCase().replace(/\s+/g, '').replace(/[\[\]【】()（）「」『』・:：_\-‐‑–—]/g, '');
}

export function makeQueryTokens(query) {
  let text = String(query || '');
  try { text = text.normalize('NFKC'); } catch {}
  return text.toLowerCase()
    .split(/[\s　/／,，・:：\[\]【】()（）]+/)
    .map((token) => normalizeText(token))
    .filter((token) => token.length >= 2)
    .slice(0, 8);
}

export function textMatchesQuery(titleNorm, contextNorm, queryNorm, tokens) {
  // 周辺の商品名や「検索語」の見出しは証拠にしない。複数語はすべて一致。
  if (queryNorm && titleNorm.includes(queryNorm)) return true;
  if (!tokens.length) return false;
  return tokens.every((token) => titleNorm.includes(token));
}

export function isSealedTitle(title) {
  return /(?:\bbox\b|ボックス|カートン|\d+\s*BOX|ブースターパック|ブースター\s*BOX|パック\s*BOX|未開封BOX|新品商品|新品予約)/i.test(String(title || ''));
}

// 「ブースターパック」という商品名だけでは、1パックかBOXかは分からない。
// 箱単位の表記がある商品を優先し、単品パックの安値がBOXより上に来るのを防ぐ。
export function isBoxOrCartonTitle(title) {
  return /(?:\bbox\b|\d+\s*BOX|未開封BOX|ボックス|カートン)/i.test(String(title || ''));
}

export function isJunkTitle(title) {
  return /オリパ|謎袋|謎箱|福袋|くじ|ガチャ|プラモデル|デカール|中古|スリーブ|プレイマット|デッキケース|ストレージ|空箱|空き箱|店頭受取専用|店頭販売のみ/i.test(String(title || ''));
}

export function looksLikeSingleCard(title) {
  const text = String(title || '');
  if (isSealedTitle(text)) return false;
  // GD03-118RP2 / GD03-050LRP / GD03-110UP+ もカード番号。
  // 番号末尾の英字を見落とすと「未開封」のプロモカードまでBOX扱いしてしまう。
  return /(?:\b[A-Z]{1,4}\d{0,2}[-_/]\d{2,4}(?:[A-Z][A-Z0-9]*)?\b|\b(?:SEC|SR|UR|SAR|AR|RRR|RR|LR|R|UC|U|C)\+?\b|パラレル|シングル|鑑定|PSA\d+)/i.test(text);
}

export function isLikelyProductUrl(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return false; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  const path = parsed.pathname;
  // 検索の「次へ」やカテゴリー一覧は商品ではない。先に明示的に除く。
  if (/\/(?:products\/list|product-list)(?:\/|$)|\/(?:search|shopbrand|index|category)\.html$/i.test(path)) return false;
  return /\/(?:product\/\d+|products\/detail\/\d+|view\/item\/|shopdetail\/|products\/[^/]+|shop\/g\/g[^/]+|item\/[^/]+|goods\/[^/]+|product-[^/]+)|\/[^/]+\.html$/i.test(path);
}

export function extractPrice(text) {
  if (!text) return null;
  const patterns = [
    /(?:販売価格|価格|税込価格|通常価格)\s*[:：]?\s*(?:￥|¥)?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,9})\s*円?/i,
    /(?:￥|¥)\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,9})/,
    /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,9})\s*円\s*(?:\(税込\)|税込)?/i,
  ];
  for (const pattern of patterns) {
    const match = String(text).match(pattern);
    if (!match) continue;
    const price = parseMoney(match[1]);
    if (price != null && price > 0 && price < 100_000_000) return price;
  }
  return null;
}

export function parseMoney(value) {
  const number = Number(String(value || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

export function extractStock(text) {
  const value = String(text || '');
  let match = value.match(/在庫(?:数)?\s*[:：]?\s*([0-9]+)\s*(?:点|個|BOX|箱)?/i);
  if (match) {
    const qty = Number(match[1]);
    return { stock: qty > 0 ? 'in_stock' : 'out_of_stock', qty };
  }
  match = value.match(/残り\s*([0-9]+)\s*(?:点|個|BOX|箱)?/i);
  if (match) {
    const qty = Number(match[1]);
    return { stock: qty > 0 ? 'in_stock' : 'out_of_stock', qty };
  }
  if (/在庫なし|売り切れ|売切れ|SOLD\s*OUT|完売|品切れ|現在、商品はございません/i.test(value)) return { stock: 'out_of_stock', qty: 0 };
  if (/在庫あり|カートに入れる|購入する|予約受付中|予約する/i.test(value)) return { stock: 'in_stock', qty: null };
  return { stock: 'unknown', qty: null };
}

export function cleanText(htmlOrText) {
  return decodeHtmlEntities(stripTags(String(htmlOrText || '')))
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

export function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(Number.parseInt(n, 16)));
}

export function parseAttributes(tag) {
  const out = {};
  const re = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = re.exec(String(tag || '')))) out[match[1].toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4]);
  return out;
}

export function absoluteUrl(base, href) {
  try { return new URL(decodeHtmlEntities(String(href || '')), String(base || '')).toString(); } catch { return href; }
}

export function normalizeUrlKey(url) {
  return String(url || '').replace(/#.*$/, '').replace(/[?&](?:utm_[^=&]+|ref|from)=[^&]*/gi, '');
}

export function stockRank(stock) {
  if (stock === 'in_stock') return 0;
  if (stock === 'unknown') return 1;
  return 2;
}
