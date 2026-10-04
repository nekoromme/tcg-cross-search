import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {emptyMonitor,addTarget,observe,eligibility,publicMonitor} from '../src/monitor-core.js';
import {syncAutomaticCatalog} from '../src/automatic-catalog.js';
import {applyAutomaticPriceRecords} from '../src/automatic-prices.js';
import {applyAutomaticPricing} from '../src/monitor-pricing.js';
const feed=JSON.parse(readFileSync(new URL('./fixtures/official-stock-releases-2026-10-03.json',import.meta.url)));
const NOW=Date.parse('2026-10-04T13:00:00+09:00'),id='yugioh-/japan/products/yac1/',url='https://www.yugioh-card.com/japan/products/yac1/';
function price(){return {productId:id,game:'yugioh',status:'confirmed',boxPrice:5940,packPrice:396,packsPerBox:15,officialUrl:url,checkedAt:NOW,basis:'official_pack_times_verified_count',sources:[{kind:'official_price',url,packsPerBox:15}]};}
test('未登録の実商品を公式価格で判定し、再取得時に1回だけ通知する',()=>{
  const s=emptyMonitor();s.automatic={enabled:true};syncAutomaticCatalog(s,feed,NOW);s.events=[];
  const r=s.rules.find(r=>r.automaticProductId===id),title='遊戯王 ORIGINAL ARTWORK COLLECTION BOX';
  const t=addTarget(s,r,{title,url:'https://mediaworld.co.jp/products/yac1',storeId:'mediaworld'},NOW);
  const row={title,price:6237,stock:'in_stock',detailChecked:true};
  observe(s,t,row,NOW);assert.equal(s.events.length,0);
  const prices={version:1,checkedAt:NOW,records:{[id]:price()}};
  applyAutomaticPriceRecords(s,prices,NOW+100);applyAutomaticPricing(s,NOW+100);
  assert.equal(s.events.length,0);assert.equal(eligibility(row,r.config),true);assert.equal(eligibility({...row,price:6238},r.config),false);
  observe(s,t,row,NOW+1000);assert.equal(s.events.length,1);assert.equal(s.events[0].priceCondition.referencePrice,5940);
  s.events[0].delivery='sent';s.events[0].receiptId='original-receipt';r.enabled=false;
  syncAutomaticCatalog(s,feed,NOW+2000);assert.equal(r.config.automaticProduct.boxPrice,5940);assert.equal(r.enabled,false);assert.equal(s.events[0].receiptId,'original-receipt');
  syncAutomaticCatalog(s,{...feed,prices:{version:1,records:{[id]:{...price(),status:'fetch_failed',checkedAt:NOW+3000}}}},NOW+3000);
  assert.equal(r.config.automaticProduct.boxPrice,5940);assert(t.history.length>=2);
});
test('新弾に定価が届いても通常105%を守り、外国語・別仕様・不正な価格資料は使わない',()=>{
  const s=emptyMonitor();s.automatic={enabled:true};syncAutomaticCatalog(s,feed,NOW);
  const r=s.rules.find(r=>r.automaticProductId===id),record=price();
  applyAutomaticPriceRecords(s,{version:1,records:{[id]:{...record,boxPrice:99999}}});assert.equal(r.config.automaticProduct.boxPrice,null);
  applyAutomaticPriceRecords(s,{version:1,records:{[id]:record}});applyAutomaticPricing(s,NOW);
  assert.equal(r.config.priceLimit,'105');assert.equal(s.rules.find(r=>r.automaticProductId==='pokemon-m6a').config.priceLimit,'200');
  for(const title of ['ORIGINAL ARTWORK COLLECTION 英語版 BOX','ORIGINAL ARTWORK COLLECTION BOX 2箱セット','ヴァンガード ORIGINAL ARTWORK COLLECTION BOX'])assert.equal(eligibility({title,price:100,stock:'in_stock',detailChecked:true},r.config),false);
  assert.equal(publicMonitor(s).load.intervalMinSeconds,0);
});
