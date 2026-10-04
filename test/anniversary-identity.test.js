import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyMonitor,addTarget,matchesRule,createRuleMatcher,eligibility} from '../src/monitor-core.js';
import {syncAutomaticCatalog} from '../src/automatic-catalog.js';
import {runMonitorTick} from '../src/monitor-engine.js';
import {identifyProduct,comparePrice} from '../public/catalog.js';
const now=Date.parse('2026-10-04T02:00:00Z');
// 2026-10-04の本番で拾った別ゲームの実例。通知履歴の識別子はfixture専用にする。
const title='【予約販売　10月23日発売予定】タイトルブースター プレミアム「ペルソナ 30th Anniversary」 BOX【ヴァンガード】';
function fixture(){const s=emptyMonitor();s.automatic={enabled:true};syncAutomaticCatalog(s,{seen_releases:{}},now);const r=s.rules.find(r=>r.automaticProductId==='pokemon-m6a');r.config.automaticProduct.aliases=['30th CELEBRATION','30th'];return {s,r};}
test('別作品の30thにポケカの定価・200%上限を適用しない。旧aliasが保存されていても除外',()=>{
  const {r}=fixture();
  for(const value of [title,'ペルソナ 30th Anniversary BOX','30th Anniversary BOX','ヴァンガード 30th CELEBRATION BOX']) {
    const row={title:value,stock:'preorder',price:5200,detailChecked:true};
    assert.equal(identifyProduct(value),null,value);assert.equal(comparePrice(row).status,'unknown');
    assert.equal(matchesRule(row,r.config),false,value);assert.equal(createRuleMatcher(r.config)(row),false,value);assert.equal(eligibility(row,r.config),false,value);
  }
  for(const value of ['30th CELEBRATION BOX','ポケモンカードゲーム 30th BOX','ポケカ 30th BOX','30周年 セレブレーション BOX'])assert(matchesRule({title:value},r.config),value);
});
test('誤って登録した旧ページを停止し、送信済みIDは保存して対象違いの記録を付ける',async()=>{
  const {s,r}=fixture(),t=addTarget(s,r,{title,storeId:'cardmax',url:'https://www.cardmax.jp/shop/shopdetail.html?brandcode=000000228529'},now);
  t.lastGood={title,stock:'preorder',price:5200,detailChecked:true};s.jobs=[];
  s.events=[{id:'already-sent',receiptId:'receipt-kept',targetId:t.id,ruleId:r.id,delivery:'sent',at:now-1000}];
  await runMonitorTick(s,{now:()=>now,save:async()=>{},storeHost:()=>'',notify:async()=>assert.fail('誤商品を再送しない')});
  assert.equal(t.enabled,false);assert.equal(s.events[0].delivery,'sent');assert.equal(s.events[0].receiptId,'receipt-kept');assert(s.events[0].invalidReason);
  assert(!r.config.automaticProduct.aliases.includes('30th'));assert.equal(s.automatic.pricePolicy.overrides['pokemon-m6a'].percent,200);
});
