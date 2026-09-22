import test from 'node:test';
import assert from 'node:assert/strict';
import {accessDecision, accessDay, ACCESS_LIMITS, createAccessController, networkGuard} from '../src/access-limits.js';
import worker, {fetchHtml} from '../src/index.js';
import {emptyMonitor, addRule, addTarget, activeTarget, effectiveInterval, publicMonitor} from '../src/monitor-core.js';
import {runMonitorTick} from '../src/monitor-engine.js';
import {collectStoreResults} from '../public/continued-search.js';
const now=Date.parse('2026-09-22T14:59:00Z');
const acquire=(host='shop.test',kind='manual')=>({action:'acquire',host,kind});
function counter(){const s={};accessDecision(s,{action:'status'},now);return s;}

test('同じ店舗は4接続、全体24接続まで。解放・異常終了の失効で再開',()=>{
  const s=counter();let leases=[];
  for(let i=0;i<4;i++)leases.push(accessDecision(s,acquire(),now));
  assert(!accessDecision(s,acquire('www.shop.test'),now).ok);
  accessDecision(s,{action:'release',id:leases[0].id},now);
  assert(accessDecision(s,acquire(),now).ok);
  for(let i=0;i<20;i++)assert(accessDecision(s,acquire(`shop${i}.test`),now).ok);
  assert(!accessDecision(s,acquire('other.test'),now).ok);
  assert(accessDecision(s,acquire('other.test'),now+45001).ok);
});
test('1分の上限は固定分境界をまたぐ連打でも超えない',()=>{
  const s=counter();
  for(let i=0;i<30;i++){const r=accessDecision(s,acquire(),now+i);assert(r.ok);accessDecision(s,{action:'release',id:r.id},now+i);}
  assert(!accessDecision(s,acquire(),now+59999).ok);
  assert(accessDecision(s,acquire(),now+60001).ok);
  s.recent=Array.from({length:180},(_,i)=>({host:`a${i}`,at:now+60000}));
  assert(!accessDecision(s,acquire('new.test'),now+60002).ok);
});
test('自動監視の日次上限でも手動枠を残し、日本時間0時に再開',()=>{
  const s=counter();s.monitor=12000;s.total=12000;
  assert(!accessDecision(s,acquire('a','monitor'),now).ok);
  assert(accessDecision(s,acquire('a'),now).ok);
  s.total=20000;assert(!accessDecision(s,acquire('b'),now).ok);
  const midnight=Date.parse('2026-09-22T15:00:00Z');
  assert.equal(accessDay(midnight),accessDay(now)+1);
  assert(accessDecision(s,acquire('b','monitor'),midnight).ok);
  assert.equal(s.total,1);assert.equal(s.monitor,1);
});
test('店舗の日次上限は別端末や手動・自動の区別なく共有する',()=>{
  const s=counter();s.hosts['shop.test']=2000;
  assert(!accessDecision(s,acquire('www.shop.test','monitor'),now).ok);
  assert(!accessDecision(s,acquire(),now).ok);
  assert(accessDecision(s,acquire('another.test'),now).ok);
});
test('並行した要求を直列に判定し、保存先を読み直しても回数が残る',async()=>{
  let saved={};const storage={load:async()=>structuredClone(saved),save:async s=>{saved=structuredClone(s);}};
  const control=createAccessController(storage);
  const results=await Promise.all(Array.from({length:20},()=>control(acquire())));
  assert.equal(results.filter(r=>r.ok).length,4);
  assert.equal((await createAccessController(storage)({action:'status'})).used,4);
});
test('保存先未設定・保存障害・上限到達では店舗へ通信しない',async t=>{
  let fetched=0;t.mock.method(globalThis,'fetch',async()=>{fetched++;return new Response('');});
  assert.equal((await worker.fetch(new Request('https://x/api/search?store=mediaworld&q=GD04'),{})).status,503);
  const guard=networkGuard({ACCESS_CONTROL:async()=>{throw new Error('storage');}});
  await assert.rejects(fetchHtml('https://mediaworld.co.jp/products/x',100,{requests:0,deadline:Date.now()+10000,guard}),e=>e.accessLimited);
  const response=await worker.fetch(new Request('https://x/api/search?store=mediaworld&q=GD04'),{ACCESS_CONTROL:async()=>({ok:false,error:'アクセス上限',retryAt:Date.now()+1000})});
  const data=await response.json();assert(data.accessLimited);assert.equal(data.coverage.noHitConfirmed,false);assert.equal(data.continuations[0].offset,0);assert.equal(fetched,0);
});
test('転送も1通信ずつ数え、本文取得後・失敗時に接続枠を返却する',async t=>{
  const commands=[];let n=0;
  const guard=networkGuard({ACCESS_CONTROL:async c=>{commands.push(c.action);return {ok:true,id:String(n)};}});
  t.mock.method(globalThis,'fetch',async()=>++n===1?new Response('',{status:302,headers:{location:'/products/b'}}):new Response('product'));
  await fetchHtml('https://mediaworld.co.jp/products/a',100,{requests:0,deadline:Date.now()+10000,guard});
  assert.deepEqual(commands,['acquire','release','acquire','release']);
  commands.length=0;t.mock.method(globalThis,'fetch',async()=>{throw new Error('network');});
  await assert.rejects(fetchHtml('https://mediaworld.co.jp/products/a',100,{requests:0,deadline:Date.now()+10000,guard}));
  assert.deepEqual(commands,['acquire','release']);
});
test('上限に達しても既存の検索結果と未確認位置を保持し、自動連打しない',async()=>{
  let calls=0;const row={url:'https://x/products/a',detailChecked:true};
  const result=await collectStoreResults(async()=>++calls===1?{status:'ok',results:[row],coverage:{},continuations:[{offset:4}]}:{status:'error',results:[],coverage:{partialReasons:['アクセス上限']},accessLimited:true,retryAt:now+1000,error:'アクセス上限'});
  assert.equal(calls,2);assert.deepEqual(result.results,[row]);assert.equal(result.continuations[0].offset,4);assert(result.accessLimited);
});
const config={query:'GD04',game:'gundam',storeIds:['mediaworld']};
const seed=i=>({storeId:'mediaworld',url:`https://mediaworld.co.jp/products/${i}`,title:'ガンダムカードゲーム GD04 BOX'});
test('50ページ・10条件を強制し、旧データ超過分は削除せず待機',()=>{
  const s=emptyMonitor(),r=addRule(s,config);
  for(let i=0;i<50;i++)assert(addTarget(s,r,seed(i),now));
  assert.equal(addTarget(s,r,seed(50),now),null);
  assert.throws(()=>addRule(s,{...config,query:'GD05'}));
  s.targets.push({...s.targets[0],id:'old',url:seed(99).url});
  assert(!activeTarget(s,s.targets[50]));assert.equal(publicMonitor(s).load.waitingPages,1);
  assert(effectiveInterval(s,s.targets[0])>=3600);
  const other=emptyMonitor();for(let i=0;i<10;i++)addRule(other,{...config,query:`GD${i}`});
  assert.throws(()=>addRule(other,{...config,query:'GD99'}));
});
test('監視が通信上限で延期された時は在庫・通知状態を変えない',async()=>{
  const s=emptyMonitor();addRule(s,config,[seed(1)],now);s.jobs=[];
  const target=s.targets[0];target.lastGood={stock:'in_stock',price:5808};target.episodes={saved:{active:true}};
  const before=structuredClone(target.episodes);
  await runMonitorTick(s,{now:()=>now,save:async()=>{},storeHost:()=> 'mediaworld.co.jp',check:async()=>({deferred:true,error:'アクセス上限',retryAt:now+60000})});
  assert.equal(target.lastGood.stock,'in_stock');assert.deepEqual(target.episodes,before);assert.equal(target.nextAt,now+60000);assert.equal(target.failures,0);assert.equal(s.events.length,0);
});

test('本番と同じ共有保存先の呼出し経路で検索が動き、使用数が永続化される',async t=>{
  const {InventoryMonitor}=await import('../src/monitor-service.js');
  const data=new Map();
  const object=new InventoryMonitor({storage:{get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v))}},{});
  const env={MONITORS:{idFromName:name=>name,get:id=>{assert.equal(id,'shared-access-budget-v1');return object;}}};
  t.mock.method(globalThis,'fetch',async()=>new Response('<html><main>検索結果 0件</main></html>',{headers:{'Content-Type':'text/html'}}));
  const result=await (await worker.fetch(new Request('https://x/api/search?store=mediaworld&q=GD04'),env)).json();
  assert(!result.accessLimited);assert.notEqual(result.status,'error');
  const saved=data.get('access-budget');assert(saved.total>=1);assert.equal(saved.leases.length,0);
  const next=new InventoryMonitor({storage:{get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v))}},{});
  const status=await(await next.fetch(new Request('https://internal/internal/access-budget',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'status'})}))).json();
  assert.equal(status.used,saved.total);
});
