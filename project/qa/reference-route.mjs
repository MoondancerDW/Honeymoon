import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { Movement } from '../client/movement.mjs';
import { loadBase } from '../server/base.mjs';
import { createHoneymoonServer } from '../server/index.mjs';
import { physics } from '../server/physics.mjs';
import * as geometry from '../world/geometry.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const size = {width: 1280, height: 720};

// Positions refer to feet. Positive Minecraft yaw turns west and pitch looks down.
export const poses = [
  {id:'01-spawn', feet:[-7.5,65,-19.5], yaw:180, pitch:3},
  {id:'02-street', feet:[-7.5,65,-32.5], yaw:180, pitch:0},
  {id:'03-corner', feet:[-7.5,65,-58.5], yaw:90, pitch:2},
  {id:'04-facade', feet:[-23.5,65,-58.5], yaw:90, pitch:0},
  {id:'05-door', feet:[-30.5,65,-57.5], yaw:180, pitch:12},
  {id:'06-armchair', feet:[-31.5,65,-60.5], yaw:90, pitch:26},
];

export const waypoints = [
  [-7.5,65,-19.5], [-7.5,65,-58.5], [-27,65,-58.5],
  [-27,65,-57], [-30.5,65,-57], [-30.5,65,-57.5], [-30.5,65,-60.5], [-31.5,65,-60.5],
];

const asPoint = ([x,y,z]) => ({x,y,z});
const radians = degrees => degrees * Math.PI / 180;

function routePositions() {
  return waypoints.slice(1).flatMap((to, index) => {
    const from = waypoints[index];
    const count = Math.round(Math.hypot(...to.map((value, axis) => value - from[axis])) * 2);
    return Array.from({length:count}, (_, step) => to.map((value, axis) => from[axis] + (value - from[axis]) * (step + 1) / count));
  });
}

function cellAt(base, doorOpen, x,y,z) {
  const cell = base.getCell(x,y,z);
  if (doorOpen && x === -31 && y === 65 && z === -59) return {...cell, key:'legacy:64:7'};
  const composition = base.manifest.compositions[cell.key];
  return composition ? {...cell,...composition} : cell;
}

function checkRoute(base) {
  let doorOpen = false;
  const getCell = (x,y,z) => cellAt(base, doorOpen, x,y,z);
  const physical = physics(base, geometry, getCell);
  const movement = new Movement({manifest:base.manifest, hasChunk:() => true, cellAt:getCell});
  const spawn = asPoint(waypoints[0]);
  let from = spawn;
  const walking = {...spawn};
  let distance = 0;
  for (const point of routePositions()) {
    if (from.x === -30.5 && from.z === -57.5) doorOpen = true;
    const to = asPoint(point);
    assert.ok(physical.collides({...to,y:to.y-.03}), 'Unsupported route point ' + point);
    assert.ok(physical.movementAllowed(from,to), 'Blocked route point ' + point);
    const dx = to.x - from.x, dz = to.z - from.z;
    for (let i=0;i<10;i++) movement.update(walking, dx * 8, dz * 8, false, .0125);
    assert.ok(Math.hypot(walking.x-to.x,walking.y-to.y,walking.z-to.z)<.015, 'Client movement diverged at ' + point);
    distance += Math.hypot(dx,dz);
    from = to;
  }
  assert.deepEqual(from,asPoint(waypoints.at(-1)));
  return {distance, from:spawn, to:from, door:[-31,65,-59], movementSteps:routePositions().length};
}

async function walkOnServer(page, origin, tick) {
  const post = async (path, payload) => {
    const result = await page.request.post(origin + path, {data:payload});
    const body = await result.json();
    assert.equal(result.status(),200, path + ' ' + JSON.stringify(payload) + ': ' + JSON.stringify(body));
    return body;
  };
  const start = await post('/api/session', {});
  assert.deepEqual(start.position, asPoint(waypoints[0]));
  for (const point of routePositions()) {
    tick();
    await post('/api/position', asPoint(point));
    if (point[0] === -30.5 && point[2] === -57.5) {
      const opened = await post('/api/action', {
        type:'interact', requestId:'reference-wood-door', x:-31, y:65, z:-59, expectedRevision:0,
      });
      assert.ok(opened.changes.some(change => change.x === -31 && change.y === 65 && change.z === -59 && change.cell === 'legacy:64:7'));
    }
  }
  const end = await post('/api/session', {});
  assert.deepEqual(end.position, asPoint(waypoints.at(-1)));
  return {start:start.position, end:end.position, revision:end.worldRevision};
}

