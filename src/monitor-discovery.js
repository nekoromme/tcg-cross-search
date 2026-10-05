import {STORE_MAP,buildStoreSearchUrl} from './stores.js';
import {findCandidateProducts} from './search-results.js';
import {findNextSearchPage} from './pagination.js';
import {emptySearchEvidence} from './search-evidence.js';
import {parseAttributes,cleanText,normalizeUrlKey} from './search-common.js';
import {activeJob,addTarget,matchesRule,createRuleMatcher,ruleEnabled,storeEnabled} from './monitor-core.js';
import {initDiscovery,discoveryStore,discoveryLog,storeCadence,discoveryBudget,focusStore,focusTarget} from './monitor-cadence.js';
import {parseBigwebCatalog} from './bigweb.js';

export function syncDiscoveryStores(state,now) {
  if(!initDiscovery(state,now))return;
  for(const job of state.jobs)if(activeJob(state,job))discoveryStore(state,job.storeId,now);
}
export function discoveryRules(state,storeId) {
  return state.rules.filter(r=>ruleEnabled(r)&&r.config.storeIds.includes(storeId));
}
export function dueDiscoveryStore(state,io,now) {
  if(!state.discovery||!io.discoverStore)return null;
  const budget=discoveryBudget(state,'group',now);
  if(!budget.ok){
    if(state.discovery.groupBudgetRetryAt!==budget.retryAt)discoveryLog(state,{kind:'budget_wait',storeId:'all',reason:'本日の一覧探索枠を使い切ったため待機',nextAt:budget.retryAt},now);
    state.discovery.groupBudgetRetryAt=budget.retryAt;return null;
  }
  delete state.discovery.groupBudgetRetryAt;
  return Object.values(state.discovery.stores).filter(s=>storeEnabled(state,s.storeId)&&discoveryRules(state,s.storeId).length&&s.nextAt<=now&&(s.retryAt||0)<=now&&(state.hosts[io.storeHost(s.storeId)]||0)<=now)
    .sort((a,b)=>a.nextAt-b.nextAt)[0]||null;
}
export function registerDiscoveryRows(state,rules,storeId,rows,now,source,baseline=false) {
  let matched=0,registered=0,limited=0;
  for(const row of rows||[])for(const rule of rules)if(matchesRule(row,rule.config)) {
    matched++;
    try {
      const before=state.targets.length,target=addTarget(state,rule,{...row,storeId},now);
      if(!target){limited++;continue;}
      if(state.targets.length>before) {
        registered++;
        target.discovery={firstSeenAt:now,source,baseline,publicationAt:null};
        // 初回の既存商品取り込みは新発売と呼ばない。一覧の価格/在庫で通知しない。
        if(!baseline)focusTarget(state,target,'巡回で初めて発見した販売ページ',now);
        discoveryLog(state,{kind:'page_found',storeId,targetId:target.id,ruleId:rule.id,source,baseline},now);
      }
    } catch { /* 登録店の外部リンク・無効なURLは対象にしない。 */ }
  }
  return {matched,registered,limited};
}
export async function runStoreDiscovery(state,profile,io,now) {
  const storeId=profile.storeId,host=io.storeHost(storeId),cadence=storeCadence(profile,now);
  const previousAt=profile.lastAt||null;
  profile.nextAt=now+cadence.intervalMs;state.hosts[host]=now+30_000;
  // 途中中断時も同じ店へ即再接続しない。未完了の通信をゼロにしないよう先に枠を予約。
  discoveryBudget(state,'group',now);state.discovery.budget.group+=4;
  await io.save(state);
  let result;
  try {
    result=await io.discoverStore(storeId,discoveryRules(state,storeId),profile);
    if(result.sources)profile.sources=result.sources;
    if(Number.isInteger(result.sourceCursor))profile.sourceCursor=result.sourceCursor;
    const counts=registerDiscoveryRows(state,discoveryRules(state,storeId),storeId,result.results,now,'store-listing',!profile.successes);
    profile.lastAttemptAt=now;profile.lastResult={...counts,pages:result.pages,requests:result.requests,status:result.status,previousAt};
    if(result.status==='error'||result.accessLimited)throw Object.assign(new Error(result.error||'一覧を確認できず'),{status:result.httpStatus,retryAt:result.retryAt,accessLimited:result.accessLimited});
    profile.successes++;profile.failures=0;profile.lastAt=now;profile.retryAt=0;profile.error=result.status==='partial'?'一部の掲載一覧は未確認。取得できた範囲を記録':'';
    if(counts.registered) {
      profile.lastNewAt=now;
      if(profile.successes>1)focusStore(state,profile,'対象商品の新しい販売ページを発見',now);
    }
    const next=storeCadence(profile,now);profile.mode=next.mode;profile.reason=next.reason;profile.intervalMs=next.intervalMs;profile.nextAt=now+next.intervalMs;
    discoveryLog(state,{kind:'listing',storeId,...profile.lastResult,mode:next.mode,reason:next.reason,nextAt:profile.nextAt},now);
  } catch(error) {
    profile.lastAttemptAt=now;profile.failures++;profile.error='掲載一覧の確認失敗（売切れとは判定しません）';
    const delay=[403,429].includes(error.status)?3600_000:Math.min(6*3600_000,30*60_000*2**Math.min(profile.failures-1,4));
    profile.retryAt=Math.max(now+delay,Number(error.retryAt)||0);profile.nextAt=profile.retryAt;
    profile.mode='waiting';profile.reason=profile.error;
    if(error.accessLimited||[403,429].includes(error.status))state.hosts[host]=Math.max(state.hosts[host]||0,profile.retryAt);
    discoveryLog(state,{kind:'listing_error',storeId,httpStatus:error.status||null,reason:profile.error,nextAt:profile.nextAt,pages:result?.pages||[]},now);
  }
  if(Number.isFinite(result?.requests))state.discovery.budget.group-=Math.max(0,4-result.requests);
}

