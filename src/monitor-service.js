import { refreshAutomaticCatalog, syncAutomaticCatalog } from './automatic-catalog.js';
import { normalizeUrlKey } from './search-common.js';
import { accessDecision, networkGuard } from './access-limits.js';
import { emptyMonitor, addTarget, matchesRule, activeTarget, activeJob, syncActivity, addRule, removeRule, publicMonitor, validateWebhook } from './monitor-core.js';
import { runMonitorTick, sendDiscord } from './monitor-engine.js';
import { STORE_MAP } from './stores.js';
import { fetchHtml, handleStoreSearch } from './index.js';
import { parseProductDetail } from './product-detail.js';
import { identifyProduct } from '../public/catalog.js';
import { productUrl } from './monitor-core.js';
import { encodeMonitor, decodeMonitor, monitorFailure } from './monitor-storage.js';
import {updateRulePrice,applyAutomaticPricing} from './monitor-pricing.js';
import {applyAutomaticPriceRecords} from './automatic-prices.js';
import {fetchDiscoveryListings} from './monitor-discovery.js';
import {findBigwebProduct} from './bigweb.js';

export const monitorResponse=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export async function readCommand(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new Error('JSON形式で送信してください');
  const reader=request.body?.getReader();
  if (!reader) throw new Error('操作内容がありません');
  let text='',size=0; const decoder=new TextDecoder();
  try { while(true) {const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>100_000)throw new Error('送信データが大きすぎます');text+=decoder.decode(value,{stream:true});} }
  finally {await reader.cancel();}
  return JSON.parse(text+decoder.decode());
}
export async function routeMonitor(request, env) {
  const origin=request.headers.get('Origin');
  if(origin && origin!==new URL(request.url).origin) return monitorResponse({error:'別サイトからは操作できません'},403);
  if(!['GET','POST'].includes(request.method)) return monitorResponse({error:'未対応の操作です'},405);
  // 端末で作る256bitの合言葉が、その人の保存領域への鍵になる。URLやログには含めない。
  const token=request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if(!token) return monitorResponse({error:'監視用の合言葉が必要です'},401);
  if(!env.MONITORS) return monitorResponse({error:'監視の保存先がまだ設定されていません'},503);
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
  const id=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
  try {return await env.MONITORS.get(env.MONITORS.idFromName(id)).fetch(request);}
  catch(error){const failure=monitorFailure(error,'durable-object');console.error(JSON.stringify({event:'monitor_failure',...failure}));return monitorResponse({error:'監視の保存先を利用できません。次回に再試行します',failure},503);}
}

