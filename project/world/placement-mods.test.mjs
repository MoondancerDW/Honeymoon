import {test} from 'node:test';
import assert from 'node:assert/strict';
import {biblioFor} from './biblio-models.mjs';
import {blockKey,signalSides} from './block-interactions.mjs';
import {blockFaceVertices} from './block-faces.mjs';
import {collisionFor,selectionFor,shapeFor,tiles} from './geometry.mjs';
import {modWallPlacement,orientModBlock,orientModObject} from './placement-mods.mjs';

const position = [3,12,7];
const target = {x:3,y:12,z:7};
const at = (face, yaw=0, pitch=0) => {
  const [x,y,z]=signalSides[face];
  return {yaw,pitch,against:{x:target.x-x,y:target.y-y,z:target.z-z}};
};
const familyModels = (ids, model) => ({models:Object.fromEntries(ids.flatMap(id=>
  Array.from({length:16},(_,meta)=>[blockKey(id,meta),model])))});
const models = {
  jammy:familyModels([200,201,203,205,208,209,211,218],{}),
  biblio:familyModels([2248,2249,2250,2251,2255],{surfaces:[],groups:{wall:[],wallLid:[],floorLid:[]}}),
};

test('Jammy rotates within each furniture model group and keeps distinct subtypes', () => {
  for (const [id,base] of [[200,1],[200,5],[203,4],[205,0],[205,4],[205,8],[208,8],[211,12],[218,0],[218,4]]) {
    const item=blockKey(id,base);
    const rotated=[0,1,2,3].map(heading=>orientModBlock(item,at(1,heading*Math.PI/2),target,models));
    assert.deepEqual(rotated,[2,1,0,3].map(offset=>blockKey(id,base+offset)));
  }
  for (const [id,meta] of [[200,0],[200,13],[200,14],[200,15],[201,12],[201,13],[201,14],[201,15],[203,0],[205,12],[205,13],[208,12],[218,8]]) {
    assert.equal(orientModBlock(blockKey(id,meta),at(1),target,models),undefined);
  }
  assert.equal(orientModBlock(blockKey(1526,0),at(1,Math.PI/2),target,models),blockKey(1526,1));
  assert.equal(orientModBlock(blockKey(2249,0),at(1,Math.PI/2),target,models),blockKey(2249,3));
  assert.equal(orientModBlock(blockKey(2249,4),at(1,Math.PI/2),target,models),undefined);
});

test('wall blinds and mob heads follow the support face in all four directions', () => {
  for (const [id,base] of [[200,9],[203,8],[203,12],[209,8]]) {
    for (const [face,offset] of [[2,0],[3,2],[4,3],[5,1]]) {
      assert.deepEqual(modWallPlacement(blockKey(id,base),at(face,Math.PI),target,models),
        {cell:blockKey(id,base+offset),requireSupport:face});
    }
    assert.deepEqual(modWallPlacement(blockKey(id,base),at(1),target,models),{error:'invalid_mount_face'});
  }
  assert.equal(modWallPlacement(blockKey(211,12),at(1),target,models),undefined);
});