function listingUrl(raw,store) {
  const url=new URL(raw),home=new URL(store.home),action=new URL(store.action);
  if(url.origin!==home.origin||url.username||url.password||url.hash||url.href.length>1800||!(url.pathname===action.pathname||url.pathname==='/new'||url.pathname==='/new/'))throw new Error('掲載一覧のURLが不正です');
  return url.href;
}
// 店が実際に表示した新着リンク/並び替えだけ採用する。未知の並び替え番号を推測しない。
export function discoverListingSources(html,currentUrl,store) {
  const found=[],current=new URL(currentUrl);
  for(const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs=parseAttributes(m[1]),label=cleanText(m[2]);if(!attrs.href)continue;
    if(!/^(新着商品|新着順|新しい順|登録の新しい順)$/.test(label))continue;
    try {
      const linked=new URL(attrs.href,current),url=new URL(current);
      if(linked.origin!==current.origin)continue;
      if(label==='新着商品'&&/^\/new\/?$/.test(linked.pathname))found.push({url:listingUrl(linked.href,store),role:'new'});
      if(label!=='新着商品'&&linked.pathname===new URL(store.action).pathname) {
        for(const key of ['sort','order','sort_by'])if(linked.searchParams.has(key)) {
          url.searchParams.set(key,linked.searchParams.get(key));found.push({url:listingUrl(url.href,store),role:'sorted'});
        }
      }
    }catch{/* 範囲外のリンクは追わない。 */}
  }
  return found;
}

