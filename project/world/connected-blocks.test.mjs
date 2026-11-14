import test from 'node:test';
import assert from 'node:assert/strict';
import {collisionFor, selectionFor, shapeDependsOnNeighbors, shapeFor, tiles} from './geometry.mjs';
import {filledVoxels, voxelKey, writeVoxel} from './voxel-chisel.mjs';

const bounds = ({x0, y0, z0, x1, y1, z1}) => [x0, y0, z0, x1, y1, z1];
const side = (x, y, z, cell) => (dx, dy, dz) => x === dx && y === dy && z === dz ? cell : 'air';

test('fences use distinct native neighbor types and update all four arms when edited', () => {
  const checks = [[[-1, 0, 0], [0, 0, .375, .625, 1.5, .625]],
    [[1, 0, 0], [.375, 0, .375, 1, 1.5, .625]],
    [[0, 0, -1], [.375, 0, 0, .625, 1.5, .625]],
    [[0, 0, 1], [.375, 0, .375, .625, 1.5, 1]]];
  for (const id of [85, 113]) {
    const fence = `legacy:${id}:0`;
    for (const [direction, expected] of checks) {
      const at = cell => side(...direction, cell);
      for (const connecting of [fence, 'legacy:107:4', 'legacy:244:1', 'legacy:52:0']) {
        assert.deepEqual(collisionFor(fence, at(connecting)).map(bounds), [expected]);
        assert.equal(shapeFor(fence, at(connecting)).length, 3);
        assert.deepEqual(selectionFor(fence, at(connecting)).map(bounds), [expected.with(4, 1)]);
      }
      for (const separated of ['air', 'legacy:20:0', 'legacy:18:0', 'legacy:86:1', 'legacy:139:0',
        `legacy:${id === 85 ? 113 : 85}:0`]) {
        assert.deepEqual(collisionFor(fence, at(separated)).map(bounds), [[.375, 0, .375, .625, 1.5, .625]]);
        assert.equal(shapeFor(fence, at(separated)).length, 1);
      }
    }
  }
  const voxels = filledVoxels('legacy:1:0');
  assert.equal(shapeFor('legacy:85:0', side(1, 0, 0, {key:voxelKey, voxels})).length, 3);
  assert.equal(shapeFor('legacy:85:0', side(1, 0, 0, {key:voxelKey, voxels:writeVoxel(voxels, 0, null)})).length, 1);
});

test('walls change render post, side arms, bounding height, moss and movement separately', () => {
  const id = 'legacy:139:1';
  const xLine = (x, y, z) => x !== 0 && y === 0 && z === 0 ? 'legacy:139:0' : 'air';
  assert.deepEqual(shapeFor(id, xLine).map(bounds), [[0, 0, .3125, 1, .8125, .6875]]);
  assert.equal(shapeFor(id, xLine)[0].faces[0], 36);
  const overhead = (x, y, z) => y === 1 ? 'legacy:1:0' : xLine(x, y, z);
  assert.deepEqual(shapeFor(id, overhead).map(bounds), [
    [.25, 0, .25, .75, 1, .75], [0, 0, .3125, .25, .8125, .6875], [.75, 0, .3125, 1, .8125, .6875],
  ]);
  assert.deepEqual(collisionFor(id, overhead).map(bounds), [[0, 0, .3125, 1, 1.5, .6875]]);
  assert.deepEqual(selectionFor(id, overhead).map(bounds), [[0, 0, .3125, 1, .8125, .6875]]);
  assert.deepEqual(collisionFor(id, side(0, 0, 1, 'legacy:107:0')).map(bounds), [[.25, 0, .25, .75, 1.5, 1]]);
});

