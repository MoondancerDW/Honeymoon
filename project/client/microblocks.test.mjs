import assert from 'node:assert/strict';
import {test} from 'node:test';
import {microblockKey} from '../world/microblocks.mjs';
import {pick} from './movement.mjs';
import {World} from './world-data.mjs';

test('one outline selects a hollow cover while the ray can pass through its hole', () => {
  const parts = [{slot: 2, shape: 3, material: 1}, {slot: 3, shape: 0, material: 2}];
  const target = {key: microblockKey, parts};
  const world = {cellAt: (x, y, z) => x === 0 && y === 1 && z === 0 ? target : null};
  const rim = pick(world, [.1, 1.5, -1], [0, 0, 1]);
  assert.equal(rim.partSlot, 2);
  assert.deepEqual(rim.part, parts[0]);
  assert.equal(rim.boxes.length, 4);
  const through = pick(world, [.5, 1.5, -1], [0, 0, 1]);
  assert.equal(through.partSlot, 3);
  assert.equal(through.boxes.length, 1);
});

test('edited parts sharing one palette index remain distinct in the worker halo', () => {
  const world = new World({palette:['air'], compositions:{}});
  world.addChunk({x:0, z:0, sections:[]});
  const bottom = [{slot:0, shape:0, material:1}];
  const top = [{slot:1, shape:2, material:2}];
  world.setOverride({x:0,y:0,z:0,cell:microblockKey, object:null, parts:bottom,revision:1});
  world.setOverride({x:1,y:0,z:0,cell:microblockKey, object:null, parts:top,revision:2});
  const {indices,microblocks} = world.halo(0,0,0);
  assert.equal(world.cellAt(0,0,0).parts,bottom);
  assert.equal(world.cellAt(1,0,0).parts,top);
  assert.equal(indices[343],indices[344]);
  assert.deepEqual(microblocks,[[343,bottom],[344,top]]);
  assert.equal(world.palette.length,2);
});
