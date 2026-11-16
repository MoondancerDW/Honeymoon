import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as geometry from '../world/geometry.mjs';
import {createGame} from './game.mjs';
import {openStore} from './store.mjs';

const stone='legacy:1:0', flower='legacy:37:0', gate='legacy:107:0';
const unsupportedMaterials=['legacy:51:0','legacy:9:0','legacy:11:0',flower];
const fixture=new Map([
  ['10,1,8',flower],
  ['8,1,12','legacy:44:0'],
]);
const normalSurface={x:8,y:0,z:10}, noSurface={x:10,y:1,z:8};

function sandbox(t) {
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const base={
    hash:'placement-test',
    catalog:new Set([stone,flower,gate,...unsupportedMaterials]),
    manifest:{spawn:[8.5,1,8.5],bounds:{minX:0,maxX:15,minY:0,maxY:15,minZ:0,maxZ:15}},
    inBounds:(x,y,z)=>[x,y,z].every(value=>value>=0&&value<=15),
    getCell:(x,y,z)=>({key:fixture.get(`${x},${y},${z}`) ?? (y===0?stone:'air'),object:null}),
  };
  const game=createGame(base,store,geometry,{allowRemoval:true,modules:[],creativeBlocks:base.catalog});
  const player=store.createPlayer().id;
  game.session(player);
  return (input)=>game.action(player,input);
}

test('new fire, water, lava and flowers require a solid floor but allow ordinary placement on one',async t=>{
  for(const [i,cell] of unsupportedMaterials.entries()) await t.test(cell,t=>{
    const action=sandbox(t);
    const attempt=(against,target,expectedRevision=0)=>action({type:'place',x:against.x,y:against.y+1,z:against.z,
      against,expectedRevision,cell,requestId:`surface-${i}-${target}`});
    const noFloor=attempt(noSurface,'unsupported');
    assert.equal(noFloor.status,409,JSON.stringify(noFloor.output));
    assert.equal(noFloor.output.error,'missing_support');
    const placed=attempt(normalSurface,'supported');
    assert.equal(placed.status,200,JSON.stringify(placed.output));
    assert.equal(placed.output.changes[0].cell,cell);
  });
});

test('partial blocks still accept explicitly targeted waterlogging and lavalogging',async t=>{
  for(const [i,cell] of ['legacy:9:0','legacy:11:0'].entries()) await t.test(cell,t=>{
    const action=sandbox(t);
    const result=action({type:'place_liquid',x:8,y:1,z:12,cell,creative:true,
      hit:{x:8.5,y:1.5,z:12.5},requestId:`pour-slab-${i}`,expectedRevision:0});
    assert.equal(result.status,200,JSON.stringify(result.output));
    assert.equal(result.output.changes[0].cell,'legacy:44:0');
    assert.equal(result.output.changes[0].fluid,i?'lava':'water');
  });
});

test('gate placement follows each cardinal facing and fence corners leave the diagonal open',async t=>{
  const directions=[[0,2],[Math.PI/2,1],[Math.PI,0],[-Math.PI/2,3]];
  for(const [yaw,expected] of directions) await t.test(`gate:${expected}`,t=>{
    const action=sandbox(t);
    const result=action({type:'place',x:8,y:1,z:10,against:normalSurface,expectedRevision:0,cell:gate,
      yaw,requestId:`oriented-gate-${expected}`});
    assert.equal(result.status,200,JSON.stringify(result.output));
    assert.equal(result.output.changes[0].cell,`legacy:107:${expected}`);
    assert.equal(geometry.collisionFor(`legacy:107:${expected|4}`).length,0);
  });
  const fence='legacy:85:0';
  const corners=geometry.collisionFor(fence,(dx,dy,dz)=>!dy&&(dx===1||dz===1)?fence:'air');
  assert.equal(corners.length,2);
  assert.ok(corners.every(box=>box.y1===1.5));
  const contains=(x,z)=>corners.some(box=>x>=box.x0&&x<=box.x1&&z>=box.z0&&z<=box.z1);
  assert.ok(contains(.5,.9)&&contains(.9,.5));
  assert.equal(contains(.9,.9),false);
});
