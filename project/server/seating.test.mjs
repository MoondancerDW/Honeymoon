import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createGame} from './game.mjs';
import {createNpcs} from './npcs.mjs';
import {physics} from './physics.mjs';
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

test('both bed halves share the render and collision shape, including room below the mattress', () => {
  for (const meta of [0,1,2,3,8,9,10,11,12,13,14,15]) {
    const key = `legacy:26:${meta}`;
    const mesh = geometry.bedMesh(key);
    assert.equal(geometry.collisionFor(key),mesh);
    assert.equal(geometry.selectionFor(key),mesh);
    const [{x0,y0,z0,x1,y1,z1}]=mesh;
    assert.deepEqual([x0,y0,z0,x1,y1,z1],[0,3/16,0,1,9/16,1]);
  }
  const getCell=(x,y,z)=>({key:cells.get(`${x},${y},${z}`)??'air'});
  const colliders=physics({manifest:{}},geometry,getCell);
  assert.equal(colliders.collides({x:3.5,y:1,z:2.5},{halfWidth:.2,height:1/8}),false);
  assert.equal(colliders.collides({x:3.5,y:1,z:2.5},{halfWidth:.2,height:1/4}),true);
});

test('imported airborne NPCs regain mattress contact while authored poses stay unchanged',t=>{
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const bounds={minX:0,maxX:15,minY:0,maxY:15,minZ:0,maxZ:15};
  const base={hash:'npc-bed-test',manifest:{spawn:Object.values(spawn),bounds},
    inBounds:(...coords)=>coords.every(n=>n>=0&&n<16),
    catalog:new Set(['air','legacy:1:0',...cells.values()]),
    getCell:(x,y,z)=>({key:cells.get(`${x},${y},${z}`)??(y===0?'legacy:1:0':'air'),object:null})};
  const game=createGame(base,store,geometry,{modules:[]});
  const common={name:'Patient',scale:1,health:20,combat:{},lines:{},equipment:[],model:'npcpony'};
  const airborne={OnGround:0,Motion:[0,-.155,0],FallDistance:4};
  const patient={...common,id:'patient',native:airborne,animation:'crawl',position:{x:3.5,y:1.9841,z:2.5}};
  const aboveHead={...common,id:'other',native:airborne,animation:'sneak',position:{x:3.5,y:2.0625,z:3.5}};
  const posed={...patient,id:'posed',native:{...airborne,OnGround:1},position:{...patient.position}};
  const away={...patient,id:'away',position:{x:5.5,y:1.9841,z:3.5}};
  const npcs=createNpcs({base,store,game,source:{definitions:[patient,aboveHead,posed,away],shared:{}},
    editorAuth:{isAdmin:()=>true,require:()=>{}}});
  const player=store.createPlayer().id;
  game.session(player);
  const shown=Object.fromEntries(npcs.snapshot(player).npcs.map(npc=>[npc.id,npc]));
  assert.deepEqual(shown.patient.position,{x:3.5,y:1.5625,z:2.5});
  assert.equal(shown.patient.animation,'crawl');
  assert.equal(shown.other.position.y,1.5625);
  assert.equal(shown.other.animation,'sneak');
  assert.equal(shown.posed.position.y,1.9841);
  assert.equal(shown.away.position.y,1.9841);
  const corrected=npcs.editor(player).definitions.find(npc=>npc.id==='patient');
  assert.equal(corrected.position.y,1.5625);
  npcs.edit(player,{action:'save',npcId:'patient',definition:{...corrected,position:{...corrected.position,y:1.9841}}});
  assert.equal(npcs.snapshot(player).npcs.find(npc=>npc.id==='patient').position.y,1.9841);
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
  assert.deepEqual(seated.position,{x:3.5,y:1.5625,z:3});
  assert.equal(seated.seat.bed,true);
  assert.deepEqual(game.sit(one,foot,pose),seated);
  assert.equal(game.poseFor(one,pose).motion,'sit');
  assert.equal(game.poseFor(one,pose).stance,'crawl');
  assert.throws(() => game.sit(two,head,pose),{code:'seat_taken'});
  assert.throws(() => game.position(one,spawn),{code:'movement_blocked'});
  const removing = game.action(two,{x:3,y:1,z:3,requestId:'seat-break',type:'remove',expectedRevision:0});
  assert.equal(removing.status,409);
  assert.equal(removing.output.error,'seat_taken');
  assert.deepEqual(game.leaveSeat(one),spawn);
  assert.deepEqual(game.sit(one,undefined,pose),{seat:null,position:spawn});
  assert.equal(game.sit(two,head,pose).position.z,3);
  assert.equal(game.respawn(two).seat,null);
  assert.equal(game.sit(one,head,pose).position.z,3);
});

