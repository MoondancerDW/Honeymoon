import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createGame} from './game.mjs';
import {openStore} from './store.mjs';
import * as geometry from '../world/geometry.mjs';
import {seatFor} from '../world/seats.mjs';

const spawn = {x:1.5, y:1, z:2.5};
const foot = {x:3,y:1,z:2,hit:{x:3.1,y:1.5625,z:2.5}};
const head = {x:3,y:1,z:3,hit:{x:3.1,y:1.5625,z:3.5}};
const cells = new Map([['3,1,2','legacy:26:0'], ['3,1,3','legacy:26:8']]);

test('the original mountable furniture has the intended seat height and headings', () => {
  for (const block of [213,214,215,216,217]) {
    assert.deepEqual(seatFor({key:`legacy:${block}:13`}),{height:.5,yaw:-Math.PI / 2});
  }
  assert.deepEqual(seatFor({key:'legacy:203:0'}),{height:7/16,yaw:0});
  assert.deepEqual(seatFor({key:'legacy:204:1'}),{height:.4,yaw:-Math.PI/2});
  assert.deepEqual(seatFor({key:'legacy:207:15'},null,Math.PI/2),{height:7/16,yaw:-Math.PI/2});
  assert.equal(seatFor({key:'legacy:203:4'}),null);
  assert.equal(seatFor({key:'legacy:207:11'}),null);
  assert.equal(seatFor({key:'legacy:53:0'}),null);
});

test('bed halves share occupancy and releasing a seat restores a collision-free standing position', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const bounds = {minX:0,maxX:15,minY:0,maxY:15,minZ:0,maxZ:15};
  const base = {hash:'seats-test',manifest:{spawn:Object.values(spawn),bounds},
    inBounds:(x, y, z) => [x,y,z].every(value => value >= 0 && value <= 15),
    catalog:new Set(['air','legacy:1:0',...cells.values()]),
    getCell:(x,y,z) => ({key:cells.get(`${x},${y},${z}`) ?? (y === 0 ? 'legacy:1:0' : 'air'),object:null})};
  const game = createGame(base,store,geometry,{allowRemoval:true, modules:[]});
  const one = store.createPlayer().id;
  const two = store.createPlayer().id;
  game.session(one);
  game.session(two);
  const pose = {yaw:0,pitch:0,motion:'idle'};
  assert.equal(game.poseFor(one,{...pose,motion:'sit'}).motion,'idle');
  const seated = game.sit(one,foot,pose);
  assert.deepEqual(seated.position,{x:3.5,y:1.5625,z:2.5});
  assert.deepEqual(game.sit(one,foot,pose),seated);
  assert.equal(game.poseFor(one,pose).motion,'sit');
  assert.throws(() => game.sit(two,head,pose),{code:'seat_taken'});
  assert.throws(() => game.position(one,spawn),{code:'movement_blocked'});
  const removing = game.action(two,{x:3,y:1,z:3,requestId:'seat-break',type:'remove',expectedRevision:0});
  assert.equal(removing.status,409);
  assert.equal(removing.output.error,'seat_taken');
  assert.deepEqual(game.leaveSeat(one),spawn);
  assert.deepEqual(game.sit(one,undefined,pose),{seat:null,position:spawn});
  assert.equal(game.sit(two,head,pose).position.z,3.5);
  assert.equal(game.respawn(two).seat,null);
  assert.equal(game.sit(one,head,pose).position.z,3.5);
});
