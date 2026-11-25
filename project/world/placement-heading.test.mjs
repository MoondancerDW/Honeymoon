import assert from 'node:assert/strict';
import {test} from 'node:test';
import {blockKey,signalSides} from './block-interactions.mjs';
import {shapeFor} from './geometry.mjs';
import {orientPlacedBlock,orientWallAttachment} from './placement-heading.mjs';
import {harvestRule} from './survival-tools.mjs';

const target={x:0,y:0,z:0};
const at=(face,yaw=0)=>{
  const [x,y,z]=signalSides[face];
  return {against:{x:-x,y:-y,z:-z},yaw};
};

test('native directional blocks preserve the held material and anvil damage',()=>{
  for (const [heading,pumpkin,stair] of [[0,0,3],[1,3,1],[2,2,2],[3,1,0]]) {
    const input=at(1,heading*Math.PI/2);
    assert.equal(orientPlacedBlock('legacy:91:0',input,target),blockKey(91,pumpkin));
    assert.equal(orientPlacedBlock('legacy:3247:0',input,target),blockKey(3247,stair));
    for (const meta of [0,1,2]) {
      const anvil=orientPlacedBlock(blockKey(145,meta),{...input,creative:true},target);
      assert.equal(anvil,blockKey(145,(meta<<2)|((heading+1)&1)));
      assert.equal(harvestRule(anvil,{key:'creative:257:0'}).drops[0].cell,blockKey(145,meta));
    }
  }
  assert.equal(orientPlacedBlock('legacy:145:9',at(1,Math.PI/2),target),'legacy:145:8');
  assert.equal(orientPlacedBlock('legacy:17:3',at(5),target),'legacy:17:7');
  assert.equal(orientPlacedBlock('legacy:17:3',at(2),target),'legacy:17:11');
  for (let meta=0;meta<16;meta++) assert.equal(orientPlacedBlock(blockKey(162,meta),at(5),target),blockKey(162,meta));
  const chisel=orientPlacedBlock('legacy:2808:8',at(1),target);
  assert.equal(chisel,'legacy:2808:11');
  assert.notDeepEqual(shapeFor(chisel)[0].faces,shapeFor('legacy:2808:3')[0].faces);
  assert.equal(harvestRule(chisel).drops[0].cell,'legacy:2808:8');
  assert.equal(harvestRule('legacy:3247:3').drops[0].cell,'legacy:3247:0');
  assert.equal(harvestRule('legacy:2160:6',{key:'creative:257:0'}).drops[0].cell,'legacy:2160:0');
});

test('walls determine the ladder, cocoa, tripwire hook, vine and skull orientation',()=>{
  const directional=[[65,[2,3,4,5]],[127,[8,10,9,11]],[131,[0,2,3,1]],[106,[1,4,8,2]],[144,[2,3,4,5]]];
  for (const [id,states] of directional) {
    for (const [index,meta] of states.entries()) {
      const face=index+2;
      const placed=orientWallAttachment(blockKey(id,id===127?8:0),at(face,Math.PI),target);
      assert.equal(placed.cell,blockKey(id,meta));
      assert.equal(placed.requireSupport,face);
    }
  }
  assert.equal(orientWallAttachment('legacy:65:0',at(1),target).error,'invalid_mount_face');
  assert.equal(orientWallAttachment('legacy:106:4',at(0),target).cell,'legacy:106:0');
  assert.equal(orientWallAttachment('legacy:127:0',at(2),target).jungleLog,true);
  for (const [meta,edge,bound] of [[2,'z1',1],[3,'z0',0],[4,'x1',1],[5,'x0',0]]) {
    assert.equal(shapeFor(blockKey(144,meta))[0][edge],bound);
  }
  const skull=Rot=>shapeFor({key:'legacy:144:1',object:{data:{Rot}}});
  assert.notEqual(skull(1)[1].angle,skull(7)[1].angle);
});

test('new portal planes follow the selected axis and old portals infer it from neighbors',()=>{
  const eastWest=orientPlacedBlock('legacy:90:0',at(1),target);
  const northSouth=orientPlacedBlock('legacy:90:0',at(1,Math.PI/2),target);
  assert.equal(shapeFor(eastWest)[0].x1,1);
  assert.equal(shapeFor(northSouth)[0].z1,1);
  assert.equal(shapeFor('legacy:90:0',(x,y,z)=>x===0&&y===0&&z===1?'legacy:90:0':'air')[0].z1,1);
});
