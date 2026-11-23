import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {createHoneymoonServer} from '../server/index.mjs';
import * as geometry from '../world/geometry.mjs';

const generated=process.env.HONEYMOON_QA_GENERATED;
const output=process.argv[2]&&resolve(process.argv[2]);
if (!generated||!output) throw new Error('Provide HONEYMOON_QA_GENERATED and an output directory');
await mkdir(output,{recursive:true});

const palette=['air','legacy:1:0','legacy:3:0'];
const cellIndex=(x,y,z)=>y===64?1:y===65&&z===6?x===4?2:x===6?1:0:0;
const hash='bd'.repeat(32);
const coverage=(x,z)=>x===0&&z===0;
const indices=Buffer.alloc(8192);
for (let y=64;y<=65;y++) for (let z=0;z<16;z++) for(let x=0;x<16;x++) {
  indices.writeUInt16LE(cellIndex(x,y,z),2*(x+16*z+256*(y&15)));
}
const bounds={minX:0,maxX:15,minY:0,maxY:255,minZ:0,maxZ:15};
const manifest={bounds,spawn:[4.5,65,8.5],chunks:[[0,0]],terrain:[],palette,compositions:{},
  schemaVersion:1,importVersion:1,catalogVersion:1,contentHash:hash,chunkPalettes:true};
const base={manifest,hash,catalog:new Set(palette),hasPlayableChunk:coverage,worldCoverage:coverage,
  inBounds:(x,y,z)=>x>=0&&x<16&&y>=0&&y<256&&z>=0&&z<16,
  getCell:(x,y,z)=>({key:palette[cellIndex(x,y,z)],object:null}),
  publicChunk:(x,z)=>coverage(x,z)?{x,z,palette,compositions:{},objects:[],entities:[],
    sections:[{y:4,indices:indices.toString('base64')}]}:null};

let now=Date.now();
const ownerKey='qa-held-equipment';
const app=createHoneymoonServer({base,generated,geometry,state:':memory:',npcAdminKey:ownerKey,clock:()=>now,
  ownerOnPrimary:true,inviteRequired:false,initialMode:'creative'});
app.server.listen(0,'127.0.0.1');
await once(app.server,'listening');
const url=`http://127.0.0.1:${app.server.address().port}/`;
const result={checks:[],errors:[]};
let browser,page,defender;

