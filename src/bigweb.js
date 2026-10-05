const CODE = /\[(GD\d{2})\]/i;
const NORMAL_BOX = /ブースターパック[\s\S]*\bBOX\s*[（(]?\s*24\s*パック入\s*[）)]?/i;
const EXCLUDED = /(?:ハーフストレージ|デッキボックス|スタートデッキ|プレミアムカード|セット|英語版|海外版|中国語|韓国語)/i;

export function parseBigwebCatalog(text, store, diagnostics = {}) {
  let payload;
  try { payload = JSON.parse(String(text || '')); }
  catch { throw new Error('BIGWEBの商品一覧JSONを解析できません'); }
  if (payload?.success !== true || !Array.isArray(payload.items)) throw new Error('BIGWEBの商品一覧形式を確認できません');

  diagnostics.items = payload.items.length;
  diagnostics.accepted = 0;
  diagnostics.excludedOther = 0;
  const rows = [];
  for (const item of payload.items) {
    const title = String(item?.name || '').normalize('NFKC').trim();
    const code = title.match(CODE)?.[1]?.toUpperCase();
    const languageId = Number(item?.lang ?? item?.language?.id);
    const valid = Number.isInteger(item?.id) && item.id > 0
      && Number(item.game_id) === Number(store.catalog.gameId)
      && item.is_box === true && languageId === 0 && code
      && NORMAL_BOX.test(title) && !EXCLUDED.test(title)
      && (!item.cardset?.web || String(item.cardset.web).toUpperCase() === code);
    if (!valid) { diagnostics.excludedOther++; continue; }

    const quantity = Number(item.stock_count);
    let stock = 'unknown';
    if (item.is_sold_out === true || quantity === 0) stock = 'out_of_stock';
    else if (item.is_sold_out === false && Number.isFinite(quantity) && quantity > 0)
      stock = item.is_preorder_item === true ? 'preorder' : 'in_stock';
    const price = Number(item.price);
    const comparablePrice = Number.isFinite(price) && price > 0 ? Math.round(price) : null;
    rows.push({
      title,
      url: `${store.catalog.productBase}${item.id}`,
      price: comparablePrice,
      stock,
      stockQty: Number.isFinite(quantity) && quantity >= 0 ? Math.floor(quantity) : null,
      detailChecked: true,
      priceComparable: comparablePrice != null,
      ...(comparablePrice == null ? { priceIssue: '販売価格を確認できず' } : {}),
      kind: 'box',
      source: 'official_json_api',
    });
    diagnostics.accepted++;
  }
  return rows;
}

export function findBigwebProduct(text, store, productUrl) {
  const url = new URL(productUrl);
  const id = url.pathname.match(/\/cardViewer\/(\d+)\/?$/)?.[1];
  if (!id) return null;
  return parseBigwebCatalog(text, store).find(row => row.url.endsWith(`/cardViewer/${id}`)) || null;
}
