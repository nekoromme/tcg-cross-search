import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCTS, identifyProduct, matchesQuery, searchTerms, comparePrice } from '../public/catalog.js';
import { selectRows } from '../public/ui.js';
import { productKind } from '../public/product-kind.js';
import { findCandidateProducts, parseProductDetail } from '../src/search.js';
import { extractStock } from '../src/search-common.js';
import { findNextSearchPage } from '../src/pagination.js';
import worker from '../src/index.js';

test('catalog has source evidence and keeps price changes and special sets separate', () => {
  assert.equal(new Set(PRODUCTS.map(p => p.id)).size, PRODUCTS.length);
  assert.equal(new Set(PRODUCTS.map(p => p.game)).size, 5);
  for (const p of PRODUCTS) {
    assert.ok(p.sources.length && p.sources.every(s => new URL(s.url).protocol === 'https:'));
    assert.ok(p.checkedAt && p.boxPrice > 0 && p.language === 'ja');
    if (p.basis === 'pack_times_count') assert.equal(p.boxPrice, p.packPrice * p.packsPerBox);
    assert.equal(identifyProduct(p.name)?.id, p.id, p.name);
  }
  assert.equal(identifyProduct('GD04').boxPrice, 5808);
  assert.equal(identifyProduct('GD05').boxPrice, 6000);
  assert.equal(identifyProduct('OP16').boxPrice, 5280);
  assert.equal(identifyProduct('OP17').boxPrice, 5760);
  assert.equal(identifyProduct('M4').boxPrice, 5400);
  assert.equal(identifyProduct('M6').boxPrice, 6000);
  assert.equal(identifyProduct('STORY BOOSTER 01').boxPrice, 6600);
});

test('aliases match the same box without merging similar or ambiguous codes', () => {
  assert.ok(matchesQuery('ガンダム Steel Requiem BOX', 'GD03'));
  assert.ok(matchesQuery('GD03 BOX', 'スティールレクイエム'));
  assert.ok(matchesQuery('ワンピース 世界最強の戦士 BOX', 'OP-17'));
  assert.ok(matchesQuery('ポケモン MEGAドリームex BOX', 'メガドリームex'));
  assert.equal(matchesQuery('GD050 BOX', 'GD05'), false);
  assert.equal(matchesQuery('GD04 BOX', 'GD05'), false);
  assert.equal(identifyProduct('GD04 Steel Requiem BOX'), null);
  assert.equal(identifyProduct('EB01 BOX'), null);
  assert.equal(identifyProduct('ST01 BOX'), null);
  assert.equal(identifyProduct('ワンピース EB01 BOX'), null);
  assert.equal(identifyProduct('ガンダム EB01 BOX').name, 'Eternal Nexus');
  assert.deepEqual(searchTerms('M6'), ['ストームエメラルダ']);
  assert.deepEqual(searchTerms('スティールレクイエム'), ['GD03','Steel Requiem']);
});

test('expanded catalog distinguishes parallel Pokemon releases and manga booster numbers', () => {
  for (const [code, name, price] of [
    ['M1L','メガブレイブ',5400], ['M1S','メガシンフォニア',5400], ['M2','インフェルノX',5400],
    ['SV9','バトルパートナーズ',5400], ['SV9a','熱風のアリーナ',5400], ['SV10','ロケット団の栄光',5400],
    ['OP-11','神速の拳',5280], ['OP-12','師弟の絆',5280], ['OP-13','受け継がれる意志',5280], ['OP-14','蒼海の七傑',5280],
    ['SB01','MANGA BOOSTER 01',7920], ['SB02','MANGA BOOSTER 02',7920],
  ]) {
    assert.equal(identifyProduct(code)?.name, name, code);
    assert.ok(matchesQuery(`${name} BOX`, code));
    const comparison = comparePrice({title:`${name} BOX`, price, detailChecked:true});
    assert.equal(comparison.status, 'known', name);
    assert.equal(comparison.difference, 0);
    assert.equal(comparison.checkedAt, '2026-09-08');
  }
  for (const [wanted, other] of [['M1L','M1S'], ['M2','M2a'], ['SV9','SV9a'], ['SB01','SB02']])
    assert.equal(matchesQuery(`${other} BOX`, wanted), false);
  assert.equal(identifyProduct('メガブレイブ メガシンフォニア BOXセット'), null);
  assert.deepEqual(searchTerms('SV9a'), ['熱風のアリーナ']);
  assert.deepEqual(searchTerms('マンガブースター01'), ['SB01','MANGA BOOSTER 01']);
  assert.equal(identifyProduct('GD05').checkedAt, '2026-09-07', '既存商品は再確認したことにしない');
});

