// 公式発売情報は、既存の抽選監視が確認・保存した情報だけを取り込む。
// ショップの商品名やSNSの噂から、存在しない新弾を作らない。
import { PRODUCTS, identifyProduct, normalized } from '../public/catalog.js';
import { addRule } from './monitor-core.js';
import { applyAutomaticPricing } from './monitor-pricing.js';

export const RELEASE_FEED = 'https://raw.githubusercontent.com/nekoromme/tcg-box-monitor-public/refs/heads/monitor-state/inventory_releases.json';
export const AUTO_LIMITS = {rules:80, targets:500, events:500, pagesPerRule:12};
const GAME_IDS = {pokemon_card:'pokemon',one_piece_card:'onepiece',gundam_card:'gundam',dragon_ball_fusion_world:'dragonball',lorcana:'lorcana',yu_gi_oh:'yugioh'};
const OFFICIAL_HOSTS = {pokemon:['www.pokemon-card.com','www.30th.pokemon-card.com'],onepiece:['www.onepiece-cardgame.com'],gundam:['www.gundam-gcg.com'],dragonball:['www.dbs-cardgame.com'],lorcana:['www.takaratomy.co.jp'],yugioh:['www.yugioh-card.com']};
const METHODS = new Set(['pokemon_official_product_card','pokemon_official_products_api','onepiece_official_product_link','gundam_official_booster_catalog','dragonball_official_product_link','lorcana_official_booster_detail','yugioh_official_embedded_catalog']);
const PINNED = ['gundam-gd01','gundam-gd05','pokemon-m6a'];
export function catalogProducts(feed) {
  if (!feed?.seen_releases || typeof feed.seen_releases !== 'object') throw new Error('発売情報の形式を確認できません');
  // BOX定価が未確認の商品は価格台帳には入れず、発売日と検索条件だけを補完する。
  const supplement={id:'onepiece-eb-04',game:'onepiece',code:'EB-04',name:'EGGHEAD CRISIS',aliases:['EGGHEAD CRISIS'],searchTerm:'EB-04',releaseDate:'2026-01-31',boxPrice:null,sources:[{url:'https://www.onepiece-cardgame.com/products/?page=1&subcategory=boosters'}]};
  const products=new Map([...PRODUCTS,supplement].map(p=>[p.id,{...p,officialUrl:p.sources[0]?.url}]));
  for(const r of Object.values(feed.seen_releases)) {
    const game=GAME_IDS[r.game_id];
    let url;try{url=new URL(r.official_url);}catch{continue;}
    if(!game || url.protocol!=='https:' || !OFFICIAL_HOSTS[game].includes(url.hostname) || r.source_tier!=='official' || r.confidence!=='high' || !METHODS.has(r.extraction_method))continue;
    // デッキ・用品・映像商品を通常の拡張パックBOXと混同しない。
    if(!/パック|ブースター|BOOSTER/i.test(r.product_category||'') || /デッキ|カードセット|MOVIE|DVD|Blu.?ray|サプライ/i.test(r.product_name))continue;
    const date=r.release_date||r.release_month;
    if(!/^20\d\d-\d\d(?:-\d\d)?$/.test(date||''))continue;
    const known=identifyProduct(r.product_name,game) || [...products.values()].find(p=>p.game===game&&p.sources?.some(s=>s.url===url.href));
    if(known)continue; // 確認済みの定価・別名と発売日を、一覧の曖昧な記載で上書きしない。
    const name=String(r.product_name).normalize('NFKC').replace(/^(?:ポケモンカードゲーム\s*MEGA\s*)?(?:(?:拡張パック|ブースターパック|ブースター|エクストラブースター|プレミアムブースター)\s*)+/,'').replace(/[「」『』]/g,'').trim();
    const code=name.match(/(?:\[|【)((?:OP|EB|PRB)-?\d+|(?:GD|FB|SB|ST)\d+)(?:\]|】)/i)?.[1]||'';
    const query=code&&!['EB01','ST01'].includes(code)?code:name.replace(/[【\[].*?[】\]]/g,'').replace(/^遊[☆★]?戯[☆★]?王\s*/,'').trim();
    if(query.length<2 || query.length>100)continue;
    const id=`${game}-${code?code.toLowerCase():normalized(url.pathname)}`;
    products.set(id,{id,game,code,name,searchTerm:query,aliases:[name,query],releaseDate:date,officialUrl:url.href,boxPrice:null});
  }
  return [...products.values()];
}

