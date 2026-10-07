import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {emptyMonitor,addRule,observe,effectiveInterval,publicMonitor} from '../src/monitor-core.js';
import {runMonitorTick} from '../src/monitor-engine.js';
import {syncAutomaticCatalog} from '../src/automatic-catalog.js';
import {syncDiscoveryStores,fetchDiscoveryListings,discoverListingSources,runStoreDiscovery,registerDiscoveryRows} from '../src/monitor-discovery.js';
import {discoveryStore,focusStore,focusTarget,storeCadence,discoveryBudget,DISCOVERY_POLICY} from '../src/monitor-cadence.js';
import {makeMonitorIO} from '../src/monitor-service.js';
import {STORE_MAP} from '../src/stores.js';
import {discoveryMarkup} from '../public/monitor-discovery-view.js';
const now=Date.parse('2026-10-04T01:00:00Z'), minute=60_000;
const config={query:'GD01',game:'gundam',storeIds:['cardwiz']};
const row={title:'ガンダム GD01 BOX',storeId:'cardwiz',url:'https://www.cardwiz.jp/product/123',price:5808,detailChecked:true,stock:'in_stock'};
function fixture(){const state=emptyMonitor();state.automatic={enabled:true};const rule=addRule(state,config,[],now);syncDiscoveryStores(state,now);return {state,rule,profile:state.discovery.stores.cardwiz};}
const listing=(rows=[row])=>rows.map(r=>`<a href="${r.url}">${r.title}</a>`).join('');
function page(text){return {status:200,text,truncated:false};}