test('special Pokemon sets are hidden from BOX results and never use booster MSRP', () => {
  const titles = ['デッキビルドＢＯＸ バトルパートナーズ', 'メガブレイブ ポケモンセンターセット',
    'メガシンフォニア ポケセンセット BOX', 'ロケット団の栄光 アタッシュケースセット',
    'バトルパートナーズ プレミアムトレーナーボックス'];
  for (const title of titles) {
    assert.equal(productKind(title), 'special', title);
    // 旧レスポンスがBOXと判定していても通常BOXの定価を当てない。
    assert.equal(comparePrice({title,kind:'box',price:4200,detailChecked:true}).status, 'unknown');
    const data = results([{title,kind:'box',price:4200}]);
    assert.equal(selectRows(data).main.length, 0);
    assert.equal(selectRows(data,{unit:'sealed'}).main[0].kind, 'special');
  }
  assert.equal(productKind('GD03 BOX プロモパック付き'), 'box');
  assert.equal(comparePrice({title:'バトルパートナーズ 拡張パック BOX',price:5400,detailChecked:true}).status, 'known');
});

test('hyphenated booster codes survive while individual card numbers do not', () => {
  const html = '<a href="/product/1">ワンピース OP-17 BOX</a><p>5760円 在庫あり</p>' +
    '<a href="/product/2">OP17-001 SR BOX購入特典</a><p>500円 在庫あり</p>';
  assert.deepEqual(findCandidateProducts(html, 'https://shop.test/', 'OP17', true, 8).map(r => r.url), ['https://shop.test/product/1']);
});

test('comparison requires one Japanese booster BOX with verified unconditional price', () => {
  const valid = { title:'GD05 BOX', price:6000, detailChecked:true };
  assert.equal(comparePrice(valid).status, 'known');
  for (const title of ['GD05 12BOX', 'GD05 BOX×2', 'GD05 BOX 2個セット', 'GD05 カートン',
    'GD05 1パック', '英語版 GD05 BOX', 'GD05 BOX 海外版', 'GD05 プレミアムセット BOX', 'GD05 デッキボックス']) {
    assert.equal(comparePrice({ ...valid, title }).status, 'unknown', title);
  }
  for (const changes of [{ detailChecked:false },{ price:null },{ priceComparable:false },{ price:0 }])
    assert.equal(comparePrice({ ...valid, ...changes }).status, 'unknown');
  assert.equal(productKind('GD05 2BOX シュリンクあり'), 'bundle');
});

function results(rows) { return new Map([['a', {store:{id:'a',name:'店A'}, results: rows.map((r,i) => ({
  title:'GD05 BOX', price:6000, stock:'in_stock', detailChecked:true, url:`https://shop.test/product/${i}`, ...r
}))}]]); }
test('price caps use exact yen boundaries and unknowns can be excluded without a new request', () => {
  const data = results([{price:6301},{price:6300},{price:6000},{title:'未登録商品 BOX',price:30000},{price:null}]);
  assert.deepEqual(selectRows(data,{priceLimit:'105'}).main.map(r=>r.price),[6000,6300,30000]);
  assert.deepEqual(selectRows(data,{priceLimit:'105',includeUnknown:false}).main.map(r=>r.price),[6000,6300]);
  assert.deepEqual(selectRows(data,{priceLimit:'100',includeUnknown:false}).main.map(r=>r.price),[6000]);
  assert.equal(selectRows(data,{priceLimit:'all',includeUnknown:false}).main.length,3);
  assert.deepEqual(selectRows(data,{maxPrice:6200}).main.map(r=>r.price),[6000]);
});

test('preorders have a separate switch and are excluded by immediate-stock-only', () => {
  const data = results([{stock:'preorder'},{stock:'in_stock'},{stock:'out_of_stock'}]);
  assert.equal(selectRows(data).main.length,3);
  assert.equal(selectRows(data,{includePreorders:false}).main.length,2);
  assert.equal(selectRows(data,{inStockOnly:true}).main.length,1);
  assert.equal(extractStock('予約受付中 残り 2BOX').stock,'preorder');
  assert.equal(extractStock('予約受付終了 在庫数 2 カートに入れる').stock,'out_of_stock');
});

test('discount sort compares against each product reference and puts unknowns last', () => {
  const data = results([{price:5700},{title:'GD03 BOX',price:5227},{title:'未登録 BOX',price:1000}]);
  assert.deepEqual(selectRows(data,{sort:'discount'}).main.map(r=>r.price),[5227,5700,1000]);
});

