import assert from 'node:assert/strict';
import {test} from 'node:test';
import {clipLiquidFace, liquidCavity, liquidAt, canLogLiquid} from './logged-fluid.mjs';
import {movementMedium} from './block-movement.mjs';

const volume = boxes => boxes.reduce((sum, {x0, x1, y0, y1, z0, z1}) => sum + (x1 - x0) * (y1 - y0) * (z1 - z0), 0);

test('static liquids occupy only the free parts of slabs, stairs and microblocks', () => {
  for (const fluid of ['water', 'lava']) {
    const lower = {key:'legacy:44:0', fluid};
    const upper = {key:'legacy:44:8', fluid};
    const stairs = {key:'legacy:53:0', fluid};
    const panel = {key:'cover:750:0:test-panel', fluid, parts:[{slot:0, shape:0, material:2}]};
    const ladder = {key:'legacy:65:2', fluid};
    assert.equal(volume(liquidCavity(lower)), .5);
    assert.equal(volume(liquidCavity(upper)), .5);
    assert.equal(volume(liquidCavity(stairs)), .25);
    assert.equal(volume(liquidCavity(panel)), .875);
    assert.equal(volume(liquidCavity(ladder)), .875);
    assert.equal(liquidAt(lower, [.5, .25, .5]), undefined);
    assert.equal(liquidAt(lower, [.5, .75, .5]), fluid);
    assert.equal(liquidAt(upper, [.5, .25, .5]), fluid);
    assert.equal(liquidAt(upper, [.5, .75, .5]), undefined);
    const [surface] = liquidCavity(lower);
    assert.deepEqual(clipLiquidFace(surface, 5, liquidCavity(lower)), []);
    assert.deepEqual(clipLiquidFace(surface, 5, liquidCavity(upper)), [surface]);
    assert.equal(movementMedium((x,y,z) => x === 0 && y === 0 && z === 0 ? lower : null, .5, .5, .5),
      fluid);
  }
  assert.equal(canLogLiquid('legacy:1:0'), false);
  assert.equal(canLogLiquid('legacy:9:0'), false);
  assert.equal(canLogLiquid('air'), false);
});
