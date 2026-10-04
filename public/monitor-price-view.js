const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function rulePriceForm(rule) {
  const options=[...new Set(['100','105','110','150','200',rule.config.priceLimit,...(rule.automaticProductId?[]:['all'])])];
  return `<details data-panel="price-${esc(rule.id)}"><summary>この商品の通知上限を変更</summary><form data-rule-price="${esc(rule.id)}" class="monitorGrid"><label>定価に対する上限<select name="priceLimit">${options.map(p=>`<option value="${esc(p)}" ${p===rule.config.priceLimit?'selected':''}>${p==='all'?'定価制限なし':p==='105'?'定価＋5%以内':p==='200'?'定価の2倍以内':`定価の${p}%以内`}</option>`).join('')}</select></label><label>さらに金額で上限を指定（円）<input name="maxPrice" type="number" inputmode="numeric" min="1" max="99999999" value="${esc(rule.config.maxPrice??'')}" placeholder="指定なし"></label><p class="help">割合と金額の両方を指定した場合は、安い方が通知上限です。税込の商品価格で比較し、送料は含みません。上限外も監視と履歴保存は続けます。</p><button type="submit">この商品の上限を保存</button></form></details>`;
}
