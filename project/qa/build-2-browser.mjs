import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {createHoneymoonServer} from '../server/index.mjs';
import * as geometry from '../world/geometry.mjs';
import {stackRevision} from '../world/item-text.mjs';
import {playerBody} from '../world/player-body.mjs';

const [outputArg='work/build-2-qa', test='mobile']=process.argv.slice(2);
const expectedBuild=Number(process.env.HONEYMOON_QA_BUILD ?? 2);
const output=resolve(outputArg);
await mkdir(output,{recursive:true});
const solo=test==='solo';
const iphoneQa=test==='iphone-fullscreen';
const preloadQa=test==='terrain-preload-mobile'||test==='terrain-preload-desktop';
const onlineCacheQa=test==='online-cache'||test==='online-cache-mobile';
const controlsQa=test==='controls-update'||test==='controls-update-mobile';
const touchGameplayQa=test==='touch-gameplay';
const pauseQa=test==='pause-desktop'||test==='pause-mobile';
const raceQa=test==='races-desktop'||test==='races-mobile';
const mobileQa=iphoneQa||touchGameplayQa||['mobile','online-cache-mobile','controls-update-mobile','terrain-preload-mobile','pause-mobile','races-mobile'].includes(test);
const lavaQa=test==='lava-death';
const networkQa=test==='network-diagnostics';
const state=solo || networkQa ? join(await mkdtemp(join(output,`${test}-`)),'honeymoon.sqlite') : ':memory:';
const ownerKey='qa-local-owner';
const app=createHoneymoonServer({geometry,state,singlePlayer:solo,initialMode:solo||lavaQa||raceQa?'game':'creative',
  generated:process.env.HONEYMOON_QA_GENERATED,npcAdminKey:ownerKey,
  ...((onlineCacheQa||preloadQa)&&{inviteRequired:true,ownerOnPrimary:true}),
  ...(test==='altitude-server'&&{inviteRequired:true,ownerOnPrimary:true,altitudeMusic:process.env.HONEYMOON_QA_AUDIO})});
app.server.listen(0,'127.0.0.1');
await once(app.server,'listening');
const url=`http://127.0.0.1:${app.server.address().port}/`;
const result={test,checks:[],errors:[],failedAssets:[]};
const browser=await chromium.launch({channel:'msedge',args:['--enable-unsafe-swiftshader']});
const page=await browser.newPage({
  ...(mobileQa?{viewport:{width:390,height:730},isMobile:true,hasTouch:true}:{viewport:{width:1000,height:640}}),
  deviceScaleFactor:1,
  ...((onlineCacheQa||preloadQa||iphoneQa)&&{serviceWorkers:'block'}),
});
page.on('pageerror',error=>result.errors.push(error.message));
page.on('console',message=>{
  if (message.type()==='error' && /WebGLProgram|shader error|INVALID_OPERATION/i.test(message.text())) {
    result.errors.push(message.text());
  }
});
page.on('response',response=>{
  if (response.status()>=400 && /\.(?:mjs|webp|png|bin)(?:$|\?)/.test(response.url())) {
    result.failedAssets.push({status:response.status(),path:new URL(response.url()).pathname});
  }
});
const stat=()=>page.evaluate(()=>honeymoon.stats());
const click=selector=>page.locator(selector).click({timeout:15000});
const visible=selector=>page.locator(selector).isVisible();
const shot=name=>page.screenshot({path:join(output,name+'.png'),timeout:15_000});
const ready=()=>page.waitForFunction(()=>globalThis.honeymoon?.stats().playable>0,undefined,{timeout:90_000});
const skipPreload=()=>page.context().route(/\/api\/terrain-preload\?/,route=>route.fulfill({status:409}));
const pauseSection=section=>click(`[data-pause-section="${section}"]`);
const pauseTab=tab=>click(`[data-pause-tab="${tab}"]`);
async function start(admin=!solo) {
  if (admin) {
    const response=await page.request.post(url+'api/access/owner',{data:{key:ownerKey,profileName:'Проверка игры'}});
    assert.equal(response.status(),200,await response.text());
  }
  await page.goto(url,{waitUntil:'domcontentloaded'});
  await ready();
  assert.equal((await page.request.get(url+'api/build').then(response=>response.json())).build,expectedBuild);
  if (await visible('#play')) await click('#play');
  else await page.locator('#scene canvas').click();
  await page.waitForFunction(()=>!document.getElementById('chat-toggle').disabled);
  result.checks.push({start:(await stat()).playable});
}

async function hop(x,y,z) {
  await page.locator('#teleport-toggle').evaluate(button=>button.click());
  for (const [axis,value] of Object.entries({x,y,z})) await page.locator('#teleport-'+axis).fill(String(value));
  await click('#teleport-send');
  await page.waitForFunction(([x,y,z])=>{
    const at=honeymoon.stats().position;
    return Math.hypot(x-at.x,y-at.y,z-at.z)<1 && document.getElementById('teleport-loading').hidden;
  },[x,y,z],{timeout:65_000});
  if (await visible('#teleport-form')) await click('#teleport-close');
  if (await visible('#play')) await click('#play');
}

