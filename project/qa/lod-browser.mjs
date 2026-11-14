import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {loadBase} from '../server/base.mjs';
import {createHoneymoonServer} from '../server/index.mjs';
import * as geometry from '../world/geometry.mjs';

const [generatedArg = 'generated', outputArg = 'work/city-lod/frames'] = process.argv.slice(2);
const external = process.env.HONEYMOON_TEST_URL;
const selected = process.env.HONEYMOON_LOD_POSE;
const generated = resolve(generatedArg);
const output = resolve(outputArg);
const base = external ? null : loadBase(join(generated,'world'));
const app = external ? null : createHoneymoonServer({generated, base, state:':memory:', geometry});
const points = [
  {id:'city', feet:[-163,151,164], yaw:-174.4, pitch:22.5},
  {id:'castle-approach', feet:[-1620.5,119,87.5], yaw:153, pitch:26},
  {id:'castle-from-far', feet:[-1875,145,145], yaw:-92, pitch:14},
  {id:'east-garrison', feet:[479,139,-95], yaw:-124.2, pitch:26.5},
  {id:'mine-room', feet:[612.5,44,667.5], yaw:-26.6, pitch:14.3},
];
const rad = angle => angle * Math.PI / 180;
const result = {errors:[], responses:[], shots:[]};
let browser;
await mkdir(output,{recursive:true});
try {
  let url = external;
  if (app) {
    app.server.listen(0,'127.0.0.1');
    await once(app.server,'listening');
    url = `http://127.0.0.1:${app.server.address().port}`;
  }
  browser = await chromium.launch({channel:'msedge'});
  const page = await browser.newPage({viewport:{width:1280,height:720}, deviceScaleFactor:1});
  page.on('pageerror',error => result.errors.push(error.message));
  page.on('response',res => {
    if (res.status() >= 400) result.responses.push({code:res.status(),url:new URL(res.url()).pathname});
  });
  await page.route('**/game.mjs', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = 'globalThis.honeymoon = Object.freeze({';
    assert.ok(source.includes(marker));
    const code = `\nqaCamera: ({feet,yaw,pitch}) => {
      view.cycleTime = 6000;
      view.updateSky(6000);
      Object.assign(position,{x:feet[0],y:feet[1],z:feet[2]});
      Object.assign(heading,{yaw,pitch}); updateCamera();
    },\n`;
    await route.fulfill({response, body:source.replace(marker,marker+code)});
  });
  await page.goto(url);
  await page.waitForFunction(() => globalThis.honeymoon?.stats().playable, undefined, {timeout:90000});
  const initialDistance = await page.locator('#distance').inputValue();
  assert.equal(initialDistance,'24');
  await page.addStyleTag({content:'#game > :not(#scene) {display:none !important;}'});
  for (const {id,feet,yaw,pitch} of points) {
    if (selected && id !== selected) continue;
    await page.evaluate(pose => honeymoon.qaCamera(pose), {feet,yaw:rad(180-yaw),pitch:-rad(pitch)});
    const modes = id === 'mine-room' ? [[4,false],[24,false],[24,true]] : [[4,false],[24,false]];
    for (const [distance,occlusion] of modes) {
      await page.evaluate(value => honeymoon.setDistance(value), distance);
      if (occlusion) await page.evaluate(() => honeymoon.setOcclusion(true));
      await page.waitForFunction(({feet,distance,occlusion}) => {
        const {streaming,farTerrain,occlusion:visibility} = honeymoon.stats();
        return streaming?.ready && streaming.x === Math.floor(feet[0]/16) && streaming.z === Math.floor(feet[2]/16) &&
          (distance === 24 ? farTerrain?.ready && farTerrain.packs > 0 : !farTerrain?.active) &&
          (!occlusion || visibility?.enabled && visibility.classifiedSections > 0);
      }, {feet,distance,occlusion},{timeout:120000,polling:220});
      const facts = await page.evaluate(() => {
        const {farTerrain,residentChunks,triangles,calls,occlusion} = honeymoon.stats();
        return {farTerrain,residentChunks,triangles,calls,occlusion};
      });
      await page.waitForTimeout(160);
      await page.screenshot({path:join(output,`${id}-${distance}${occlusion ? '-occlusion' : ''}.png`)});
      result.shots.push({id,distance,occlusionEnabled:occlusion,...facts});
    }
  }
  assert.deepEqual(result.errors,[]);
  assert.deepEqual(result.responses,[]);
  assert.ok(result.shots.length > 0);
} catch (error) {
  result.failure = error.stack;
  throw error;
} finally {
  await writeFile(join(output,'result.json'),JSON.stringify(result,null,2)+'\n');
  await browser?.close();
  await app?.close();
}
