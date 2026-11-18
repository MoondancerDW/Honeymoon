import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as geometry from '../world/geometry.mjs';
import {itemFrameModel,itemFrameMount} from '../world/item-frames.mjs';
import {createGame} from './game.mjs';
import {openStore} from './store.mjs';
import {createTestRange} from './test-range.mjs';

const stone={key:'legacy:1:0',id:1,meta:0,category:'build'};
const lamp={key:'creative:768:21',blockKey:'legacy:768:0',id:768,damage:21,kind:'shaped-lamp',category:'build'};
const cover={key:'creative:750:1',blockKey:'legacy:750:0',id:750,damage:1,kind:'microblock',category:'build',
  part:{slot:0,shape:0,material:1}};
const apple={key:'creative:260:0',id:260,damage:0,kind:'flat-item',category:'items'};
const water={key:'legacy:9:0',id:9,meta:0,category:'nature'};
const bed={key:'legacy:26:0',id:26,meta:0,category:'build'};
const tabs=[{id:'build',label:'Строительство'},{id:'nature',label:'Природа'},{id:'items',label:'Предметы'}];
const placeable=new Set([stone.key,water.key,bed.key]);
const items=new Map([lamp,cover,apple].map(item=>[item.key,item]));
const fixture=()=>createTestRange({catalog:{entries:[stone,water,bed,lamp,cover,apple],tabs},placeable,items,
  blockStates:['legacy:17:4','cover:750:0:unused']});

function cellInChunk(chunk,x,y,z) {
  const section=chunk.sections.find(section=>section.y===(y>>4));
  const index=(x&15)+(z&15)*16+(y&15)*256;
  return section ? chunk.palette[Buffer.from(section.indices,'base64').readUInt16LE(2*index)] : 'air';
}

test('the flat range serves matching floor, fixtures, microblock variants, and frame exhibits',()=>{
  const range=fixture();
  assert.deepEqual(range.manifest.spawn,[.5,65,.5]);
  assert.equal(range.hash,fixture().hash);
  assert.equal(range.publicManifest.contentHash,range.hash);
  assert.equal(range.getCell(0,64,0).key,'legacy:98:0');
  assert.equal(range.getCell(0,65,4).key,'air');
  assert.equal(range.getCell(-1,65,2).object.data.Text2,'Блоки справа');
  assert.equal(range.getCell(-8,66,8).key,stone.key);
  assert.equal(range.getCell(-13,66,9).key,'air');
  assert.equal(range.getCell(-12,66,9).key,'legacy:26:8');
  const shapedLamp=range.getCell(-16,66,8);
  assert.equal(shapedLamp.object.type,'RPShLamp');
  assert.equal(shapedLamp.object.data.color,5);
  const part=range.getCell(-20,66,8);
  const chunk=range.publicChunk(-2,0);
  assert.equal(cellInChunk(chunk,-20,66,8),part.key);
  assert.deepEqual(chunk.compositions[part.key],{parts:[cover.part]});
  assert.equal(range.catalog.has('legacy:17:4'),true);
  assert.equal(range.catalog.has('cover:750:0:unused'),false);
  assert.equal(range.publicChunk(400,400),null);
  const frames=range.manifest.chunks.flatMap(([x,z])=>range.publicChunk(x,z).entities);
  assert.equal(frames.length,items.size+placeable.size);
  assert.equal(new Set(frames.map(frame=>frame.key)).size,frames.length);
  assert.equal(frames.some(frame=>frame.data.Item.id===260),true);
  assert.equal(frames.some(frame=>frame.data.Item.id===1&&frame.data.Item.Block===true),true);
  for (const frame of frames) {
    const mount=itemFrameMount(frame);
    assert.deepEqual(mount.normal,[0,0,-1]);
    assert.equal(range.inBounds(...frame.position),true);
    assert.equal(range.getCell(...mount.support).key,'legacy:5:0');
    assert.equal(range.getEntity(frame.position[0],frame.position[2],frame.key),frame);
  }
});

test('the floor ends at the 500 by 500 boundary even in partial chunks',()=>{
  const range=fixture();
  const {minX,maxX,minZ,maxZ}=range.publicManifest.bounds;
  assert.equal(maxX-minX+1,500);
  assert.equal(maxZ-minZ+1,500);
  assert.ok(range.manifest.chunks.some(([x,z])=>x===minX>>4&&z===maxZ>>4));
  for (const [x,z] of [[minX,minZ],[minX,maxZ],[maxX,minZ],[maxX,maxZ]]) {
    const chunk=range.publicChunk(x>>4,z>>4);
    assert.equal(range.inBounds(x,64,z),true);
    assert.equal(cellInChunk(chunk,x,64,z),range.getCell(x,64,z).key);
    assert.equal(cellInChunk(chunk,x,64,z),'legacy:2:0');
  }
  for (const [x,z] of [[minX-1,0],[maxX+1,0],[8,maxZ+1]]) {
    const chunk=range.publicChunk(x>>4,z>>4);
    assert.equal(range.inBounds(x,64,z),false);
    assert.equal(range.getCell(x,64,z).key,'air');
    assert.equal(cellInChunk(chunk,x,64,z),'air');
  }
  assert.equal(range.publicChunk(minX>>4,(minZ-1)>>4),null);
  assert.equal(range.inBounds(0,64,minZ-1),false);
});

test('saved feet outside the range are restored to spawn and players cannot teleport there',t=>{
  const range=fixture();
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const player=store.createPlayer().id;
  const {maxX,maxZ}=range.manifest.bounds;
  const edge={x:maxX+.5,y:65,z:maxZ+.5};
  const outside={...edge,z:maxZ+1.5};
  store.putState('movement',player,'pos',1,{world:range.hash,position:outside,stance:'stand'});
  const game=createGame(range,store,geometry,{modules:[],persistPositions:true});
  assert.deepEqual(game.session(player).position,{x:.5,y:65,z:.5});
  assert.deepEqual(game.teleport(player,edge).position,edge);
  assert.throws(()=>game.teleport(player,outside),{code:'outside_playable_area'});
});

test('a displayed frame can be turned using normal game actions with its mod block preserved',t=>{
  const range=fixture();
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const player=store.createPlayer().id;
  const game=createGame(range,store,geometry,{modules:[],creativeBlocks:placeable,creativeItems:items,allowRemoval:true});
  game.teleport(player,{x:8.5,y:65,z:5.5});
  const key='frame:8:66:8:2';
  const frame=range.getEntity(8,7,key);
  const result=game.action(player,{type:'frame_use',requestId:'range-turn-frame',x:8,y:66,z:7,
    entity:key,expectedRevision:0,hit:{x:8.5,y:66.5,z:7.935}});
  assert.equal(result.status,200,JSON.stringify(result.output));
  assert.equal(result.output.frames[0].data.ItemRotation,1);
  assert.deepEqual(result.output.frames[0].data.Item,frame.data.Item);
});

test('the invisible-frame inventory item can be shown using the shared frame sprite',()=>{
  const frame={data:{TileX:0,TileY:0,TileZ:0,Direction:2,Item:{id:389,Damage:1}}};
  const model=itemFrameModel(frame,{'389:0':{uv:[.1,.2,.3,.4]}});
  assert.equal(model.item.length,1);
  assert.deepEqual(model.item[0].uv,[.1,.4,.3,.4,.3,.2,.1,.2]);
});
