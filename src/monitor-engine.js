import { recordHistory } from './monitor-history.js';
import {applyAutomaticPricing,priceAssessment} from './monitor-pricing.js';
// スケジュールと保存先を外から渡す。移行しても在庫判定・通知履歴を変えない。
import { LIMITS, effectiveInterval, discoveryInterval, activeJob, activeTarget, addTarget, matchesRule, eligibility, observe, recordFailure, validateWebhook } from './monitor-core.js';

export async function runMonitorTick(state, io) {
  const now=io.now?.() ?? Date.now();
  state.lastTick=now;
  if (!state.enabled) return;
  applyAutomaticPricing(state,now);
  // 古い版で登録された用品も、取得済みの商品名で除外して履歴を残す。
  for(const target of state.targets) {
    const rules=state.rules.filter(r=>target.ruleIds.includes(r.id));
    if(target.enabled!==false && target.lastGood && rules.length && rules.every(r=>r.automaticProductId) && !rules.some(r=>matchesRule(target.lastGood,r.config))) {
      target.enabled=false;recordHistory(target,{kind:'pause',reason:'通常の日本語版BOXではないため対象外'},now);
      for(const event of state.events)if(event.targetId===target.id&&event.delivery==='pending')event.delivery='cancelled';
    }
  }
  // 旧送信形式で失敗していた通知を、この修正後に一度だけ再開する。
  // 送信済みは触らず、古い在庫通知は下の鮮度確認で取り消して再取得する。
  if(state.deliveryVersion!==4) {
    for(const event of state.events)if(['pending','failed'].includes(event.delivery)&&event.error) {
      event.delivery='pending';event.attempts=0;event.nextAt=now;
    }
    state.deliveryVersion=4;
  }
  const usedHosts=new Set();
  // 発見検索の枠を先に確保する。30秒監視の店舗でも発見検索が永久に後回しにならない。
  const job=state.jobs.filter(j=>j.nextAt<=now && activeJob(state,j))
    .sort((a,b)=>a.nextAt-b.nextAt).find(j=>(state.hosts[io.storeHost(j.storeId)]||0)<=now);
  if(job)usedHosts.add(io.storeHost(job.storeId));
  // 同じ店は1巡で1商品、直近の接続から最低30秒。遅い店が他を止めないよう6店まで並列。
  const due=state.targets.filter(t=>activeTarget(state,t) && t.nextAt<=now).sort((a,b)=>a.nextAt-b.nextAt);
  const selected=[];
  for (const t of due) {
    const host=new URL(t.url).hostname;
    if (usedHosts.has(host) || (state.hosts[host]||0)>now) continue;
    usedHosts.add(host); state.hosts[host]=now+Math.min(30_000,state.intervalSeconds*1000); selected.push(t);
    if (selected.length===6) break;
  }
  // 次の予定を保存してから接続する。途中で実行環境が再起動しても連打しない。
  for (const t of selected) t.nextAt=now+effectiveInterval(state,t)*1000;
  await io.save(state);
  await Promise.all(selected.map(async t=>{
    try {
      const response=await io.check(t);
      const checkedAt=io.now?.()??Date.now();
      if(response.deferred) {t.nextAt=response.retryAt;t.error=response.error;recordHistory(t,{kind:'waiting',reason:response.error},checkedAt);return;}
      if (response.error) recordFailure(t,response.error,checkedAt,state.intervalSeconds,response.status);
      else observe(state,t,response.row,checkedAt);
      if ([403,429].includes(response.status)) state.hosts[new URL(t.url).hostname]=now+1800_000;
    } catch { recordFailure(t,'商品ページの通信に失敗',io.now?.()??Date.now(),state.intervalSeconds); }
  }));
  await io.save(state);

  // 新規掲載の発見は各条件・店舗につき30分おき。既知のページ確認と混ぜない。
  if (job) {
    const host=io.storeHost(job.storeId), rule=state.rules.find(r=>r.id===job.ruleId);
    state.hosts[host]=now+30_000;
    job.nextAt=now+discoveryInterval(state);
    const task=job.queue.shift() || {start:'',offset:0};
    await io.save(state);
    try {
      const result=await io.discover(rule.config,job.storeId,task,{pausedUrls:state.targets.filter(t=>t.enabled===false&&t.storeId===job.storeId).map(t=>t.url)});
      if(result.accessLimited)throw Object.assign(new Error(result.error),{accessLimited:true,retryAt:result.retryAt});
      if (['error','blocked'].includes(result.status)) throw Object.assign(new Error('検索ページを取得できず'),{status:result.httpStatus});
      let matched=0,registered=0;
      for (const row of result.results||[]) if (matchesRule(row,rule.config)) {
        matched++;
        try { if(addTarget(state,rule,{...row,storeId:job.storeId},now))registered++; } catch { /* 店舗外リンクは登録しない。 */ }
      }
      const key=t=>`${t.start||''}|${t.offset||0}`;
      job.seen.push(key(task)); job.rounds++;
      for (const next of result.continuations||[]) if (!job.seen.includes(key(next))&&!job.queue.some(t=>key(t)===key(next))) job.queue.push(next);
      job.lastAt=now;job.lastResult={at:now,status:result.status,matched,registered};
      job.error=(result.coverage?.partialReasons||[]).slice(0,3).join('／');
      if(registered<matched)job.error=[job.error,'登録上限により一部の商品ページを未登録'].filter(Boolean).join('／');
      // 検索範囲は最大20バッチ。上限は明示し、完了と偽らない。
      if (job.queue.length && job.rounds<20) job.nextAt=now+60_000;
      else {
        if(job.queue.length) job.error='新規掲載の検索上限。一部の続きは未確認';
        job.queue=[]; job.seen=[]; job.rounds=0;
      }
    } catch (error) {
      job.error=error.accessLimited?error.message:'検索ページの取得失敗。時間をあけて再試行'; job.queue.unshift(task);
      if(error.accessLimited)job.nextAt=error.retryAt;
      if ([403,429].includes(error.status)) state.hosts[host]=now+1800_000;
    }
  }
  state.runs=[...(state.runs||[]),{at:now,checked:selected.length,discovered:job?{ruleId:job.ruleId,storeId:job.storeId,result:job.lastResult,error:job.error}:null,targets:state.targets.length,errors:state.targets.filter(t=>t.error).length}].slice(-1000);
  await io.save(state);
  // 通知は履歴に保存後に送信。失敗しても在庫変化を失わず、次の巡回で再試行する。
  const pending=state.events.filter(e=>e.delivery==='pending'&&e.nextAt<=now).reverse();
  // 通知先が不調なら送信だけを休止する。店舗確認・ログ保存は継続する。
  // 一つの不調で全商品の通知を連続失敗させない。
  if(state.deliveryHealth?.retryAt>now)return;
  let delivered=0;
  for (const event of pending) {
    if(event.kind==='catalog') {
      if(!state.automatic?.enabled){event.delivery='cancelled';continue;}
      if(!state.webhook){event.delivery='screen';continue;}
      event.attempts++;event.nextAt=now+Math.min(300000,30000*2**event.attempts);
      await io.save(state);
      try{deliverySucceeded(state,event,await io.notify(state.webhook,event),now);}
      catch(error){deliveryFailed(state,event,error,now);}
      await io.save(state);if(event.error||++delivered>=(state.automatic?.enabled?3:1))break;continue;
    }
    const t=state.targets.find(t=>t.id===event.targetId);
    if (!t || !activeTarget(state,t) || now-event.at>600_000) {
      event.delivery='cancelled';
      event.cancelledAt=now;event.cancelReason=!t||!activeTarget(state,t)?'inactive':'stale';
      // 待ち行列で古くなった未配送通知は、次の実取得で再判定する。
      if(t && activeTarget(state,t) && t.episodes[event.ruleId])t.episodes[event.ruleId].active=false;
      continue;
    }
    const rule=state.rules.find(r=>r.id===event.ruleId);
    // 価格条件変更前に作られた通知も、実際に送る価格で再判定する。
    // 現在値だけが安くなっていても、昔の高い価格の通知を送らない。
    const eventPrice=rule&&priceAssessment({...t.lastGood,...event,detailChecked:true},rule.config);
    if(!rule || eligibility(t.lastGood,rule.config)===false || eventPrice.status!=='within_limit') {
      event.delivery='cancelled';event.cancelledAt=now;event.cancelReason=eventPrice?.reason||'監視条件外';
      const episode=t.episodes[event.ruleId];if(episode?.lastEvent===event.at)episode.active=false;
      continue;
    }
    // 直近の取得が不明なら通知を保留。確認できた古い在庫を現在の在庫として送らない。
    if (t.error || !t.lastGoodAt || now-t.lastGoodAt>Math.max(120_000,state.intervalSeconds*2000)) continue;
    if (!state.webhook) { event.delivery='screen'; continue; }
    event.attempts++;
    event.priceCondition=eventPrice;
    event.nextAt=now+Math.min(300_000,30_000*2**event.attempts);
    await io.save(state);
    try {deliverySucceeded(state,event,await io.notify(state.webhook,event),now);}
    catch(error) {deliveryFailed(state,event,error,now);}
    await io.save(state);
    if(event.error||++delivered>=(state.automatic?.enabled?3:1))break; // 自動セットでも一巡3通知まで。
  }
  await io.save(state);
}

