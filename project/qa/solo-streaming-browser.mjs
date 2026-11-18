import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {loadSoloDistribution} from '../server/solo-distribution.mjs';

const [installationArg,generatedArg,outputArg]=process.argv.slice(2);
const installation=resolve(installationArg), generated=resolve(generatedArg), output=resolve(outputArg);
await mkdir(output,{recursive:true});
const distribution=loadSoloDistribution(generated);
assert.ok(distribution,'Missing distribution catalog');
const remoteRequests=[];
const origin=createServer(async (request,response)=>{
  remoteRequests.push({method:request.method,path:request.url,cookie:request.headers.cookie??null,
    authorization:request.headers.authorization??null});
  try {
    if (await distribution.serve(request,response,new URL(request.url,'http://localhost').pathname)) return;
    response.writeHead(404).end();
  } catch {
    if (!response.headersSent) response.writeHead(500).end();
    else response.destroy();
  }
});
origin.listen(0,'127.0.0.1');
await once(origin,'listening');
const source=`http://127.0.0.1:${origin.address().port}`;
const result={checks:[],pageErrors:[]};
let browser,game;
const mapFiles=()=>remoteRequests.filter(request=>request.path.startsWith('/solo-download/files/'));

async function start(offline=false) {
  const exe=process.platform==='win32' ? join(installation,'runtime','node.exe') : process.execPath;
  const child=spawn(exe,['Launch-Honeymoon.mjs','--no-browser','--port','0','--asset-origin',source,
    ...(offline ? ['--offline'] : [])],{cwd:installation,windowsHide:true,stdio:['ignore','pipe','pipe']});
  game=child;
  const url=await new Promise((accept,reject)=>{
    let output='';
    const timer=setTimeout(()=>reject(Error('Startup timed out: '+output)),100000);
    const finish=value=>{
      clearTimeout(timer);
      accept(value);
    };
    child.stdout.on('data',bytes=>{
      output+=bytes;
      const address=output.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (address) finish(address[0]);
    });
    child.stderr.on('data',bytes=>{output+=bytes;});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',code=>{clearTimeout(timer);reject(Error(`Launcher exit ${code}: ${output}`));});
  });
  const state=await fetch(url+'api/solo-cache').then(r=>r.json());
  assert.equal(state.build,4);
  return {url,state};
}

async function stop() {
  if (!game) return;
  const child=game;
  game=undefined;
  if (child.exitCode!==null || child.signalCode!==null) return;
  const exited=once(child,'exit');
  child.kill();
  await exited;
}

async function enter(url,withoutInternet=false) {
  const page=await browser.newPage({viewport:{width:950,height:650}});
  if (withoutInternet) await page.addInitScript(()=>Object.defineProperty(navigator,'onLine',{get:()=>false}));
  page.on('pageerror',error=>result.pageErrors.push(error.message));
  page.on('request',request=>{
    if (!request.url().startsWith(url) && !/^(?:blob|data):/.test(request.url())) result.browserRemoteRequest=request.url();
  });
  await page.goto(url,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>globalThis.honeymoon?.stats().playable>0,undefined,{timeout:90_000});
  const session=await page.evaluate(async()=>fetch('/api/session',{method:'POST',body:'{}',
    headers:{'Content-Type':'application/json'}}).then(r=>r.json()));
  assert.equal(session.access.role,'admin');
  assert.equal(session.access.owner,true);
  assert.equal(session.access.singlePlayer,true);
  assert.equal(session.soloDownload,true);
  await page.locator('#play').click();
  await page.waitForFunction(()=>!document.getElementById('teleport-toggle').disabled);
  return {page,session};
}

try {
  const started=performance.now();
  const first=await start();
  const firstFiles=mapFiles().length;
  assert.ok(firstFiles>0 && first.state.readyBytes<first.state.totalBytes);
  result.checks.push({firstLaunchMs:Math.round(performance.now()-started),starter:first.state,firstFiles});
  browser=await chromium.launch({channel:'msedge',args:['--enable-unsafe-swiftshader']});
  const {page,session}=await enter(first.url);
  const spawn=session.position;
  await page.evaluate(()=>document.exitPointerLock());
  await page.waitForFunction(()=>document.getElementById('game').classList.contains('paused'));
  await page.locator('#solo-download-toggle').click();
  await page.locator('#solo-download-size').waitFor();
  await page.screenshot({path:join(output,'download-dialog.png')});
  await page.locator('#solo-download-close').click();
  await page.locator('#play').click();

  const far={x:728,y:275,z:-900};
  const pack='full-world/1.-2.bin';
  assert.ok(!mapFiles().some(request=>request.path.endsWith('/'+pack)));
  await page.locator('#teleport-toggle').evaluate(button=>button.click());
  for (const [axis,value] of Object.entries(far)) await page.locator('#teleport-'+axis).fill(String(value));
  await page.locator('#teleport-send').click();
  await page.waitForFunction(()=>Math.abs(honeymoon.stats().position.x-728)<1 &&
    document.getElementById('teleport-loading').hidden,undefined,{timeout:70000});
  assert.equal(mapFiles().filter(request=>request.path.endsWith('/'+pack)).length,1);
  const afterTeleport=await page.evaluate(()=>honeymoon.stats().position);
  await page.screenshot({path:join(output,'downloaded-region.png')});
  await page.waitForTimeout(5500);
  await page.close();
  await stop();
  result.checks.push({spawn,afterTeleport,farPackDownloads:1});

  const before=mapFiles().length;
  const repeat=await start();
  assert.equal(mapFiles().length,before);
  await stop();
  const offline=await start(true);
  const {page:offlinePage,session:offlineSession}=await enter(offline.url,true);
  assert.equal(offlineSession.access.uid,session.access.uid);
  assert.ok(Math.abs(offlineSession.position.x-far.x)<1);
  const missing=await offlinePage.evaluate(async()=>fetch('/api/teleport',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({x:3164,y:280,z:-5316})})
    .then(async r=>({status:r.status,error:(await r.json()).error})));
  assert.deepEqual(missing,{status:503,error:'solo_asset_unavailable'});
  const localInventory=await offlinePage.evaluate(async()=>fetch('/api/action',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({
      type:'inventory_give',requestId:'solo-qa-give-item',slot:7,key:'legacy:1:0',count:4,
    }),
  }).then(async r=>({status:r.status,stack:(await r.json()).inventory?.slots[7]})));
  assert.equal(localInventory.status,200);
  assert.equal(localInventory.stack?.count,4);
  assert.equal(mapFiles().length,before);
  await offlinePage.close();
  assert.ok(!result.browserRemoteRequest);
  assert.deepEqual(result.pageErrors,[]);
  assert.ok(remoteRequests.every(r=>r.method==='GET' && !r.cookie && !r.authorization &&
    r.path.startsWith('/solo-download/')));
  result.checks.push({repeatedFileDownloads:mapFiles().length-before,repeatReady:repeat.state.readyFiles,
    offlinePosition:offlineSession.position,offlineNotDownloaded:missing,localInventory:localInventory.stack,localOwner:true});
} catch (error) {
  result.failure=error.stack;
  throw error;
} finally {
  result.remoteRequests=remoteRequests;
  await writeFile(join(output,'solo-streaming.json'),JSON.stringify(result,null,2)+'\n');
  await browser?.close();
  await stop();
  await new Promise(resolve=>origin.close(resolve));
}
