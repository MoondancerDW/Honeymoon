import assert from 'node:assert/strict';
import {test} from 'node:test';
import {World} from './world-data.mjs';
import {filledVoxels, voxelKey} from '../world/voxel-chisel.mjs';

const ranked = (...values) => {
  const indices = Buffer.alloc(8192);
  values.forEach(([x, y, z, index]) => indices.writeUInt16LE(index, (x + z * 16 + y * 256) * 2));
  return {y:0, indices:indices.toString('base64')};
};
const newWorld = () => new World({chunkPalettes:true, palette:['air'], compositions:{}});
const offset = (x, y, z) => x + 1 + (z + 1) * 18 + (y + 1) * 18 ** 2;

test('compact upper columns retain high edits and keep lower terrain unknown until upgraded',()=>{
  const world=newWorld();
  const chunk={x:-1,z:0,palette:['air'],highOnly:true,sections:[]};
  world.addChunk(chunk);
  world.setOverride({x:-1,y:268,z:2,cell:'legacy:1:0',revision:1});
  world.setOverride({x:-1,y:65,z:2,cell:'legacy:1:0',revision:2});
  assert.equal(world.hasChunk(-1,2,268),true);
  assert.equal(world.hasChunk(-1,2,65),false);
  assert.equal(world.cellAt(-1,268,2),'legacy:1:0');
  assert.equal(world.cellAt(-1,65,2),null);
  assert.equal(world.upperOverrides.size,1);
  world.addChunk({...chunk,highOnly:false});
  assert.equal(world.cellAt(-1,65,2),'legacy:1:0');
  world.setOverride({x:-1,y:268,z:2,cell:'air',revision:3});
  assert.equal(world.upperOverrides.size,0);
  assert.equal(world.cellAt(-1,268,2),null);
});

test('adjacent chunks can use the same index for different materials and their covers', () => {
  const world = newWorld();
  const cover = 'cover:750:0:packed';
  const shape = {parts:[{slot:0, material:1, shape:0}]};
  const west = {x:-1, z:0, palette:['air', cover], compositions:{[cover]:shape}, sections:[ranked([15,0,0,1])]};
  const east = {x:0, z:0, palette:['air', 'legacy:2:0'], sections:[ranked([0,0,0,1])]};
  world.addChunk(west);
  world.addChunk(east);
  assert.deepEqual(world.cellAt(-1,0,0).parts, shape.parts);
  assert.equal(world.cellAt(0,0,0), 'legacy:2:0');
  const halo = world.halo(0,0,0);
  assert.equal(halo.palette[halo.indices[offset(-1,0,0)]], cover);
  assert.equal(halo.palette[halo.indices[offset(0,0,0)]], 'legacy:2:0');
  assert.deepEqual(halo.compositions[cover], shape);
  world.removeChunks([west]);
  assert.equal(world.cellAt(-1,0,0), null);
  assert.equal(world.halo(0,0,0).compositions[cover], undefined);
  assert.deepEqual(world.palette, ['air']);
});

test('an evicted edge reloads with edits, their light and sculpted materials', () => {
  const world = newWorld();
  const west = {x:0, z:0, palette:['air'], sections:[ranked()]};
  const east = {x:1, z:0, palette:['air'], sections:[ranked()]};
  const torch = 'legacy:50:5';
  world.addChunk(west);
  world.addChunk(east);
  world.setOverride({x:15,y:8,z:8,cell:torch,revision:1});
  world.updateLighting();
  assert.equal(world.lightAt(16,8,8) & 15, 13);
  world.removeChunks([west,east]);
  assert.equal(world.blockLightOverrides.size, 0);
  const voxels = filledVoxels('legacy:9:0');
  world.setOverride({x:17,y:8,z:8,cell:voxelKey,voxels,revision:2});
  assert.equal(world.setOverride({x:17,y:8,z:8,cell:null,revision:1}), false);
  world.updateLighting(world.addChunk(east));
  assert.equal(world.lightAt(16,8,8) & 15, 0);
  world.updateLighting(world.addChunk(west));
  assert.equal(world.lightAt(16,8,8) & 15, 13);
  assert.equal(world.cellAt(15,8,8), torch);
  assert.deepEqual(world.cellAt(17,8,8).voxels, voxels);
  assert.deepEqual(world.halo(1,0,0).sculpted, [[offset(1,8,8), voxels]]);
});
