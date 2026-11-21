import assert from 'node:assert/strict';
import { test } from 'node:test';
import {cameraClearance, movementSpeed, Movement, pick, pickMinecart} from './movement.mjs';
import {FREE_FALL_START_SPEED,POSITION_STEP_LIMIT,WORLD_GRAVITY,playerBody} from '../world/player-body.mjs';
import {JUMP_CHARGE_HEIGHT} from '../world/pony-abilities.mjs';

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

test('crouching stops at the edge and jumps clear a full block at every pony size', () => {
  const world = worldFor(new Map());
  const movement = new Movement({...world,cellAt:(x,y,z) => x <= 0 ? world.cellAt(x,y,z) : null});
  const position = {x:.5,y:1,z:.5};
  movement.grounded = true;
  assert.equal(movement.setStance(position,'crouch'),'crouch');
  for (let i=0; i<120; i++) movement.update(position,1.14,0,false,.016);
  assert.ok(position.x > 1.25 && position.x < 1.3);
  assert.ok(Math.abs(position.y - 1) < .001);
  for (const size of ['small','normal','large','tall']) {
    const jumper = new Movement(worldFor(new Map([['0,1,0','legacy:1:0']])));
    jumper.ponyType = 'alicorn';
    jumper.size = size;
    jumper.grounded = true;
    const landing = {x:-.6,y:1,z:.5};
    let reachedBlock=false;
    for (let i=0; i<48; i++) {
      jumper.update(landing,3.8,0,i===0,.016);
      if (landing.x>0 && jumper.grounded && Math.abs(landing.y-2)<.001) reachedBlock=true;
    }
    assert.ok(reachedBlock);
  }
});

test('all races share Minecraft ascent and only winged jumps begin a constant glide', () => {
  let referenceAscent;
  for (const ponyType of ['earth','unicorn','pegasus','alicorn']) {
    for (const size of ['small','normal','large','tall']) {
      const movement=new Movement(worldFor(new Map()));
      movement.ponyType=ponyType;
      movement.size=size;
      movement.grounded=true;
      const position={x:.5,y:1,z:.5};
      let elapsed=0, apex=position.y, glideFrames=0;
      const ascent=[];
      for (let step=0;step<80;step++) {
        movement.update(position,0,0,step===0,.016);
        elapsed+=.016;
        apex=Math.max(apex,position.y);
        if (movement.gliding) {
          glideFrames++;
          assert.equal(movement.fall,-1.4);
        }
        if (elapsed<.3) ascent.push(position.y);
        if (movement.grounded) break;
      }
      referenceAscent ??= ascent;
      assert.deepEqual(ascent,referenceAscent);
      const winged=ponyType==='pegasus' || ponyType==='alicorn';
      assert.ok(Math.abs(apex-1-1.2522)<.001);
      if (winged) assert.ok(glideFrames>45 && elapsed>1 && elapsed<1.28);
      else assert.ok(glideFrames===0 && Math.abs(elapsed-.576)<.001);
    }
  }
});

