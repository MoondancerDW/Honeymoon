import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {loadBase} from '../server/base.mjs';
import {createHoneymoonServer} from '../server/index.mjs';
import {westCellarHatch} from '../world/west-cellar.mjs';
import * as geometry from '../world/geometry.mjs';

const output = process.argv[2] ?? 'work/building-survey/west-cellar-browser';
const base = loadBase('generated/world');
const spawn = [-59.5, 60, 56.5];
const app = createHoneymoonServer({state: ':memory:', geometry, base: {...base, manifest: {...base.manifest, spawn}}});
let browser;
try {
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({channel: 'msedge'});
  const page = await browser.newPage({viewport: {width: 1280, height: 720}});
  const errors = [];
  const positionRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (!response.url().endsWith('/api/position')) return;
    positionRequests.push({status: response.status(), request: response.request().postDataJSON()});
  });
  await page.goto(origin);
  await page.waitForFunction(() => globalThis.honeymoon && !document.querySelector('#play').disabled, null, {timeout: 90_000});
  await page.locator('#play').click();
  await page.waitForFunction(() => document.querySelector('#entry').hidden);
  const hatch = await page.evaluate(({x, y, z}) => honeymoon.getCell(x, y, z), westCellarHatch);
  assert.equal(hatch.key, 'legacy:96:12');
  assert.equal(hatch.object.data.ladderRung, 3);
  await mkdir(output, {recursive: true});
  await page.evaluate(() => honeymoon.look(0, 1.16));
  await page.screenshot({path: join(output, 'shaft.png')});

  await page.keyboard.down('Space');
  await page.waitForFunction(() => honeymoon.stats().position.y > 64.7, null, {timeout: 15_000});
  await page.keyboard.down('KeyA');
  await page.waitForFunction(() => {
    const {position} = honeymoon.stats();
    return position.x < -60.4 && position.y > 65.1;
  }, null, {timeout: 7_000});
  await page.keyboard.up('KeyA');
  await page.keyboard.up('Space');
  await page.waitForFunction(() => Math.abs(honeymoon.stats().position.y - 65.125) < .002);
  const position = await page.evaluate(() => honeymoon.stats().position);
  await page.evaluate(() => honeymoon.look(-Math.PI / 2, -.65));
  await page.screenshot({path: join(output, 'exit.png')});
  assert.ok(positionRequests.some(({status, request}) => status === 200 && request.x < -60.4 && request.y > 65.1),
    'The server must accept a position on the upper floor');
  const removal = await page.request.post(`${origin}/api/action`, {data: {type: 'remove', requestId: 'cellar-no-breaking',
    ...westCellarHatch, expectedRevision: 0}});
  assert.equal(removal.status(), 403);
  assert.deepEqual(await removal.json(), {error: 'block_not_owned'});
  assert.deepEqual(errors, []);
  const result = {browser: browser.version(), spawn, position, requests: positionRequests, originalBlockProtected: true, errors};
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({browser: result.browser, position, requests: positionRequests.length}));
} finally {
  await browser?.close();
  await app.close();
}
