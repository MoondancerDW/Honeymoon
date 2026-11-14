import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as geometry from './geometry.mjs';
import { isMicroPart, microblockAddition, microblockKey, microblockPattern, microblockPlacement, microblockRemoval } from './microblocks.mjs';
import { voxelIndex, writeVoxel } from './voxel-chisel.mjs';
import { physics } from '../server/physics.mjs';

const part = (slot, shape = 0, material = 2) => ({slot, shape, material});
const multipart = parts => ({key: microblockKey, parts});
const origin = {x: .125, y: .25 - 1.62, z: -2};

test('hollow bars share one slot and target rays must reach the exact part', () => {
  const layout = multipart([part(2, 3), part(3)]);
  const boxes = geometry.shapeFor(layout);
  assert.equal(boxes.filter(box => box.partSlot === 2).length, 4);
  assert.equal(boxes.filter(box => box.partSlot === 3).length, 1);
  const body = physics({manifest:{}}, geometry, (x, y, z) => x === 0 && y === 0 && z === 0 ? layout : null);
  const first = {x:.125, y:.25, z:0};
  assert.deepEqual(body.targetAtHit(origin, 0, 0, 0, first)?.face, [0, 0, -1]);
  assert.equal(body.visiblePart(origin, 0, 0, 0, 2, first), true);
  assert.equal(body.visiblePart(origin, 0, 0, 0, 3, first), false);
  assert.equal(body.visiblePart(origin, 0, 0, 0, 3, {...first,z:.875}), false);
  assert.equal(body.visiblePart(origin, 0, 0, 0, 2), false);
  const openRay = {x:.5,y:.5,z:.875};
  const centeredEye = {x:.5,y:.5 - 1.62,z:-2};
  assert.equal(body.visiblePart(centeredEye, 0, 0, 0, 3, openRay), true);
});

test('multiple shapes fit only when their volumes and existing slot shapes remain intact', () => {
  const original = [part(0)];
  assert.equal(microblockAddition(original, part(2)), null, 'perpendicular plates intersect');
  assert.equal(microblockAddition(original, part(0, 3)), null, 'a slot cannot be claimed twice');
  assert.equal(microblockAddition(original, part(26)), null, 'a column through a plate would be truncated');
  const withTop = microblockAddition(original, part(13));
  const withMiddle = microblockAddition(withTop.parts, part(27));
  assert.deepEqual(withMiddle.parts.map(item => item.slot), [0, 13, 27]);
  assert.deepEqual(microblockRemoval(withMiddle.parts, 13).parts.map(item => item.slot), [0, 27]);
  assert.equal(microblockRemoval([part(0), part(2)], 0), null, 'a touching legacy plate would grow');
  assert.equal(microblockRemoval([part(0), part(2)], 0, {mayReshape:slot => slot === 2}).reshaped, true);
  assert.deepEqual(original, [part(0)]);
  assert.equal(isMicroPart(part(29)), false);
  assert.equal(isMicroPart(part(27, 3)), false);
  assert.equal(isMicroPart(part(6, 13)), false);
  assert.equal(isMicroPart(part(0, 3, 200)), false);
});

test('preview chooses valid same-cell slots or the clicked neighboring cube', () => {
  const cell = multipart([part(0)]);
  const world = {cellAt: (x, y, z) => x === 0 && y === 0 && z === 0 ? cell : null};
  const target = {x:0,y:0,z:0,cell,partSlot:0,offset:[0,1,0],hit:{x:.5,y:.125,z:.5}};
  const within = microblockPlacement(world, target, part(0));
  assert.deepEqual([within.x, within.y, within.z, within.part.slot], [0, 0, 0, 1]);
  assert.deepEqual(within.against, {x:0,y:0,z:0,partSlot:0});
  assert.ok(within.boxes.every(box => box.partSlot === 1));
  const next = microblockPlacement(world, target, part(0), {adjacent: true});
  assert.deepEqual([next.x, next.y, next.z, next.part.slot], [0, 1, 0, 0]);
  assert.equal(microblockPlacement({...world, hasChunk:()=>false}, target, part(0)), null);
});

test('copied patterns stack and follow the hit without changing other pieces', () => {
  const held = part(0,0,5);
  held.pattern = microblockPattern(geometry.coverBoxes([held]));
  const bottom = part(0,0,2);
  const target = {x:0,y:0,z:0,partSlot:0,offset:[0,1,0],hit:{x:.4,y:.125,z:.6}};
  let cell = multipart([bottom]);
  const world = {cellAt: (x,y,z) => x === 0 && y === 0 && z === 0 ? cell : null};
  const second = microblockPlacement(world, {...target,cell}, held);
  assert.deepEqual(second.part, {slot:29, sourceSlot:0, shape:0, material:5,bounds:[[0,1,0,8,2,8]]});
  cell = multipart([bottom,second.part]);
  const third = microblockPlacement(world, {...target,cell,partSlot:29,hit:{...target.hit,y:.25}}, held);
  assert.deepEqual(third.part.bounds, [[0,2,0,8,3,8]]);
  assert.equal(third.part.slot,30);
  const packed = microblockAddition(cell.parts, third.part);
  assert.deepEqual(microblockRemoval(packed.parts, 29).parts,[bottom,third.part]);

  const peg = part(6,0,1);
  peg.pattern = microblockPattern(geometry.coverBoxes([peg]));
  const otherAim = microblockPlacement(world,{...target,cell,partSlot:29,hit:{x:.7,y:.25,z:.2}},peg);
  assert.deepEqual(otherAim.part.bounds, [[5,2,1,6,3,2]]);
  const sculpted = writeVoxel(null,voxelIndex(5,2,1),'legacy:20:0');
  assert.equal(microblockAddition(cell.parts, otherAim.part, sculpted), null);
  assert.ok(microblockAddition(cell.parts, otherAim.part, writeVoxel(null,voxelIndex(4,2,1),'legacy:89:0')));
});
