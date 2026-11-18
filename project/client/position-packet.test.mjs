import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {createHoneymoonServer} from '../server/index.mjs';
import * as geometry from '../world/geometry.mjs';
import {positionBatch, positionSendInterval} from './position-packet.mjs';
import {FLIGHT_SPRINT_SPEED, FLIGHT_VERTICAL_MULTIPLIER, POSITION_BATCH_LIMIT} from '../world/player-body.mjs';

test('batches a long fall in steps allowed by the server', () => {
  const start = [0,220,0];
  const falling = Array.from({length:32}, (_, index) => [0,220 - (index + 1) * .5,0]);
  const sent = positionBatch(start, falling);
  assert.equal(sent.trail.length, 32);
  assert.deepEqual(sent.target, [0,204,0]);
  const flying = positionBatch(start, falling, undefined, true);
  assert.deepEqual(flying.target, [0,214,0]);
});

test('retains predicted walk steps through the requested final step', () => {
  const start = [0,65,0];
  const walking = Array.from({length:36}, (_, index) => [3 * (index + 1) / 20,65,0]);
  assert.equal(positionBatch(start, walking).target[0], POSITION_BATCH_LIMIT);
  assert.deepEqual(positionBatch(start, walking, walking[2]).target, walking[2]);
});

test('batches a full 130 ms flight sprint update without accumulating client movement', () => {
  const start = [0,65,0];
  const sprint = Array.from({length:13}, (_, index) => [(index + 1) * .01 * FLIGHT_SPRINT_SPEED,65,0]);
  assert.deepEqual(positionBatch(start, sprint).trail, sprint);
  assert.equal(positionSendInterval(start,sprint,130),130);
});

test('batches a full 130 ms vertical flight sprint at the horizontal speed', () => {
  const start = [0,65,0];
  const ascent = Array.from({length:13}, (_, i) =>
    [0,65 + (i + 1) * .01 * FLIGHT_SPRINT_SPEED * FLIGHT_VERTICAL_MULTIPLIER,0]);
  assert.ok(ascent.at(-1)[1] - start[1] < POSITION_BATCH_LIMIT);
  assert.deepEqual(positionBatch(start, ascent).trail, ascent);
  assert.equal(positionSendInterval(start,ascent,130),130);
});

test('pacing sends consecutive backlog packets within the server movement budget', async t => {
  const start = [0,65,0];
  const bounds = {minX:-16,maxX:15,minY:60,maxY:75,minZ:-16,maxZ:15};
  const base = {manifest:{bounds,spawn:start},hash:'position-pacing',
    inBounds:(x,y,z) => x >= -16 && x < 16 && y >= 60 && y <= 75 && z >= -16 && z < 16,
    getCell:(_x,y) => ({key:y===64?'legacy:1:0':'air',object:null})};
  let now = 1000;
  const app = createHoneymoonServer({base,geometry,state:':memory:',clock:() => now});
  t.after(() => app.close());
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let cookie;
  async function post(path, body) {
    const response = await fetch(`${origin}/api/${path}`,{method:'POST',headers:{'Content-Type':'application/json',
      ...(cookie && {Cookie:cookie})},body:JSON.stringify(body)});
    cookie ??= response.headers.get('set-cookie')?.split(';')[0];
    return {status:response.status,body:await response.json()};
  }
  function send(from, batch, requestId) {
    const [x,y,z] = batch.target;
    return post('position',{x,y,z,from,trail:batch.trail,requestId});
  }

  assert.equal((await post('session',{})).status,200);
  const queued = Array.from({length:52},(_, index) => [(index+1)*.16,65,0]);
  const first = positionBatch(start,queued);
  const next = positionBatch(first.target,queued.slice(first.trail.length));
  now += 500;
  assert.equal((await send(start,first,'backlog-first')).status,200);
  const previousSentAt = now;
  now += 130;
  assert.equal((await send(first.target,next,'backlog-next')).body.error,'movement_blocked');
  now = previousSentAt + positionSendInterval(first.target,next.trail,130);
  const accepted = await send(first.target,next,'backlog-next');
  assert.equal(accepted.status,200);
  assert.deepEqual(accepted.body.position,{x:queued.at(-1)[0],y:65,z:0});
});
