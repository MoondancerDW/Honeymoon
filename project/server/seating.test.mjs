import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createGame} from './game.mjs';
import {openStore} from './store.mjs';
import {displayEntity} from './base.mjs';
import * as geometry from '../world/geometry.mjs';
import {bedMate, seatFor} from '../world/seats.mjs';
import {minecartHit, minecartSeat} from '../world/minecarts.mjs';

const spawn = {x:1.5, y:1, z:2.5};
const foot = {x:3,y:1,z:2,hit:{x:3.1,y:1.5625,z:2.5}};
const head = {x:3,y:1,z:3,hit:{x:3.1,y:1.5625,z:3.5}};
const cells = new Map([['3,1,2','legacy:26:0'], ['3,1,3','legacy:26:8']]);

test('the original mountable furniture has the intended seat height and headings', () => {
  const facings = [0,-Math.PI / 2,Math.PI,Math.PI / 2];
  for (const block of [213,214,215,216,217]) {
    for (let meta = 0; meta < 16; meta++) {
      assert.deepEqual(seatFor({key:`legacy:${block}:${meta}`}),{height:.5,yaw:facings[meta & 3]});
    }
  }
  assert.deepEqual(seatFor({key:'legacy:203:0'}),{height:7/16,yaw:0});
  assert.deepEqual(seatFor({key:'legacy:204:1'}),{height:.4,yaw:-Math.PI/2});
  assert.deepEqual(seatFor({key:'legacy:207:15'},null,Math.PI/2),{height:7/16,yaw:-Math.PI/2});
  assert.equal(seatFor({key:'legacy:203:4'}),null);
  assert.equal(seatFor({key:'legacy:207:11'}),null);
  assert.equal(seatFor({key:'legacy:53:0'}),null);
});

test('all bed orientations and both halves provide the same upright seat pose', () => {
  const offsets = [[0,1],[-1,0],[0,-1],[1,0]];
  for (const [meta,[dx,dz]] of offsets.entries()) {
    const foot = {x:0,y:1,z:0}, head = {x:dx,y:1,z:dz};
    const bottom = {key:`legacy:26:${meta}`}, top = {key:`legacy:26:${meta | 8}`};
    const occupied = {key:`legacy:26:${meta | 12}`};
    assert.deepEqual(seatFor(bottom),seatFor(top));
    assert.deepEqual(seatFor(occupied),seatFor(top));
    assert.equal(seatFor(top).height,9/16);
    assert.deepEqual(bedMate(bottom,foot,() => top),head);
    assert.deepEqual(bedMate(top,head,() => bottom),foot);
  }
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

test('imported passenger cart seats one player through water and rejects forged or occluded hits', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const raw = {type:'Minecart',key:'entity:cart:0',position:[4.5,1.35,2.5],data:{Type:0,Rotation:[0,17],Fire:-1}};
  assert.deepEqual(displayEntity(raw).data,{Type:0,Rotation:[0]});
  assert.deepEqual(displayEntity({...raw,data:{Type:1}}).data,{});
  const bounds = {minX:0,maxX:15,minY:0,maxY:15,minZ:0,maxZ:15};
  let wall = false;
  const base = {hash:'minecart-test',manifest:{spawn:Object.values(spawn),bounds},
    inBounds:(x,y,z) => [x,y,z].every(value => value >= 0 && value <= 15),
    catalog:new Set(['air','legacy:1:0','legacy:9:0']),
    getCell:(x,y,z) => ({key:y === 0 || wall && x === 3 ? 'legacy:1:0' : x === 3 ? 'legacy:9:0' : 'air',object:null}),
    getEntity:(x,z,key) => key === raw.key ? raw : null};
  const game = createGame(base,store,geometry,{allowRemoval:true,modules:[]});
  const one = store.createPlayer().id, two = store.createPlayer().id;
  game.session(one);
  game.session(two);
  const eye = [spawn.x,spawn.y + 1.62,spawn.z];
  const delta = [4.5 - eye[0],1.25 - eye[1],2.5 - eye[2]];
  const length = Math.hypot(...delta);
  const direction = delta.map(value => value / length);
  const distance = minecartHit(raw,eye,direction);
  assert.ok(Number.isFinite(distance));
  const [x,y,z] = eye.map((value,i) => value + distance * direction[i]);
  const target = {x:4,y:1,z:2,entity:raw.key,hit:{x,y,z}};
  const pose = {yaw:Math.PI/2,pitch:0,motion:'idle'};
  assert.throws(() => game.sit(one,{...target,entity:'unknown'},pose),{code:'not_a_seat'});
  assert.throws(() => game.sit(one,{...target,hit:{x,y:4,z}},pose),{code:'outside_reach'});
  wall = true;
  assert.throws(() => game.sit(one,target,pose),{code:'outside_reach'});
  wall = false;
  assert.deepEqual(game.sit(one,target,pose).seat,minecartSeat(raw,pose.yaw));
  assert.throws(() => game.sit(two,target,pose),{code:'seat_taken'});
  assert.deepEqual(game.sit(one,undefined,pose),{seat:null,position:spawn});
  assert.deepEqual(game.sit(two,target,pose).seat,minecartSeat(raw,pose.yaw));
});
