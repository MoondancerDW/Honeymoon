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
const compareWater = process.env.HONEYMOON_LOD_WATER === '1';
const fire = process.env.HONEYMOON_FIRE_POSE && JSON.parse(process.env.HONEYMOON_FIRE_POSE);
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
if (compareWater) points.splice(0,points.length,
  {id:'forest-lake-eye',feet:[-1141.5,99,166.5],yaw:30,pitch:4,surfaceY:96+8/9},
  {id:'river-town-eye',feet:[-15.5,65,47.5],yaw:-12,pitch:3,surfaceY:63+8/9},
  {id:'river-market-eye',feet:[94.5,65,-21.5],yaw:-70,pitch:2,surfaceY:63+8/9});
if (fire) {
  if (!compareWater) points.length = 0;
  points.push({id:'fire-eye',...fire});
}
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
  page.on('console',message => {
    if (message.type() === 'error' && /WebGLProgram|shader error|INVALID_OPERATION/i.test(message.text())) {
      result.errors.push(message.text());
    }
  });
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
      return view.perspectiveView();
    },\n`;
    await route.fulfill({response, body:source.replace(marker,marker+code+
      '\nqaFireFrame: () => view.fireTexture?.offset.y,\n')});
  });
  await page.goto(url);
  await page.waitForFunction(() => globalThis.honeymoon?.stats().playable, undefined, {timeout:90000});
  const initialDistance = await page.locator('#distance').inputValue();
  assert.equal(initialDistance,'24');
  await page.addStyleTag({content:'#game > :not(#scene) {display:none !important;}'});
  for (const {id,feet,yaw,pitch,surfaceY} of points) {
    if (selected && id !== selected) continue;
    const camera = {feet,yaw:rad(180-yaw),pitch:-rad(pitch)};
    const perspective = await page.evaluate(pose => honeymoon.qaCamera(pose),camera);
    assert.equal(perspective.mode,'first');
    assert.ok(Math.abs(perspective.position[1] - feet[1] - 1.62) < .11);
    const modes = id === 'fire-eye' ? [[4,false]] : compareWater ? [[8,false],[24,false]]
      : id === 'mine-room' ? [[4,false],[24,false],[24,true]] : [[4,false],[24,false]];
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
      const name = `${id}-${distance}${occlusion ? '-occlusion' : ''}`;
      const screenshot = await page.screenshot({path:join(output,`${name}.png`)});
      if (id === 'fire-eye') {
        const frame = await page.evaluate(() => honeymoon.qaFireFrame());
        await page.waitForFunction(previous => honeymoon.qaFireFrame() !== previous,frame);
        const next = await page.screenshot({path:join(output,`${name}-next.png`)});
        result.fire = {position:fire.fire,frames:[frame,await page.evaluate(() => honeymoon.qaFireFrame())]};
        assert.ok(!screenshot.equals(next),'The original fire has different rendered frames');
      }
      result.shots.push({id,distance,perspective,camera,surfaceY,occlusionEnabled:occlusion,...facts});
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
