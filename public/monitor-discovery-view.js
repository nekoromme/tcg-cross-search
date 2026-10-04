const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function discoveryMarkup(discovery,names,time) {
  if(!discovery)return '';
  const modes={normal:'通常',quiet:'変化が少ない店',focused:'期間限定の重点監視',waiting:'取得待機',paused:'停止中'};
  return '<p>店舗の一覧は通常30分、変化が少ない店は60分、重点監視は10分を目安に確認。通信枠・店舗の応答によって延びます。初回発見は掲載開始時刻とは限りません。</p>'+
    Object.values(discovery.stores||{}).map(s=>`<article class="monitorCard"><strong>${esc(names[s.storeId]||s.storeId)}／${esc(modes[s.mode]||'初回待ち')}</strong><p>${esc(s.reason||'初回の一覧確認を待機')}<br>前回成功 ${time(s.lastAt)}／次回予定 ${time(s.nextAt)}${s.mode==='focused'?`<br>重点期間の終了 ${time(s.focusUntil)}`:''}<br>前回発見 ${s.lastResult?.registered||0}ページ／短時間販売の観測 ${s.rapidSales?.length||0}回</p>${s.error?`<p class="monitorError">${esc(s.error)}</p>`:''}</article>`).join('');
}
