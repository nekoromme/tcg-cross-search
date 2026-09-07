import test from 'node:test';
import assert from 'node:assert/strict';
import { createFavoritesStore, normalizeSearch, FAVORITES_KEY } from '../public/saved-searches.js';

function storage() {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
}

test('saved searches survive reload with every filter but never force refresh or results', () => {
  const disk = storage();
  const input = { query: 'GD03', game: 'gundam', depth: 'wide', view: 'list', unit: 'sealed', sort: 'price_desc',
    inStockOnly: true, priceLimit: '100', maxPrice: 6000, includeUnknown: false, includePreorders: false };
  createFavoritesStore(() => disk).save({ ...input, forceRefresh: true, results: [{ price: 123 }] });
  assert.deepEqual(createFavoritesStore(() => disk).read().items, [input]);
});

test('equivalent query spelling deduplicates but different games and price conditions remain separate', () => {
  const disk = storage(), store = createFavoritesStore(() => disk);
  store.save({ query: 'GD03' });
  assert.equal(store.save({ query: ' ｇｄ０３ ' }).duplicate, true);
  store.save({ query: 'GD03', game: 'gundam' });
  store.save({ query: 'GD03', priceLimit: '100' });
  assert.equal(store.read().items.length, 3);
});

test('the limit never silently evicts a saved search and removal can be undone', () => {
  const disk = storage(), store = createFavoritesStore(() => disk);
  for (let i = 0; i < 30; i++) store.save({ query: `商品${i}` });
  assert.match(store.save({ query: '追加商品' }).error, /30件/);
  const removed = store.read().items[5];
  assert.equal(store.remove(removed).items.length, 29);
  assert.equal(store.save(removed).items.length, 30);
  assert.equal(store.read().items[0].query, removed.query);
});

test('storage failure does not report success or overwrite malformed existing data', () => {
  const disk = storage(), store = createFavoritesStore(() => disk);
  store.save({ query: 'GD03' });
  disk.setItem = () => { throw new Error('quota'); };
  assert.ok(store.save({ query: 'GD04' }).error);
  assert.ok(store.remove({ query: 'GD03' }).error);
  assert.equal(store.read().items[0].query, 'GD03');
  const bad = storage(); bad.setItem(FAVORITES_KEY, '{invalid');
  assert.ok(createFavoritesStore(() => bad).save({ query: 'GD05' }).error);
  assert.equal(bad.getItem(FAVORITES_KEY), '{invalid');
  assert.ok(createFavoritesStore(() => { throw new Error('blocked'); }).read().error);
});

test('separate tabs reread before mutation so a second save retains the first tab addition', () => {
  const disk = storage(), first = createFavoritesStore(() => disk), second = createFavoritesStore(() => disk);
  first.read(); second.read();
  first.save({ query: 'GD03' }); second.save({ query: 'GD04' });
  assert.deepEqual(first.read().items.map(x => x.query), ['GD04', 'GD03']);
});

test('invalid stored options cannot restore unsupported filters or unbounded price values', () => {
  const value = normalizeSearch({ query: 'GD03', game: 'invalid', depth: 'unlimited', maxPrice: Infinity, sort: 'invalid' });
  assert.equal(value.game, ''); assert.equal(value.depth, 'standard'); assert.equal(value.maxPrice, null);
  assert.equal(value.sort, 'price_asc'); assert.equal(normalizeSearch({ query: ' ' }), null);
});