export function selectAutomaticProducts(products,now=Date.now()) {
  const today=new Date(now).toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});
  const selected=new Map();
  for(const id of PINNED){const p=products.find(p=>p.id===id);if(p)selected.set(id,{...p,pinned:true});}
  for(const game of Object.values(GAME_IDS)) {
    const rows=products.filter(p=>p.game===game).sort((a,b)=>b.releaseDate.localeCompare(a.releaseDate)||a.id.localeCompare(b.id));
    // 直近5弾は「発売済み」で数える。発売前の新弾は別枠なので、旧弾が早く外れない。
    for(const p of [...rows.filter(p=>p.releaseDate<=today).slice(0,5),...rows.filter(p=>p.releaseDate>today)])if(!selected.has(p.id))selected.set(p.id,p);
  }
  if(selected.size>AUTO_LIMITS.rules-10)throw new Error('新弾の件数が自動登録上限を超えています。既存対象を維持しました');
  return [...selected.values()];
}

export function syncAutomaticCatalog(state,feed,now=Date.now()) {
  const auto=state.automatic;
  // 一時的に一覧から消えても削除しない。新弾は累積台帳へ保存し、日付で直近5弾を選ぶ。
  const merged=new Map((auto.catalog||[]).map(p=>[p.id,p]));
  for(const p of catalogProducts(feed))merged.set(p.id,p);
  const catalog=[...merged.values()],chosen=selectAutomaticProducts(catalog,now);
  auto.catalog=catalog;
  const wanted=new Set(chosen.map(p=>p.id)), added=[];
  for(const rule of state.rules.filter(r=>r.automaticProductId)) {
    rule.autoRetired=!wanted.has(rule.automaticProductId);
    if(rule.autoRetired && !rule.retiredAt)rule.retiredAt=now;
    if(!rule.autoRetired)delete rule.retiredAt;
  }
  // 対象から外れて30日たったページだけ期限切れにする。保存済みのGitHubログは残る。
  state.targets=state.targets.filter(t=>!t.ruleIds.every(id=>state.rules.some(r=>r.id===id&&r.autoRetired&&r.retiredAt<now-30*86400000)));
  for(const p of chosen) {
    let rule=state.rules.find(r=>r.automaticProductId===p.id);
    if(!rule) {
      rule=addRule(state,{query:p.searchTerm||p.name,game:p.game,priceLimit:'105',includeUnknown:false,includePreorders:true},[],now);
      rule.automaticProductId=p.id;added.push(p);
    }
    // 再同期しても手動停止・通知済み状態・取得ログは維持する。
    rule.config.automaticProduct={id:p.id,name:p.name,code:p.code,aliases:p.aliases||[p.name],releaseDate:p.releaseDate,officialUrl:p.officialUrl,boxPrice:p.boxPrice||null,pinned:!!p.pinned};
  }
  auto.products=chosen.map(p=>({id:p.id,game:p.game,name:p.name,query:p.searchTerm||p.name,releaseDate:p.releaseDate,pinned:!!p.pinned,officialUrl:p.officialUrl}));
  applyAutomaticPricing(state,now);
  auto.lastSync=now;auto.nextSync=now+2*3600000;auto.error='';
  auto.log=[...(auto.log||[]),{at:now,kind:'catalog',count:chosen.length,added:added.map(p=>p.name)}].slice(-100);
  // 初期登録も1件にまとめる。新弾発見を在庫発見とは別の通知として残す。
  if(added.length)state.events.unshift({id:crypto.randomUUID(),kind:'catalog',at:now,title:`監視対象に${added.length}弾を追加`,products:added.map(p=>({name:p.name,game:p.game,releaseDate:p.releaseDate})),delivery:state.webhook?'pending':'screen',attempts:0,nextAt:now});
  return added;
}

export async function refreshAutomaticCatalog(state,now=Date.now(),fetcher=fetch) {
  if(!state.automatic?.enabled || state.automatic.nextSync>now)return;
  let stage='fetch';
  try {
    const response=await fetcher(RELEASE_FEED,{redirect:'manual',headers:{'User-Agent':'PersonalTCGCrossSearch/0.10.3 (+https://github.com/nekoromme/tcg-cross-search)'},signal:AbortSignal.timeout(15000)});
    stage=`http-${response.status}`;
    if(!response.ok)throw new Error('発売情報を取得できません');
    stage='read-body';
    const text=await response.text();if(text.length>12_000_000)throw new Error('発売情報のサイズ上限');
    stage='parse-catalog';
    syncAutomaticCatalog(state,JSON.parse(text),now);
  } catch (error) {
    state.automatic.lastFailure={at:now,stage,name:error?.name||'Error',reason:String(error?.message||'').slice(0,180)};
    state.automatic.error='公式発売情報の更新失敗。前回の監視対象を維持し30分後に再試行';
    state.automatic.nextSync=now+1800000;
    state.automatic.log=[...(state.automatic.log||[]),{at:now,kind:'error',message:state.automatic.error}].slice(-100);
  }
}
