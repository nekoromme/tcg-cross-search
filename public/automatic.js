// ここは公開済みの稼働記録だけを読む。秘密の通知鍵を端末に取り込まない。
const STATUS='https://raw.githubusercontent.com/nekoromme/tcg-box-monitor-public/monitor-state/inventory_status.json';
const GAMES={pokemon:'ポケモン',onepiece:'ワンピース',gundam:'ガンダム',dragonball:'ドラゴンボール',lorcana:'ロルカナ',yugioh:'遊戯王'};
const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=t=>t?new Date(t).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}):'未確認',yen=n=>n?Number(n).toLocaleString('ja-JP')+'円':'未確認';
let state;
export function settingsRequestUrl(product,values) {
  const input={version:1,productId:product.id,enabled:values.enabled,percent:values.percent,maxPrice:values.maxPrice};
  const body=`${product.name} の通知条件を変更します。\n\n\`\`\`json\n${JSON.stringify(input,null,2)}\n\`\`\`\n\nこのリポジトリの所有者本人が送信した設定だけ反映されます。`;
  return 'https://github.com/nekoromme/tcg-box-monitor-public/issues/new?'+new URLSearchParams({title:'[在庫設定] 通知条件の変更',body});
}
function renderProducts() {
  const filter=$('filter').value.normalize('NFKC').toLowerCase();
  $('products').innerHTML=state.automatic.products.filter(p=>[p.name,p.id,GAMES[p.game],p.notificationStatus].join(' ').normalize('NFKC').toLowerCase().includes(filter)).map(p=>{
    const rule=state.rules.find(r=>r.automaticProductId===p.id),price=state.prices?.records?.[p.id],cadence=state.cadence?.products.find(c=>c.productId===p.id);
    const status={price_unpublished:'公式価格の発表待ち',quantity_unconfirmed:'1箱の入数の確認待ち',identity_unconfirmed:'公式ページの商品名を確認中',fetch_failed:'公式ページを再確認中',price_conflict:'価格の記載を確認中'}[price?.status];
    const sources=p.priceEvidence?.sources||price?.sources||[];
    return `<article class="autoProduct"><h3>${esc(p.name)}</h3><span class="autoBadge">${esc(GAMES[p.game])} · ${esc(p.notificationStatus)}</span>
      <p>定価 ${yen(p.boxPrice)} ／ 通知上限 <strong>${p.priceStatus==='ready'?yen(p.notificationMaxPrice):'保留'}</strong>（${p.pricePercent}%）</p>
      ${p.notificationReason?`<p>${esc(p.notificationReason)}</p>`:''}${!p.boxPrice&&status?`<p>${status}。次の確認：${time(price.nextCheckAt)}</p>`:''}
      <p class="help">発売 ${esc(p.releaseDate)}${cadence?.minSeconds?` ／ 商品確認 ${Math.ceil(cadence.minSeconds/60)}〜${Math.ceil(cadence.maxSeconds/60)}分目安`:''}</p>
      ${sources.length?`<details><summary>定価の根拠</summary>${sources.map(s=>`<p><a href="${esc(s.url)}" target="_blank" rel="noopener">${s.kind==='official_price'?'公式価格':'1箱の入数'}</a> ／ ${time(s.checkedAt)}</p>`).join('')}</details>`:''}
      <details><summary>通知対象・上限を変更</summary><form data-product="${esc(p.id)}"><label>在庫通知<select name="enabled"><option value="true" ${rule?.enabled?'selected':''}>有効</option><option value="false" ${!rule?.enabled?'selected':''}>停止</option></select></label><label>定価に対する上限（%）<input name="percent" type="number" min="50" max="1000" step="1" required value="${p.pricePercent}"></label><label>さらに金額で上限（円・空欄なら割合のみ）<input name="maxPrice" type="number" min="1" max="99999999" step="1" value="${rule?.config.maxPrice??''}"></label><button type="submit">GitHubで確認して保存</button><p class="help">開いた画面で送信すると反映を開始します。割合と金額の両方がある場合は安い方を使います。</p></form></details></article>`;
  }).join('')||'<p>一致する商品はありません。</p>';
}
async function refresh() {
  $('refresh').disabled=true;
  try {
    const response=await fetch(STATUS,{cache:'no-store'});if(!response.ok)throw new Error('稼働記録を取得できませんでした');
    state=await response.json();const active=state.automatic.products.filter(p=>p.monitoringEnabled),unknown=active.filter(p=>!p.boxPrice);
    const stale=Date.now()-state.generatedAt>3*3600000;
    $('message').textContent=`記録 ${time(state.generatedAt)}（日本時間）${stale?'。更新が遅れています。表示は過去の記録です。':''}`;
    $('summary').textContent=`監視有効 ${active.length}弾 ／ 定価確認待ち ${unknown.length}弾 ／ 通知の連続失敗 ${state.deliveryHealth?.consecutiveFailures||0}件`;
    renderProducts();
    const review=state.marketReview,candidates=review?.products.filter(p=>p.status==='pause_candidate')||[];
    $('market').innerHTML=review?`<p>確認 ${time(review.reviewedAt)} ／ 次回 ${time(review.nextReviewAt)}</p><p>${esc(review.scope)}</p>${candidates.length?candidates.map(p=>`<p><strong>${esc(p.name)}</strong>：${esc(p.reason)}</p>`).join(''):'<p>新しい除外候補はありません。</p>'}`:'<p>最初の定期確認を待っています。</p>';
    const lag=state.cadence?.notificationDelay;
    $('cadence').innerHTML=`<p>一覧探索：通常30分、変化が少ない店は60分、新規発見・短時間完売の根拠がある店は10分。最大3店を重点監視します。</p><p>${lag?.samples?`検知してから通知受理まで：中央値${Math.ceil(lag.medianMs/1000)}秒、最大${Math.ceil(lag.maxMs/1000)}秒（直近7日・${lag.samples}件）`:'通知の遅れは実際の送信履歴が集まると表示します。'}</p><p class="help">${esc(state.cadence?.limitations||'商品ごとの確認間隔は上の商品欄に表示します。')}</p>`;
  }catch(error){$('message').textContent=error.message+'。最後に表示できた記録を残しています。';}
  finally{$('refresh').disabled=false;}
}
$('refresh').onclick=refresh;$('filter').oninput=()=>state&&renderProducts();
$('products').onsubmit=event=>{
  const form=event.target.closest('form[data-product]');if(!form)return;event.preventDefault();
  const product=state.automatic.products.find(p=>p.id===form.dataset.product);
  location.href=settingsRequestUrl(product,{enabled:form.elements.enabled.value==='true',percent:Number(form.elements.percent.value),maxPrice:form.elements.maxPrice.value?Number(form.elements.maxPrice.value):null});
};
refresh();
