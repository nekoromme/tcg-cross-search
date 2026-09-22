import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyMonitor,addRule,addTarget,activeTarget,activeJob,effectiveInterval,discoveryInterval,observe,recordFailure,publicMonitor} from '../src/monitor-core.js';
import {monitorCommand,makeMonitorIO} from '../src/monitor-service.js';
import {runMonitorTick} from '../src/monitor-engine.js';
import {recordHistory,pruneHistory} from '../src/monitor-history.js';
import {historyMarkup} from '../public/monitor-history-view.js';
const title='ガンダムカードゲーム GD04 BOX';
const config={query:'GD04',game:'gundam',storeIds:['mediaworld'],priceLimit:'all',includeUnknown:true};
const seed=i=>({title,storeId:'mediaworld',url:`https://mediaworld.co.jp/products/${i}`});
const row={title,price:5808,stock:'in_stock',detailChecked:true};
function fixture(){const state=emptyMonitor();const rule=addRule(state,config,[seed(1)]);return {state,rule,target:state.targets[0]};}
const io={save:async()=>{},storeHost:()=> 'mediaworld.co.jp',check:async()=>({row}),discover:async()=>({status:'no_hit',results:[],coverage:{}})};

test('店舗OFFで既知商品の確認・新規掲載検索・通知待ちがすべて止まり、再開で戻る',async()=>{
  const {state,target}=fixture();state.events=[{targetId:target.id,delivery:'pending'}];let checks=0,jobs=0;
  await monitorCommand(state,{action:'store-toggle',storeId:'mediaworld',enabled:false});
  assert(!activeTarget(state,target));assert(!activeJob(state,state.jobs[0]));assert.equal(state.events[0].delivery,'cancelled');
  await runMonitorTick(state,{...io,check:async()=>{checks++;return {row};},discover:async()=>{jobs++;return {results:[]};}});
  assert.equal(checks+jobs,0);
  assert.equal(target.history.at(-1).kind,'pause');
  await monitorCommand(state,{action:'store-toggle',storeId:'mediaworld',enabled:true});
  assert(activeTarget(state,target));assert(activeJob(state,state.jobs[0]));assert.equal(target.history.at(-1).kind,'resume');
});
test('個別OFFは再発見・店舗OFF→ON・条件OFF→ONでも解除されない',async()=>{
  const {state,rule,target}=fixture();
  await monitorCommand(state,{action:'target-toggle',id:target.id,enabled:false});
  addTarget(state,rule,{...seed(1),url:seed(1).url+'?_pos=2'},Date.now());
  assert.equal(state.targets.length,1);assert.equal(target.enabled,false);
  for(const enabled of [false,true])await monitorCommand(state,{action:'store-toggle',storeId:'mediaworld',enabled});
  for(const enabled of [false,true])await monitorCommand(state,{action:'toggle',id:rule.id,enabled});
  assert(!activeTarget(state,target));assert.equal(target.enabled,false);
  await monitorCommand(state,{action:'target-toggle',id:target.id,enabled:true});assert(activeTarget(state,target));
});
test('停止した対象は巡回負荷から除外され、個別ONでも店舗OFFなら停止のまま',async()=>{
  const {state,rule,target}=fixture();for(let i=2;i<=10;i++)addTarget(state,rule,seed(i),Date.now());
  const before=effectiveInterval(state,target);
  for(const t of state.targets.slice(1))await monitorCommand(state,{action:'target-toggle',id:t.id,enabled:false});
  assert(effectiveInterval(state,target)<before);
  await monitorCommand(state,{action:'store-toggle',storeId:'mediaworld',enabled:false});
  await monitorCommand(state,{action:'target-toggle',id:target.id,enabled:true});
  assert(!activeTarget(state,target));assert.equal(publicMonitor(state).targets[0].monitorStatus,'店舗をOFF');
  assert.equal(publicMonitor(state).load.activePages,0);
});
test('不正な店舗やページの指定では設定を書き換えない',async()=>{
  const {state}=fixture(),before=JSON.stringify(state);
  for(const command of [{action:'store-toggle',storeId:'unknown',enabled:false},{action:'target-toggle',id:'missing',enabled:false},{action:'store-toggle',storeId:'mediaworld',enabled:'false'}])await assert.rejects(monitorCommand(state,command));
  assert.equal(JSON.stringify(state),before);
});
test('OFFの商品は掲載検索の詳細取得からも除外し、他の商品は確認する',async t=>{
  const calls=[];t.mock.method(globalThis,'fetch',async url=>{
    calls.push(String(url));
    return new Response(String(url).includes('/search')?`<a href="/products/1?_pos=2">${title}</a><a href="/products/2">${title}</a>`:`<h1>${title}</h1><span>5808円</span><span>在庫あり</span>`,{headers:{'Content-Type':'text/html'}});
  });
  await makeMonitorIO(async()=>{}).discover(config,'mediaworld',{},{pausedUrls:[seed(1).url]});
  assert(!calls.some(url=>url.includes('/products/1')));assert(calls.some(url=>url.includes('/products/2')));
});
test('同じ価格と在庫は確認時刻と回数をまとめ、値下げ・売切・再入荷は別の行になる',()=>{
  const {state,target}=fixture(),now=Date.now();
  observe(state,target,row,now);observe(state,target,row,now+1000);
  assert.equal(target.history.length,1);assert.equal(target.history[0].samples,2);assert.equal(target.history[0].lastAt,now+1000);
  observe(state,target,{...row,price:5000},now+2000);
  observe(state,target,{...row,stock:'out_of_stock',price:null},now+3000);
  observe(state,target,row,now+4000);
  assert.deepEqual(target.history.map(x=>[x.stock,x.price]),[['in_stock',5808],['in_stock',5000],['out_of_stock',null],['in_stock',5808]]);
});
test('取得失敗・不明・停止の前後をつながず、再開で通知済み情報を消さない',async()=>{
  const {state,target}=fixture(),now=Date.now();
  observe(state,target,row,now);recordFailure(target,'通信失敗',now+1000,60);observe(state,target,row,now+2000);
  observe(state,target,{...row,stock:'unknown'},now+3000);
  assert.deepEqual(target.history.map(x=>x.kind),['observation','error','observation','error']);
  assert.equal(target.lastGood.stock,'in_stock');
  const episodes=Object.keys(target.episodes);assert.equal(state.events.length,1);
  await monitorCommand(state,{action:'settings',enabled:false});await monitorCommand(state,{action:'settings',enabled:true});
  assert.equal(target.history.at(-1).kind,'resume');assert.deepEqual(Object.keys(target.episodes),episodes);
  observe(state,target,row,now+5000);assert.equal(state.events.length,1);
});
test('履歴は100件まで、30日以上更新されていない記録を除外し、旧データから値を捏造しない',()=>{
  const target={},now=Date.now();
  for(let i=0;i<120;i++)recordHistory(target,{kind:'observation',stock:'in_stock',price:i+1},now+i);
  assert.equal(target.history.length,100);assert.equal(target.history[0].price,21);
  assert.equal(pruneHistory(target,now+31*86400000).length,0);
  const {state,target:old}=fixture();old.lastGood=row;old.lastGoodAt=now-1000;
  assert.equal(publicMonitor(state).targets[0].history.length,0);
});
test('履歴表示は時刻幅と確認回数を明記し、店舗由来の文字列をHTMLとして実行しない',()=>{
  const text=historyMarkup([{kind:'observation',at:1,lastAt:2,samples:2,stock:'in_stock',price:5808},{kind:'error',at:3,lastAt:3,samples:1,reason:'<img src=x onerror=alert(1)>'}],n=>`時刻${n}`);
  assert(text.includes('2回の確認'));assert(text.includes('時刻1'));assert(text.includes('時刻2'));assert(text.includes('5,808円'));
  assert(!text.includes('<img'));assert(text.includes('&lt;img'));
});