test('ground seating keeps exact feet and heading, is idempotent, and releases when support disappears',t=>{
  const store = openStore(':memory:');
  t.after(()=>store.close());
  const bounds = {minX:0,maxX:15,minY:0,maxY:15,minZ:0,maxZ:15};
  let floor=true;
  const base = {hash:'ground-seat-test',manifest:{spawn:Object.values(spawn),bounds},
    inBounds:(x,y,z)=>[x,y,z].every(value=>value>=0 && value<=15),
    catalog:new Set(['air','legacy:1:0','legacy:44:0','legacy:9:0']),
    getCell(x,y,z) {
      const key=x>=3&&x<=5&&z>=3&&z<=5&&y===0 ? 'legacy:44:0' :
        x===6&&z===6&&y===1 ? 'legacy:9:0' :
          floor&&y===0 ? 'legacy:1:0' : 'air';
      return {key,object:null};
    }};
  const game=createGame(base,store,geometry,{modules:[]});
  const player=store.createPlayer().id;
  const pose={yaw:-1.25,pitch:.1,motion:'idle'};
  game.session(player);

  const sit = () => game.sit(player,undefined,pose,true);
  const stand = () => game.sit(player,undefined,pose,false);
  const first=sit();
  assert.deepEqual(first,{seat:{...spawn,yaw:pose.yaw,kind:'ground'},position:spawn,stance:'stand'});
  assert.deepEqual(sit(),first);
  assert.equal(game.poseFor(player,pose).motion,'sit');
  assert.equal(game.poseFor(player,pose).yaw,pose.yaw);
  assert.throws(()=>game.position(player,{...spawn,z:3.5}),{code:'movement_blocked'});
  assert.deepEqual(stand(),{seat:null,position:spawn,stance:'stand'});
  assert.deepEqual(stand(),{seat:null,position:spawn,stance:'stand'});
  assert.equal(game.poseFor(player,{...pose,motion:'sit'}).motion,'idle');

  const above={...spawn,y:3};
  game.teleport(player,above);
  assert.throws(sit,{code:'seat_requires_ground'});
  assert.equal(game.session(player).seat,null);
  game.teleport(player,{x:6.5,y:1,z:6.5});
  assert.throws(sit,{code:'seat_requires_ground'});

  const slab={x:4.3,y:.5,z:4.7};
  game.teleport(player,slab);
  assert.deepEqual(sit().position,slab);
  assert.deepEqual(stand().position,slab);

  game.teleport(player,spawn);
  sit();
  floor=false;
  assert.equal(game.session(player).seat,null);
  assert.equal(game.poseFor(player,{...pose,motion:'sit'}).motion,'idle');
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
  const distance = minecartHit(displayEntity(raw),eye,direction);
  assert.ok(Number.isFinite(distance));
  const [x,y,z] = eye.map((value,i) => value + distance * direction[i]);
  const target = {x:4,y:1,z:2,entity:raw.key,hit:{x,y,z}};
  const pose = {yaw:Math.PI/2,pitch:0,motion:'idle'};
  assert.throws(() => game.sit(one,{...target,entity:'unknown'},pose),{code:'not_a_seat'});
  assert.throws(() => game.sit(one,{...target,hit:{x,y:4,z}},pose),{code:'outside_reach'});
  wall = true;
  assert.throws(() => game.sit(one,target,pose),{code:'outside_reach'});
  wall = false;
  assert.deepEqual(game.sit(one,target,pose).seat,{...minecartSeat(raw,pose.yaw),entity:raw.key});
  assert.throws(() => game.sit(two,target,pose),{code:'seat_taken'});
  assert.deepEqual(game.sit(one,undefined,pose),{seat:null,position:spawn});
  assert.deepEqual(game.sit(two,target,pose).seat,{...minecartSeat(raw,pose.yaw),entity:raw.key});
});
