import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {loadBase} from '../server/base.mjs';
import {createHoneymoonServer} from '../server/index.mjs';
import * as geometry from '../world/geometry.mjs';

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

try {
  await mkdir(output, {recursive:true});
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
      assert.equal(other.status(), 403);
      assert.equal((await other.json()).error, 'block_not_owned');
    } finally { await peer.close(); }
    await page.waitForFunction(({x,y,z}) => {
      const hit = honeymoon.target();
      return hit?.x === x && hit?.y === y && hit?.z === z;
    }, placement);
    const [removed] = await action(page, page.mouse.down({button:'left'}));
    await page.mouse.up({button:'left'});
    assert.equal(removed.status(), 200);
    assert.equal((await removed.json()).changes[0].cell, null);
    result.breaking = {original:403, otherPlayer:403, owner:200};
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
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
