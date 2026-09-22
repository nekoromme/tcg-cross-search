// 合言葉はURLへ入れない。認証ヘッダーでのみ送るので履歴・リンクに残らない。
const KEY='tcg-monitor-key-v1', $=id=>document.getElementById(id);
let key='', state=null, busy=false, draft=null, storeNames={};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=value=>value?new Date(value).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}):'未確認';
const stock={in_stock:'在庫あり',out_of_stock:'在庫なし',preorder:'予約受付',unknown:'在庫不明'};
const delivery={pending:'通知待ち・再試行中',sent:'Discord送信済み',failed:'Discord送信失敗',screen:'画面内の記録',cancelled:'送信見送り（条件外・停止・時間経過）'};
function message(text,error=false){$('message').textContent=text;$('message').className=error?'monitorError':'';}
async function api(body) {
  if(!key) throw new Error('このブラウザに合言葉を保存できません。ブラウザの保存設定を確認してください');
  const response=await fetch('/api/monitor',{method:body?'POST':'GET',cache:'no-store',headers:{Authorization:`Bearer ${key}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(45000)});
  const data=await response.json();if(!response.ok)throw new Error(data.error||`取得失敗 ${response.status}`);
  state=data; render();return data;
}
async function perform(fn){if(busy)return;busy=true;try{await fn();}catch(e){message(e.message,true);}finally{busy=false;}}
function render() {
  const active=state.rules.filter(r=>r.enabled).length;
  $('overview').textContent=`${state.enabled?'稼働中':'全体を一時停止中'}／有効な条件 ${active}件／商品ページ ${state.targets.length}件／最終巡回 ${time(state.lastTick)}`;
  $('pauseAll').textContent=state.enabled?'全体を一時停止':'全体を再開';
  if(state.minInterval===10&&!$('interval').querySelector('option[value="10"]'))$('interval').insertAdjacentHTML('afterbegin','<option value="10">10秒（移行先サーバー）</option>');
  if(document.activeElement!==$('interval'))$('interval').value=String(state.intervalSeconds);
  $('notificationState').textContent=state.notificationConfigured?'通知先は設定済み。空欄のまま保存すると現在の通知先を維持します。':'通知先は未設定。現在は画面内の記録のみです。';
  $('rules').innerHTML=state.rules.map(r=>`<article class="monitorCard"><strong>${esc(r.config.query)}：${r.enabled?'監視中':'一時停止'}</strong><p>${r.config.unit==='box'?'BOXのみ':'BOX＋カートン・複数BOX'}／${r.config.priceLimit==='all'?'定価制限なし':`定価の${esc(r.config.priceLimit)}%まで`}${r.config.maxPrice?`／上限${r.config.maxPrice.toLocaleString()}円`:''}／${r.config.includePreorders?'予約を含む':'即納のみ'}／定価不明${r.config.includeUnknown?'も含む':'は除外'}／${r.config.storeIds.length}店</p><div class="monitorActions"><button data-toggle="${r.id}" type="button">${r.enabled?'一時停止':'再開'}</button><button data-delete="${r.id}" type="button">この条件を削除</button></div></article>`).join('')||'<p>まだ登録されていません。</p>';
  $('targets').innerHTML=state.targets.map(t=>`<article class="monitorCard"><strong>${esc(storeNames[t.storeId]||t.storeId)}</strong><a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${esc(t.title)}</a><p>${t.error?'今回：確認失敗／前回確認：':''}${esc(stock[t.lastGood?.stock]||'未確認')}・${t.lastGood?.price>0?t.lastGood.price.toLocaleString()+'円':'価格未設定・未確認'}<br>最終取得 ${time(t.lastChecked)}／正常確認 ${time(t.lastGoodAt)}<br>次回予定 ${state.enabled?time(t.nextAt):'停止中'}</p>${t.error?`<p class="monitorError">${esc(t.error)}（連続${t.failures}回）</p>`:''}</article>`).join('')||'<p>検索で商品ページが見つかると、ここに追加されます。</p>';
  $('events').innerHTML=state.events.map(e=>`<article class="monitorCard"><strong>${esc(stock[e.stock])}・${e.price.toLocaleString()}円（送料別）</strong><a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.title)}</a><p>${esc(storeNames[e.storeId]||e.storeId)}／${time(e.at)}<br>${esc(delivery[e.delivery]||e.delivery)}</p></article>`).join('')||'<p>条件を満たす在庫・予約を確認すると記録します。</p>';
  $('jobs').innerHTML=state.jobs.map(j=>`<div class="monitorCard"><strong>${esc(state.rules.find(r=>r.id===j.ruleId)?.config.query)}／${esc(storeNames[j.storeId]||j.storeId)}</strong><p>前回 ${time(j.lastAt)}／${j.queue.length?'続きの確認待ち':'次の掲載確認を待機'}${j.error?`<br><span class="monitorError">${esc(j.error)}</span>`:''}</p></div>`).join('')||'<p>監視条件の登録後に順番に検索します。</p>';
  if(state.error)message(state.error,true);
}
$('refresh').onclick=()=>perform(async()=>{await api();message('最新の監視状況を表示しました');});
$('pauseAll').onclick=()=>perform(async()=>{await api({action:'settings',enabled:!state.enabled});message(state.enabled?'監視を再開しました':'監視を一時停止しました');});
$('rules').onclick=event=>perform(async()=>{
  const toggle=event.target.closest('[data-toggle]'),del=event.target.closest('[data-delete]');
  if(toggle){const r=state.rules.find(r=>r.id===toggle.dataset.toggle);await api({action:'toggle',id:r.id,enabled:!r.enabled});message('監視条件を更新しました');}
  if(del){await api({action:'delete',id:del.dataset.delete});message('監視条件を削除しました');}
});
$('addForm').onsubmit=event=>{event.preventDefault();perform(async()=>{
  const rule={query:$('monitorQuery').value,game:$('monitorGame').value,unit:$('monitorUnit').value,priceLimit:$('monitorPrice').value,maxPrice:$('monitorMax').value||null,includePreorders:$('monitorPreorder').checked,includeUnknown:$('monitorUnknown').checked};
  await api({action:'add',rule,seeds:draft?.seeds||[]});draft=null;sessionStorage.removeItem('tcg-monitor-draft');$('addPanel').open=false;message(state.enabled?'監視を登録しました。商品ページを順に確認します。':'登録しました。全体が停止中なので、再開ボタンで開始してください。');
});};
$('settingsForm').onsubmit=event=>{event.preventDefault();perform(async()=>{const body={action:'settings',intervalSeconds:Number($('interval').value)};if($('webhook').value.trim())body.webhook=$('webhook').value.trim();await api(body);$('webhook').value='';message('設定を保存しました');});};
$('testNotification').onclick=()=>perform(async()=>{await api({action:'test'});message('Discordへテスト通知を送りました');});
$('removeNotification').onclick=()=>perform(async()=>{await api({action:'settings',webhook:''});message('Discord通知先を解除しました');});
$('showKey').onclick=()=>{$('keyDisplay').hidden=false;$('keyDisplay').value=key;};
$('keyForm').onsubmit=event=>{event.preventDefault();perform(async()=>{const next=$('keyInput').value.trim();if(!/^[a-f0-9]{64}$/.test(next))throw new Error('合言葉の形式を確認してください');localStorage.setItem(KEY,next);key=next;$('keyInput').value='';$('keyDisplay').hidden=true;await api();message('この合言葉の監視を開きました');});};
$('exportState').onclick=()=>perform(async()=>{await api();const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='tcg-monitor-backup.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);message('移行用データを書き出しました');});
async function init(){try{
  key=localStorage.getItem(KEY)||'';
  if(!/^[a-f0-9]{64}$/.test(key)){key=[...crypto.getRandomValues(new Uint8Array(32))].map(x=>x.toString(16).padStart(2,'0')).join('');localStorage.setItem(KEY,key);}
  try{draft=JSON.parse(sessionStorage.getItem('tcg-monitor-draft')||'null');}catch{}
  if(draft){const r=draft.rule;$('monitorQuery').value=r.query;$('monitorGame').value=r.game||'';$('monitorUnit').value=r.unit==='box'?'box':'sealed';$('monitorPrice').value=r.priceLimit;$('monitorMax').value=r.maxPrice||'';$('monitorPreorder').checked=r.includePreorders;$('monitorUnknown').checked=r.includeUnknown;}
  const stores=await(await fetch('/api/stores')).json();storeNames=Object.fromEntries(stores.stores.map(s=>[s.id,s.name]));
  await api();message('監視状況を表示しました');
}catch(e){message(e.message,true);}}
init();
// 画面の更新だけ。監視の実行はサーバー側なので、閉じても止まらない。
setInterval(()=>{if(!document.hidden&&!busy&&key)perform(()=>api());},30_000);