function deliverySucceeded(state,event,receipt,now) {
  event.delivery='sent';event.sentAt=now;
  if(receipt?.id)event.receiptId=receipt.id;
  if(event.error)event.previousError=event.error;
  delete event.error;
  state.deliveryHealth={...state.deliveryHealth,lastAttemptAt:now,lastSuccessAt:now,consecutiveFailures:0,retryAt:0,error:''};
}
function deliveryFailed(state,event,error,now) {
  const previous=state.deliveryHealth||{},failures=(previous.consecutiveFailures||0)+1;
  const permanent=[401,403,404].includes(error?.status);
  const delay=Math.max(Number(error?.retryAfterMs)||0,permanent?1800_000:Math.min(900_000,30_000*2**Math.min(failures,5)));
  event.delivery=event.attempts>=5?'failed':'pending';event.error=deliveryError(error);event.lastFailureAt=now;
  event.nextAt=now+delay;
  state.deliveryHealth={...previous,lastAttemptAt:now,lastFailureAt:now,consecutiveFailures:failures,retryAt:event.nextAt,error:event.error};
}

function deliveryError(error) {
  // 秘密のURLやレスポンス本文を保存せず、HTTP番号と例外種別だけを残す。
  const status=String(error?.message||'').match(/HTTP \d{3}/)?.[0];
  return `Discord送信失敗（${status||String(error?.name||'Error').slice(0,40)}）`;
}
export async function sendDiscord(webhook, event) {
  const url=new URL(validateWebhook(webhook)); url.searchParams.set('wait','true');
  const label=event.stock==='preorder'?'予約受付':event.stock==='test'?'通知テスト':'在庫あり';
  const content=event.kind==='catalog'
    ? `【TCG在庫監視】${event.title}\n${event.products.slice(0,6).map(p=>`${p.name}（${p.releaseDate}）`).join('\n')+(event.products.length>6?`\nほか${event.products.length-6}弾`:'')}\n通常BOXは定価＋5%以内（商品別の例外あり）。定価未確認は通知保留。\n通知番号：${event.id}`
    : `【TCG在庫監視】${label}\n${event.title.slice(0,500)}\n${event.storeName||event.storeId}：${event.price.toLocaleString('ja-JP')}円（送料別）${event.priceCondition?.maxPrice?`\n通知上限：${event.priceCondition.maxPrice.toLocaleString('ja-JP')}円${event.priceCondition.referencePrice?`／定価：${event.priceCondition.referencePrice.toLocaleString('ja-JP')}円（${event.priceCondition.percent}%まで）`:''}`:''}\n${event.url}\n確認時刻：${new Date(event.at).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}\n通知番号：${event.id}`;
  // Workersではredirect:errorがTypeErrorになる。manualで転送を追わず3xxも失敗にする。
  const response=await fetch(url,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(8000),
    headers:{'Content-Type':'application/json','User-Agent':'DiscordBot (https://github.com/nekoromme/tcg-cross-search, 0.10.4)'},body:JSON.stringify({
      content:content.slice(0,1950),
      allowed_mentions:{parse:[]}})});
  let payload;try{payload=await response.json();}catch{/* エラー本文は保存しない。 */}
  if(!response.ok)throw Object.assign(new Error(`通知送信 HTTP ${response.status}`),{status:response.status,retryAfterMs:response.status===429?Math.max(Number(response.headers.get('retry-after'))||0,Number(payload?.retry_after)||0)*1000:0});
  return {id:typeof payload?.id==='string'?payload.id:null};
}
