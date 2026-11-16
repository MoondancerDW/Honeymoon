import test from 'node:test';
import assert from 'node:assert/strict';
import {createFluidSimulation} from './fluids.mjs';
import {shapeFor,collisionFor} from '../world/geometry.mjs';
import {FAKE_WATER} from '../world/fluid-state.mjs';
import {movementMedium} from '../world/block-movement.mjs';

function fixture({height=0,spreading} = {}) {
  const cells=new Map();
  let now=0;
  const read=(x,y,z)=>cells.get(`${x},${y},${z}`) ?? {x,y,z,cell:y<=height ? 'legacy:1:0' : null};
  const simulation=createFluidSimulation({read,clock:()=>now,shape:shapeFor,collision:collisionFor,spreading,
    topSupports:(x,y,z)=>y<=height,
    canWrite:(x,y,z)=>Math.abs(x)<11 && Math.abs(z)<11 && y>=0 && y<12});
  function write(x,y,z,cell,extras={}) {
    const value={x,y,z,cell,...extras};
    cells.set(`${x},${y},${z}`,value);
    simulation.changed([value]);
  }
  function tick(ms=250) {
    now+=ms;
    const plan=simulation.advance();
    for (const entry of plan?.cells ?? []) cells.set(`${entry.x},${entry.y},${entry.z}`,entry);
    if (plan) simulation.changed(plan.cells);
    return plan;
  }
  return {read,write,tick,key:(x,y,z)=>read(x,y,z).cell};
}

test('water falls first, spreads with levels and recedes after source removal', () => {
  const {write,tick,key}=fixture({spreading:true});
  write(0,3,0,'legacy:9:0');
  tick();
  assert.equal(key(0,2,0),'legacy:8:8');
  assert.equal(key(1,3,0),null);
  tick();
  assert.equal(key(0,1,0),'legacy:8:8');
  for (let i=0;i<12;i++) tick();
  assert.equal(key(2,1,0),'legacy:8:2');
  assert.equal(key(7,1,0),'legacy:8:7');
  assert.equal(key(8,1,0),null);
  write(0,3,0,null);
  for (let i=0;i<28;i++) tick();
  assert.equal(key(0,1,0),null);
  assert.equal(key(2,1,0),null);
});

test('lava has its own timing, cools next to water, and fake water does not flow or slow ponies', () => {
  const {write,tick,key,read}=fixture({spreading:true});
  write(-2,1,0,'legacy:11:0');
  write(2,1,0,FAKE_WATER);
  tick(1000);
  assert.equal(key(-1,1,0),null);
  assert.equal(key(3,1,0),null);
  tick(500);
  assert.equal(key(-1,1,0),'legacy:10:2');
  assert.equal(movementMedium((x,y,z)=>({key:read(x,y,z).cell}),-1.5,1.1,.5),'lava');
  write(-2,1,1,FAKE_WATER);
  tick(1500);
  assert.equal(key(-2,1,0),'legacy:49:0');
  assert.equal(movementMedium((x,y,z)=>({key:read(x,y,z).cell}),2.5,1.1,.5),null);
});

test('with spreading paused, sources and existing flows stay in their cells and logged fluid stays contained', () => {
  const {write,tick,key,read}=fixture();
  write(0,3,0,'legacy:9:0');
  write(4,3,0,'legacy:11:0');
  write(-4,1,0,'legacy:8:4');
  write(-8,1,0,'legacy:10:3');
  write(8,1,0,'legacy:44:0',{fluid:'water'});
  for (let step=0; step<10; step++) assert.equal(tick(1500),null);
  assert.equal(key(0,3,0),'legacy:9:0');
  assert.equal(key(4,3,0),'legacy:11:0');
  assert.equal(key(-4,1,0),'legacy:8:4');
  assert.equal(key(-8,1,0),'legacy:10:3');
  assert.equal(read(8,1,0).fluid,'water');
  for (const point of [[0,2,0],[4,2,0],[-3,1,0],[-7,1,0],[7,1,0]]) assert.equal(key(...point),null);
  assert.equal(movementMedium((x,y,z)=>({key:read(x,y,z).cell}),.5,3.1,.5),'water');
  assert.equal(movementMedium((x,y,z)=>({key:read(x,y,z).cell}),4.5,3.1,.5),'lava');
});

test('lava still solidifies when water is placed directly against it without spreading', () => {
  const {write,tick,key}=fixture();
  write(0,1,0,'legacy:11:0');
  write(1,1,0,'legacy:9:0');
  assert.deepEqual(tick(1500)?.cells.map(({x,y,z,cell})=>({x,y,z,cell})),[{x:0,y:1,z:0,cell:'legacy:49:0'}]);
  assert.equal(key(1,1,0),'legacy:9:0');
  assert.equal(tick(1500),null);
});

test('ground plants fall from invalid support and remain on foliage and in water', () => {
  const {write,tick,key,read}=fixture();
  write(0,1,0,'legacy:37:0');
  assert.deepEqual(tick(100)?.detached,[{at:[0,1,0],cell:'legacy:37:0'}]);
  assert.equal(key(0,1,0),null);
  write(0,1,0,'legacy:18:0');
  write(0,2,0,'legacy:37:0');
  write(2,1,0,'legacy:3:0');
  write(2,2,0,'legacy:31:1',{fluid:'water'});
  tick(100);
  assert.equal(key(0,2,0),'legacy:37:0');
  assert.equal(read(2,2,0).fluid,'water');
});
