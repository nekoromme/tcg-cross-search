import { cleanText, decodeHtmlEntities, extractPrice, extractStock, normalizeText, parseAttributes, parseMoney } from './search-common.js';

export function parseProductDetail(html) {
  const out = { title: '', price: null, stock: 'unknown', stockQty: null };
  if (!html) return out;

  const scripts = html.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const script of scripts) {
    const bodyMatch = script.match(/>([\s\S]*?)<\/script>/i);
    if (!bodyMatch) continue;
    try {
      const product = findProductJsonLd(JSON.parse(decodeHtmlEntities(bodyMatch[1]).trim()));
      if (!product) continue;
      if (product.name) out.title = cleanText(String(product.name));
      const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
      if (offers) {
        const price = Number(offers.price || offers.lowPrice || offers.highPrice);
        if (Number.isFinite(price) && price > 0) out.price = Math.round(price);
        const availability = String(offers.availability || '').toLowerCase();
        if (/instock|limitedavailability|preorder/.test(availability)) out.stock = 'in_stock';
        if (/outofstock|soldout|discontinued/.test(availability)) out.stock = 'out_of_stock';
      }
      break;
    } catch {}
  }

  if (out.price == null) {
    const patterns = [
      /<meta\b[^>]*(?:property|itemprop)=["'](?:product:price:amount|price)["'][^>]*content=["']([0-9,.]+)["'][^>]*>/i,
      /<meta\b[^>]*content=["']([0-9,.]+)["'][^>]*(?:property|itemprop)=["'](?:product:price:amount|price)["'][^>]*>/i,
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (!match) continue;
      const price = parseMoney(match[1]);
      if (price != null) { out.price = price; break; }
    }
  }

  const productHeading = findProductHeading(html);
  const mainText = cleanText(extractMainProductRegion(html, productHeading));
  // 店名のh1より、商品名として指定された見出し・共有用の商品名を優先する。
  // アドバンテージなどでは、商品名はh2#product_nameにある。
  if (!out.title && productHeading) out.title = cleanText(productHeading[2]);
  if (!out.title) out.title = getMetaContent(html, 'og:title');
  if (!out.title) {
    const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1) out.title = cleanText(h1[1]);
  }
  if (!out.title) {
    const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    if (title) out.title = cleanText(title[1]).replace(/\s*[|｜].*$/, '').trim();
  }
  if (out.price == null) out.price = extractPrice(mainText);
  if (out.stock === 'unknown') {
    const stock = extractStock(mainText);
    if (stock.stock !== 'unknown') { out.stock = stock.stock; out.stockQty = stock.qty; }
  } else {
    // 構造化データで在庫が分かっていても、同じ商品の数量は拾う。
    const stock = extractStock(mainText);
    if (stock.stock === out.stock) out.stockQty = stock.qty;
  }
  return out;
}

function extractMainProductRegion(html, productHeading) {
  const source = String(html || '');
  // 商品名の直前にあるナビゲーションやカート内の在庫表記は読まない。
  // 商品の位置を特定できないページ全体から価格を拾わない。
  if (!productHeading) return '';
  const region = source.slice(productHeading.index, productHeading.index + 45000);
  const boundary = region.search(/<(?:div|section|aside|ul)\b[^>]*(?:id|class)=["'][^"']*(?:related|recommend|recently|checked-contents)[^"']*["']|<h[2-6]\b[^>]*>\s*(?:おすすめ|関連商品|最近チェック)|<!--\s*(?:関連商品|おすすめ|最近チェック)/i);
  return (boundary < 0 ? region : region.slice(0, boundary)).replace(/<!--[\s\S]*?-->/g, ' ');
}

function getMetaContent(html, property) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = parseAttributes(tag);
    if (attrs.property === property || attrs.name === property) return cleanText(attrs.content || '');
  }
  return '';
}

function findProductHeading(html) {
  const headings = [...html.matchAll(/<h[1-6]\b([^>]*)>([\s\S]*?)<\/h[1-6]>/gi)];
  const named = headings.find((heading) => {
    const attrs = parseAttributes(heading[1]);
    return /(?:product|item)[_-](?:name|title)/i.test(`${attrs.id || ''} ${attrs.class || ''}`);
  });
  if (named) return named;
  const metaTitle = normalizeText(getMetaContent(html, 'og:title'));
  if (metaTitle) {
    const matching = headings.find((heading) => normalizeText(cleanText(heading[2])) === metaTitle);
    if (matching) return matching;
  }
  return headings.find((heading) => /^<h1\b/i.test(heading[0]));
}

function findProductJsonLd(obj) {
  if (!obj) return null;
  if (Array.isArray(obj)) {
    for (const item of obj) { const result = findProductJsonLd(item); if (result) return result; }
    return null;
  }
  if (typeof obj !== 'object') return null;
  const type = obj['@type'];
  if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) return obj;
  if (obj['@graph']) return findProductJsonLd(obj['@graph']);
  // ItemList内のおすすめ商品は、表示中の商品の証拠にしない。
  return null;
}
