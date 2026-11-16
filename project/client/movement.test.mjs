import assert from 'node:assert/strict';
import { test } from 'node:test';
import {cameraClearance, movementSpeed, Movement, pick, pickMinecart} from './movement.mjs';
import {POSITION_STEP_LIMIT,playerBody} from '../world/player-body.mjs';

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
  const blocked = walk([['0,1,0','legacy:44:0'],['0,2,0','legacy:44:8']]);
  assert.ok(wall.x <= -.299 && Math.abs(wall.y - 1) < .002);
  assert.ok(blocked.x <= -.299 && Math.abs(blocked.y - 1) < .002);
});

test('a RedPower cover blocks the half-block step into a low ceiling', () => {
  const cover = {key:'cover:750:0:tread', parts:[{slot:0, shape:0, material:2}]};
  const position = walk([['0,1,0',cover], ['0,2,0','legacy:44:8']]);
  assert.ok(Math.abs(position.x + .3) < .002);
  assert.ok(Math.abs(position.y - 1) < .002);
});

test('a ceiling on the approach clips the step to the height available above a cover', () => {
  const cover = {key:'cover:750:0:tread', parts:[{slot:0, shape:0, material:2}]};
  const position = walk([['0,1,0',cover], ['-1,3,0','legacy:35:4'], ['0,3,0','legacy:35:4']]);
  assert.ok(position.x > .6);
  assert.ok(Math.abs(position.y - 1.125) < .002);
});

test('uses the three pony sizes for standing, crouching and crawling clearance', () => {
  const movement = new Movement(worldFor(new Map([['0,3,0','legacy:1:0'], ['1,1,0','legacy:1:0']])));
  assert.equal(movement.blocked(.5, 1.49, .5), false);
  assert.equal(movement.blocked(.5, 1.52, .5), true);
  assert.equal(movement.blocked(.5, 1, .5), false);
  assert.equal(movement.blocked(.71, 1, .5), true);
  for (const [size, expected] of Object.entries({normal:[[1.5,.6],[1,.6],[.5,.6]],small:[[1,.6],[.5,.6],[.25,.6]],
    large:[[2,.6],[1.5,.6],[1,.6]],tall:[[2,.6],[1.5,.6],[1,.6]]})) {
    assert.deepEqual(['stand','crouch','crawl'].map(stance => {
      const {height,halfWidth} = playerBody(size,stance);
      return [height,halfWidth * 2];
    }),expected);
  }
});

test('crawl fits under a low roof and waits for enough headroom to stand again', () => {
  const movement = new Movement(worldFor(new Map([['1,1,0','legacy:44:8']])));
  const position = {x:.5,y:1,z:.5};
  movement.grounded = true;
  assert.equal(movement.setStance(position,'crawl'),'crawl');
  for (let i=0; i<80; i++) movement.update(position,.99,0,false,.016);
  assert.ok(position.x > 1.5);
  assert.equal(movement.setStance(position,'stand'),'crawl');
  for (let i=0; i<90; i++) movement.update(position,.99,0,false,.016);
  assert.equal(movement.setStance(position,'stand'),'stand');
});

test('crouching stops at the edge and jump heights match the pony size', () => {
  const world = worldFor(new Map());
  const movement = new Movement({...world,cellAt:(x,y,z) => x <= 0 ? world.cellAt(x,y,z) : null});
  const position = {x:.5,y:1,z:.5};
  movement.grounded = true;
  assert.equal(movement.setStance(position,'crouch'),'crouch');
  for (let i=0; i<120; i++) movement.update(position,1.14,0,false,.016);
  assert.ok(position.x > 1.25 && position.x < 1.3);
  assert.ok(Math.abs(position.y - 1) < .001);
  for (const [size,height] of [['small',1],['normal',1],['large',1.5]]) {
    const flight = new Movement(world);
    const feet = {x:.5,y:1,z:.5};
    flight.size = size;
    flight.grounded = true;
    let apex = feet.y;
    for (let i=0; i<65; i++) {
      flight.update(feet,0,0,i === 0,.016);
      apex = Math.max(feet.y,apex);
    }
    assert.ok(Math.abs(apex - 1 - height) < .001);

    const steps = [['0,1,0','legacy:1:0']];
    if (height === 1.5) steps.push(['0,2,0','legacy:44:0']);
    const jumper = new Movement(worldFor(new Map(steps)));
    jumper.size = size;
    jumper.grounded = true;
    const landing = {x:-.6,y:1,z:.5};
    for (let i=0; i<33; i++) jumper.update(landing,3.8,0,i === 0,.016);
    assert.ok(landing.x > 0 && Math.abs(landing.y-1-height) < .001);
  }
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

test('flight hovers, uses physical colliders and records each movement step', () => {
  const obstacles = new Map([
    ['1,4,0','legacy:1:0'], ['0,6,0','legacy:1:0'],
  ]);
  const movement = new Movement(worldFor(obstacles));
  const position = {x:.5,y:4,z:.5};
  const trail = [];
  movement.fly(position, 0, 0, 0, .05);
  assert.equal(position.y, 4);
  for (let i = 0; i < 8; i++) movement.fly(position, 5.1, 5.1, 0, .05, p => trail.push({...p}));
  assert.ok(position.x <= .70002);
  assert.ok(position.y > 4.49 && position.y <= 4.50002);
  assert.equal(trail.length, 32);
  const {y} = position;
  movement.update(position, 0, 0, false, .05);
  assert.ok(position.y < y);
});

test('sprint accelerates ground movement by 40 percent and flying by 100 percent', () => {
  const flight = movementSpeed({flying:true});
  assert.equal(movementSpeed(),3.8);
  assert.equal(movementSpeed({sprint:true}),5.1 * 1.4);
  assert.equal(movementSpeed({flying:true, sprint:true}), flight * 2);
  assert.ok(movementSpeed({flying:true, sprint:true}) * .016 < POSITION_STEP_LIMIT);
});

test('third-person camera stays four blocks away in open space and stops at near obstacles', () => {
  const world = worldFor(new Map([
    ['0,2,2','legacy:20:0'], ['0,2,-3','legacy:1:0'], ['0,2,1','legacy:9:0'],
  ]));
  const eye = [.5,2.62,0];
  assert.equal(cameraClearance(world,eye,[1,0,0]),4);
  assert.equal(cameraClearance(world,eye,[0,0,1]),1.9);
  assert.equal(cameraClearance(world,eye,[0,0,-1]),1.9);
  assert.ok(Math.abs(cameraClearance(world,[.5,2.62,1.95],[0,0,-1]) - 3.85) < 1e-9);
});

test('passenger cart pointing follows the model through water and stops at solid walls', () => {
  const cells = new Map([['2,2,0','legacy:9:0']]);
  const world = worldFor(cells);
  const entities = [{type:'Minecart',position:[3.5,2.35,.5],key:'cart',data:{Type:0,Rotation:[90]}}];
  world.chunks = new Map([['0,0',{entities}]]);
  const origin = [.5,2.5,.5], direction = [1,0,0];
  const block = () => pick(world,origin,direction);
  assert.equal(block().x,2);
  assert.equal(pickMinecart(world,origin,direction,block())?.entity,'cart');
  cells.set('2,2,0','legacy:1:0');
  assert.equal(pickMinecart(world,origin,direction,block()),null);
});
