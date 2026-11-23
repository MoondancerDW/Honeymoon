import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {createHoneymoonServer} from '../server/index.mjs';
import {openStore} from '../server/store.mjs';
import * as geometry from '../world/geometry.mjs';

const generated=process.env.HONEYMOON_QA_GENERATED;
const output=process.argv[2]&&resolve(process.argv[2]);
if (!generated||!output) throw new Error('Provide map assets and an output directory');
await mkdir(output,{recursive:true});

const palette=['air','legacy:1:0','legacy:2168:0'];
const bounds={minX:0,maxX:15,minY:0,maxY:255,minZ:0,maxZ:15};
const cellIndex=(x,y,z)=>y===64?1:x===6&&y===65&&z===6?2:0;
const hash='bd'.repeat(32);
const coverage=(x,z)=>x===0&&z===0;
const indices=Buffer.alloc(8192);
for (let y=64;y<66;y++) for (let z=0;z<16;z++) for(let x=0;x<16;x++) {
  indices.writeUInt16LE(cellIndex(x,y,z),2*(x+16*z+256*(y&15)));
}
const manifest={bounds,spawn:[4.5,65,8.5],chunks:[[0,0]],terrain:[],palette,compositions:{},
  schemaVersion:1,importVersion:1,catalogVersion:1,contentHash:hash,chunkPalettes:true};
const base={manifest,hash,catalog:new Set(palette),hasPlayableChunk:coverage,worldCoverage:coverage,
  inBounds:(x,y,z)=>x>=0&&x<16&&y>=0&&y<256&&z>=0&&z<16,
  getCell:(x,y,z)=>({key:palette[cellIndex(x,y,z)],object:null}),
  publicChunk:(x,z)=>coverage(x,z)?{x,z,palette,compositions:{},objects:[],entities:[],
    sections:[{y:4,indices:indices.toString('base64')}]}:null};
const ownerKey='qa-world-objects';
const state=join(output,'world-use.sqlite');
const store=openStore(state);
store.putState('diagnostic','world','layout',1,{switch:[0,65,0],door:[[1,65,0],[1,66,0]]});
store.close();
const app=createHoneymoonServer({base,generated,geometry,state,npcAdminKey:ownerKey,
  ownerOnPrimary:true,inviteRequired:true,initialMode:'creative'});
app.server.listen(0,'127.0.0.1');
await once(app.server,'listening');
const url=`http://127.0.0.1:${app.server.address().port}/`;
const result={checks:[],errors:[]};
let browser,page;

try {
  browser=await chromium.launch({channel:'msedge',args:['--enable-unsafe-swiftshader']});
  page=await browser.newPage({viewport:{width:1000,height:640},serviceWorkers:'block'});
  page.on('pageerror',error=>result.errors.push(error.message));
  const login=await page.request.post(url+'api/access/owner',{data:{key:ownerKey,profileName:'Проверка предметов'}});
  assert.equal(login.status(),200,await login.text());
  const {playerId}=await login.json();
  const items=['creative:390:0','legacy:37:0','creative:357:0','legacy:2160:0','creative:354:0','legacy:54:0','legacy:140:0'];
  for (const [slot,key] of items.entries()) {
    const grant=app.game.action(playerId,{requestId:randomUUID(),type:'inventory_give',slot,key,count:1});
    assert.equal(grant.status,200,JSON.stringify(grant.output));
  }
  await page.goto(url,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>globalThis.honeymoon?.stats().playable>0,undefined,{timeout:60000});
  if (await page.locator('#play').isVisible()) await page.locator('#play').click();
  else await page.locator('#scene canvas').click();
  await page.waitForFunction(()=>Boolean(document.pointerLockElement));

  async function aim(point) {
    await page.evaluate(async point=>{
      for (let step=0;step<3;step++) {
        const eyes=honeymoon.localAvatar()?.eyes;
        const {position,body}=honeymoon.stats();
        const [x,y,z]=eyes??[position.x,position.y+body.eye,position.z];
        const dx=point[0]-x,dz=point[2]-z,dy=point[1]-y;
        honeymoon.look(Math.atan2(-dx,-dz),Math.atan2(dy,Math.hypot(dx,dz)));
        await new Promise(requestAnimationFrame);
      }
    },point);
  }
  async function select(slot) {
    const changed=page.waitForResponse(response=>response.url()===url+'api/action' &&
      response.request().postDataJSON()?.type==='inventory_select');
    await page.keyboard.press(`Digit${slot+1}`);
    const response=await changed;
    assert.equal(response.status(),200,await response.text());
    await page.waitForFunction(slot=>document.querySelector(`#hotbar [aria-selected="true"]`)?.dataset.slot===String(slot) ||
      Number(document.querySelector('#hotbar .selected')?.dataset.slot)===slot,slot,{timeout:1000}).catch(()=>{});
  }
  async function perform(type,point,button='right') {
    await aim(point);
    const finished=page.waitForResponse(response=>response.url()===url+'api/action' &&
      response.request().postDataJSON()?.type===type,{timeout:5000});
    await page.mouse.click(500,320,{button});
    const response=await finished;
    assert.equal(response.status(),200,await response.text());
    return response.json();
  }

  const pot=await perform('place',[2.5,65,6.5]);
  assert.equal(pot.changes[0].cell,'legacy:140:0');
  await select(1);
  const flower=await perform('interact',[2.5,65.2,6.5]);
  assert.equal(flower.changes[0].cell,'legacy:140:2');
  assert.equal(flower.changes[0].y,65);
  await select(6);
  assert.equal((await perform('place',[1.5,65,7.5])).changes[0].cell,'legacy:140:0');
  result.checks.push('both pot entries place and the flower fits inside the pot');

  await select(2);
  assert.equal((await perform('interact',[6.5,65.45,6.5])).changes[0].object.data.jarContent,'cookie');
  await select(8);
  assert.equal((await perform('interact',[6.5,65.45,6.5])).changes[0].object.data.jarContent,'empty');
  await select(3);
  assert.equal((await perform('interact',[6.5,65.45,6.5])).changes[0].object.data.jarContent,'firefly');
  result.checks.push('cookie and firefly insert into the jar through the ordinary play controls');

  await select(4);
  assert.equal((await perform('place',[3.5,65,6.5])).changes[0].cell,'legacy:92:0');
  for (let slice=1;slice<=6;slice++) {
    const eaten=await perform('interact',[3.76,65.25,6.5]);
    assert.equal(eaten.changes[0].cell,slice===6?null:`legacy:92:${slice}`);
  }
  result.checks.push('cake places and is eaten in six slices');

  await select(5);
  const west=(await perform('place',[2.5,65,7.5])).changes[0];
  const east=(await perform('place',[6.5,65,8.5])).changes[0];
  assert.notEqual(west.cell,east.cell);
  const broken=await perform('remove',[2.5,65.45,7.5],'left');
  assert.ok(broken.effects.some(effect=>effect.type==='break'));
  result.checks.push('chests follow opposite viewing directions and breaking produces debris');
  assert.deepEqual(result.errors,[]);
  await page.screenshot({path:join(output,'world-use.png')});
} catch(error) {
  result.failure=error.stack;
  await page?.screenshot({path:join(output,'world-use-failure.png')}).catch(()=>{});
  throw error;
} finally {
  await browser?.close();
  await app.close();
  await writeFile(join(output,'world-use.json'),JSON.stringify(result,null,2)+'\n');
}
