import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {loadSoloDistribution} from '../server/solo-distribution.mjs';

const [installationArg,generatedArg,outputArg]=process.argv.slice(2);
const expectedBuild=Number(process.env.HONEYMOON_QA_BUILD ?? 4);
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
const requestedOrigins=new Set();
const worldOrigins=new Set();

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
  worldOrigins.add(new URL(url).origin);
  const state=await fetch(url+'api/solo-cache').then(r=>r.json());
  assert.equal(state.build,expectedBuild);
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
    if (!/^(?:blob|data):/.test(request.url())) requestedOrigins.add(new URL(request.url()).origin);
  });
  await page.goto(url,{waitUntil:'domcontentloaded'});
  await playable(page);
  const session=await localPost(page,'session');
  assert.equal(session.access.role,'admin');
  assert.equal(session.access.owner,true);
  assert.equal(session.access.singlePlayer,true);
  assert.equal(session.soloDownload,true);
  await play(page);
  return {page,session};
}

async function playable(page) {
  await page.waitForFunction(()=>globalThis.honeymoon?.stats().playable>0,undefined,{timeout:90_000});
}

async function play(page) {
  await page.locator('#play').click();
  await page.waitForFunction(()=>!document.getElementById('teleport-toggle').disabled);
}

async function localPost(page,path,payload={}) {
  return page.evaluate(async ({path,payload})=>{
    const response=await fetch('/api/'+path,{method:'POST',body:JSON.stringify(payload),
      headers:{'Content-Type':'application/json'}});
    if (!response.ok) throw new Error('Local request failed: '+path+' '+response.status);
    return response.json();
  },{path,payload});
}

async function pause(page) {
  await page.evaluate(()=>document.exitPointerLock());
  await page.waitForFunction(()=>document.getElementById('game').classList.contains('paused'));
}

async function switchWorld(page,label) {
  const previous=new URL(page.url()).origin;
  await Promise.all([
    page.waitForURL(url=>url.hostname==='127.0.0.1'&&url.origin!==previous,{timeout:30000}),
    page.getByRole('button',{name:label,exact:true}).click(),
  ]);
  worldOrigins.add(new URL(page.url()).origin);
  await playable(page);
  return localPost(page,'session');
}

async function teleport(page,{x,y,z}) {
  await page.locator('#teleport-toggle').evaluate(button=>button.click());
  for (const [axis,value] of Object.entries({x,y,z})) await page.locator('#teleport-'+axis).fill(String(value));
  await page.locator('#teleport-send').click();
  await page.waitForFunction(({x,y,z})=>{
    const at=honeymoon.stats().position;
    return Math.hypot(at.x-x,at.y-y,at.z-z)<.04 && document.getElementById('teleport-loading').hidden;
  },{x,y,z});
  const close=page.locator('#teleport-close');
  if (await close.isVisible()) await close.click();
  if (await page.locator('#play').isVisible()) await play(page);
}

