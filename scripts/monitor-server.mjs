// 有料サーバーへの移行用。外部ライブラリを増やさずNode.js 24で動かす。
// Cloudflare版と同じ監視エンジン・商品解析・操作画面を使用する。
import http from 'node:http';
import { readFile, writeFile, rename, mkdir, open, unlink } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';
import { emptyMonitor, validateRule, productUrl, publicMonitor, validateWebhook } from '../src/monitor-core.js';
import { makeMonitorIO, monitorCommand, readCommand, monitorResponse } from '../src/monitor-service.js';
import { runMonitorTick } from '../src/monitor-engine.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const dir=resolve(process.env.MONITOR_DATA_DIR||join(root,'.monitor-data'));
const key=process.env.MONITOR_ACCESS_KEY||'';
if(!/^[a-f0-9]{64}$/.test(key))throw new Error('MONITOR_ACCESS_KEYに64桁の合言葉を設定してください');
await mkdir(dir,{recursive:true,mode:0o700});
const lockPath=join(dir,'server.lock');
// 2重起動すると通知も二重になるため、保存領域を使うプロセスを1つに限定する。
let lock;
try {lock=await open(lockPath,'wx',0o600);}
catch(error) {
  if(error.code!=='EEXIST')throw error;
  const pid=Number(await readFile(lockPath,'utf8'));
  if(!Number.isInteger(pid)||pid<=0)throw new Error('ロックファイルが不正です');
  try{process.kill(pid,0);throw new Error('監視サーバーは既に起動しています');}
  catch(e){if(e.code!=='ESRCH')throw e;}
  // 前のプロセスが消えていることを確認できた場合だけ、異常終了のロックを回収する。
  await unlink(lockPath);lock=await open(lockPath,'wx',0o600);
}
await lock.writeFile(String(process.pid));
const statePath=join(dir,'state.json');
async function save(state) {
  const temp=join(dir,'state.tmp');const file=await open(temp,'w',0o600);
  try{await file.writeFile(JSON.stringify(state));await file.sync();}finally{await file.close();}
  await rename(temp,statePath);
}
let state=emptyMonitor();
try {state=JSON.parse(await readFile(statePath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
const importPath=process.env.MONITOR_IMPORT_FILE;
if(importPath) {
  if(state.rules.length)throw new Error('既存データへの上書き移行はしません。新しい保存先を指定してください');
  const data=JSON.parse(await readFile(importPath,'utf8'));
  if(data.schema!==1||!Array.isArray(data.rules)||data.rules.length>10||!Array.isArray(data.targets)||data.targets.length>100)throw new Error('移行ファイルの形式が不正です');
  for(const rule of data.rules)rule.config=validateRule(rule.config);
  for(const target of data.targets)target.url=productUrl(target.url,target.storeId);
  // 通知済みのエピソードは維持。送信待ちの古い在庫通知を移行直後に流さない。
  state={...emptyMonitor(),...data,webhook:'',hosts:{},enabled:false};
  state.events=state.events.slice(0,80).map(e=>({...e,delivery:e.delivery==='pending'?'cancelled':e.delivery}));
  state.jobs=state.rules.flatMap(r=>r.config.storeIds.map(storeId=>({ruleId:r.id,storeId,nextAt:Date.now(),queue:[],seen:[],rounds:0,lastAt:null,error:''})));
  await save(state);
}
if(process.env.DISCORD_WEBHOOK_URL)state.webhook=validateWebhook(process.env.DISCORD_WEBHOOK_URL);
if(process.env.MONITOR_INTERVAL_SECONDS){const n=Number(process.env.MONITOR_INTERVAL_SECONDS);if(![10,30,60,180,300].includes(n))throw new Error('監視間隔が不正です');state.intervalSeconds=n;}
await save(state);
let tail=Promise.resolve();
function serial(fn){const result=tail.then(fn);tail=result.catch(()=>{});return result;}
const io=makeMonitorIO(save);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://127.0.0.1');
    const chunks=[];let bytes=0;
    for await(const chunk of req){bytes+=chunk.length;if(bytes>100000){res.writeHead(413);res.end();return;}chunks.push(chunk);}
    const headers=new Headers(req.headers);
    const origin=headers.get('origin');
    // リバースプロキシ運用では明示した公開URLのみ許可する。
    const allowedOrigin=process.env.MONITOR_PUBLIC_ORIGIN||`http://${req.headers.host}`;
    if(origin&&origin!==allowedOrigin){res.writeHead(403);res.end();return;}
    const request=new Request(url,{method:req.method,headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})});
    let response;
    if(url.pathname==='/api/monitor') {
      const supplied=headers.get('authorization')||'';
      const expected=`Bearer ${key}`;
      if(supplied.length!==expected.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))response=monitorResponse({error:'監視用の合言葉が違います'},401);
      else response=await serial(async()=>{
        if(request.method==='POST') {
          const action=await monitorCommand(state,await readCommand(request),{minInterval:10});
          await save(state);
          if(action==='test')await io.notify(state.webhook,{id:crypto.randomUUID(),at:Date.now(),title:'通知テスト',price:0,url:allowedOrigin,stock:'test'});
        }else if(request.method!=='GET')return monitorResponse({error:'未対応の操作'},405);
        return monitorResponse(publicMonitor(state,10));
      });
    }else if(url.pathname.startsWith('/api/'))response=await worker.fetch(request,{});
    else {
      const file=resolve(root,'public','.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
      if(!file.startsWith(join(root,'public')+'/')||!mime[extname(file)])response=new Response('Not found',{status:404});
      else {try{response=new Response(await readFile(file),{headers:{'Content-Type':mime[extname(file)],'Cache-Control':'no-cache'}});}catch{response=new Response('Not found',{status:404});}}
    }
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'処理に失敗しました。設定と稼働ログを確認してください'}));}
});
server.listen(Number(process.env.PORT)||8787,process.env.HOST||'127.0.0.1',()=>console.info(JSON.stringify({event:'monitor_server_started',port:Number(process.env.PORT)||8787})));
let stopping=false;
async function loop(){if(stopping)return;try{await serial(()=>runMonitorTick(state,io));}catch{console.error(JSON.stringify({event:'monitor_tick_failed'}));}if(!stopping)setTimeout(loop,Math.min(30,state.intervalSeconds)*1000);}
loop();
async function stop(){if(stopping)return;stopping=true;server.close();await tail;await lock.close();await unlink(lockPath);process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
