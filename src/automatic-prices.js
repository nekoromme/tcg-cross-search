// GitHub側で取得した公式価格の台帳。未確認・誤った版の情報は取り込まない。
const HOSTS={pokemon:['www.pokemon-card.com','www.30th.pokemon-card.com'],onepiece:['www.onepiece-cardgame.com'],gundam:['www.gundam-gcg.com'],dragonball:['www.dbs-cardgame.com'],lorcana:['www.takaratomy.co.jp'],yugioh:['www.yugioh-card.com']};
export function verifiedPrice(product,record) {
  if(record?.status!=='confirmed'||record.productId!==product.id||record.game!==product.game||!Number.isInteger(record.boxPrice)||record.boxPrice<100||record.boxPrice>100000||!Number.isFinite(record.checkedAt))return null;
  let url;try{url=new URL(record.officialUrl);}catch{return null;}
  if(url.protocol!=='https:'||url.username||url.password||!HOSTS[product.game]?.includes(url.hostname))return null;
  if(!record.sources?.some(s=>s.kind==='official_price'&&s.url===url.href))return null;
  if(record.basis==='official_pack_times_verified_count') {
    if(!Number.isInteger(record.packPrice)||record.packPrice<=0||!Number.isInteger(record.packsPerBox)||record.packsPerBox<2||record.packsPerBox>60||record.packPrice*record.packsPerBox!==record.boxPrice)return null;
    if(!record.sources.some(s=>s.kind==='official_price'&&s.packsPerBox===record.packsPerBox||s.kind==='observed_box_quantity'&&s.count===record.packsPerBox))return null;
  } else if(record.basis!=='official_box')return null;
  return {boxPrice:record.boxPrice,priceEvidence:record,officialUrl:url.href};
}
export function applyAutomaticPriceRecords(state,prices,now=Date.now()) {
  if(prices?.version!==1||!state.automatic)return [];
  const auto=state.automatic,changed=[];
  auto.priceRecords ||= {};
  for(const product of auto.catalog||[]) {
    const record=prices.records?.[product.id],value=verifiedPrice(product,record);
    if(!value||auto.priceRecords[product.id]?.checkedAt>record.checkedAt)continue;
    auto.priceRecords[product.id]=record;
    if(product.boxPrice!==value.boxPrice)changed.push(product.id);
    Object.assign(product,value);
    for(const rule of state.rules.filter(r=>r.automaticProductId===product.id))Object.assign(rule.config.automaticProduct,value);
  }
  auto.priceCollection={checkedAt:prices.checkedAt,records:prices.records,log:prices.log?.slice(-80)||[]};
  if(changed.length) {
    auto.log=[...(auto.log||[]),{at:now,kind:'official-prices',products:changed}].slice(-100);
    // 価格が初めて分かった商品の古い在庫記録をそのまま通知せず、再取得を早める。
    const ids=new Set(state.rules.filter(r=>changed.includes(r.automaticProductId)&&r.enabled&&!r.autoRetired).map(r=>r.id));
    for(const target of state.targets)if(target.ruleIds.some(id=>ids.has(id))&&!target.error)target.nextAt=Math.min(target.nextAt,now);
  }
  return changed;
}
