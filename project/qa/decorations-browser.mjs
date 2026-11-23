import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {createHoneymoonServer} from '../server/index.mjs';
import * as geometry from '../world/geometry.mjs';
import {paintingAt,paintingItemKey,paintingMount} from '../world/paintings.mjs';

const generated=process.env.HONEYMOON_QA_GENERATED;
const output=process.argv[2] && resolve(process.argv[2]);
if (!generated || !output) throw new Error('Provide HONEYMOON_QA_GENERATED and an output directory');
await mkdir(output,{recursive:true});

const importedPainting={...paintingAt([1,66,3],3,'Aztec2'),key:'entity:qa-painting',placed:false};
const importedFrame={type:'ItemFrame',key:'entity:qa-frame',position:[3.5,66.5,4.0625],
  data:{TileX:3,TileY:66,TileZ:3,Direction:0,Dir:2,ItemRotation:0}};
const entities=[importedPainting,importedFrame];
const bounds={minX:0,maxX:15,minY:0,maxY:255,minZ:0,maxZ:15};
const palette=['air','legacy:1:0'];
const hash='ab'.repeat(32);
const hasPlayableChunk=(x,z)=>x===0&&z===0;
const inBounds=(x,y,z)=>x>=0&&x<16&&y>=0&&y<256&&z>=0&&z<16;
// Keep the spawn platform inside radius 1 so the test's clear sightline does not get a diagnostic gate.
const isStone=(x,y,z)=>y===64 && x>=0&&x<=2&&z>=6&&z<=8 || x>=0&&x<=6&&y>=65&&y<=68&&z===3;
const indices=Buffer.alloc(8192);
for (let y=64;y<=68;y++) for (let z=0;z<16;z++) for (let x=0;x<16;x++) {
  if (isStone(x,y,z)) indices.writeUInt16LE(1,2*(x+z*16+(y&15)*256));
}
const manifest={bounds,spawn:[1.5,65,7.5],chunks:[[0,0]],terrain:[],palette,compositions:{},
  schemaVersion:1,importVersion:1,catalogVersion:1,contentHash:hash,chunkPalettes:true};
const base={manifest,hash,catalog:new Set(palette),inBounds,hasPlayableChunk,worldCoverage:hasPlayableChunk,
  getCell:(x,y,z)=>({key:isStone(x,y,z)?palette[1]:palette[0],object:null}),
  getEntity:(_x,_z,key)=>entities.find(entity=>entity.key===key),
  publicDecorations:(x,z)=>hasPlayableChunk(x,z)?entities:[],
  publicChunk:(x,z)=>hasPlayableChunk(x,z)?{x,z,palette,compositions:{},objects:[],entities,
    sections:[{y:4,indices:indices.toString('base64')}]}:null};

const ownerKey='qa-decoration-owner';
const app=createHoneymoonServer({base,generated,geometry,state:':memory:',npcAdminKey:ownerKey,
  ownerOnPrimary:true,inviteRequired:true,initialMode:'creative'});
app.server.listen(0,'127.0.0.1');
await once(app.server,'listening');
const url=`http://127.0.0.1:${app.server.address().port}/`;
const results={checks:[],pageErrors:[]};
let browser,page;

try {
  browser=await chromium.launch({channel:'msedge',args:['--enable-unsafe-swiftshader']});
  page=await browser.newPage({viewport:{width:1000,height:640},serviceWorkers:'block'});
  page.on('pageerror',error=>results.pageErrors.push(error.message));
  const login=await page.request.post(url+'api/access/owner',{data:{key:ownerKey,profileName:'Проверка картин'}});
  assert.equal(login.status(),200,await login.text());
  const {playerId}=await login.json();
  const grant=app.game.action(playerId,{requestId:randomUUID(),type:'inventory_give',slot:0,key:paintingItemKey,count:1});
  assert.equal(grant.status,200,JSON.stringify(grant.output));
  await page.goto(url,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>globalThis.honeymoon?.stats().playable>0,undefined,{timeout:60_000});
  const play=page.locator('#play');
  if (await play.isVisible()) await play.click();
  else await page.locator('#scene canvas').click();
  await page.waitForFunction(()=>Boolean(document.pointerLockElement));

  async function look(point) {
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

  async function click(button,type) {
    const pending=page.waitForResponse(value=>value.url()===url+'api/action' && value.request().postDataJSON()?.type===type,
      {timeout:12_000});
    await page.mouse.click(500,320,{button});
    const response=await pending;
    assert.equal(response.status(),200,await response.text());
    return response.json();
  }

  const hasLabel=text=>page.waitForFunction(text=>document.getElementById('selected-label').textContent.includes(text),text,
    {timeout:12_000});
  await look(importedPainting.position);
  await hasLabel('Картина');
  const removed=await click('left','frame_remove');
  assert.equal(removed.frames.find(entry=>entry.key===importedPainting.key)?.removed,true);
  await look([1.5,66.5,4]);
  await page.waitForFunction(()=>!document.getElementById('selected-label').textContent.includes('Картина'));
  const placed=await click('right','place_frame');
  const painting=placed.frames.find(entity=>entity.type==='Painting'&&entity.placed);
  assert.ok(painting);
  assert.deepEqual(paintingMount(painting).normal,[0,0,1]);
  results.checks.push('removed original painting and placed a new painting on the wall');

  await look(painting.position);
  await hasLabel('Картина');
  await page.screenshot({path:join(output,'decorations-browser-placed.png')});
  const removedPlaced=await click('left','frame_remove');
  assert.equal(removedPlaced.frames.some(entity=>entity.key===painting.key),false);
  await look(importedFrame.position);
  await hasLabel('Рамка');
  const removedFrame=await click('left','frame_remove');
  assert.equal(removedFrame.frames.find(entry=>entry.key===importedFrame.key)?.removed,true);
  assert.equal(await page.evaluate(()=>honeymoon.getCell(3,66,3)),palette[1]);
  assert.deepEqual(results.pageErrors,[]);
  results.checks.push('removed the new painting and an original empty frame while keeping the wall');
  await page.screenshot({path:join(output,'decorations-browser.png')});
} catch (error) {
  results.failure=error.stack;
  results.at=await page?.evaluate(()=>({label:document.getElementById('selected-label')?.textContent,
    position:globalThis.honeymoon?.stats().position,eye:globalThis.honeymoon?.localAvatar()?.eyes,
    target:globalThis.honeymoon?.target(),locked:Boolean(document.pointerLockElement)})).catch(()=>undefined);
  await page?.screenshot({path:join(output,'decorations-browser-failure.png'),timeout:5000}).catch(()=>{});
  throw error;
} finally {
  await browser?.close();
  await app.close();
  await writeFile(join(output,'decorations-browser.json'),JSON.stringify(results,null,2)+'\n');
}