async function checkTestRange(page) {
  await pause(page);
  const equestria=await localPost(page,'session');
  assert.equal(equestria.soloWorld,'equestria');
  const originalOrigin=new URL(page.url()).origin;
  const expectedPosition=await page.evaluate(()=>honeymoon.stats().position);
  const range=await switchWorld(page,'Тестовый полигон');
  assert.equal(range.soloWorld,'test-range');
  assert.equal(range.access.role,'admin');
  assert.deepEqual(range.position,{x:.5,y:65,z:.5});
  assert.equal(range.inventory.slots[7],null);
  assert.ok(!range.soloDownload);
  assert.equal(await page.getByRole('button',{name:'Загрузка карты'}).isVisible(),false);
  const {bounds}=await page.evaluate(()=>fetch('/generated/world/world.json').then(response=>response.json()));
  assert.equal(bounds.maxX-bounds.minX+1,500);
  assert.equal(bounds.maxZ-bounds.minZ+1,500);
  await play(page);
  const outside=await page.evaluate(async x=>{
    const response=await fetch('/api/teleport',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({x,y:65,z:.5})});
    return {status:response.status,error:(await response.json()).error};
  },bounds.maxX+1.5);
  assert.deepEqual(outside,{status:403,error:'outside_playable_area'});
  const npcs=await page.evaluate(()=>fetch('/api/npcs').then(response=>response.json()));
  assert.deepEqual(npcs.npcs.map(npc=>npc.id),['test-range-guide']);
  await page.evaluate(()=>honeymoon.look(Math.PI,-.21));
  await page.waitForFunction(()=>honeymoon.targetNpc()?.id==='test-range-guide');
  await page.keyboard.press('KeyE');
  await page.getByRole('dialog',{name:'Смотритель полигона'}).waitFor();
  await page.getByText(/На западе полигона стоят ряды/).waitFor();
  await page.screenshot({path:join(output,'test-range-guide.png')});
  await page.locator('#npc-menu-close').click();
  if (await page.locator('#play').isVisible()) await play(page);
  await teleport(page,{x:8.5,y:65,z:5.5});
  await page.evaluate(()=>honeymoon.look(Math.PI,-.05));
  await page.waitForFunction(()=>document.getElementById('selected').textContent.includes('Рамка'));
  const [rotation]=await Promise.all([
    page.waitForResponse(response=>response.url().endsWith('/api/action') &&
      response.request().postDataJSON().type==='frame_use'),
    page.keyboard.press('KeyE'),
  ]);
  assert.ok(rotation.ok(),await rotation.text());
  const rotated=await rotation.json();
  assert.equal(rotated.frames.find(frame=>frame.key==='frame:8:66:8:2').data.ItemRotation,1);
  await page.screenshot({path:join(output,'test-range-frames.png')});
  await pause(page);
  const changed=await localPost(page,'action',{type:'inventory_give',requestId:'qa-range-give-example',
    slot:7,key:'legacy:1:0',count:8});
  assert.equal(changed.inventory.slots[7].count,8);
  const returned=await switchWorld(page,'Вернуться в Эквестрию');
  assert.equal(new URL(page.url()).origin,originalOrigin);
  assert.equal(returned.soloWorld,'equestria');
  assert.equal(returned.inventory.slots[7].count,4);
  assert.ok(Math.hypot(returned.position.x-expectedPosition.x,returned.position.y-expectedPosition.y,
    returned.position.z-expectedPosition.z)<.1);
  const revisited=await switchWorld(page,'Тестовый полигон');
  assert.equal(revisited.inventory.slots[7].count,8);
  assert.deepEqual(revisited.position,{x:8.5,y:65,z:5.5});
  await play(page);
  await teleport(page,{x:bounds.maxX+.5,y:65,z:.5});
  await page.keyboard.press('KeyF');
  await page.waitForFunction(()=>honeymoon.stats().flying);
  await page.evaluate(()=>honeymoon.look(-Math.PI/2,0));
  await page.keyboard.down('KeyW');
  try {
    await page.waitForFunction(edge=>honeymoon.stats().position.x>edge+.58,bounds.maxX);
    await page.waitForTimeout(600);
    const {position,body}=await page.evaluate(()=>honeymoon.stats());
    assert.ok(position.x+body.halfWidth<=bounds.maxX+1+.001);
  } finally {
    await page.keyboard.up('KeyW');
  }
  return {testedOffline:true,returned:returned.position,npc:npcs.npcs[0].name,frameRotation:1,
    isolatedInventory:true,bounds,teleportBoundary:outside.status,flightBoundary:true};
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
  if (expectedBuild>=7) result.checks.push({testRange:await checkTestRange(offlinePage)});
  assert.equal(mapFiles().length,before);
  await offlinePage.close();
  assert.deepEqual([...requestedOrigins].filter(origin=>!worldOrigins.has(origin)),[]);
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
