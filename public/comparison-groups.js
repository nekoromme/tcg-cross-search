// 表示条件を通過した結果だけをまとめる。ここから店舗への通信は行わない。
// 名前が似ているだけの商品、海外版、数量不明のセットは別々に残す。
export function groupProductRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const c = row.comparison;
    const comparable = row.kind === 'box' && row.detailChecked && c?.status === 'known' && c.productId;
    const key = comparable ? `product:${c.productId}` : `offer:${row.storeId}:${row.url}`;
    if (!groups.has(key)) groups.set(key, { key, comparable: Boolean(comparable),
      name: comparable ? c.productName : row.title, referencePrice: comparable ? c.referencePrice : null, rows: [] });
    groups.get(key).rows.push(row);
  }
  // 元の並び順の先頭商品を基準にグループを並べる。各店の並びも選択した順序を保つ。
  return [...groups.values()].map(group => {
    const prices = group.rows.map(r => r.price).filter(p => Number.isFinite(p) && p > 0);
    const available = group.rows.filter(r => r.stock === 'in_stock');
    const availablePrices = available.map(r => r.price).filter(p => Number.isFinite(p) && p > 0);
    return { ...group, storeCount: new Set(group.rows.map(r => r.storeId)).size,
      availableStores: new Set(available.map(r => r.storeId)).size,
      minPrice: prices.length ? Math.min(...prices) : null,
      availableMinPrice: availablePrices.length ? Math.min(...availablePrices) : null };
  });
}

export function comparisonConditions(row) {
  const conditions = [...(row.conditions || [])];
  const text = String(row.title || '').normalize('NFKC');
  // 付属品や外装条件が書かれていないことを「シュリンクあり」に置き換えない。
  if (!conditions.some(c => /シュリンク/.test(c))) {
    if (/シュリンク(?:なし|無し|無|を剥|をはが|開封)/.test(text)) conditions.push('シュリンクなし・開封条件あり');
    else if (/シュリンク(?:付き|付|あり|有り|有(?!無))/.test(text)) conditions.push('シュリンクあり表記');
    else conditions.push('シュリンク条件未確認');
  }
  if (/店頭受取|店舗受取|店頭引取/.test(text) && !conditions.includes('店頭受取')) conditions.push('店頭受取');
  return [...new Set(conditions)];
}