try {
  browser=await chromium.launch({channel:'msedge',args:['--enable-unsafe-swiftshader']});
  page=await browser.newPage({viewport:{width:1000,height:640},serviceWorkers:'block'});
  defender=await browser.newPage({viewport:{width:720,height:540},serviceWorkers:'block'});
  for (const browserPage of [page,defender]) browserPage.on('pageerror',error=>result.errors.push(error.message));
  const login=await page.request.post(url+'api/access/owner',{data:{key:ownerKey,profileName:'Проверка снаряжения'}});
  assert.equal(login.status(),200,await login.text());
  const {playerId}=await login.json();
  const guest=await defender.request.post(url+'api/session',{data:{}});
  assert.equal(guest.status(),200,await guest.text());
  const {playerId:defenderId,profile}=await guest.json();
  assert.ok(defenderId&&defenderId!==playerId);
  const target={x:6.7,y:65,z:8.5};
  app.game.teleport(defenderId,target);
  const loadout=['creative:373:16348','creative:260:0','creative:373:16274','creative:290:0',
    'creative:270:0','creative:268:0','creative:261:0','creative:262:0'];
  for (const [slot,key] of loadout.entries()) {
    const grant=app.game.action(playerId,{requestId:randomUUID(),type:'inventory_give',slot,key,count:slot===7?3:1});
    assert.equal(grant.status,200,JSON.stringify(grant.output));
  }
  for (const target of [playerId,defenderId]) {
    const mode=await page.request.post(url+'api/modes',{data:{target,mode:'game'}});
    assert.equal(mode.status(),200,await mode.text());
  }

  async function enter(browserPage) {
    await browserPage.goto(url,{waitUntil:'domcontentloaded'});
    await browserPage.waitForFunction(()=>globalThis.honeymoon?.stats().playable>0,undefined,{timeout:60_000});
    const play=browserPage.locator('#play');
    if (await play.isVisible()) await play.click();
    else await browserPage.locator('#scene canvas').click();
    await browserPage.waitForFunction(()=>!document.getElementById('chat-toggle').disabled);
  }
  await enter(defender);
  await page.bringToFront();
  await enter(page);
  await page.waitForFunction(()=>Boolean(document.pointerLockElement));

  function wait(route,type) {
    return page.waitForResponse(response=>response.url()===`${url}api/${route}`&&
      (!type || response.request().postDataJSON()?.type===type),{timeout:8000});
  }
  async function success(pending) {
    const response=await pending;
    assert.equal(response.status(),200,await response.text());
    return response.json();
  }
  async function select(slot) {
    const pending=wait('action','inventory_select');
    await page.keyboard.press(`Digit${slot+1}`);
    await success(pending);
  }
  async function aim(point) {
    await page.evaluate(async point=>{
      for (let frame=0;frame<3;frame++) {
        const {position,body}=honeymoon.stats();
        const eyes=honeymoon.localAvatar()?.eyes??[position.x,position.y+body.eye,position.z];
        const dx=point[0]-eyes[0],dy=point[1]-eyes[1],dz=point[2]-eyes[2];
        honeymoon.look(Math.atan2(-dx,-dz),Math.atan2(dy,Math.hypot(dx,dz)));
        await new Promise(requestAnimationFrame);
      }
    },point);
  }
  async function use(route,type,button='right') {
    now+=500;
    const pending=wait(route,type);
    await page.mouse.click(500,320,{button});
    return success(pending);
  }
  const health=(browserPage=page)=>browserPage.evaluate(()=>honeymoon.health().health);
  const waitHealth=(browserPage,hp)=>browserPage.waitForFunction(hp=>honeymoon.health().health===hp,hp);

  const catalog=await page.request.get(url+'generated/creative/catalog.json').then(response=>response.json());
  const names=new Map(catalog.entries.map(({key,name})=>[key,name]));
  assert.match(names.get(loadout[0]),/урона/);
  assert.match(names.get(loadout[2]),/скорости/);
  assert.equal(names.get('creative:4999:1'),'Яблочный сидр');
  const ownHealth=await health();
  await aim([4.5,67,5]);
  const drank=await use('held-use','consume');
  assert.equal(drank.inventory.slots[0].key,'creative:374:0');
  await waitHealth(page,ownHealth-6);
  await select(1);
  await use('held-use','consume');
  await waitHealth(page,ownHealth-2);
  await select(2);
  await use('held-use','consume');
  await page.waitForFunction(()=>honeymoon.stats().potionEffects?.speed?.amplifier===0);
  result.checks.push('damaging and speed potions have distinct catalog names and effects, and eating restores HP');

  await select(3);
  await aim([4.5,65.98,6.5]);
  assert.equal((await use('held-use','hoe')).changes[0].cell,'legacy:60:0');
  await select(4);
  await aim([6.5,65.6,6.5]);
  const initialDebris=await page.evaluate(()=>honeymoon.stats().breakParticles);
  const mined=await use('action','remove','left');
  assert.equal(mined.changes[0].cell,null);
  await page.waitForFunction(count=>honeymoon.stats().breakParticles>count,initialDebris);
  const creativeMode=await page.request.post(url+'api/modes',{data:{target:playerId,mode:'creative'}});
  assert.equal(creativeMode.status(),200,await creativeMode.text());
  await page.waitForFunction(()=>honeymoon.health().mode==='creative');
  await aim([4.5,65.7,6.5]);
  const creativeDebris=await page.evaluate(()=>honeymoon.stats().breakParticles);
  assert.equal((await use('action','remove','left')).changes[0].cell,null);
  await page.waitForFunction(count=>honeymoon.stats().breakParticles>count,creativeDebris);
  const survivalMode=await page.request.post(url+'api/modes',{data:{target:playerId,mode:'game'}});
  assert.equal(survivalMode.status(),200,await survivalMode.text());
  await page.waitForFunction(()=>honeymoon.health().mode==='game');
  result.checks.push('hoe tills dirt, wooden pickaxe mines stone, and block debris renders in survival and creative');

  await aim([target.x,target.y+.72,target.z]);
  const defenderHealth=await health(defender);
  await select(8);
  assert.equal((await use('combat',undefined,'left')).hit,true);
  await waitHealth(defender,defenderHealth-1);
  await select(5);
  assert.equal((await use('combat',undefined,'left')).hit,true);
  await waitHealth(defender,defenderHealth-5);
  result.checks.push('clicking the same player with a hoof and a wooden sword deals 1 and 4 HP');

  await select(6);
  await aim([target.x,target.y+.72,target.z]);
  const start=wait('held-use','bow-start');
  await page.mouse.down({button:'right'});
  await success(start);
  await page.waitForFunction(()=>honeymoon.stats().bowDraw>.5);
  await page.screenshot({path:join(output,'held-equipment-bow.png')});
  now+=1000;
  const release=wait('held-use','bow-release');
  await page.mouse.up({button:'right'});
  const shot=await success(release);
  assert.equal(shot.projectile.kind,'arrow');
  assert.ok(shot.projectile.points.length>1);
  assert.equal(shot.inventory.slots[7].count,2);
  await waitHealth(defender,Math.max(0,defenderHealth-13));
  result.checks.push('right button charges a visible bow and releasing fires one arrow that damages the target');
  assert.ok(profile?.id);
  assert.deepEqual(result.errors,[]);
} catch(error) {
  result.failure=error.stack;
  result.at=await page?.evaluate(()=>({target:globalThis.honeymoon?.target(),health:globalThis.honeymoon?.health(),
    position:globalThis.honeymoon?.stats().position,locked:Boolean(document.pointerLockElement)})).catch(()=>undefined);
  await page?.screenshot({path:join(output,'held-equipment-failure.png'),timeout:5000}).catch(()=>{});
  throw error;
} finally {
  await browser?.close();
  await app.close();
  await writeFile(join(output,'held-equipment.json'),JSON.stringify(result,null,2)+'\n');
}
