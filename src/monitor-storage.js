// 履歴を削らずに圧縮し、保存行数を減らす。以前の分割JSONもそのまま読める。
// 同じキー群を一つのトランザクションで置き換えるため、途中の失敗で混在させない。
const FORMAT='monitor-gzip-v1';
const CHUNK=96*1024;
const MAX_BYTES=32*1024*1024;
export async function encodeMonitor(serialized) {
  const bytes=new TextEncoder().encode(serialized);
  if(bytes.length>MAX_BYTES)throw new Error('monitor snapshot size limit');
  const compressed=new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  let binary='';for(let i=0;i<compressed.length;i+=32768)binary+=String.fromCharCode(...compressed.subarray(i,i+32768));
  const envelope=JSON.stringify({storageFormat:FORMAT,data:btoa(binary)});
  return {chunks:envelope.match(new RegExp(`[\\s\\S]{1,${CHUNK}}`,'g'))||[],stats:{format:FORMAT,uncompressedBytes:bytes.length,compressedBytes:compressed.length}};
}
export async function decodeMonitor(serialized) {
  const envelope=JSON.parse(serialized);
  if(envelope.storageFormat!==FORMAT)return {state:envelope,stats:{format:'legacy-json',uncompressedBytes:new TextEncoder().encode(serialized).length}};
  const binary=atob(envelope.data),compressed=Uint8Array.from(binary,c=>c.charCodeAt(0));
  const reader=new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  let size=0,text='';const decoder=new TextDecoder();
  try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_BYTES)throw new Error('monitor snapshot size limit');text+=decoder.decode(value,{stream:true});}}
  finally {await reader.cancel();}
  return {state:JSON.parse(text+decoder.decode()),stats:{format:FORMAT,uncompressedBytes:size,compressedBytes:compressed.length}};
}
export function monitorFailure(error,stage) {
  const message=String(error?.message||'');
  // 例外本文にはJSONや秘密が混ざり得るため、既知の分類だけを外へ返す。
  const code=/quota|daily.*limit|rows.*(?:limit|written)|exceeded.*(?:storage|write)|D1_ERROR.*limit/i.test(message)?'storage_quota'
    :/snapshot|chunk|JSON|Unexpected token/i.test(message)?'storage_data'
    :/CPU|memory|resource.*limit/i.test(message)?'runtime_limit':'monitor_unavailable';
  return {code,stage,name:String(error?.name||'Error').slice(0,40),at:Date.now()};
}
