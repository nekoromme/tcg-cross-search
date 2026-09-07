import { PRODUCTS, CATALOG_UPDATED } from './catalog-data.js';
import { productKind, isSpecialSet } from './product-kind.js';
export { PRODUCTS, CATALOG_UPDATED };

export const GAMES = { pokemon: 'ポケモンカード', onepiece: 'ワンピース', gundam: 'ガンダム', dragonball: 'ドラゴンボール（フュージョンワールド）', lorcana: 'ロルカナ' };
const GAME_PATTERNS = { pokemon: /ポケモン|ポケカ|pokemon/i, onepiece: /ワンピース|one\s*piece/i,
  gundam: /ガンダム|gundam/i, dragonball: /ドラゴンボール|dragon\s*ball|フュージョンワールド/i, lorcana: /ロルカナ|lorcana/i };
export function normalized(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\-‐‑–—_【】「」『』()（）・:：]/g, '');
}
export function explicitGame(title) {
  const games = Object.entries(GAME_PATTERNS).filter(([,pattern]) => pattern.test(title)).map(([game]) => game);
  return games.length === 1 ? games[0] : '';
}
// GD05 と GD050、OP-01 と OP-010 を混同しない。表記ゆれのハイフン・空白だけ許す。
export function hasCode(title, code) {
  return codePattern(code)?.test(String(title).normalize('NFKC')) || false;
}
function codePattern(code) {
  const parts = code.match(/^([a-z]+)-?(\d+[a-z]*)$/i);
  return parts ? new RegExp(`(?<![a-z0-9])${parts[1]}[\\s_-]*${parts[2]}(?![a-z0-9])`, 'i') : null;
}
// HTML内のリンクごとに正規表現・商品名の正規化を繰り返さない。
const catalogIndex = PRODUCTS.map(product => ({ product, aliases: product.aliases.map(normalized), code:codePattern(product.code) }));
export function identifyProduct(title, gameHint = '') {
  const text = normalized(title);
  const original = String(title || '').normalize('NFKC');
  const game = explicitGame(title) || gameHint;
  const matches = catalogIndex.filter(({product:p, aliases, code}) => (!game || p.game === game) &&
    (aliases.some(alias => text.includes(alias)) || (code && (!p.ambiguousCode || game === p.game) && code.test(original))));
  // 「EB01」など複数タイトルで使う番号は、ゲーム名・正式商品名がなければ未確定。
  if (matches.length !== 1) return null;
  return matches[0].product;
}
export function matchesQuery(title, query) {
  return createQueryMatcher(query)(title);
}
export function createQueryMatcher(query) {
  const q = normalized(query);
  const wanted = identifyProduct(query);
  const recognized = wanted && [wanted.code, ...wanted.aliases].filter(Boolean).some(a => normalized(a) === q);
  const tokens = String(query).normalize('NFKC').split(/[\s/／,，・:：【】\[\]()（）]+/).filter(Boolean)
    .map(token => ({ text:normalized(token), code:codePattern(token) }));
  return title => {
    const source = normalized(title);
    if (wanted) {
    const actual = identifyProduct(title, wanted.game);
    if (!actual || actual.id !== wanted.id) return false;
    // 商品番号以外に指定した BOX 等の条件も残す。商品名だけの別名検索は同一商品として扱う。
    if (recognized) return true;
    }
    return tokens.length > 0 && tokens.every(token => token.code ? token.code.test(String(title).normalize('NFKC')) : source.includes(token.text));
  };
}
export function searchTerms(query) {
  const p = identifyProduct(query);
  if (!p) return [String(query).normalize('NFKC')];
  const q = normalized(query);
  if (![p.code, ...(p.aliases || [])].filter(Boolean).some(a => normalized(a) === q)) return [query];
  // 店の検索には型番か正式名を使う。別表記での再検索は候補が無い場合に1回だけ。
  return [...new Set([p.searchTerm || p.name, p.name])];
}
export function comparePrice(row) {
  const product = identifyProduct(row.title);
  if (!product) return { status: 'unknown', reason: '商品を定価台帳で特定できず' };
  const base = { productId: product.id, game: product.game, productName: product.name, sources: product.sources,
    referencePrice: product.boxPrice, basis: product.basis, checkedAt: product.checkedAt };
  if (/英語版|海外版|中国語|韓国語|繁体|繁體|簡体|简体|english(?:\s*(?:ver|version|edition))?|\bEN\b/i.test(row.title))
    return { ...base, status: 'unknown', reason: '日本語版と価格を比較できず' };
  if ((row.kind || productKind(row.title)) !== 'box') return { ...base, status: 'unknown', reason: '1BOX以外は定価比較の対象外' };
  if (isSpecialSet(row.title))
    return { ...base, status: 'unknown', reason: '通常のブースターBOXと仕様が異なる可能性' };
  if (!product.boxPrice) return { ...base, status: 'unknown', reason: 'BOX定価の資料を確認中' };
  if (!row.detailChecked || !Number.isInteger(row.price) || row.price <= 0 || row.priceComparable === false)
    return { ...base, status: 'unknown', reason: row.priceIssue || '税込商品価格を確認できず' };
  return { ...base, status: 'known', difference: row.price - product.boxPrice, percent: (row.price / product.boxPrice - 1) * 100 };
}
export function withinPriceLimit(row, comparison, percent) {
  // 表示用に丸めた割合で判定しない。6,300円は通し6,301円は除外する。
  return comparison.status === 'known' && row.price * 100 <= comparison.referencePrice * percent;
}
