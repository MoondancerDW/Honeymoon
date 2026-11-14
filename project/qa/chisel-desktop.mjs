import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {createHoneymoonServer} from '../server/index.mjs';
import * as geometry from '../world/geometry.mjs';
import {voxelIndex, voxelMaterialAt} from '../world/voxel-chisel.mjs';

const output = process.argv[2] ?? 'work/chisel/desktop';
const destination = {x:-10,y:65,z:-20};
const floor = {...destination,y:64};
const app = createHoneymoonServer({state:':memory:',geometry});
const browser = await chromium.launch({channel:'msedge',headless:process.env.HONEYMOON_HEADED !== '1'});
const page = await browser.newPage({viewport:{width:1280,height:720}});
const errors = [], positionResponses = [], actions = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => {
  if (response.url().endsWith('/api/position')) positionResponses.push(response.status());
});
const snapshot = () => page.evaluate(() => honeymoon.stats());

async function action(type, control, status = 200) {
  const sent = page.waitForResponse(response => response.url().endsWith('/api/action') &&
    response.request().postDataJSON()?.type === type, {timeout:8_000});
  await control();
  const response = await sent;
  const body = await response.json();
  assert.equal(response.status(),status,JSON.stringify(body));
  actions.push({type,status,revision:body.worldRevision});
  return body;
}

async function aim(point, cell, voxel) {
  await page.evaluate(([x,y,z]) => {
    const eye = honeymoon.stats().position;
    const dx = x-eye.x, dy = y-eye.y-1.62, dz = z-eye.z;
    honeymoon.look(Math.atan2(-dx,-dz),Math.atan2(dy,Math.hypot(dx,dz)));
  },point);
  await page.waitForFunction(({x,y,z,voxel}) => {
    const target = honeymoon.target();
    return target?.x === x && target.y === y && target.z === z && (voxel === undefined || target.voxel === voxel);
  },{...cell,voxel},{timeout:5_000});
}

const click = button => () => page.mouse.click(640,360,{button});
const rendered = revision => page.waitForFunction(revision => honeymoon.stats().lastEditRender?.revision >= revision,
  revision,{timeout:8_000});

function frames(before, after) {
  const values = after.frameTimes.slice(before.frameTimes.length).sort((a,b)=>a-b);
  assert.ok(values.length);
  const round = value => Number(value.toFixed(2));
  return {count:values.length,p95:round(values[Math.ceil(values.length*.95)-1]),max:round(values.at(-1)),
    over50ms:values.filter(value=>value>50).length};
}

