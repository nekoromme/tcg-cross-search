// 保存済みの事実を表示するだけ。価格・在庫を推測で補完しない。
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={in_stock:'在庫あり',out_of_stock:'在庫なし',preorder:'予約受付'};
export function historyMarkup(rows,formatTime) {
  if(!rows?.length)return '<p class="help">まだ確認履歴がありません。機能追加後の監視から記録します。</p>';
  return '<table class="historyTable"><thead><tr><th scope="col">確認した時刻</th><th scope="col">確認内容</th></tr></thead><tbody>'+[...rows].reverse().map(row=>{
    const when=row.lastAt!==row.at?`${esc(formatTime(row.at))}<br>〜 ${esc(formatTime(row.lastAt))}<br>${esc(row.samples)}回の${row.kind==='observation'?'確認':'記録'}`:esc(formatTime(row.at));
    let detail;
    if(row.kind==='observation')detail=`${esc(labels[row.stock]||'未確認')}<br>${row.price>0?Number(row.price).toLocaleString('ja-JP')+'円':'価格未確認'}${row.comparable===false?'（条件付き・単純比較不可）':''}`;
    else detail=`${esc({error:'取得失敗',waiting:'通信上限で待機',pause:'監視停止',resume:'監視再開'}[row.kind]||'未確認')}<br>${esc(row.reason)}`;
    return `<tr><td>${when}</td><td>${detail}</td></tr>`;
  }).join('')+'</tbody></table>';
}
