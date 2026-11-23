import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pickItemFrame} from '../client/movement.mjs';
import {CREATIVE_FRAME_KEY} from '../world/creative-items.mjs';
import {itemFrameHit} from '../world/item-frames.mjs';
import {paintingAt,paintingHit,paintingItemKey,paintingMount} from '../world/paintings.mjs';
import {createItemFrames} from './item-frames.mjs';
import {openStore} from './store.mjs';

const support=[2,3,4];
const originalFrame={key:'entity:original-frame',type:'ItemFrame',position:[2.5,3.5,3.9375],
  data:{TileX:2,TileY:3,TileZ:4,Dir:0,Direction:2,ItemRotation:0}};
const originalPainting={...paintingAt(support,2,'Aztec2'),key:'entity:original-painting',placed:false};
const sight={x:2.5,y:3,z:1.5,eye:.5};
const direction=[0,0,1];

function fixture(t,entities=[],{face=[0,0,-1],wall=(x,y)=>x===2&&y===3,protectedCell=()=>false,visible=true}={}) {
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const base={inBounds:(...point)=>point.every(value=>value>=0&&value<16),
    publicDecorations:(x,z)=>x===0&&z===0?entities:[]};
  const config={base,store,protectedCell,faceSupports:(x,y)=>wall(x,y),getCurrent:()=>({cell:null}),
    physical:{targetAtHit:()=>({face}),visiblePoint:()=>visible}};
  const frames=createItemFrames(config);
  return {frames,reopen:()=>createItemFrames(config)};
}

function removeInput(entity,revision=entity.revision??0) {
  const origin=[sight.x,sight.y+sight.eye,sight.z];
  const length=(entity.type==='Painting'?paintingHit:itemFrameHit)(entity,origin,direction);
  const [x,y,z]=entity.position.map(Math.floor);
  return {type:'frame_remove',x,y,z,entity:entity.key,expectedRevision:revision,
    hit:{x:origin[0],y:origin[1],z:origin[2]+length}};
}

test('an original frame can be emptied and removed without editing its backing block',t=>{
  const source={...originalFrame,data:{...originalFrame.data,Item:{id:260,Damage:0}}};
  const {frames,reopen}=fixture(t,[source]);
  const emptied=frames.edit(removeInput(source),sight);
  assert.equal(emptied.frames[0].data.Item,undefined);
  assert.deepEqual(emptied.removedStack,{key:'creative:260:0',count:1});
  const removed=frames.edit(removeInput(source,emptied.worldRevision),sight);
  assert.deepEqual(removed.removedStack,{key:CREATIVE_FRAME_KEY,count:1});
  assert.deepEqual(removed.changes,[]);
  assert.equal(reopen().snapshot()[0].removed,true);
  assert.throws(()=>reopen().edit(removeInput(source),sight),{code:'not_a_frame'});
  const replacement=reopen().place({x:2,y:3,z:4,hit:{x:2.5,y:3.5,z:4}},sight);
  assert.equal(replacement.frames.some(frame=>frame.placed),true);
});

test('an original painting disappears from picking after its persisted removal',t=>{
  const {frames,reopen}=fixture(t,[originalPainting]);
  const chunk={entities:[originalPainting]};
  const world={chunks:new Map([['0,0',chunk]]),frames:new Map(),hasChunk:()=>true};
  assert.equal(pickItemFrame(world,[2.5,3.5,1.5],direction)?.kind,'painting');
  const output=frames.edit(removeInput(originalPainting),sight);
  assert.deepEqual(output.removedStack,{key:paintingItemKey,count:1});
  world.frames=new Map(reopen().snapshot().map(frame=>[frame.key,frame]));
  assert.equal(pickItemFrame(world,[2.5,3.5,1.5],direction),null);
});

test('paintings fit the actual wall, do not share a face with frames, and detach with their support',t=>{
  const {frames}=fixture(t,[],{wall:(x,y)=>x>=1&&x<=2&&y>=3&&y<=4});
  const placement={x:2,y:3,z:4,hit:{x:2.5,y:3.5,z:4}};
  const [art]=frames.placePainting(placement,sight).frames;
  assert.equal(art.type,'Painting');
  const mount=paintingMount(art);
  assert.deepEqual(mount.normal,[0,0,-1]);
  assert.deepEqual(mount.art.slice(2),[32,32]);
  assert.throws(()=>frames.place(placement,sight),{code:'occupied'});
  assert.deepEqual(frames.removeSupported(1,4,4),[]);
});

test('genuine reserved decorations and occluded targets remain protected',t=>{
  const sameSupport=(x,y,z)=>[x,y,z].every((value,index)=>value===support[index]);
  const protectedFrame=fixture(t,[originalFrame],{protectedCell:sameSupport}).frames;
  assert.throws(()=>protectedFrame.edit(removeInput(originalFrame),sight),{code:'protected_cell'});
  const occluded=fixture(t,[originalPainting],{visible:false}).frames;
  assert.throws(()=>occluded.edit(removeInput(originalPainting),sight),{code:'outside_reach'});
  const floor=fixture(t,[],{face:[0,1,0]}).frames;
  assert.throws(()=>floor.placePainting({x:2,y:3,z:4,hit:{x:2.5,y:4,z:4.5}},sight),{code:'invalid_frame_face'});
});
