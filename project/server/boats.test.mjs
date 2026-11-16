import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createGame} from './game.mjs';
import {openStore} from './store.mjs';
import {CREATIVE_BOAT_KEY} from '../world/creative-items.mjs';
import {boatHit} from '../world/boats.mjs';
import * as geometry from '../world/geometry.mjs';

test('boats require water, turn and travel with an authoritative rider, persist, and dismount on a clear bank',t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const spawn = [1.5,2,5.5];
  const bounds = {minX:0,maxX:15,minY:0,maxY:15,minZ:0,maxZ:15};
  const base = {hash:'boat-lake',manifest:{spawn,bounds},catalog:new Set(['air','legacy:1:0','legacy:9:0']),
    inBounds:(...coords) => coords.every(value => value >= 0 && value < 16),
    getCell:(x,y,z) => ({key:y === 0 ? 'legacy:1:0' : y !== 1 ? 'air' :
      x >= 2 && x <= 12 && z >= 2 && z <= 12 ? 'legacy:9:0' : 'legacy:1:0',object:null})};
  let now = 0;
  const options = {modules:[],clock:()=>now,creativeItems:new Map([[CREATIVE_BOAT_KEY,{kind:'boat'}]])};
  const game = createGame(base,store,geometry,options);
  const player = store.createPlayer().id, other = store.createPlayer().id;
  game.session(player);
  const request = {requestId:'boat-launch',type:'place_boat',creativeItem:CREATIVE_BOAT_KEY,
    x:4,y:1,z:5,hit:{x:4.5,y:1+8/9,z:5.5},expectedRevision:0,yaw:-Math.PI/2};
  assert.equal(game.action(player,{...request,requestId:'boat-land-error',x:1}).output.error,'boat_requires_water');
  const placed = game.action(player,request);
  assert.equal(placed.status,200,JSON.stringify(placed));
  const entity = placed.output.boat;
  assert.equal(game.action(player,request).replay,true);
  assert.equal(game.action(player,{...request,requestId:'boat-collision'}).output.error,'occupied');

  const eye = [spawn[0],spawn[1]+1.62,spawn[2]];
  const delta = [3,-1.5,0], length = Math.hypot(...delta);
  const direction = delta.map(value => value/length);
  const distance = boatHit(entity,eye,direction);
  assert.ok(Number.isFinite(distance));
  const hit = Object.fromEntries(['x','y','z'].map((axis,i) => [axis,eye[i]+direction[i]*distance]));
  const target = {x:4,y:1,z:5,entity:entity.key,hit};
  const pose = {yaw:-Math.PI/2,pitch:0,motion:'idle'};
  const seated = game.sit(player,target,pose);
  assert.equal(seated.seat.kind,'boat');
  assert.throws(() => game.sit(other,target,pose),{code:'seat_taken'});
  assert.throws(() => game.position(player,{x:0,y:5,z:5}),{code:'movement_blocked'});

  function drive(input,steps) {
    for (let i = 0; i < steps; i++) {
      if (i % 5 === 0) game.driveMinecart(player,pose,undefined,input);
      now += 50;
      game.advanceMinecarts();
    }
  }
  drive([0,1],8);
  assert.ok(game.minecartSnapshot(player).seat.yaw < seated.seat.yaw-.7);
  drive([0,-1],8);
  drive([1,0],90);
  const arrival = game.minecartSnapshot(player);
  assert.ok(arrival.position.x > 11.5 && arrival.position.x < 12.7,JSON.stringify(arrival));
  assert.equal(arrival.position.x,arrival.boats[0].position[0]);
  assert.equal(arrival.position.y,arrival.boats[0].position[1]+.10);
  assert.ok(Math.abs(arrival.position.z-spawn[2]) < .02);
  const exited = game.sit(player,undefined,pose);
  assert.equal(exited.seat,null);
  assert.equal(exited.position.y,2);
  assert.ok(exited.position.x >= 13);
  game.flushMinecarts();
  assert.deepEqual(createGame(base,store,geometry,options).minecartSnapshot(player).boats,arrival.boats);
});
