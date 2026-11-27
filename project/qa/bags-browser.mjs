import assert from 'node:assert/strict';
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

const farmland={x:5,y:64,z:6};
const palette=['air','legacy:1:0','legacy:60:0'];
const bounds={minX:0,maxX:15,minY:0,maxY:255,minZ:0,maxZ:15};
const hash='ba'.repeat(32);
const coverage=(x,z)=>x===0&&z===0;
const cellIndex=(x,y,z)=>y!==64?0:x===farmland.x&&z===farmland.z?2:1;
const indices=Buffer.alloc(8192);
for (let z=0;z<16;z++) for (let x=0;x<16;x++) indices.writeUInt16LE(cellIndex(x,64,z),2*(x+16*z));
const manifest={bounds,spawn:[4.5,65,8.5],chunks:[[0,0]],terrain:[],palette,compositions:{},
  schemaVersion:1,importVersion:1,catalogVersion:1,contentHash:hash,chunkPalettes:true};
const base={manifest,hash,catalog:new Set(palette),hasPlayableChunk:coverage,worldCoverage:coverage,
  inBounds:(x,y,z)=>x>=0&&x<16&&y>=0&&y<256&&z>=0&&z<16,
  getCell:(x,y,z)=>({key:palette[cellIndex(x,y,z)],object:null}),
  publicChunk:(x,z)=>coverage(x,z)?{x,z,palette,compositions:{},objects:[],entities:[],
    sections:[{y:4,indices:indices.toString('base64')}]}:null};
const state=join(output,'bags.sqlite');
const initialStore=openStore(state);
initialStore.putState('diagnostic','world','layout',1,{switch:[0,65,0],door:[[1,65,0],[1,66,0]]});
initialStore.close();
const ownerKey='qa-portable-bags';
const app=createHoneymoonServer({base,generated,geometry,state,npcAdminKey:ownerKey,
  ownerOnPrimary:true,inviteRequired:true,initialMode:'game'});
app.server.listen(0,'127.0.0.1');
await once(app.server,'listening');
const url=`http://127.0.0.1:${app.server.address().port}/`;

const title='Дневник из старой сумки';
const bookTag={title,author:'Лилия',pages:['Оригинальная страница'],display:{Name:title,Lore:['Сохранённая заметка']},
  CustomMod:{value:{$nbt:'long',value:'11892379324890'}}};
const seedTag={display:{Name:'Семена из старого мешочка'}};
const result={checks:[],errors:[]};
let browser,page;

