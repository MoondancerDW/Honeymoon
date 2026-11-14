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

test('a wall-to-ceiling run fills the elbow exactly once and hides both arm ends', () => {
  const corner = wire(2);
  corner.object.data.cons |= 1 << 1;
  const neighbors = (x, y, z) => {
    if (x === 0 && y === -1 && z === 0) return wire(2);
    if (x === 0 && y === 0 && z === 1) return wire(1);
    return null;
  };
  const [ceiling, wall, elbow] = redPowerWireMesh(corner, neighbors);
  const height = Math.fround(.188), outer = 1 - height;
  assert.deepEqual(bounds(ceiling), [.375, outer, height, .625, 1, 1]);
  assert.deepEqual(bounds(wall), [.375, 0, 0, .625, outer, height]);
  assert.deepEqual(bounds(elbow), [.375, outer, 0, .625, 1, height]);
  assert.equal(ceiling.faces[4], -1);
  assert.equal(wall.faces[3], -1);
  assert.deepEqual(elbow.faces, [1792 + 36, 1792 + 36, -1, -1, -1, -1]);
  assert.deepEqual(collisionFor(corner), []);
});

test('a branching run keeps each uninterrupted side in a single face', () => {
  const [continuous, center, ...arms] = redPowerWireMesh(wire(0), (x, y, z) => z || x < 0 ? wire(0) : null);
  assert.equal(continuous.z0, 0);
  assert.equal(continuous.z1, 1);
  assert.equal(continuous.faces[1], 1792 + 20);
  assert.equal(center.faces[1], -1);
  assert.ok(arms.every(arm => arm.faces[1] < 0 || arm.z0 > 0 && arm.z1 < 1));
});

test('an exposed outside corner wraps in the neighboring cell once with local UVs', () => {
  const elbow = wire(2);
  elbow.object.data.cons |= 1 << 1;
  const diagonal = (x, y, z) => x === 0 && y === -1 && z === -1 ? elbow : null;
  const result = redPowerWireMesh(elbow, diagonal);
  const [cap] = result.filter(part => part.redPowerOffset);
  const height = Math.fround(.188);
  assert.deepEqual(bounds(cap), [.375, -height, 0, .625, 0, height]);
  assert.deepEqual(cap.redPowerOffset, [0, -1, 0]);
  assert.equal(result.filter(part => part.redPowerOffset).length, 1);
  const blocked = redPowerWireMesh(elbow, (x, y, z) => x === 0 && y === -1 && z === 0 ? 'legacy:1:0' : diagonal(x, y, z));
  assert.ok(blocked.every(part => !part.redPowerOffset));
});

test('an insulated wire reaches a shaped lamp mounted on the same face', () => {
  const lamp = {key:'legacy:768:0', object:{data:{rot:1}}};
  const [run] = redPowerWireMesh(wire(1), (x, y, z) => z === 1 ? lamp : null);
  assert.equal(run.z1, 1);
  const [wrongMount] = redPowerWireMesh(wire(0), (x, y, z) => z === 1 ? lamp : null);
  assert.equal(wrongMount.z1, Math.fround(.74));
});
