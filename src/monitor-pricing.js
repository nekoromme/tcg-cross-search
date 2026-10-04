import {comparePrice,PRODUCTS} from '../public/catalog.js';

// 期待度の推測で購入上限を引き上げない。例外は商品IDで明示する。
// 税込の通常1BOXの商品価格を比較する。送料・ポイントは含めない。
export const AUTOMATIC_PRICE_VERSION=1;
export function initialPricePolicy() {
  return {version:AUTOMATIC_PRICE_VERSION,defaultPercent:105,overrides:{
    'pokemon-m6a':{percent:200,maxPrice:null,reason:'利用者指定：30th CELEBRATIONの通常BOXは定価の2倍まで'},
  }};
}
export function priceAssessment(row,rule) {
  const comparison=comparePrice(row||{});
  const referencePrice=comparison.status==='known'?comparison.referencePrice:null;
  const percent=rule.priceLimit==='all'?null:Number(rule.priceLimit);
  const absolute=rule.maxPrice||null;
  const relative=referencePrice&&percent?Math.floor(referencePrice*percent/100):null;
  const maxPrice=relative&&absolute?Math.min(relative,absolute):relative||absolute;
  const base={referencePrice,percent,maxPrice,policyReason:rule.pricePolicyReason||'',shippingIncluded:false};
  if(!Number.isInteger(row?.price)||row.price<=0||row.priceComparable===false)
    return {...base,status:'price_unknown',reason:'税込商品価格を確認できないため通知保留'};
  if(maxPrice&&row.price>maxPrice)
    return {...base,status:'over_limit',reason:`通知上限${maxPrice.toLocaleString('ja-JP')}円を超過`};
  if(!referencePrice&&!rule.includeUnknown)
    return {...base,status:'reference_unknown',reason:'BOX定価を確認できないため通知保留'};
  return {...base,status:'within_limit',reason:maxPrice?`通知上限${maxPrice.toLocaleString('ja-JP')}円以下`:'価格条件内'};
}

// 再同期や旧版からの移行で、通知済み・手動停止・在庫履歴を初期化しない。
// 発売情報の取得が失敗しても、この価格条件は次の巡回の冒頭で適用する。
export function applyAutomaticPricing(state,now=Date.now()) {
  const auto=state.automatic;if(!auto)return;
  const policy=auto.pricePolicy ||= initialPricePolicy(),changed=[];
  for(const rule of state.rules.filter(r=>r.automaticProductId)) {
    const override=policy.overrides[rule.automaticProductId];
    const percent=override?.percent??policy.defaultPercent;
    const maxPrice=override?.maxPrice??null;
    const reason=override?.reason||'基本条件：定価＋5%以内';
    if(rule.config.priceLimit!==String(percent)||rule.config.maxPrice!==maxPrice||rule.config.includeUnknown!==false||rule.config.pricePolicyReason!==reason) {
      Object.assign(rule.config,{priceLimit:String(percent),maxPrice,includeUnknown:false,pricePolicyReason:reason});
      changed.push(rule.automaticProductId);
    }
  }
  auto.products=(auto.products||[]).map(p=>{
    const rule=state.rules.find(r=>r.automaticProductId===p.id);if(!rule)return p;
    const retail=rule.config.automaticProduct?.boxPrice||PRODUCTS.find(item=>item.id===p.id)?.boxPrice||null;
    const relative=retail?Math.floor(retail*Number(rule.config.priceLimit)/100):null;
    const absolute=rule.config.maxPrice;
    return {...p,boxPrice:retail,pricePercent:Number(rule.config.priceLimit),notificationMaxPrice:relative&&absolute?Math.min(relative,absolute):relative||absolute,pricePolicyReason:rule.config.pricePolicyReason,priceStatus:retail?'ready':'reference_unknown'};
  });
  if(changed.length)auto.log=[...(auto.log||[]),{at:now,kind:'pricing',products:changed,defaultPercent:policy.defaultPercent}].slice(-100);
}

export function updateRulePrice(state,id,input,now=Date.now()) {
  const rule=state.rules.find(r=>r.id===id);if(!rule)throw new Error('監視条件が見つかりません');
  const limit=String(input.priceLimit),percent=Number(limit);
  if(!(limit==='all'&&!rule.automaticProductId)&&(!Number.isInteger(percent)||percent<50||percent>1000))throw new Error('定価の割合は50〜1000%の整数で指定してください');
  const maxPrice=input.maxPrice==null||input.maxPrice===''?null:Number(input.maxPrice);
  if(maxPrice!==null&&(!Number.isInteger(maxPrice)||maxPrice<1||maxPrice>99999999))throw new Error('上限価格が不正です');
  if(rule.automaticProductId) {
    state.automatic.pricePolicy ||= initialPricePolicy();
    state.automatic.pricePolicy.overrides[rule.automaticProductId]={percent,maxPrice,reason:'利用者が商品別に指定した価格条件'};
    applyAutomaticPricing(state,now);
  } else Object.assign(rule.config,{priceLimit:limit,maxPrice});
  // 再取得前の古い在庫は通知しない。現在の上限を超えた通知待ちはここで止める。
  for(const event of state.events.filter(e=>e.ruleId===id&&e.delivery==='pending'&&e.kind!=='catalog')) {
    const assessment=priceAssessment({...event,detailChecked:true},rule.config);
    if(assessment.status!=='within_limit') {
      event.delivery='cancelled';event.cancelledAt=now;event.cancelReason=assessment.reason;
      const target=state.targets.find(t=>t.id===event.targetId),episode=target?.episodes[id];
      if(episode&&episode.lastEvent===event.at)episode.active=false;
    }
  }
}