try {
  await mkdir(output,{recursive:true});
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  await page.goto(origin);
  await page.waitForFunction(() => globalThis.honeymoon && !document.querySelector('#play').disabled,null,{timeout:90_000});
  await page.locator('#play').click();
  await page.waitForFunction(() => document.querySelector('#entry').hidden);
  const before = await snapshot();

  await aim([-9.52,65,-19.47],floor);
  const copy = await action('copy',()=>page.keyboard.press('KeyQ'));
  assert.equal(copy.cell,'legacy:2:0');
  await page.waitForFunction(() => document.querySelector('#selected').textContent.includes('В руке'));
  const originalPlacement = await action('place',click('right'));
  assert.equal(originalPlacement.changes[0].cell,copy.cell);
  await rendered(originalPlacement.worldRevision);

  await page.keyboard.press('KeyV');
  await page.waitForFunction(()=>honeymoon.stats().chiseling);
  const sourceIndex = voxelIndex(7,5,3);
  await aim([-9,65.6875,-19.5625],destination,sourceIndex);
  const material = (await action('copy_voxel',()=>page.keyboard.press('KeyQ'))).material;
  assert.equal(material,copy.cell);
  await page.waitForFunction(material => honeymoon.stats().chiselMaterial === material,material);

  const editStart = await snapshot();
  const holes = [];
  let state;
  for (const [y,z] of [[4,2],[4,3],[4,4],[5,2],[5,3],[5,4],[6,2],[6,3],[6,4],[7,3]]) {
    const index = voxelIndex(7,y,z);
    await aim([-9,65+(y+.5)/8,-20+(z+.5)/8],destination,index);
    const response = await action('remove_voxel',click('left'));
    state = response.changes[0];
    assert.equal(voxelMaterialAt(state.voxels,index),null);
    holes.push({index,y,z});
    await page.waitForFunction(revision => honeymoon.stats().revision >= revision,response.worldRevision);
  }
  await rendered(state.revision);
  for (const hole of holes) assert.equal(voxelMaterialAt(state.voxels,hole.index),null);
  assert.equal(voxelMaterialAt(state.voxels,voxelIndex(6,5,3)),material);
  await page.screenshot({path:join(output,'sculpture.png')});

  // The face behind a removed eighth is now visible through the recess.
  for (const {index,y,z} of holes.slice(0,6)) {
    await aim([-9.125,65+(y+.5)/8-.038,-20+(z+.5)/8],destination,voxelIndex(6,y,z));
    await page.waitForFunction(index => {
      const preview = honeymoon.placement();
      return preview?.voxel === index && !preview.blocked;
    },index);
    const response = await action('place_voxel',click('right'));
    state = response.changes[0];
    assert.equal(voxelMaterialAt(state.voxels,index),material);
    await page.waitForFunction(revision => honeymoon.stats().revision >= revision,response.worldRevision);
  }
  await rendered(state.revision);

  await aim([-8.12,65,-19.45],{x:-9,y:64,z:-20});
  const protectedCell = await action('remove_voxel',click('left'),403);
  assert.equal(protectedCell.error,'voxel_not_owned');

  await aim([-9.52,65,-20.48],{x:-10,y:64,z:-21});
  const adjoining = {x:-10,y:65,z:-21};
  await page.waitForFunction(({x,y,z}) => {
    const preview = honeymoon.placement();
    return preview?.x === x && preview.y === y && preview.z === z && !preview.blocked;
  },adjoining);
  const outside = await action('place_voxel',click('right'));
  const newCell = outside.changes[0];
  assert.deepEqual([newCell.x,newCell.y,newCell.z],Object.values(adjoining));
  await rendered(outside.worldRevision);
  const editEnd = await snapshot();
  assert.equal(editEnd.movementSync.corrections,0);
  assert.equal(editEnd.movementSync.errors,0);

  await aim([-8.12,65,-19.45],{x:-9,y:64,z:-20});
  await page.waitForFunction(() => {
    const preview = honeymoon.placement();
    return preview?.x === -9 && preview.y === 65 && preview.z === -20 && !preview.blocked;
  });
  const actionUrl = '**/api/action';
  let beginWalk;
  const requestPaused = new Promise(resolve => { beginWalk = resolve; });
  await page.route(actionUrl, async route => {
    beginWalk();
    await new Promise(resolve => setTimeout(resolve, 300));
    await route.continue();
  },{times:1});
  const delayedPlacement = action('place_voxel',click('right'));
  await Promise.race([requestPaused,delayedPlacement]);
  await page.evaluate(() => honeymoon.look(Math.PI / 2, -.1));
  await page.keyboard.down('KeyW');
  try { await delayedPlacement; }
  finally { await page.keyboard.up('KeyW'); }
  await page.waitForTimeout(400);
  const inFlight = await snapshot();
  assert.equal(inFlight.movementSync.corrections,0);
  assert.equal(inFlight.movementSync.errors,0);
  assert.ok(inFlight.position.x < before.position.x - .1);

  await page.keyboard.down('KeyW');
  try {
    for (const yaw of [0,165,345,120,300,90,270,15]) {
      await page.evaluate(yaw=>honeymoon.look(yaw*Math.PI/180,-.1),yaw);
      await page.waitForTimeout(250);
    }
  } finally { await page.keyboard.up('KeyW'); }
  await page.waitForTimeout(200);
  const after = await snapshot();
  assert.ok(positionResponses.length && positionResponses.every(status=>status===200));
  assert.ok(Math.hypot(after.position.x-before.position.x,after.position.z-before.position.z)>.25);
  assert.equal(after.movementSync.corrections,0);
  assert.equal(after.movementSync.errors,0);
  assert.deepEqual(errors,[]);

  const report = {browser:browser.version(), viewport:'1280×720', edits:18, positionResponses:positionResponses.length,
    editing:frames(editStart,editEnd), movingAndTurning:frames(inFlight,after), movementSync:after.movementSync,
    editWithMovement:{extraRequestDelayMs:300, before:editEnd.position, after:inFlight.position, corrections:inFlight.movementSync.corrections},
    lastEditRender:editEnd.lastEditRender,actions,errors};
  await writeFile(join(output,'result.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {
  await browser.close();
  await app.close();
}
