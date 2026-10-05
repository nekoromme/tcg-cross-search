import test from 'node:test';
import assert from 'node:assert/strict';
import {productKind} from '../public/product-kind.js';
import {pokemon30thBoxIdentity,explicitPacksPerBox} from '../public/pokemon-30th.js';
import {identifyProduct,matchesQuery,searchTerms,comparePrice} from '../public/catalog.js';
import {selectRows} from '../public/ui.js';
import {parseProductDetail} from '../src/product-detail.js';
import {emptyMonitor,matchesRule,eligibility,addTarget,observe} from '../src/monitor-core.js';
import {syncAutomaticCatalog} from '../src/automatic-catalog.js';
import {runMonitorTick} from '../src/monitor-engine.js';
import {makeMonitorIO} from '../src/monitor-service.js';
import worker from '../src/index.js';
import {normalizeSearch} from '../public/saved-searches.js';

const now=Date.parse('2026-10-06T00:00:00Z');
function fixture(){const s=emptyMonitor();s.automatic={enabled:true};syncAutomaticCatalog(s,{seen_releases:{}},now);s.events=[];return {s,r:s.rules.find(r=>r.automaticProductId==='pokemon-m6a')};}
const normal='【新品】[TCG] (BOX) ポケモンカードゲーム MEGA(メガ) 拡張パック 30th CELEBRATION ポケモン(20パック)(20260916)';
// 2026-10-06確認。Yahooラッコポッケ c010m-021 と楽天松竹堂 pokemon30thcardset9 の商品見出し。
const cardSet='【予約】ポケモンカードゲーム MEGA 30th CELEBRATION カードセット フシギダネ・ヒトカゲ・ゼニガメ 未開封BOX';
const nineSet='ポケモンカードゲーム MEGA 30th CELEBRATION カードセット 全9種 コンプリートセット 30周年 セレブレーション ヒトカゲ ゼニガメ フシギダネ box';
const row=title=>({title,kind:'box',detailChecked:true,price:7200,stock:'in_stock'});

test('実掲載のカードセットBOX・表記ゆれ・9種・特別仕様を検索、分類、定価、通知で共通除外',()=>{
  const {r}=fixture();
  for(const title of [cardSet,nineSet,'30th CELEBRATION カード セット BOX','30th CELEBRATION CARD-SET BOX',
    '30th CELEBRATION 全９種セット BOX','30th CELEBRATION 御三家 BOX','30th CELEBRATION FUTURISTIC BOX',
    '30th CELEBRATION プレミアムデッキセット BOX','30th CELEBRATION Elite Trainer Box','30th CELEBRATION Booster Bundle BOX']) {
    assert.equal(productKind(title),'special',title);
    assert.equal(identifyProduct(title),null,title);
    assert.equal(matchesQuery(title,'30th CELEBRATION BOX'),false,title);
    assert.equal(matchesRule(row(title),r.config),false,title);
    assert.equal(eligibility(row(title),r.config),false,title);
    assert.equal(comparePrice(row(title)).status,'unknown',title);
    assert.equal(selectRows(new Map([['a',{store:{id:'a',name:'a'},results:[row(title)]}]])).main.length,0,title);
  }
  // カードセットを明示検索する用途は壊さない。通常BOXの定価は付けない。
  assert(matchesQuery(cardSet,'30th CELEBRATION カードセット'));
  for(const title of [normal,'30th CELEBRATION BOX','ポケカ 30th 1箱','30周年 セレブレーション ＢＯＸ']) {
    assert(matchesRule(row(title),r.config),title);assert.equal(eligibility({...row(title),price:14400},r.config),true,title);
    assert.equal(eligibility({...row(title),price:14401},r.config),false,title);
  }
});

test('検索はBOXを先に1回、候補なしのときだけ広い商品名に補完。単語除外を店へ丸投げしない',()=>{
  assert.deepEqual(searchTerms('30th CELEBRATION'),['30th CELEBRATION BOX','30th CELEBRATION']);
  assert.deepEqual(searchTerms('M6a'),['30th CELEBRATION BOX','30th CELEBRATION']);
  assert.deepEqual(searchTerms('30th CELEBRATION BOX'),['30th CELEBRATION BOX']);
  assert.deepEqual(searchTerms('GD05'),['GD05','Freedom Ascension']);
  assert.equal(normalizeSearch({query:'30th CELEBRATION',priceLimit:'200',maxPrice:14400}).priceLimit,'200');
});

