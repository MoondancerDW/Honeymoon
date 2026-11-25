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

const palette=['air','legacy:1:0'];
const fixtures=new Set(['5,66,8','11,66,8','8,66,5','8,66,11','9,69,7','5,66,10','11,66,10']);
const cellIndex=(x,y,z)=>Number(y===64||fixtures.has(`${x},${y},${z}`));
const hash='ae'.repeat(32);
const coverage=(x,z)=>x===0&&z===0;
const indices=Buffer.alloc(8192);
for (let y=64;y<70;y++) for (let z=0;z<16;z++) for (let x=0;x<16;x++) {
  indices.writeUInt16LE(cellIndex(x,y,z),2*(x+16*z+256*(y&15)));
}
const bounds={minX:0,maxX:15,minY:0,maxY:255,minZ:0,maxZ:15};
const manifest={bounds,spawn:[8.5,65,8.5],chunks:[[0,0]],terrain:[],palette,compositions:{},
  schemaVersion:1,importVersion:1,catalogVersion:1,contentHash:hash,chunkPalettes:true};
const base={manifest,hash,catalog:new Set(palette),hasPlayableChunk:coverage,worldCoverage:coverage,
  inBounds:(x,y,z)=>x>=0&&x<16&&y>=0&&y<256&&z>=0&&z<16,
  getCell:(x,y,z)=>({key:palette[cellIndex(x,y,z)],object:null}),
  publicChunk:(x,z)=>coverage(x,z)?{x,z,palette,compositions:{},objects:[],entities:[],
    sections:[{y:4,indices:indices.toString('base64')}]}:null};

const state=join(output,'orientation.sqlite');
const store=openStore(state);
store.putState('diagnostic','world','layout',1,{switch:[0,65,0],door:[[1,65,0],[1,66,0]]});
store.close();
const ownerKey='qa-placement-orientation';
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
  const login=await page.request.post(url+'api/access/owner',{data:{key:ownerKey,profileName:'Проверка ориентации'}});
  assert.equal(login.status(),200,await login.text());
  const {playerId}=await login.json();
  const loadout=['legacy:219:4','legacy:219:8','legacy:219:0','legacy:54:0','legacy:205:0',
    'legacy:2255:4','creative:397:4','legacy:219:4','creative:753:0'];
  for (const [slot,key] of loadout.entries()) {
    const grant=app.game.action(playerId,{requestId:randomUUID(),type:'inventory_give',slot,key,count:1});
    assert.equal(grant.status,200,`${key}: ${JSON.stringify(grant.output)}`);
  }
  await page.goto(url,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>globalThis.honeymoon?.stats().playable>0,undefined,{timeout:60000});
  if (await page.locator('#play').isVisible()) await page.locator('#play').click();
  else await page.locator('#scene canvas').click();
  await page.waitForFunction(()=>Boolean(document.pointerLockElement));

  async function aim(point) {
    await page.evaluate(async point=>{
      for (let frame=0;frame<3;frame++) {
        const {position,body}=honeymoon.stats();
        const [x,y,z]=honeymoon.localAvatar()?.eyes??[position.x,position.y+body.eye,position.z];
        const dx=point[0]-x,dy=point[1]-y,dz=point[2]-z;
        honeymoon.look(Math.atan2(-dx,-dz),Math.atan2(dy,Math.hypot(dx,dz)));
        await new Promise(requestAnimationFrame);
      }
    },point);
  }

  const actionResponse=type=>page.waitForResponse(response=>response.url()===url+'api/action' &&
    response.request().postDataJSON()?.type===type,{timeout:8000});
  async function select(slot) {
    const pending=actionResponse('inventory_select');
    await page.keyboard.press(`Digit${slot+1}`);
    const response=await pending;
    assert.equal(response.status(),200,await response.text());
  }
  async function place(point,status=200) {
    await aim(point);
    const pending=actionResponse('place');
    await page.mouse.click(500,320,{button:'right'});
    const response=await pending;
    assert.equal(response.status(),status,`${point}: ${await response.text()}`);
    return response.json();
  }

  const wallLights=[[[5.98,66.5,8.5],5],[[11.02,66.5,8.5],7],[[8.5,66.5,5.98],6],[[8.5,66.5,11.02],4]];
  for (const [point,meta] of wallLights.slice(0,3)) {
    assert.equal((await place(point)).changes[0].cell,`legacy:219:${meta}`);
  }
  assert.equal((await place([7.5,64.99,6.5],409)).error,'invalid_mount_face');
  result.checks.push('Jammy lantern uses three wall faces in creative and rejects the top of a block');

  await select(1);
  assert.equal((await place([7.5,64.99,6.5])).changes[0].cell,'legacy:219:8');
  await select(2);
  assert.equal((await place([9.5,69.02,7.5])).changes[0].cell,'legacy:219:0');
  result.checks.push('Jammy table lamp and ceiling light use the correct mounting surfaces');

  await select(3);
  assert.equal((await place([6.5,64.99,7.5])).changes[0].cell,'legacy:54:5');
  assert.equal((await place([10.5,64.99,7.5])).changes[0].cell,'legacy:54:4');
  await select(4);
  const first=(await place([6.5,64.99,10.5])).changes[0].cell;
  const second=(await place([10.5,64.99,10.5])).changes[0].cell;
  assert.ok(first!==second && [first,second].every(cell=>/^legacy:205:[0-3]$/.test(cell)));
  result.checks.push('chest and Jammy fridge front faces follow the viewing direction and preserve the item type');

  await select(5);
  const caseOnFloor=(await place([9.5,64.99,6.5])).changes[0];
  assert.equal(caseOnFloor.cell,'legacy:2255:4');
  assert.ok(caseOnFloor.object.data.caseAngle<4);
  const caseOnWall=(await place([5.98,66.5,10.5])).changes[0];
  assert.equal(caseOnWall.cell,caseOnFloor.cell);
  assert.equal(caseOnWall.object.data.caseAngle,6);
  await select(6);
  const skull=(await place([7.5,64.99,10.5])).changes[0];
  assert.equal(skull.cell,'legacy:144:1');
  assert.equal(skull.object.data.SkullType,4);
  assert.ok(skull.object.data.Rot>0 && skull.object.data.Rot<16);
  result.checks.push('BiblioCraft case fits floors and walls and creeper head preserves its type and yaw');

  await select(8);
  const gate=(await place([11.02,66.5,10.5])).changes[0];
  assert.equal(gate.cell,'legacy:753:0');
  assert.equal(gate.object.data.rot>>2,5);
  result.checks.push('RedPower logic board mounts on a wall and keeps the selected gate type');

  await select(7);
  const mode=await page.request.post(url+'api/modes',{data:{target:playerId,mode:'game'}});
  assert.equal(mode.status(),200,await mode.text());
  await page.waitForFunction(()=>honeymoon.health()?.mode==='game');
  const [point,meta]=wallLights[3];
  const wallInSurvival=await place(point);
  assert.equal(wallInSurvival.changes[0].cell,`legacy:219:${meta}`);
  assert.equal(wallInSurvival.inventory.slots[7],null);
  result.checks.push('Jammy lantern uses the fourth wall face in survival');
  assert.deepEqual(result.errors,[]);
  await page.screenshot({path:join(output,'placement-orientation.png')});
} catch (error) {
  result.failure=error.stack;
  await page?.screenshot({path:join(output,'placement-orientation-failure.png')}).catch(()=>{});
  throw error;
} finally {
  await browser?.close();
  await app.close();
  await writeFile(join(output,'placement-orientation.json'),JSON.stringify(result,null,2)+'\n');
}
