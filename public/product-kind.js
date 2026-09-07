// 画面と検索処理で同じ判定を使う。価格だけでBOXと決めつけない。
export function productKind(title) {
  const text = String(title || '').normalize('NFKC');
  // 「1カートン・12BOX」はBOXより先に判定する。
  if (/カートン|carton|ケース販売|\d+\s*ケース/i.test(text)) return 'carton';
  if (/(?<![A-Z0-9])(?:[2-9]|\d{2,})\s*(?:BOX|ボックス|箱)\s*(?:セット|入り|入|まとめ|販売|$|[)）】])/i.test(text)) return 'bundle';
  if (/(?:BOX|ボックス|1\s*箱)/i.test(text)) return 'box';
  if (/パック|pack/i.test(text)) return 'pack';
  return 'unknown';
}

export const KIND_LABELS = { box: 'BOX', carton: 'カートン', bundle: '複数BOXセット', pack: 'パック・単位要確認', unknown: '販売単位不明' };
