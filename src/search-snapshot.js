// 同じ検索の詳細確認を分割する時だけ、サーバーが取得済みの候補一覧を引き継ぐ。
// 詳細確認済みの価格・在庫は使い回さない。続きでも商品詳細は新しく取り直す。
// 保存が使えない・期限切れ・条件が違う場合は通常検索へ戻るので、確認を省かない。
const TTL_MS=120_000;
function key(origin,id){return new Request(`${origin}/__internal/search-snapshot/${id}`);}
export async function loadSearchSnapshot(origin,id,scope,now=Date.now()) {
  if(!/^[a-f0-9]{32}$/.test(id||'') || !globalThis.caches?.default)return null;
  try {
    const response=await caches.default.match(key(origin,id));
    if(!response)return null;
    const saved=await response.json();
    if(saved.scope!==scope || saved.expiresAt<=now || !Array.isArray(saved.candidates))return null;
    return saved;
  } catch {return null;}
}
export async function saveSearchSnapshot(origin,scope,value,now=Date.now()) {
  if(!globalThis.caches?.default)return '';
  try {
    const id=crypto.randomUUID().replaceAll('-','');
    await caches.default.put(key(origin,id),new Response(JSON.stringify({...value,scope,expiresAt:now+TTL_MS}),{
      headers:{'Content-Type':'application/json','Cache-Control':`public, max-age=${TTL_MS/1000}`}}));
    return id;
  } catch {return '';}
}
