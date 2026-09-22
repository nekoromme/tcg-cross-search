import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMonitor, validateRule, productUrl, validateWebhook, addRule, addTarget, observe, recordFailure, eligibility, publicMonitor, removeRule } from '../src/monitor-core.js';
import { runMonitorTick, sendDiscord } from '../src/monitor-engine.js';
import { InventoryMonitor, monitorCommand, routeMonitor, makeMonitorIO } from '../src/monitor-service.js';

const config={query:'GD04',game:'gundam',priceLimit:'105',includeUnknown:false,includePreorders:true};
const row={title:'ガンダムカードゲーム Phantom Aria GD04 BOX',price:5808,stock:'in_stock',detailChecked:true};
const seed={...row,storeId:'mediaworld',url:'https://mediaworld.co.jp/products/13921565000'};
const webhook='https://discord.com/api/webhooks/123456789012345678/'+ 'x'.repeat(60);
function fixture(){const s=emptyMonitor(),r=addRule(s,config,[seed],1000);return {s,r,t:s.targets[0]};}
function io(s,extras={}){return {save:async()=>{},now:()=>1000000,storeHost:id=>id==='mediaworld'?'mediaworld.co.jp':id,check:async()=>({row}),discover:async()=>({status:'no_hit',results:[],coverage:{partialReasons:[]}}),notify:async()=>{},...extras};}

