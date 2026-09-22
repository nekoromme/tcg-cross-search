import { cleanText, parseAttributes } from './search-common.js';

// Day屋は該当なしでも0件表示が出ない。店のフォームが実際に公開している
// 新品カテゴリーだけを補助確認し、知らないカテゴリー番号は推測しない。
export function sealedCategoryUrls(html, store) {
  if (store.id !== 'dayya') return [];
  const select = [...String(html).matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)]
    .find(m => parseAttributes(m[1]).name === 'category_id');
  if (!select) return [];
  const found = [];
  for (const m of select[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)) {
    const label = cleanText(m[2]);
    const id = parseAttributes(m[1]).value;
    if (!['新品', '新品その他'].includes(label) || !/^\d+$/.test(id || '')) continue;
    const url = new URL(store.action); url.searchParams.set('category_id', id);
    found.push({ url: url.href, label });
  }
  return found.slice(0, 2);
}

// 追加確認は既に許可した店舗の検索ページだけ。任意のURLを取得する機能にしない。
export function validateContinuation(raw, store, terms) {
  if (!raw) return null;
  const url = new URL(raw), action = new URL(store.action);
  if (url.origin !== action.origin || url.pathname !== action.pathname || url.username || url.password || url.hash)
    throw new Error('追加確認の検索先が不正です');
  const allowed = new Set([store.field, ...Object.keys(store.fixed || {}), 'page', 'pageno', 'page_no', ...(store.pageFields || [])]);
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key)) throw new Error('追加確認の検索条件が不正です');
    if (['page', 'pageno', 'page_no', ...(store.pageFields || [])].includes(key) && key !== store.field
      && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100)) throw new Error('追加確認のページ番号が不正です');
  }
  const allowedTerms = [...terms, `${terms[0]} ${store.boxKeyword || 'BOX'}`]
    .map(t => store.boxKeyword ? t.replace(/(^|\s)BOX(?=\s|$)/gi, `$1${store.boxKeyword}`) : t);
  if (!allowedTerms.includes(url.searchParams.get(store.field))) throw new Error('追加確認で検索語は変更できません');
  for (const [key,value] of Object.entries(store.fixed || {})) if (url.searchParams.get(key) !== String(value))
    throw new Error('追加確認の固定条件が不正です');
  return url.href;
}
