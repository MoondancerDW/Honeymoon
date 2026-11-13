import { chromium, devices } from 'playwright-core';
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
  await page.waitForFunction(() => {
    const m = honeymoon.stats();
    return m.pending === 0 && m.chunksLoaded === 64;
  }, {timeout:90000});
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
  await peer.waitForFunction(({x,y,z}) => !honeymoon.getCell(x,y,z), selected, {timeout:10000});
  const remove = await stats(page);
  await peer.waitForFunction(revision => honeymoon.stats().lastEditRender?.revision === revision, remove.revision);
  results.edits = {selected, removedVisibleToSecondClient: true, removeMs: remove.lastEdit,
    peerRemoveMeshMs: (await stats(peer)).lastEditRender.ms};
  await page.waitForFunction(({x,y,z}) => { const next = honeymoon.target(); return next && next.x+next.offset[0]===x && next.y+next.offset[1]===y && next.z+next.offset[2]===z; }, selected, {timeout:10000});
  await page.mouse.down({button:'right'});
  await page.mouse.up({button:'right'});
  await peer.waitForFunction(({x,y,z,key}) => {
    const cell = honeymoon.getCell(x,y,z);
    return (typeof cell === 'string' ? cell : cell?.key) === key;
  }, selected, {timeout:10000});
  results.edits.replacedVisibleToSecondClient = true;
  const place = await stats(page);
  await peer.waitForFunction(revision => honeymoon.stats().lastEditRender?.revision === revision, place.revision);
  results.edits.placeMs = place.lastEdit;
  results.edits.peerPlaceMeshMs = (await stats(peer)).lastEditRender.ms;
  await second.close();

  await context.close();
  const phone = await browser.newContext({...devices['Pixel 7']});
  const touch = await phone.newPage();
  await ready(touch);
  await touch.locator('#play').tap();
  await touch.locator('#stick').waitFor();
  await settled(touch);
  const before = (await stats(touch)).position;
  const pad = await touch.locator('#stick').boundingBox();
  const cdp = await phone.newCDPSession(touch);
  const point = {x: Math.round(pad.x + pad.width / 2), y: Math.round(pad.y + pad.height / 2 - 30)};
  await cdp.send('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[point]});
  await touch.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', {type:'touchEnd', touchPoints:[]});
  const after = (await stats(touch)).position;
  if (Math.hypot(after.x - before.x, after.z - before.z) < .5) throw new Error('Touch joystick did not move player');
  results.emulatedTouch = {controls: await touch.locator('#touch-use').isVisible(), width: await touch.evaluate(() => innerWidth), before, after};
  await touch.screenshot({path:resolve(directory,'touch.png')});
  await phone.close();
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
