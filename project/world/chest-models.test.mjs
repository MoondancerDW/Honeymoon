import test from 'node:test';
import assert from 'node:assert/strict';
import {chestMesh, collisionFor, shapeDependsOnNeighbors, shapeFor} from './geometry.mjs';

const bounds = box => [box.x0, box.y0, box.z0, box.x1, box.y1, box.z1];
const single = [1 / 16, 0, 1 / 16, 15 / 16, 14 / 16, 15 / 16];

test('single normal and Ender chests have separate base, lid and lock UVs', () => {
  const normal = chestMesh('legacy:54:3');
  const ender = chestMesh('legacy:130:3');
  assert.deepEqual(normal.map(part => part.faces[0]), [3660, 3666, 3672]);
  assert.deepEqual(ender.map(part => part.faces[0]), [3678, 3684, 3690]);
  assert.deepEqual(bounds(normal[2]), [7 / 16, 7 / 16, 15 / 16, 9 / 16, 11 / 16, 1]);
  assert.deepEqual(bounds(collisionFor('legacy:130:3', () => 'legacy:54:3')[0]), single);
});

test('the two large chest halves share an open seam and revert when a neighbor is removed', () => {
  assert.equal(shapeDependsOnNeighbors('legacy:54:3'), true);
  for (const [metadata, [dx, dz], collisionIndex] of [[2, [-1, 0], 0], [3, [1, 0], 3], [4, [0, 1], 5], [5, [0, -1], 2]]) {
    const key = `legacy:54:${metadata}`;
    const leftNeighbor = (x, y, z) => x === dx && !y && z === dz ? {key} : null;
    const rightNeighbor = (x, y, z) => x === -dx && !y && z === -dz ? key : 'air';
    const [base1, lid1, latch1] = chestMesh(key, leftNeighbor);
    const [base2, lid2, latch2] = chestMesh(key, rightNeighbor);
    assert.equal(base1.faces[1], -1, key);
    assert.equal(base2.faces[0], -1, key);
    assert.equal(base1.x1, 1, key);
    assert.equal(base2.x0, 0, key);
    assert.equal(lid1.faces[5], 3707, key);
    assert.equal(lid2.faces[5], 3725, key);
    assert.equal(latch1.x1, 1, key);
    assert.equal(latch2.x0, 0, key);
    assert.deepEqual(base1.chestLightOffset, dx < 0 || dz < 0 ? [dx, 0, dz] : undefined, key);
    assert.deepEqual(base2.chestLightOffset, dx > 0 || dz > 0 ? [0 - dx, 0, 0 - dz] : undefined, key);
    const connected = [...single];
    connected[collisionIndex] = collisionIndex < 3 ? 0 : 1;
    assert.deepEqual(bounds(shapeFor(key, leftNeighbor)[0]), connected, key);
    assert.deepEqual(bounds(collisionFor(key, leftNeighbor)[0]), connected, key);
    assert.deepEqual(bounds(collisionFor(key)[0]), single, key);
  }
});

test('a 90-degree native hinge moves both lid halves and latch while keeping selection and collision', () => {
  const key = 'legacy:54:3';
  const opened = {key, object: {type: 'Chest', data: {open: true}}};
  const openNeighbor = (x, y, z) => x === 1 && !y && !z ? opened : 'air';
  const closedNeighbor = (x, y, z) => x === -1 && !y && !z ? key : 'air';
  const [base, lid, latch] = chestMesh(key, openNeighbor);
  assert.deepEqual(bounds(base), [1 / 16, 0, 1 / 16, 1, 10 / 16, 15 / 16]);
  assert.deepEqual(bounds(lid), [1 / 16, 9 / 16, -4 / 16, 1, 23 / 16, 1 / 16]);
  assert.deepEqual(bounds(latch), [15 / 16, 23 / 16, -1 / 16, 1, 1.5, 3 / 16]);
  assert.deepEqual(bounds(chestMesh(opened, closedNeighbor)[1]), [0, 9 / 16, -4 / 16, 15 / 16, 23 / 16, 1 / 16]);
  assert.equal(lid.faces[0], 3768);
  assert.equal(latch.faces[1], -1);
  assert.equal(chestMesh(key)[1].y1, 14 / 16);
  assert.deepEqual(bounds(shapeFor(opened)[0]), single);
  assert.deepEqual(bounds(collisionFor(opened)[0]), single);
});

test('formerly unknown HarvestCraft variants use source tiles and keep plant collision disabled', () => {
  for (const [id, meta, tile, solid] of [[3803, 0, 3732, true], [3982, 0, 3733, true],
    [3936, 0, 3734, false], [3965, 4, 3736, false], [3965, 7, 3737, false], [3986, 7, 3740, false],
    [3903, 0, 3792, true], [3998, 0, 3793, true]]) {
    const key = `legacy:${id}:${meta}`;
    const [shape] = shapeFor(key);
    assert.equal(shape.faces[0], tile);
    assert.equal(shape.solid, solid);
    assert.equal(collisionFor(key).length, Number(solid));
  }
});

test('the two Mine Little Brony random gem block IDs retain their original textures', () => {
  assert.equal(shapeFor('legacy:3217:0')[0].faces[0], 1);
  assert.equal(shapeFor('legacy:3230:0')[0].faces[0], 1041);
});
