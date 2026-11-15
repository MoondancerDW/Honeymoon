import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FIRE_FRAMES, FIRE_SIZE, fireSpriteSheet} from './fire-animation.mjs';
import {shapeFor} from './geometry.mjs';

test('legacy fire uses two animated terrain sprites with clear non-solid edges', () => {
  const fire = shapeFor('legacy:51:15')[0];
  assert.equal(fire.mode,'fire');
  assert.equal(fire.kind,'cross');
  assert.equal(fire.solid,false);
  assert.equal(fire.emissive,true);
  const pixels = fireSpriteSheet();
  const frameSize = FIRE_SIZE * FIRE_SIZE * 2 * 4;
  assert.equal(pixels.length,frameSize * FIRE_FRAMES);
  const alpha = frame => pixels.slice(frame * frameSize,(frame + 1) * frameSize)
    .filter((_,index) => index % 4 === 3);
  const first = alpha(0);
  assert.ok(first.includes(0) && first.includes(255));
  assert.notDeepEqual(alpha(1),first);
  assert.notDeepEqual(alpha(FIRE_FRAMES - 1),first);
});
