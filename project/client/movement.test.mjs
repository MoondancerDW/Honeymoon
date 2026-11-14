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

test('uses the original standing height and width when checking clearance', () => {
  const movement = new Movement(worldFor(new Map([['0,3,0','legacy:1:0'], ['1,1,0','legacy:1:0']])));
  assert.equal(movement.blocked(.5, 1.19, .5), false);
  assert.equal(movement.blocked(.5, 1.22, .5), true);
  assert.equal(movement.blocked(.695, 1, .5), false);
  assert.equal(movement.blocked(.705, 1, .5), true);
});

test('finishes a dry vertical collision before leaving the edge horizontally', () => {
  const movement = new Movement(worldFor(new Map([['0,1,0','legacy:44:0']])));
  const position = {x:1.25, y:1.5, z:.5};
  movement.grounded = true;
  movement.update(position, 3.8, 0, false, .016);
  assert.ok(position.x > 1.3);
  assert.equal(position.y, 1.5);
  movement.update(position, 3.8, 0, false, .016);
  assert.ok(position.y < 1.5);
});

test('climbs and descends ladder blocks without removing their backing wall', () => {
  const blocks = new Map([['0,1,0','legacy:65:2'],['0,2,0','legacy:65:2'],['0,3,0','legacy:65:2'],
    ['0,1,1','legacy:1:0'],['0,2,1','legacy:1:0'],['0,3,1','legacy:1:0']]);
  const movement = new Movement(worldFor(blocks));
  const position = {x:.5,y:1,z:.5};
  for (let i=0;i<35;i++) movement.update(position,0,0,false,.016,{rise:true});
  assert.ok(position.y > 2.2);
  assert.equal(movement.medium, 'ladder');
  for (let i=0;i<70;i++) movement.update(position,0,0,false,.016,{descend:true});
  assert.ok(Math.abs(position.y - 1) < .002);
});

test('water slows forward travel and Space raises the player through the waterline', () => {
  const water = ['0,1,0','0,2,0','1,1,0','1,2,0'].map(key => [key,'legacy:9:0']);
  const movement = new Movement(worldFor(new Map(water)));
  const position = {x:.5,y:1.1,z:.5};
  for (let i=0;i<20;i++) movement.update(position,3.8,0,false,.016,{rise:true});
  assert.ok(position.x < 1.25 && position.x > 1);
  assert.ok(position.y > 1.8 && position.y < 2);
  assert.equal(movement.medium, 'water');
});