test('38弾を店舗単位に束ね、価格上限と送信済みIDを変更しない',async()=>{
  const state=emptyMonitor();state.automatic={enabled:true};
  syncAutomaticCatalog(state,JSON.parse(readFileSync(new URL('./fixtures/official-stock-releases-2026-10-03.json',import.meta.url))),now);
  state.events=[{id:'9070360c-deac-49a7-bfac-1cf400fca214',delivery:'sent',receiptId:'kept'}];
  let calls=0;
  await runMonitorTick(state,{now:()=>now,storeHost:id=>new URL(STORE_MAP.get(id).home).hostname,save:async()=>{},discoverStore:async()=>{calls++;return {status:'ok',results:[],pages:[],requests:1};}});
  assert.equal(state.rules.length,38);assert.equal(Object.keys(state.discovery.stores).length,19);assert.equal(calls,1);
  assert.equal(state.events[0].receiptId,'kept');assert.equal(state.automatic.pricePolicy.defaultPercent,105);
  assert.equal(state.automatic.pricePolicy.overrides['pokemon-m6a'].percent,200);
  assert(state.jobs.length>500); // 個別検索による補完も履歴ごと維持
});
test('一覧を一度だけ取得し複数弾を登録。詳細未確認の価格・在庫では通知しない',async()=>{
  const {state,rule,profile}=fixture();addRule(state,{...config,query:'GD05'},[],now);
  const rows=[row,{...row,title:'ガンダム GD05 BOX',url:'https://www.cardwiz.jp/product/125'}];
  let calls=0;const result=await fetchDiscoveryListings('cardwiz',state.rules,profile,async()=>{calls++;return page(listing(rows));});
  assert.equal(calls,1);assert.equal(result.results.length,2);
  const counts=registerDiscoveryRows(state,state.rules,'cardwiz',result.results,now,'store-listing',true);
  assert.equal(counts.registered,2);assert.equal(state.events.length,0);assert.equal(state.targets[0].lastGood,null);
  assert.equal(registerDiscoveryRows(state,[rule],'cardwiz',result.results,now+minute,'store-listing').registered,0);
  assert.equal(state.targets.length,2);
});
test('最初の取込では高速化せず、その後の発見で10分×2時間。初回発見を掲載開始と偽らない',async()=>{
  const {state,profile}=fixture();const io={storeHost:()=> 'www.cardwiz.jp',save:async()=>{},discoverStore:async()=>({status:'ok',results:[row],pages:[],requests:1})};
  await runStoreDiscovery(state,profile,io,now);assert.equal(profile.intervalMs,30*minute);assert.equal(state.targets[0].discovery.publicationAt,null);
  io.discoverStore=async()=>({status:'ok',results:[{...row,url:'https://www.cardwiz.jp/product/124'}],pages:[],requests:1});
  await runStoreDiscovery(state,profile,io,now+30*minute);assert.equal(profile.intervalMs,10*minute);assert.equal(profile.focusUntil,now+150*minute);
  assert.equal(storeCadence(profile,now+151*minute).mode,'normal');
  profile.successes=24;assert.equal(storeCadence(profile,now+2*86400000).intervalMs,60*minute);
});
test('長い観測間隔・初回から在庫あり・取得失敗では短時間完売と推定しない',()=>{
  const {state,rule,profile}=fixture();registerDiscoveryRows(state,[rule],'cardwiz',[row],now,'test');const target=state.targets[0];
  observe(state,target,row,now);observe(state,target,{...row,stock:'out_of_stock'},now+minute);
  assert.equal(profile.rapidSales.length,0);assert.equal(target.availabilityTiming.lastSale.durationUpperMs,null);
  observe(state,target,row,now+40*minute);observe(state,target,{...row,stock:'out_of_stock'},now+41*minute);
  assert.equal(profile.rapidSales.length,0);assert.equal(target.availabilityTiming.lastSale.durationUpperMs,40*minute);
  observe(state,target,{...row,stock:'unknown'},now+42*minute);assert.equal(profile.rapidSales.length,0);
});
test('売切→購入可能→売切の上限15分以内を2回確認した店だけ24時間重点監視',()=>{
  const {state,rule,profile}=fixture();registerDiscoveryRows(state,[rule],'cardwiz',[row],now,'test');const target=state.targets[0];
  for(const [m,stock] of [[0,'out_of_stock'],[2,'in_stock'],[7,'out_of_stock'],[9,'preorder'],[13,'out_of_stock']])observe(state,target,{...row,stock},now+m*minute);
  assert.equal(profile.rapidSales.length,2);assert.equal(profile.focusUntil,now+13*minute+86400000);
  assert.equal(target.availabilityTiming.lastSale.durationUpperMs,6*minute);
  assert.equal(state.events.length,1); // 二度連続の売切を挟まないので既存の重複抑止を維持
});
test('重点枠は最大3店・5商品、通信予算を配分し期限後は通常へ戻る',()=>{
  const {state,rule}=fixture();
  for(let i=0;i<8;i++){const p=discoveryStore(state,`store-${i}`,now);focusStore(state,p,'観測',now);registerDiscoveryRows(state,[rule],'cardwiz',[{...row,url:`https://www.cardwiz.jp/product/${1000+i}`}],now,'test');}
  assert.equal(Object.values(state.discovery.stores).filter(x=>x.focusUntil>now).length,3);
  assert.equal(state.targets.filter(x=>x.focusUntil>now).length,5);
  const focused=state.targets[0];assert(effectiveInterval(state,focused,now)>=120);
  const total=state.targets.reduce((n,t)=>n+86400/effectiveInterval(state,t,now),0);assert(total<=1200.001);
  assert.equal(storeCadence(state.discovery.stores['store-0'],now+3*3600000).mode,'normal');
});
test('403と通信上限は店舗全体を待機、一覧の解析失敗では既知商品の巡回を止めない',async()=>{
  for(const [status,accessLimited,hostWait] of [[403,false,true],[0,true,true],[200,false,false]]){
    const {state,profile}=fixture();
    await runStoreDiscovery(state,profile,{save:async()=>{},storeHost:()=> 'www.cardwiz.jp',discoverStore:async()=>({status:'error',httpStatus:status,accessLimited,retryAt:now+2*3600000,requests:1})},now);
    assert.equal(state.hosts['www.cardwiz.jp']>now+minute,hostWait);assert(profile.nextAt>=now+2*3600000);assert.equal(profile.successes,0);
  }
});
test('店舗が表示した新着URLだけ利用し外部リンクは追わない。先頭と後方を2取得以内で併用',async()=>{
  const {state,profile}=fixture(),store=STORE_MAP.get('cardwiz');
  const discovered=discoverListingSources('<a href="/new">新着商品</a><a href="https://evil.test/new">新着商品</a>',store.action,store);
  assert.deepEqual(discovered,[{url:'https://www.cardwiz.jp/new',role:'new'}]);
  profile.sources=[{url:'https://www.cardwiz.jp/product-list?keyword=BOX',role:'search',nextUrl:'https://www.cardwiz.jp/product-list?keyword=BOX&page=3',depth:2},{url:'https://www.cardwiz.jp/new',role:'new'}];
  const urls=[];const r=await fetchDiscoveryListings('cardwiz',state.rules,profile,async url=>{urls.push(url);return page(listing()+'<a href="?keyword=BOX&page=4">次へ</a>');});
  assert.equal(urls.length,2);assert.equal(urls[0],'https://www.cardwiz.jp/new');assert.match(urls[1],/page=3/);
  assert.equal(r.sources[0].depth,3);assert.match(r.sources[0].nextUrl,/page=4/);
});
test('新着一覧の解析失敗でも補完一覧を取得し、空結果と混同しない',async()=>{
  const {state,profile}=fixture();profile.sources=[{url:'https://www.cardwiz.jp/product-list?keyword=BOX',role:'search'},{url:'https://www.cardwiz.jp/new',role:'new'}];
  const r=await fetchDiscoveryListings('cardwiz',state.rules,profile,async url=>page(url.endsWith('/new')?'<main>ページを表示できません</main>':listing()));
  assert.equal(r.status,'partial');assert.equal(r.results.length,1);assert(r.sources[1].disabledUntil>Date.now());
});
test('発見の通信枠を先に予約し、日次上限で止まる。日時変更でログを削除しない',async()=>{
  const {state,profile}=fixture();discoveryBudget(state,'group',now);state.discovery.budget.group=DISCOVERY_POLICY.groupDaily;
  let calls=0;await runMonitorTick(state,{now:()=>now,save:async()=>{},storeHost:()=> 'www.cardwiz.jp',discoverStore:async()=>{calls++;},discover:async()=>({status:'no_hit',results:[],coverage:{requests:1}})});
  assert.equal(calls,0);assert(discoveryBudget(state,'group',now+86400000).ok);assert.equal(profile.nextAt,now);
});
test('自動監視の補完検索は詳細を二重取得しない',async t=>{
  const original=globalThis.fetch;let count=0;t.after(()=>globalThis.fetch=original);
  globalThis.fetch=async()=>{count++;return new Response(listing());};
  const result=await makeMonitorIO(async()=>{}).discover(config,'cardwiz',{}, {listingOnly:true});
  assert.equal(count,1);assert.equal(result.results[0].detailChecked,false);assert.equal(result.coverage.detailChecks,0);
});
test('公開状態に観測理由・価格・履歴を含め、停止した店と商品の設定を維持する',async()=>{
  const {state,rule}=fixture();registerDiscoveryRows(state,[rule],'cardwiz',[row],now,'test');state.targets[0].enabled=false;state.disabledStoreIds=['cardwiz'];
  await runMonitorTick(state,{now:()=>now,save:async()=>{},storeHost:()=> 'www.cardwiz.jp',discoverStore:async()=>assert.fail('停止店へ接続不可')});
  assert.equal(state.targets[0].enabled,false);const pub=publicMonitor(state);assert.equal(pub.discovery.policy.version,1);
  const html=discoveryMarkup(pub.discovery,{cardwiz:'<script>bad</script>'},String);assert(!html.includes('<script>'));assert.match(html,/掲載開始時刻とは限りません/);
});

