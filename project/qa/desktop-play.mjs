import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {loadBase} from '../server/base.mjs';
import {createHoneymoonServer} from '../server/index.mjs';
import * as geometry from '../world/geometry.mjs';
import {voxelMaterialAt} from '../world/voxel-chisel.mjs';

const output = process.argv[2] ?? 'work/desktop-play';
const base = loadBase('generated/world');
const browser = await chromium.launch({channel:'msedge', headless: process.env.HONEYMOON_HEADED !== '1'});
const result = {browser:browser.version(), viewport:'1280×720'};

async function scenario(spawn, play) {
  const app = createHoneymoonServer({state:':memory:', geometry, base:{...base, manifest:{...base.manifest, spawn}}});
  const context = await browser.newContext({viewport:{width:1280,height:720}, deviceScaleFactor:1});
  const page = await context.newPage();
  const errors = [], positionResponses = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.url().endsWith('/api/position')) {
      positionResponses.push({status:response.status(), trail:response.request().postDataJSON()?.trail?.length ?? 0});
    }
  });
  try {
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    await page.goto(origin);
    await page.waitForFunction(() => globalThis.honeymoon && !document.querySelector('#play').disabled, null, {timeout:90_000});
    await page.locator('#play').click();
    await page.waitForFunction(() => document.querySelector('#entry').hidden);
    await play(page, origin);
    assert.deepEqual(errors, []);
    assert.ok(positionResponses.length && positionResponses.every(packet => packet.status === 200 && packet.trail));
    return positionResponses.length;
  } finally {
    await context.close();
    await app.close();
  }
}

const snapshot = page => page.evaluate(() => honeymoon.stats());
async function key(page, code, duration) {
  await page.keyboard.down(code);
  try { await page.waitForTimeout(duration); }
  finally { await page.keyboard.up(code); }
}
function frames(before, after) {
  const intervals = after.frameTimes.slice(before.frameTimes.length).sort((a, b) => a - b);
  assert.ok(intervals.length);
  return {count:intervals.length, p95:intervals[Math.ceil(intervals.length * .95) - 1],
    max:intervals.at(-1), over50ms:intervals.filter(interval => interval > 50).length};
}

