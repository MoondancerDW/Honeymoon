import assert from 'node:assert/strict';
import {test} from 'node:test';
import {positionBatch} from './position-packet.mjs';
import {FLIGHT_SPRINT_SPEED, POSITION_BATCH_LIMIT} from '../world/player-body.mjs';

test('batches a long fall in steps allowed by the server', () => {
  const start = [0,220,0];
  const falling = Array.from({length:32}, (_, index) => [0,220 - (index + 1) * .5,0]);
  const sent = positionBatch(start, falling);
  assert.equal(sent.trail.length, 12);
  assert.deepEqual(sent.target, [0,214,0]);
  assert.equal(positionBatch(sent.target, falling.slice(sent.trail.length)).target[1], 208);
});

test('retains predicted walk steps through the requested final step', () => {
  const start = [0,65,0];
  const walking = Array.from({length:30}, (_, index) => [(index + 1) / 10,65,0]);
  assert.equal(positionBatch(start, walking).target[0], POSITION_BATCH_LIMIT);
  assert.deepEqual(positionBatch(start, walking, walking[2]).target, walking[2]);
});

test('batches a full 130 ms flight sprint update without accumulating client movement', () => {
  const start = [0,65,0];
  const sprint = Array.from({length:13}, (_, index) => [(index + 1) * .01 * FLIGHT_SPRINT_SPEED,65,0]);
  assert.deepEqual(positionBatch(start, sprint).trail, sprint);
});