test('only a continuous hold through a tenth of a second at the apex uses a charge', () => {
  const sample = (type, holding, hasCharge = true, blocks = new Map()) => {
    const movement=new Movement(worldFor(blocks));
    movement.ponyType=type;
    movement.grounded=true;
    const position={x:.5,y:1,z:.5};
    const heights=[];
    let charges=0, boostAt;
    for (let i=0;i<75;i++) {
      movement.update(position,0,0,i===0,.01,{chargeHeld:holding(i),availableCharge:()=>hasCharge,
        recordStep:(_position,boosted)=>{
          if (boosted) {
            charges++;
            boostAt=i;
          }
        }});
      heights.push(position.y-1);
    }
    return {movement,position,heights,charges,boostAt,apex:Math.max(...heights)};
  };
  for (const type of ['earth','unicorn','pegasus','alicorn']) {
    const normal=sample(type,i=>i<3), earlyRelease=sample(type,i=>i<34),
      held=sample(type,()=>true), empty=sample(type,()=>true,false);
    const charged=type==='earth'||type==='alicorn', {movement,position}=held;
    assert.equal(normal.charges,0);
    assert.equal(earlyRelease.charges,0);
    assert.deepEqual(empty.heights,normal.heights);
    assert.deepEqual(held.heights.slice(0,30),normal.heights.slice(0,30));
    assert.ok(Math.abs(earlyRelease.apex-normal.apex)<.002);
    assert.ok(Math.abs(held.apex-(charged ? JUMP_CHARGE_HEIGHT : normal.apex))<.002);
    assert.equal(held.charges,Number(charged));
    if (charged) {
      assert.equal(held.boostAt,40);
      assert.ok(held.heights.slice(30,40).every(y=>Math.abs(y-normal.apex)<.002));
      assert.ok(earlyRelease.heights[34]<normal.apex);
    }
    if (movement.gliding) {
      movement.cancelSlowFall();
      assert.equal(movement.fall,-FREE_FALL_START_SPEED);
      movement.update(position,0,0,false,.1);
      assert.equal(movement.gliding,false);
      assert.ok(Math.abs(movement.fall+FREE_FALL_START_SPEED+WORLD_GRAVITY*.1)<1e-6);
    }
  }
  const pressedAgain=sample('earth',i=>i<12 || i>=20);
  assert.equal(pressedAgain.charges,0);
  assert.ok(Math.abs(pressedAgain.apex-1.2522)<.002);
  const lowRoof=sample('earth',()=>true,true,new Map([['0,3,0','legacy:1:0']]));
  assert.equal(lowRoof.charges,0);
  assert.ok(Math.abs(lowRoof.apex-.5)<.002);
  const highRoof=sample('earth',()=>true,true,new Map([['0,4,0','legacy:1:0']]));
  assert.equal(highRoof.charges,1);
  assert.ok(Math.abs(highRoof.apex-1.5)<.002);
});

test('a charged jump can land on a two-block ledge at walking speed', () => {
  const world = worldFor(new Map([['0,1,0','legacy:1:0'],['0,2,0','legacy:1:0']]));
  for (const ponyType of ['earth','alicorn']) for (const size of ['small','normal','large','tall']) {
    for (const dt of [.008,.016,.033]) {
      const movement = new Movement(world);
      movement.ponyType = ponyType;
      movement.size = size;
      movement.grounded = true;
      const position = {x:-.6,y:1,z:.5};
      for (let i=0; i<Math.ceil(1.5/dt); i++) {
        const speed = position.x<.5 ? 3.8 : 0;
        movement.update(position,speed,0,i===0,dt,{chargeHeld:true,availableCharge:()=>true});
        if (movement.grounded) break;
      }
      assert.ok(position.x>0 && movement.grounded && Math.abs(position.y-3)<.001,
        `${ponyType} ${size} ${dt}s landed at ${JSON.stringify(position)}`);
    }
  }
});

test('race multipliers affect ground sprint and only ordinary Pegasus flight below the overview', () => {
  const sprint=movementSpeed({sprint:true});
  for (const [ponyType,ratio] of [['earth',1.25],['pegasus',.7],['unicorn',.85],['alicorn',1.25]]) {
    assert.equal(movementSpeed({sprint:true,ponyType}),sprint*ratio);
    for (const y of [64,255.9,256,258,500]) {
      assert.equal(movementSpeed({flying:true,y,ponyType}),movementSpeed({flying:true,y})*(ponyType==='pegasus'&&y<256?.8:1));
      assert.equal(movementSpeed({flying:true,sprint:true,y,ponyType}),movementSpeed({flying:true,sprint:true,y}));
    }
  }
});

