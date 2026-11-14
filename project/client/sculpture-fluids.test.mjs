import assert from 'node:assert/strict';
import {test} from 'node:test';
import {movementMedium} from '../world/block-movement.mjs';
import * as geometry from '../world/geometry.mjs';
import {PLAYER, physics} from '../server/physics.mjs';
import {filledVoxels, isOpaqueFullVoxels, isSolidFullVoxels, voxelAtHit, voxelFaces, voxelIndex, voxelKey, writeVoxel} from '../world/voxel-chisel.mjs';
import {lightChanged} from './block-light.mjs';
import {pick} from './movement.mjs';

const {collisionFor, selectionFor} = geometry;
const water = 'legacy:9:0', flowingWater = 'legacy:8:3', lava = 'legacy:11:0', stone = 'legacy:1:0';
const sculpture = voxels => ({key:voxelKey, voxels});

test('fluid eighths can be selected, share a surface and do not create collision', () => {
  const fullWater = filledVoxels(water);
  assert.deepEqual(collisionFor(sculpture(fullWater)), []);
  assert.equal(isSolidFullVoxels(fullWater), false);
  assert.equal(isOpaqueFullVoxels(filledVoxels(lava)), false);
  assert.equal(selectionFor(sculpture(fullWater))[0].solid, false);

  const waterPair = writeVoxel(writeVoxel(null, voxelIndex(0,0,0), water), voxelIndex(1,0,0), flowingWater);
  const surfaces = voxelFaces(waterPair);
  assert.equal(surfaces.filter(({face,box}) => face < 2 && box.x0 === .125).length, 0);
  assert.ok(surfaces.every(({box}) => box.mode === 'blend' && box.fluid === 'water'));

  const mixed = sculpture(writeVoxel(waterPair, voxelIndex(2,0,0), stone));
  assert.deepEqual(selectionFor(mixed).map(({solid,fluid}) => [solid,fluid]), [[false,'water'],[true,undefined]]);
  assert.deepEqual(collisionFor(mixed), [{x0:.25,y0:0,z0:0,x1:.375,y1:.125,z1:.125,solid:true,mode:'opaque'}]);
  const host = {x:0, y:0, z:0}, boundary = {x:.25,y:.05,z:.05};
  assert.equal(voxelAtHit(host, boundary, [-1,0,0], true, mixed.voxels), voxelIndex(2,0,0));
  assert.equal(voxelAtHit(host, boundary, [1,0,0], true, mixed.voxels), null);
  const solidNeighbor = writeVoxel(mixed.voxels, voxelIndex(1,0,0), stone);
  assert.equal(voxelAtHit(host, boundary, [-1,0,0], true, solidNeighbor), null);
});

test('the client and server pick the solid eighth when its face coincides with a water exit', () => {
  const mixed = sculpture(writeVoxel(writeVoxel(null, voxelIndex(0,0,0), water), voxelIndex(1,0,0), stone));
  const cellAt = (x,y,z) => x === 0 && y === 2 && z === 0 ? mixed : null;
  const origin = [.05,2.05,.05];
  const target = pick({cellAt}, origin, [1,0,0], true);
  assert.deepEqual(target.offset, [-1,0,0]);
  assert.equal(target.voxelMaterial, stone);
  assert.equal(target.voxel, voxelIndex(1,0,0));
  const physical = physics({manifest:{}}, geometry, cellAt);
  const hit = physical.targetAtHit({x:origin[0],y:origin[1] - PLAYER.eye,z:origin[2]}, 0,2,0,target.hit, true);
  assert.deepEqual(hit.face, target.offset);
  assert.equal(voxelAtHit(target, hit.hit, hit.face, true, mixed.voxels), target.voxel);
});

test('the player swims only where their feet meet a sculpted water eighth', () => {
  const mixed = sculpture(writeVoxel(writeVoxel(null, voxelIndex(7,0,0), water), voxelIndex(6,0,0), lava));
  const cellAt = (x,y,z) => x === -1 && y === 1 && z === -2 ? mixed : null;
  assert.equal(movementMedium(cellAt, -.01, 1, -1.98), 'water');
  assert.equal(movementMedium(cellAt, -.01, 0.95, -1.98), 'water');
  assert.equal(movementMedium(cellAt, -.01, 1.09, -1.98), null);
  assert.equal(movementMedium(cellAt, -.01, 1, -1.7), null);
  assert.equal(movementMedium(cellAt, -.2, 1, -1.98), null);
});

test('full sculpted water preserves absorption and lava eighths emit block light', () => {
  const waterEighth = writeVoxel(null,0,water);
  const lavaEighth = writeVoxel(null,0,lava);
  assert.equal(lightChanged({key:water}, sculpture(filledVoxels(water))), false);
  assert.equal(lightChanged({key:'air'}, sculpture(waterEighth)), false);
  assert.equal(lightChanged(sculpture(filledVoxels(water)), sculpture(waterEighth)), true);
  assert.equal(lightChanged({key:'air'}, sculpture(lavaEighth)), true);
});
