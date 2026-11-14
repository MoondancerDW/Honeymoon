import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crossSpriteCorners } from './cross-sprites.mjs';
import { collisionFor, selectionFor, shapeFor } from './geometry.mjs';

const extent = box => [box.x0, box.y0, box.z0, box.x1, box.y1, box.z1];

test('all HarvestCraft candle colors use their whole cutout sprite on two crossed planes', () => {
  for (let id = 3909; id <= 3924; id++) {
    const cell = `legacy:${id}:5`;
    const [sprite] = shapeFor(cell);
    assert.equal(sprite.kind, 'cross');
    assert.equal(sprite.faces[0], 3270 + id - 3909);
    assert.equal(sprite.mode, 'cutout');
    assert.equal(sprite.emissive, true);
    const [ascending, descending] = crossSpriteCorners(sprite, [1, 2, 3]);
    assert.equal(ascending[0][0], descending[0][0]);
    assert.ok(ascending[0][2] < ascending[1][2]);
    assert.ok(descending[0][2] > descending[1][2]);
    assert.equal(ascending[2][1] - ascending[1][1], 1);
    assert.deepEqual(collisionFor(cell), []);
    assert.deepEqual(extent(selectionFor(cell)[0]), [.4, 0, .4, .6, .6, .6]);
  }
});

test('wall candles keep two planes and lean outward from each mounting face', () => {
  const mounts = [[0, .2, .35, .3, .8, .65], [.7, .2, .35, 1, .8, .65],
    [.35, .2, 0, .65, .8, .3], [.35, .2, .7, .65, .8, 1]];
  function center(plane, a, b, axis) { return (plane[a][axis] + plane[b][axis]) / 2; }
  for (let meta = 1; meta <= mounts.length; meta++) {
    const cell = `legacy:3909:${meta}`;
    const sprite = shapeFor(cell)[0];
    const axis = meta <= 2 ? 0 : 2;
    const sign = meta % 2 === 0 ? -1 : 1;
    const delta = (a, b) => Math.round(Math.abs(a - b) * 1000);
    for (const plane of crossSpriteCorners(sprite, [0, 0, 0])) {
      assert.equal(Math.sign(center(plane, 2, 3, axis) - center(plane, 0, 1, axis)), sign);
    }
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