test('BiblioCraft uses tile angles, preserving wood, contents and wall support', () => {
  const caseItem=blockKey(2255,7);
  const floor=orientModObject(caseItem,null,position,at(1),models);
  assert.equal(floor.type,'WeaponCaseTile');
  assert.equal(floor.data.caseAngle,3);
  assert.deepEqual(modWallPlacement(caseItem,at(1),target,models),{cell:caseItem,requireSupport:1});
  assert.deepEqual(modWallPlacement(caseItem,at(0),target,models),{error:'invalid_mount_face'});
  assert.deepEqual(modWallPlacement(blockKey(2251,3),at(1),target,models),{error:'invalid_mount_face'});
  for (const [face,angle,bounds] of [
    [2,1,['z1',1]], [3,3,['z0',0]], [4,0,['x1',1]], [5,2,['x0',0]],
  ]) {
    const [edge,value]=bounds;
    for (const [id,meta,field,offset] of [[2251,3,'labelAngle',0],[2255,7,'caseAngle',4]]) {
      const key=blockKey(id,meta);
      assert.deepEqual(modWallPlacement(key,at(face),target,models),{cell:key,requireSupport:face});
      const tile=orientModObject(key,{data:{existing:'value'}},position,at(face,Math.PI),models);
      assert.deepEqual(tile.data,{existing:'value',[field]:angle+offset});
      assert.equal(tile.key,'tile:3:12:7');
      const [shape]=biblioFor(models.biblio,id,meta,tile.data).selection;
      assert.equal(shape[edge],value);
    }
  }
  const shelf=blockKey(2250,2);
  assert.deepEqual([0,1,2,3].map(h=>orientModObject(shelf,null,position,at(1,h*Math.PI/2),models).data.bookcaseAngle),[3,2,1,0]);
  assert.equal(orientModObject(shelf,null,position,at(1),models).type,'BookcaseTile');
});

test('RedPower separates appliance yaw, six-way machine fronts and gate mount', () => {
  const igniter=blockKey(763,12);
  const buffer=blockKey(751,2);
  const mixer=blockKey(751,0);
  for (const [heading,worldFace] of [[0,5],[1,1],[2,4],[3,0]]) {
    const input=at(1,heading*Math.PI/2);
    const object=orientModObject(igniter,null,position,input);
    const [shape]=shapeFor({key:igniter,object});
    assert.equal(shape.faces[worldFace],tiles.redPowerMachine+164);
    const [bufferShape]=shapeFor({key:buffer,object:orientModObject(buffer,null,position,input)});
    assert.equal(bufferShape.faces[worldFace],tiles.redPowerMachine+89);
    const [mixerShape]=shapeFor({key:mixer,object:orientModObject(mixer,null,position,input)});
    assert.equal(mixerShape.faces[worldFace],3795);
  }
  assert.equal(orientModObject(igniter,null,position,at(1,0,-1.4)).data.rot,0);
  assert.equal(orientModObject(igniter,null,position,at(1,0,1.4)).data.rot,1);
  const gate=blockKey(753,0);
  for (const [face,edge,value] of [[0,'y0',.875],[1,'y1',.125],[2,'z0',.875],[3,'z1',.125],[4,'x0',.875],[5,'x1',.125]]) {
    const input=at(face,Math.PI/2);
    assert.deepEqual(modWallPlacement(gate,input,target),{cell:gate,requireSupport:face});
    const object=orientModObject(gate,{type:'RPLogic',data:{sid:9}},position,input);
    assert.equal(object.data.rot>>2,face^1);
    assert.equal(object.data.sid,9);
    assert.equal(shapeFor({key:gate,object})[0][edge],value);
  }
  const floorUV=heading=> {
    const object=orientModObject(gate,null,position,at(1,heading));
    return blockFaceVertices(shapeFor({key:gate,object})[0],3).uv;
  };
  assert.notDeepEqual(floorUV(0),floorUV(Math.PI/2));
  const wallSpin=pitch=>orientModObject(gate,null,position,at(3,0,pitch)).data.rot&3;
  assert.notEqual(wallSpin(-.4),wallSpin(.4));
});

