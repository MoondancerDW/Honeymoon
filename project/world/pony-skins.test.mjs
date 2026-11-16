import test from 'node:test';
import assert from 'node:assert/strict';
import {ponyModels} from './pony-model-data.mjs';
import {defaultPonyPixels, ponySkinHeight, readPonySkin} from './pony-skins.mjs';

function set(pixels, width, x, y, color) {
  pixels.set(color, (y * width + x) * 4);
}

test('legacy pony metadata selects the source renderer, species, proportions and style', () => {
  const pixels = new Uint8Array(64 * 32 * 4);
  set(pixels, 64, 0, 0, [254, 249, 252, 255]);
  set(pixels, 64, 1, 0, [70, 142, 136, 255]);
  set(pixels, 64, 2, 0, [255, 255, 255, 255]);
  set(pixels, 64, 3, 0, [42, 60, 120, 255]);
  set(pixels, 64, 1, 1, [20, 0, 0, 255]);
  assert.equal(readPonySkin(pixels, 64, 32).glowColor, 0x4444aa);
  set(pixels, 64, 0, 1, [194, 52, 218, 255]);
  assert.deepEqual(readPonySkin(pixels, 64, 32), {
    ponyType: 'alicorn', tail: 3, male: true, size: 'tall', mane: 3, advanced: false, glowColor:0xc234da,
  });
  set(pixels, 64, 4, 0, [35, 110, 70, 255]);
  assert.equal(readPonySkin(pixels, 64, 32).advanced, true);
});

test('HD layouts keep the native atlas coordinates and their header markers', () => {
  const pixels = new Uint8Array(128 * 128 * 4);
  set(pixels, 128, 0, 0, [136, 202, 240, 255]);
  set(pixels, 128, 2, 0, [66, 88, 68, 255]);
  set(pixels, 128, 2, 2, [30, 0, 0, 255]);
  assert.equal(ponySkinHeight(128, 128), 64);
  assert.equal(readPonySkin(pixels, 128, 128).ponyType, 'pegasus');
  assert.equal(readPonySkin(pixels, 128, 128).tail, 4);
  assert.equal(readPonySkin(pixels, 128, 128).mane, 4);
  assert.equal(ponySkinHeight(80, 40), 0);
  assert.equal(ponySkinHeight(128, 96), 0);
  assert.equal(readPonySkin(defaultPonyPixels(), 64, 32).advanced, false);
});

test('both captured pony renderers have articulated parts and different advanced UVs', () => {
  for (const parts of Object.values(ponyModels)) {
    for (const key of ['head', 'headpiece.2', 'muzzleFemale.0', 'muzzleMale.0', 'frontRight', 'frontLeft',
      'hindRight', 'hindLeft', 'tail.20', 'wingLeft.0', 'wingLeftOpen.0', 'wingRightOpen.6']) {
      assert.equal(parts[key][0].length, 6);
      assert.ok(parts[key][1].length >= 20 && parts[key][1].length % 20 === 0);
    }
    for (const [pose, quads] of Object.values(parts)) {
      assert.ok(pose.every(Number.isFinite));
      assert.ok(quads.every(Number.isFinite));
      // The legacy OpenGL texture repeats. A few quads cross the bottom of the atlas.
      assert.ok(quads.every((value, index) => index % 5 < 3 || (value >= 0 && value <= 1.125)));
    }
  }
  assert.notDeepEqual(ponyModels.basic['headpiece.2'][1], ponyModels.advanced['headpiece.2'][1]);
});
