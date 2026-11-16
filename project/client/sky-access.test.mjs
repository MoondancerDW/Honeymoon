import assert from 'node:assert/strict';
import {test} from 'node:test';
import {skyProfile} from './sky-access.mjs';
import {World} from './world-data.mjs';

const palette=['air','legacy:1:0','legacy:20:0','legacy:50:0','legacy:44:0'];
const roof=9, floor=1, west=12, east=20, north=4, south=12, column=[15,8];
const upperSide=1<<9,lowerSide=1<<8;

function roomChunk(cx,openRoof) {
  const geometry=Buffer.alloc(8192), sky=Buffer.alloc(2048), block=Buffer.alloc(2048);
  const light=(bytes,index,value)=> { bytes[index>>1] |= value<<((index&1)*4); };
  for(let y=0;y<16;y++) for(let z=0;z<16;z++) for(let local=0;local<16;local++) {
    const x=cx*16+local, i=local+z*16+y*256;
    const room=x>=west&&x<=east&&z>=north&&z<=south&&y>=floor&&y<=roof;
    const boundary=x===west||x===east||z===north||z===south||y===floor||y===roof;
    const gap=openRoof&&x===column[0]&&z===column[1]&&y===roof;
    const stone=room&&boundary&&!gap;
    const lamp=x===14&&y===2&&z===8;
    geometry.writeUInt16LE(stone ? 1 : lamp ? 3 : 0, i*2);
    const daylight=stone ? 0 : room&&!gap ? (openRoof ? 15-Math.abs(x-column[0])-Math.abs(z-column[1]) : 0) : 15;
    light(sky,i,daylight);
    if(lamp) light(block,i,14);
  }
  return {x:cx,z:0,sections:[{y:0,indices:geometry.toString('base64'),skyLight:sky.toString('base64'),
    blockLight:block.toString('base64')}],objects:[]};
}

function create(openRoof,neighbors=true) {
  const world=new World({palette,bounds:{minY:0,maxY:63},compositions:{}});
  world.addChunk(roomChunk(0,openRoof));
  if(neighbors) world.addChunk(roomChunk(1,openRoof));
  return world;
}

test('roof edits update a shaft and preserve the torch channel, including section halo data',()=>{
  const world=create(false);
  assert.equal(world.lightAt(14,2,8),14);
  world.setOverride({x:15,y:roof,z:8,cell:null,revision:1});
  const dirty=world.updateLighting();
  assert.ok(dirty.has('0,0,0') && dirty.has('1,0,0'));
  assert.equal(world.lightAt(15,2,8)>>4,15);
  assert.equal(world.lightAt(14,2,8)>>4,14);
  assert.equal(world.lightAt(14,2,8)&15,14);
  const top=(2+1)*18*18+(8+1)*18+15+1;
  assert.equal(world.halo(0,0,0).light[top]>>4,15);
  world.setOverride({x:15,y:roof,z:8,cell:'legacy:1:0',revision:2});
  world.updateLighting();
  assert.equal(world.lightAt(14,2,8),14);
  assert.equal(world.lightAt(15,2,8)>>4,0);
});

test('an opaque roof darkens the room after a neighboring chunk arrives',()=>{
  const world=create(true,false);
  world.setOverride({x:15,y:roof,z:8,cell:'legacy:44:0',revision:1});
  world.updateLighting();
  assert.equal(world.lightAt(15,2,8)>>4,0);
  const dirty=world.updateLighting(world.addChunk(roomChunk(1,true)));
  assert.ok(dirty.has('1,0,0'));
  assert.equal(world.lightAt(16,2,8)>>4,0);
  assert.equal(world.lightAt(14,2,8)&15,14);
});

test('a glass window admits indirect daylight and solid replacement closes it',()=>{
  const world=create(false);
  const window={x:west,y:6,z:8,cell:'legacy:20:0',revision:1};
  world.setOverride(window);
  world.updateLighting();
  assert.ok(world.lightAt(13,6,8)>>4>=12);
  assert.equal(world.lightAt(11,6,8)>>4,15);
  world.setOverride({...window,cell:'legacy:1:0',revision:2});
  world.updateLighting();
  assert.equal(world.lightAt(13,6,8)>>4,0);
  assert.equal(world.lightAt(11,6,8)>>4,15);
});

test('opaque slabs and horizontal RedPower plates seal vertical light while glass admits it',()=>{
  const vertical=upperSide|lowerSide;
  assert.equal(skyProfile({key:'legacy:44:0'})&vertical,vertical);
  assert.equal(skyProfile({key:'legacy:20:0'})&vertical,0);
  const part={slot:0,shape:0,material:2};
  assert.equal(skyProfile({key:'legacy:750:0',parts:[part]})&vertical,vertical);
  assert.equal(skyProfile({key:'legacy:750:0',parts:[{...part,material:7}]})&vertical,0);
});
