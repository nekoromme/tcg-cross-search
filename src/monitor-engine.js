// スケジュールと保存先を外から渡す。移行しても在庫判定・通知履歴を変えない。
import { LIMITS, activeTarget, addTarget, matchesRule, observe, recordFailure, validateWebhook } from './monitor-core.js';

export async function runMonitorTick(state, io) {
  const now=io.now?.() ?? Date.now();
  state.lastTick=now;
  if (!state.enabled) return;
  const usedHosts=new Set();
  // 発見検索の枠を先に確保する。30秒監視の店舗でも発見検索が永久に後回しにならない。
  const job=state.jobs.filter(j=>j.nextAt<=now && state.rules.some(r=>r.id===j.ruleId&&r.enabled))
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
  for (const t of selected) t.nextAt=now+state.intervalSeconds*1000;
  await io.save(state);
  await Promise.all(selected.map(async t=>{
    try {
      const response=await io.check(t);
      if (response.error) recordFailure(t,response.error,now,state.intervalSeconds,response.status);
      else observe(state,t,response.row,now);
      if ([403,429].includes(response.status)) state.hosts[new URL(t.url).hostname]=now+1800_000;
    } catch { recordFailure(t,'商品ページの通信に失敗',now,state.intervalSeconds); }
  }));
  await io.save(state);

  // 新規掲載の発見は各条件・店舗につき30分おき。既知のページ確認と混ぜない。
  if (job) {
    const host=io.storeHost(job.storeId), rule=state.rules.find(r=>r.id===job.ruleId);
    state.hosts[host]=now+30_000;
    job.nextAt=now+LIMITS.discoveryMs;
    const task=job.queue.shift() || {start:'',offset:0};
    await io.save(state);
    try {
      const result=await io.discover(rule.config,job.storeId,task);
      if (['error','blocked'].includes(result.status)) throw Object.assign(new Error('検索ページを取得できず'),{status:result.httpStatus});
      for (const row of result.results||[]) if (matchesRule(row,rule.config)) {
        try { addTarget(state,rule,{...row,storeId:job.storeId},now); } catch { /* 店舗外リンクは登録しない。 */ }
      }
      const key=t=>`${t.start||''}|${t.offset||0}`;
      job.seen.push(key(task)); job.rounds++;
      for (const next of result.continuations||[]) if (!job.seen.includes(key(next))&&!job.queue.some(t=>key(t)===key(next))) job.queue.push(next);
      job.lastAt=now;
      job.error=(result.coverage?.partialReasons||[]).slice(0,3).join('／');
      // 検索範囲は最大20バッチ。上限は明示し、完了と偽らない。
      if (job.queue.length && job.rounds<20) job.nextAt=now+60_000;
      else {
        if(job.queue.length) job.error='新規掲載の検索上限。一部の続きは未確認';
        job.queue=[]; job.seen=[]; job.rounds=0;
      }
    } catch (error) {
      job.error='検索ページの取得失敗。時間をあけて再試行'; job.queue.unshift(task);
      if ([403,429].includes(error.status)) state.hosts[host]=now+1800_000;
    }
  }
  await io.save(state);
  // 通知は履歴に保存後に送信。失敗しても在庫変化を失わず、次の巡回で再試行する。
  const pending=state.events.filter(e=>e.delivery==='pending'&&e.nextAt<=now).reverse();
  for (const event of pending) {
    const t=state.targets.find(t=>t.id===event.targetId);
    if (!t || !activeTarget(state,t) || now-event.at>600_000) {event.delivery='cancelled';continue;}
    // 直近の取得が不明なら通知を保留。確認できた古い在庫を現在の在庫として送らない。
    if (t.error || !t.lastGoodAt || now-t.lastGoodAt>Math.max(120_000,state.intervalSeconds*2000)) continue;
    if (!state.webhook) { event.delivery='screen'; continue; }
    event.attempts++;
    event.nextAt=now+Math.min(300_000,30_000*2**event.attempts);
    await io.save(state);
    try { await io.notify(state.webhook,event); event.delivery='sent'; event.sentAt=now; }
    catch { event.delivery=event.attempts>=5?'failed':'pending'; event.error='Discord送信失敗'; }
    await io.save(state);
    break; // Discordへ一度に送信しすぎない。
  }
  await io.save(state);
}

export async function sendDiscord(webhook, event) {
  const url=new URL(validateWebhook(webhook)); url.searchParams.set('wait','true');
  const label=event.stock==='preorder'?'予約受付':'在庫あり';
  const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
    headers:{'Content-Type':'application/json'},body:JSON.stringify({
      content:`【TCG在庫監視】${label}\n${event.title.slice(0,500)}\n${event.storeName||event.storeId}：${event.price.toLocaleString('ja-JP')}円（送料別）\n${event.url}\n確認時刻：${new Date(event.at).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}\n通知番号：${event.id}`,
      allowed_mentions:{parse:[]}})});
  await response.body?.cancel();
  if(!response.ok) throw new Error(`通知送信 HTTP ${response.status}`);
}
