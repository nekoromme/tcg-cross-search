import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { loadSearchSnapshot, saveSearchSnapshot } from '../src/search-snapshot.js';
import { collectStoreResults } from '../public/continued-search.js';
import { createRequestQueue } from '../public/request-queue.js';

function memoryCache(t) {
  const original=globalThis.caches, values=new Map();
  globalThis.caches={default:{put:async(k,v)=>values.set(k.url,await v.text()),match:async k=>values.has(k.url)?new Response(values.get(k.url)):undefined}};
  t.after(()=>{if(original===undefined)delete globalThis.caches;else globalThis.caches=original;});
  return values;
}
function search(task,query='GD04') {
  const params=new URLSearchParams({store:'masters_gundam',q:query,refresh:'1',start:task.start||'',offset:String(task.offset||0),snapshot:task.snapshot||''});
  return worker.fetch(new Request(`https://app.test/api/search?${params}`), {ACCESS_CONTROL:async()=>({ok:true,id:'test'})}).then(r=>r.json());
}
const listing=Array.from({length:13},(_,i)=>`<a href="/product/${i+1}">GD04 BOX</a>`).join('');

test('13商品すべての詳細確認を保ち、一覧取得4回を1回に減らす',async t=>{
  const cached=memoryCache(t);let lists=0,details=0;
  t.mock.method(globalThis,'fetch',async raw=>{
    if(new URL(raw).pathname==='/product-list'){lists++;return new Response(listing);}
    details++;return new Response('<h1>GD04 BOX</h1>販売価格5808円 在庫なし');
  });
  const withSnapshot=await collectStoreResults(search);
  assert.equal(lists,1);assert.equal(details,13);assert.equal(withSnapshot.coverage.pagesRead,1);
  assert.equal(withSnapshot.coverage.reusedListings,3);assert.equal(withSnapshot.continuations.length,0);
  const requestsWithSnapshot=lists+details;
  lists=0;details=0;cached.clear();delete globalThis.caches;
  const withoutSnapshot=await collectStoreResults(search);
  assert.equal(lists,4);assert.equal(details,13);
  assert.deepEqual(withSnapshot.results,withoutSnapshot.results);
  assert.equal(withSnapshot.coverage.partialReasons.length,0);
  assert(requestsWithSnapshot<lists+details);
});
test('候補一覧を引き継いでも、続きの詳細価格・在庫は新しく確認する',async t=>{
  memoryCache(t);let price=5808;
  t.mock.method(globalThis,'fetch',async raw=>new Response(new URL(raw).pathname==='/product-list'?listing:`<h1>GD04 BOX</h1>販売価格${price}円 在庫あり`));
  const first=await search({});assert(first.continuations[0].snapshot);
  price=5000;const second=await search(first.continuations[0]);
  assert(second.results.filter(r=>r.detailChecked).every(r=>r.price===5000&&r.stock==='in_stock'));
  assert.equal(second.coverage.pagesRead,0);
});
test('別条件・期限切れ・保存障害なら候補一覧を流用しない',async t=>{
  memoryCache(t);const origin='https://app.test',scope='GD04-box';
  const id=await saveSearchSnapshot(origin,scope,{candidates:[]},1000);
  assert(await loadSearchSnapshot(origin,id,scope,2000));
  assert.equal(await loadSearchSnapshot(origin,id,'GD05-box',2000),null);
  assert.equal(await loadSearchSnapshot(origin,id,scope,121001),null);
  assert.equal(await loadSearchSnapshot(origin,'bad',scope,2000),null);
  globalThis.caches.default.put=async()=>{throw new Error('quota');};
  assert.equal(await saveSearchSnapshot(origin,scope,{candidates:[]}), '');
  let lists=0;t.mock.method(globalThis,'fetch',async raw=>{if(new URL(raw).pathname==='/product-list'){lists++;return new Response(listing);}return new Response('<h1>GD04 BOX</h1>販売価格5808円 在庫なし');});
  const result=await collectStoreResults(search);assert.equal(lists,4);assert.equal(result.results.filter(r=>r.detailChecked).length,13);
});
test('ページが変わったらそのページを取得し、初回検索では古い一覧を使わない',async t=>{
  memoryCache(t);let lists=0;
  t.mock.method(globalThis,'fetch',async raw=>{if(new URL(raw).pathname==='/product-list'){lists++;return new Response(listing);}return new Response('<h1>GD04 BOX</h1>販売価格5808円 在庫なし');});
  const first=await search({});const snapshot=first.continuations[0].snapshot;
  await search({snapshot,offset:0});assert.equal(lists,2);
  await search({snapshot,offset:4,start:'https://www.masters-square.com/product-list?keyword=GD04&page=2'});assert.equal(lists,3);
});
test('Day屋の2カテゴリを同時に確認し、片方が壊れていれば未確認を残す',async t=>{
  let active=0,max=0;const waiting=[];
  t.mock.method(globalThis,'fetch',async raw=>{
    const category=new URL(raw).searchParams.get('category_id');
    if(!category)return new Response('<select name="category_id"><option value="1">新品</option><option value="2">新品その他</option></select>');
    active++;max=Math.max(max,active);
    await new Promise(resolve=>{waiting.push(resolve);if(waiting.length===2)waiting.forEach(r=>r());});active--;
    return new Response(category==='1'?'<main><a href="/products/detail/1">別作品BOX</a></main>':'<main></main>');
  });
  const result=await(await worker.fetch(new Request('https://app.test/api/search?store=dayya&q=GD04'), {ACCESS_CONTROL:async()=>({ok:true,id:'test'})})).json();
  assert.equal(max,2);assert.equal(result.coverage.categories.length,2);assert.equal(result.coverage.noHitConfirmed,false);assert(result.coverage.partialReasons.length);
});
test('通信は上限以内で、追加確認より未着手の店舗を先に進める',async()=>{
  const queue=createRequestQueue(2),started=[],byStore=new Map();let active=0,max=0;
  const rows=await Promise.all(['a','b','c'].map(store=>collectStoreResults(task=>queue.run(async()=>{
    active++;max=Math.max(max,active);byStore.set(store,(byStore.get(store)||0)+1);assert.equal(byStore.get(store),1);
    started.push(store+task.offset);
    await new Promise(r=>setTimeout(r,store==='a'?5:15));
    active--;byStore.set(store,0);
    return {status:'ok',results:[{url:`https://${store}/${task.offset}`,detailChecked:true}],coverage:{partialReasons:[]},continuations:store==='a'&&task.offset<8?[{start:'',offset:task.offset+4}]:[]};
  }))));
  assert(max<=2);assert(started.indexOf('c0')<started.indexOf('a4'));
  assert.equal(rows[0].results.length,3);assert(rows.every(r=>r.continuations.length===0));
});
test('失敗した通信の枠も返し、他店と再試行を止めない',async()=>{
  const queue=createRequestQueue(1);
  const failed=queue.run(()=>{throw new Error('timeout');});
  const success=queue.run(()=>42);
  await assert.rejects(failed,/timeout/);assert.equal(await success,42);
});