test('flight-off and cliff free fall start at speed and accelerate at world gravity for every race', () => {
  const dt = .016;
  const dropAt = elapsed => FREE_FALL_START_SPEED*elapsed + .5*WORLD_GRAVITY*elapsed**2;
  for (const ponyType of ['earth','unicorn','pegasus','alicorn']) {
    for (const cliff of [true,false]) {
      const world=worldFor(new Map(cliff ? [['0,400,0','legacy:1:0']] : []));
      world.manifest={bounds:{...world.manifest.bounds,maxY:600}};
      const movement=new Movement(world);
      movement.ponyType=ponyType;
      const start=401;
      const position={x:cliff ? 1.22 : .5,y:start,z:.5};
      if (cliff) {
        movement.grounded=true;
        movement.update(position,7,0,false,dt);
        assert.ok(position.x>1.3 && Math.abs(position.y-start)<1e-6);
      } else {
        movement.fly(position,0,0,0,dt);
      }
      let step=0;
      do {
        movement.update(position,0,0,false,dt);
        if (++step===1 || step===125) assert.ok(Math.abs(position.y-(start-dropAt(step*dt)))<1e-6);
      } while (!movement.grounded && step<575);
      assert.ok(step*dt<6,'a 400-block drop takes less than six seconds');
      assert.ok(dropAt((step-1)*dt)<400 && dropAt(step*dt)>=400);
      assert.ok(Math.abs(position.y-1)<.001);
    }
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

test('automatic walking jumps a climbable step and stays low at walls and ceilings', () => {
  const block=['0,1,0','legacy:1:0'];
  for (const [obstacles,clear] of [
    [[block],true],
    [[block,['0,2,0','legacy:1:0']],false],
    [[block,['-1,3,0','legacy:1:0'],['0,3,0','legacy:1:0']],false],
  ]) {
    const movement=new Movement(worldFor(new Map(obstacles)));
    const position={x:-.6,y:1,z:.5};
    let apex=position.y;
    for (let i=0;i<48;i++) {
      movement.update(position,3.8,0,false,.016,{automatic:true});
      apex=Math.max(apex,position.y);
    }
    if (clear) {
      assert.ok(position.x>.6);
      assert.ok(apex>=1.999);
    } else {
      assert.ok(Math.abs(position.x+.3)<.002);
      assert.ok(Math.abs(apex-1)<.001);
    }
  }
});

test('automatic flight climbs a wall, levels off and respects the ceiling', () => {
  for (const wallTop of [6,15]) {
    const obstacles=new Map();
    for (let y=4;y<=wallTop;y++) obstacles.set(`1,${y},0`,'legacy:1:0');
    const movement=new Movement(worldFor(obstacles));
    const position={x:.5,y:4,z:.5};
    for (let i=0;i<112;i++) movement.fly(position,7.65,0,0,.016,undefined,false,true);
    if (wallTop===6) {
      assert.ok(position.x>4);
      assert.ok(position.y>=7 && position.y<7.2);
    } else {
      assert.ok(Math.abs(position.x-.7)<.002);
      assert.ok(Math.abs(position.y-14.5)<.002);
    }
  }
});

test('automatic flight does not attempt to climb missing terrain or the world boundary', () => {
  const world=worldFor(new Map());
  for (const [start,hasChunk,waiting] of [[.5,x=>x<=0,true],[8.5,()=>true,false]]) {
    const movement=new Movement({...world,hasChunk});
    const position={x:start,y:4,z:.5};
    for (let i=0;i<12;i++) movement.fly(position,7.65,0,0,.016,undefined,false,true);
    assert.ok(Math.abs(position.x-start-.2)<.002);
    assert.equal(position.y,4);
    assert.equal(Boolean(movement.waitingForTerrain),waiting);
  }
});

test('sprint accelerates ground movement by 40 percent and flying by 100 percent', () => {
  const flight = movementSpeed({flying:true});
  assert.equal(movementSpeed(),3.8);
  assert.equal(movementSpeed({sprint:true}),5.1 * 1.4);
  assert.equal(movementSpeed({flying:true, sprint:true}), flight * 2);
  assert.ok(movementSpeed({flying:true, sprint:true}) * .016 < POSITION_STEP_LIMIT);
});

test('high flight sprint is 20 percent faster than its previous 30.6 blocks per second', () => {
  const speed=movementSpeed({flying:true,sprint:true,y:258});
  assert.ok(Math.abs(speed-36.72)<1e-9);
  assert.equal(movementSpeed({flying:true,y:258}),7.65*1.4);
  assert.equal(movementSpeed({flying:true,sprint:true,y:256}),15.3);
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