test('実店舗の新着リンク・複数弾のBOX表記を取得済みの入力でも認識する',async()=>{
  const state=emptyMonitor();state.automatic={enabled:true};
  syncAutomaticCatalog(state,JSON.parse(readFileSync(new URL('./fixtures/official-stock-releases-2026-10-03.json',import.meta.url))),now);
  const fixtures=JSON.parse(readFileSync(new URL('./fixtures/discovery-listings-2026-10-04.json',import.meta.url)));
  for(const f of fixtures){const result=await fetchDiscoveryListings(f.storeId,state.rules.filter(r=>r.config.storeIds.includes(f.storeId)),{},async()=>page(f.html));assert.equal(result.status,'ok',f.storeId);assert(result.results.length>0,f.storeId);}
});


test('竜のしっぽは公式の新品欄を1回だけ読み、GD01通常BOXだけ登録候補にする',async()=>{
  const state=emptyMonitor();state.automatic={enabled:true};
  const releaseFeed=JSON.parse(readFileSync(new URL('./fixtures/official-stock-releases-2026-10-03.json',import.meta.url)));
  syncAutomaticCatalog(state,releaseFeed,now);
  const gd01=state.rules.find(r=>r.automaticProductId==='gundam-gd01');
  const paused=state.rules.find(r=>r.automaticProductId==='gundam-gd02');paused.enabled=false;
  syncAutomaticCatalog(state,releaseFeed,now+1);
  assert(gd01.config.storeIds.includes('ryuunoshippo'));
  assert(state.jobs.some(j=>j.ruleId===gd01.id&&j.storeId==='ryuunoshippo'));
  assert.equal(paused.enabled,false);
  const html=readFileSync(new URL('./fixtures/ryuunoshippo-new-products-2026-10-07.html',import.meta.url),'utf8');
  let calls=0;
  const result=await fetchDiscoveryListings('ryuunoshippo',[gd01],{},async url=>{
    calls++;assert.equal(url,'https://www.ryuunoshippo7.com/product-group/2?view=recommend');
    return page(html);
  });
  assert.equal(calls,1);
  assert.equal(result.status,'ok');
  assert.equal(result.results.length,1);
  assert.equal(result.results[0].url,'https://www.ryuunoshippo7.com/product/1273');
  assert.equal(result.results[0].price,5800);
  assert.equal(result.results[0].stock,'out_of_stock');
  assert.match(result.results[0].title,/GD01/);
});
