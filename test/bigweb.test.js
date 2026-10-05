import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { STORE_MAP } from '../src/stores.js';
import { eligibility } from '../src/monitor-core.js';
import { fetchDiscoveryListings } from '../src/monitor-discovery.js';
import { findBigwebProduct, parseBigwebCatalog } from '../src/bigweb.js';
import { makeMonitorIO } from '../src/monitor-service.js';

const fixture = readFileSync(new URL('./fixtures/bigweb-products-2026-10-05.json', import.meta.url), 'utf8');
const store = STORE_MAP.get('bigweb');
const page = text => ({status:200,text,finalUrl:store.catalog.url,truncated:false});

test('BIGWEBの実一覧から通常24パックBOXだけを抽出する', () => {
  const stats = {};
  const rows = parseBigwebCatalog(fixture, store, stats);
  assert.deepEqual(rows.map(row => row.title), [
    'ガンダムカードゲーム ブースターパック Newtype Rising [GD01] BOX(24パック入)',
    'ガンダムカードゲーム ブースターパック Freedom Ascension [GD05] BOX(24パック入)',
  ]);
  assert.deepEqual(rows.map(row => row.stock), ['out_of_stock','out_of_stock']);
  assert.deepEqual(rows.map(row => row.price), [5200,6019]);
  assert.equal(stats.items,5); assert.equal(stats.accepted,2); assert.equal(stats.excludedOther,3);
  assert.equal(findBigwebProduct(fixture,store,rows[0].url)?.title,rows[0].title);
});

test('在庫はsold-out falseかつ正のstock_countの時だけ購入可能とする', () => {
  const data=JSON.parse(fixture),item=data.items[1];
  item.is_sold_out=false; item.stock_count=2;
  let row=parseBigwebCatalog(JSON.stringify(data),store).find(x=>x.title.includes('GD05'));
  assert.equal(row.stock,'in_stock');assert.equal(row.stockQty,2);
  item.is_sold_out=true;
  row=parseBigwebCatalog(JSON.stringify(data),store).find(x=>x.title.includes('GD05'));
  assert.equal(row.stock,'out_of_stock');
});

test('価格条件は既存の個別上限を使い、API一覧は1通信で検索できる', async t => {
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(fixture,{headers:{'content-type':'application/json'}});});
  const data=await (await worker.fetch(new Request('https://app.test/api/search?store=bigweb&q=GD05'),{ACCESS_CONTROL:async()=>({ok:true,id:'test'})})).json();
  assert.equal(calls,1);assert.equal(data.status,'ok');assert.equal(data.results.length,1);
  assert.equal(data.results[0].comparison.status,'known');assert.equal(data.results[0].comparison.difference,19);
  const rule={query:'GD05',game:'gundam',unit:'box',priceLimit:'105',maxPrice:6300,includePreorders:true};
  const available={...data.results[0],stock:'in_stock'};
  assert.equal(eligibility(available,rule),true);
});

test('自動発見も公開JSONを1回だけ読み、用品やセットを登録候補にしない', async () => {
  let calls=0;
  const rules=[{config:{query:'GD05',game:'gundam',unit:'box',priceLimit:'105',maxPrice:6300,includePreorders:true,storeIds:['bigweb']}}];
  const result=await fetchDiscoveryListings('bigweb',rules,{},async()=>{calls++;return page(fixture);});
  assert.equal(calls,1);assert.equal(result.status,'ok');assert.equal(result.results.length,1);
  assert.match(result.results[0].title,/Freedom Ascension/);
});

test('登録後の巡回も商品画面ではなく同じ公式APIで在庫を再確認する', async t => {
  const urls=[];
  t.mock.method(globalThis,'fetch',async url=>{urls.push(String(url));return new Response(fixture,{headers:{'content-type':'application/json'}});});
  const result=await makeMonitorIO(async()=>{}).check({storeId:'bigweb',url:'https://www.bigweb.co.jp/ja/products/gundamgcg/cardViewer/3548567'});
  assert.deepEqual(urls,[store.catalog.url]);
  assert.equal(result.row.title.includes('GD05'),true);assert.equal(result.row.stock,'out_of_stock');assert.equal(result.row.price,6019);
});
