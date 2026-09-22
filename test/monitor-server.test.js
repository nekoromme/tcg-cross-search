import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { emptyMonitor, addRule, observe, publicMonitor } from '../src/monitor-core.js';

test('移行用サーバーで認証・データ引継ぎ・静的画面・再起動を確認',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'tcg-monitor-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
  const key='d'.repeat(64),state=emptyMonitor();
  const title='ガンダムカードゲーム GD04 BOX';
  addRule(state,{query:'GD04',game:'gundam',priceLimit:'105'},[{storeId:'mediaworld',url:'https://mediaworld.co.jp/products/test',title}]);
  observe(state,state.targets[0],{title,price:5808,stock:'in_stock',detailChecked:true},Date.now());state.enabled=false;state.disabledStoreIds=['mediaworld'];state.targets[0].enabled=false;
  const backup=join(dir,'backup.json');await writeFile(backup,JSON.stringify(publicMonitor(state)));
  let child;
  t.after(async()=>{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}});
  const start=async(importFile='')=>{
    child=spawn(process.execPath,['scripts/monitor-server.mjs'],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',MONITOR_ACCESS_KEY:key,MONITOR_DATA_DIR:dir,MONITOR_IMPORT_FILE:importFile},stdio:['ignore','pipe','pipe']});
    await Promise.race([once(child.stdout,'data'),once(child,'exit').then(([code])=>{throw new Error(`起動失敗 ${code}`);}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('起動待ち時間超過')),5000);timer.unref();})]);
  };
  await start(backup);
  const base=`http://127.0.0.1:${port}`;
  let response=await fetch(base+'/api/monitor');assert.equal(response.status,401);
  response=await fetch(base+'/monitor.html');assert.equal(response.status,200);assert((await response.text()).includes('画面を閉じても'));
  response=await fetch(base+'/api/monitor',{headers:{Authorization:`Bearer ${key}`}});let data=await response.json();assert.equal(data.enabled,false);assert.equal(data.targets.length,1);assert.equal(data.events.length,1);assert(data.targets[0].episodes[data.rules[0].id].active);
  response=await fetch(base+'/api/monitor',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({action:'settings',intervalSeconds:10})});assert.equal(response.status,200);
  child.kill('SIGTERM');await once(child,'exit');await start();
  response=await fetch(base+'/api/monitor',{headers:{Authorization:`Bearer ${key}`}});data=await response.json();assert.equal(data.intervalSeconds,10);assert.equal(data.events.length,1);assert.equal(data.enabled,false);assert.equal(data.targets[0].enabled,false);assert.deepEqual(data.disabledStoreIds,['mediaworld']);assert.equal(data.targets[0].history[0].price,5808);
});
