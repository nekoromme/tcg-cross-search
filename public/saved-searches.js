// お気に入りには「検索の条件」だけを保存する。価格・在庫は再検索で確認する。
// 保存先はこのブラウザ内。通信やアカウント登録は必要ない。
export const FAVORITES_KEY = 'tcg-saved-searches-v1';
export const FAVORITES_LIMIT = 30;
const pick = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;

export function normalizeSearch(input) {
  if (!input || typeof input.query !== 'string' || !input.query.trim()) return null;
  const price = Number(input.maxPrice);
  return {
    query: input.query.trim().slice(0, 100),
    game: pick(input.game, ['pokemon', 'onepiece', 'gundam', 'dragonball', 'lorcana'], ''),
    depth: pick(input.depth, ['standard', 'wide'], 'standard'),
    view: pick(input.view, ['grouped', 'list'], 'grouped'),
    unit: pick(input.unit, ['box', 'sealed', 'all'], 'box'),
    sort: pick(input.sort, ['price_asc', 'price_desc', 'stock', 'store', 'discount'], 'price_asc'),
    inStockOnly: input.inStockOnly === true,
    priceLimit: pick(input.priceLimit, ['100', '105', '110', 'all'], '105'),
    maxPrice: Number.isFinite(price) && price >= 1 && price <= 99999999 ? Math.floor(price) : null,
    includeUnknown: input.includeUnknown !== false,
    includePreorders: input.includePreorders !== false,
  };
}

export function favoriteKey(input) {
  const search = normalizeSearch(input);
  if (!search) return '';
  // 大文字・小文字や全角の違いだけなら重複登録しない。検索条件が違えば別保存。
  return JSON.stringify({ ...search, query: search.query.normalize('NFKC').toLowerCase() });
}

export function createFavoritesStore(getStorage = () => globalThis.localStorage) {
  function read() {
    try {
      const value = JSON.parse(getStorage().getItem(FAVORITES_KEY) || '[]');
      if (!Array.isArray(value)) throw new Error('invalid format');
      const unique = new Map();
      for (const entry of value) {
        const search = normalizeSearch(entry);
        if (search) unique.set(favoriteKey(search), search);
      }
      return { items: [...unique.values()], error: null };
    } catch {
      return { items: [], error: 'お気に入りを読み込めません。ブラウザの保存設定を確認してください。通常の検索は使えます。' };
    }
  }

  function write(items) {
    try {
      getStorage().setItem(FAVORITES_KEY, JSON.stringify(items));
      return { items, error: null };
    } catch {
      // 保存失敗を成功扱いにしない。元の保存内容も画面に残す。
      return { ...read(), error: '保存できませんでした。ブラウザの空き容量や保存設定を確認してください。' };
    }
  }

  return {
    read,
    save(input) {
      const state = read();
      if (state.error) return state;
      const search = normalizeSearch(input);
      if (!search) return { ...state, error: '保存する商品名・型番を入力してください。' };
      if (state.items.some(item => favoriteKey(item) === favoriteKey(search))) return { ...state, duplicate: true };
      if (state.items.length >= FAVORITES_LIMIT) return { ...state, error: `お気に入りは${FAVORITES_LIMIT}件までです。不要なものを削除してから保存してください。` };
      // 操作のたびに読み直し、別タブで追加したお気に入りを不用意に上書きしない。
      return write([search, ...state.items]);
    },
    remove(input) {
      const state = read();
      if (state.error) return state;
      return write(state.items.filter(item => favoriteKey(item) !== favoriteKey(input)));
    },
  };
}
