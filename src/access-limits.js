// 全端末・手動検索・自動監視が共用する、外部店舗への通信の予算。
// 店舗が許可した回数ではなく、このアプリ側の暴走防止用の保守的な初期値。
export const ACCESS_LIMITS = Object.freeze({ daily:20000, monitorDaily:12000, minute:180, hostMinute:30, hostDaily:2000, concurrent:24, hostConcurrent:4 });
const DAY=86400000;
export function accessDay(now) { return Math.floor((now+9*3600000)/DAY); }
export function accessDecision(state, command, now=Date.now()) {
  const day=accessDay(now);
  if(state.day!==day){state.day=day;state.total=0;state.monitor=0;state.hosts={};}
  state.recent=(state.recent||[]).filter(x=>x.at>now-60000);
  state.leases=(state.leases||[]).filter(x=>x.until>now);
  if(command.action==='release') {state.leases=state.leases.filter(x=>x.id!==command.id);return {ok:true};}
  if(command.action==='status')return {ok:true,limits:ACCESS_LIMITS,used:state.total,monitorUsed:state.monitor,resetsAt:(day+1)*DAY-9*3600000};
  if(command.action!=='acquire')return {ok:false,error:'操作が不正です'};
  const host=String(command.host||'').replace(/^www\./,'');
  const reset=(day+1)*DAY-9*3600000;
  const deny=(reason,retryAt)=>({ok:false,error:`アクセス上限のため待機：${reason}`,retryAt});
  if(state.total>=ACCESS_LIMITS.daily || (command.kind==='monitor' && state.monitor>=ACCESS_LIMITS.monitorDaily))return deny('本日の通信枠を使い切りました（日本時間0時に再開）',reset);
  if((state.hosts[host]||0)>=ACCESS_LIMITS.hostDaily)return deny('この店舗の本日の通信枠を使い切りました',reset);
  const recentHost=state.recent.filter(x=>x.host===host);
  if(state.recent.length>=ACCESS_LIMITS.minute)return deny('全体の1分間の通信枠',state.recent[0].at+60000);
  if(recentHost.length>=ACCESS_LIMITS.hostMinute)return deny('この店舗の1分間の通信枠',recentHost[0].at+60000);
  const hostLeases=state.leases.filter(x=>x.host===host);
  if(state.leases.length>=ACCESS_LIMITS.concurrent || hostLeases.length>=ACCESS_LIMITS.hostConcurrent)return deny('同時接続が混雑しています',now+5000);
  const id=crypto.randomUUID();
  state.total++;if(command.kind==='monitor')state.monitor++;
  state.hosts[host]=(state.hosts[host]||0)+1;
  state.recent.push({host,at:now});state.leases.push({id,host,until:now+45000});
  return {ok:true,id};
}
// Node.jsへの移行時も同じ判定を使い、再起動前に回数を保存する。
export function createAccessController(storage) {
  let tail=Promise.resolve();
  return command=>{const job=tail.then(async()=>{const state=await storage.load()||{};const result=accessDecision(state,command);await storage.save(state);return result;});tail=job.catch(()=>{});return job;};
}
export function accessClient(env={}) {
  if(env.ACCESS_CONTROL)return env.ACCESS_CONTROL;
  if(!env.MONITORS)return null;
  const stub=env.MONITORS.get(env.MONITORS.idFromName('shared-access-budget-v1'));
  return async command=>{
    const response=await stub.fetch(new Request('https://internal/internal/access-budget',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command)}));
    if(!response.ok)throw new Error('通信上限の確認に失敗したため、店舗への接続を停止しました');
    return response.json();
  };
}
export function networkGuard(env,kind='manual') {
  const client=accessClient(env);
  // 本番入口では保存先が必須。単体テストから直接解析する場合だけ未指定を許可する。
  if(!client)return null;
  return async url=>{
    let result;
    try{result=await client({action:'acquire',host:new URL(url).hostname,kind});}
    catch{throw Object.assign(new Error('通信上限を確認できないため待機しています'),{accessLimited:true,retryAt:Date.now()+60000});}
    if(!result.ok)throw Object.assign(new Error(result.error),{accessLimited:true,retryAt:result.retryAt});
    return async()=>{try{await client({action:'release',id:result.id});}catch{/* 解放できなくても45秒で失効。通信回数は返却しない。 */}};
  };
}