try {
  browser=await chromium.launch({channel:'msedge',args:['--enable-unsafe-swiftshader']});
  page=await browser.newPage({viewport:{width:1000,height:640},serviceWorkers:'block'});
  page.on('pageerror',error=>result.errors.push(error.message));
  const login=await page.request.post(url+'api/access/owner',{data:{key:ownerKey,profileName:'Проверка сумок'}});
  assert.equal(login.status(),200,await login.text());
  const {playerId}=await login.json();
  const inventory=Array(36).fill(null);
  inventory[0]={key:'creative:9268:3',count:1,nbt:{contents:[{id:387,Damage:0,Count:1,Slot:4,tag:bookTag,ForgeExtra:7}]}};
  inventory[1]={key:'creative:9299:575',count:1,nbt:{contents:[{id:295,Damage:0,Count:2,Slot:0,tag:seedTag}]}};
  const fixture=openStore(state);
  try {fixture.putState('inventory',playerId,'slots',3,{slots:inventory,selected:0});}
  finally {fixture.close();}

  await page.goto(url,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>globalThis.honeymoon?.stats().playable>0,undefined,{timeout:60000});
  async function resume() {
    if (await page.locator('#play').isVisible()) await page.locator('#play').click();
    if (!await page.evaluate(()=>Boolean(document.pointerLockElement))) await page.locator('#scene canvas').click();
    await page.waitForFunction(()=>Boolean(document.pointerLockElement));
  }
  await resume();
  async function rightClick() {
    await page.mouse.down({button:'right'});
    await page.mouse.up({button:'right'});
  }
  async function perform(type,interact) {
    const pending=page.waitForResponse(response=>response.url()===url+'api/action' &&
      response.request().postDataJSON()?.type===type,{timeout:10000});
    const [response]=await Promise.all([pending,interact()]);
    assert.equal(response.status(),200,await response.text());
    return response.json();
  }
  async function bagLayout(size,columns,lockedSlot) {
    await page.waitForFunction(({size,slot})=>document.querySelectorAll('#container-slots > button').length===size &&
      document.querySelector('#container-slots').getAttribute('aria-busy')==='false' &&
      document.querySelector(`#container-inventory [data-slot="${slot}"]`)?.disabled,{size,slot:lockedSlot});
    assert.equal(await page.locator('#container-slots').evaluate(grid=>getComputedStyle(grid).gridTemplateColumns.split(' ').length),columns);
  }
  async function closeGameBag() {
    await page.locator('#container-close').click();
    await resume();
  }
  await page.evaluate(()=>honeymoon.look(0,1.2));
  const canvas=await perform('bag_open',rightClick);
  assert.equal(canvas.bag.key,'creative:9268:3');
  assert.deepEqual(canvas.bag.slots[4].nbt,bookTag);
  assert.deepEqual(canvas.bag.slots[4].legacyNbt,{ForgeExtra:7});
  await bagLayout(27,9,0);
  const storedBook=page.locator('#container-slots [data-slot="4"]');
  await storedBook.hover();
  const tooltip=page.locator('#container-menu .item-tooltip:not([hidden])');
  assert.match(await tooltip.innerText(),new RegExp(title));
  assert.match(await tooltip.innerText(),/Сохранённая заметка/);
  await page.screenshot({path:join(output,'canvas-bag.png')});
  await storedBook.click();
  const taken=await perform('bag_move',()=>page.locator('#container-inventory [data-slot="9"]').click());
  assert.equal(taken.bag.slots[4],null);
  assert.deepEqual(taken.inventory.slots[9].nbt,bookTag);
  assert.deepEqual(taken.inventory.slots[9].legacyNbt,{ForgeExtra:7});
  await closeGameBag();
  result.checks.push('RMB opens dyed canvas bag; 27 slots and original book name, lore, pages and mod data preserved on transfer');

  await page.keyboard.press('KeyI');
  const inventoryBag=page.locator('#creative-menu [data-slot="0"]');
  await inventoryBag.waitFor({state:'visible'});
  await inventoryBag.locator('canvas').waitFor();
  assert.match(await inventoryBag.getAttribute('aria-label'),/Canvas Bag/);
  assert.equal((await perform('bag_open',()=>inventoryBag.click({button:'right'}))).bag.inventorySlot,0);
  await bagLayout(27,9,0);
  await page.locator('#container-close').click();
  assert.equal(await page.locator('#creative-menu[open]').isVisible(),true);
  await page.locator('#creative-close').click();
  await resume();
  result.checks.push('RMB in player inventory opens a bag and returns to the inventory');

  await perform('inventory_select',()=>page.keyboard.press('Digit2'));
  await page.waitForFunction(()=>document.querySelector('#hotbar .selected-slot')?.dataset.slot==='1');
  await page.keyboard.down('Shift');
  try {
    const seed=await perform('bag_open',rightClick);
    assert.equal(seed.bag.key,'creative:9299:575');
    assert.deepEqual(seed.bag.slots[0].nbt,seedTag);
  } finally {await page.keyboard.up('Shift');}
  await bagLayout(9,3,1);
  await page.screenshot({path:join(output,'seed-bag.png')});
  await closeGameBag();
  await page.evaluate(async ({x,y,z})=>{
    for (let frame=0;frame<3;frame++) {
      const {position,body}=honeymoon.stats();
      const dx=x+.5-position.x, dy=y+.9375-position.y-body.eye, dz=z+.5-position.z;
      honeymoon.look(Math.atan2(-dx,-dz),Math.atan2(dy,Math.hypot(dx,dz)));
      await new Promise(requestAnimationFrame);
    }
  },farmland);
  await page.waitForFunction(({x,y,z})=>{
    const target=honeymoon.target();
    return target?.x===x && target.y===y && target.z===z && target.offset[1]===1;
  },farmland);
  const planted=await perform('bag_plant',rightClick);
  assert.ok(planted.changes.some(cell=>cell.x===farmland.x && cell.y===farmland.y+1 && cell.z===farmland.z && cell.cell==='legacy:59:0'));
  assert.equal(planted.inventory.slots[1].nbt.contents[0].Count,1);
  assert.deepEqual(planted.inventory.slots[1].nbt.contents[0].tag,seedTag);
  result.checks.push('Shift+RMB opens Seed Bag; plain RMB plants wheat and consumes one NBT seed on the server');
  assert.deepEqual(result.errors,[]);
} catch(error) {
  result.failure=error.stack;
  await page?.screenshot({path:join(output,'bags-failure.png')}).catch(()=>{});
  throw error;
} finally {
  await writeFile(join(output,'bags-browser.json'),JSON.stringify(result,null,2)+'\n');
  await page?.evaluate(()=>document.exitPointerLock()).catch(()=>{});
  await browser?.close();
  await app.close();
}
