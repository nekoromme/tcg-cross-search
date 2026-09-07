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
        if (offers['@type'] === 'AggregateOffer' || (offers.price == null && (offers.lowPrice != null || offers.highPrice != null))) {
          out.priceComparable = false; out.priceIssue = '価格帯のため販売価格を特定できず';
        }
        const price = Number(offers.price);
        if (Number.isFinite(price) && price > 0) out.price = Math.round(price);
        if (offers.priceCurrency && offers.priceCurrency !== 'JPY') {
          out.price = null; out.priceComparable = false; out.priceIssue = '日本円の価格を確認できず';
        }
        if (Array.isArray(product.offers) && product.offers.length > 1) {
          out.price = null; out.priceComparable = false; out.priceIssue = '複数の販売条件があるため要確認';
        }
        const availability = String(offers.availability || '').toLowerCase();
        if (/instock|limitedavailability/.test(availability)) out.stock = 'in_stock';
        if (/preorder|presale/.test(availability)) out.stock = 'preorder';
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
  const priceText = mainText.normalize('NFKC');
  // 税抜だけのページを税込の定価と比較しない。税込併記は明示された金額を採用。
  if (/税抜|税別/.test(priceText)) {
    const inclusive = priceText.match(/(?:税込(?:価格)?\s*[:：]?\s*[¥￥]?\s*([\d,]+)\s*円)|(?:([\d,]+)\s*円\s*\(?税込\)?)/);
    const gross = inclusive && parseMoney(inclusive[1] || inclusive[2]);
    if (gross) out.price = gross;
    else { out.priceComparable = false; out.priceIssue = '税込価格を確認できず'; }
  }
  const currency = getMetaContent(html, 'product:price:currency');
  if (currency && currency !== 'JPY') { out.priceComparable = false; out.priceIssue = '日本円の価格を確認できず'; }
  // 会員・クーポン前提の金額しか判別できない場合は、安値と断定しない。
  if (/(?:会員(?:限定)?価格|クーポン(?:適用|利用)後|ポイント(?:還元)?後)\s*[:：]?\s*[¥￥]?\s*[\d,]+/.test(priceText)) {
    out.priceComparable = false; out.priceIssue = '会員・割引条件付きの価格は要確認';
  }
  if (out.stock === 'unknown') {
    const stock = extractStock(mainText);
    if (stock.stock !== 'unknown') { out.stock = stock.stock; out.stockQty = stock.qty; }
  } else {
    // 構造化データで在庫が分かっていても、同じ商品の数量は拾う。
    const stock = extractStock(mainText);
    if (stock.stock === out.stock) out.stockQty = stock.qty;
    // 構造化データと画面で矛盾した場合は、売切表記を優先し誤って在庫ありにしない。
    if (stock.stock === 'out_of_stock') { out.stock = stock.stock; out.stockQty = 0; }
    else if (stock.stock === 'preorder' && out.stock === 'in_stock') { out.stock = 'preorder'; out.stockQty = stock.qty; }
  }
  if (out.stock === 'in_stock' && /予約|発売予定/.test(out.title)) out.stock = 'preorder';
  const conditions = [];
  if (/シュリンク(?:なし|無し|無|を剥|をはが|開封)|シュリンクが(?:ない|無い)/.test(out.title + ' ' + mainText)) conditions.push('シュリンクなし・開封条件あり');
  if (/店頭受取|店舗受取|店頭引取/.test(out.title)) conditions.push('店頭受取');
  if (conditions.length) out.conditions = conditions;
  if (out.priceComparable === false) out.price = null;
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
  // 二木のMakeShop画面は見出しタグを使わず div.item-title に商品名を置いている。
  // 内側の売切バッジやカテゴリ名を除き、購入対象の商品名だけを取り出す。
  const makeshop = html.match(/<div\b[^>]*class=["']item-title["'][^>]*>([\s\S]*?)<\/div>\s*(?=<(?!\/div))/i);
  if (makeshop) {
    // 入れ子の最初の div で切らないよう、価格領域の直前までを限定して再取得する。
    const section = html.slice(makeshop.index, makeshop.index + 6000);
    const end = section.search(/<(?:div|p)\b[^>]*class=["'][^"']*(?:item-price|price-area)/i);
    const titleRegion = (end >= 0 ? section.slice(0,end) : makeshop[0])
      .replace(/<(?:div|p)\b[^>]*class=["'][^"']*(?:item-detail-icon|item-category-name)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|p)>/gi, ' ')
      .replace(/SOLD\s*OUT/gi, ' ');
    const title = cleanText(titleRegion);
    if (title && title.length < 500) return Object.assign([makeshop[0], '', title], { index: makeshop.index });
  }
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
