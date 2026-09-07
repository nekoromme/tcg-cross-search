import { cleanText, parseAttributes } from './search-common.js';

const PAGE_FIELDS = ['page', 'pageno', 'page_no'];
// 店が表示した「次へ」だけを読む。全商品一覧や外部URLへ検索が逸れないよう検証する。
export function findNextSearchPage(html, currentUrl, store) {
  const current = new URL(currentUrl);
  const candidates = [];
  for (const match of String(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>|<link\b([^>]*)>/gi)) {
    const attrs = parseAttributes(match[1] || match[3]);
    if (!attrs.href) continue;
    const label = cleanText(match[2] || '') || attrs.title || attrs['aria-label'] || '';
    let next;
    try { next = new URL(attrs.href, current); } catch { continue; }
    if (next.origin !== current.origin || next.pathname !== current.pathname || next.username || next.password) continue;
    const pageField = PAGE_FIELDS.find(field => next.searchParams.has(field));
    if (!pageField) continue;
    const number = Number(next.searchParams.get(pageField));
    const oldNumber = Number(current.searchParams.get(pageField) || 1);
    if (!Number.isInteger(number) || number !== oldNumber + 1 || number > 100) continue;
    const isNext = /(?:^|\s)next(?:\s|$)/i.test(attrs.rel || '') || /次|next|^[>›»→]+$/i.test(label);
    if (!isNext && label !== String(number)) continue;
    // ページ番号以外の検索条件は同じものだけ。省略された条件は元の値を引き継ぐ。
    let valid = true;
    for (const [key, value] of current.searchParams) {
      if (PAGE_FIELDS.includes(key)) continue;
      if (next.searchParams.has(key) && next.searchParams.get(key) !== value) { valid = false; break; }
      next.searchParams.set(key, value);
    }
    for (const [key] of next.searchParams) {
      if (!PAGE_FIELDS.includes(key) && !current.searchParams.has(key)) valid = false;
    }
    if (!valid || next.searchParams.get(store.field) !== current.searchParams.get(store.field)) continue;
    next.hash = '';
    candidates.push({ url: next.href, priority: isNext ? 0 : 1 });
  }
  return candidates.sort((a,b) => a.priority - b.priority)[0]?.url || null;
}
