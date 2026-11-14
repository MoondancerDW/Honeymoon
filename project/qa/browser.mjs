import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = process.env.HONEYMOON_URL || 'http://127.0.0.1:4173';
const directory = resolve('work/browser-qa');
await mkdir(directory, {recursive:true});
const browser = await chromium.launch({
  channel: 'msedge',
  headless: process.env.HONEYMOON_HEADED !== '1',
  args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
});
const errors = [];
const context = await browser.newContext({viewport:{width:1280,height:720}});
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.stack));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const results = {browser: browser.version(), resolution: '1280×720', errors, distances: []};
const world = await (await fetch(`${base}/generated/world/world.json`)).json();
const stats = page => page.evaluate(() => honeymoon.stats());
page.on('response', response => { if (response.status() >= 400) errors.push(response.status() + ' ' + response.url()); });
const percentile = (sample, p) => {
  const ordered = sample.slice().sort((a,b) => a-b);
  return +(ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * p))] || 0).toFixed(2);
};

async function ready(page) {
  await page.goto(base, {waitUntil:'domcontentloaded'});
  await page.locator('#play').waitFor();
  await page.waitForFunction(() => !document.querySelector('#play').disabled, {timeout:90000});
}

async function settled(page) {
  await page.waitForFunction(count => {
    const m = honeymoon.stats();
    return m.pending === 0 && m.chunksLoaded === count;
  }, world.chunks.length, {timeout:90000});
}

try {
  await ready(page);
  await settled(page);
  results.startup = await stats(page);
  await page.screenshot({path: resolve(directory, 'entry.png')});
  await page.locator('#play').click();
  await page.waitForFunction(() => document.querySelector('#entry').hidden);
  await page.evaluate(() => honeymoon.look(0, -.11));
  await page.screenshot({path: resolve(directory, 'spawn.png')});

  for (const distance of [8,16,32]) {
    const start = Date.now();
    await page.evaluate(d => honeymoon.setDistance(d), distance);
    await settled(page);
    const buildMs = Date.now() - start;
    const previous = await stats(page);
    const frames = previous.frameTimes.length;
    await page.evaluate(() => honeymoon.look(0, -.11));
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1400);
    await page.keyboard.up('KeyW');
    await page.evaluate(() => honeymoon.look(Math.PI / 2, -.12));
    await page.keyboard.down('KeyA');
    await page.waitForTimeout(700);
    await page.keyboard.up('KeyA');
    await page.waitForTimeout(400);
    const end = await stats(page);
    const times = end.frameTimes.slice(frames);
    results.distances.push({distance, buildMs, frames:times.length, p50:percentile(times,.5), p95:percentile(times,.95),
      pausesOver50ms:times.filter(ms => ms > 50).length, maxMs:percentile(times,1), calls:end.calls,
      preciseMiB:+(end.preciseBytes / 1048576).toFixed(2), coarseMiB:+(end.coarseBytes / 1048576).toFixed(2),
      preciseTriangles:end.preciseTriangles, coarseTriangles:end.coarseTriangles,
      before:previous.position, after:end.position});
    await page.screenshot({path: resolve(directory, 'distance-' + distance + '.png')});
    await page.evaluate(async () => {
      if (document.pointerLockElement) document.exitPointerLock();
    });
    await page.locator('#reset').click();
    await page.waitForTimeout(250);
    await page.locator('#play').click();
    await page.waitForFunction(() => document.querySelector('#entry').hidden);
  }

  const second = await browser.newContext();
  const peer = await second.newPage();
  await ready(peer);
  await settled(peer);
  await page.evaluate(() => honeymoon.look(Math.PI, -.66));
  await page.waitForFunction(() => Boolean(honeymoon.target()));
  const selected = await page.evaluate(() => {
    const {x,y,z,cell,offset} = honeymoon.target();
    return {x,y,z,key: typeof cell === 'string' ? cell : cell.key,offset};
  });
  await page.keyboard.press('KeyQ');
  await page.waitForFunction(() => document.querySelector('#selected').textContent.includes('В руке'));
  await page.mouse.down({button:'left'});
  await page.mouse.up({button:'left'});
  const stillPresent = await peer.evaluate(({x,y,z,key}) => {
    const cell = honeymoon.getCell(x,y,z);
    return (typeof cell === 'string' ? cell : cell?.key) === key;
  }, selected);
  const removal = await page.request.post(`${base}/api/action`, {data:{type:'remove', requestId:'desktop-block-breaking',
    x:selected.x, y:selected.y, z:selected.z, expectedRevision:0}});
  const response = await removal.json();
  if (!stillPresent || removal.status() !== 403 || response.error !== 'block_breaking_disabled') {
    throw new Error('Block breaking is enabled');
  }
  results.edits = {selected, copyWorks: true, blockBreakingDisabled: true};
  await second.close();
} catch (error) {
  results.failure = error.stack;
  process.exitCode = 1;
  await page.screenshot({path:resolve(directory,'failure.png')}).catch(() => {});
} finally {
  if (results.startup) {
    const {frameTimes, meshTimes, ...numbers} = results.startup;
    results.startup = {...numbers, meshP50ms:percentile(meshTimes,.5), meshP95ms:percentile(meshTimes,.95),
      meshMaxMs:percentile(meshTimes,1), maxInitialFrameMs:percentile(frameTimes,1)};
  }
  await writeFile(resolve(directory,'result.json'), JSON.stringify(results,null,2) + '\n');
  console.log(JSON.stringify(results,null,2));
  await browser.close();
}
