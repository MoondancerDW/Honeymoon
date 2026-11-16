import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {loadBase} from '../server/base.mjs';
import {createHoneymoonServer} from '../server/index.mjs';
import {physics} from '../server/physics.mjs';
import * as geometry from '../world/geometry.mjs';

const [directory = 'generated', screenshots = 'work/horizon-controls'] = process.argv.slice(2);
const generated = resolve(directory);
const output = resolve(screenshots);
const base = loadBase(join(generated, 'world'));
const game = createHoneymoonServer({
  generated, state:':memory:', geometry,
  base:{...base, manifest:{...base.manifest, spawn:[-8,65,-17.5]}},
});
const browser = await chromium.launch({channel:'msedge'});
const context = await browser.newContext({viewport:{width:1280,height:720}});
const page = await context.newPage();
const errors = [], rejected = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => {
  if (response.url().endsWith('/api/position') && !response.ok()) rejected.push(response.request().postDataJSON());
});
const stats = () => page.evaluate(() => honeymoon.stats());
const press = key => page.keyboard.press(key);
const black = page.locator('#teleport-loading');
const timeout = {timeout:90_000};
const hold = async (key, ready) => {
  await page.keyboard.down(key);
  try { await ready(); }
  finally { await page.keyboard.up(key); }
};

async function teleport(point) {
  await press('KeyG');
  for (const [axis,value] of Object.entries(point)) await page.locator('#teleport-' + axis).fill(String(value));
  const response = page.waitForResponse(res => res.url().endsWith('/api/teleport'));
  await page.locator('#teleport-send').click();
  assert.equal((await response).status(),200);
}

try {
  await mkdir(output,{recursive:true});
  game.server.listen(0,'127.0.0.1');
  await once(game.server,'listening');
  await page.goto('http://127.0.0.1:' + game.server.address().port);
  await page.locator('#play').click(timeout);
  await page.waitForFunction(() => document.pointerLockElement && honeymoon.stats().streaming?.ready, null, timeout);

  await press('Escape');
  await page.waitForFunction(() => !document.querySelector('#entry').hidden);
  await press('Escape');
  await page.waitForFunction(() => document.querySelector('#entry').hidden);
  await press('KeyY');
  await page.waitForFunction(() => honeymoon.perspective().mode === 'back');
  await press('KeyU');
  await page.waitForFunction(() => honeymoon.perspective().mode === 'orbit');
  await press('KeyU');
  await page.waitForFunction(() => honeymoon.perspective().mode === 'back');

  await press('KeyP');
  await page.waitForFunction(() => honeymoon.stats().spectator && honeymoon.perspective().mode === 'first');
  await press('KeyY');
  await press('KeyU');
  assert.equal((await stats()).perspective.mode,'first');
  assert.equal(await page.evaluate(() => honeymoon.localAvatar().visible),false);
  assert.equal(await black.isVisible(),false);

  let releaseChunk;
  const waitForChunk = new Promise(resolve => { releaseChunk = resolve; });
  await page.route('**/generated/world/chunks/-11.2.json', async route => {
    await waitForChunk;
    await route.continue();
  });
  const far = {x:-175.5,y:115,z:39.5};
  try {
    await teleport(far);
    await black.waitFor({state:'visible',...timeout});
    await page.waitForTimeout(350);
    assert.equal(await black.isVisible(),true);
    assert.match(await black.textContent(),/Загрузка, подождите/);
    await page.screenshot({path:join(output,'teleport-loading.png')});
  } finally { releaseChunk(); }
  await black.waitFor({state:'hidden',...timeout});
  await press('Escape');
  assert.equal((await stats()).position.x,far.x);

  const worldPhysics = physics(base,geometry,base.getCell);
  let surface;
  for (let y = 110; y > 30; y--) {
    const point = {...far,y};
    if (worldPhysics.collides({...point,y:y-.1}) && !worldPhysics.collides(point)) { surface = point; break; }
  }
  assert.ok(surface,'Expected a solid surface under the city flight');
  await teleport({...surface,y:surface.y + .6});
  await page.waitForFunction(() => !document.querySelector('#teleport-send').disabled);
  assert.equal(await black.isVisible(),false,'A nearby, loaded teleport should not blank the screen');
  await press('Escape');
  await hold('KeyC', () => page.waitForFunction(y => honeymoon.stats().position.y < y - .65, surface.y));
  const clipped = (await stats()).position;
  assert.ok(worldPhysics.collides(clipped),'C should fly into the solid surface');
  assert.equal(await black.isVisible(),false,'Ordinary spectator flight should not blank the screen');
  await press('KeyP');
  await page.waitForFunction(() => !honeymoon.stats().spectator && honeymoon.perspective().mode === 'back');
  const stood = (await stats()).position;
  assert.ok(stood.y > clipped.y && worldPhysics.collides({...stood,y:stood.y-.01}) && !worldPhysics.collides(stood));

  // This landing area contains a procedurally coloured, untextured minecart.
  await page.evaluate(() => honeymoon.setDistance(4));
  const cartArea = {x:491.5,y:157.5,z:-442.5};
  await teleport(cartArea);
  await black.waitFor({state:'visible',...timeout});
  await black.waitFor({state:'hidden',...timeout});
  await page.waitForFunction(() => !document.querySelector('#teleport-send').disabled);
  const arrived = (await stats()).position;
  assert.deepEqual(arrived,cartArea);

  assert.deepEqual(errors,[]);
  assert.deepEqual(rejected,[]);
  const report = {far,clipped,stood,arrived,movement:(await stats()).movementSync,errors};
  await writeFile(join(output,'result.json'),JSON.stringify(report,null,2) + '\n');
  console.log(report);
} finally {
  await context.close();
  await browser.close();
  await game.close();
}
