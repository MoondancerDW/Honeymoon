import test from 'node:test';
import assert from 'node:assert/strict';
import {collisionFor, shapeFor, sourceAtlasModel} from './geometry.mjs';

test('RedPower furnace uses its own front state, heading and top and bottom textures', () => {
  for (const [meta, side, bottom, top, front] of [[0, 3794, 3797, 3797, 3795],
    [1, 592, 596, 595, 593], [4, 672, 596, 675, 673]]) {
    for (const [rot, panelFace] of [4, 1, 5, 0].entries()) {
      for (const ps of [0, 1]) {
        const cell = {key: `legacy:751:${meta}`, object: {data: {rot, ps}}};
        const [box] = shapeFor(cell);
        const expected = [side, side, bottom, top, side, side];
        expected[panelFace] = front + ps;
        assert.deepEqual(box.faces, expected);
        assert.deepEqual(collisionFor(cell), [box]);
      }
    }
  }
});

test('RedPower ore storage selects the six native material tiles', () => {
  for (let meta = 0; meta < 6; meta++) {
    const [box] = shapeFor(`legacy:754:${meta}`);
    assert.deepEqual(box.faces, Array(6).fill(336 + meta));
  }
});

test('Campfire active and idle share the 9-piece rotated source model with a 1/4-block collision', () => {
  const active = 'legacy:3000:2';
  const idle = 'legacy:3001:1';
  const model = sourceAtlasModel(active);
  assert.equal(model.length, 54);
  assert.equal(sourceAtlasModel(idle), model);
  assert.equal(sourceAtlasModel('legacy:1:0'), null);
  assert.equal(collisionFor(active)[0].y1, .25);
  assert.deepEqual(collisionFor(active), collisionFor(idle));
  const points = model.flatMap(quad => quad.positions);
  const vertical = points.filter((_, i) => i % 3 === 1);
  assert.equal(Math.min(...vertical), 0);
  assert.ok(Math.max(...vertical) > .9);
  assert.ok(model.every(quad => quad.uv.length === 8 && quad.uv.every(v => v > 0 && v < 1)));
});
