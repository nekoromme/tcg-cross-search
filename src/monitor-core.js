// 実行場所に依存しない監視のルール。Cloudflareでも移行先のNode.jsでも共有する。
import { STORE_MAP, STORES } from './stores.js';
import { isLikelyProductUrl, isJunkTitle, looksLikeSingleCard, normalizeUrlKey, sanitizeQuery } from './search-common.js';
import { matchesQuery, comparePrice, identifyProduct, explicitGame } from '../public/catalog.js';
import { productKind } from '../public/product-kind.js';

export const LIMITS = { rules: 10, targets: 50, events: 80, intervalSeconds: 60, discoveryMs: 30 * 60_000 };
export function emptyMonitor() {
  return { schema: 1, enabled: true, intervalSeconds: 60, webhook: '', rules: [], targets: [], jobs: [], events: [], hosts: {}, lastTick: null, error: '' };
}
export function validateRule(input) {
  const query = sanitizeQuery(input.query);
  if (query.length < 2 || query.length > 100) throw new Error('監視する商品名・型番を2〜100文字で入力して');
  const game = String(input.game || '');
  if (!['', 'pokemon', 'onepiece', 'gundam', 'dragonball', 'lorcana'].includes(game)) throw new Error('ゲームの指定が不正です');
  const unit = input.unit || 'box';
  if (!['box', 'sealed'].includes(unit)) throw new Error('監視はBOXまたはBOX＋カートンに対応しています');
  const priceLimit = String(input.priceLimit || '105');
  if (!['100', '105', '110', 'all'].includes(priceLimit)) throw new Error('定価条件が不正です');
  const maxPrice = input.maxPrice == null || input.maxPrice === '' ? null : Number(input.maxPrice);
  if (maxPrice !== null && (!Number.isInteger(maxPrice) || maxPrice < 1 || maxPrice > 99999999)) throw new Error('上限価格が不正です');
  const allowed = STORES.filter(s => !game || !s.games || s.games.includes(game)).map(s=>s.id);
  if(input.storeIds && !Array.isArray(input.storeIds))throw new Error('対象店舗の形式が不正です');
  const storeIds = input.storeIds ? [...new Set(input.storeIds)].sort() : allowed.sort();
  if (!storeIds.length || storeIds.some(id=>!allowed.includes(id))) throw new Error('対象店舗が不正です');
  return { query, game, unit, priceLimit, maxPrice, includeUnknown: input.includeUnknown === true,
    includePreorders: input.includePreorders !== false, storeIds };
}
export function productUrl(raw, storeId) {
  const store = STORE_MAP.get(storeId);
  const url = new URL(raw), home = store && new URL(store.home);
  if (!home || url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.hostname !== home.hostname || !url.pathname.startsWith(home.pathname) || !isLikelyProductUrl(url.href)) {
    throw new Error('登録済み店舗の商品ページだけ監視できます');
  }
  url.hash = '';
  // 検索順位などの追跡情報は同じ商品の別登録を作らない。
  for (const key of [...url.searchParams.keys()]) if (/^_|^utm_|^(ref|srsltid)$/i.test(key)) url.searchParams.delete(key);
  if (url.href.length > 1500) throw new Error('商品URLが長すぎます');
  return url.href;
}
export function validateWebhook(value) {
  if (!value) return '';
  const url = new URL(String(value));
  if (url.origin !== 'https://discord.com' || url.username || url.password || url.hash || url.search ||
      !/^\/api\/webhooks\/\d{15,22}\/[A-Za-z0-9_-]{30,150}$/.test(url.pathname)) throw new Error('Discordの通知用URLを入力して');
  return url.href;
}
export function matchesRule(row, rule) {
  if (!row.title || !matchesQuery(row.title, rule.query) || isJunkTitle(row.title) || looksLikeSingleCard(row.title)) return false;
  const game = explicitGame(row.title) || identifyProduct(row.title)?.game;
  if (game && rule.game && game !== rule.game) return false;
  return (rule.unit === 'box' ? ['box'] : ['box','carton','bundle']).includes(productKind(row.title));
}
// null は未確認、false は確認済みの条件外。未確認を売切として扱わないことが重要。
export function eligibility(row, rule) {
  if (!row?.detailChecked || !row.title || row.stock === 'unknown') return null;
  if (!matchesRule(row, rule)) return false;
  if (row.stock === 'out_of_stock') return false;
  if (!['in_stock','preorder'].includes(row.stock)) return null;
  if (row.stock === 'preorder' && !rule.includePreorders) return false;
  if (!(row.price > 0) || row.priceState === 'unavailable' || row.priceComparable === false) return null;
  if (rule.maxPrice && row.price > rule.maxPrice) return false;
  const comp = comparePrice(row);
  if (comp.status !== 'known' && !rule.includeUnknown) return false;
  if (comp.status === 'known' && rule.priceLimit !== 'all' && row.price > comp.referencePrice * Number(rule.priceLimit) / 100) return false;
  return true;
}
export function addRule(state, input, seeds = [], now = Date.now()) {
  const valid = validateRule(input), fingerprint = JSON.stringify(valid);
  const existing = state.rules.find(r=>JSON.stringify(r.config) === fingerprint);
  if (existing) return existing;
  if(state.targets.length>=LIMITS.targets)throw new Error(`商品ページは最大${LIMITS.targets}件です。不要な監視条件を削除してください`);
  if (state.rules.length >= LIMITS.rules) throw new Error(`監視条件は最大${LIMITS.rules}件です`);
  const rule = { id: crypto.randomUUID(), config: valid, enabled: true, createdAt: now };
  state.rules.push(rule);
  state.jobs.push(...valid.storeIds.map(storeId=>({ ruleId: rule.id, storeId, nextAt: now, queue: [], seen: [], rounds: 0, lastAt: null, error: '' })));
  for (const row of seeds.slice(0,100)) if (valid.storeIds.includes(row.storeId) && matchesRule(row,valid)) addTarget(state, rule, row, now);
  return rule;
}
export function addTarget(state, rule, row, now) {
  const url = productUrl(row.url, row.storeId), key = `${row.storeId}:${normalizeUrlKey(url)}`;
  let target = state.targets.find(t=>t.key===key);
  if (!target) {
    if (state.targets.length >= LIMITS.targets) { state.error = `商品ページが${LIMITS.targets}件の上限。不要な監視条件を削除してください`; return null; }
    target = { id: crypto.randomUUID(), key, storeId: row.storeId, url, title: String(row.title).slice(0,600), ruleIds: [], episodes: {}, nextAt: now, failures: 0, lastChecked: null, lastGood: null, error: '' };
    state.targets.push(target);
  }
  if (!target.ruleIds.includes(rule.id)) target.ruleIds.push(rule.id);
  return target;
}
export function removeRule(state, id) {
  state.rules = state.rules.filter(r=>r.id!==id);
  state.jobs = state.jobs.filter(j=>j.ruleId!==id);
  for (const t of state.targets) { t.ruleIds=t.ruleIds.filter(x=>x!==id); delete t.episodes[id]; }
  state.targets=state.targets.filter(t=>t.ruleIds.length);
  if(state.targets.length<LIMITS.targets && state.error.startsWith('商品ページ'))state.error='';
  for (const event of state.events) if (event.ruleId===id && event.delivery==='pending') event.delivery='cancelled';
}
export function activeTarget(state, target) {
  // 旧版で51件以上登録済みでもデータを削除しない。超過分を待機させる。
  return state.enabled && enabledTargets(state).slice(0,LIMITS.targets).includes(target);
}
function enabledTargets(state) {return state.targets.filter(t=>state.rules.some(r=>r.enabled && t.ruleIds.includes(r.id)));}
export function effectiveInterval(state,target) {
  const targets=enabledTargets(state).slice(0,LIMITS.targets);
  const host=target && new URL(target.url).hostname.replace(/^www\./,'');
  const hostCount=host?targets.filter(t=>new URL(t.url).hostname.replace(/^www\./,'')===host).length:0;
  // 商品確認は約8000回/日、同一店は約1200回/日を目安に間隔を延長。
  // 発見検索・手動検索の余裕を残す。最終的な制限は全端末共通の通信ゲートが担当。
  return Math.max(state.intervalSeconds,Math.ceil(targets.length*86400/8000),Math.ceil(hostCount*86400/1200));
}
export function discoveryInterval(state) {
  const jobs=state.jobs.filter(j=>state.rules.some(r=>r.id===j.ruleId&&r.enabled)).length;
  // 1回4通信を目安に掲載検索を分散。続きの実通信数は共有上限でも制限する。
  return Math.max(LIMITS.discoveryMs,Math.ceil(jobs*4*86400000/4000));
}
export function observe(state, target, row, now) {
  target.lastChecked=now;
  target.latest=row;
  const known = row.detailChecked && row.title && row.stock !== 'unknown' && ((row.price > 0 && row.priceComparable!==false) || row.stock==='out_of_stock');
  if (!known) { recordFailure(target, '商品名・在庫・価格を確認できず', now, state.intervalSeconds); return; }
  target.lastGood=row; target.lastGoodAt=now; target.title=row.title.slice(0,600); target.failures=0; target.error='';
  target.nextAt=now+effectiveInterval(state,target)*1000;
  for (const rule of state.rules.filter(r=>r.enabled && target.ruleIds.includes(r.id))) {
    const value=eligibility(row,rule.config);
    const episode=target.episodes[rule.id] ||= { active:false, negatives:0, lastEvent:0 };
    if (value===null) continue;
    if (!value) {
      // 一度だけの売切表示で通知を再開しない。2回続いた時に次の再入荷を待つ。
      episode.negatives++;
      if (episode.negatives>=2) episode.active=false;
      for (const e of state.events) if (e.targetId===target.id && e.ruleId===rule.id && e.delivery==='pending') e.delivery='cancelled';
      continue;
    }
    episode.negatives=0;
    if (!episode.active && (!episode.lastEvent || now-episode.lastEvent>=300_000)) {
      const event={ id:crypto.randomUUID(), targetId:target.id, ruleId:rule.id, at:now, title:target.title, storeId:target.storeId, url:target.url,
        price:row.price, stock:row.stock, delivery:state.webhook?'pending':'screen', attempts:0, nextAt:now };
      // 同じ商品が複数条件に当たっても、同じ巡回の通知は1件にまとめる。
      if(!state.events.some(e=>e.targetId===target.id&&e.at===now))state.events.unshift(event);
      state.events=state.events.slice(0,LIMITS.events);
      episode.lastEvent=now;
      episode.active=true;
    }
  }
}
export function recordFailure(target, message, now, intervalSeconds, status=0) {
  target.lastChecked=now; target.failures=(target.failures||0)+1;
  target.error=message; // HTTP本文や秘密のURLをエラーへ入れない。
  const delay=[403,429].includes(status)?1800_000:Math.min(1800_000,intervalSeconds*1000*2**Math.min(target.failures,5));
  target.nextAt=now+delay;
}
export function publicMonitor(state, minInterval=30) {
  const {webhook,hosts,...rest}=state;
  return { ...rest, notificationConfigured:Boolean(webhook), limits:LIMITS, minInterval, load: { activePages:enabledTargets(state).slice(0,LIMITS.targets).length, waitingPages:Math.max(0,enabledTargets(state).length-LIMITS.targets), intervalSeconds:Math.max(effectiveInterval(state),...enabledTargets(state).slice(0,LIMITS.targets).map(t=>effectiveInterval(state,t))), discoverySeconds:Math.ceil(discoveryInterval(state)/1000) } };
}
