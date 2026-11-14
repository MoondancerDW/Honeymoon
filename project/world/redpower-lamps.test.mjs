import assert from 'node:assert/strict';
import {test} from 'node:test';
import {withExtractedModels} from './extracted-models.mjs';
import * as geometry from './geometry.mjs';

const extracted = withExtractedModels(geometry, {redpower:{lamps:[[], []]}});
const lamp = (style, rot) => ({key:'legacy:768:0', object:{data:{style, rot}}});

test('shaped lamp movement uses the native default cube for every orientation and style', () => {
  const cube = [{x0:0, y0:0, z0:0, x1:1, y1:1, z1:1}];
  for (const style of [0, 1]) {
    for (const rot of [0, 1, 2, 3, 4, 5]) {
      assert.deepEqual(geometry.collisionFor(lamp(style, rot)), cube);
      assert.deepEqual(extracted.collisionFor(lamp(style, rot)), cube);
    }
  }
  assert.deepEqual(extracted.collisionFor('legacy:768:0'), cube);
});

test('shaped lamp selection still follows the saved orientation and style', () => {
  assert.deepEqual(extracted.shapeFor(lamp(1, 0)), [
    {x0:.1875, y0:0, z0:.1875, x1:.8125, y1:.75, z1:.8125},
  ]);
  assert.deepEqual(extracted.shapeFor(lamp(0, 5)), [
    {x0:.5, y0:.125, z0:.125, x1:1, y1:.875, z1:.875},
  ]);
});
