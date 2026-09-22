import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchesQuery, identifyProduct, searchTerms } from '../public/catalog.js';
import { findCandidateProducts } from '../src/search-results.js';
import { productKind } from '../public/product-kind.js';
import { STORE_MAP, buildStoreSearchUrl } from '../src/stores.js';
import worker from '../src/index.js';

// 本番画面で観測した商品名。ページ全体の再現ではなく、表記ゆれの回帰検証用。
// 実在庫・価格の正しさは、この固定データのテストだけでは保証しない。
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/audit-titles-2026-09-22.json', import.meta.url)));
for (const { query, titles } of fixtures) {
  test(`observed BOX titles and alias-with-unit query: ${query}`, () => {
    for (const title of titles) {
      assert.ok(matchesQuery(title, query), title);
      assert.ok(matchesQuery(title, `${query} BOX`), title);
      assert.equal(productKind(title), 'box', title);
      const p = identifyProduct(query);
      // 実商品の正式名だけの表記も、型番+BOXから見つけられること。
      assert.ok(matchesQuery(`${p.name} ボックス`, `${query} BOX`));
      assert.equal(matchesQuery(`${p.name} 1パック`, `${query} BOX`), false);
      assert.equal(matchesQuery(`${p.name} デッキボックス`, `${query} BOX`), false);
      // 同じシリーズでも別の弾を混ぜない。
      const other = fixtures.find(f => identifyProduct(f.query).game === p.game && f.query !== query);
      if (other) assert.equal(matchesQuery(other.titles[0], query), false);
      const html = `<a href="/product/1">${title}</a><p>販売価格: 6000円 在庫あり</p>`;
      assert.equal(findCandidateProducts(html, 'https://shop.test/', `${query} BOX`, true, 8).length, 1);
    }
  });
}

test('BOX suffix expands registered aliases but retains other search restrictions', () => {
  assert.deepEqual(searchTerms('M6 BOX'), ['ストームエメラルダ BOX']);
  assert.deepEqual(searchTerms('スティールレクイエム BOX'), ['GD03 BOX', 'Steel Requiem BOX']);
  assert.equal(matchesQuery('GD04 ボックス', 'GD04 BOX'), true);
  assert.equal(matchesQuery('GD04 BOX', 'GD04 BOX シュリンク付き'), false);
  assert.equal(matchesQuery('GD040 BOX', 'GD04 BOX'), false);
  assert.equal(matchesQuery('GD03 BOX', 'GD04 BOX'), false);
  assert.deepEqual(searchTerms('未登録商品 BOX'), ['未登録商品 BOX']);
});

test('Tier One uses its observed Japanese unit spelling, including explicit BOX queries', () => {
  assert.equal(new URL(buildStoreSearchUrl(STORE_MAP.get('tier1_gundam'), 'GD04 BOX')).searchParams.get('search_keyword'), 'GD04 ボックス');
  assert.equal(new URL(buildStoreSearchUrl(STORE_MAP.get('masters_gundam'), 'GD04 BOX')).searchParams.get('keyword'), 'GD04 BOX');
});

test('GD04 buried under singles is recovered using one store-specific fallback', async t => {
  const requests = [];
  // ティアワン実検索で確認した商品名と商品番号。HTML構造は最小再現。
  t.mock.method(globalThis, 'fetch', async url => {
    const u = new URL(url); requests.push(u);
    if (u.pathname === '/view/item/000000015991')
      return new Response('<h1>【GD04】「Phantom Aria」ボックス（24パック）</h1><p>￥5,808（税込） 売り切れ</p>');
    if (u.searchParams.get('search_keyword') === 'GD04 ボックス')
      return new Response('<a href="/view/item/000000015991">【GD04】「Phantom Aria」ボックス（24パック）</a>');
    return new Response('<a href="/view/item/000000012345">【LR】カード《GD04-001》</a>');
  });
  const data = await (await worker.fetch(new Request('https://app.test/api/search?store=tier1_gundam&q=GD04'), {})).json();
  assert.deepEqual(requests.filter(u => u.pathname === '/view/search').map(u => u.searchParams.get('search_keyword')), ['GD04', 'GD04 ボックス']);
  assert.equal(data.coverage.requests, 3);
  assert.equal(data.results.length, 1);
  assert.equal(data.results[0].price, 5808);
  assert.equal(data.results[0].stock, 'out_of_stock');
  assert.equal(data.results[0].kind, 'box');
  assert.equal(data.results[0].comparison.status, 'known');
});
