import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createMinecarts} from './minecarts.mjs';
import {createGame} from './game.mjs';
import {openStore} from './store.mjs';
import * as geometry from '../world/geometry.mjs';
import {CREATIVE_MINECART_KEY} from '../world/creative-items.mjs';
import {railFor} from '../world/rails.mjs';
import {minecartHit, minecartSeat} from '../world/minecarts.mjs';

function fixture(t) {
  const store = openStore(':memory:');
  const blocks = new Map();
  let time = 0;
  const options = {base:{inBounds:() => true},store,clock:() => time,canMove:() => true,
    solidAt:(x,y,z) => blocks.get([x,y,z].join()) === 'legacy:1:0',
    cellAt:(x,y,z) => blocks.get([x,y,z].join())};
  const carts = createMinecarts(options);
  t.after(() => store.close());
  return {store,carts,blocks,options,tick() { time += 50; }};
}

test('placed minecart follows a curve and slope, carries its rider, and saves its position', t => {
  const {store,carts,blocks,options,tick} = fixture(t);
  for (const [address,meta] of [['2,1,2',1],['3,1,2',1],['4,1,2',7],['4,1,3',0],['4,1,4',5],['4,2,5',0],['4,2,6',0]]) {
    blocks.set(address,'legacy:66:' + meta);
  }
  const cart = store.atomic(() => carts.place({x:2,y:1,z:2,yaw:-Math.PI/2},railFor(blocks.get('2,1,2'))));
  carts.accept(cart);
  assert.throws(() => store.atomic(() => carts.place({x:2,y:1,z:2},railFor(blocks.get('2,1,2')))),{code:'occupied'});
  const key = cart.entity.key;
  const rider = {player:'rider',yaw:-Math.PI/2};
  const riders = new Map([[key,rider]]);
  const route = [];
  for (let frame = 0; frame < 60; frame++) {
    if (frame % 4 === 0) carts.steering(key,1);
    tick();
    carts.advance(riders,(player,entity) => {
      assert.equal(player,'rider');
      rider.yaw = minecartSeat(entity,rider.yaw).yaw;
      route.push(entity);
    });
  }
  assert.ok(route.some(({position:[x,,z]}) => x > 4 && x < 4.5 && z > 2.5 && z < 3));
  assert.ok(route.some(({data}) => Math.abs(data.Rotation[1]) > 40));
  const [finished] = carts.snapshot();
  assert.deepEqual(finished.position,[4.5,2.375,6.98]);
  carts.flush();
  assert.deepEqual(createMinecarts(options).snapshot(),[finished]);
  carts.steering(key,-1);
  tick();
  carts.advance(riders,(_player,entity) => { rider.yaw = minecartSeat(entity,rider.yaw).yaw; });
  assert.ok(carts.snapshot()[0].position[2] < finished.position[2]);

  blocks.delete('4,2,6');
  tick();
  let dismounted = false;
  carts.advance(riders,(player,entity) => { dismounted = player === 'rider' && entity === null; });
  assert.equal(dismounted,true);
  store.atomic(() => carts.remove(key));
  carts.accept(undefined,key);
  assert.deepEqual(createMinecarts(options).snapshot(),[]);
});

test('a powered rail launches a resting cart away from a solid end stop', t => {
  const {store,carts,blocks,tick} = fixture(t);
  blocks.set('1,1,2','legacy:1:0');
  blocks.set('2,1,2','legacy:27:9');
  blocks.set('3,1,2','legacy:66:1');
  const cart = store.atomic(() => carts.place({x:2,y:1,z:2},railFor(blocks.get('2,1,2'))));
  carts.accept(cart);
  for (let frame = 0; frame < 15; frame++) { tick(); carts.advance(new Map(),() => {}); }
  assert.ok(carts.snapshot()[0].position[0] > 3);
});

test('a session places and rides a cart across a supported grade without changing block revisions', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const bounds = {minX:0,maxX:15,minY:0,maxY:15,minZ:0,maxZ:15};
  const blocks = new Map([['2,1,2','legacy:66:1'],['3,1,2','legacy:66:2'],
    ['4,1,2','legacy:1:0'],['4,2,2','legacy:66:1'],['5,1,2','legacy:1:0'],['5,2,2','legacy:66:1']]);
  const base = {hash:'cart-route',manifest:{bounds,spawn:[1.5,1,2.5]},catalog:new Set(['air','legacy:1:0',...blocks.values()]),
    inBounds:(...coords) => coords.every(n => n >= 0 && n < 16),
    getCell:(x,y,z) => ({key:blocks.get([x,y,z].join()) ?? (y === 0 ? 'legacy:1:0' : 'air'),object:null})};
  let time = 0;
  const game = createGame(base,store,geometry,{modules:[],clock:() => time,
    creativeItems:new Map([[CREATIVE_MINECART_KEY,{kind:'minecart'}]])});
  const player = store.createPlayer().id;
  game.session(player);
  const place = {type:'place_minecart', x:2,y:1,z:2,hit:{x:2.5,y:1.125,z:2.5},
    expectedRevision:0, requestId:'place-cart', creativeItem:CREATIVE_MINECART_KEY,yaw:-Math.PI/2};
  const bad = game.action(player,{...place,requestId:'wrong-cart',x:1,y:0});
  assert.equal(bad.output.error,'minecart_requires_rail');
  const first = game.action(player,place);
  assert.equal(first.status,200,JSON.stringify(first));
  const again = game.action(player,place);
  assert.equal(again.replay,true);
  assert.deepEqual(again.output,first.output);
  const entity = first.output.minecart;
  const eye = [1.5,2.62,2.5];
  const delta = [1,-1.25,0];
  const dir = delta.map(value => value / Math.hypot(...delta));
  const hitDistance = minecartHit(entity,eye,dir);
  const hit = Object.fromEntries(['x','y','z'].map((axis,i) => [axis,eye[i] + dir[i] * hitDistance]));
  const pose = {yaw:-Math.PI/2,pitch:0,motion:'sit'};
  const mounted = game.sit(player,{x:2,y:1,z:2,hit,entity:entity.key},pose);
  assert.equal(mounted.seat.entity,entity.key);
  for (let frame = 0; frame < 45; frame++) {
    if (frame % 4 === 0) game.driveMinecart(player,pose,1);
    time += 50;
    game.advanceMinecarts();
  }
  const moving = game.minecartSnapshot(player);
  assert.equal(moving.seat.entity,entity.key);
  assert.deepEqual(moving.entities[0].position,[5.98,2.375,2.5]);
  assert.deepEqual(moving.position,{x:5.98,y:2.1875,z:2.5});
  assert.equal(game.worldRevision(),0);
  const dismount = game.sit(player,undefined,pose);
  assert.equal(dismount.seat,null);
  assert.ok(dismount.position.x > 3.5);
});
