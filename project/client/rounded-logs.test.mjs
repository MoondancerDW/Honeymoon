import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {test} from 'node:test';
import {ATLAS_GRID, shapeFor} from '../world/geometry.mjs';
import {isTreeLog, logAxis} from './rounded-logs.mjs';

let result;
globalThis.self = {postMessage(value) { result = value; }};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier.startsWith('/world/') ? new URL('..' + specifier, import.meta.url).href : specifier, context);
  },
});
await import('./mesh-worker.mjs');
hooks.deregister();

function section(blocks) {
  const palette = ['air', ...new Set(blocks.map(block => block[3]))];
  const indices = new Uint16Array(18 ** 3);
  for (const [x, y, z, key] of blocks) {
    indices[x + 1 + (z + 1) * 18 + (y + 1) * 18 ** 2] = palette.indexOf(key);
  }
  self.onmessage({data: {
    type: 'precise', palette, indices, light: new Uint8Array(indices.length).fill(0xf3), atlasRows: 128,
    collectVisibility: true,
  }});
  assert.equal(result.error, undefined);
  return result;
}

const oak = 'legacy:17:0';
const horizontalX = 'legacy:17:4';
const horizontalZ = 'legacy:17:8';

test('each trunk axis has eight bark sides, octagonal end grain and outward triangle winding', () => {
  for (const [axis, key] of [horizontalX, oak, horizontalZ].entries()) {
    const box = shapeFor(key)[0];
    assert.equal(logAxis(box.faces), axis);
    assert.deepEqual([box.x0, box.y0, box.z0, box.x1, box.y1, box.z1], [0,0,0,1,1,1]);
    const {roundedLogs, layers, visibility, fitsSection} = section([[0,0,0,key]]);
    const {positions, uvs, indices, lightLevels} = layers.opaque;
    assert.equal(roundedLogs, 1);
    assert.equal(indices.length, (8 + 3 * 2) * 6);
    assert.equal(visibility, null);
    assert.equal(fitsSection, true);
    assert.ok(lightLevels.every(level => level === 0xf3));
    const textureCounts = new Map();
    for (let i = 0; i < uvs.length; i += 8) {
      const tile = Math.floor(uvs[i] * ATLAS_GRID) + ATLAS_GRID * Math.floor((1 - uvs[i + 1]) * 128);
      textureCounts.set(tile, (textureCounts.get(tile) ?? 0) + 1);
    }
    assert.equal(textureCounts.get(box.faces[axis * 2]), 6);
    assert.equal(textureCounts.get(box.faces[(axis * 2 + 2) % 6]), 8);
    for (let i = 0; i < indices.length; i += 3) {
      const [a,b,c] = [...indices.subarray(i,i+3)].map(index => positions.subarray(3*index,3*index+3));
      const u = b.map((value, j) => value - a[j]), v = c.map((value, j) => value - a[j]);
      const normal = [u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
      assert.ok(normal.reduce((sum, value, j) => sum + value * (a[j] - .5), 0) > 0);
    }
  }
});

test('trunks keep the same silhouette at end joints and go square at side and mixed-axis joints', () => {
  const ends = section([[2,4,3,oak],[2,5,3,oak]]);
  assert.equal(ends.roundedLogs, 2);
  assert.equal(ends.layers.opaque.indices.length, 22 * 6);
  for (const neighboringLog of [oak, horizontalX, 'legacy:17:12', 'legacy:701:1']) {
    const pair = section([[2,4,3,oak],[3,4,3,neighboringLog]]);
    assert.equal(pair.roundedLogs, 0);
    assert.equal(pair.layers.opaque.indices.length, 10 * 6);
  }
  const mixed = section([[2,4,3,oak],[2,5,3,horizontalX]]);
  assert.equal(mixed.roundedLogs, 0);
  assert.equal(mixed.layers.opaque.indices.length, 10 * 6);
  assert.equal(section([[2,4,3,oak],[3,4,3,'legacy:5:0']]).roundedLogs, 1);
});

test('both sides of a section boundary switch when a neighboring log is placed and removed', () => {
  for (const [x, otherX] of [[15,16],[0,-1]]) {
    for (const neighbor of [null, oak, null]) {
      const blocks = [[x,4,6,oak]];
      if (neighbor) blocks.push([otherX,4,6,neighbor]);
      assert.equal(section(blocks).roundedLogs, neighbor ? 0 : 1);
    }
    assert.equal(section([[x,4,6,horizontalX],[otherX,4,6,horizontalX]]).roundedLogs, 1);
  }
  assert.equal(section([[2,15,6,oak],[2,16,6,oak]]).roundedLogs, 1);
  assert.equal(section([[2,15,6,oak],[2,16,6,horizontalZ]]).roundedLogs, 0);
});

test('an opaque neighbor covers the flat bark and retains its own face behind the bevel', () => {
  const {roundedLogs, layers} = section([[0,0,0,oak],[1,0,0,'legacy:1:0']]);
  assert.equal(roundedLogs, 1);
  assert.equal(layers.opaque.indices.length, (13 + 6) * 6);
  const faceCoordinates = 4 * 3;
  const stoneFace = layers.opaque.positions.subarray(13 * faceCoordinates, 14 * faceCoordinates);
  assert.deepEqual([...stoneFace].filter((_, index) => index % 3 === 0), [1,1,1,1]);
});

test('modded tree logs round without treating wood planks, stone or machinery as logs', () => {
  for (const key of ['legacy:245:0','legacy:701:1','legacy:2163:1','legacy:2176:1','legacy:3251:3']) {
    assert.equal(isTreeLog(key), true);
    assert.equal(section([[5,5,5,key]]).roundedLogs, 1, key);
  }
  for (const key of ['legacy:5:0','legacy:162:1','legacy:2179:0','legacy:17:12']) {
    assert.equal(section([[5,5,5,key]]).roundedLogs, 0, key);
  }
});
