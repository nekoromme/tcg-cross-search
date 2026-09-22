import { cleanText } from './search-common.js';

// 商品が無い根拠は、店舗が表示する検索件数・空結果の文言だけに限定する。
// 「カート0件」「閲覧履歴なし」や、読み取れないページを売切れ扱いしない。
export function emptySearchEvidence(html) {
  const visible = String(html || '').replace(/<(script|style|select)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const text = cleanText(visible);
  const message = text.match(/お探しの商品は見つかりませんでした|(?:ご指定の条件|検索条件)に一致する商品が見つかりませんでした|該当する商品(?:は|が)(?:ありません|ございません)|検索条件に一致する商品(?:は|が)(?:ありません|ございません)/);
  if (message) return message[0];
  // おちゃのこネットの実ページで確認した検索結果件数。単なる0という数字は使わない。
  if (/class=["'][^"']*\b(?:count_number|item_count|number_box)\b[^"']*["'][^>]*>\s*(?:<[^>]+>\s*)*0\s*(?:<[^>]+>\s*)*件/i.test(visible)
    || /登録アイテム数\s*[:：]\s*0\s*件|総\s*0\s*件/.test(text)) return '検索結果0件';
  return null;
}

export function searchPageEvidence(html, stats, candidates, truncated = false) {
  const empty = emptySearchEvidence(html);
  if (truncated) return { outcome: 'unreadable', reason: 'ページの容量上限' };
  if (candidates.length) return { outcome: 'matched' };
  if (empty) return { outcome: 'empty', reason: empty };
  if (stats.matchingLinks > 0 && stats.matchingLinks === stats.excludedSingles + stats.excludedOther)
    return { outcome: 'excluded', reason: '一致した商品はシングル・用品等' };
  return { outcome: 'unreadable', reason: stats.productLinks > 0
    ? '検索語に一致する商品リンクなし。空結果の明示も確認できず'
    : '商品リンクと検索結果件数を確認できず' };
}
