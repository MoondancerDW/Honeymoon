import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {Movement, movementSpeed} from '../client/movement.mjs';
import {positionBatch} from '../client/position-packet.mjs';
import {FREE_FALL_START_SPEED, POSITION_TRAIL_LIMIT, WORLD_GRAVITY} from '../world/player-body.mjs';
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

  const page=crypto.randomUUID();
  const {body:{movement:ownership}}=await post('position-state',{page,start:true});
  const stream=await fetch(`${origin}/api/events?movement=${page}&presence=1`,{headers:{Cookie:cookie}});
  t.after(()=>stream.body.cancel().catch(()=>{}));
  assert.equal(stream.status,200);
  const after={...next,z:next.z+.04};
  const legacy={...after,from:tuple(next),trail:[tuple(after)],requestId:'another-legacy-tab'};
  assert.deepEqual(await post('position',legacy),
    {status:409,body:{error:'movement_page_replaced',position:next,stance:'stand'}});
  const modern=await post('position',{...legacy,requestId:'sequenced-packet',page,epoch:ownership.epoch,first:1});
  assert.equal(modern.body.movement.accepted,1);
  assert.deepEqual(modern.body.movement.position,after);
  // Another current page can claim control. The obsolete open stream no longer owns motion.
  await post('position-state',{page:crypto.randomUUID(),start:true});
  const again={...after,z:after.z+.04};
  assert.equal((await post('position',{...again,from:tuple(after),trail:[tuple(again)],requestId:'legacy-after-v2'})).status,200);
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

test('a world-height fall starts at Minecraft speed, accelerates and arrives through valid batches', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const bounds = {minX:-4,maxX:4,minY:0,maxY:511,minZ:-4,maxZ:4};
  const start = [.5,500,.5];
  const base = {manifest:{bounds,spawn:start},hash:'gravity-fixture',
    inBounds:(x,y,z) => x >= -4 && x <= 4 && y >= 0 && y <= 511 && z >= -4 && z <= 4,
    getCell:(_x,y) => ({key:y === 0 ? 'legacy:1:0' : 'air'})};
  let now = 0;
  const game = createGame(base,store,geometry,{modules:[],clock:() => now});
  const movement = new Movement({manifest:base.manifest, hasChunk:() => true, cellAt:base.getCell});
  const player = store.createPlayer().id;
  const {position} = game.session(player);
  const feet = {...position};
  const page = crypto.randomUUID();
  const {epoch} = game.movementChannel.open(player,'device',page,true);
  let first = 1;
  let from = start;
  let largestDrop = 0;
  while (!movement.grounded && now < 11000) {
    const samples = [];
    for (let step = 0; step < 8 && !movement.grounded; step++) {
      movement.update(feet,0,0,false,.016,{recordStep:p => samples.push(tuple(p))});
    }
    now += 128;
    if (!movement.grounded) {
      const elapsed = now / 1000;
      const expected = start[1] - FREE_FALL_START_SPEED * elapsed - .5 * WORLD_GRAVITY * elapsed**2;
      assert.ok(Math.abs(feet.y-expected) < 1e-7, `height ${feet.y} instead of ${expected} at ${now} ms`);
    }
    const batch = positionBatch(from,samples);
    assert.equal(batch.trail.length,samples.length);
    largestDrop = Math.max(largestDrop,from[1]-batch.target[1]);
    const packet = {...point(batch.target),page,epoch,first,from,trail:batch.trail,requestId:`fall-batch-${first}`};
    const state = game.movementChannel.receive(player,'device',packet,body => game.position(player,body));
    first += batch.trail.length;
    assert.equal(state.accepted,first-1);
    from = tuple(state.position);
  }
  assert.ok(largestDrop > 12);
  const duration = (Math.sqrt(FREE_FALL_START_SPEED**2 + 2*WORLD_GRAVITY*(start[1]-1)) - FREE_FALL_START_SPEED) / WORLD_GRAVITY;
  assert.ok(Math.abs(now/1000 - duration) < .128);
  assert.ok(movement.grounded);
  assert.ok(Math.abs(from[1]-1) < .005);
});

