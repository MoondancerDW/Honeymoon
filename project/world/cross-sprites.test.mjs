import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collisionFor, selectionFor, shapeFor } from './geometry.mjs';

const extent = box => [box.x0, box.y0, box.z0, box.x1, box.y1, box.z1];

test('all HarvestCraft candle colors use the native torch cutout and source tile', () => {
  for (let id = 3909; id <= 3924; id++) {
    const cell = `legacy:${id}:5`;
    const [sprite] = shapeFor(cell);
    assert.equal(sprite.faces[0], 3270 + id - 3909);
    assert.equal(sprite.mode, 'cutout');
    assert.equal(sprite.emissive, true);
    assert.deepEqual(sprite.torchMount,[0,0]);
    assert.deepEqual([sprite.x0,sprite.x1,sprite.z0,sprite.z1],[7/16,9/16,7/16,9/16]);
    assert.deepEqual(collisionFor(cell), []);
    assert.deepEqual(extent(selectionFor(cell)[0]), [.4, 0, .4, .6, .6, .6]);
  }
});

test('wall candles lean outward from each of their four mounting faces', () => {
  const mounts = [[0, .2, .35, .3, .8, .65], [.7, .2, .35, 1, .8, .65],
    [.35, .2, 0, .65, .8, .3], [.35, .2, .7, .65, .8, 1]];
  for (let meta = 1; meta <= mounts.length; meta++) {
    const cell = `legacy:3909:${meta}`;
    const sprite = shapeFor(cell)[0];
    const delta = (a, b) => Math.round(Math.abs(a - b) * 1000);
    assert.deepEqual(sprite.torchMount,[[-1,0],[1,0],[0,-1],[0,1]][meta-1]);
    assert.equal(sprite.y0,.2);
    assert.ok(extent(selectionFor(cell)[0]).every((value, i) => delta(value, mounts[meta - 1][i]) === 0));
    assert.deepEqual(collisionFor(cell), []);
  }
});

test('source texture slots cover the orchard and food variants in the surrounding chunks', () => {
  const orchard = [4090, 3950, 3944, 3959, 3995, 3980, 3962];
  for (const [row, id] of orchard.entries()) {
    for (const [stage, meta] of [0, 4, 7].entries()) {
      const [sprite] = shapeFor(`legacy:${id}:${meta}`);
      assert.equal(sprite.kind, 'cross');
      assert.equal(sprite.faces[0], 3840 + 3 * row + stage);
    }
  }
  const storage = [4027, 4075, 3985, 4081, 4092, 3973, 3970];
  for (const [slot, id] of storage.entries()) {
    const [model] = collisionFor(`legacy:${id}:0`);
    assert.equal(model.faces[0], 3861 + slot);
    assert.deepEqual(extent(model), [0, 0, 0, 1, 1, 1]);
  }
  for (const [slot, id] of [3814, 3908, 4071, 3954, 3975].entries()) {
    const [sprite] = shapeFor(`legacy:${id}:0`);
    assert.equal(sprite.kind, 'cross');
    assert.equal(sprite.faces[0], 3868 + slot);
  }
  assert.deepEqual(shapeFor('legacy:3249:0')[0].faces, [1047, 1047, 1046, 1048, 1047, 1047]);
  assert.deepEqual(extent(collisionFor('legacy:3249:6')[0]), [.8125, 0, .0625, .9375, 7 / 16, .9375]);
});