test('監視条件の検証・重複登録・他ゲームの店舗除外',()=>{
  const s=emptyMonitor(),a=addRule(s,config);assert.equal(addRule(s,config).id,a.id);
  assert(!a.config.storeIds.includes('tier1_op'));
  assert.throws(()=>validateRule({...config,storeIds:['tier1_op']}));
  assert.throws(()=>validateRule({...config,query:'x'}));assert.throws(()=>validateRule({...config,maxPrice:-1}));
});
test('商品URLは対象店舗内の商品だけ。外部・認証・操作ページを拒否',()=>{
  for(const url of ['https://evil.test/products/a','http://mediaworld.co.jp/products/a','https://u:p@mediaworld.co.jp/products/a','https://mediaworld.co.jp/admin','https://mediaworld.co.jp:444/products/a'])assert.throws(()=>productUrl(url,'mediaworld'));
  assert.throws(()=>productUrl('https://store.shopping.yahoo.co.jp/other/a.html','suns'));
  assert.equal(productUrl(seed.url+'?_pos=1&utm_source=a#x','mediaworld'),seed.url);
  assert.throws(()=>validateWebhook('https://evil.test/api/webhooks/a'));assert.equal(validateWebhook(webhook),webhook);
});
test('BOX・価格上限・予約・定価不明・条件付き価格を判定',()=>{
  const r=validateRule(config);assert.equal(eligibility(row,r),true);
  assert.equal(eligibility({...row,price:7000},r),false);
  assert.equal(eligibility({...row,priceComparable:false},r),null);
  assert.equal(eligibility({...row,stock:'preorder'},{...r,includePreorders:false}),false);
  assert.equal(eligibility({...row,title:row.title.replace('BOX','カートン')},r),false);
  assert.equal(eligibility({...row,price:0},r),null);
  assert.equal(eligibility({...row,stock:'unknown'},r),null);
});
test('初回通知・同じ在庫の重複抑制・二回の売切後の再入荷',()=>{
  const {s,t}=fixture();observe(s,t,row,1000000);observe(s,t,row,1060000);assert.equal(s.events.length,1);
  observe(s,t,{...row,stock:'out_of_stock'},1120000);observe(s,t,row,1180000);assert.equal(s.events.length,1);
  observe(s,t,{...row,stock:'out_of_stock'},1300000);observe(s,t,{...row,stock:'out_of_stock'},1360000);
  observe(s,t,row,1420000);assert.equal(s.events.length,2);
});
test('未知・通信失敗を売切にしない。再起動後も通知済みを保持',()=>{
  let {s,t}=fixture();observe(s,t,row,1000000);
  observe(s,t,{...row,stock:'unknown'},1060000);assert.equal(t.lastGood.stock,'in_stock');assert(t.error);
  recordFailure(t,'HTTP 500',1120000,60);s=JSON.parse(JSON.stringify(s));t=s.targets[0];
  observe(s,t,row,1500000);assert.equal(s.events.length,1);assert.equal(t.error,'');
});
test('0円売切→価格・在庫復活、値下がりで通知条件に入る',()=>{
  const {s,t}=fixture();observe(s,t,{...row,price:null,stock:'out_of_stock',priceState:'unavailable'},1000000);
  assert.equal(t.error,'');assert.equal(s.events.length,0);
  observe(s,t,{...row,price:9000},1060000);assert.equal(s.events.length,0);
  observe(s,t,row,1120000);assert.equal(s.events.length,1);
});
test('失敗と403・429で間隔を延ばす',()=>{
  const {t}=fixture();recordFailure(t,'失敗',1000000,60);assert.equal(t.nextAt,1120000);
  recordFailure(t,'拒否',1100000,60,429);assert.equal(t.nextAt,2900000);
});
test('全体停止・条件停止では店舗への通信を行わない',async()=>{
  const {s}=fixture();let requests=0;const hooks=io(s,{check:async()=>{requests++;},discover:async()=>{requests++;}});
  s.enabled=false;await runMonitorTick(s,hooks);assert.equal(requests,0);
  s.enabled=true;s.rules[0].enabled=false;await runMonitorTick(s,hooks);assert.equal(requests,0);
});
test('同じ店は1巡1商品。公平に残った商品へ進む',async()=>{
  const {s,r}=fixture();s.jobs=[];addTarget(s,r,{...seed,url:seed.url+'1'},1001);
  const checked=[];await runMonitorTick(s,io(s,{check:async t=>{checked.push(t.url);return {row};}}));
  assert.deepEqual(checked,[seed.url]);
  await runMonitorTick(s,io(s,{now:()=>1031000,check:async t=>{checked.push(t.url);return {row};}}));assert.equal(checked.length,2);assert.equal(checked[1],seed.url+'1');
});
test('通知失敗を保存して再試行。送れたら繰り返さない',async()=>{
  const {s}=fixture();s.webhook=webhook;s.jobs=[];let calls=0;
  await runMonitorTick(s,io(s,{notify:async()=>{calls++;throw new Error('network');}}));
  assert.equal(s.events[0].delivery,'pending');assert.equal(s.events[0].attempts,1);
  await runMonitorTick(s,io(s,{now:()=>1060000,notify:async()=>{calls++;}}));assert.equal(s.events[0].delivery,'sent');
  await runMonitorTick(s,io(s,{now:()=>1120000,notify:async()=>{calls++;}}));assert.equal(calls,2);
});
test('通知待ちの間に売切・取得失敗なら古い在庫を送らない',async()=>{
  const {s,t}=fixture();s.jobs=[];s.webhook=webhook;observe(s,t,row,1000000);let sent=0;
  await runMonitorTick(s,io(s,{now:()=>1060000,check:async()=>({error:'失敗'}),notify:async()=>{sent++;}}));assert.equal(sent,0);
  t.nextAt=0;await runMonitorTick(s,io(s,{now:()=>1120000,check:async()=>({row:{...row,stock:'out_of_stock'}}),notify:async()=>{sent++;}}));assert.equal(sent,0);assert.equal(s.events[0].delivery,'cancelled');
});
test('新規商品発見は続き位置を引き継ぎ、商品ページを登録',async()=>{
  const s=emptyMonitor();addRule(s,{...config,storeIds:['mediaworld']});s.jobs[0].nextAt=0;
  const tasks=[];await runMonitorTick(s,io(s,{discover:async(_r,_id,task)=>{tasks.push(task);return {status:'ok',results:[seed],continuations:[{start:'',offset:4}],coverage:{partialReasons:[]}};}}));
  assert.equal(s.targets.length,1);assert.equal(s.jobs[0].queue[0].offset,4);
  s.targets[0].nextAt=9999999;
  await runMonitorTick(s,io(s,{now:()=>1061000,discover:async(_r,_id,task)=>{tasks.push(task);return {status:'no_hit',results:[],coverage:{partialReasons:[]}};}}));
  assert.equal(tasks[1].offset,4);assert.equal(s.jobs[0].queue.length,0);assert.equal(s.targets.length,1);
});
test('設定・履歴の公開データに通知先の秘密を出さない',()=>{
  const {s,r}=fixture();s.webhook=webhook;assert(!JSON.stringify(publicMonitor(s)).includes(webhook));
  removeRule(s,r.id);assert.equal(s.targets.length,0);assert.equal(s.jobs.length,0);
});
test('認証なし・別サイトからの操作・不正な間隔を拒否',async()=>{
  const a=await routeMonitor(new Request('https://example.com/api/monitor'),{});assert.equal(a.status,401);
  const b=await routeMonitor(new Request('https://example.com/api/monitor',{headers:{Origin:'https://evil.test'}}),{});assert.equal(b.status,403);
  await assert.rejects(()=>monitorCommand(emptyMonitor(),{action:'settings',intervalSeconds:10}));
  const s=emptyMonitor();await monitorCommand(s,{action:'settings',intervalSeconds:10},{minInterval:10});assert.equal(s.intervalSeconds,10);
});
test('保存領域は合言葉ごとに分離し、クエリの合言葉は受け付けない',async()=>{
  const ids=[];const env={MONITORS:{idFromName:id=>{ids.push(id);return id;},get:()=>({fetch:async()=>new Response('{}')})}};
  for(const token of ['a'.repeat(64),'b'.repeat(64)])await routeMonitor(new Request('https://example.com/api/monitor',{headers:{Authorization:`Bearer ${token}`}}),env);
  assert.notEqual(ids[0],ids[1]);assert(!ids.includes('a'.repeat(64)));
  const response=await routeMonitor(new Request('https://example.com/api/monitor?key='+ 'a'.repeat(64)),env);assert.equal(response.status,401);
});
test('永続保存と目覚まし設定、停止で目覚まし解除、再起動から復元',async()=>{
  const data=new Map();let alarm=null;const storage={get:async k=>data.get(k),put:async(k,v)=>data.set(k,v),delete:async k=>data.delete(k),setAlarm:async n=>alarm=n,deleteAlarm:async()=>alarm=null,transaction:async fn=>fn(storage)};
  let object=new InventoryMonitor({storage},{});
  const command=body=>new Request('https://x/api/monitor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  let response=await object.fetch(command({action:'add',rule:config,seeds:[seed]}));assert.equal(response.status,200);assert(alarm>Date.now());
  object=new InventoryMonitor({storage},{});response=await object.fetch(new Request('https://x/api/monitor'));assert.equal((await response.json()).targets.length,1);
  response=await object.fetch(command({action:'settings',enabled:false}));assert.equal(alarm,null);
  // 大きな状態も保存項目ごとの上限を超えずに復元できる。
  const state=await object.load();state.error='あ'.repeat(90000);await object.save(state);assert.equal((await object.load()).error.length,90000);
  for(const [k,v]of data)if(k.startsWith('chunk:'))assert(Buffer.byteLength(v)<128*1024);
});
test('通知内容のメンションを無効化、秘密の転送を許可しない',async(t)=>{
  const original=globalThis.fetch;let captured;
  globalThis.fetch=async(url,options)=>{captured={url:String(url),options};return new Response('{}');};t.after(()=>globalThis.fetch=original);
  await sendDiscord(webhook,{id:'test',at:1000000,title:'@everyone GD04',price:5808,storeId:'mediaworld',stock:'in_stock',url:seed.url});
  assert(captured.url.endsWith('?wait=true'));assert.equal(captured.options.redirect,'error');assert.deepEqual(JSON.parse(captured.options.body).allowed_mentions,{parse:[]});
});
test('実行アダプターでも税抜・会員価格の比較不可を保持する',async(t)=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response('<h1>ガンダムカードゲーム GD04 BOX</h1><main>販売価格 5,000円 税抜 在庫あり</main>');t.after(()=>globalThis.fetch=original);
  const result=await makeMonitorIO(async()=>{}).check(seed);assert.equal(result.row.priceComparable,false);
});
test('30秒監視で既知商品があっても新規掲載の検索を実行する',async()=>{
  const {s}=fixture();s.intervalSeconds=30;s.jobs=s.jobs.filter(j=>j.storeId==='mediaworld');s.jobs[0].nextAt=0;let searched=0,checked=0;
  await runMonitorTick(s,io(s,{check:async()=>{checked++;return {row};},discover:async()=>{searched++;return {status:'no_hit',results:[]};}}));
  assert.equal(searched,1);assert.equal(checked,0);
  await runMonitorTick(s,io(s,{now:()=>1031000,check:async()=>{checked++;return {row};}}));assert.equal(checked,1);
});
test('重なる条件の通知をまとめ、短時間の再入荷は5分経過後に通知できる',()=>{
  const {s,t}=fixture();addRule(s,{...config,priceLimit:'110'},[seed]);observe(s,t,row,1000000);assert.equal(s.events.length,1);
  observe(s,t,{...row,stock:'out_of_stock'},1060000);observe(s,t,{...row,stock:'out_of_stock'},1120000);
  observe(s,t,row,1180000);assert.equal(s.events.length,1);
  observe(s,t,row,1300000);assert.equal(s.events.length,2);
});