test('the server accepts the faster high sprint while automatic flight clears a wall', t => {
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const bounds={minX:-12,maxX:32,minY:0,maxY:511,minZ:-12,maxZ:12};
  const start=[-2.5,274,.5];
  const base={manifest:{bounds,spawn:start},hash:'high-auto-flight',
    inBounds:(x,y,z)=>x>=-12 && x<=32 && y>=0 && y<=511 && z>=-12 && z<=12,
    getCell:(x,y,z)=>({key:x===0 && z===0 && y>=274 && y<=277 ? 'legacy:1:0' : 'air'})};
  let now=0;
  const game=createGame(base,store,geometry,{modules:[],clock:()=>now});
  const player=store.createPlayer().id;
  const feet={...game.session(player).position};
  const movement=new Movement({manifest:base.manifest,hasChunk:()=>true,cellAt:base.getCell});
  const page=crypto.randomUUID();
  const {epoch}=game.movementChannel.open(player,'device',page,true);
  const speed=movementSpeed({flying:true,sprint:true,y:feet.y});
  let first=1;
  let from=start;
  for (let i=0;i<5;i++) {
    const samples=[];
    for (let tick=0;tick<8;tick++) movement.fly(feet,speed,0,0,.016,p=>samples.push(tuple(p)),false,true);
    now+=128;
    const batch=positionBatch(from,samples,undefined,true);
    assert.equal(batch.trail.length,samples.length);
    const packet={...point(batch.target),page,epoch,first,from,trail:batch.trail,
      requestId:`flight-batch-${first}`,pose:{motion:'fly'}};
    const state=game.movementChannel.receive(player,'device',packet,body=>game.position(player,body));
    first+=batch.trail.length;
    assert.equal(state.accepted,first-1);
    from=tuple(state.position);
  }
  assert.ok(from[0]>12 && from[1]>=278 && from[1]<279);
});

test('increasing avatar height at the world ceiling keeps its flight position', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const bounds = {minX:-4,maxX:4,minY:0,maxY:511,minZ:-4,maxZ:4};
  const base = {manifest:{bounds,spawn:[.5,65,.5]},hash:'ceiling-profile',
    inBounds:(x,y,z) => x >= -4 && x <= 4 && y >= 0 && y <= 511 && z >= -4 && z <= 4,
    getCell:() => ({key:'air'})};
  let size = 'normal';
  const game = createGame(base,store,geometry,{modules:[],playerSize:() => size});
  const player = store.createPlayer().id;
  game.session(player);
  const high = {x:2.5,y:510.5,z:-1.5};
  assert.deepEqual(game.teleport(player,high).position,high);
  size = 'large';
  const local = {...high,y:510};
  assert.deepEqual(game.reconcileProfile(player).position,local);
  assert.deepEqual(game.session(player).position,local);
});

test('a seated foal that grows under a low ceiling leaves the seat in a fitting stance', t => {
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const bounds={minX:0,maxX:15,minY:0,maxY:15,minZ:0,maxZ:15};
  const base={manifest:{bounds,spawn:[8.5,1,8.5]},hash:'seat-resize',
    inBounds:(x,y,z)=>[x,y,z].every(value=>value>=0 && value<=15),
    getCell:(x,y,z)=>({key:y===0 || (y===2 && x===4 && z===4)?'legacy:1:0':'air'})};
  let size='small';
  const game=createGame(base,store,geometry,{modules:[],playerSize:()=>size});
  const player=store.createPlayer().id;
  game.session(player);
  const position={x:4.5,y:1,z:4.5};
  assert.deepEqual(game.teleport(player,position).position,position);
  assert.equal(game.sit(player,undefined,{yaw:0},true).seat.kind,'ground');
  size='large';
  assert.deepEqual(game.reconcileProfile(player),{seat:null,position,stance:'crawl'});
  assert.equal(game.session(player).stance,'crawl');
});

test('a restarted movement channel returns an authoritative saved position for the same world', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const bounds = {minX:-4,maxX:4,minY:0,maxY:511,minZ:-4,maxZ:4};
  const spawn = [.5,65,.5];
  const base = {manifest:{bounds,spawn},hash:'movement-checkpoint',
    inBounds:(x,y,z) => x >= -4 && x <= 4 && y >= 0 && y <= 511 && z >= -4 && z <= 4,
    getCell:() => ({key:'air'})};
  const options = {modules:[],persistPositions:true};
  const player = store.createPlayer().id;
  const first = createGame(base,store,geometry,options);
  first.session(player);
  const page = crypto.randomUUID();
  const high = {x:2.5,y:500,z:-1.5};
  first.teleport(player,high);
  const before = first.movementChannel.open(player,'device',page,true);
  first.checkpointPositions();
  const second = createGame(base,store,geometry,options);
  const {movement:after} = second.movementChannel.restart(player,'device',page,before.epoch);
  assert.notEqual(after.epoch,before.epoch);
  assert.deepEqual(after.position,high);
  assert.deepEqual(second.session(player).position,high);
  const anotherWorld = createGame({...base,hash:'different-world'},store,geometry,options);
  assert.deepEqual(anotherWorld.session(player).position,point(spawn));
  const obstructed = createGame({...base,getCell:(_x,y) => ({key:y === high.y ? 'legacy:1:0' : 'air'})},
    store,geometry,options);
  assert.deepEqual(obstructed.session(player).position,point(spawn));
});
