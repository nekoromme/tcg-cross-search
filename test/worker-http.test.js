import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare,Response} from 'miniflare';

// NodeのfetchモックだけではWorkers固有のRequestオプション不一致を検出できない。
// 外部通信はすべて差し替え、実際のworkerdで通知と発売情報取得を通す。
test('Workersで通知と公式発売情報を取得し、転送先へ秘密を渡さない',async()=>{
  const root=fileURLToPath(new URL('..',import.meta.url));
  const bundle=await build({stdin:{resolveDir:root,contents:`
    import {emptyMonitor} from './src/monitor-core.js';
    import {refreshAutomaticCatalog} from './src/automatic-catalog.js';
    import {sendDiscord} from './src/monitor-engine.js';
    export default {async fetch(request) {
      const s=emptyMonitor();s.automatic={enabled:true,nextSync:0,log:[]};
      await refreshAutomaticCatalog(s);
      let error='';try {await sendDiscord('https://discord.com/api/webhooks/123456789012345/abcdefghijklmnopqrstuvwxyz123456',{id:'runtime-test',at:Date.now(),title:'GD01 BOX',price:5808,storeId:'test',url:'https://example.com/box',stock:'in_stock'});}catch(e){error=e.message;}
      return Response.json({products:s.rules.length,catalogError:s.automatic.error,notificationError:error});
    }};`},bundle:true,write:false,format:'esm',platform:'neutral',target:'es2022'});
  let redirect=false;const hosts=[];
  const mf=new Miniflare({workers:[{config:{name:'inventory-http-test',type:'worker',compatibilityDate:'2026-09-07',manifest:{mainModule:'worker.js',modules:{'worker.js':{type:'esm',contents:bundle.outputFiles[0].text}}}},dev:{outboundService:{type:'fetcher',handler:request=>{
    const host=new URL(request.url).hostname;hosts.push(host);
    if(host==='raw.githubusercontent.com')return Response.json({seen_releases:{}});
    if(host==='discord.com')return redirect?new Response(null,{status:302,headers:{Location:'https://unexpected.example/secret'}}):Response.json({id:'message'});
    throw new Error('Unexpected external request');
  }}}}]});
  try {
    const success=await (await mf.dispatchFetch('https://test.local/')).json();
    assert.equal(success.catalogError,'',JSON.stringify(success));assert(success.products>0);assert.equal(success.notificationError,'');
    redirect=true;
    const failure=await (await mf.dispatchFetch('https://test.local/')).json();
    assert.match(failure.notificationError,/HTTP 302/);assert(!hosts.includes('unexpected.example'));
  } finally {await mf.dispose();}
});
