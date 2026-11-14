import assert from 'node:assert/strict';
import {test} from 'node:test';
import {caveMoodSource} from './audio.mjs';

const listener = {x: -8.5, y: 53.5, z: 7.5};

function source({loaded = true, block = null, light = 0, sample = [10, 7, 53], threshold = 0} = {}) {
  const world = {
    hasChunk: (x, z) => loaded && x === -16 && z === 0,
    cellAt: () => block,
    lightAt: () => light,
  };
  const values = [sample[0] / 16, sample[1] / 16, sample[2] / 128, threshold / 8];
  return caveMoodSource(world, listener, () => values.shift());
}

test('cave mood uses dark air in a loaded chunk and the original block-light threshold', () => {
  assert.deepEqual(source(), [-6, 53, 7]);
  assert.deepEqual(source({light: 5, threshold: 5}), [-6, 53, 7]);
  assert.equal(source({light: 6, threshold: 5}), null);
  assert.equal(source({light: 16, threshold: 7}), null);
  assert.equal(source({block: 'legacy:1:0'}), null);
  assert.equal(source({loaded: false}), null);
});

test('cave mood keeps the original audible distance of greater than two through eight blocks', () => {
  assert.equal(source({sample: [9, 7, 53]}), null);
  assert.deepEqual(source({sample: [7, 7, 61]}), [-9, 61, 7]);
  assert.equal(source({sample: [7, 7, 62]}), null);
});
