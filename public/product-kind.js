// 画面と検索処理で同じ判定を使う。価格だけでBOXと決めつけない。
export function isSpecialSet(title) {
  const text = String(title || '').normalize('NFKC');
  // 通常BOXと同じ弾名を含んでいても、デッキや付属品とのセットは別商品。
  return /カード\s*セット|card[\s_-]*set|デッキビルド\s*(?:BOX|ボックス)|トレーナー(?:ズ)?\s*(?:BOX|ボックス)|ポケモンセンターセット|ポケセンセット|アタッシュケース|デラックス|プレミアムセット|ギフトセット|特別セット|スターター|スタートデッキ|構築済|デッキボックス|ロングカードボックス|ストレージ(?:ボックス|BOX)|FUTURISTIC|プレミアムデッキ/i.test(text)
    || (isPokemon30thTitle(text) && /9\s*(?:種|种)|御三家|最初のパートナー|first[\s_-]*partner|elite[\s_-]*trainer|\bETB\b|(?:ultra[\s_-]*)?premium[\s_-]*collection|booster[\s_-]*bundle|mini[\s_-]*tin|poster[\s_-]*collection|tech[\s_-]*sticker|battle[\s_-]*deck/i.test(text));
}
export function isPokemon30thTitle(title) {
  const text=String(title||'').normalize('NFKC');
  return /30\s*th[\s_-]*CELEBRATION|30周年\s*セレブレーション|(?:ポケモン(?:カードゲーム)?|ポケカ|pokemon)\s*30\s*th|(?<![A-Z0-9])M6[\s_-]*a(?![A-Z0-9])/i.test(text);
}
export function productKind(title) {
  const text = String(title || '').normalize('NFKC');
  // カードセットの「未開封BOX」「カートン」も通常拡張BOXとは別物。
  if (isSpecialSet(text)) return 'special';
  // 「1カートン・12BOX」はBOXより先に判定する。
  if (/カートン|carton|ケース販売|\d+\s*ケース/i.test(text)) return 'carton';
  // 先頭0の弾番号（MANGA BOOSTER 01/02 BOX）を複数BOXと誤認しない。
  if (/(?<![A-Z0-9])(?:[2-9]|[1-9]\d+)\s*(?:BOX|ボックス|箱)|(?:BOX|ボックス|箱)\s*[×x*]\s*(?:[2-9]|[1-9]\d+)|(?:BOX|ボックス)\s*(?:[2-9]|[1-9]\d+)\s*個/i.test(text)) return 'bundle';
  if (/(?:BOX|ボックス|1\s*箱)/i.test(text)) return 'box';
  if (/パック|pack/i.test(text)) return 'pack';
  return 'unknown';
}

export const KIND_LABELS = { box: 'BOX', carton: 'カートン', bundle: '複数BOXセット', special: '特別セット・関連商品', pack: 'パック・単位要確認', unknown: '販売単位不明' };
