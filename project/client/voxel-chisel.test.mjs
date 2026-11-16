import assert from 'node:assert/strict';
import {test} from 'node:test';
import {filledVoxels, voxelBox, voxelIndex, voxelKey, writeVoxel} from '../world/voxel-chisel.mjs';
import {Movement, overlapsPlacement, pick} from './movement.mjs';
import {World} from './world-data.mjs';

const stone = 'legacy:1:0';
const dirt = 'legacy:3:0';
const manifest = {palette:['air',stone,dirt], compositions:{},
  bounds:{minX:-16,maxX:15,minY:0,maxY:31,minZ:-16,maxZ:15}};

test('chisel selection exposes exact material at one eighth through a removed front layer', () => {
  const front = voxelIndex(2, 2, 0);
  const behind = voxelIndex(2, 2, 1);
  const state = writeVoxel(writeVoxel(filledVoxels(stone), front, null), behind, dirt);
  const world = {cellAt: (x,y,z) => x === 0 && y === 1 && z === 0 ? {key:voxelKey, voxels:state} : null};
  const origin = [.3125, 1.3125, -2];
  const aim = [0,0,1];
  const hit = pick(world, origin, aim, true);
  assert.equal(hit.voxel, behind);
  assert.equal(hit.voxelMaterial, dirt);
  assert.deepEqual(hit.boxes, [{x0:.25,y0:.25,z0:.125,x1:.375,y1:.375,z1:.25}]);
  assert.equal(pick(world, origin, aim).voxel, undefined);
});

test('sculpture overrides keep their distinct data in section halos and movement', () => {
  const world = new World(manifest);
  for (const x of [-1,0]) for (const z of [-1,0]) world.addChunk({x,z,sections:[]});
  const one = writeVoxel(null, voxelIndex(0, 0, 0), stone);
  const two = writeVoxel(null, voxelIndex(7, 7, 7), dirt);
  world.setOverride({x:0,y:0,z:0,cell:voxelKey,voxels:one,revision:1});
  world.setOverride({x:-1,y:0,z:0,cell:voxelKey,voxels:two,revision:2});
  const {indices,sculpted} = world.halo(0,0,0);
  assert.equal(indices[342], indices[343]);
  assert.deepEqual(sculpted, [[342,two],[343,one]]);
  const player = new Movement(world);
  assert.equal(player.blocked(.3,.08,.3), true);
  assert.equal(player.blocked(.64,.08,.64), false);
  world.setOverride({x:0,y:0,z:0,cell:null,voxels:null,revision:3});
  assert.equal(player.blocked(.3,.08,.3), false);
});

test('a pending material placement prevents local movement into its eighth until the reply', () => {
  const world = new World(manifest);
  for (const x of [-1,0]) for (const z of [-1,0]) world.addChunk({x,z,sections:[]});
  const movement = new Movement(world);
  const feet = {x:-.51,y:.08,z:.25};
  const placement = {x:0,y:0,z:0,boxes:[voxelBox(voxelIndex(0,0,1))]};
  assert.equal(overlapsPlacement(feet, placement), false);
  movement.pendingPlacement = placement;
  movement.fly(feet, 5.1, 0, 0, .05);
  assert.ok(feet.x <= -.2999);
  assert.equal(overlapsPlacement(feet, placement), false);
  movement.pendingPlacement = null;
  movement.fly(feet, 5.1, 0, 0, .05);
  assert.ok(feet.x > -.3);
});
