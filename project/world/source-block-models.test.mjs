import test from 'node:test';
import assert from 'node:assert/strict';
import {collisionFor, shapeFor, sourceAtlasModel} from './geometry.mjs';
import {creativeBlock} from './creative-blocks.mjs';

test('standard cubes retain the captured textures of their individual faces and metadata', () => {
  assert.deepEqual(shapeFor('legacy:58:0')[0].faces,[60,59,4,43,60,59]);
  assert.deepEqual(shapeFor('legacy:103:0')[0].faces,[136,136,137,137,136,136]);
  assert.deepEqual(shapeFor('legacy:24:2')[0].faces,[230,230,176,176,230,230]);
  assert.deepEqual(shapeFor('legacy:17:11')[0].faces,[153,153,153,153,21,21]);
  for (const id of [86,91,99,100]) for (let meta = 0; meta < 16; meta++) {
    const [box] = shapeFor(`legacy:${id}:${meta}`);
    assert.deepEqual(box.faces,creativeBlock(id,meta)[0]);
    assert.equal(box.emissive,id === 91);
  }
  const [cage] = shapeFor('legacy:52:0');
  assert.equal(cage.mode,'cutout');
  assert.deepEqual(collisionFor('legacy:52:0'),[cage]);
});

test('tripwire draws only the matching translucent source rows at the stored height and headings', () => {
  const isolated = shapeFor('legacy:132:0');
  assert.equal(isolated.length,4);
  assert.ok(isolated.every(strip => strip.mode === 'blend' && strip.kind === 'strip' && strip.faces[0] === 173 &&
    strip.corners.every(([,y]) => y === 1.5 / 16) && Math.max(...strip.uv.map(([,v]) => v)) === 2 / 16));
  assert.equal(Math.min(...isolated.map(strip => strip.z0)),0);
  assert.equal(Math.max(...isolated.map(strip => strip.z1)),1);
  const east = shapeFor('legacy:132:6',(dx,_,dz) => dx === 1 && dz === 0 ? 'legacy:132:2' : 'air');
  assert.equal(east.length,2);
  assert.ok(east.every(strip => strip.x0 >= .5 && strip.z1 - strip.z0 === 1 / 32 &&
    strip.corners.every(([,y]) => y === 3.5 / 16) && Math.min(...strip.uv.map(([,v]) => v)) === 2 / 16));
  assert.deepEqual(collisionFor('legacy:132:6'),[]);
});

test('RedPower furnace uses its own front state, heading and top and bottom textures', () => {
  for (const [meta, side, bottom, top, front] of [[0, 3794, 3797, 3797, 3795],
    [1, 592, 596, 595, 593], [4, 672, 596, 675, 673]]) {
    for (const [rot, panelFace] of [4, 1, 5, 0].entries()) {
      for (const ps of [0, 1]) {
        const cell = {key: `legacy:751:${meta}`, object: {data: {rot, ps}}};
        const [box] = shapeFor(cell);
        const expected = [side, side, bottom, top, side, side];
        expected[panelFace] = front + ps;
        assert.deepEqual(box.faces, expected);
        assert.deepEqual(collisionFor(cell), [box]);
      }
    }
  }
});

test('RedPower ore storage selects the six native material tiles', () => {
  for (let meta = 0; meta < 6; meta++) {
    const [box] = shapeFor(`legacy:754:${meta}`);
    assert.deepEqual(box.faces, Array(6).fill(336 + meta));
  }
});

test('RedPower igniter uses native machine1 faces and activation at every stored orientation', () => {
  const topAt = [3,2,5,4,1,0];
  const bottomAt = [2,3,4,5,0,1];
  for (const [rot, flameFace] of topAt.entries()) {
    for (const ps of [0,1,2,3]) {
      const cell = {key:'legacy:763:12',object:{data:{rot,ps}}};
      const [model] = shapeFor(cell);
      assert.equal(model.faces[flameFace],512 + 164 + (ps & 1));
      assert.equal(model.faces[bottomAt[rot]],512 + 48);
      assert.deepEqual(model.faces.filter((_,face) => face !== flameFace && face !== bottomAt[rot]).sort(),
        [678,678,679,679]);
      assert.equal(model.mode,'opaque');
      assert.equal(model.approximation,undefined);
    }
  }
});

test('Campfire active and idle share the 9-piece rotated source model with a 1/4-block collision', () => {
  const active = 'legacy:3000:2';
  const idle = 'legacy:3001:1';
  const model = sourceAtlasModel(active);
  assert.equal(model.length, 54);
  assert.equal(sourceAtlasModel(idle), model);
  assert.equal(sourceAtlasModel('legacy:1:0'), null);
  assert.equal(collisionFor(active)[0].y1, .25);
  assert.deepEqual(collisionFor(active), collisionFor(idle));
  const points = model.flatMap(quad => quad.positions);
  const vertical = points.filter((_, i) => i % 3 === 1);
  assert.equal(Math.min(...vertical), 0);
  assert.ok(Math.max(...vertical) > .9);
  assert.ok(model.every(quad => quad.uv.length === 8 && quad.uv.every(v => v > 0 && v < 1)));
});
