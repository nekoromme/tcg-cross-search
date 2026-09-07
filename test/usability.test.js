import test from 'node:test';
import assert from 'node:assert/strict';
import { productKind } from '../public/product-kind.js';
import { flattenRows, selectRows, renderRows } from '../public/ui.js';
import { findCandidateProducts, parseProductDetail } from '../src/search.js';
import worker from '../src/index.js';

// 実店舗にある「1カートン・12BOX・1BOXあたり○円」も先にカートンと判定。
test('classifies carton and multi-box offers before BOX, including full-width titles', () => {
  for (const [title, expected] of [
    ['GD03 1カートン(12BOX入り)(1BOXあたり5808円)', 'carton'],
    ['ＧＤ０３ １ＢＯＸ・２４パック入', 'box'], ['GD03 12BOXセット', 'bundle'],
    ['GD03 ボックス', 'box'], ['GD03 ブースターパック', 'pack'], ['GD03 新品', 'unknown'],
  ]) assert.equal(productKind(title), expected, title);
});

const fixture = new Map([['a', { store: { id: 'a', name: 'A店' }, results: [
  { title: 'GD03 BOX', url: 'https://a/box', price: 5808, stock: 'in_stock', detailChecked: true },
  { title: 'GD03 BOX', url: 'https://a/cheap', price: 4780, stock: 'out_of_stock', detailChecked: true },
  { title: 'GD03 カートン(12BOX)', url: 'https://a/carton', price: 60000, stock: 'in_stock', detailChecked: true },
  { title: 'GD03 BOX', url: 'https://a/no-price', price: null, stock: 'out_of_stock', detailChecked: true },
  { title: 'GD03 BOX', url: 'https://a/unknown-stock', price: 1000, stock: 'unknown', detailChecked: true },
  { title: 'GD03 BOX', url: 'https://a/listing-only', price: 1200, stock: 'in_stock', detailChecked: false },
  { title: 'GD03 パック', url: 'https://a/pack', price: 240, stock: 'in_stock', detailChecked: true },
] }]]);

test('default shows only confirmed BOX in ascending price, regardless of stock', () => {
  const rows = selectRows(fixture);
  assert.deepEqual(rows.main.map(x => x.price), [4780, 5808]);
  assert.equal(rows.review.length, 3);
  assert.equal(rows.hidden, 2);
});

test('filters and sort work on the same results without searching again', () => {
  assert.deepEqual(selectRows(fixture, { sort: 'price_desc' }).main.map(x => x.price), [5808, 4780]);
  assert.deepEqual(selectRows(fixture, { sort: 'stock' }).main.map(x => x.stock), ['in_stock', 'out_of_stock']);
  assert.equal(selectRows(fixture, { unit: 'sealed' }).main.length, 3);
  assert.equal(selectRows(fixture, { unit: 'all' }).main.length, 4);
  assert.deepEqual(selectRows(fixture, { inStockOnly: true }).main.map(x => x.price), [5808]);
  assert.equal(flattenRows(fixture, 'price_desc').at(-1).price, null);
});

test('store sort is alphabetical and equal prices remain stable', () => {
  const data = new Map([['z', { store: { id: 'z', name: 'Z店' }, results: [{ title: 'BOX', url: 'https://z', price: 100 }] }],
    ['a', { store: { id: 'a', name: 'A店' }, results: [{ title: 'BOX', url: 'https://a', price: 300 }] }]]);
  assert.deepEqual(flattenRows(data, 'store').map(x => x.storeName), ['A店', 'Z店']);
});

test('nearby matching products cannot make unrelated links match', () => {
  const html = '<a href="/product/1">GD02 BOX</a><span>GD03 新品 在庫あり 5000円</span>' +
    '<a href="/product/2">GD03 BOX</a><span>5808円 在庫なし</span>';
  assert.deepEqual(findCandidateProducts(html, 'https://shop.test/', 'GD03', true, 8).map(x => x.url), ['https://shop.test/product/2']);
  assert.equal(findCandidateProducts(html, 'https://shop.test/', 'GD03 Requiem', true, 8).length, 0);
});

test('missing listing price is not borrowed from next product', () => {
  const html = '<a href="/product/1">GD03 BOX</a>' +
    '<a href="/product/2">GD03 BOX 別商品</a><span>9999円 在庫あり</span>';
  const first = findCandidateProducts(html, 'https://shop.test/', 'GD03', true, 8).find(x => x.url.endsWith('/1'));
  assert.equal(first.price, null);
  assert.equal(first.stock, 'unknown');
});

