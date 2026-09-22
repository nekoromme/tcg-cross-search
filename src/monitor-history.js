// 価格・在庫の履歴は、監視が実際に確認した事実だけを保存する。
// 同じ値の繰り返しは1行にまとめるが、確認の間ずっと同じだったとは保証しない。
export const HISTORY_LIMITS = Object.freeze({ entries:100, days:30 });
export function pruneHistory(target, now=Date.now()) {
  target.history=(target.history||[]).filter(x=>Number.isFinite(x.at)&&Number.isFinite(x.lastAt)&&x.lastAt>=now-HISTORY_LIMITS.days*86400000).slice(-HISTORY_LIMITS.entries);
  return target.history;
}
export function recordHistory(target, entry, now=Date.now()) {
  const rows=pruneHistory(target,now);
  const value=entry.kind==='observation'
    ? {kind:'observation',stock:entry.stock,price:entry.price>0?entry.price:null,comparable:entry.comparable!==false}
    : {kind:entry.kind,reason:String(entry.reason||'').slice(0,180)};
  const last=rows.at(-1);
  // 失敗・停止・再開が挟まれば別の行になる。過去と現在を勝手につながない。
  const same=last && Object.entries(value).every(([k,v])=>last[k]===v);
  if(same && now>=last.lastAt) {last.lastAt=now;last.samples=(last.samples||1)+1;}
  else rows.push({...value,at:now,lastAt:now,samples:1});
  target.history=rows.slice(-HISTORY_LIMITS.entries);
}