test('Futaki nested product heading is parsed without badges or recommendation prices', () => {
  const html = '<h1>ショップ名</h1><div class="item-title"><div class="item-detail-icon">SOLD OUT</div>' +
    '<div class="item-category-name">カードゲーム</div>ガンダム Steel Requiem【GD03】 BOX</div>' +
    '<div class="item-price">4,930円(税込)</div><p>SOLD OUT</p><div class="related-items">1,000円 在庫あり</div>';
  const row = parseProductDetail(html);
  assert.equal(row.title,'ガンダム Steel Requiem【GD03】 BOX');
  assert.equal(row.price,4930);
  assert.equal(row.stock,'out_of_stock');
});

test('tax-exclusive, conditional, foreign-currency and aggregate prices are not treated as certain cheap yen prices', () => {
  assert.equal(parseProductDetail('<h1>GD05 BOX</h1>販売価格:5000円（税別）').price,null);
  assert.equal(parseProductDetail('<h1>GD05 BOX</h1>販売価格:5000円（税別）税込価格:5500円').price,5500);
  assert.equal(parseProductDetail('<h1>GD05 BOX</h1>会員価格:5000円').price,null);
  for (const offers of [{price:40,priceCurrency:'USD'},{'@type':'AggregateOffer',lowPrice:10,highPrice:10000},
    [{price:5000},{price:10000}]]) {
    const html = `<script type="application/ld+json">${JSON.stringify({'@type':'Product',name:'GD05 BOX',offers})}</script><h1>GD05 BOX</h1>6000円 在庫あり`;
    assert.equal(parseProductDetail(html).price,null);
  }
});

const current = 'https://www.masters-square.com/product-list?keyword=GD05';
const shop = {field:'keyword'};
test('pagination preserves keyword and rejects external links, changed search, loops and jumps', () => {
  assert.equal(new URL(findNextSearchPage('<a href="?page=2">次へ</a>',current,shop)).searchParams.get('keyword'),'GD05');
  for (const href of ['https://other.test/product-list?keyword=GD05&page=2','?keyword=GD01&page=2','?page=3','?page=1','/product/2?page=2','?page=2&new=1'])
    assert.equal(findNextSearchPage(`<a href="${href}">次へ</a>`,current,shop),null,href);
});

test('wide search reaches a BOX on page two; standard reports an unread continuation', async t => {
  const requested = [];
  t.mock.method(globalThis,'fetch',async url => {
    const u = new URL(url); requested.push(u.href);
    if (u.pathname === '/product/8') return new Response('<h1>GD05 BOX</h1><p>6000円 在庫数 1</p>');
    if (u.searchParams.get('page') === '2') return new Response('<a href="/product/8">GD05 BOX</a>');
    return new Response('<a href="/product/1">GD05-001 R</a><a href="?page=2">次へ</a>');
  });
  const standard = await (await worker.fetch(new Request('https://app.test/api/search?store=masters_gundam&q=GD05'),{})).json();
  assert.equal(standard.results.length,0);
  assert.ok(standard.coverage.nextPageUrl);
  requested.length = 0;
  const wide = await (await worker.fetch(new Request('https://app.test/api/search?store=masters_gundam&q=GD05&depth=wide'),{})).json();
  assert.equal(wide.results.length,1);
  assert.equal(wide.results[0].comparison.status,'known');
  assert.equal(wide.coverage.pagesRead,2);
  assert.equal(requested.length,3);
  assert.ok(requested.filter(u => u.includes('product-list')).every(u => new URL(u).searchParams.get('keyword') === 'GD05'));
});

test('later 429 preserves first page results without retrying an alternate search', async t => {
  const urls=[];
  t.mock.method(globalThis,'fetch',async url => {
    const u = new URL(url); urls.push(u);
    if(u.pathname === '/product/1')return new Response('<h1>GD03 BOX</h1>5808円 在庫あり');
    if(u.searchParams.has('page'))return new Response('blocked',{status:429});
    return new Response('<a href="/product/1">GD03 BOX</a><a href="?page=2">次へ</a>');
  });
  const data = await (await worker.fetch(new Request('https://app.test/api/search?store=masters_gundam&q=GD03&depth=wide'),{})).json();
  assert.equal(data.results.length,1);
  assert.ok(data.coverage.partialReasons.some(r=>r.includes('429')));
  assert.equal(urls.length,3);
});

test('first-page rejection is not retried and redirects cannot leave a configured shop', async t => {
  let calls=0;
  const mock = t.mock.method(globalThis,'fetch',async()=> {calls++;return new Response('blocked',{status:403});});
  const url='https://app.test/api/search?store=masters_gundam&q=GD03&depth=wide';
  assert.equal((await (await worker.fetch(new Request(url),{})).json()).status,'blocked');
  assert.equal(calls,1);
  mock.mock.mockImplementation(async()=>new Response(null,{status:302,headers:{location:'https://other.test/private'}}));
  const data=await (await worker.fetch(new Request(url),{})).json();
  assert.equal(data.status,'error');
  assert.match(data.error,/店舗外/);
});
