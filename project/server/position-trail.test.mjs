import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {Movement} from '../client/movement.mjs';
import {POSITION_TRAIL_LIMIT} from '../world/player-body.mjs';
import * as geometry from '../world/geometry.mjs';
import {createHoneymoonServer} from './index.mjs';
import {createGame} from './game.mjs';
import {openStore} from './store.mjs';

const bounds = {minX: -16, maxX: 15, minY: 60, maxY: 75, minZ: -32, maxZ: 0};
const covers = {'-9': 'cover:750:0:vertical', '-8': 'cover:750:0:upper'};
const compositions = {
  [covers[-9]]: {parts: [{slot: 21, shape: 0, material: 2}]},
  [covers[-8]]: {parts: [{slot: 23, shape: 0, material: 2}]},
};
const cellAt = (x, y, z) => {
  const key = y === 64 ? 'legacy:1:0' : y === 65 && z === -18 ? (covers[x] ?? 'air') : 'air';
  return {key, object: null, ...compositions[key]};
};
const inBounds = (x, y, z) => x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY
  && z >= bounds.minZ && z <= bounds.maxZ;
const tuple = ({x, y, z}) => [x, y, z];
const point = ([x, y, z]) => ({x, y, z});

test('position packets follow the client around the spawn cover corner, with retry and bounds checks', async t => {
  const feet = {x:-8.26, y:65, z:-17.55};
  const movement = new Movement({manifest: {bounds}, hasChunk: () => true, cellAt});
  movement.grounded = true;
  const samples = [];
  const speed = Math.SQRT1_2 * 3.8;
  for (let tick = 0; tick < 13; tick++) {
    movement.update(feet, -speed, speed, false, .0125, {recordStep: p => samples.push(tuple(p))});
  }
  const [from, ...trail] = samples.slice(1);
  const end = point(trail.at(-1));
  const base = {manifest: {bounds, spawn: from, compositions}, hash: 'position-trail', inBounds, getCell: cellAt};
  let now = 0;
  const app = createHoneymoonServer({base, geometry, state: ':memory:', clock: () => now});
  t.after(() => app.close());
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let cookie;
  async function post(path, body) {
    const response = await fetch(`${origin}/api/${path}`, {method: 'POST', headers: {'Content-Type': 'application/json',
      ...(cookie && {Cookie: cookie})}, body: JSON.stringify(body)});
    cookie ??= response.headers.get('set-cookie')?.split(';')[0];
    return {status: response.status, body: await response.json()};
  }
  assert.equal((await post('session', {})).status, 200);
  now += 137.5;
  assert.deepEqual(await post('position', end), {status: 409, body: {error: 'movement_blocked', position: point(from), stance:'stand'}});
  const packet = {...end, from, trail, requestId: 'round-corner'};
  const accepted = await post('position', packet);
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body.position, end);
  assert.deepEqual(await post('position', packet), {status: 200,
    body: {position: end, effects: [], changes: [], worldRevision: accepted.body.worldRevision, stance:'stand'}});

  const next = {...end, z: end.z + .04};
  assert.equal((await post('position', {...next, from, trail: [tuple(next)], requestId: 'stale-from'})).status, 409);
  const excessive = Array.from({length: POSITION_TRAIL_LIMIT + 1}, () => tuple(next));
  assert.equal((await post('position', {...next, from: tuple(end), trail: excessive, requestId: 'over-count'})).status, 400);
  assert.equal((await post('position', {...end, from: tuple(end), trail: [tuple(next)], requestId: 'wrong-tail'})).status, 400);

  // A circular trail can have a zero net displacement and still exceed the movement budget.
  const loop = Array.from({length: POSITION_TRAIL_LIMIT}, (_, index) => tuple(index % 2 === 0 ? {...end, z: end.z + .3} : end));
  assert.deepEqual(await post('position', {...end, from: tuple(end), trail: loop, requestId: 'excessive-loop'}),
    {status: 409, body: {error: 'movement_blocked', position: end, stance:'stand'}});
  const throughCover = [end.x + .28, end.y, end.z - .03];
  assert.deepEqual(await post('position', {...end, from: tuple(end), trail: [throughCover, tuple(end)], requestId: 'blocked-piece'}),
    {status: 409, body: {error: 'movement_blocked', position: end, stance:'stand'}});
  assert.equal((await post('position', {...next, from: tuple(end), trail: [tuple(next)], requestId: 'after-reject'})).status, 200);
});

test('positions validate body changes at their own step and do not stand through a solid roof', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const spawn = [1.5,1,.5];
  const bounds = {minX:-4,maxX:8,minY:0,maxY:8,minZ:-4,maxZ:8};
  const base = {manifest:{bounds,spawn},hash:'pony-body-fixture',
    inBounds:(x,y,z) => x >= -4 && x <= 8 && y >= 0 && y <= 8 && z >= -4 && z <= 8,
    getCell:(x,y) => ({key:y === 0 && x < 4 ? 'legacy:1:0' : x === 2 && y === 1 ? 'legacy:44:8' : 'air'})};
  const game = createGame(base,store,geometry,{modules:[],playerSize:() => 'normal'});
  const player = store.createPlayer().id;
  game.session(player);
  const send = (from, trail, requestId) => game.position(player,{...point(trail.at(-1)),from,trail,requestId});
  assert.throws(() => send(spawn,[[1.55,1,.5,'crawl']],'false-transition'),{code:'movement_blocked'});
  const crouch = send(spawn,[[...spawn,'crouch']],'begin-crouch');
  assert.equal(crouch.stance,'crouch');
  assert.throws(() => send(spawn,[[1.76,1,.5,'crouch']],'blocked-crouch'),{code:'movement_blocked'});
  const trail = [[...spawn,'crawl'],[1.76,1,.5,'crawl']];
  const moved = send(spawn,trail,'crawl-under-roof');
  assert.equal(moved.stance,'crawl');
  assert.equal(send(spawn,trail,'crawl-under-roof').stance,'crawl');
  assert.equal(game.poseFor(player,{motion:'walk',stance:'stand'}).stance,'crawl');
  assert.throws(() => send(tuple(moved.position),[[...tuple(moved.position),'stand']],'blocked-stand'),{code:'movement_blocked'});
  const clear = send(tuple(moved.position),[[...spawn,'crawl'],[...spawn,'stand']],'back-to-standing');
  assert.equal(clear.stance,'stand');
  const edge = [4.29,1,.5];
  game.teleport(player,point(edge));
  send(edge,[[...edge,'crouch']],'crouch-at-edge');
  assert.throws(() => send(edge,[[4.31,1,.5,'crouch']],'try-edge-step'),{code:'movement_blocked'});
});
