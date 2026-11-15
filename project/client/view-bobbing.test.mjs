import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ViewBobbing} from './view-bobbing.mjs';

test('camera walks through alternating offsets and settles at rest', () => {
  const bob = new ViewBobbing();
  bob.step(.2, .05, true, 0);
  const first = bob.sample();
  assert.ok(first.x > 0 && first.y > 0 && first.roll > 0 && first.pitch < 0);
  for (let tick = 0; tick < 10; tick++) bob.step(.2, .05, true, 0);
  assert.ok(bob.sample().x < 0);
  for (let tick = 0; tick < 25; tick++) bob.step(0, .05, true, 0);
  assert.ok(Math.abs(bob.sample().x) < .00001);
  bob.step(.05, .05, false, -5);
  assert.ok(bob.sample().pitch < 0);
  bob.reset();
  assert.ok(Object.values(bob.sample()).every(value => value === 0));
});
