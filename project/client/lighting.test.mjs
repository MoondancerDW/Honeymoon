import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FACE_SHADE, coverShade, legacyLight, linearByte } from './lighting.mjs';
import { World } from './world-data.mjs';

test('preserves independent sky and block lighting from the imported section', () => {
  const world = new World({palette: ['air']});
  const sky = Buffer.alloc(2048, 0x1f).toString('base64');
  const block = Buffer.alloc(2048, 0xe4).toString('base64');
  world.addChunk({x:-1, z:-1, sections:[{y:4, indices:Buffer.alloc(8192).toString('base64'),
    skyLight:sky, blockLight:block}]});
  const {light} = world.halo(-1,4,-1);
  assert.equal(light[343], 0xf4);
  assert.equal(light[344], 0x1e);
});

test('legacy lighting keeps shaded interiors and the warm block-light curve', () => {
  assert.deepEqual(legacyLight(0x00), [14,14,14]);
  assert.deepEqual(legacyLight(0x08), [93,74,51]);
  assert.deepEqual(legacyLight(0x80), [67,67,67]);
  assert.deepEqual(legacyLight(0xf0), [250,250,250]);
  assert.equal(linearByte(255, FACE_SHADE[0], 255), 81);
  assert.equal(linearByte(255, FACE_SHADE[3], 255), 255);
  assert.equal(coverShade(0xf0), 1);
  assert.ok(Math.abs(coverShade(0xb7) - 11/27) < 1e-9);
});
