// 観測間の長さを保ち、初回から売切の商品を「瞬殺」と推測しない。
const MINUTE=60_000, DAY=86400_000;
export const DISCOVERY_POLICY=Object.freeze({version:1,normalMs:30*MINUTE,quietMs:60*MINUTE,focusedMs:10*MINUTE,
  focusMs:2*3600_000,maxFocusedStores:3,maxFocusedTargets:5,logEntries:1000,logDays:14,groupDaily:2600,fallbackDaily:1400});
export function initDiscovery(state,now) {
  if(!state.automatic?.enabled)return null;
  const d=state.discovery ||= {version:1,startedAt:now,stores:{},log:[]};
  d.stores ||= {};d.log ||= [];
  return d;
}
export function discoveryLog(state,entry,now) {
  if(!state.discovery)return;
  state.discovery.log=[...state.discovery.log.filter(x=>x.at>=now-DISCOVERY_POLICY.logDays*DAY),{...entry,at:now}].slice(-DISCOVERY_POLICY.logEntries);
}
export function discoveryStore(state,id,now) {
  const d=initDiscovery(state,now);if(!d)return null;
  return d.stores[id] ||= {storeId:id,nextAt:now,createdAt:now,successes:0,failures:0,rapidSales:[],sources:[],sourceCursor:0};
}
export function focusStore(state,store,reason,now,duration=DISCOVERY_POLICY.focusMs) {
  const focused=Object.values(state.discovery.stores).filter(x=>x.focusUntil>now);
  if(!(store.focusUntil>now)&&focused.length>=DISCOVERY_POLICY.maxFocusedStores)return false;
  store.focusUntil=Math.max(store.focusUntil||0,now+duration);store.focusReason=reason;
  store.nextAt=Math.max(store.retryAt||0,Math.min(store.nextAt,now+DISCOVERY_POLICY.focusedMs));
  return true;
}
export function focusTarget(state,target,reason,now) {
  if(!state.discovery)return;
  if(!(target.focusUntil>now)&&state.targets.filter(t=>t.focusUntil>now&&t.enabled!==false).length>=DISCOVERY_POLICY.maxFocusedTargets)return;
  target.focusUntil=now+30*MINUTE;target.focusReason=reason;
}
export function storeCadence(store,now) {
  if(store.retryAt>now)return {intervalMs:store.retryAt-now,mode:'waiting',reason:store.error||'接続待機'};
  if(store.focusUntil>now)return {intervalMs:DISCOVERY_POLICY.focusedMs,mode:'focused',reason:store.focusReason};
  if(store.successes>=24 && now-(store.lastNewAt||store.createdAt)>=DAY)
    return {intervalMs:DISCOVERY_POLICY.quietMs,mode:'quiet',reason:'取得範囲で24時間以上、対象ページの追加なし'};
  return {intervalMs:DISCOVERY_POLICY.normalMs,mode:'normal',reason:'通常の観測・記録'};
}
export function discoveryBudget(state,kind,now,reserve=4) {
  const d=state.discovery,day=Math.floor((now+9*3600_000)/DAY);
  if(d.budget?.day!==day)d.budget={day,group:0,fallback:0};
  const limit=kind==='group'?DISCOVERY_POLICY.groupDaily:DISCOVERY_POLICY.fallbackDaily;
  return {ok:d.budget[kind]+reserve<=limit,retryAt:(day+1)*DAY-9*3600_000};
}
export function recordAvailability(state,target,row,now) {
  if(!state.discovery)return;
  const store=discoveryStore(state,target.storeId,now),t=target.availabilityTiming ||= {firstObservedAt:now};
  const available=['in_stock','preorder'].includes(row.stock), previous=t.stock;
  // 通信失敗中・停止中をまたぐサンプルも区間を広げる。下限/上限を正直に記録する。
  if(available && !['in_stock','preorder'].includes(previous)) {
    t.availableSince=now;t.openAfter=previous==='out_of_stock'?t.lastAt:null;
    t.firstAvailableAt ||= now;
    if(previous==='out_of_stock')focusTarget(state,target,'購入不可から購入可能への変化',now);
    discoveryLog(state,{kind:'available',storeId:target.storeId,targetId:target.id,previousAt:t.openAfter,firstSeenAt:target.discovery?.firstSeenAt||null},now);
  }
  if(!available && ['in_stock','preorder'].includes(previous)) {
    const sample={at:now,targetId:target.id,availableFirstAt:t.availableSince,availableLastAt:t.lastAt,
      unavailableBeforeAt:t.openAfter,unavailableAt:now,
      durationLowerMs:Math.max(0,t.lastAt-t.availableSince),durationUpperMs:t.openAfter==null?null:now-t.openAfter};
    t.lastSale=sample;
    discoveryLog(state,{kind:'sold_out',storeId:target.storeId,...sample},now);
    if(sample.durationUpperMs!==null&&sample.durationUpperMs<=15*MINUTE) {
      store.rapidSales=[...(store.rapidSales||[]).filter(x=>x.at>=now-7*DAY),sample].slice(-12);
      // 一度の揺れで店全体を常時高速化しない。2回の短時間販売が根拠。
      if(store.rapidSales.length>=2)focusStore(state,store,'15分以内の販売終了を2回以上確認（過去7日）',now,DAY);
    }
    delete t.openAfter;delete t.availableSince;
  }
  t.stock=row.stock;t.lastAt=now;
  if(available)t.lastAvailableAt=now;else t.lastUnavailableAt=now;
}

// 重点枠も同じ1日8000回・同一店1200回の中で配分する。無制限に追加しない。
export function focusedInterval(state,target,targets,now) {
  if(!state.discovery||!targets.some(t=>t.focusUntil>now))return null;
  const weight=t=>t.focusUntil>now?6:state.rules.some(r=>r.enabled&&!r.autoRetired&&t.ruleIds.includes(r.id)&&r.config.automaticProduct?.pinned)?3:1;
  const own=target?weight(target):1,host=target&&new URL(target.url).hostname;
  const total=targets.reduce((n,t)=>n+weight(t),0),hostTotal=targets.filter(t=>new URL(t.url).hostname===host).reduce((n,t)=>n+weight(t),0);
  return Math.max(target?.focusUntil>now?120:state.intervalSeconds,state.intervalSeconds,Math.ceil(total*86400/(8000*own)),Math.ceil(hostTotal*86400/(1200*own)));
}