test('入数は主商品の明示仕様だけ。JAN単独・バラ20パック・安値ではBOX認定しない',()=>{
  for(const title of ['30th CELEBRATION 1パック','30th CELEBRATION 20パックセット','30th CELEBRATION 4521329462424',
    '30th CELEBRATION 2BOX','英語版 30th CELEBRATION BOX','30th CELEBRATION BOX (2パック)'])
    assert.notEqual(pokemon30thBoxIdentity(row(title)).status,'confirmed',title);
  assert.equal(explicitPacksPerBox('1BOX＝20パック入り。1パック＝カード6枚入り'),20);
  assert.equal(explicitPacksPerBox('1BOX20パック 1BOX2パック'),-1);
  const html='<h1>30th CELEBRATION BOX</h1>販売価格:7200円 在庫あり 1BOX＝20パック入り'+
    '<section class="related"><h2>カードセット 未開封BOX</h2>1BOX＝2パック入り</section>';
  const parsed=parseProductDetail(html);assert.equal(parsed.packsPerBox,20);assert.equal(parsed.productIdentity.status,'confirmed');
  const changed=parseProductDetail('<h1>30th CELEBRATION BOX</h1>販売価格:1200円 在庫あり 1BOX＝2パック入り');
  assert.equal(changed.productIdentity.status,'excluded');assert.equal(comparePrice({...changed,detailChecked:true}).status,'unknown');
  const cached={...row('30th CELEBRATION BOX (2パック)')};
  assert.equal(selectRows(new Map([['a',{store:{id:'a',name:'a'},results:[cached]}]])).main.length,0);
  const single={...row('30th CELEBRATION 1パック'),kind:'pack'};
  assert.equal(selectRows(new Map([['a',{store:{id:'a',name:'a'},results:[single]}]]),{unit:'sealed'}).main.length,0);
  const hiddenSet=parseProductDetail('<h1>30th CELEBRATION BOX</h1>販売価格:1200円 在庫あり プロモカード（キラ）各1枚 拡張パック2パック 紙製カードスタンド1個');
  assert.equal(hiddenSet.productIdentity.status,'excluded');
});

test('商品詳細の同定結果は検索画面と本番監視IOの両方へ引き継ぐ',async t=>{
  t.mock.method(globalThis,'fetch',async url=>new Response(String(url).includes('/products/')
    ?'<h1>30th CELEBRATION BOX</h1>販売価格:1200円 在庫あり 1BOX＝2パック入り'
    :'<a href="/products/13921514000">30th CELEBRATION BOX</a>'));
  const checked=await makeMonitorIO(async()=>{}, {ACCESS_CONTROL:async()=>({ok:true,id:'test'})}).check({storeId:'mediaworld',url:'https://mediaworld.co.jp/products/13921514000'});
  assert.equal(checked.row.productIdentity.status,'excluded');assert.equal(checked.row.packsPerBox,2);
  const data=await (await worker.fetch(new Request('https://app.test/api/search?store=mediaworld&q=30th%20CELEBRATION'),{ACCESS_CONTROL:async()=>({ok:true,id:'test'})})).json();
  assert.equal(data.results[0].productIdentity.status,'excluded');
  assert.equal(selectRows(new Map([['mediaworld',data]])).main.length,0);
});

test('旧誤商品は履歴を消さず停止。送信待ちは取消し、sent/receiptは維持し再送しない',async()=>{
  const {s,r}=fixture();const target=addTarget(s,r,{title:cardSet,storeId:'mediaworld',url:'https://mediaworld.co.jp/products/fixture'},now);
  target.lastGood=row(cardSet);target.history=[{at:now-1000,lastAt:now-1000,kind:'observation'}];s.jobs=[];
  s.events=[{id:'sent-fixture',receiptId:'receipt-fixture',targetId:target.id,ruleId:r.id,delivery:'sent'},
    {id:'pending-fixture',targetId:target.id,ruleId:r.id,delivery:'pending',nextAt:now}];
  await runMonitorTick(s,{now:()=>now,save:async()=>{},storeHost:()=>'',notify:async()=>assert.fail('誤商品を再送しない')});
  assert.equal(target.enabled,false);assert.equal(target.history[0].kind,'observation');
  assert.equal(s.events[0].delivery,'sent');assert.equal(s.events[0].receiptId,'receipt-fixture');assert.equal(s.events[1].delivery,'cancelled');
  assert.equal(r.config.priceLimit,'200');assert.equal(s.automatic.pricePolicy.defaultPercent,105);
});

test('通常BOXだけ通知候補、同一在庫は一度。停止条件と価格設定を変更しない',()=>{
  const {s,r}=fixture();const stopped=s.rules.find(r=>r.automaticProductId==='gundam-gd02');stopped.enabled=false;
  const target=addTarget(s,r,{title:normal,storeId:'mediaworld',url:'https://mediaworld.co.jp/products/fixture-normal'},now);
  const verified={...row(normal),productIdentity:pokemon30thBoxIdentity(row(normal))};
  observe(s,target,verified,now);observe(s,target,verified,now+1000);
  assert.equal(s.events.length,1);assert.equal(s.events[0].priceCondition.maxPrice,14400);
  assert(target.history.some(h=>h.identityDecision));assert.equal(stopped.enabled,false);
});
