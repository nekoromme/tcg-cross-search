import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { STORE_MAP } from '../src/stores.js';
import { parseProductDetail } from '../src/product-detail.js';
import { sealedCategoryUrls, validateContinuation } from '../src/store-exceptions.js';
import { collectStoreResults, mergeStorePage } from '../public/continued-search.js';
import { selectRows } from '../public/ui.js';

const menu='<select name="category_id"><option value="1766">新品</option><option value="14">新品その他</option><option value="10">ポケモン</option></select>';
const request=(store,q,extra='')=>new Request(`https://app.test/api/search?store=${store}&q=${encodeURIComponent(q)}${extra}`);

test('Dayya discovers only the two published sealed categories and confirms scoped absence', async t=>{
  assert.equal(sealedCategoryUrls(menu,STORE_MAP.get('dayya')).length,2);
  t.mock.method(globalThis,'fetch',async url=> {
    const category=new URL(url).searchParams.get('category_id');
    return new Response(category ? '<main><a href="/products/detail/11">別作品のブースターパック BOX</a></main>' : menu+'<main></main>');
  });
  const data=await (await worker.fetch(request('dayya','GD04'),{})).json();
  assert.equal(data.status,'no_hit'); assert.equal(data.coverage.noHitConfirmed,true);
  assert.deepEqual(data.coverage.categories.map(x=>x.complete),[true,true]);
});

test('category fallback recovers matching product and checks its detail',async t=>{
  t.mock.method(globalThis,'fetch',async url=>{
    const u=new URL(url);
    if(u.pathname==='/products/detail/11') return new Response('<h1>GD04 BOX</h1>販売価格5808円 在庫なし');
    if(u.searchParams.has('category_id')) return new Response('<main><a href="/products/detail/11">GD04 BOX</a></main>');
    return new Response(menu+'<main></main>');
  });
  const data=await (await worker.fetch(request('dayya','GD04'),{})).json();
  assert.equal(data.results.length,1); assert.equal(data.results[0].price,5808);
});

test('empty or broken category pages cannot turn unknown into confirmed absence',async t=>{
  t.mock.method(globalThis,'fetch',async url=>new Response(new URL(url).searchParams.has('category_id')?'<main></main>':menu));
  const data=await (await worker.fetch(request('dayya','GD04'),{})).json();
  assert.equal(data.coverage.noHitConfirmed,false);
  assert.ok(data.coverage.partialReasons.length);
});

test('zero price plus sold out becomes unavailable; unknown stock is still unresolved',()=>{
  const zero=parseProductDetail('<h2 id="product_name">GD04 BOX</h2>販売価格: 0円 在庫なし');
  assert.equal(zero.price,null); assert.equal(zero.priceState,'unavailable');
  const row={...zero,url:'https://test/product/1',kind:'box',detailChecked:true};
  const result={store:{id:'a',name:'A'},results:[row]};
  assert.equal(selectRows(new Map([['a',result]]),{priceLimit:'all'}).main.length,1);
  assert.equal(selectRows(new Map([['a',result]]),{inStockOnly:true}).main.length,0);
  assert.equal(parseProductDetail('<h2 id="product_name">GD04 BOX</h2>販売価格:0円').priceState,undefined);
  assert.equal(parseProductDetail('<h2 id="product_name">GD04 BOX</h2>販売価格:5808円 在庫あり').priceState,undefined);
});

test('continuations read past the first 8 candidates and finish every detail in small batches',async t=>{
  const html=Array.from({length:13},(_,n)=>`<a href="/product/${n+1}">GD04 BOX</a>`).join('');
  t.mock.method(globalThis,'fetch',async url=>new URL(url).pathname==='/product-list'?new Response(html):new Response('<h1>GD04 BOX</h1>販売価格5808円 在庫なし'));
  const data=await collectStoreResults(async task=> (await worker.fetch(request('masters_gundam','GD04',`&offset=${task.offset}`),{})).json());
  assert.equal(data.results.length,13);
  assert.ok(data.results.every(r=>r.detailChecked));
  assert.equal(data.continuations.length,0);
});

test('following a next-page continuation preserves earlier offers and verifies the last page',async t=>{
  t.mock.method(globalThis,'fetch',async url=>{
    const u=new URL(url);
    if(u.pathname.startsWith('/product/')) return new Response('<h1>GD04 BOX</h1>販売価格5808円 在庫なし');
    const p=u.searchParams.get('page')||'1';
    return new Response(`<a href="/product/${p}">GD04 BOX</a>`+(p==='1'?'<a href="?keyword=GD04&page=2">次へ</a>':''));
  });
  const data=await collectStoreResults(async task=> (await worker.fetch(request('masters_gundam','GD04',task.start?`&start=${encodeURIComponent(task.start)}`:''),{})).json());
  assert.equal(data.results.length,2); assert.equal(data.continuations.length,0);
});

test('failed continuation preserves offers and can be retried from the remaining task',async()=>{
  const first={status:'ok',store:{id:'a'},results:[{url:'https://a/1',detailChecked:true}],coverage:{partialReasons:[]},continuations:[{start:'https://a/page2',offset:0}]};
  const failed=await collectStoreResults(async()=>{throw new Error('timeout');},first);
  assert.equal(failed.results.length,1); assert.equal(failed.continuations.length,1);
  const retried=await collectStoreResults(async()=>({...first,results:[{url:'https://a/2',detailChecked:true}],continuations:[]}),failed);
  assert.equal(retried.results.length,2); assert.equal(retried.continuations.length,0); assert.equal(retried.resumeError,'');
});

test('limited automatic batches retain a resumable queue and later rejection removes an earlier candidate',async()=>{
  let calls=0;
  const fetcher=async task=>({status:'ok',results:[{url:`https://a/${task.offset}`,detailChecked:true}],coverage:{partialReasons:[]},continuations:task.offset<8?[{start:'',offset:task.offset+4}]:[]});
  const first=await collectStoreResults(async t=>{calls++;return fetcher(t);},null,()=>{},1);
  assert.equal(calls,1); assert.equal(first.continuations.length,1);
  const final=await collectStoreResults(fetcher,first);
  assert.equal(final.results.length,3); assert.equal(final.continuations.length,0);
  const rejected=mergeStorePage(final,{status:'no_hit',results:[],rejectedUrls:['https://a/0'],coverage:{partialReasons:[]}});
  assert.equal(rejected.results.length,2);
});

test('resume URL cannot leave store search or alter the user query',()=>{
  const store=STORE_MAP.get('masters_gundam');
  for(const url of ['https://evil.test/product-list?keyword=GD04','https://www.masters-square.com/admin?keyword=GD04',
    'https://www.masters-square.com/product-list?keyword=GD05','https://www.masters-square.com/product-list?keyword=GD04&page=999'])
    assert.throws(()=>validateContinuation(url,store,['GD04','Phantom Aria']));
  assert.ok(validateContinuation('https://www.masters-square.com/product-list?keyword=GD04&page=2',store,['GD04']));
});
