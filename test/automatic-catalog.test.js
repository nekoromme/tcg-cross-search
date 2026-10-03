import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {emptyMonitor,addTarget,observe,publicMonitor,matchesRule,activeJob} from '../src/monitor-core.js';
import {syncAutomaticCatalog,refreshAutomaticCatalog,catalogProducts,selectAutomaticProducts} from '../src/automatic-catalog.js';
import {runMonitorTick,sendDiscord} from '../src/monitor-engine.js';
const feed=JSON.parse(readFileSync(new URL('./fixtures/official-stock-releases-2026-10-03.json',import.meta.url)));
const now=Date.parse('2026-10-03T13:00:00Z');
function state(){const s=emptyMonitor();s.automatic={enabled:true};syncAutomaticCatalog(s,feed,now);return s;}

test('実際の公式発売履歴から指定3商品・各作品の直近5弾・未来の新弾を選ぶ',()=>{
  const s=state(), ps=s.automatic.products;
  for(const id of ['gundam-gd01','gundam-gd05','pokemon-m6a'])assert(ps.find(p=>p.id===id&&p.pinned));
  for(const game of ['pokemon','onepiece','gundam','dragonball','lorcana'])assert(ps.filter(p=>p.game===game&&p.releaseDate<='2026-10-03').length>=5);
  assert(ps.some(p=>p.query==='GD06'));assert(ps.some(p=>p.query==='OP-18'));assert(ps.some(p=>p.query==='FB12'));
  assert(!ps.some(p=>/MOVIE|収録パラレル/.test(p.name)));
  assert.equal(publicMonitor(s).limits.rules,80);
});
test('再同期・一時的なカタログ欠落でも通知・停止状態を保持し、二重追加しない',()=>{
  const s=state(), r=s.rules.find(r=>r.config.query==='GD05');r.enabled=false;
  const count=s.rules.length,events=s.events.length;
  syncAutomaticCatalog(s,feed,now+3600000);assert.equal(s.rules.length,count);assert.equal(s.events.length,events);assert.equal(r.enabled,false);
  syncAutomaticCatalog(s,{seen_releases:{}},now+7200000);assert(s.automatic.products.some(p=>p.query==='GD06'));
});
test('新弾が出ると1度だけ追加通知し、発売後も固定指定を残す',()=>{
  const s=state(), changed=structuredClone(feed);
  changed.seen_releases.new={game_id:'gundam_card',source_tier:'official',confidence:'high',extraction_method:'gundam_official_booster_catalog',official_url:'https://www.gundam-gcg.com/jp/products/gd08.html',product_category:'ブースターパック',product_name:'Test New Set [GD08]',release_date:'2027-04-01'};
  syncAutomaticCatalog(s,changed,now);assert.equal(s.events[0].products.length,1);assert.match(s.events[0].products[0].name,/GD08/);
  const n=s.events.length;syncAutomaticCatalog(s,changed,now+1);assert.equal(s.events.length,n);
  syncAutomaticCatalog(s,changed,Date.parse('2027-05-01'));assert(s.automatic.products.some(p=>p.id==='gundam-gd01'));
  const retired=s.rules.find(r=>r.automaticProductId==='gundam-gd02');assert(retired.autoRetired);assert(!activeJob(s,s.jobs.find(j=>j.ruleId===retired.id)));
});
test('取得失敗は前回の対象を維持し、失敗ログと再試行予定を保存する',async()=>{
  const s=state(),count=s.rules.length;s.automatic.nextSync=0;
  await refreshAutomaticCatalog(s,now,async()=>new Response('blocked',{status:503}));
  assert.equal(s.rules.length,count);assert(s.automatic.error);assert.equal(s.automatic.nextSync,now+1800000);
});
test('30周年の通常BOXだけ通知し、特別BOX・デッキ・海外版は除外する',()=>{
  const s=state(),r=s.rules.find(r=>r.automaticProductId==='pokemon-m6a');
  assert(matchesRule({title:'ポケモンカード 30th CELEBRATION BOX'},r.config));
  for(const title of ['30th CELEBRATION FUTURISTIC BOX','30th CELEBRATION プレミアムデッキセット エーフィ BOX','30th CELEBRATION カードセット BOX','30th CELEBRATION English BOX'])assert(!matchesRule({title},r.config));
  const t=addTarget(s,r,{title:'ポケモンカード 30th CELEBRATION BOX',url:'https://mediaworld.co.jp/products/stock-test',storeId:'mediaworld'},now);
  observe(s,t,{title:t.title,price:25000,stock:'in_stock',detailChecked:true},now);const n=s.events.length;
  observe(s,t,{title:t.title,price:25000,stock:'in_stock',detailChecked:true},now+60000);assert.equal(s.events.length,n);assert.equal(t.history[0].samples,2);
});
test('新弾通知も保存して配送し、2回目は再送しない',async()=>{
  const s=emptyMonitor();s.automatic={enabled:true};s.webhook='configured';syncAutomaticCatalog(s,feed,now);s.jobs=[];
  let sent=0;const io={now:()=>now,save:async()=>{},notify:async()=>sent++,storeHost:id=>id};
  await runMonitorTick(s,io);await runMonitorTick(s,io);assert.equal(sent,1);assert.equal(s.events[0].delivery,'sent');assert.equal(s.runs.length,2);
});
test('新弾通知の本文もDiscordの文字数以内でメンションを無効化',async t=>{
  const original=globalThis.fetch;let body;t.after(()=>globalThis.fetch=original);
  globalThis.fetch=async(url,options)=>{body=JSON.parse(options.body);return new Response('{}');};
  await sendDiscord('https://discord.com/api/webhooks/123456789012345678/'+'x'.repeat(60),{kind:'catalog',title:'追加',id:'test',products:state().automatic.products});
  assert(body.content.length<=2000);assert.deepEqual(body.allowed_mentions,{parse:[]});
});