export async function fetchDiscoveryListings(storeId,rules,profile,fetchPage,guard) {
  const store=STORE_MAP.get(storeId),budget={requests:0,maxRequests:4,timeoutMs:15_000,deadline:Date.now()+25_000,guard};
  if(store.catalog?.type==='bigweb-json') {
    budget.maxRequests=1;budget.timeoutMs=28_000;budget.deadline=Date.now()+30_000;
    const url=store.catalog.url,pages=[];
    try {
      const page=await fetchPage(url,2_000_000,budget);
      if(page.status!==200||page.truncated)throw Object.assign(new Error('一覧を確認できず'),{status:page.status,code:page.truncated?'body_limit':'http_error'});
      const stats={},catalog=parseBigwebCatalog(page.text,store,stats);
      const matchers=rules.map(r=>createRuleMatcher(r.config));
      const results=catalog.filter(row=>matchers.some(match=>match(row)));
      pages.push({url,head:true,productLinks:stats.accepted,scope:'read',hasMore:false,order:'official_json_api'});
      return {status:'ok',results,pages,sources:[{url,role:'official_json_api',lastAt:Date.now()}],sourceCursor:0,requests:budget.requests};
    } catch(error) {
      pages.push({url,scope:'error',httpStatus:error.status||null,reason:error.code||'fetch_failed'});
      return {status:'error',results:[],pages,sources:[{url,role:'official_json_api'}],sourceCursor:0,requests:budget.requests,
        httpStatus:error.status,accessLimited:!!error.accessLimited,retryAt:error.retryAt,error:'掲載一覧を確認できず'};
    }
  }
  let sources=structuredClone(profile.sources||[]);
  if(!sources.length)sources=[{url:buildStoreSearchUrl(store,'BOX'),role:'search'},{url:buildStoreSearchUrl(store,store.boxKeyword?'BOX':'ボックス'),role:'alternate'}].filter((s,i,all)=>all.findIndex(x=>x.url===s.url)===i);
  const usable=sources.filter(s=>!(s.disabledUntil>Date.now()));
  const primary=usable.find(s=>s.role==='new')||usable.find(s=>s.role==='sorted')||usable[0]||sources[0];
  // 先頭は毎回読み、残りの1枠だけで別表記と次ページを巡る。
  const secondary=(usable.length?usable:sources)[(profile.sourceCursor||0)%(usable.length||sources.length)];
  const tasks=[{source:primary,url:primary.url,head:true}];
  if(secondary!==primary||secondary.nextUrl)tasks.push({source:secondary,url:secondary.nextUrl||secondary.url,head:!secondary.nextUrl});
  const matchers=rules.map(r=>createRuleMatcher(r.config)),matchedTitles=new Map();
  const acceptTitle=title=>{if(!matchedTitles.has(title))matchedTitles.set(title,matchers.some(match=>match({title})));return matchedTitles.get(title);};
  const pages=[],rows=new Map();let failure=null;
  for(const task of tasks) {
    try {
      const url=listingUrl(task.url,store),page=await fetchPage(url,2_000_000,budget);
      if(page.status!==200||page.truncated)throw Object.assign(new Error('一覧を確認できず'),{status:page.status,code:page.truncated?'body_limit':'http_error'});
      const stats={};
      // 同じ巨大HTMLを弾ごとに再解析せず、リンク抽出は一度だけ。
      const candidates=findCandidateProducts(page.text.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]||page.text,page.finalUrl||url,'',true,500,true,stats,acceptTitle);
      const productLinks=stats.productLinks;
      for(const row of candidates)rows.set(normalizeUrlKey(row.url),row);
      const empty=emptySearchEvidence(page.text);
      if(!productLinks&&!empty)throw Object.assign(new Error('商品リンク・検索件数を確認できず'),{code:'unreadable'});
      const next=findNextSearchPage(page.text,page.finalUrl||url,store);
      // 先頭の再取得で後方ページの位置を毎回リセットしない。
      if(!task.head||!task.source.nextUrl) {
        task.source.depth=task.head?1:(task.source.depth||1)+1;
        task.source.nextUrl=task.source.depth<20?next:null;
      }
      task.source.lastAt=Date.now();delete task.source.disabledUntil;
      for(const source of discoverListingSources(page.text,url,store))if(!sources.some(s=>s.url===source.url)&&sources.length<4)sources.push(source);
      pages.push({url,head:task.head,productLinks,scope:empty?'empty':productLinks?'read':'unreadable',hasMore:!!next,depthLimited:task.source.depth>=20&&!!next,order:task.source.role});
    } catch(error) {
      failure=error;pages.push({url:task.url,scope:'error',httpStatus:error.status||null,reason:error.code||(['AbortError','TimeoutError'].includes(error.name)||error==='timeout'?'timeout':'fetch_failed')});
      if(error.accessLimited||[403,429].includes(error.status))break;
      task.source.disabledUntil=Date.now()+6*3600_000;
    }
  }
  return {status:failure?(pages.some(p=>p.scope!=='error')&&!failure.accessLimited&&![403,429].includes(failure.status)?'partial':'error'):'ok',results:[...rows.values()],pages,sources,sourceCursor:((profile.sourceCursor||0)+1)%sources.length,
    requests:budget.requests,httpStatus:failure?.status,accessLimited:!!failure?.accessLimited,retryAt:failure?.retryAt,error:failure?'掲載一覧を確認できず':''};
}
