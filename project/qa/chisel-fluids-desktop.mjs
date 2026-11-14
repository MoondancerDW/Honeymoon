import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {createHoneymoonServer} from '../server/index.mjs';
import * as geometry from '../world/geometry.mjs';
import {voxelCoordinate, voxelMaterialAt} from '../world/voxel-chisel.mjs';

const output = process.argv[2] ?? 'work/chisel-fluids';
const external = process.env.HONEYMOON_TEST_URL;
const app = external ? null : createHoneymoonServer({state:':memory:',geometry});
const water = 'legacy:9:0', lava = 'legacy:11:0';
const sources = [[water,{x:-9,y:65,z:-20}], [lava,{x:-6,y:65,z:-20}]];
const destination = {x:-8,y:65,z:-21};
const report = {actions:[], errors:[]};
let browser;
await mkdir(output, {recursive:true});
try {
  let url = external;
  if (app) {
    app.server.listen(0,'127.0.0.1');
    await once(app.server,'listening');
    url = `http://127.0.0.1:${app.server.address().port}`;
  }
  browser = await chromium.launch({channel:'msedge'});
  report.browser = browser.version();
  const page = await browser.newPage({viewport:{width:1280,height:720}});
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(url);
  await page.locator('#play').click({timeout:90000});
  await page.waitForFunction(() => document.pointerLockElement && !document.querySelector('#creative-toggle').disabled);

  async function aim({x,y,z}, [dx,dy,dz], material) {
    await page.evaluate(([x,y,z]) => {
      const feet = honeymoon.stats().position;
      const dx = x - feet.x, dy = y - feet.y - 1.62, dz = z - feet.z;
      honeymoon.look(Math.atan2(-dx,-dz), Math.atan2(dy,Math.hypot(dx,dz)));
    },[x+dx,y+dy,z+dz]);
    try {
      await page.waitForFunction(({x,y,z,material}) => {
        const target = honeymoon.target();
        return target?.x === x && target.y === y && target.z === z && (!material || target.voxelMaterial === material);
      },{x,y,z,material},{timeout:10000});
    } catch (error) {
      report.target = await page.evaluate(() => honeymoon.target());
      throw error;
    }
  }

  async function action(type, run) {
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/action' &&
      response.request().postDataJSON()?.type === type);
    await run();
    const response = await pending;
    const data = await response.json();
    assert.equal(response.status(),200,JSON.stringify(data));
    report.actions.push({type, revision:data.worldRevision, material:data.material ?? response.request().postDataJSON()?.material});
    return data;
  }

  const click = button => page.mouse.click(640,360,{button});
  const below = (cell) => ({...cell,y:cell.y-1});
  for (const [material, cell] of sources) {
    await page.keyboard.press('KeyI');
    await page.locator('#creative-search').fill(material);
    await page.locator(`#creative-grid [data-key="${material}"]`).click();
    await page.waitForFunction(() => document.pointerLockElement && !document.querySelector('#creative-menu').open);
    await aim(below(cell),[.5,1,.5]);
    assert.equal((await action('place',() => click('right'))).changes[0].cell,material);
  }

  await page.keyboard.press('KeyV');
  const positions = [[.6875,1,.5625],[.3125,1,.5625]];
  const added = [];
  for (const [index,[material,cell]] of sources.entries()) {
    const surface = geometry.shapeFor(material)[0].y1;
    await aim(cell,[.5,surface,.5],material);
    assert.equal((await action('copy_voxel',() => page.keyboard.press('KeyQ'))).material,material);
    await page.waitForFunction(key => honeymoon.stats().chiselMaterial === key,material);
    await aim(below(destination),positions[index]);
    const voxel = await page.evaluate(() => honeymoon.placement()?.voxel);
    const change = (await action('place_voxel',() => click('right'))).changes[0];
    assert.equal(voxelMaterialAt(change.voxels,voxel),material);
    await page.waitForFunction(revision => honeymoon.stats().lastEditRender?.revision >= revision,change.revision);
    added.push({voxel,material,cell:change.voxels});
  }
  assert.deepEqual(added[1].cell.materials,[lava,water]);
  const [x,y,z] = voxelCoordinate(added[0].voxel);
  await aim(destination,[(x+.5)/8,(y+1)/8,(z+.5)/8],water);
  await page.screenshot({path:join(output,'water-and-lava.png')});
  const removed = (await action('remove_voxel',() => click('left'))).changes[0];
  assert.deepEqual(removed.voxels.materials,[lava]);
  assert.equal(voxelMaterialAt(removed.voxels,added[0].voxel),null);
  report.corrections = await page.evaluate(() => honeymoon.stats().movementSync.corrections);
  assert.equal(report.corrections,0);
  assert.deepEqual(report.errors,[]);
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  await writeFile(join(output,'result.json'),JSON.stringify(report,null,2)+'\n');
  await browser?.close();
  await app?.close();
}
