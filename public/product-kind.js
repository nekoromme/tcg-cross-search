// 画面と検索処理で同じ判定を使う。価格だけでBOXと決めつけない。
export function isSpecialSet(title) {
  // 通常BOXと同じ弾名を含んでいても、デッキや付属品とのセットは別商品。
  return /デッキビルド\s*(?:BOX|ボックス)|トレーナー(?:ズ)?\s*(?:BOX|ボックス)|ポケモンセンターセット|ポケセンセット|アタッシュケース|デラックス|プレミアムセット|ギフトセット|特別セット|スターター|スタートデッキ|構築済|デッキボックス/i.test(String(title || '').normalize('NFKC'));
}
export function productKind(title) {
  const text = String(title || '').normalize('NFKC');
  // 「1カートン・12BOX」はBOXより先に判定する。
  if (/カートン|carton|ケース販売|\d+\s*ケース/i.test(text)) return 'carton';
  if (isSpecialSet(text)) return 'special';
  // 先頭0の弾番号（MANGA BOOSTER 01/02 BOX）を複数BOXと誤認しない。
  if (/(?<![A-Z0-9])(?:[2-9]|[1-9]\d+)\s*(?:BOX|ボックス|箱)|(?:BOX|ボックス|箱)\s*[×x*]\s*(?:[2-9]|[1-9]\d+)|(?:BOX|ボックス)\s*(?:[2-9]|[1-9]\d+)\s*個/i.test(text)) return 'bundle';
  if (/(?:BOX|ボックス|1\s*箱)/i.test(text)) return 'box';
  if (/パック|pack/i.test(text)) return 'pack';
  return 'unknown';
}

export const KIND_LABELS = { box: 'BOX', carton: 'カートン', bundle: '複数BOXセット', special: '特別セット・関連商品', pack: 'パック・単位要確認', unknown: '販売単位不明' };