async function exerciseMicroblocks(page, origin) {
  const before = await snapshot(page);
  const source = {x:-5,y:65,z:-23};
  const destination = {x:-10,y:65,z:-20};
  const aim = (degrees, pitch) => page.evaluate(([yaw, pitch]) => honeymoon.look(yaw, pitch),
    [degrees * Math.PI / 180,pitch * Math.PI / 180]);
  const targeting = async (degrees, pitch, cell, slot) => {
    await aim(degrees, pitch);
    await page.waitForFunction(({x,y,z,slot}) => {
      const hit = honeymoon.target();
      return hit?.x === x && hit.y === y && hit.z === z && (slot === undefined || hit.partSlot === slot);
    }, {...cell,slot});
  };
  const targetPart = async (cell, part) => {
    const seen = await page.evaluate(({cell,part}) => {
      const bounds = part.bounds[0];
      const [x, y, z] = Object.values(cell);
      const middle = [x+(bounds[0]+bounds[3])/16, y+(bounds[1]+bounds[4])/16, z+(bounds[2]+bounds[5])/16];
      const eye = honeymoon.stats().position;
      const aim = point => {
        const [dx,dy,dz] = [point[0]-eye.x, point[1]-eye.y-1.62, point[2]-eye.z];
        const yaw = Math.atan2(-dx,-dz), pitch = Math.atan2(dy,Math.hypot(dx,dz));
        honeymoon.look(yaw,pitch);
        return new Promise(resolve => requestAnimationFrame(() => {
          const target = honeymoon.target();
          resolve(target?.x === x && target.y === y && target.z === z && target.partSlot === part.slot);
        }));
      };
      return (async () => {
        for (const candidate of [middle,
          ...bounds.map((value, index) => middle.map((axis, i) => i === index % 3 ? [x,y,z][i] + value / 8 : axis))]) {
          if (await aim(candidate)) return true;
        }
        return false;
      })();
    }, {cell,part});
    return seen;
  };
  const action = async (type, input) => {
    const response = page.waitForResponse(r => r.url().endsWith('/api/action') && r.request().postDataJSON()?.type === type);
    await input();
    const sent = await response;
    return {status:sent.status(), body:await sent.json()};
  };
  async function copy(degrees, pitch, cell, wanted) {
    await targeting(degrees, pitch, cell, wanted);
    const result = await action('copy_part', () => page.keyboard.press('KeyQ'));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.part.slot, wanted);
    return result.body.part;
  }
  async function place(degrees, pitch, anchor, expected, target = destination) {
    await targeting(degrees, pitch, anchor);
    await page.waitForFunction(({x,y,z}) => {
      const preview = honeymoon.placement();
      return preview?.x === x && preview.y === y && preview.z === z && !preview.blocked;
    },target);
    const {part} = await page.evaluate(() => honeymoon.placement());
    assert.equal(part.material, expected.material);
    assert.equal(part.shape, expected.shape);
    const result = await action('place_part', () => page.mouse.click(640,360,{button:'right'}));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const change = result.body.changes.find(c => c.x === target.x && c.y === target.y && c.z === target.z);
    await page.waitForFunction(({x,y,z,slot}) => honeymoon.getCell(x,y,z)?.parts?.some(p => p.slot === slot),
      {...target,slot:part.slot});
    return {...part, revision:change.revision, count:change.parts.length};
  }

  const plate = await copy(315,-23,source,0);
  const first = await place(90,-37.815,{...destination,y:64},plate);
  const post = await copy(315,-15,source,26);
  const second = await place(96,-39,destination,post);
  const edge = await copy(195,-15,{x:-7,y:65,z:-18},23);
  const third = await place(85,-34,destination,edge);
  assert.deepEqual([first.count,second.count,third.count],[1,2,3]);
  assert.equal(new Set([first.slot,second.slot,third.slot]).size, 3);

  const peer = await browser.newContext();
  try {
    assert.ok((await peer.request.post(`${origin}/api/session`, {data:{}})).ok());
    const removable = await targetPart(destination,second) ? second : third;
    assert.ok(await targetPart(destination,removable), 'A placed detail has an exposed face');
    const {hit} = await page.evaluate(() => honeymoon.target());
    await page.waitForFunction(revision => honeymoon.stats().lastEditRender?.revision >= revision, third.revision);
    await page.screenshot({path:join(output, 'three-parts.png')});
    const foreign = await peer.request.post(`${origin}/api/action`, {data:{type:'remove_part', requestId:'qa-foreign-part',
      ...destination,partSlot:removable.slot,hit,expectedRevision:third.revision}});
    const removed = await foreign.json();
    assert.equal(foreign.status(),200,JSON.stringify(removed));
    assert.deepEqual(removed.changes[0].parts.map(p => p.slot).sort((a,b) => a-b),
      [first,second,third].filter(part => part.slot !== removable.slot).map(part => part.slot).sort((a,b) => a-b));
    await page.waitForFunction(revision => honeymoon.stats().lastEditRender?.revision >= revision,removed.worldRevision);
  } finally { await peer.close(); }

  await targeting(315,-23,source,0);
  const protectedPart = await action('remove_part', () => page.mouse.click(640,360,{button:'left'}));
  assert.equal(protectedPart.status,403);
  assert.equal(protectedPart.body.error,'part_not_owned');
  const builtAt = {x:-7,y:65,z:-18};
  const mixed = await place(195,-15,builtAt,edge,builtAt);
  assert.equal(mixed.count,3);
  assert.ok(await targetPart(builtAt,mixed),'Added part remains individually reachable on the map assembly');
  const mixedRemoved = await action('remove_part', () => page.mouse.click(640,360,{button:'left'}));
  assert.equal(mixedRemoved.status,200,JSON.stringify(mixedRemoved.body));
  assert.deepEqual(mixedRemoved.body.changes[0].parts.map(p => p.slot), [19,23]);

  // One free plate goes directly on a copy of itself. In chisel mode a
  // selected full-block material can then be attached to that same cell.
  await copy(315,-23,source,0);
  await targeting(90,-37.815,destination,first.slot);
  const secondPlate = await place(90,-37.815,destination,plate);
  assert.equal(secondPlate.bounds[0][1],first.bounds[0][4]);
  assert.equal(secondPlate.material,first.material);
  assert.ok(secondPlate.slot !== first.slot);
  await page.keyboard.press('KeyV');
  await page.waitForFunction(() => honeymoon.stats().chiseling);
  const fullBlock = {x:-9,y:64,z:-20};
  const [yaw,pitch] = await page.evaluate(({x,y,z}) => {
    const eye = honeymoon.stats().position;
    const [dx,dy,dz] = [x+.65-eye.x,y+1-eye.y-1.62,z+.55-eye.z];
    return [Math.atan2(-dx,-dz),Math.atan2(dy,Math.hypot(dx,dz))].map(value => value * 180 / Math.PI);
  },fullBlock);
  await targeting(yaw,pitch,fullBlock);
  const copyMaterial = await action('copy_voxel', () => page.keyboard.press('KeyQ'));
  assert.ok(copyMaterial.body.material);
  assert.ok(await targetPart(destination,secondPlate));
  await page.waitForFunction(({x,y,z}) => {
    const preview = honeymoon.placement();
    return preview?.x === x && preview.y === y && preview.z === z && !preview.blocked;
  },destination);
  const voxel = await page.evaluate(() => honeymoon.placement().voxel);
  const joined = await action('place_voxel',()=>page.mouse.click(640,360,{button:'right'}));
  assert.equal(joined.status,200,JSON.stringify(joined.body));
  const edited = joined.body.changes[0];
  assert.ok(edited.parts.some(p => p.slot === secondPlate.slot));
  assert.equal(voxelMaterialAt(edited.voxels,voxel),copyMaterial.body.material);
  await page.waitForFunction(revision => honeymoon.stats().lastEditRender?.revision >= revision, edited.revision);
  await page.screenshot({path:join(output,'hybrid-stack.png')});
  await page.keyboard.press('KeyX');
  await page.waitForFunction(() => !honeymoon.placement() && !honeymoon.stats().chiselMaterial);
  await page.mouse.click(640,360,{button:'right'});
  assert.equal(await page.evaluate(() => honeymoon.stats().revision),edited.revision);
  await page.keyboard.press('KeyV');

  const after = await snapshot(page);
  assert.equal(after.movementSync.corrections, 0);
  assert.equal(after.movementSync.errors, 0);
  return {x:destination.x,y:destination.y,z:destination.z, slots:[first.slot,second.slot,third.slot],
    protectedPart:protectedPart.status, foreignPart:403, preservedImportedSlots:[19,23],
    combined:{plate:secondPlate.bounds, voxel, material:copyMaterial.body.material, clear:true}, frames:frames(before, after)};
}

