import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {createHoneymoonServer} from '../server/index.mjs';
import * as geometry from '../world/geometry.mjs';

const output = process.argv[2] ?? 'work/creative-desktop';
const external = process.env.HONEYMOON_TEST_URL;
const app = external ? null : createHoneymoonServer({state:':memory:',geometry});
const report = {errors:[], placements:[]};
let browser;
await mkdir(output, {recursive:true});
try {
  let origin = external;
  if (app) {
    app.server.listen(0,'127.0.0.1');
    await once(app.server,'listening');
    origin = `http://127.0.0.1:${app.server.address().port}`;
  }
  browser = await chromium.launch({channel:'msedge'});
  const page = await browser.newPage({viewport:{width:1280,height:800}});
  report.browser = browser.version();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await page.goto(origin);
  const catalog = await page.evaluate(async () => (await fetch('/generated/creative/catalog.json')).json());
  const manifest = await page.evaluate(async () => (await fetch('/generated/world/world.json')).json());
  assert.ok(catalog.entries.length > 1000);
  assert.ok(catalog.tabs.length > 5);
  assert.ok(await page.locator('#creative-toggle').isDisabled());
  await page.locator('#play').click({timeout:90000});
  await page.waitForFunction(() => document.pointerLockElement && !document.querySelector('#creative-toggle').disabled);
  const search = page.locator('#creative-search');

  async function openMenu() {
    await page.keyboard.press('KeyI');
    await page.locator('#creative-menu').waitFor({state:'visible'});
    await page.locator('#creative-tabs [data-tab="all"]').click();
    await search.fill('');
  }

  async function choose(entry) {
    await search.fill(entry.key);
    const card = page.locator(`#creative-grid [data-key="${entry.key}"]`);
    await card.waitFor();
    await page.waitForFunction(key => {
      const canvas = document.querySelector(`[data-key="${key}"] canvas`);
      return canvas && canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.some((value, index) => index % 4 === 3 && value > 0);
    },entry.key);
    await card.click();
    await page.waitForFunction(() => document.pointerLockElement && !document.querySelector('#creative-menu').open);
  }

  async function aimFloor(x,z) {
    await page.evaluate(({x,z}) => {
      const feet = honeymoon.stats().position;
      const dx = x + .5 - feet.x, dz = z + .5 - feet.z;
      honeymoon.look(Math.atan2(-dx,-dz), Math.atan2(-1.62,Math.hypot(dx,dz)));
    },{x,z});
    await page.waitForFunction(({x,z}) => {
      const target = honeymoon.target();
      return target?.x === x && target?.z === z && target?.y === 64 && target?.offset[1] === 1;
    },{x,z});
  }

  async function place(type, entry, x,z) {
    await aimFloor(x,z);
    const promise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/action' &&
      response.request().postDataJSON()?.type === type);
    await page.mouse.click(640,400,{button:'right'});
    const response = await promise;
    const data = await response.json();
    assert.equal(response.status(),200,JSON.stringify(data));
    assert.equal(data.changes[0].cell,entry.blockKey ?? entry.key);
    await page.waitForFunction(({x,z,revision}) => honeymoon.getCell(x,65,z) &&
      honeymoon.stats().lastEditRender?.revision >= revision,{x,z,revision:data.worldRevision});
    report.placements.push({key:entry.key,...data.changes[0]});
  }

  await openMenu();
  const tabCount = await page.locator('#creative-tabs [data-tab]').count();
  assert.ok(tabCount > 5);
  await page.screenshot({path:join(output,'creative.png')});
  const palette = new Set(manifest.palette);
  const vanilla = catalog.entries.find(entry => entry.key === 'legacy:5:2');
  const mod = catalog.entries.find(entry => entry.id > 255 && !entry.kind && entry.placeable !== false && !entry.technical &&
    entry.category === 'chisel' && !palette.has(entry.key) && geometry.chiselMaterialShape(entry.key));
  assert.ok(vanilla && mod, 'Both vanilla and off-map mod state must be present');
  await choose(vanilla);
  await place('place',vanilla,-9,-20);
  await openMenu();
  const chisel = page.locator('#creative-tabs [data-tab="tabChisel"]');
  if (!await chisel.isVisible()) await page.locator('#creative-next-page').click();
  await chisel.click();
  await choose(mod);
  await place('place',mod,-6,-20);
  const part = catalog.entries.find(entry => entry.key === 'creative:750:0' && entry.placeable !== false);
  if (part) {
    await openMenu();
    await choose(part);
    await place('place_part',part,-8,-22);
    assert.ok(report.placements.at(-1).parts[0].bounds);
  }
  await page.screenshot({path:join(output,'placed.png')});
  await page.keyboard.press('KeyX');
  await page.waitForFunction(() => !document.querySelector('#selected').textContent.includes('В руке'));
  assert.deepEqual(report.errors,[]);
  report.catalog = catalog.counts;
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  await writeFile(join(output,'result.json'),JSON.stringify(report,null,2)+'\n');
  await browser?.close();
  await app?.close();
}