test('panes use centered faces, narrow collision and distinct inherited opaque flags', () => {
  const pane = 'legacy:102:0';
  const one = side(1, 0, 0, 'legacy:20:0');
  const models = shapeFor(pane, one);
  assert.deepEqual(bounds(models[0]), [.5, 0, .5, 1, 1, .5]);
  assert.deepEqual(models[0].faces, [-1, -1, -1, -1, 49, 49]);
  assert.deepEqual(models[1].faces, [148, 148, -1, -1, -1, -1]);
  assert.deepEqual(collisionFor(pane, one).map(bounds), [[.5, 0, .4375, 1, 1, .5625]]);
  assert.deepEqual(selectionFor(pane, one).map(bounds), [[.4375, 0, .4375, 1, 1, .5625]]);
  const corner = (x, y, z) => x === 1 || z === -1 ? 'legacy:18:0' : 'air';
  assert.deepEqual(collisionFor(pane, corner).map(bounds), [
    [.5, 0, .4375, 1, 1, .5625], [.4375, 0, 0, .5625, 1, .5],
  ]);
  assert.deepEqual(selectionFor(pane, corner).map(bounds), [[.4375, 0, 0, 1, 1, .5625]]);
  for (const cell of ['legacy:101:0', 'legacy:52:0', 'legacy:107:0', 'air']) {
    assert.deepEqual(collisionFor(pane, side(1, 0, 0, cell)).map(bounds), [
      [0, 0, .4375, 1, 1, .5625], [.4375, 0, 0, .5625, 1, 1],
    ]);
  }
  const stacked = (x, y, z) => z === 0 && (y === 0 && x !== 0 || y === 1 && x <= 0) ? pane : 'air';
  assert.deepEqual(shapeFor(pane, stacked).filter(box => box.faces[3] === 148 && box.y0 > .5).map(bounds),
    [[.5, 1.01, .4375, 1, 1.01, .5625]]);
});

test('gate geometry opens away from the native heading and sinks between walls', () => {
  for (let facing = 0; facing < 4; facing++) {
    const open = `legacy:107:${facing | 4}`, closed = `legacy:107:${facing}`;
    const walls = (x, y, z) => y === 0 && (facing & 1 ? x === 0 && z !== 0 : x !== 0 && z === 0) ? 'legacy:139:0' : 'air';
    const mesh = shapeFor(open);
    const terminal = mesh[4];
    assert.deepEqual([terminal.x0, terminal.z0, terminal.x1, terminal.z1], [
      [0, .8125, .125, .9375], [.0625, 0, .1875, .125], [.875, .0625, 1, .1875], [.8125, .875, .9375, 1],
    ][facing]);
    assert.equal(shapeFor(open, walls)[0].y1, .8125);
    assert.equal(shapeFor(open)[0].y1, 1);
    assert.deepEqual(collisionFor(open, walls), []);
    assert.equal(collisionFor(closed, walls)[0].y1, 1.5);
    assert.deepEqual(selectionFor(open, walls), selectionFor(closed, walls));
    assert.ok(shapeDependsOnNeighbors(open));
  }
});

test('mod stairs inherit native corner rendering and movement with straight ray limits', () => {
  const outer = side(1, 0, 0, 'legacy:4035:2');
  assert.deepEqual(shapeFor('legacy:109:0', outer).map(bounds), collisionFor('legacy:109:0', outer).map(bounds));
  assert.deepEqual(bounds(collisionFor('legacy:109:0', outer)[1]), [.5, .5, .5, 1, 1, 1]);
  assert.deepEqual(bounds(selectionFor('legacy:109:0', outer)[1]), [.5, .5, 0, 1, 1, 1]);
  for (let color = 0; color < 16; color++) {
    const wool = shapeFor(`legacy:35:${color}`)[0].faces[0];
    const stairs = `legacy:${4035 + color}:0`;
    const slab = `legacy:${4051 + color}:8`;
    assert.equal(shapeFor(stairs, outer)[0].faces[0], wool);
    assert.deepEqual(bounds(shapeFor(stairs, outer)[1]), [.5, .5, .5, 1, 1, 1]);
    assert.deepEqual(bounds(collisionFor(stairs, outer)[1]), [.5, .5, .5, 1, 1, 1]);
    assert.equal(shapeFor(slab)[0].faces[0], wool);
    assert.deepEqual(bounds(collisionFor(slab)[0]), [0, .5, 0, 1, 1, 1]);
  }
  assert.equal(shapeFor('legacy:3247:7')[0].faces[0], tiles.cloud + 36);
  assert.equal(shapeFor('legacy:3248:0')[0].faces[0], tiles.cloud + 32);
  assert.deepEqual(bounds(collisionFor('legacy:3247:7')[1]), [0, 0, 0, 1, .5, .5]);
  const inner = side(-1, 0, 0, 'legacy:109:2');
  assert.deepEqual(collisionFor('legacy:4041:0', inner).map(bounds), [
    [0, 0, 0, 1, .5, 1], [.5, .5, 0, 1, 1, 1], [0, .5, .5, .5, 1, 1],
  ]);
});