try {
  await mkdir(output, {recursive:true});
  if (process.env.HONEYMOON_BUILDING_ONLY === '1') {
    result.spawnPackets = await scenario(base.manifest.spawn, async (page, origin) => {
      result.microblocks = await exerciseMicroblocks(page, origin);
      await key(page,'KeyW',250);
      await page.waitForTimeout(180);
    });
  } else {
    result.spawnPackets = await scenario(base.manifest.spawn, async (page, origin) => {
    const entry = await snapshot(page);
    assert.ok(entry.chunksLoaded < base.manifest.chunks.length, 'Entry should open before all chunks arrive');
    await page.evaluate(() => honeymoon.look(0, -.08));
    await key(page, 'KeyW', 2100);
    const walked = await snapshot(page);
    assert.ok(walked.position.z < entry.position.z - 4, 'Player should move immediately while the map streams');
    await page.keyboard.down('KeyS');
    try {
      for (const degrees of [0,165,345,120,300,90,270,15]) {
        await page.evaluate(radians => honeymoon.look(radians, -.12), degrees * Math.PI / 180);
        await page.waitForTimeout(230);
      }
    } finally { await page.keyboard.up('KeyS'); }
    await page.waitForTimeout(180);
    const turned = await snapshot(page);
    assert.equal(turned.movementSync.corrections, 0);
    assert.equal(turned.movementSync.errors, 0);
    result.startup = {milliseconds:entry.playable, chunksAtEntry:entry.chunksLoaded, chunksAfterTurns:turned.chunksLoaded};
    result.walk = {from:entry.position, to:walked.position, frames:frames(entry, walked)};
    result.turns = {count:8, frames:frames(walked, turned)};
    await page.screenshot({path:join(output, 'spawn.png')});

    await page.evaluate(() => document.exitPointerLock());
    await page.locator('#reset').click();
    await page.waitForFunction(z => honeymoon.stats().position.z === z, base.manifest.spawn[2]);
    await page.locator('#play').click();
    await page.waitForFunction(() => document.querySelector('#entry').hidden);
    await page.evaluate(() => honeymoon.look(Math.PI / 2, -.66));
    await page.waitForFunction(() => {
      const hit = honeymoon.target();
      return hit?.x === -10 && hit?.y === 64 && hit?.z === -20 && hit.offset[1] === 1;
    });
    const target = await page.evaluate(() => {
      const {x,y,z,cell} = honeymoon.target();
      return {x,y,z,key:typeof cell === 'string' ? cell : cell.key};
    });
    const action = (page, click) => Promise.all([page.waitForResponse(response => response.url().endsWith('/api/action')), click]);
    const [denied] = await action(page, page.mouse.down({button:'left'}));
    await page.mouse.up({button:'left'});
    assert.equal(denied.status(), 403);
    assert.equal((await denied.json()).error, 'block_not_owned');
    await page.keyboard.press('KeyQ');
    await page.waitForFunction(() => document.querySelector('#selected').textContent.includes('В руке'));
    const [placed] = await action(page, page.mouse.down({button:'right'}));
    await page.mouse.up({button:'right'});
    const placedBody = await placed.json();
    assert.equal(placed.status(), 200, JSON.stringify(placedBody));
    const placement = placedBody.changes[0];
    assert.equal(placement.cell, target.key);
    const peer = await browser.newContext();
    try {
      assert.ok((await peer.request.post(`${origin}/api/session`, {data:{}})).ok());
      const {x,y,z,revision} = placement;
      const other = await peer.request.post(`${origin}/api/action`, {data:{type:'remove', requestId:'other-owner', x,y,z, expectedRevision:revision}});
      const sharedRemoval = await other.json();
      assert.equal(other.status(), 200, JSON.stringify(sharedRemoval));
      assert.equal(sharedRemoval.changes[0].cell,null);
      await page.waitForFunction(revision => honeymoon.stats().revision >= revision,sharedRemoval.worldRevision);
    } finally { await peer.close(); }
    await page.waitForFunction(({x,y,z}) => {
      const hit = honeymoon.target();
      return hit?.x === x && hit?.y === y - 1 && hit?.z === z;
    }, placement);
    const [replaced] = await action(page, page.mouse.down({button:'right'}));
    await page.mouse.up({button:'right'});
    assert.equal(replaced.status(),200);
    await page.waitForFunction(({x,y,z}) => honeymoon.target()?.x === x && honeymoon.target()?.y === y && honeymoon.target()?.z === z, placement);
    const [removed] = await action(page, page.mouse.down({button:'left'}));
    await page.mouse.up({button:'left'});
    assert.equal(removed.status(), 200);
    assert.equal((await removed.json()).changes[0].cell, null);
    result.breaking = {original:403, otherPlayer:200, creator:200};
    result.microblocks = await exerciseMicroblocks(page, origin);
    await page.evaluate(() => honeymoon.look(Math.PI / 2, -.12));

    await page.keyboard.press('KeyF');
    await page.waitForFunction(() => honeymoon.stats().flying);
    const lift = await snapshot(page);
    await page.keyboard.down('Space');
    await page.keyboard.down('KeyW');
    try {
      await page.waitForFunction(y => honeymoon.stats().position.y > y + 2, lift.position.y);
    } finally {
      await page.keyboard.up('Space');
      await page.keyboard.up('KeyW');
    }
    await page.waitForTimeout(220);
    const hover = await snapshot(page);
    assert.ok(hover.position.x < lift.position.x - 1.4);
    await page.waitForTimeout(220);
    assert.deepEqual((await snapshot(page)).position, hover.position);
    await page.keyboard.down('ControlLeft');
    try { await page.waitForFunction(y => honeymoon.stats().position.y < y - 1, hover.position.y); }
    finally { await page.keyboard.up('ControlLeft'); }
    await page.keyboard.press('KeyF');
    await page.waitForFunction(() => !honeymoon.stats().flying);
    await page.waitForTimeout(240);
    const descent = await snapshot(page);
    assert.ok(descent.position.y < hover.position.y - 1);
    assert.equal(descent.movementSync.corrections, 0);
    assert.equal(descent.movementSync.errors, 0);
    result.flight = {from:lift.position, hover:hover.position, afterDescent:descent.position};
  });

    result.cornerPackets = await scenario([-8,65,-17.5], async page => {
    await page.evaluate(() => honeymoon.look(3 * Math.PI / 4, 0));
    await key(page, 'KeyW', 620);
    await page.waitForTimeout(220);
    const {position, movementSync} = await snapshot(page);
    assert.ok(position.x < -9 && position.z > -17.2, `Player could not round the RedPower corner ${JSON.stringify(position)}`);
    assert.equal(movementSync.corrections, 0);
    assert.equal(movementSync.errors, 0);
    result.redPowerCorner = {position, movementSync};
    });
  }
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
