import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {loadBase} from './base.mjs';
import {openStore} from './store.mjs';
import {restoreFromBackup,restoreOriginalEdits} from './restore-original-map.mjs';
import {microblockKey} from '../world/microblocks.mjs';
import {filledVoxels,voxelKey,voxelMaterialAt,writeVoxel} from '../world/voxel-chisel.mjs';

const stone='legacy:1:0', wood='legacy:5:0', sourcePanel='cover:750:0:restore-test';
const floor={slot:0,shape:0,material:2}, ceiling={slot:1,shape:0,material:5};
const sign={key:'original-sign',position:[0,1,0],type:'Sign',data:{Text1:'Original'}};
const address=(x,y,z)=>`${x},${y},${z}`;
const terrain=new Map([
  ['0,1,0',['legacy:63:0',sign]], ['1,1,0',[stone]], ['2,1,0',[sourcePanel]], ['3,1,0',[sourcePanel]],
  ['4,1,0',[stone]], ['5,1,0',[stone]], ['6,1,0',['legacy:64:0']], ['6,2,0',['legacy:64:8']],
  ['7,1,0',['legacy:64:0']], ['7,2,0',['legacy:64:8']],
]);
const base={
  hash:'original-structures',
  manifest:{compositions:{[sourcePanel]:{parts:[floor]}}},
  catalog:new Set([stone,wood,sourcePanel,microblockKey,voxelKey,'legacy:63:0','legacy:64:0','legacy:64:8']),
  inBounds:()=>true,
  getCell(x,y,z) {
    const [key,object=null]=terrain.get(address(x,y,z)) ?? ['air'];
    return {key,object};
  },
};

function write(store,x,cell,{y=1,owner=null,parts=null,voxels}={}) {
  store.writeEdit({x,y,z:0,cell,object:null,revision:store.nextRevision(),voxels},
    JSON.stringify(base.getCell(x,y,0)),owner,parts);
}

test('restoration preserves player blocks and fills missing original blocks, microblocks and voxels',t=>{
  const store=openStore(':memory:');
  t.after(()=>store.close());
  store.rebase(base,()=>false,(...point)=>JSON.stringify(base.getCell(...point)));
  const {id:owner}=store.createPlayer();
  write(store,0,wood,{owner});
  write(store,0,null);
  write(store,1,wood,{owner});
  write(store,2,microblockKey,{parts:[{...ceiling,owner}]});
  const ownedFloor={...floor,material:3,owner};
  write(store,3,microblockKey,{parts:[ownedFloor]});
  const missing=writeVoxel(filledVoxels(stone),1,null);
  write(store,4,voxelKey,{owner,voxels:writeVoxel(missing,2,wood)});
  write(store,5,voxelKey,{voxels:missing});
  write(store,6,null);
  write(store,6,null,{y:2});
  write(store,7,null);
  write(store,7,wood,{y:2,owner});
  write(store,8,wood,{owner});
  const revision=store.worldRevision();

  assert.throws(()=>restoreOriginalEdits(base,store,{expectedRevision:revision-1}),/save changed/);
  assert.throws(()=>restoreOriginalEdits(base,store,{verifyChunk:x=>{if(x===6) throw new Error('Corrupt original');}}),/Corrupt original/);
  assert.equal(store.worldRevision(),revision);
  assert.equal(store.getEdit(0,1,0).cell,null);

  const stats=restoreOriginalEdits(base,store,{expectedRevision:revision});
  assert.deepEqual(stats,{blocks:3,parts:1,voxels:2,blockedBlocks:3,blockedParts:1,blockedVoxels:1,revision:revision+1});
  assert.equal(store.getEdit(0,1,0).cell,'legacy:63:0');
  assert.deepEqual(store.getEdit(0,1,0).object,sign);
  assert.equal(store.getEditOwner(0,1,0),null);
  assert.equal(store.getEditOwner(1,1,0),owner);
  assert.equal(store.getEdit(1,1,0).cell,wood);
  assert.deepEqual(store.getMicroParts(2,1,0),[{...floor,owner:null},{...ceiling,owner}]);
  assert.deepEqual(store.getMicroParts(3,1,0),[ownedFloor]);
  const sculpture=store.getEdit(4,1,0).voxels;
  assert.equal(voxelMaterialAt(sculpture,1),stone);
  assert.equal(voxelMaterialAt(sculpture,2),wood);
  assert.equal(store.getEdit(5,1,0).voxels,undefined);
  assert.equal(store.getEdit(5,1,0).cell,stone);
  assert.equal(store.getEdit(6,1,0).cell,'legacy:64:0');
  assert.equal(store.getEdit(6,2,0).cell,'legacy:64:8');
  assert.equal(store.getEdit(7,1,0).cell,null);
  assert.equal(store.getEdit(7,2,0).cell,wood);
  assert.equal(store.getEdit(8,1,0).cell,wood);
  assert.equal(restoreOriginalEdits(base,store).revision,revision+1);

  // A version update that changes the global hash but leaves this original
  // cell intact must keep the player's replacement at the same position.
  const nextBase={...base,hash:'unrelated-map-change'};
  store.rebase(nextBase,()=>false,(...point)=>JSON.stringify(nextBase.getCell(...point)));
  assert.equal(store.getEdit(1,1,0).cell,wood);
  assert.equal(store.getEditOwner(1,1,0),owner);
});

test('restoring from a separate map verifies chunk contents before touching the saved terrain',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'honeymoon-map-test-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const live=join(directory,'live'), archive=join(directory,'archive');
  const state=join(directory,'save.sqlite');
  const indices=Buffer.alloc(8192);
  indices.writeUInt16LE(1,2*(1+16+256));
  const content=JSON.stringify({x:0,z:0,sections:[{y:0,indices:indices.toString('base64')}],entities:[],objects:[]});
  const chunkHash=createHash('sha256').update(content).digest('hex');
  const world={schemaVersion:1,bounds:{minX:0,minY:0,minZ:0,maxX:15,maxY:15,maxZ:15},
    palette:['air',stone],chunks:[[0,0]],chunkHash:{'0.0.json':chunkHash}};
  for (const folder of [live,archive]) {
    mkdirSync(join(folder,'chunks'),{recursive:true});
    writeFileSync(join(folder,'world.json'),JSON.stringify(world));
    writeFileSync(join(folder,'chunks','0.0.json'),content);
  }
  const original=loadBase(live);
  const store=openStore(state);
  try {
    store.rebase(original,()=>false,(...point)=>JSON.stringify(original.getCell(...point)));
    store.writeEdit({x:1,y:1,z:1,cell:null,object:null,revision:store.nextRevision()},
      JSON.stringify(original.getCell(1,1,1)));
  } finally { store.close(); }
  const archivedChunk=join(archive,'chunks','0.0.json');
  writeFileSync(archivedChunk,content+' ');
  await assert.rejects(restoreFromBackup(archive,live,state,join(directory,'invalid-chunk.sqlite')),/failed verification/);
  const preRestore=join(directory,'before.sqlite');
  writeFileSync(archivedChunk,content);
  const result=await restoreFromBackup(archive,live,state,preRestore);
  assert.equal(result.blocks,1);
  const unchanged=openStore(preRestore), restored=openStore(state);
  try {
    assert.equal(unchanged.getEdit(1,1,1).cell,null);
    assert.equal(unchanged.worldRevision(),1);
    assert.equal(restored.getEdit(1,1,1).cell,stone);
    assert.equal(restored.worldRevision(),2);
  } finally {unchanged.close();restored.close();}
});
