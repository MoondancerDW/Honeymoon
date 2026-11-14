import assert from 'node:assert/strict';
import {test} from 'node:test';
import {displayObject} from '../server/base.mjs';
import {collisionFor, redPowerWireMesh, shapeFor} from './geometry.mjs';

const wire = (mount, md = 4, pwr = 0, parts = []) => ({key:'legacy:750:2', parts,
  object:displayObject({type:'InsRedwire', data:{cons:1 << mount, md, pwr, private:'fixture'}})});
const bounds = ({x0, y0, z0, x1, y1, z1}) => [x0, y0, z0, x1, y1, z1];

test('insulated RedPower wire renders on the saved face and matches the source collision and pick', () => {
  const floor = wire(0);
  const [part] = redPowerWireMesh(floor);
  assert.equal(part.y0, 0);
  assert.equal(part.y1, Math.fround(.188));
  assert.equal(part.x1 - part.x0, .25);
  assert.equal(part.faces[2], -1);
  assert.equal(part.faces[3], 1792 + 20);
  assert.equal(part.faces[4], 1792 + 36);
  assert.equal(part.redPowerLocalShade[3], 1);
  assert.equal(redPowerWireMesh(wire(1))[0].redPowerLocalShade[2], 1);
  assert.deepEqual(collisionFor(floor), []);
  assert.deepEqual(bounds(shapeFor(floor)[0]), [0, 0, 0, 1, Math.fround(.188), 1]);
  assert.equal(shapeFor(wire(5))[0].x0, 1 - Math.fround(.188));
  assert.deepEqual(floor.object.data, {cons:1, md:4, pwr:0});
});

test('wire placed from a catalog key without saved mounting data remains visible and selectable', () => {
  const key = 'legacy:750:2';
  assert.equal(redPowerWireMesh(key), null);
  assert.deepEqual(bounds(shapeFor(key)[0]), [.4375, .4375, .4375, .5625, .5625, .5625]);
});

test('same-color wires link across a face, retaining the native powered texture', () => {
  const mounts = [[0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0]];
  const expected = [2, 3, 4, 5, 0, 1];
  for (const [side, [x,y,z]] of mounts.entries()) {
    const [part] = redPowerWireMesh(wire(side, 4, 10), (dx, dy, dz) => dx === x && dy === y && dz === z ? wire(side) : null);
    assert.equal(part.faces[expected[side]], -1);
    assert.ok(part.faces.includes(1792 + 52));
  }
  const [wrong] = redPowerWireMesh(wire(0), (x,y,z) => z === -1 ? wire(0, 5) : null);
  const [right] = redPowerWireMesh(wire(0), (x,y,z) => z === -1 ? wire(0, 4) : null);
  assert.equal(wrong.z0, Math.fround(.26));
  assert.equal(right.z0, 0);
});
