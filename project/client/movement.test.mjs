import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Movement } from './movement.mjs';

const manifest = {bounds:{minX:-8,maxX:8,minY:0,maxY:15,minZ:-8,maxZ:8}};
function worldFor(obstacles) {
  return {
    manifest,
    hasChunk: () => true,
    cellAt(x,y,z) {
      return y === 0 ? 'legacy:1:0' : obstacles.get([x,y,z].join(',')) || null;
    }
  };
}

function walk(obstacles) {
  const movement = new Movement(worldFor(new Map(obstacles)));
  const position = {x:-.6,y:1,z:.5};
  for (let i=0;i<22;i++) movement.update(position,3.8,0,false,.016);
  return position;
}

test('walks up a lower slab with room above', () => {
  const position = walk([['0,1,0','legacy:44:0']]);
  assert.ok(position.x > .6);
  assert.ok(Math.abs(position.y - 1.5) < .002);
});

test('cannot step into a full block or under a low ceiling', () => {
  const wall = walk([['0,1,0','legacy:1:0']]);
  const blocked = walk([['0,1,0','legacy:44:0'],['0,3,0','legacy:1:0']]);
  assert.ok(wall.x <= -.28 && Math.abs(wall.y - 1) < .002);
  assert.ok(blocked.x <= -.28 && Math.abs(blocked.y - 1) < .002);
});
