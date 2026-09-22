import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { findCandidateProducts } from '../src/search-results.js';
import { parseProductDetail } from '../src/product-detail.js';
import { emptySearchEvidence } from '../src/search-evidence.js';
import { summarizeStoreChecks } from '../public/ui.js';
import { STORE_MAP, buildStoreSearchUrl } from '../src/stores.js';
import { findNextSearchPage } from '../src/pagination.js';

// 実際のCARDMAX応答はhrefの引用符がない。ブラウザーのDOMは引用符を補うため、
// 保存済みDOMだけのテストでは見つけられなかった読み取り漏れを再現する。
const listing = '<a href=/shop/shopdetail.html?brandcode=000000211454&search=Phantom+Aria&sort=>ブースターパック Phantom Aria BOX【ガンダムカードゲーム】</a>';
const detail = '<h2 id="M_logo">CARDMAX</h2><p>おすすめ 100円 在庫あり</p>' +
  '<h2 id="M_itemName">ブースターパック Phantom Aria BOX【ガンダムカードゲーム】</h2>' +
  '<p>販売価格：￥5,808 （税込）</p><p>売り切れ</p><a>カートに入れる</a>';

test('raw CARDMAX anchors and camel-case product heading yield the real BOX offer', () => {
  const rows = findCandidateProducts(listing, 'https://www.cardmax.jp/shop/shopbrand.html', 'GD04', true, 8);
  assert.equal(rows.length, 1);
  assert.equal(new URL(rows[0].url).searchParams.get('brandcode'), '000000211454');
  const parsed = parseProductDetail(detail);
  assert.equal(parsed.price, 5808);
  assert.equal(parsed.stock, 'out_of_stock');
  assert.match(parsed.title, /Phantom Aria BOX/);
});

test('Yahoo paragraph product title exposes own stock without borrowing another store stock', () => {
  const html = '<div class="styles_itemName__Cf_Kt"><p class="styles_catchCopy__yhwu9">BOX カートン</p>' +
    '<p class="styles_name__u228e">BRIGHTNESS OF HOPE FB11 BOX</p></div>' +
    '<ul class="styles_itemLabels__CoCPa"><li>在庫なし</li></ul><p itemprop="price">13,500<span>円</span></p>' +
    '<p>ポイントは原則税抜価格が対象です</p><p>入会特典を使うと8,500円</p>' +
    '<h2 class="ModulesHeader__heading">他ストアでの取り扱い</h2><p>在庫あり 100円</p>';
  const row=parseProductDetail(html);
  assert.equal(row.title,'BRIGHTNESS OF HOPE FB11 BOX');
  assert.equal(row.price,13500);
  assert.equal(row.stock,'out_of_stock');
  assert.equal(parseProductDetail(html.replace('在庫なし','在庫表示未提供')).stock,'unknown');
});

test('OP17 figure accessories do not become uncertain trading-card candidates', () => {
  const html='<a href="/products/51069274000">【新品即納】[FIG] LA-OP17:figma用タクティカルグローブLサイズ フィギュア用アクセサリ</a>';
  assert.deepEqual(findCandidateProducts(html,'https://mediaworld.co.jp/','OP-17',true,8),[]);
});

test('unquoted next-product anchors cannot lend their price to the previous listing', () => {
  const rows = findCandidateProducts(listing + '<a href=/shop/shopdetail.html?brandcode=2>GD04 BOX</a><p>9000円</p>',
    'https://www.cardmax.jp/shop/shopbrand.html', 'GD04', true, 8);
  assert.equal(rows.find(r=>r.url.includes('211454')).price, null);
});

test('different product identifiers in query parameters survive worker deduplication', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    const u = new URL(url);
    if (u.pathname.endsWith('shopbrand.html')) return new Response(listing + listing.replace('211454', '211455'));
    return new Response(detail);
  });
  const data = await (await worker.fetch(new Request('https://app.test/api/search?store=cardmax&q=GD04'), {})).json();
  assert.equal(data.results.length, 2);
  assert.equal(data.results[0].price, 5808);
});

test('Torecolo includes the search execution flag shown in the actual form', () => {
  const url = new URL(buildStoreSearchUrl(STORE_MAP.get('torecolo'), 'GD04'));
  assert.equal(url.searchParams.get('search'), 'x');
  assert.equal(url.searchParams.get('keyword'), 'GD04');
  const next = findNextSearchPage('<a href="/shop/goods/search.aspx?p=2&search=x&keyword=GD04&ps=50">2</a>',url,STORE_MAP.get('torecolo'));
  assert.equal(new URL(next).searchParams.get('p'),'2');
});

test('single-card identifiers in Torecolo URLs explain exclusions but never establish a BOX offer', () => {
  const stats = {};
  const rows = findCandidateProducts('<a href="/shop/g/gGCG-GD04-002LR/">ペーネロペー</a>',
    'https://www.torecolo.jp/shop/goods/search.aspx', 'GD04',true,8,true,stats);
  assert.equal(rows.length,0);
  assert.equal(stats.excludedSingles,1);
});

test('only explicit search-empty evidence is accepted; carts and templates are ignored', () => {
  for (const html of [
    '<div class="count_number"><span class="number">0</span><span class="count_suffix">件</span></div>',
    '<p>登録アイテム数: 0件</p>', '<main>お探しの商品は見つかりませんでした</main>',
    '<p>ご指定の条件に一致する商品が見つかりませんでした。</p>',
  ]) assert.ok(emptySearchEvidence(html));
  for (const html of ['<p>カート0件</p>', '<p>最近見た商品がありません</p>',
    '<script>"お探しの商品は見つかりませんでした"</script>',
    '<!-- 総0件 --><p>商品一覧</p>', '<select><option>60件</option></select>']) assert.equal(emptySearchEvidence(html), null);
});

test('empty pages and retrieval failures are counted separately without hiding uncertainty', async t => {
  const mock=t.mock.method(globalThis, 'fetch', async()=>new Response('<p>お探しの商品は見つかりませんでした</p>'));
  const request=new Request('https://app.test/api/search?store=193&q=GD04');
  const empty=await (await worker.fetch(request, {})).json();
  assert.equal(empty.coverage.noHitConfirmed,true);
  mock.mock.mockImplementation(async()=>new Response('<main></main>'));
  const unknown=await (await worker.fetch(request, {})).json();
  assert.equal(unknown.coverage.noHitConfirmed,false);
  assert.deepEqual(summarizeStoreChecks([empty,unknown,{status:'blocked'}]),{noHit:1,partial:1,failed:1});
  const limited={...empty,coverage:{...empty.coverage,partialReasons:['検索結果の続きは未確認']}};
  assert.equal(summarizeStoreChecks([limited]).partial,1);
});

test('detail failures retain HTTP status or timeout instead of a generic message', async t => {
  const mock=t.mock.method(globalThis, 'fetch', async url=>new URL(url).pathname.endsWith('shopbrand.html')
    ? new Response(listing) : new Response('Unavailable',{status:503}));
  const request=new Request('https://app.test/api/search?store=cardmax&q=GD04');
  const http=await (await worker.fetch(request,{})).json();
  assert.match(http.results[0].reviewReason,/503/);
  mock.mock.mockImplementation(async url=>{
    if(new URL(url).pathname.endsWith('shopbrand.html')) return new Response(listing);
    throw new DOMException('deadline','AbortError');
  });
  const timeout=await (await worker.fetch(request,{})).json();
  assert.match(timeout.coverage.detailFailures[0].reason,/タイムアウト/);
});