async function browserPhotos(base, output, exerciseDoor) {
  const gameFile = await readFile(join(project,'client/game.mjs'),'utf8');
  const marker = 'globalThis.honeymoon = Object.freeze({';
  assert.ok(gameFile.includes(marker), 'Cannot install screenshot-only camera control');
  const cameraControl = [
    marker,
    'referencePose: ({feet,yaw,pitch}) => {',
    '  Object.assign(position, {x:feet[0], y:feet[1], z:feet[2]});',
    '  heading.yaw = yaw; heading.pitch = pitch;',
    '  updateCamera();',
    '},',
  ].join('\n');
  const photoGame = gameFile.replace(marker,cameraControl);
  let time = 0;
  const app = createHoneymoonServer({base,state:':memory:',geometry,clock:() => time});
  let browser;
  try {
    app.server.listen(0,'127.0.0.1');
    await once(app.server,'listening');
    browser = await chromium.launch({channel:'msedge'});
    const page = await browser.newPage({viewport:size, deviceScaleFactor:1});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/game.mjs', route => route.fulfill({body:photoGame,contentType:'text/javascript'}));
    // Omit the demo mechanic's overlays for the legacy-world comparison.
    await page.route('**/api/world', async route => {
      const response = await route.fetch();
      const body = await response.json();
      body.overrides = body.overrides.filter(change => !change.cell?.startsWith('game:'));
      await route.fulfill({response,json:body});
    });
    const origin = 'http://127.0.0.1:' + app.server.address().port;
    await page.goto(origin);
    await page.waitForFunction(() => globalThis.honeymoon?.stats().chunksLoaded === 64,
      null,{timeout:90_000});
    await page.evaluate(() => honeymoon.setDistance(8));
    const visualChunks = base.manifest.visualChunks?.length ?? 0;
    await page.waitForFunction(expected => {
      const stats = honeymoon.stats();
      return stats.pending === 0 && (stats.visualChunksLoaded ?? 0) === expected;
    },visualChunks,{timeout:90_000});
    await page.addStyleTag({content:'#game > :not(#scene) {display:none !important;}'});
    let serverWalk;
    for (const pose of poses) {
      if (exerciseDoor && pose.id === '06-armchair') {
        serverWalk = await walkOnServer(page, origin, () => {time += 125;});
        await page.waitForFunction(revision => honeymoon.stats().revision >= revision && honeymoon.stats().pending === 0,
          serverWalk.revision,{timeout:30_000});
      }
      await page.evaluate(({feet,yaw,pitch}) => {
        honeymoon.referencePose({feet,yaw,pitch});
        return new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
      },{feet:pose.feet,yaw:radians(180-pose.yaw),pitch:-radians(pose.pitch)});
      await page.screenshot({path:join(output,pose.id+'.png')});
    }
    assert.deepEqual(errors,[]);
    return serverWalk;
  } finally {
    await browser?.close();
    await app.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const stage = process.argv[2] ?? 'after';
  assert.match(stage,/^[a-z0-9-]+$/);
  const output = join(project,'work/reference-comparison/browser',stage);
  await mkdir(output,{recursive:true});
  const base = loadBase(join(project,'generated/world'));
  const route = checkRoute(base);
  const serverWalk = await browserPhotos(base,output,!stage.startsWith('before'));
  await writeFile(join(output,'poses.json'), JSON.stringify({size, fov:70, horizon:8, route, serverWalk, poses},null,2)+'\n');
  console.log(JSON.stringify({output, route, serverWalk, frames:poses.length}));
}
