import {
  absoluteUrl,
  cleanText,
  extractPrice,
  extractStock,
  isBoxOrCartonTitle,
  isJunkTitle,
  isLikelyProductUrl,
  isSealedTitle,
  looksLikeSingleCard,
  makeQueryTokens,
  normalizeText,
  normalizeUrlKey,
  parseAttributes,
  textMatchesQuery,
} from './search-common.js';
import { productKind } from '../public/product-kind.js';

export function findCandidateProducts(html, baseUrl, query, sealedOnly = true, limit = 2, preferBoxes = false) {
  if (!html) return [];
  const queryNorm = normalizeText(query);
  const tokens = makeQueryTokens(query);
  const anchorRe = /<a\b([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  const byUrl = new Map();
  let match;
  let inspected = 0;

  while ((match = anchorRe.exec(html)) && inspected < 6000) {
    inspected += 1;
    const href = match[2];
    if (!href || href.startsWith('#') || /^javascript:/i.test(href) || /^mailto:/i.test(href)) continue;
    const url = absoluteUrl(baseUrl, href);
    if (!isLikelyProductUrl(url)) continue;
    if (new URL(url).origin !== new URL(baseUrl).origin) continue;

    const fullAnchor = match[0];
    const attrsText = `${match[1] || ''} ${match[3] || ''}`;
    let title = cleanText(match[4]);
    if (!title || title.length < 2) {
      const img = fullAnchor.match(/<img\b[^>]*>/i);
      if (img) {
        const attrs = parseAttributes(img[0]);
        title = cleanText(attrs.alt || attrs.title || '');
      }
    }
    if (!title) title = cleanText(parseAttributes(`<a ${attrsText}>`).title || '');
    const anchorText = title;
    // カード全体がリンクの店では、価格・在庫まで商品名に含まれている。
    title = title.replace(/\s+(?:販売価格\s*[:：]?\s*)?(?:[￥¥]\s*)?[\d,]+\s*円[\s\S]*$/, '').trim();

    // 次の商品リンクに達したら切る。隣の商品の価格・在庫を混ぜない。
    const tail = html.slice(anchorRe.lastIndex, anchorRe.lastIndex + 1800);
    const nextProduct = [...tail.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)]
      .find((link) => {
        const next = absoluteUrl(baseUrl, link[1]);
        return isLikelyProductUrl(next) && normalizeUrlKey(next) !== normalizeUrlKey(url);
      });
    const context = cleanText(tail.slice(0, nextProduct?.index ?? tail.length));
    const titleNorm = normalizeText(title);
    const contextNorm = normalizeText(context);
    if (!textMatchesQuery(titleNorm, contextNorm, queryNorm, tokens)) continue;

    const sealedTitle = isSealedTitle(title);
    const junkTitle = isJunkTitle(title);
    const singleCard = looksLikeSingleCard(title);
    if (sealedOnly) {
      if (junkTitle) continue;
      if (singleCard) continue;
      if (!sealedTitle && !/新品|未開封|ブースター|パック/i.test(title)) continue;
    }

    let score = 0;
    if (queryNorm.length >= 2 && titleNorm.includes(queryNorm)) score += 35;
    if (queryNorm.length >= 2 && contextNorm.includes(queryNorm)) score += 12;
    for (const token of tokens) {
      if (titleNorm.includes(token)) score += 8;
      else if (contextNorm.includes(token)) score += 2;
    }
    if (sealedTitle) score += 25;
    if (isBoxOrCartonTitle(title)) score += 25;
    if (/カートン/i.test(title)) score += 4;
    if (/新品|未開封/i.test(title)) score += 6;
    if (singleCard) score -= 30;
    if (junkTitle) score -= 50;

    const price = extractPrice(anchorText.slice(title.length)) ?? extractPrice(context);
    const stockInfo = extractStock(anchorText === title ? context : anchorText);
    if (sealedOnly && price != null && price < 500 && !/パック(?!入り)/.test(title)) score -= 10;

    const candidate = {
      title: title || guessTitleFromContext(context, query),
      url,
      price,
      stock: stockInfo.stock,
      stockQty: stockInfo.qty,
      score,
      detailChecked: false,
      kind: productKind(title),
    };
    if (!candidate.title) continue;
    const key = normalizeUrlKey(url);
    const current = byUrl.get(key);
    if (!current || current.score < candidate.score) byUrl.set(key, candidate);
  }

  return [...byUrl.values()]
    .sort((a, b) => {
      if (preferBoxes && (a.kind === 'box') !== (b.kind === 'box')) return a.kind === 'box' ? -1 : 1;
      if (a.score !== b.score) return b.score - a.score;
      if (a.price == null && b.price != null) return 1;
      if (a.price != null && b.price == null) return -1;
      return (a.price || 0) - (b.price || 0);
    })
    .slice(0, limit);
}

function guessTitleFromContext(context, query) {
  const text = String(context || '').replace(/\s+/g, ' ').trim();
  const index = text.toLowerCase().indexOf(String(query || '').toLowerCase());
  if (index >= 0) return text.slice(Math.max(0, index - 60), index + String(query).length + 100).trim();
  return text.slice(0, 140).trim();
}