test('BOX candidates survive even if many cartons appear first', () => {
  const html = Array.from({ length: 20 }, (_, n) => `<a href="/product/${n}">GD03 カートン ${n}</a>`).join('') +
    '<a href="/product/99">GD03 BOX</a>';
  assert.equal(findCandidateProducts(html, 'https://shop.test/', 'GD03', true, 8, true)[0].kind, 'box');
});

test('accessories and off-site product links do not enter sealed results', () => {
  const html = '<a href="/product/1">GD03 新品 ストレージボックス</a>' +
    '<a href="https://other.test/product/2">GD03 BOX</a>';
  assert.equal(findCandidateProducts(html, 'https://shop.test/', 'GD03', true, 8).length, 0);
});

test('recommendations cannot supply price or stock to current product', () => {
  const result = parseProductDetail('<h1>GD03 BOX</h1><div>販売価格: 0円</div><div class="related-items">GD02 BOX 9999円 在庫数 99</div>');
  assert.equal(result.price, null);
  assert.equal(result.stock, 'unknown');
  assert.equal(parseProductDetail('<title>GD03 BOX</title><aside>おすすめ 9999円 在庫あり</aside>').price, null);
});

test('recommendation JSON-LD does not override the current product', () => {
  const result = parseProductDetail('<script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"@type":"Product","name":"GD02 BOX","offers":{"price":100}}]}</script><h1>GD03 BOX</h1><p>5808円 在庫数 4</p>');
  assert.equal(result.title, 'GD03 BOX');
  assert.equal(result.price, 5808);
});

test('empty-state distinguishes filters and uncertain results; cards escape source text', () => {
  const container = {}, count = {}, panel = {}, summary = {}, review = {};
  renderRows(container, count, fixture, { reviewPanel: panel, reviewSummary: summary, reviewContainer: review });
  assert.equal(panel.hidden, false);
  assert.match(summary.textContent, /3件/);
  assert.doesNotMatch(container.innerHTML, /no-price|unknown-stock|carton/);
  const malicious = new Map([['x', { store: { id: 'x', name: '<script>' }, results: [{ title: 'BOX <img onerror="x">', price: 100, stock: 'in_stock', detailChecked: true, url: 'https://shop.test/product/1' }] }]]);
  renderRows(container, count, malicious);
  assert.doesNotMatch(container.innerHTML, /<script>|<img/);
});

test('API revalidates details and never fills unknown stock from listing guesses', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('product-list')) return new Response('<a href="/product/1">GD03 BOX</a><span>5808円 在庫数 9</span><a href="/product/2">GD03 BOX</a>');
    if (String(url).endsWith('/1')) return new Response('<h1>GD03 BOX</h1><span>5808円</span>');
    return new Response('<h1>GD02 BOX</h1><span>100円 在庫あり</span>');
  };
  try {
    const response = await worker.fetch(new Request('https://app.test/api/search?store=masters_gundam&q=GD03&refresh=1'), {});
    const data = await response.json();
    assert.equal(data.results.length, 1);
    assert.equal(data.results[0].stock, 'unknown');
    assert.equal(data.results[0].stockQty, null);
    assert.equal(data.results[0].price, 5808);
  } finally { globalThis.fetch = previous; }
});

test('individual cards are excluded even when their source is a custom deck BOX', () => {
  const names = ['ガンダム・瑞白星(第2形態)[GCG_GD03-055_R(2)] 【カスタムデッキボックス Freedom Ascension【SC01】収録】',
    'ホタルビ[GCG_ GD03 -129_U(2)] 【カスタムデッキボックス収録】'];
  const html = names.map((title, n) => `<a href="/product/${n}">${title}</a><span>100円 在庫あり</span>`).join('') +
    '<a href="/product/99">GD03 BOX</a><span>5808円 在庫あり</span>';
  assert.deepEqual(findCandidateProducts(html, 'https://shop.test/', 'GD03', true, 8, true).map(x => x.url), ['https://shop.test/product/99']);
});

test('whole-card links keep their own price but strip price and stock from title', () => {
  const html = '<a href="/product/1">ロルカナ 1BOX 2,500円 (税込) 希望小売価格 : 5,280円 在庫なし</a>';
  const result = findCandidateProducts(html, 'https://shop.test/', 'ロルカナ', true, 8)[0];
  assert.equal(result.title, 'ロルカナ 1BOX');
  assert.equal(result.price, 2500);
  assert.equal(result.stock, 'out_of_stock');
});