test('RedPower device art turns on native axes with subtype and state intact', () => {
  const directional = [
    [761,0,2067],[761,1,2072],[761,2,2073],
    [763,0,565],[763,1,561],[763,2,569],[763,3,569],[763,4,615],
    [763,5,624],[763,7,663],[763,8,637],[763,9,670],[763,10,615],[764,3,557],
  ];
  for (const [id,meta,frontTile] of directional) {
    const key=blockKey(id,meta);
    for (const [heading,worldFace] of [[0,5],[1,1],[2,4],[3,0]]) {
      const object=orientModObject(key,null,position,at(1,heading*Math.PI/2));
      assert.equal(shapeFor({key,object})[0].faces[worldFace],frontTile,key);
    }
  }
  const [solar]=shapeFor(blockKey(764,0));
  assert.equal(solar.y1,1/4);
  assert.equal(solar.faces[3],597);
  const [backplane]=shapeFor(blockKey(760,0));
  assert.equal(backplane.y1,1/8);
  assert.equal(backplane.faces[3],2066);
  const deployer=blockKey(763,0);
  const active=orientModObject(deployer,{data:{ps:1}},position,at(1,Math.PI));
  assert.equal(shapeFor({key:deployer,object:active})[0].faces[4],566);
  const transformer=blockKey(764,4);
  for (let face=0;face<6;face++) {
    const object=orientModObject(transformer,null,position,at(face));
    assert.equal(object.data.rot>>2,face^1);
  }
});

test('RedPower simplified models show their direction at the original bounds', () => {
  const port=tiles.redPowerMachine+57;
  const bounds=shape=>[shape.x0,shape.y0,shape.z0,shape.x1,shape.y1,shape.z1];
  for (const [id,meta,height,portFaces] of [
    [762,0,1,[4,0,5,1]], [764,1,.25,[1,4,0,5]], [764,2,.25,[5,1,4,0]],
    [764,4,.25,[5,1,4,0]], [767,0,1,[5,1,4,0]],
  ]) {
    const key=blockKey(id,meta);
    for (let heading=0;heading<4;heading++) {
      const object=orientModObject(key,null,position,at(1,heading*Math.PI/2));
      const cell={key,object};
      assert.equal(shapeFor(cell)[0].faces.indexOf(port),portFaces[heading],key);
      assert.deepEqual(collisionFor(cell).map(bounds),[[0,0,0,1,height,1]],key);
      assert.deepEqual(selectionFor(cell).map(bounds),[[0,0,0,1,height,1]],key);
    }
  }
  for (const id of [764,767]) {
    const key=blockKey(id,id===764?2:0);
    const down=orientModObject(key,null,position,at(0,0,1.4));
    const up=orientModObject(key,null,position,at(1,0,-1.4));
    assert.equal(shapeFor({key,object:down})[0].faces.indexOf(port),2);
    assert.equal(shapeFor({key,object:up})[0].faces.indexOf(port),3);
  }
});

test('mod logs, stone snakes and cloud machines use their visible directional faces', () => {
  for (const id of [2163,2176]) {
    const key=blockKey(id,2);
    const endTile=shapeFor(key)[0].faces[3];
    for (const [face,meta,meshFace] of [[1,2,3],[3,10,5],[5,6,1]]) {
      const oriented=orientModBlock(key,at(face),target,models);
      assert.equal(oriented,blockKey(id,meta));
      assert.equal(shapeFor(oriented)[0].faces[meshFace],endTile);
    }
  }
  for (const id of [2174,2783,2784,2785]) {
    const head=blockKey(id,1), body=blockKey(id,13);
    const frontTile=shapeFor(head)[0].faces[5];
    for (const [heading,meshFace] of [[0,5],[1,1],[2,4],[3,0]]) {
      const oriented=orientModBlock(head,at(1,heading*Math.PI/2),target,models);
      assert.equal(shapeFor(oriented)[0].faces[meshFace],frontTile);
    }
    assert.equal(orientModBlock(body,at(1),target,models),blockKey(id,14));
    assert.equal(orientModBlock(body,at(3),target,models),body);
    assert.equal(orientModBlock(body,at(5),target,models),blockKey(id,12));
  }
  for (const id of [3254,3255,3256]) {
    const key=blockKey(id,0);
    const frontTile=shapeFor(key)[0].faces[5];
    for (const [heading,meshFace] of [[0,5],[1,1],[2,4],[3,0]]) {
      const object=orientModObject(key,null,position,at(1,heading*Math.PI/2),models);
      assert.equal(shapeFor({key,object})[0].faces[meshFace],frontTile);
    }
  }
});
