import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fillHeldLight, heldLightLevel, heldLightOcclusion, HELD_LIGHT_RADIUS, HELD_LIGHT_SIDE, HELD_LIGHT_VOXELS} from './held-light.mjs';

test('held props follow registry emission and the inverted lamp bit', () => {
  const block = key => heldLightLevel({kind:'block',key});
  assert.equal(block('legacy:50:0'),14);
  assert.equal(block('legacy:89:0'),15);
  assert.equal(block('legacy:75:0'),0);
  assert.equal(block('creative:768:52'),15);
  assert.equal(block('creative:768:36'),0);
  assert.equal(heldLightLevel({kind:'item',key:'5767:0'}),13);
  assert.equal(heldLightLevel({kind:'item',key:'5256:0'}),0);
  assert.equal(heldLightLevel({kind:'item',key:'325:0'}),0);
  assert.equal(heldLightLevel(null),0);
});

test('nearby held light reaches through glass and water and fades at solid walls', () => {
  const values = new Uint8Array(HELD_LIGHT_VOXELS);
  const scratch = new Uint16Array(values.length);
  const side = HELD_LIGHT_SIDE, r = HELD_LIGHT_RADIUS;
  const at = (x,y,z) => values[x + r + side * (z + r + side * (y + r))] / 17;
  const fill = material => fillHeldLight(values,scratch,0,0,0,14,
    x => heldLightOcclusion({key:x === 2 ? material : 'air'}));
  fill('legacy:1:0');
  assert.equal(at(0,0,0),14);
  assert.equal(at(1,0,0),13);
  assert.equal(at(2,0,0),0);
  assert.equal(at(3,0,0),0);
  fill('legacy:20:0');
  assert.equal(at(3,0,0),11);
  assert.equal(at(13,0,0),1);
  assert.equal(at(14,0,0),0);
  fill('legacy:9:0');
  assert.equal(at(3,0,0),9);
  const plate = {key:'legacy:750:0',parts:[{material:0,shape:0,slot:5}]};
  fillHeldLight(values,scratch,0,0,0,14,x=>heldLightOcclusion(x===2 ? plate : {key:'air'}));
  assert.equal(at(2,0,0),12);
  assert.equal(at(3,0,0),0);
  plate.parts = [{material:7,shape:0,slot:5}];
  fillHeldLight(values,scratch,0,0,0,14,x=>heldLightOcclusion(x===2 ? plate : {key:'air'}));
  assert.equal(at(3,0,0),11);
});
