import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {emptyMonitor,addTarget,observe,eligibility} from '../src/monitor-core.js';
import {syncAutomaticCatalog} from '../src/automatic-catalog.js';
import {applyAutomaticPricing,priceAssessment,updateRulePrice} from '../src/monitor-pricing.js';
import {runMonitorTick,sendDiscord} from '../src/monitor-engine.js';
import {rulePriceForm} from '../public/monitor-price-view.js';
import {historyMarkup} from '../public/monitor-history-view.js';
const feed=JSON.parse(readFileSync(new URL('./fixtures/official-stock-releases-2026-10-03.json',import.meta.url)));
const NOW=Date.parse('2026-10-04T00:30:00Z');
function setup(){const s=emptyMonitor();s.automatic={enabled:true};s.webhook='configured';syncAutomaticCatalog(s,feed,NOW);s.events=[];s.jobs=[];return s;}
function row(title,price){return {title,price,stock:'in_stock',detailChecked:true};}
function target(s,id,title){const rule=s.rules.find(r=>r.automaticProductId===id);return [rule,addTarget(s,rule,{title,url:`https://mediaworld.co.jp/products/${id}`,storeId:'mediaworld'},NOW)];}

test('指定BOXの境界価格を整数で比較し、1円超過と別仕様の30thを除外する',()=>{
  const s=setup();
  for(const [id,title,cap] of [['gundam-gd01','ガンダム GD01 BOX',6098],['gundam-gd05','ガンダム GD05 BOX',6300],['pokemon-m6a','ポケモン 30th CELEBRATION BOX',14400]]) {
    const r=s.rules.find(r=>r.automaticProductId===id);
    assert.equal(eligibility(row(title,cap),r.config),true);
    assert.equal(eligibility(row(title,cap+1),r.config),false);
    assert.equal(priceAssessment(row(title,cap),r.config).maxPrice,cap);
  }
  const r=s.rules.find(r=>r.automaticProductId==='pokemon-m6a');
  for(const title of ['30th CELEBRATION FUTURISTIC BOX','30th CELEBRATION English BOX','30th CELEBRATION BOX 2箱セット'])assert.equal(eligibility(row(title,14400),r.config),false);
});
test('高い在庫も履歴へ残し、値下がりで条件内になった時だけ通知する',()=>{
  const s=setup(),[r,t]=target(s,'pokemon-m6a','ポケモン 30th CELEBRATION BOX');
  observe(s,t,row(t.title,33500),NOW);assert.equal(s.events.length,0);assert.equal(t.priceDecisions[r.id].status,'over_limit');
  assert.match(historyMarkup(t.history,String),/14,400円を超過/);
  observe(s,t,row(t.title,14400),NOW+60000);assert.equal(s.events.length,1);assert.equal(s.events[0].priceCondition.maxPrice,14400);
  observe(s,t,row(t.title,14400),NOW+120000);assert.equal(s.events.length,1);assert.equal(t.history.length,2);
});
test('新弾は105%を継承し、定価不明は記録だけ残して通知保留にする',()=>{
  const s=setup(),[r,t]=target(s,'gundam-gd07','ガンダム Blazing Fist GD07 BOX');
  assert.equal(r.config.priceLimit,'105');assert.equal(r.config.includeUnknown,false);
  observe(s,t,row(t.title,100),NOW);assert.equal(s.events.length,0);assert.equal(t.priceDecisions[r.id].status,'reference_unknown');assert.equal(t.history.length,1);
  assert.equal(s.automatic.products.find(p=>p.id==='gundam-gd07').priceStatus,'reference_unknown');
});
test('商品別の例外は再同期で消えず、金額上限と割合の厳しい方を使う',()=>{
  const s=setup(),[r,t]=target(s,'gundam-gd05','ガンダム GD05 BOX');r.enabled=false;
  s.events.push({id:'sent-before',delivery:'sent'});
  updateRulePrice(s,r.id,{priceLimit:'200',maxPrice:9000},NOW);
  syncAutomaticCatalog(s,feed,NOW+1);assert.equal(r.enabled,false);assert.equal(r.config.priceLimit,'200');assert.equal(r.config.maxPrice,9000);assert(s.events.some(e=>e.id==='sent-before'));
  assert.equal(eligibility(row(t.title,9000),r.config),true);assert.equal(eligibility(row(t.title,9001),r.config),false);
  assert.throws(()=>updateRulePrice(s,r.id,{priceLimit:'all'},NOW));
  assert.throws(()=>updateRulePrice(s,r.id,{priceLimit:'NaN'},NOW));
  assert.match(rulePriceForm(r),/value="200" selected/);assert.match(rulePriceForm(r),/value="9000"/);
});
test('旧版の価格無制限を移行し、待機中の高額通知と古い通知価格を送らない',async()=>{
  const s=setup(),[r,t]=target(s,'pokemon-m6a','ポケモン 30th CELEBRATION BOX');
  delete s.automatic.pricePolicy;r.config.priceLimit='all';r.config.includeUnknown=true;
  observe(s,t,row(t.title,33500),NOW);assert.equal(s.events.length,1);
  s.events.push({id:'sent-old',delivery:'sent'});t.nextAt=NOW+3600000;
  // 店頭価格が下がっていても通知待ちの本文が高いままなら再利用しない。
  t.lastGood=row(t.title,14000);
  let sends=0;const io={now:()=>NOW+1000,save:async()=>{},storeHost:()=>'',notify:async()=>sends++};
  await runMonitorTick(s,io);assert.equal(sends,0);assert.equal(s.events[0].delivery,'cancelled');assert.match(s.events[0].cancelReason,/14,400/);assert.equal(s.events[1].delivery,'sent');
  observe(s,t,row(t.title,14000),NOW+301000);t.nextAt=NOW+3600000;
  await runMonitorTick(s,{...io,now:()=>NOW+301001});assert.equal(sends,1);
  await runMonitorTick(s,{...io,now:()=>NOW+302000});assert.equal(sends,1);
});
test('上限変更で取り消した通知の理由を保持し、Discord本文にも上限を表示する',async t=>{
  const s=setup(),[r,p]=target(s,'pokemon-m6a','ポケモン 30th CELEBRATION BOX');observe(s,p,row(p.title,14000),NOW);
  const event=structuredClone(s.events[0]);updateRulePrice(s,r.id,{priceLimit:'105'},NOW+1);
  assert.equal(s.events[0].delivery,'cancelled');assert.match(s.events[0].cancelReason,/7,560/);
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);let content;
  globalThis.fetch=async(_url,options)=>{content=JSON.parse(options.body).content;return Response.json({id:'receipt'});};
  await sendDiscord('https://discord.com/api/webhooks/123456789012345678/'+'x'.repeat(60),event);
  assert.match(content,/通知上限：14,400円/);assert.match(content,/定価：7,200円（200%まで）/);assert.match(content,/送料別/);
  applyAutomaticPricing(s,NOW+2);assert.equal(r.config.priceLimit,'105');
});
