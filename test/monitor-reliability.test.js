import test from 'node:test';
import assert from 'node:assert/strict';
import {InventoryMonitor} from '../src/monitor-service.js';
import {emptyMonitor} from '../src/monitor-core.js';
import {runMonitorTick} from '../src/monitor-engine.js';
import {monitorFailure} from '../src/monitor-storage.js';
import {assertCurrentBuild} from '../scripts/prepare-worker-build.mjs';

function storageFixture(entries=[]) {
  let data=new Map(entries),writes=0,fail=false;
  const storage={get:async k=>data.get(k),put:async(k,v)=>{writes++;data.set(k,v);},delete:async k=>{writes++;data.delete(k);},setAlarm:async()=>{},deleteAlarm:async()=>{},transaction:async fn=>{
    const before=new Map(data);try{await fn(storage);if(fail)throw new Error('injected write failure');}catch(e){data=before;throw e;}
  }};
  return {storage,get writes(){return writes;},data:()=>data,fail:()=>fail=true};
}
test('増えた旧履歴を欠落なく圧縮保存し、再起動後の同一保存では書き込まない',async()=>{
  const state=emptyMonitor();state.events=[{id:'sent-once',delivery:'sent',sentAt:123}];
  state.runs=Array.from({length:1000},(_,i)=>({at:i,checked:3,error:'通信上限のため待機',details:'長い取得結果'.repeat(50)}));
  const raw=JSON.stringify(state),chunks=raw.match(/[\s\S]{1,20000}/g),fixture=storageFixture([['chunks',chunks.length],...chunks.map((c,i)=>[`chunk:${i}`,c])]);
  let object=new InventoryMonitor({storage:fixture.storage},{});
  const loaded=await object.load();assert.deepEqual(loaded,state);await object.save(loaded);
  assert.equal(fixture.data().get('chunks'),1);
  object=new InventoryMonitor({storage:fixture.storage},{});const restored=await object.load();assert.deepEqual(restored,state);
  const writes=fixture.writes;await object.save(restored);assert.equal(fixture.writes,writes);
  restored.lastTick=100;await object.save(restored);assert.equal(fixture.writes-writes,1);
  assert.equal((await new InventoryMonitor({storage:fixture.storage},{}).load()).events[0].delivery,'sent');
});
test('保存途中の失敗で前回状態を失わず、壊れた履歴を空の状態で上書きしない',async()=>{
  const fixture=storageFixture(),object=new InventoryMonitor({storage:fixture.storage},{}),s=emptyMonitor();
  await object.save(s);fixture.fail();s.lastTick=99;await assert.rejects(()=>object.save(s));
  assert.equal((await new InventoryMonitor({storage:fixture.storage},{}).load()).lastTick,null);
  const broken=storageFixture([['chunks',1]]),response=await new InventoryMonitor({storage:broken.storage},{}).fetch(new Request('https://example.com/api/monitor'));
  assert.equal(response.status,503);assert.equal((await response.json()).failure.code,'storage_data');assert.equal(broken.writes,0);
});
test('過去に成功していても直近の通知失敗を保持し、待機後に一度だけ回復する',async()=>{
  const s=emptyMonitor();s.automatic={enabled:true};s.webhook='configured';s.deliveryVersion=4;
  s.events=[{id:'old',kind:'catalog',delivery:'sent',sentAt:1},{id:'a',kind:'catalog',delivery:'pending',at:1000,nextAt:0,attempts:0},{id:'b',kind:'catalog',delivery:'pending',at:1001,nextAt:0,attempts:0}];
  let calls=0;const io={now:()=>10000,save:async()=>{},storeHost:()=>'',notify:async()=>{calls++;throw Object.assign(new Error('通知送信 HTTP 429'),{status:429,retryAfterMs:120000});}};
  await runMonitorTick(s,io);assert.equal(calls,1);assert.equal(s.deliveryHealth.consecutiveFailures,1);
  await runMonitorTick(s,{...io,now:()=>40000});assert.equal(calls,1);
  await runMonitorTick(s,{...io,now:()=>130000,notify:async()=>{calls++;return {id:'receipt'};}});
  assert.equal(calls,3);assert(s.events.every(e=>e.delivery==='sent'));assert.equal(s.deliveryHealth.consecutiveFailures,0);
  assert.equal(s.events.find(e=>e.id==='b').error,undefined);
  await runMonitorTick(s,{...io,now:()=>160000});assert.equal(calls,3);
});
test('古い本番公開を拒否し、失敗分類へ秘密を含めない',()=>{
  assert.throws(()=>assertCurrentBuild({commit:'a'.repeat(40),branch:'main',remote:'b'.repeat(40)}),/古い変更/);
  assertCurrentBuild({commit:'a'.repeat(40),branch:'main',remote:'a'.repeat(40)});
  assert.equal(monitorFailure(new Error('daily storage write quota exceeded SECRET'),'load').code,'storage_quota');
  assert(!JSON.stringify(monitorFailure(new Error('SECRET https://discord.com/api/webhooks/secret'),'load')).includes('SECRET'));
});