export function makeMonitorIO(save, env = {}) {
  const guard=networkGuard(env,'monitor');
  return { save, storeHost:id=>new URL(STORE_MAP.get(id).home).hostname,
    async check(target) {
      const url=productUrl(target.url,target.storeId);
      const store=STORE_MAP.get(target.storeId);
      let page;
      try{page=await fetchHtml(store.catalog?.type==='bigweb-json'?store.catalog.url:url,store.catalog?2_000_000:900_000,{requests:0,deadline:Date.now()+30_000,timeoutMs:store.catalog?28_000:undefined,guard});}
      catch(error){if(error.accessLimited)return {deferred:true,retryAt:error.retryAt,error:error.message};throw error;}
      if(page.status!==200) return {error:`商品ページ HTTP ${page.status}`,status:page.status};
      if(page.truncated) return {error:'商品ページの容量上限で未確認'};
      const parsed=store.catalog?.type==='bigweb-json'?findBigwebProduct(page.text,store,url):parseProductDetail(page.text);
      if(!parsed)return {error:'公式商品一覧で対象ページを確認できず'};
      const product=identifyProduct(parsed.title);
      if(parsed.stock==='in_stock'&&(target.releaseDate||product?.releaseDate)>new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'})) parsed.stock='preorder';
      return {row:{title:parsed.title||'',price:parsed.price,stock:parsed.stock,priceState:parsed.priceState||'',
        detailChecked:Boolean(parsed.title),priceComparable:parsed.priceComparable,priceIssue:parsed.priceIssue},status:200};
    },
    discoverStore:(storeId,rules,profile)=>fetchDiscoveryListings(storeId,rules,profile,fetchHtml,guard),
    async discover(rule,storeId,task,{pausedUrls=[],listingOnly=false}={}) {
      const paused=new Set(pausedUrls.map(url=>normalizeUrlKey(productUrl(url,storeId))));
      const params=new URLSearchParams({store:storeId,q:rule.query,sealed:'1',refresh:'1',depth:'standard',start:task.start||'',offset:String(task.offset||0),snapshot:task.snapshot||''});
      return (await handleStoreSearch(new Request(`https://monitor.internal/api/search?${params}`),guard,{listingOnly,skipDetail:candidate=>{try{return paused.has(normalizeUrlKey(productUrl(candidate.url,storeId)));}catch{return false;}}})).json();
    },
    notify:(webhook,event)=>sendDiscord(webhook,{...event,storeName:STORE_MAP.get(event.storeId)?.name}),
  };
}

export async function monitorCommand(state, body, {minInterval=30}={}) {
  const before=new Map(state.targets.map(t=>[t.id,activeTarget(state,t)]));
  const now=Date.now();
  switch(body.action) {
    case 'automatic-prices': applyAutomaticPriceRecords(state,body.prices,now);applyAutomaticPricing(state,now);break;
    case 'rule-price': updateRulePrice(state,body.id,body,now); break;
    case 'automatic': {
      // 同期は既存領域だけを操作する。新しい端末の監視を無断で移動しない。
      state.automatic ||= {enabled:true,nextSync:0,log:[]};
      if(body.enabled!==undefined)state.automatic.enabled=body.enabled===true;
      state.automatic.nextSync=0;
      if(state.automatic.enabled && body.releases)syncAutomaticCatalog(state,{seen_releases:body.releases,prices:body.prices});
      else await refreshAutomaticCatalog(state);
      break;
    }
    case 'automatic-seeds': {
      if(!state.automatic?.enabled)throw new Error('自動対象が未設定です');
      for(const row of (Array.isArray(body.seeds)?body.seeds:[]).slice(0,100))
        for(const rule of state.rules.filter(r=>r.automaticProductId&&!r.autoRetired))
          if(rule.config.storeIds.includes(row.storeId)&&matchesRule(row,rule.config))
            try{addTarget(state,rule,row,now);}catch{/* 許可店以外のリンクは登録しない。 */}
      break;
    }
    case 'add': addRule(state,body.rule,Array.isArray(body.seeds)?body.seeds:[]); break;
    case 'delete': removeRule(state,body.id); break;
    case 'toggle': {
      const rule=state.rules.find(r=>r.id===body.id); if(!rule)throw new Error('監視条件が見つかりません');
      rule.enabled=body.enabled===true;
      if(rule.enabled) {for(const t of state.targets) if(t.ruleIds.includes(rule.id))t.nextAt=Math.max(now,t.error?t.nextAt:0);for(const j of state.jobs)if(j.ruleId===rule.id)j.nextAt=Math.max(now,j.error?j.nextAt:0);}
      else for(const e of state.events)if(e.ruleId===rule.id&&e.delivery==='pending')e.delivery='cancelled';
      break;
    }
    case 'store-toggle': {
      if(!STORE_MAP.has(body.storeId)||typeof body.enabled!=='boolean')throw new Error('店舗の指定が不正です');
      const disabled=new Set(state.disabledStoreIds||[]);
      if(body.enabled)disabled.delete(body.storeId);else disabled.add(body.storeId);
      state.disabledStoreIds=[...disabled];
      // 再開後は新しい掲載の確認も順番に行う。店舗の接続休止時間は維持する。
      if(body.enabled)for(const job of state.jobs)if(job.storeId===body.storeId)job.nextAt=Math.max(now,job.error?job.nextAt:0);
      break;
    }
    case 'target-toggle': {
      const target=state.targets.find(t=>t.id===body.id);
      if(!target||typeof body.enabled!=='boolean')throw new Error('商品ページの指定が不正です');
      target.enabled=body.enabled;
      break;
    }
    case 'settings': {
      if(body.intervalSeconds!==undefined) {
        const value=Number(body.intervalSeconds);
        if(![10,30,60,180,300].includes(value)||value<minInterval)throw new Error(`この環境では${minInterval}秒以上を指定して`);
        state.intervalSeconds=value;
      }
      if(body.enabled!==undefined)state.enabled=body.enabled===true;
      if(body.webhook!==undefined)state.webhook=validateWebhook(body.webhook);
      break;
    }
    case 'test': {
      if(!state.webhook)throw new Error('先にDiscord通知先を保存してください');
      if(state.lastTest && Date.now()-state.lastTest<60_000)throw new Error('通知テストは1分あけてください');
      state.lastTest=Date.now();
      // 送信自体は保存後に呼び出し元が実行する。
      return 'test';
    }
    default: throw new Error('操作が不正です');
  }
  syncActivity(state,before,now);
}

// クラウド固有なのは保存と目覚ましだけ。ネットワークを待つ間の操作も直列化する。
export class InventoryMonitor {
  constructor(ctx,env) {this.ctx=ctx;this.env=env;this.tail=Promise.resolve();}
  serial(fn) {const result=this.tail.then(fn);this.tail=result.catch(()=>{});return result;}
  async load() {
    const count=await this.ctx.storage.get('chunks')||0;
    if(!count)return emptyMonitor();
    let serialized='';
    for(let i=0;i<count;i++){const chunk=await this.ctx.storage.get(`chunk:${i}`);if(typeof chunk!=='string')throw new Error('monitor snapshot chunk missing');serialized+=chunk;}
    const {state,stats}=await decodeMonitor(serialized);
    this.lastSerialized=JSON.stringify(state);this.storageStats={...stats,chunks:count};
    return state;
  }
  async save(state) {
    // 変更がない保存を省き、増えた履歴は圧縮して一括保存する。
    const serialized=JSON.stringify(state);
    if(serialized===this.lastSerialized&&this.storageStats?.format==='monitor-gzip-v1')return;
    const {chunks,stats}=await encodeMonitor(serialized);
    await this.ctx.storage.transaction(async tx=>{
      const old=await tx.get('chunks')||0;
      for(let i=0;i<chunks.length;i++)await tx.put(`chunk:${i}`,chunks[i]);
      for(let i=chunks.length;i<old;i++)await tx.delete(`chunk:${i}`);
      if(old!==chunks.length)await tx.put('chunks',chunks.length);
    });
    this.lastSerialized=serialized;this.storageStats={...stats,chunks:chunks.length};
  }
  async schedule(state) {
    if(state.enabled && (state.automatic?.enabled||state.jobs.some(j=>activeJob(state,j))||state.targets.some(t=>activeTarget(state,t))||state.events.some(e=>e.delivery==='pending')))
      await this.ctx.storage.setAlarm(Date.now()+30_000);
    else await this.ctx.storage.deleteAlarm();
  }
  fetch(request) {return this.serial(async()=>{
    // 外部公開ルートにはこのパスを用意しない。共有の保存先へ内部からのみ呼ぶ。
    if(new URL(request.url).pathname==='/internal/access-budget') {
      const command=await readCommand(request), counters=await this.ctx.storage.get('access-budget')||{};
      const result=accessDecision(counters,command);
      await this.ctx.storage.put('access-budget',counters);
      if(!result.ok)console.info(JSON.stringify({event:'access_limit_wait',kind:command.kind||'manual',reason:result.error,retryAt:result.retryAt}));
      return monitorResponse(result);
    }
    let state;
    try {state=await this.load();}
    catch(error){const failure=monitorFailure(error,'load-state');console.error(JSON.stringify({event:'monitor_failure',...failure}));return monitorResponse({error:'監視履歴を読み出せません。既存履歴を保持して再試行します',failure},503);}
    try {
      if(request.method==='POST') {
        const command=await readCommand(request);
        const action=await monitorCommand(state,command);
        await this.save(state); await this.schedule(state);
        if(action==='test') {
          try {await sendDiscord(state.webhook,{title:'通知テスト：自動監視の通知先を確認しました',storeName:'TCG横断在庫検索',price:0,url:'https://tcg-cross-search.purplepearl-v.workers.dev/monitor.html',id:crypto.randomUUID(),at:Date.now(),stock:'test'});}
          catch{return monitorResponse({error:'通知テストに失敗。Discordの通知先を確認してください'},502);}
        }
      }
      return monitorResponse({...publicMonitor(state),storage:this.storageStats});
    } catch(error) {return monitorResponse({error:error.message || '監視設定を保存できませんでした'},400);}
  });}
  alarm() {return this.serial(async()=>{
    let state;
    try {state=await this.load();}
    catch(error){console.error(JSON.stringify({event:'monitor_failure',...monitorFailure(error,'alarm-load')}));throw error;}
    // 致命的な中断が起きても次回を残す。通常の終了時に30秒後へ調整する。
    if(state.enabled&&state.rules.some(r=>r.enabled))await this.ctx.storage.setAlarm(Date.now()+60_000);
    try {await refreshAutomaticCatalog(state);await runMonitorTick(state,makeMonitorIO(s=>this.save(s),this.env));state.lastCompletedAt=Date.now();state.error='';await this.save(state);}
    catch(error) {state.error='巡回処理が中断しました。次回に再試行します';state.lastFailure=monitorFailure(error,'alarm-run');console.error(JSON.stringify({event:'monitor_failure',...state.lastFailure}));await this.save(state);}
    await this.schedule(state);
    console.info(JSON.stringify({event:'inventory_tick',rules:state.rules.length,targets:state.targets.length,
      failed:state.targets.filter(t=>t.error).length,pending:state.events.filter(e=>e.delivery==='pending').length}));
  });}
}
