import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHoneymoonServer } from '../server/index.mjs';
import { loadBase } from '../server/base.mjs';
import * as geometry from '../world/geometry.mjs';

const directory = resolve('work/browser-qa');
await mkdir(directory, {recursive: true});
const base = loadBase(resolve('generated/world'));
const browser = await chromium.launch({channel:'msedge'});
const targets = [
  {name:'armchair', cell:[-34,65,-61], spawn:[-31.5,65,-60.5], focus:[-33.5,65.65,-60.5]},
  {name:'bookcase', cell:[-59,76,-50], spawn:[-60.5,75,-48.5], focus:[-58.5,76.48,-49.5]},
  {name:'sign', cell:[-54,70,-49], spawn:[-54.5,70,-50.5], focus:[-53.5,70.56,-48.5]},
];
const result = [];
try {
  for (const target of targets) {
    const manifest = {...base.manifest, spawn: target.spawn, terrain: []};
    const app = createHoneymoonServer({base:{...base,manifest}, state:':memory:', geometry});
    await new Promise(done => app.server.listen(0,'127.0.0.1',done));
    const context = await browser.newContext({viewport:{width:1280,height:720}});
    try {
      const page = await context.newPage();
      await page.goto('http://127.0.0.1:' + app.server.address().port);
      await page.waitForFunction(() => !document.querySelector('#play').disabled, {timeout:60000});
      const delta = target.focus.map((value,i) => value - target.spawn[i] - (i === 1 ? 1.62 : 0));
      const yaw = Math.atan2(-delta[0], -delta[2]);
      const pitch = Math.atan2(delta[1], Math.hypot(delta[0],delta[2]));
      await page.locator('#play').click();
      await page.waitForFunction(() => document.querySelector('#entry').hidden);
      await page.evaluate(([yaw,pitch]) => honeymoon.look(yaw,pitch), [yaw,pitch]);
      await page.waitForFunction(() => honeymoon.stats().chunksLoaded === 64 && honeymoon.stats().pending === 0, {timeout:60000});
      const picked = await page.evaluate(() => honeymoon.target());
      const selected = picked && [picked.x,picked.y,picked.z];
      if (String(selected) !== String(target.cell)) throw new Error(target.name + ' was not selectable');
      result.push({name:target.name, position:target.spawn, picked:selected});
      await page.screenshot({path:join(directory,target.name + '.png')});
    } finally {
      await context.close();
      await app.close();
    }
  }
  await writeFile(join(directory,'samples.json'), JSON.stringify(result,null,2) + '\n');
  console.log(result);
} finally {
  await browser.close();
}