try {
  if (raceQa) {
    await skipPreload();
    await start();
    assert.match(await page.title(),/^Lilium Moonlight\b/);
    const cdp=mobileQa ? await page.context().newCDPSession(page) : null;
    const down=async id=>{
      const {x,y,width,height}=await page.locator(id).boundingBox();
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x+width/2,y:y+height/2}]});
    };
    const up=()=>cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    const activate=(id,key)=>mobileQa ? page.locator(id).tap() : page.keyboard.press(key);
    const activeGame=()=>page.waitForFunction(mobile=>document.getElementById('game').classList.contains('playing') &&
      (mobile||Boolean(document.pointerLockElement)),mobileQa);
    const ground=()=>page.waitForFunction(()=>{
      const stats=honeymoon.stats();
      return stats.grounded&&stats.movementSync.status==='ready';
    },undefined,{timeout:10_000});
    async function pauseGame() {
      if (mobileQa) await page.locator('#touch-pause').tap();
      else await page.evaluate(()=>document.exitPointerLock());
      await page.locator('#pause-home').waitFor({state:'visible'});
    }
    async function changeMode(mode) {
      await pauseGame();
      await pauseSection('world');
      await click('#self-mode-toggle');
      await page.waitForFunction(want=>honeymoon.health().mode===want,mode);
      await click('#play');
      await activeGame();
    }
    async function uploadSkin(marker,type,size) {
      const encoded=await page.evaluate(({marker,size})=>{
        const canvas=document.createElement('canvas');
        canvas.width=64;
        canvas.height=32;
        const context=canvas.getContext('2d');
        context.fillStyle='#dc9262';
        context.fillRect(0,0,64,32);
        context.fillStyle=marker;
        context.fillRect(0,0,1,1);
        if (size==='large') {
          context.fillStyle='#ce3254';
          context.fillRect(3,0,1,1);
        }
        return canvas.toDataURL('image/png').split(',')[1];
      },{marker,size});
      await pauseGame();
      await pauseSection('profile');
      await page.locator('#pony-skin').setInputFiles({name:`${type}.png`,mimeType:'image/png',buffer:Buffer.from(encoded,'base64')});
      await page.waitForFunction(type=>document.getElementById('skin-status').textContent.includes(type+'.png'),type);
      await click('#play');
      await page.waitForFunction(type=>honeymoon.stats().ponyType===type,type);
      await ground();
      assert.equal((await stat()).body.size,size);
    }
    async function pressSpace(ms=25) {
      if (mobileQa) await down('#jump');
      else await page.keyboard.down('Space');
      try { await page.waitForTimeout(ms); }
      finally { if (mobileQa) await up(); else await page.keyboard.up('Space'); }
    }
    async function sampleApex(ms) {
      await ground();
      await page.evaluate(()=>{
        const floor=honeymoon.stats().position.y;
        globalThis.raceSample=new Promise(resolve=>{
          const begun=performance.now();
          let apex=0;
          function sample(now) {
            const state=honeymoon.stats();
            apex=Math.max(apex,state.position.y-floor);
            if (apex>.1&&state.grounded || now-begun>4600) resolve(apex);
            else requestAnimationFrame(sample);
          }
          requestAnimationFrame(sample);
        });
      });
      await pressSpace(ms);
      return page.evaluate(()=>raceSample);
    }
    const noFlight=async()=>{
      if (mobileQa) assert.equal(await visible('#touch-flight'),false);
      else await page.keyboard.press('KeyF');
      assert.equal((await stat()).flying,false);
    };
    const health=()=>page.evaluate(()=>honeymoon.health());
    const expectHealth=async value=>{
      assert.equal((await health()).maxHealth,value);
      assert.equal((await health()).health,value);
    };
    await ground();
    await expectHealth(15);
    await noFlight();
    const normal=await sampleApex(24);
    const charged=await sampleApex(275);
    assert.ok(normal>1.2 && normal<1.27 && Math.abs(normal+.5-charged)<.06,JSON.stringify({normal,charged}));
    await page.waitForFunction(()=>honeymoon.stats().jumpCharges===1);
    const second=await sampleApex(275);
    assert.ok(Math.abs(second-charged)<.06);
    await page.waitForFunction(()=>honeymoon.stats().jumpCharges===0);
    const empty=await sampleApex(275);
    assert.ok(Math.abs(normal-empty)<.06,JSON.stringify({normal,empty}));
    await page.waitForFunction(()=>honeymoon.stats().jumpCharges===1,undefined,{timeout:8_000});
    await page.waitForFunction(()=>honeymoon.stats().jumpCharges===2,undefined,{timeout:4_000});
    result.checks.push({earth:{normal,charged,second,empty,bothRecharged:true,health:15}});

    await uploadSkin('#88caf0','pegasus','large');
    await expectHealth(10);
    await pressSpace();
    await page.waitForFunction(()=>honeymoon.stats().gliding);
    assert.equal((await stat()).fallSpeed,-1.4);
    await pressSpace();
    await page.waitForFunction(()=>!honeymoon.stats().gliding&&honeymoon.stats().fallSpeed<-2);
    await ground();
    await activate('#touch-flight','KeyF');
    await page.waitForFunction(()=>honeymoon.stats().flying);
    const takeoff=(await stat()).position.y;
    await pressSpace(2200);
    await page.waitForFunction(y=>honeymoon.stats().position.y>y+8,takeoff);
    await activate('#touch-flight','KeyF');
    await page.waitForFunction(()=>!honeymoon.stats().flying&&honeymoon.stats().fallSpeed<-3);
    assert.equal((await stat()).gliding,false);
    await ground();
    await expectHealth(10);
    result.checks.push({pegasus:{health:10,height:'large',glideCanceled:true,fallDamage:0}});

    await uploadSkin('#d19fe4','unicorn','normal');
    await expectHealth(10);
    await noFlight();
    await changeMode('creative');
    await activate('#touch-flight','KeyF');
    await page.waitForFunction(()=>honeymoon.stats().flying);
    await activate('#touch-flight','KeyF');
    await ground();
    if (mobileQa) {await click('#touch-more'); await click('#touch-catalog');}
    else await page.keyboard.press('KeyI');
    await click('#creative-tabs [data-tab="all"]');
    await page.locator('#creative-search').fill('legacy:50:0');
    await click('#creative-grid [data-key="legacy:50:0"]');
    const [given]=await Promise.all([
      page.waitForResponse(response=>response.url().endsWith('/api/action') &&
        response.request().postDataJSON()?.type==='inventory_give'),
      click('#inventory-hotbar [data-slot="0"]'),
    ]);
    assert.equal(given.status(),200,await given.text());
    await click('#creative-close');
    await page.locator('#creative-menu').waitFor({state:'hidden'});
    await activeGame();
    await changeMode('game');
    await activate('#touch-swap-hands','KeyN');
    await page.waitForFunction(()=>honeymoon.localAvatar()?.offhand?.key==='legacy:50:0'&&honeymoon.stats().heldLights.active>=1);
    assert.ok(await visible('#hud-offhand [data-slot="40"]'));
    if (mobileQa) {await click('#touch-more'); await click('#touch-inventory');}
    else await page.keyboard.press('KeyJ');
    await page.locator('#inventory-offhand [data-slot="40"]').waitFor({state:'visible'});
    await click('#creative-close');
    if (await visible('#play')) await click('#play');
    await activeGame();
    await page.evaluate(()=>honeymoon.look(-Math.PI/2,-.22));
    const before=(await stat()).position;
    const [spell]=await Promise.all([
      page.waitForResponse(response=>response.url().endsWith('/api/magic-teleport'),{timeout:15_000}),
      activate('#touch-magic','KeyM'),
    ]);
    assert.equal(spell.status(),200,await spell.text());
    const {position:after,magicCooldownMs}=await spell.json();
    assert.ok(Math.hypot(after.x-before.x,after.z-before.z)>1);
    assert.ok(Math.hypot(after.x-before.x,after.z-before.z)<=50 && Math.abs(after.y-before.y)<=30);
    assert.ok(magicCooldownMs>19_000);
    await page.waitForFunction(()=>honeymoon.stats().magicCooldown>0,undefined,{timeout:4000});
    const repeat=await page.request.post(url+'api/magic-teleport',{data:{yaw:0,pitch:-.3}});
    assert.equal(repeat.status(),409);
    assert.equal((await repeat.json()).error,'magic_cooldown');
    await page.waitForFunction(({x,y,z})=>{
      const at=honeymoon.stats().position;
      return Math.hypot(at.x-x,at.y-y,at.z-z)<.15 && document.getElementById('teleport-loading').hidden;
    },after,{timeout:45_000});
    result.checks.push({unicorn:{health:10,offhandTorch:true,magicDestination:after,cooldown:true}});

    await uploadSkin('#fef9fc','alicorn','normal');
    await expectHealth(15);
    assert.ok(await visible('#hud-offhand [data-slot="40"]'));
    await activate('#touch-flight','KeyF');
    await page.waitForFunction(()=>honeymoon.stats().flying);
    if (mobileQa) await page.evaluate(()=>document.getElementById('game').classList.add('show-metrics'));
    if (mobileQa) for (const [width,height] of [[320,610],[390,730],[667,300],[800,370]]) {
      await page.setViewportSize({width,height});
      const controls=['#jump','#touch-remove','#touch-use','#touch-lower','#touch-sprint','#touch-flight','#touch-magic',
        '#touch-swap-hands','#touch-chat','#stick','#touch-build','#touch-more','#touch-pause','#fullscreen-toggle'];
      const boxes=await Promise.all(controls.map(selector=>page.locator(selector).boundingBox()));
      for (const [index,box] of boxes.entries()) {
        assert.ok(box&&box.width>=44&&box.height>=44&&box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=height, controls[index]);
        for(const [j,other] of boxes.entries()) {
          if (index>=j||!other) continue;
          assert.ok(box.x+box.width<=other.x || other.x+other.width<=box.x || box.y+box.height<=other.y || other.y+other.height<=box.y,
            `${width}×${height}: ${controls[index]} covers ${controls[j]}`);
        }
      }
      for (const selector of controls) {
        assert.ok(await page.locator(selector).evaluate(button=>{
          const {left,top,width,height}=button.getBoundingClientRect();
          const target=document.elementFromPoint(left+width/2,top+height/2);
          return button.contains(target);
        }),`${width}×${height}: ${selector} is reachable by touch`);
      }
      const hud=await page.locator('#health, #connection-metrics, #pony-abilities, #selected:not(:empty)').evaluateAll(elements=>
        elements.map(element=>{
          const {left,right,top,bottom}=element.getBoundingClientRect();
          return {id:element.id,left,right,top,bottom};
        }).filter(box=>box.right>box.left&&box.bottom>box.top));
      for (const [index,box] of hud.entries()) for (const other of hud.slice(index+1)) {
        assert.ok(box.right<=other.left || other.right<=box.left || box.bottom<=other.top || other.bottom<=box.top,
          `${width}×${height}: ${box.id} overlaps ${other.id}`);
      }
      await shot(`races-mobile-${width}`);
    } else await shot('races-desktop');
    result.checks.push({alicorn:{health:15,flight:true,offhand:true,mobileLayouts:mobileQa?4:0}});
  } else if (iphoneQa) {
    await skipPreload();
    await page.addInitScript(()=>{
      Object.defineProperties(document,{fullscreenEnabled:{value:false},webkitFullscreenEnabled:{value:false}});
      Object.defineProperties(navigator,{platform:{value:'iPhone'},userAgent:{value:'Mozilla/5.0 (iPhone) Safari/605.1.15'}});
    });
    await start();
    const fullscreen=page.locator('#touch #fullscreen-toggle');
    const dialog=page.locator('#fullscreen-help');
    for (const [width,height] of [[390,730],[800,370]]) {
      await page.setViewportSize({width,height});
      assert.ok(await fullscreen.isVisible());
      assert.equal(await fullscreen.getAttribute('aria-haspopup'),'dialog');
      await fullscreen.tap();
      await dialog.waitFor({state:'visible'});
      assert.match(await dialog.locator('#fullscreen-help-instructions').textContent(),/Поделиться.*На экран.*веб-приложение/);
      assert.equal(await page.locator('#game').evaluate(game=>game.classList.contains('playing')&&!game.classList.contains('paused')),true);
      await shot('iphone-fullscreen-'+width);
      await dialog.getByRole('button',{name:'Понятно'}).tap();
      await dialog.waitFor({state:'hidden'});
      assert.equal(await fullscreen.evaluate(button=>document.activeElement===button),true);
    }
    result.checks.push({iphoneFullscreenFallback:true});
  } else if (preloadQa) {
    const requests=[];
    app.server.on('request',request=>{
      const address=new URL(request.url,url);
      if (address.pathname==='/api/terrain-preload') requests.push(address.searchParams.get('layer'));
    });
    await start();
    const response=await page.request.get(url+'generated/world/world.json');
    assert.equal(response.status(),200);
    const manifest=await response.json();
    assert.equal(manifest.upperChunksEmpty,true);
    const expected={altitude:4,primitive:manifest.lod.regions.length,vista:manifest.vista.regions.length,
      ...(mobileQa?{}:{simplified:manifest.lod.regions.length})};
    const expectedTotal=Object.values(expected).reduce((total,count)=>total+count,0);
    const readyPreload=()=>page.waitForFunction(()=>honeymoon.stats().terrainPreload?.phase==='ready',
      undefined,{polling:250,timeout:120_000});
    const usage=()=>page.evaluate(async()=>{
      const {terrainCacheUsage}=await import('/terrain-cache.mjs');
      const {worldCheckpointUsage}=await import('/world-checkpoint.mjs');
      return {terrain:await terrainCacheUsage(),edits:await worldCheckpointUsage()};
    });
    const MiB=1024*1024;
    const normalCap=mobileQa?782:2462, lowCap=mobileQa?300:512;
    await readyPreload();
    const preload=(await stat()).terrainPreload;
    assert.equal(preload.loaded,expectedTotal);
    const cold=await usage();
    for (const [layer,count] of Object.entries(expected)) assert.equal(cold.terrain.buckets[layer].entries,count,layer);
    assert.equal(cold.terrain.buckets.detailed.maxBytes,(mobileQa?512:2048)*MiB);
    assert.equal(cold.terrain.buckets.simplified.maxBytes,(mobileQa?80:224)*MiB);
    assert.equal(cold.edits.maxBytes,64*MiB);
    assert.ok(requests.includes('primitive')&&requests.includes('vista'));
    assert.equal(requests.includes('simplified'),!mobileQa);
    const firstRequestCount=requests.length;
    await page.goto('about:blank');
    await start(false);
    await readyPreload();
    assert.equal(requests.length,firstRequestCount,'a repeat visit reuses the prefetched layers');
    if (mobileQa) {
      await page.evaluate(async version=>{
        const {storePrefetchedTerrain}=await import('/terrain-cache.mjs');
        const tile=new Blob([new Uint8Array(45*1024*1024)]);
        for (const n of [7000,7001]) {
          if (!await storePrefetchedTerrain(`/generated/world/chunks/${version}/${n}.${n}.json`,tile)) {
            throw new Error('Could not seed the detailed cache');
          }
        }
      },manifest.chunkCacheVersion);
      assert.ok((await usage()).terrain.buckets.detailed.bytes>=90*MiB);
      await page.locator('#touch-pause').tap();
    } else {
      await page.waitForFunction(()=>Boolean(document.pointerLockElement));
      await page.keyboard.press('Escape');
    }
    await pauseSection('settings');
    const output=page.locator('#game-cache-usage');
    await output.waitFor({state:'visible'});
    const expectLimit=limit=>page.waitForFunction(limit=>
      document.getElementById('game-cache-usage').textContent.replace(/\s+/g,'').includes(`из${limit}МиБ`),limit);
    await expectLimit(normalCap);
    await click('#low-device');
    await expectLimit(lowCap);
    const pruned=await usage();
    assert.equal(pruned.terrain.maxBytes+pruned.edits.maxBytes,lowCap*MiB);
    assert.ok(pruned.terrain.bytes+pruned.edits.bytes<=lowCap*MiB);
    assert.ok(pruned.terrain.buckets.detailed.bytes<=(mobileQa?76:226)*MiB);
    for (const layer of ['altitude','primitive','vista']) assert.equal(pruned.terrain.buckets[layer].entries,expected[layer]);
    await shot('terrain-cache-limit');
    await click('#low-device');
    await expectLimit(normalCap);
    const restored=await usage();
    assert.equal(restored.terrain.maxBytes+restored.edits.maxBytes,normalCap*MiB);
    result.checks.push({preload,requests:firstRequestCount,hadWarmCache:true,normalCap,lowCap,cold,pruned,restored});
  } else if (test==='upper-with-cache') {
    await skipPreload();
    const owner=await page.request.post(url+'api/access/owner',{data:{key:ownerKey,profileName:'Проверка верхних чанков'}});
    assert.equal(owner.status(),200,await owner.text());
    const {playerId}=await owner.json();
    const upperRequests=[];
    page.on('request',request=>{
      if (new URL(request.url()).searchParams.get('height')==='upper') upperRequests.push(request.url());
    });
    const marker={x:-1101,y:329,z:-501,cell:'legacy:1:0',object:null};
    app.game.worldEdit.write(playerId,[marker]);
    await start(false);
    await page.keyboard.press('KeyF');
    await page.waitForFunction(()=>honeymoon.stats().flying);
    await hop(-1100.5,340,-500.5);
    await page.waitForFunction(({x,y,z,cell})=>honeymoon.stats().overviewVisible&&honeymoon.getCell(x,y,z)===cell,
      marker,{timeout:30000});
    assert.deepEqual(upperRequests,[]);
    result.checks.push({marker,upperRequests:upperRequests.length,overviewVisible:true});
    await shot('upper-with-cache');
  } else if (touchGameplayQa) {
    await skipPreload();
    const owner=await page.request.post(url+'api/access/owner',{data:{key:ownerKey,profileName:'Сенсорное управление'}});
    assert.equal(owner.status(),200,await owner.text());
    const {playerId}=await owner.json();
    const y=73, z=1467;
    app.game.worldEdit.write(playerId,[
      {x:3361,y,z,cell:null,object:null},
      {x:3362,y,z,cell:'legacy:1:0',object:null},
      {x:3359,y,z,cell:'legacy:54:3',object:{key:`tile:3359:${y}:${z}`,type:'Chest',position:[3359,y,z],data:{Items:[]}}},
    ]);
    await start(false);
    await hop(3360.5,72,1467.51);
    const touch=await page.context().newCDPSession(page);
    const point={x:194,y:304,id:1};
    const touchEvent=(type,...touchPoints)=>touch.send('Input.dispatchTouchEvent',{type,touchPoints});
    const tap=async()=>{
      await touchEvent('touchStart',point);
      await touchEvent('touchEnd');
    };
    const aim=async (x,yaw)=>{
      await page.evaluate(yaw=>honeymoon.look(yaw,0),yaw);
      await page.waitForFunction(([x,y,z])=>{
        const target=honeymoon.target();
        return target?.x===x && target.y===y && target.z===z;
      },[x,y,z]);
    };
    const expectCell=(x,cell)=>page.waitForFunction(([x,y,z,cell])=>{
      const value=honeymoon.getCell(x,y,z);
      return (typeof value==='string'?value:value?.key??null)===cell;
    },[x,y,z,cell],{timeout:10000});
    async function edit(type,input) {
      const [response]=await Promise.all([
        page.waitForResponse(response=>new URL(response.url()).pathname==='/api/action' &&
          response.request().postDataJSON()?.type===type,{timeout:10000}),
        input(),
      ]);
      assert.equal(response.status(),200,await response.text());
      return {request:response.request().postDataJSON(),reply:await response.json()};
    }
    const actions=[];
    page.on('request',request=>{
      if (new URL(request.url()).pathname!=='/api/action') return;
      const {type}=request.postDataJSON();
      if (['container_open','copy','place','remove'].includes(type)) actions.push(type);
    });
    // Empty hands use the block, while the explicit palm button works even with a block selected.
    await aim(3359,Math.PI/2);
    await tap();
    await page.locator('#container-menu').waitFor({state:'visible'});
    await page.locator('#container-close').tap();
    await page.locator('#container-menu').waitFor({state:'hidden'});
    await aim(3362,-Math.PI/2);
    await page.keyboard.press('KeyO');
    await page.waitForFunction(()=>document.getElementById('toast')?.textContent.includes('Скопировано'));
    const beforeSlide=actions.length;
    await touchEvent('touchStart',point);
    await touchEvent('touchMove',{...point,x:point.x+34});
    await touchEvent('touchMove',point);
    await touchEvent('touchEnd');
    await page.waitForTimeout(250);
    assert.equal(actions.length,beforeSlide,'a drag that returns to its initial position does not act');
    await expectCell(3361,null);
    await aim(3362,-Math.PI/2);
    const placed=await edit('place',tap);
    assert.deepEqual(placed.reply.changes?.map(({x,y,z,cell})=>({x,y,z,cell})),
      [{x:3361,y,z,cell:'legacy:1:0'}],JSON.stringify(placed));
    await expectCell(3361,'legacy:1:0');
    await aim(3361,-Math.PI/2);
    await edit('remove',()=>page.locator('#touch-remove').tap());
    await expectCell(3361,null);
    await aim(3359,Math.PI/2);
    await page.locator('#touch-use').tap();
    await page.locator('#container-menu').waitFor({state:'visible'});
    await page.locator('#container-close').tap();
    await page.locator('#container-menu').waitFor({state:'hidden'});
    assert.deepEqual(actions,['container_open','copy','place','remove','container_open']);
    for (const [width,height] of [[390,730],[800,370]]) {
      await page.setViewportSize({width,height});
      const ids=['jump','touch-lower','touch-sprint','touch-flight','touch-use','touch-remove'];
      const buttons=await page.locator(ids.map(id=>'#'+id).join(',')).evaluateAll(buttons=>buttons.map(button=>{
        const {top,bottom,left,right,width,height}=button.getBoundingClientRect();
        return {label:button.getAttribute('aria-label'),top,bottom,left,right,width,height};
      }));
      assert.equal(buttons.length,ids.length);
      assert.ok(buttons.every(button=>button.label&&button.top>height/2&&button.left>width/2&&
        button.right<=width&&button.bottom<=height&&button.width>=44&&button.height>=44));
      const sprint=page.locator('#touch-sprint');
      const flight=page.locator('#touch-flight');
      await sprint.tap();
      assert.equal(await sprint.getAttribute('aria-pressed'),'true');
      await sprint.tap();
      assert.equal(await sprint.getAttribute('aria-pressed'),'false');
      await flight.tap();
      await page.waitForFunction(()=>honeymoon.stats().flying);
      await shot('touch-gameplay-'+width);
      await flight.tap();
      await page.waitForFunction(()=>!honeymoon.stats().flying);
    }
    result.checks.push({noActionOnSwipe:true,actions,orientationChecks:2,sprintAndFlight:true});
  } else if (pauseQa) {
    await skipPreload();
    await start();
    for (const [width,height] of mobileQa?[[390,730],[800,370],[667,300]]:[[1200,750]]) {
      await page.setViewportSize({width,height});
      if (mobileQa) await page.locator('#touch-pause').tap();
      else {
        await page.waitForFunction(()=>Boolean(document.pointerLockElement));
        await page.keyboard.press('Escape');
      }
      const resume=page.locator('#play');
      await resume.waitFor({state:'visible'});
      const resumeBox=await resume.boundingBox();
      assert.ok(resumeBox.x>=0&&resumeBox.y>=0&&resumeBox.y+resumeBox.height<=height);
      await shot('pause-home-'+width);
      if (mobileQa) await pauseSection('settings');
      else await page.locator('[data-pause-section="settings"]').press('Enter');
      const cacheUsage=page.locator('#game-cache-usage');
      await cacheUsage.waitFor({state:'visible'});
      assert.ok(await cacheUsage.evaluate(output=>{
        const full=output.getBoundingClientRect();
        const scroll=output.closest('.pause-content').getBoundingClientRect();
        return full.top>=scroll.top && full.bottom<=scroll.bottom;
      }),`the cache counter fits in the initial settings view at ${width}×${height}`);
      assert.equal(await visible('#detail-distance'),true);
      assert.equal(await visible('#audio-mute-toggle'),false);
      await shot('pause-graphics-'+width);
      if (mobileQa) await pauseTab('audio');
      else await page.locator('[data-pause-tab="graphics"]').press('ArrowRight');
      assert.equal(await visible('#audio-mute-toggle'),true);
      assert.equal(await visible('#detail-distance'),false);
      await pauseTab('controls');
      const guide=page.locator('#keys');
      assert.equal(await guide.evaluate(panel=>panel.open),false);
      await click('#keys > summary');
      assert.equal(await guide.evaluate(panel=>panel.open),true);
      await shot('pause-controls-'+width);
      await click('#keys > summary');
      if (mobileQa) await click('#pause-back');
      else await page.keyboard.press('Escape');
      await page.locator('[data-pause-section="settings"]').waitFor({state:'visible'});
      await resume.click();
      await page.waitForFunction(()=>document.getElementById('game').classList.contains('playing'));
      result.checks.push({width,height,resumeVisible:true,graphicsAudioAndControls:true});
    }
  } else if (controlsQa) {
    await start();
    if (mobileQa) {
      const fullscreen=page.locator('#touch #fullscreen-toggle');
      const crouch=page.locator('#touch-lower');
      for (const [width,height] of [[390,730],[800,370]]) {
        await page.setViewportSize({width,height});
        assert.ok(await fullscreen.isVisible());
        await fullscreen.tap();
        await page.waitForFunction(()=>Boolean(document.fullscreenElement));
        await fullscreen.tap();
        await page.waitForFunction(()=>!document.fullscreenElement);
        await crouch.tap();
        await page.waitForFunction(()=>honeymoon.stats().stance==='crouch');
        await page.waitForTimeout(300);
        assert.equal((await stat()).stance,'crouch');
        assert.equal(await crouch.getAttribute('aria-pressed'),'true');
        await crouch.tap();
        await page.waitForFunction(()=>honeymoon.stats().stance==='stand');
        assert.equal(await crouch.getAttribute('aria-pressed'),'false');
      }
      await page.locator('#touch-pause').tap();
    } else {
      await page.waitForFunction(()=>Boolean(document.pointerLockElement));
      await page.keyboard.press('Escape');
      await page.locator('#play').waitFor({state:'visible'});
    }
    await pauseSection('settings');
    await pauseTab('audio');
    const quickMute=page.locator('#audio-mute-toggle');
    assert.ok(await quickMute.isVisible());
    assert.equal(await quickMute.evaluate(button=>button.previousElementSibling?.id),'audio-settings-toggle');
    await quickMute.click();
    await page.waitForFunction(()=>honeymoon.stats().audio.muted);
    assert.equal(await quickMute.getAttribute('aria-pressed'),'true');
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('honeymoon-audio-settings')).muted),true);
    await click('#audio-settings-toggle');
    assert.equal(await page.locator('#audio-master').getAttribute('aria-pressed'),'false');
    await click('#audio-master');
    await page.waitForFunction(()=>!honeymoon.stats().audio.muted);
    assert.equal(await quickMute.getAttribute('aria-pressed'),'false');
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('honeymoon-audio-settings')).muted),false);
    result.checks.push({mobile:mobileQa,mutedAndRestored:true});
  } else if (lavaQa) {
    const owner=await page.request.post(url+'api/access/owner',{data:{key:ownerKey,profileName:'Проверка лавы'}});
    assert.equal(owner.status(),200,await owner.text());
    const {playerId,spawn}=await owner.json();
    const lake={x:3360,y:72,z:1467,cell:'legacy:11:0',object:null};
    app.game.worldEdit.write(playerId,[lake]);
    await start(false);
    await hop(3359.4,72,1467.5);
    await page.waitForFunction(()=>Boolean(document.pointerLockElement));
    await page.evaluate(()=>honeymoon.look(-Math.PI/2,0));
    app.game.damageFromNpc(playerId,13);
    await page.waitForFunction(()=>honeymoon.health().health===2);
    await page.evaluate(()=>{
      const health=document.getElementById('health');
      globalThis.qaLavaHealth=[];
      globalThis.qaLavaPhases=new Set();
      globalThis.qaLavaParticles=0;
      new MutationObserver(()=>{
        const value=Number(health.getAttribute('aria-valuenow'));
        if (qaLavaHealth.at(-1)?.value!==value) qaLavaHealth.push({value,at:performance.now()});
      }).observe(health,{attributes:true,attributeFilter:['aria-valuenow']});
      const observeEffect=()=>{
        const phase=honeymoon.localAvatar()?.lavaDeath;
        if (phase) qaLavaPhases.add(phase);
        qaLavaParticles=Math.max(qaLavaParticles,honeymoon.stats().lavaDeathParticles);
        if (!qaLavaPhases.has('ash') || !qaLavaParticles) requestAnimationFrame(observeEffect);
      };
      requestAnimationFrame(observeEffect);
    });
    const ashScreenshot=page.waitForFunction(()=>honeymoon.stats().lavaDeathParticles>0,undefined,{timeout:16000})
      .then(()=>shot('lava-death'));
    await page.keyboard.down('KeyW');
    try {await page.waitForFunction(()=>honeymoon.stats().position.x>3360.22);}
    finally {await page.keyboard.up('KeyW');}
    await ashScreenshot;
    await page.waitForFunction(()=>honeymoon.health().death?.cause==='lava',undefined,{timeout:9000});
    assert.equal(await page.locator('#death-title').textContent(),'Сгорел');
    const health=await page.evaluate(()=>qaLavaHealth.filter(({value})=>value<=1));
    assert.deepEqual(health.map(({value})=>value),[1,0]);
    const interval=health[1].at-health[0].at;
    assert.ok(interval>=750 && interval<=1500,`lava damage interval ${interval} ms`);
    await page.waitForFunction(()=>document.getElementById('chat-log').textContent.includes('Сгорел'));
    assert.deepEqual(await page.evaluate(()=>[...qaLavaPhases]),['charred','ash']);
    const particles=await page.evaluate(()=>qaLavaParticles);
    assert.ok(particles>0);
    await page.waitForFunction(()=>!document.pointerLockElement);
    const [revive]=await Promise.all([
      page.waitForResponse(response=>response.url().endsWith('/api/respawn')&&response.ok()),
      click('#revive'),
    ]);
    const respawn=await revive.json();
    assert.deepEqual(respawn.position,{x:spawn[0],y:spawn[1],z:spawn[2]});
    await page.waitForFunction(()=>honeymoon.health().health===15&&!honeymoon.health().death&&
      !honeymoon.localAvatar()?.lavaDeath&&!honeymoon.stats().lavaDeathParticles&&
      document.getElementById('teleport-loading').hidden,undefined,{timeout:20000});
    assert.equal(await visible('#death-screen'),false);
    result.checks.push({interval,particles,respawn:respawn.position});
  } else if (onlineCacheQa) {
    await skipPreload();
    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
    const owner=await page.request.post(url+'api/access/owner',{data:{key:ownerKey,profileName:'Проверка кэша'}});
    assert.equal(owner.status(),200,await owner.text());
    const {playerId,spawn}=await owner.json();
    const x=Math.floor(spawn[0]), y=Math.floor(spawn[1])+6, z=Math.floor(spawn[2]);
    const unchanged={x,y,z,cell:'legacy:1:0',object:null};
    const removed={...unchanged,y:y+1};
    const firstRevision=app.game.worldEdit.write(playerId,[unchanged,removed]).worldRevision;
    const chunkRequests=[];
    page.on('request',request=>{
      const path=new URL(request.url()).pathname;
      if (path.startsWith('/generated/world/chunks/')) chunkRequests.push(path);
    });
    const snapshotResponse=()=>page.waitForResponse(response=>{
      const address=new URL(response.url());
      return address.pathname==='/api/world' && address.searchParams.get('delta')==='1';
    },{timeout:45000});
    async function openWorld() {
      const snapshot=snapshotResponse();
      await page.goto(url,{waitUntil:'domcontentloaded'});
      const response=await snapshot;
      assert.equal(response.status(),200);
      await ready();
      return {request:new URL(response.url()),body:await response.json()};
    }
    const cold=await openWorld();
    assert.equal((await page.request.get(url+'api/build').then(response=>response.json())).build,expectedBuild);
    assert.equal(cold.request.searchParams.has('since'),false);
    assert.equal(cold.body.complete,true);
    assert.equal(cold.body.worldRevision,firstRevision);
    assert.equal(cold.body.edits.length,2);
    const currentChunk=`/${x>>4}.${z>>4}.json`;
    assert.ok(chunkRequests.some(path=>path.endsWith(currentChunk)),'cold load requests the spawn chunk');
    const chunkPaths=[...new Set(chunkRequests)].filter(path=>{
      const [,cx,cz]=/\/(-?\d+)\.(-?\d+)\.json$/.exec(path)??[];
      return Math.max(Math.abs(Number(cx)-(x>>4)),Math.abs(Number(cz)-(z>>4)))<=2;
    });
    await page.waitForFunction(async({paths,revision})=>{
      const read=(name, method)=>new Promise(resolve=>{
        const open=indexedDB.open(name);
        open.onerror=()=>resolve(null);
        open.onsuccess=()=>{
          const db=open.result;
          if (!db.objectStoreNames.contains('entries')) {db.close();resolve(null);return;}
          const store=db.transaction('entries').objectStore('entries');
          const get=store[method]();
          get.onsuccess=()=>resolve(get.result);
          get.onerror=()=>resolve(null);
          db.close();
        };
      });
      const terrain=new Set(await read('honeymoon-terrain-v1','getAllKeys'));
      if (!paths.every(path=>terrain.has(path))) return false;
      const saved=(await read('honeymoon-world-checkpoints-v1','getAll'))?.[0];
      return saved && JSON.parse(await saved.blob.text()).revision===revision;
    },{paths:chunkPaths,revision:firstRevision},{timeout:12000});

    // Close the document before editing, so the warm page gets the edit from its delta.
    await page.goto('about:blank');
    chunkRequests.length=0;
    const secondRevision=app.game.worldEdit.write(playerId,[{...removed,cell:null}]).worldRevision;
    const warm=await openWorld();
    assert.equal(warm.request.searchParams.get('since'),String(firstRevision));
    assert.equal(warm.request.searchParams.get('epoch'),cold.body.epoch);
    assert.equal(warm.body.complete,false);
    assert.equal(warm.body.worldRevision,secondRevision);
    assert.deepEqual(warm.body.edits.map(({x,y,z,cell})=>({x,y,z,cell})),[{x,y:y+1,z,cell:null}]);
    const visibleCells=await page.evaluate(({x,y,z})=>[honeymoon.getCell(x,y,z),honeymoon.getCell(x,y+1,z)],unchanged);
    assert.deepEqual(visibleCells,['legacy:1:0',null]);
    assert.ok(chunkRequests.every(path=>!chunkPaths.includes(path)),'warm load reuses previously loaded chunks near spawn');
    const empty=await page.request.get(url+`api/world?delta=1&since=${secondRevision}&epoch=${warm.body.epoch}`);
    assert.equal(empty.status(),200);
    assert.deepEqual((await empty.json()).edits,[]);
    const downloadedWarmChunks=chunkRequests.length;
    const spawnPath=chunkPaths.find(path=>path.endsWith(currentChunk));
    const recoveredChunk=await page.evaluate(async path=>{
      const {readTerrain,storePrefetchedTerrain}=await import('/terrain-cache.mjs');
      if (!await storePrefetchedTerrain(path,new Blob(['corrupt']))) throw new Error('Could not write the cache fixture');
      return readTerrain(path,{},true,response=>response.json());
    },spawnPath);
    assert.deepEqual([recoveredChunk.x,recoveredChunk.z],[x>>4,z>>4]);
    assert.ok(chunkRequests.slice(downloadedWarmChunks).includes(spawnPath),'damaged data is downloaded again');
    const validated=[];
    for (const asset of ['generated/textures/atlas.png','generated/world/world.json']) {
      const initial=await page.request.get(url+asset);
      const etag=initial.headers().etag;
      assert.ok(etag);
      const confirmed=await page.request.get(url+asset,{headers:{'If-None-Match':etag}});
      assert.equal(confirmed.status(),304);
      assert.equal((await confirmed.body()).length,0);
      validated.push(asset);
    }

    const eviction=await page.evaluate(async()=>{
      const {createPersistentCache}=await import('/persistent-cache.mjs');
      const sizeBound=createPersistentCache({name:'qa-cache-size',maxBytes:8,maxEntries:3,maxAgeMs:60000});
      const fourBytes=new Blob(['1234']);
      const writes=[await sizeBound.put('a',fourBytes),await sizeBound.put('b',fourBytes)];
      await new Promise(resolve=>setTimeout(resolve,10));
      await sizeBound.get('a');
      writes.push(await sizeBound.put('c',fourBytes));
      const smallestExpired=createPersistentCache({name:'qa-cache-age',maxBytes:8,maxEntries:3,maxAgeMs:1});
      writes.push(await smallestExpired.put('stale',fourBytes));
      await new Promise(resolve=>setTimeout(resolve,10));
      await smallestExpired.prune();
      return {writes,retained:await Promise.all(['a','b','c'].map(async key=>Boolean(await sizeBound.get(key)))),
        expiredAbsent:!(await smallestExpired.get('stale'))};
    });
    assert.deepEqual(eviction,{writes:[true,true,true,true],retained:[true,false,true],expiredAbsent:true});
    result.checks.push({coldEdits:cold.body.edits.length,warmEdits:warm.body.edits.length,firstRevision,secondRevision,
      cachedColdChunks:chunkPaths.length,downloadedWarmChunks,recoveredChunk:[recoveredChunk.x,recoveredChunk.z],validated,eviction});
  } else if (test==='hold-attack') {
    const y=73, z=1467;
    const blocks=Array.from({length:6},(_,i)=>3361+i).concat([3357,3358,3359]);
    const owner=await page.request.post(url+'api/access/owner',{data:{key:ownerKey,profileName:'Проверка удержания ЛКМ'}});
    assert.equal(owner.status(),200,await owner.text());
    const {playerId}=await owner.json();
    app.game.worldEdit.write(playerId,blocks.map(x=>({x,y,z,cell:'legacy:1:0',object:null})));
    await start(false);
    await hop(3360.5,72,1467.51);
    await page.waitForFunction(()=>Boolean(document.pointerLockElement));
    await page.mouse.move(500,320);
    const aim=async (x,yaw)=>{
      await page.evaluate(yaw=>honeymoon.look(yaw,0),yaw);
      await page.waitForFunction(([x,y,z])=>{
        const target=honeymoon.target();
        return target?.x===x && target.y===y && target.z===z;
      },[x,y,z]);
    };
    const removed=x=>page.waitForFunction(([x,y,z])=>!honeymoon.getCell(x,y,z),[x,y,z],{timeout:10000});
    await aim(3361,-Math.PI/2);
    await page.evaluate(()=>{
      performance.clearResourceTimings();
      performance.setResourceTimingBufferSize(2000);
      globalThis.qaAttackInput=[];
      for (const type of ['mousedown','mouseup']) document.addEventListener(type,event=>{
        if (event.button===0) qaAttackInput.push({type,at:performance.now()});
      },true);
    });
    const timing=()=>page.evaluate(()=>({
      presses:qaAttackInput.filter(event=>event.type==='mousedown').map(event=>event.at),
      releases:qaAttackInput.filter(event=>event.type==='mouseup').map(event=>event.at),
      hits:performance.getEntriesByName(location.origin+'/api/action').map(entry=>entry.startTime)
        .filter(start=>start>=qaAttackInput[0].at),
    }));

    await page.mouse.click(500,320);
    await removed(3361);
    await page.waitForTimeout(400);
    assert.equal((await timing()).hits.length,1,'a short click sends exactly one attack');

    await page.mouse.down();
    try {
      await removed(3364);
    } finally {
      await page.mouse.up();
    }
    await aim(3359,Math.PI/2);
    await page.waitForTimeout(400);
    const {presses,releases,hits}=await timing();
    const [first,repeat]=hits.slice(1);
    assert.ok(first-presses[1]<300,'the first held attack starts without the 300 ms delay');
    assert.ok(repeat-presses[1]>=299,'the first repeat waits for the 300 ms hold');
    assert.ok(hits.length>=4,'holding breaks at least three blocks after the initial click');
    assert.ok(hits.every(time=>time<=releases[1]),'releasing stops attacks even when another block is targeted');
    const repeatIntervalsMs=hits.slice(3).map((time,index)=>time-hits[index+2]);
    result.checks.push({shortClickHits:1,heldHits:hits.length-1,firstHitMs:first-presses[1],
      firstRepeatMs:repeat-presses[1],repeatIntervalsMs});
    await shot('hold-attack');
  } else if (test==='copy-corner') {
    await start();
    await hop(3360.5,72,1467.51);
    await page.waitForFunction(()=>Boolean(document.pointerLockElement));
    const selected=page.locator('#hotbar [aria-pressed="true"]');
    const slot=await selected.getAttribute('data-slot');
    assert.match(await selected.getAttribute('aria-label'),/Пусто/);
    const eye=playerBody('normal','stand').eye;
    async function aim(x,y,z) {
      await page.evaluate(([x,y,z,eye])=>{
        const from=honeymoon.stats().position;
        const dx=x-from.x, dy=y-from.y-eye, dz=z-from.z;
        honeymoon.look(Math.atan2(-dx,-dz),Math.atan2(dy,Math.hypot(dx,dz)));
      },[x,y,z,eye]);
    }
    async function edit(type,input) {
      const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/action' &&
        response.request().postDataJSON()?.type===type, {timeout:10000});
      await input();
      const reply=await response;
      assert.equal(reply.status(),200,await reply.text());
      return reply.json();
    }
    const target=[3362,72,1467];
    await aim(3362.5,72.25,1467.75);
    await page.waitForFunction(()=>honeymoon.target()?.partSlot===9);
    const copied=await edit('copy_part',()=>page.keyboard.press('KeyO'));
    assert.deepEqual(copied.part,{slot:9,shape:2,material:3});
    assert.equal(String(copied.inventory.selected),slot);
    await page.waitForFunction(()=>document.querySelector('#hotbar [aria-pressed="true"] canvas'));
    await shot('copy-corner-selected');
    await edit('remove_part',()=>page.mouse.click(500,320));
    await page.waitForFunction(([x,y,z])=>!honeymoon.getCell(x,y,z)?.parts.some(part=>part.slot===9),target);
    await aim(3363,72.25,1467.75);
    await page.waitForFunction(([x,y,z])=>{
      const next=honeymoon.placement();
      return next?.x===x && next.y===y && next.z===z && !next.blocked;
    },target);
    const placed=await edit('place_part',()=>page.mouse.click(500,320,{button:'right'}));
    await page.waitForFunction(([x,y,z])=>honeymoon.getCell(x,y,z)?.parts.length===2,target);
    assert.ok(placed.changes.some(change=>change.parts?.some(part=>part.sourceSlot===9 && part.material===3)));
    result.checks.push({target,slot:Number(slot),part:copied.part});
    await shot('copy-corner-placed');
  } else if (test==='mobile') {
    let seeded=false;
    await page.route('**/api/session',async route=>{
      const response=await route.fetch();
      const body=await response.json();
      if (!seeded && body.access?.uid) {
        function act(type,fields) {
          const result=app.game.action(body.access.uid,{requestId:'qa-seed-'+type+'-'+fields.slot,type,...fields});
          assert.equal(result.status,200,JSON.stringify(result));
          return result.output.inventory;
        }
        const draft=act('inventory_give',{slot:4,key:'creative:386:0'}).slots[4];
        const book=act('inventory_book_page',{slot:4,expected:stackRevision(draft),page:0,text:'Проверка книги'}).slots[4];
        act('inventory_book_sign',{slot:4,expected:stackRevision(book),title:'Записка'});
        body.inventory=act('inventory_give',{slot:5,key:'creative:323:0'});
        seeded=true;
      }
      await route.fulfill({response,json:body});
    });
    await start();
    for (const [id,width,height] of [['portrait',390,730],['landscape',800,370]]) {
      await page.setViewportSize({width,height});
      assert.equal(await visible('#stick'),true);
      assert.equal(await visible('#fullscreen-toggle'),true);
      const native=await page.locator('#scene').evaluate(element=>getComputedStyle(element).userSelect);
      assert.equal(native,'none');
      await click('#fullscreen-toggle');
      await page.waitForFunction(()=>Boolean(document.fullscreenElement));
      await click('#fullscreen-toggle');
      await page.waitForFunction(()=>!document.fullscreenElement);
      await click('#touch-build');
      assert.equal(await visible('#touch-place'),true);
      await click('#touch-build');
      await click('#touch-pause');
      assert.equal(await visible('#play'),true);
      await shot('pause-'+id);
      await pauseSection('settings');
      await pauseTab('controls');
      const controls=page.locator('#keys');
      assert.equal(await controls.evaluate(panel=>panel.open),false);
      await click('#keys > summary');
      assert.equal(await controls.evaluate(panel=>panel.open),true);
      assert.equal(await controls.getByRole('heading',{name:'На экране'}).isVisible(),true);
      await shot('controls-'+id);
      await click('#keys > summary');
      await click('#pause-back');
      await click('#inventory-toggle');
      const dimensions=await page.locator('#creative-close').boundingBox();
      assert.ok(dimensions.width>=44 && dimensions.height>=44,JSON.stringify(dimensions));
      assert.equal(await visible('#inventory-edit'),false);
      await page.waitForFunction(()=>[4,5].every(slot=>{
        const icon=document.querySelector(`#creative-menu [data-slot="${slot}"] canvas`);
        if (!icon) return false;
        const pixels=icon.getContext('2d').getImageData(0,0,32,32).data;
        return pixels.some((value,index)=>index%4===3 && value>0);
      }),undefined,{timeout:10_000});
      assert.match(await page.locator('#creative-menu [data-slot="4"]').getAttribute('title'),/Записка/);
      await shot('inventory-'+id);
      await click('#creative-close');
      if (await visible('#play')) await click('#play');
      await click('#touch-chat');
      await click('#chat-input');
      await page.locator('#chat-input').fill('Тест черновика');
      await click('#chat-channel');
      assert.equal(await page.locator('#chat-input').inputValue(),'Тест черновика');
      await shot('chat-'+id);
      await click('#chat-close');
      if (await visible('#play')) await click('#play');
      result.checks.push({orientation:id,inventoryClose:dimensions});
    }
  } else if (test==='flight-return') {
    await start();
    assert.equal((await stat()).flying,false);
    await page.keyboard.press('KeyF');
    await page.waitForFunction(()=>honeymoon.stats().flying);
    await hop(-8,300,-19);
    const before=(await stat()).position;
    await page.reload({waitUntil:'domcontentloaded'});
    await ready();
    const restored=await stat();
    assert.equal(restored.flying,true);
    assert.ok(Math.abs(restored.position.y-before.y)<1);
    await click('#play');
    await page.waitForFunction(()=>!document.getElementById('chat-toggle').disabled);
    await page.waitForTimeout(700);
    assert.ok(Math.abs((await stat()).position.y-before.y)<1);
    await hop(-8,66,-19);
    await page.keyboard.press('KeyF');
    await page.waitForFunction(()=>!honeymoon.stats().flying);
    await page.reload({waitUntil:'domcontentloaded'});
    await ready();
    assert.equal((await stat()).flying,false);
    result.checks.push({restoredFlight:true,heldHeight:before.y,restoredWalking:true});
  } else if (test==='jump-types') {
    await start();
    async function sampleJump() {
      await page.waitForFunction(()=>honeymoon.stats().movementSync.status==='ready');
      await page.evaluate(()=>{
        globalThis.jumpSample=new Promise(resolve=>{
          const floor=honeymoon.stats().position.y;
          const beginning=performance.now();
          let startTime,apexTime,apex=0;
          function sample(now) {
            const height=honeymoon.stats().position.y-floor;
            if (height>.02) startTime??=now;
            if (height>apex) {
              apex=height;
              apexTime=now;
            }
            if (startTime && height<.02 || now-beginning>4500) resolve({apex,ms:startTime && now-startTime,descentMs:apexTime && now-apexTime});
            else requestAnimationFrame(sample);
          }
          requestAnimationFrame(sample);
        });
      });
      await page.keyboard.press('Space');
      return page.evaluate(()=>jumpSample);
    }
    const earth=await sampleJump();
    assert.ok(earth.apex>1.18 && earth.apex<1.28,JSON.stringify(earth));
    const skin=await page.evaluate(()=>{
      const canvas=new OffscreenCanvas(64,64);
      const context=canvas.getContext('2d');
      context.fillStyle='#dc9262';
      context.fillRect(0,0,64,64);
      context.fillStyle='#88caf0';
      context.fillRect(0,0,1,1);
      return canvas.convertToBlob({type:'image/png'}).then(blob=>new Promise(resolve=>{
        const reader=new FileReader();
        reader.onload=()=>resolve(reader.result.split(',')[1]);
        reader.readAsDataURL(blob);
      }));
    });
    const update=await page.request.post(url+'api/profile',{data:{skin}});
    assert.equal(update.status(),200,await update.text());
    assert.equal((await update.json()).ponyType,'pegasus');
    await page.reload({waitUntil:'domcontentloaded'});
    await ready();
    await click('#play');
    await page.waitForFunction(()=>!document.getElementById('chat-toggle').disabled);
    const pegasus=await sampleJump();
    assert.ok(pegasus.apex>1.18 && pegasus.apex<1.28,JSON.stringify(pegasus));
    assert.ok(Math.abs(pegasus.apex-earth.apex)<.07,JSON.stringify({earth,pegasus}));
    assert.ok(pegasus.descentMs>earth.descentMs+50,JSON.stringify({earth,pegasus}));
    result.checks.push({earth,pegasus});
  } else if (test==='overview-boundary') {
    await start();
    await page.keyboard.press('KeyF');
    await page.waitForFunction(()=>honeymoon.stats().flying);
    await hop(-7.42,494.66,-2281.87);
    await page.waitForFunction(()=>honeymoon.stats().overviewVisible,undefined,{timeout:25000});
    await page.evaluate(async()=>{
      honeymoon.look(Math.PI,-.55);
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    });
    await shot('overview-boundary');
    result.checks.push({overviewVisible:true,position:(await stat()).position});
  } else if (test==='altitude-registration') {
    await page.route('**/game.mjs',async route=>{
      const response=await route.fetch();
      const source=await response.text();
      const marker='globalThis.honeymoon = Object.freeze({';
      assert.ok(source.includes(marker));
      const probe=`qaOverview:()=>{
        const overview=view.altitudeOverview, mesh=overview?.mesh;
        return {imageWidth:mesh?.material.map.image.width,imageHeight:mesh?.material.map.image.height,
          detail:Boolean(mesh?.material.onBeforeCompile.toString().includes('altitudeDetail')),
          landmarks:Object.fromEntries(overview?.landmarks?.children.map(mesh=>[mesh.name,mesh.count])??[])};
      },qaZoom:zoom=>{view.camera.zoom=zoom;view.camera.updateProjectionMatrix();},`;
      await route.fulfill({response,body:source.replace(marker,marker+probe)});
    });
    await start();
    await page.keyboard.press('KeyF');
    await page.waitForFunction(()=>honeymoon.stats().flying);
    async function look(yaw,pitch,zoom=1) {
      await page.evaluate(async ({yaw,pitch,zoom})=>{
        honeymoon.qaZoom(zoom);
        honeymoon.look(yaw,pitch);
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      },{yaw,pitch,zoom});
    }
    async function terrainShot(name) {
      const frame=await shot(name);
      const distinct=await page.evaluate(async png=>{
        const bitmap=await createImageBitmap(new Blob([Uint8Array.from(atob(png),value=>value.charCodeAt(0))]));
        const sample=new OffscreenCanvas(96,64);
        const context=sample.getContext('2d',{willReadFrequently:true});
        context.drawImage(bitmap,bitmap.width/2-192,bitmap.height/2-128,384,256,0,0,96,64);
        bitmap.close();
        const rgba=context.getImageData(0,0,96,64).data;
        const colors=new Set();
        for (let at=0;at<rgba.length;at+=4) colors.add((rgba[at]<<16)|(rgba[at+1]<<8)|rgba[at+2]);
        return colors.size;
      },frame.toString('base64'));
      assert.ok(distinct>40,`Terrain missing from ${name} (${distinct} colors)`);
      return distinct;
    }
    await hop(-109.89,202.65,-154.92);
    await look(Math.PI,-1.48);
    await shot('ponyville-ground-alignment');
    await hop(-109.89,300.28,-154.92);
    await page.waitForFunction(()=>honeymoon.stats().overviewVisible && honeymoon.qaOverview().detail &&
      Object.keys(honeymoon.qaOverview().landmarks).length>=10,undefined,{timeout:25000});
    const overview=await page.evaluate(()=>honeymoon.qaOverview());
    assert.deepEqual([overview.imageWidth,overview.imageHeight],[2624,3040]);
    assert.equal(overview.landmarks.canterlot,undefined);
    assert.equal(overview.landmarks['white-mountain-span'],undefined);
    assert.ok(['sunset-plaza','sky-plaza','cloud-service-platform'].reduce((sum,key)=>sum+overview.landmarks[key],0)>10000);
    await look(Math.PI,-1.48,(300.28-65)/(202.65-65));
    overview.visibleTerrainColors=await terrainShot('ponyville-overview-alignment');
    await hop(601.66,333.23,-1299.61);
    await look(0,-1.34);
    await terrainShot('overview-no-canterlot-proxy');
    await hop(564.63,333.8,-1051.63);
    await look(0,-1.34);
    await terrainShot('overview-no-mountain-proxy');
    await hop(-279.19,389.35,-1385.37);
    await look(0,-1.34);
    await terrainShot('overview-detailed-buildings');
    result.checks.push(overview);
  } else if (test==='height') {
    await start();
    await page.keyboard.press('KeyF');
    await page.waitForFunction(()=>honeymoon.stats().flying);
    for (const [x,y,z] of [[-85.03,510.50,-378.50],[-355.66,460.97,165.98]]) {
      await hop(x,y,z);
      await page.waitForFunction(()=>{
        const state=honeymoon.stats();
        return state.overviewReady && state.overviewVisible && state.altitude==='high' && state.farTerrain.vistaCenterReady;
      },undefined,{timeout:40_000});
      await page.evaluate(()=>honeymoon.look(0,-.65));
      const above=await stat();
      assert.equal(above.farTerrain.vistaVisiblePacks,0);
      assert.ok(above.farTerrain.vistaBytes>0);
      await shot('overview-'+Math.round(y));
      result.checks.push({above});
    }
    await hop(-355.66,258,165.98);
    await page.waitForFunction(()=>{
      const state=honeymoon.stats();
      return state.overviewVisible && state.farTerrain.vistaCenterReady;
    });
    await page.evaluate(()=>{
      const phases=globalThis.descentPhases=[];
      function collect() {
        const {altitude,overviewVisible,farTerrain,renderedFrames,position:{y}}=honeymoon.stats();
        const {vistaCenterReady,vistaVisiblePacks}=farTerrain;
        const current={altitude,overviewVisible,vistaCenterReady,vistaVisiblePacks,renderedFrames,y};
        const last=phases.at(-1);
        if (!last || last.altitude!==altitude || last.overviewVisible!==overviewVisible) phases.push(current);
        if (altitude!=='ground') requestAnimationFrame(collect);
      }
      requestAnimationFrame(collect);
    });
    await page.keyboard.down('KeyC');
    try {
      await page.waitForFunction(()=>honeymoon.stats().position.y<=252,undefined,{timeout:15_000});
    } finally {
      await page.keyboard.up('KeyC');
    }
    await page.waitForFunction(()=>honeymoon.stats().altitude==='ground',undefined,{timeout:35_000});
    const phases=await page.evaluate(()=>descentPhases);
    const landing=phases.find(phase=>phase.altitude==='landing' && !phase.overviewVisible && phase.vistaCenterReady);
    assert.ok(landing && landing.vistaVisiblePacks>0 && landing.renderedFrames>phases[0].renderedFrames &&
      phases.at(-1).renderedFrames>landing.renderedFrames,JSON.stringify(phases));
    await shot('ground-ponyville');
    result.checks.push({phases,below:await stat()});
  } else if (test==='vista-stitch') {
    await page.route('**/game.mjs',async route=>{
      const response=await route.fetch();
      const source=await response.text();
      const marker='globalThis.honeymoon = Object.freeze({';
      assert.ok(source.includes(marker));
      const probe=`qaVistaStitch:()=>{
        const terrain=view.farTerrain;
        const lod=terrain.regionAt(-36,-12);
        const x=-576,z=-184;
        const origin=terrain.materials.vista.uniforms.vistaMaskOrigin.value;
        const {width}=terrain.stitchTexture.image;
        const at=((x/8-origin.x*2)+(z/8-origin.y*2)*width)*2;
        const edge=Array.from(terrain.stitchPixels.slice(at,at+2));
        const current=terrain.packs.get('vista:-2.-1');
        const pack=current?.previous??current;
        const ground=pack?.group.children[0]?.geometry;
        if (!pack?.installed || pack.coarse || !ground || !lod?.outer || terrain.regionAt(-37,-12)) return;
        const locations=ground.attributes.faceOrigin.array, surfaces=ground.attributes.faceSurface.array;
        for (let i=0;i<ground.instanceCount;i++) {
          if (locations[i*3]/8+pack.rx*512!==x-8 || locations[i*3+2]/8+pack.rz*512!==z ||
            surfaces[i*2+1]%8!==3 || locations[i*3+1]/8!==67) continue;
          return {edge,sourceHeight:67,sourceTile:surfaces[i*2],stitched:surfaces[i*2+1]>=512};
        }
      },`;
      await route.fulfill({response,body:source.replace(marker,marker+probe)});
    });
    await start();
    await page.evaluate(()=>honeymoon.setDistance(32));
    await page.keyboard.press('KeyF');
    await page.waitForFunction(()=>honeymoon.stats().flying);
    await hop(-24.5,146,-184.5);
    await page.evaluate(()=>honeymoon.look(Math.PI/2,-.14));
    await page.waitForFunction(()=>honeymoon.qaVistaStitch()?.edge[0]>0,undefined,{timeout:60_000});
    const stitch=await page.evaluate(()=>honeymoon.qaVistaStitch());
    assert.deepEqual(stitch,{edge:[68,0],sourceHeight:67,sourceTile:0,stitched:true});
    await shot('vista-grass-edge');
    result.checks.push({stitch,farTerrain:(await stat()).farTerrain});
  } else if (test==='terrain-seam') {
    await page.route('**/game.mjs',async route=>{
      const response=await route.fetch();
      const source=await response.text();
      const marker='globalThis.honeymoon = Object.freeze({';
      assert.ok(source.includes(marker));
      const probe=`qaTerrainDay:()=>{
        view.cycleTime=6000;
        view.updateSky(6000);
      },qaVistaSeams:()=>{
        const terrain=view.farTerrain;
        const origin=terrain.materials.vista.uniforms.vistaMaskOrigin.value;
        const side=terrain.coverageTexture.image.width;
        const fallback=[];
        for (const key of view.visiblePreciseTerrain) {
          const [x,z]=key.split(',').map(Number);
          if (view.exactChunks.has(key) || terrain.regionAt(x,z) || !terrain.hasVistaAt(x*16,z*16)) continue;
          const index=(x-origin.x)+(z-origin.y)*side;
          fallback.push({key,masked:terrain.coveragePixels[index]===255});
        }
        return fallback;
      },`;
      await route.fulfill({response,body:source.replace(marker,marker+probe)});
    });
    await start();
    await page.keyboard.press('KeyF');
    await page.waitForFunction(()=>honeymoon.stats().flying);
    await hop(706.41,187.38,-1471.15);
    await page.waitForFunction(()=>{
      const state=honeymoon.stats();
      return state.altitude==='ground' && state.streaming.ready && state.farTerrain.vistaVisiblePacks>0;
    },undefined,{timeout:40_000});
    const fallback=await page.evaluate(()=>honeymoon.qaVistaSeams());
    assert.ok(fallback.length>0 && fallback.every(({masked})=>masked),JSON.stringify(fallback));
    await page.evaluate(()=>honeymoon.qaTerrainDay());
    let darkSandPixels;
    for (const [index,yaw] of [0,.008,.016,Math.PI/2,Math.PI,3*Math.PI/2].entries()) {
      await page.evaluate(async yaw=>{
        honeymoon.look(yaw,-.22);
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      },yaw);
      const frame=await shot('canterlot-transition-'+index);
      if (index===4) darkSandPixels=await page.evaluate(async png=>{
        const bitmap=await createImageBitmap(new Blob([Uint8Array.from(atob(png),char=>char.charCodeAt(0))]));
        const canvas=new OffscreenCanvas(160,80);
        const context=canvas.getContext('2d',{willReadFrequently:true});
        context.drawImage(bitmap,-215,-470);
        bitmap.close();
        const pixels=context.getImageData(0,0,160,80).data;
        let dark=0;
        for (let at=0;at<pixels.length;at+=4) if (pixels[at]<210) dark++;
        return dark;
      },frame.toString('base64'));
    }
    assert.ok(darkSandPixels<8,`Unexpectedly dark sand pixels at atlas seams: ${darkSandPixels}`);
    result.checks.push({canterlot:await stat(),fallback,darkSandPixels});
  } else if (test==='map') {
    await page.addInitScript(()=>{
      const draw=CanvasRenderingContext2D.prototype.fillText;
      const paint=CanvasRenderingContext2D.prototype.drawImage;
      globalThis.mapLabels=[];
      CanvasRenderingContext2D.prototype.fillText=function(text,...args) {
        if (this.canvas.parentElement?.id==='altitude-map-panel') mapLabels.push(text);
        return draw.call(this,text,...args);
      };
      CanvasRenderingContext2D.prototype.drawImage=function(source,...args) {
        if (this.canvas.parentElement?.id==='altitude-map-panel' && source instanceof HTMLCanvasElement && source.width===64) {
          globalThis.mapDetailPainted=true;
        }
        return paint.call(this,source,...args);
      };
    });
    await start();
    const peer=await browser.newContext();
    const feed=new AbortController();
    try {
      assert.ok((await peer.request.post(url+'api/session',{data:{}})).ok());
      assert.ok((await peer.request.post(url+'api/profile',{data:{nickname:'Проверка карты'}})).ok());
      const cookie=(await peer.cookies()).map(({name,value})=>name+'='+value).join('; ');
      assert.ok((await fetch(url+'api/events?presence=1',{headers:{cookie},signal:feed.signal})).ok);
      assert.ok((await peer.request.post(url+'api/presence',{data:{yaw:0,pitch:0,motion:'idle'}})).ok());
      await page.evaluate(()=>document.exitPointerLock());
      await page.waitForFunction(()=>document.getElementById('game').classList.contains('paused'));
      await click('#altitude-map');
      await page.waitForFunction(()=>mapLabels.includes('Проверка карты'));
      await shot('map-overview');
      const [vista,lod]=await Promise.all([
        page.waitForResponse(response=>/\/generated\/vista\/[^/]+\/[^/]+\.bin$/.test(response.url()) && response.ok()),
        page.waitForResponse(response=>/\/generated\/lod\/[^/]+\/[^/]+\.bin$/.test(response.url()) && response.ok()),
        page.getByRole('button',{name:'Моя позиция'}).click(),
      ]);
      const zoomIn=page.getByRole('button',{name:'Приблизить'});
      for (let step=0;step<4;step++) await zoomIn.click();
      await page.getByRole('button',{name:'Отдалить'}).click();
      await page.waitForFunction(()=>globalThis.mapDetailPainted);
      await shot('map-detail');
      await page.keyboard.press('Escape');
      assert.equal(await visible('#altitude-map-panel'),false);
      assert.equal(await page.locator('#altitude-map').evaluate(button=>button===document.activeElement),true);
      result.checks.push({marker:'Проверка карты',assets:[new URL(vista.url()).pathname,new URL(lod.url()).pathname]});
    } finally { feed.abort(); await peer.close(); }
  } else if (test==='travel-roles') {
    await start(false);
    await page.keyboard.press('KeyG');
    assert.equal(await visible('#teleport-form'),false);
    await page.evaluate(()=>document.exitPointerLock());
    await page.waitForFunction(()=>document.getElementById('game').classList.contains('paused'));
    await pauseSection('world');
    for (const id of ['teleport-toggle','warp-toggle','touch-teleport']) {
      assert.equal(await page.locator('#'+id).getAttribute('hidden'),'');
    }
    assert.equal(await visible('#reset'),true);
    const [spawn]=await Promise.all([
      page.waitForResponse(response=>response.url().endsWith('/api/respawn') && response.ok()),
      click('#reset'),
    ]);
    result.checks.push({travelHidden:true,spawn:(await spawn.json()).position});
  } else if (test==='controls') {
    await start();
    await page.evaluate(()=>document.exitPointerLock());
    await page.waitForFunction(()=>document.getElementById('game').classList.contains('paused'));
    await pauseSection('settings');
    await pauseTab('controls');
    const controls=page.locator('#keys'), summary=controls.locator('summary');
    assert.equal(await summary.isVisible(),true);
    assert.equal(await controls.evaluate(panel=>panel.open),false);
    assert.equal(await controls.getByText('H / Shift+H',{exact:true}).isVisible(),false);
    await summary.focus();
    await page.keyboard.press('Enter');
    assert.equal(await controls.evaluate(panel=>panel.open),true);
    for (const key of ['H / Shift+H','Q / Ctrl+Q','G / L','Tab','Стрелки / Home / End']) {
      assert.equal(await controls.getByText(key,{exact:true}).isVisible(),true);
    }
    await shot('controls-desktop');
    await page.keyboard.press('Space');
    assert.equal(await controls.evaluate(panel=>panel.open),false);
    await summary.click();
    await click('#play');
    await page.waitForFunction(()=>Boolean(document.pointerLockElement) && document.getElementById('game').classList.contains('playing'));
    await page.evaluate(()=>document.exitPointerLock());
    await page.waitForFunction(()=>document.getElementById('game').classList.contains('paused'));
    assert.equal(await controls.evaluate(panel=>panel.open),false);
    result.checks.push({collapsedByDefault:true,keyboardAccessible:true,collapsedOnReopen:true});
  } else if (test==='solo-entry') {
    await page.route('**/api/session',route=>route.fulfill({
      status:403,json:{error:'invite_required'},
    }));
    await page.goto(url.replace('127.0.0.1','honeymoon-qa.localhost'),{waitUntil:'domcontentloaded'});
    await page.locator('#access-gate').waitFor();
    const soloEntry=page.getByRole('button',{name:'Одиночная игра'});
    assert.equal(await soloEntry.count(),1);
    await soloEntry.click();
    const dialog=page.getByRole('dialog',{name:'Одиночная игра'});
    assert.equal(await dialog.isVisible(),true);
    const archiveName=expectedBuild>=19?'Lilium-Moonlight':'Honeymoon';
    assert.match(await dialog.getByRole('link',{name:'Скачать для Windows'}).getAttribute('href'),
      new RegExp(`/build-${expectedBuild}/${archiveName}-Build-${expectedBuild}-SinglePlayer\\.zip$`));
    assert.equal(await dialog.getByRole('link',{name:'Открыть запущенную игру'}).getAttribute('href'),'http://127.0.0.1:4180/');
    await shot('solo-entry');
    await dialog.getByRole('button',{name:'Закрыть'}).click();
    assert.equal(await dialog.isVisible(),false);
    result.checks.push({inviteRequired:true,soloEntryAvailable:true});
  } else if (solo) {
    await start();
    const journal=await page.request.get(url+'api/local-diagnostics');
    assert.match(journal.headers()['content-disposition'],/attachment/);
    const records=await journal.json();
    assert.ok(records.some(record=>record.kind==='server-start' && record.build===expectedBuild));
    assert.ok(records.some(record=>record.kind==='heartbeat' && record.position.length===3));
    result.checks.push({records,stats:await stat()});
    await shot('solo-play');
  } else if (networkQa) {
    let simulatedFailures=0, delayed=0;
    const events=[];
    await page.route('**/api/ping',async route=>{
      if (simulatedFailures>0) {
        simulatedFailures--;
        await route.abort('failed');
      } else if (delayed>0) {
        delayed--;
        await new Promise(resolve=>setTimeout(resolve,400));
        await route.continue();
      } else await route.continue();
    });
    page.on('response',response=>{
      if (new URL(response.url()).pathname!=='/api/player-diagnostics' || response.status()!==204) return;
      const {samples}=response.request().postDataJSON();
      for (const sample of samples) events.push(...(sample.network??[]));
    });
    await start();
    assert.ok((await page.request.post(url+'api/session',{data:{}}).then(response=>response.json())).playerDiagnostics);
    delayed=1;
    await assertEvent('spike');
    simulatedFailures=2;
    await assertEvent('recovered');
    const failures=events.filter(event=>event.kind==='ping' && event.state==='lost');
    const recovery=events.find(event=>event.kind==='ping' && event.state==='recovered');
    assert.ok(failures.length>=2);
    assert.ok(recovery.missed>=2 && recovery.durationMs>0);
    assert.equal(await page.locator('#admin-network-report').evaluate(button=>button.hidden),false);
    const response=await page.request.get(url+'api/admin/network-diagnostics?hours=1');
    assert.equal(response.status(),200);
    const report=await response.json();
    assert.equal(report.players.length,1);
    assert.equal(report.players[0].nickname,'Проверка игры');
    assert.ok(report.players[0].ping.spikes>=1 && report.players[0].ping.losses>=2);
    result.checks.push({latencySpike:events.find(event=>event.kind==='ping'&&event.state==='spike'),failures,recovery,
      uploaded:report.players[0].ping});
    async function assertEvent(state) {
      const deadline=Date.now()+25_000;
      while (Date.now()<deadline && !events.some(event=>event.kind==='ping' && event.state===state)) {
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      assert.ok(events.some(event=>event.kind==='ping' && event.state===state),JSON.stringify(events));
    }
  } else if (test==='altitude-audio' || test==='altitude-default' || test==='altitude-server') {
    let requestedAltitude=false;
    page.on('request',request=>{
      if (new URL(request.url()).pathname==='/api/altitude-music') requestedAltitude=true;
    });
    await start();
    const custom=test==='altitude-audio';
    const expectedSource=custom?'custom':test==='altitude-server'?'default':undefined;
    const expectedMode=expectedSource?'altitude':'overworld';
    if (custom) {
      await page.evaluate(()=>document.exitPointerLock());
      await page.waitForFunction(()=>document.getElementById('game').classList.contains('paused'));
      await pauseSection('settings');
      await pauseTab('audio');
      await page.locator('#music-volume').fill('35');
      await click('#audio-settings-toggle');
      await page.locator('#altitude-music-file').setInputFiles(process.env.HONEYMOON_QA_AUDIO);
      await page.waitForFunction(()=>honeymoon.stats().audio.altitudeMusicConfigured);
      await click('#audio-settings-close');
      if (await visible('#play')) await click('#play');
    }
    await page.waitForFunction(()=>{
      const audio=honeymoon.stats().audio;
      return audio.musicMode==='npc' && audio.musicPlaying && audio.musicTime>0.2;
    },undefined,{timeout:20000});
    const before=await stat();
    await page.keyboard.press('KeyF');
    await page.waitForFunction(()=>honeymoon.stats().flying);
    async function hop(x,y,z) {
      await page.locator('#teleport-toggle').evaluate(button=>button.click());
      await page.locator('#teleport-x').fill(String(x));
      await page.locator('#teleport-y').fill(String(y));
      await page.locator('#teleport-z').fill(String(z));
      await click('#teleport-send');
      await page.waitForFunction(level=>Math.abs(honeymoon.stats().position.y-level)<1 &&
        document.getElementById('teleport-loading').hidden,y,{timeout:35_000});
      await click('#teleport-close');
      if (await visible('#play')) await click('#play');
    }
    await hop(-8,275,-19);
    await page.waitForFunction(({source,mode})=>{
      const audio=honeymoon.stats().audio;
      return audio.musicMode===mode && audio.altitudeMusicSource===source && audio.musicPlaying && audio.musicTime>0.2;
    },{source:expectedSource,mode:expectedMode},{timeout:16000});
    assert.equal(requestedAltitude,test==='altitude-server');
    const above=await stat();
    await page.evaluate(()=>document.exitPointerLock());
    await page.waitForFunction(()=>document.getElementById('game').classList.contains('paused'));
    const pausedAt=(await stat()).audio.musicTime;
    await page.waitForFunction(({at,mode})=>{
      const audio=honeymoon.stats().audio;
      return audio.musicMode===mode && audio.musicPlaying && audio.musicTime>at+.4;
    },{at:pausedAt,mode:expectedMode},{timeout:5000});
    const pauseMusic=(await stat()).audio;
    await click('#play');
    await hop(-8,225,-19);
    await page.waitForFunction(()=>{
      const audio=honeymoon.stats().audio;
      return audio.musicMode==='overworld' && audio.musicPlaying;
    },undefined,{timeout:16000});
    const below=await stat();
    await hop(-8,66,-19);
    await page.waitForFunction(()=>{
      const audio=honeymoon.stats().audio;
      return audio.musicMode==='npc' && audio.musicPlaying && audio.musicTime>0.2;
    },undefined,{timeout:20000});
    const returned=await stat();
    if (custom) {
      await page.reload();
      await ready();
      await page.waitForFunction(()=>honeymoon.stats().audio.altitudeMusicConfigured);
    }
    result.checks.push({before:before.audio,above:above.audio,pauseMusic,below:below.audio,returned:returned.audio,persists:custom});
  } else if (test==='auto-move') {
    await start();
    await page.keyboard.press('KeyF');
    await page.waitForFunction(()=>honeymoon.stats().flying);
    await hop(-109.89,218,-154.92);
    await page.evaluate(()=>honeymoon.look(Math.PI/2,0));
    const moveLeftFrom=async (position,mode)=>{
      await page.waitForFunction(({x,mode})=>{
        const state=honeymoon.stats();
        return state.autoMovement===mode && state.position.x<x-1 && state.movementSync.confirmed[0]<x-.5;
      },{x:position.x,mode},{timeout:10000});
      return (await stat()).position;
    };
    const startPosition=(await stat()).position;
    await page.keyboard.press('KeyH');
    await moveLeftFrom(startPosition,'walk');
    await page.keyboard.press('KeyR');
    assert.equal((await stat()).autoMovement,'walk');
    await page.keyboard.press('KeyT');
    const input=page.locator('#chat-input');
    await input.waitFor({state:'visible'});
    const chatStart=(await stat()).position;
    await input.press('KeyH');
    await input.press('ArrowLeft');
    assert.equal(await input.inputValue(),'h');
    const chatEnd=await moveLeftFrom(chatStart,'walk');
    assert.equal(await input.evaluate(element=>element===document.activeElement),true);
    await shot('auto-move-chat');
    await input.press('Escape');
    await page.waitForFunction(()=>Boolean(document.pointerLockElement));
    await page.evaluate(()=>document.exitPointerLock());
    await page.waitForFunction(()=>document.getElementById('game').classList.contains('paused'));
    const pauseStart=(await stat()).position;
    const pauseEnd=await moveLeftFrom(pauseStart,'walk');
    await shot('auto-move-paused');
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(()=>honeymoon.stats().autoMovement===null);
    const stopped=(await stat()).position;
    await page.waitForTimeout(350);
    assert.ok(Math.abs((await stat()).position.x-stopped.x)<.1);
    await page.keyboard.press('Shift+H');
    const sprintEnd=await moveLeftFrom(stopped,'sprint');
    assert.match(await page.locator('#auto-move-status').textContent(),/спринт/i);
    await page.keyboard.press('KeyH');
    await page.waitForFunction(()=>honeymoon.stats().autoMovement===null);
    assert.equal(await visible('#auto-move-status'),false);
    result.checks.push({startPosition,chatStart,chatEnd,pauseStart,pauseEnd,stopped,sprintEnd});
  } else if (test==='outage') {
    await start();
    await page.keyboard.press('KeyF');
    await page.waitForFunction(()=>honeymoon.stats().movementSync.status==='ready');
    const before=await stat();
    const timeOrigin=await page.evaluate(()=>performance.timeOrigin);
    await page.context().setOffline(true);
    await page.keyboard.down('Space');
    await page.waitForTimeout(3900);
    const stopped=await stat();
    await page.waitForTimeout(36_100);
    const offline=await stat();
    assert.equal(offline.position.y,stopped.position.y);
    assert.ok(offline.position.y-before.position.y<20);
    await page.context().setOffline(false);
    await page.waitForFunction(()=>honeymoon.stats().movementSync.queueAgeMs<1200,undefined,{timeout:20_000});
    const online=await stat();
    await page.waitForFunction(y=>honeymoon.stats().position.y>y+3,online.position.y,{timeout:15_000});
    await page.keyboard.up('Space');
    const after=await stat();
    assert.equal(await page.evaluate(()=>performance.timeOrigin),timeOrigin);
    result.checks.push({before,stopped,offline,online,after});
    await shot('outage-recovered');
  } else {
    assert.equal(test,'late-http');
    await page.route('**/api/position',async route=>{
      try {
        const response=await route.fetch();
        await new Promise(resolve=>setTimeout(resolve,1400));
        await route.fulfill({response});
      } catch {await route.abort().catch(()=>{});}
    });
    await start();
    await page.keyboard.press('KeyF');
    const before=await stat();
    await page.keyboard.down('Space');
    await page.waitForTimeout(5000);
    await page.keyboard.up('Space');
    const after=await stat();
    assert.ok(after.position.y-before.position.y>5,JSON.stringify({from:before.position,to:after.position}));
    assert.equal(after.movementSync.corrections-before.movementSync.corrections,0);
    result.checks.push({before,after});
    await shot('late-http-flight');
  }
  assert.deepEqual(result.errors,[]);
} catch (error) {
  result.failure=error.stack;
  result.lastStats=await stat().catch(()=>null);
  await shot('failure-'+test).catch(()=>{});
  throw error;
} finally {
  await writeFile(join(output,test+'.json'),JSON.stringify(result,null,2)+'\n');
  await browser.close();
  await app.close();
}
