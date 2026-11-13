import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ATLAS_GRID, FACES, shapeFor } from '../../world/geometry.mjs';

const work = new URL('../../work/voxelize-spike/', import.meta.url);
const load = path => import(new URL('node_modules/@voxelize/' + path, work).href);
const [{ AABB }, { raycast, raycastAABB }, { Engine }, { default: setup, init, mesh_chunk_fast, set_registry }] =
  await Promise.all([
    'aabb/dist/index.mjs', 'raycast/dist/index.mjs', 'physics-engine/dist/index.js',
    'wasm-mesher/pkg/voxelize_wasm_mesher.js',
  ].map(load));
const coreBundle = readFileSync(new URL('node_modules/@voxelize/core/dist/index.mjs', work), 'utf8');
const utilities = Object.create(null);
const stageMask = coreBundle.match(/^const STAGE_MASK = (.*);$/m)?.[1];
assert.ok(stageMask);
for (const name of ['extractID', 'insertID', 'extractStage', 'insertStage']) {
  const expression = coreBundle.match(new RegExp('^_BlockUtils\\.' + name + ' = ([\\s\\S]*?^});', 'm'))?.[1];
  assert.ok(expression, name);
  // Isolate the exact distributed functions from the browser-only core bundle.
  utilities[name] = Function('const STAGE_MASK = ' + stageMask + '; return (' + expression + ')')();
}
const { extractID, insertID, extractStage, insertStage } = utilities;
const fixture = JSON.parse(readFileSync(new URL('fixture.json', import.meta.url)));
const { values } = parseArgs({ options: { 'verify-source': { type: 'boolean' } } });
if (values['verify-source']) {
  const generated = new URL('../../generated/world/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('world.json', generated)));
  const [x, y, z] = fixture.sourcePosition;
  const cx = Math.floor(x / 16);
  const cz = Math.floor(z / 16);
  const chunk = JSON.parse(readFileSync(new URL(`chunks/${cx}.${cz}.json`, generated)));
  const section = chunk.sections.find(section => section.y === Math.floor(y / 16));
  const index = (x & 15) + 16 * (z & 15) + 256 * (y & 15);
  const key = manifest.palette[Buffer.from(section.indices, 'base64').readUInt16LE(index * 2)];
  assert.equal(key, fixture.key);
  assert.deepEqual(manifest.compositions[key], fixture.composition);
}
const boxes = shapeFor({ key: fixture.key, ...fixture.composition });
assert.equal(boxes.length, 4);
const axes = [[2, 1], [1, 2], [0, 2], [2, 0], [1, 0], [0, 1]];
const minimum = ['x0', 'y0', 'z0'];
const maximum = ['x1', 'y1', 'z1'];
const corners = [[0, 0], [1, 0], [0, 1], [1, 1]];
const toAabb = (box) => ({minX: box.x0, minY: box.y0, minZ: box.z0, maxX: box.x1, maxY: box.y1, maxZ: box.z1});
const aabb = ({x0, y0, z0, x1, y1, z1}, at) => new AABB(
  x0 + at[0], y0 + at[1], z0 + at[2], x1 + at[0], y1 + at[1], z1 + at[2],
);

function block(id, name, boxes) {
  return {
    id, name, rotatable: false, yRotatable: false, isEmpty: !boxes.length, isFluid: false,
    isOpaque: false, isSeeThrough: false, transparentStandalone: false,
    isTransparent: Array(6).fill(true), dynamicPatterns: null,
    aabbs: boxes.map(toAabb),
    faces: boxes.flatMap((box, boxIndex) => FACES.flatMap((dir, face) => {
      const tile = box.faces[face];
      if (tile < 0) return [];
      const axis = face >> 1;
      const u = tile % ATLAS_GRID;
      const v = ATLAS_GRID - 1 - Math.floor(tile / ATLAS_GRID);
      return [{
        name: `p${boxIndex}-f${face}`,
        independent: false, isolated: false, dir,
        corners: corners.map(([u, v]) => {
          const point = [0, 0, 0];
          point[axis] = box[(face & 1 ? maximum : minimum)[axis]];
          point[axes[face][0]] = box[(u ? maximum : minimum)[axes[face][0]]];
          point[axes[face][1]] = box[(v ? maximum : minimum)[axes[face][1]]];
          return {pos: point, uv: [u, v]};
        }),
        range: {startU: u / ATLAS_GRID, endU: (u + 1) / ATLAS_GRID,
          startV: v / ATLAS_GRID, endV: (v + 1) / ATLAS_GRID},
      }];
    })),
  };
}

const wasm = readFileSync(new URL('node_modules/@voxelize/wasm-mesher/pkg/voxelize_wasm_mesher_bg.wasm', work));
const wasmSHA256 = createHash('sha256').update(wasm).digest('hex');
assert.equal(wasmSHA256, '5e361c8c5a4ad3a4a10d2a57c1835981662445f3932d57da0025077dd171ee29');
await setup({module_or_path: wasm});
init();
const maxId = 65535;
const types = [block(0, 'Air', []), block(maxId, fixture.key, boxes)];
const registry = {blocksById: types.map(item => [item.id, item])};
set_registry(registry);
const at = [4, 4, 4];
const [x, y, z] = at;
const size = 8;
const voxels = new Uint32Array(size ** 3);
const data = {voxels, lights: new Uint32Array(voxels.length).fill(15 << 16),
  min: [0, 0, 0], shape: [size, size, size]};
const chunks = Array.from({length: 9}, (_, i) => i === 4 ? data : null);
const offset = x * size ** 2 + y * size + z;
const min = new Int32Array([0, 0, 0]);
const max = new Int32Array([size, size, size]);
const mesh = () => mesh_chunk_fast(chunks, min, max, size).geometries;

const placed = insertID(insertStage(0, 5), maxId);
const overflow = insertID(insertStage(0, 5), maxId + 1);
assert.equal(extractID(placed), maxId);
assert.equal(extractStage(placed), 5);
assert.equal(extractID(overflow), 0);
voxels[offset] = placed;
const first = mesh();
assert.ok(first.length > 0);
assert.ok(first.every(geometry => geometry.voxel === maxId));
const outputUVTiles = new Set();
for (const geometry of first) {
  for (let vertex = 0; vertex < geometry.uvs.length; vertex += 8) {
    const centerU = (geometry.uvs[vertex] + geometry.uvs[vertex + 2] + geometry.uvs[vertex + 4] + geometry.uvs[vertex + 6]) / 4;
    const centerV = (geometry.uvs[vertex + 1] + geometry.uvs[vertex + 3] + geometry.uvs[vertex + 5] + geometry.uvs[vertex + 7]) / 4;
    const tile = Math.floor(centerU * ATLAS_GRID) + ATLAS_GRID * (ATLAS_GRID - 1 - Math.floor(centerV * ATLAS_GRID));
    outputUVTiles.add(tile);
  }
}
assert.deepEqual(outputUVTiles, new Set(boxes.flatMap(box => box.faces.filter(tile => tile >= 0))));
const meshSummary = {
  groups: first.length,
  quads: first.reduce((n, geometry) => n + geometry.indices.length / 6, 0),
  outputUVTiles: [...outputUVTiles],
};
assert.deepEqual(meshSummary, {groups: 1, quads: 24, outputUVTiles: [209, 178]});
voxels[offset] = 0;
assert.deepEqual(mesh(), []);
voxels[offset] = placed;
assert.deepEqual(mesh(), first);
voxels[offset] = overflow;
assert.deepEqual(mesh(), []);
voxels[offset] = placed;

const boxesAt = boxes.map(box => aabb(box, at));
const atFixture = (x, y, z) => x === at[0] && y === at[1] && z === at[2];
const getVoxel = (x, y, z) => atFixture(x, y, z) && extractID(voxels[offset]) ? boxesAt : [];
const { direction } = fixture.ray;
const start = fixture.ray.start.map((n, i) => n + at[i]);
const hits = boxesAt.map(box => raycastAABB(start, direction, box)).filter(Boolean).map(hit => hit.distance);
assert.deepEqual(hits, [1, 1.5]);
const hit = raycast(getVoxel, start, direction, 6);
const reverseHit = raycast((x, y, z) => [...getVoxel(x, y, z)].reverse(), start, direction, 6);
const distance = point => Math.hypot(...point.map((n, i) => n - start[i]));
assert.deepEqual(hit.voxel, at);
assert.equal(distance(hit.point), hits.at(-1));
assert.ok(distance(hit.point) > Math.min(...hits));
assert.ok(distance(reverseHit.point) < distance(hit.point));
const engine = new Engine(getVoxel, () => false, () => [], () => 0, () => 0,
  {gravity: [0,-20,0], minBounceImpulse: .5, airDrag: 0, fluidDrag: 0, fluidDensity: 1});
const body = new AABB(...start.map(n => n - .025), ...start.map(n => n + .025));
const velocity = direction.map(n => n * 4);
const resting = [0,0,0];
engine.processCollisions(body, velocity, resting);
assert.ok(resting.some(Boolean));
const collisionTravel = distance([body.minX + .025, body.minY + .025, body.minZ + .025]);
assert.ok(Math.abs(collisionTravel - (Math.min(...hits) - .025)) < 1e-5);
voxels[offset] = 0;
assert.equal(raycast(getVoxel, start, direction, 6), null);
const unobstructedBody = new AABB(...start.map(n => n - .025), ...start.map(n => n + .025));
const noCollision = [0,0,0];
engine.processCollisions(unobstructedBody, velocity, noCollision);
assert.deepEqual(noCollision, [0,0,0]);
assert.equal(distance([unobstructedBody.minX + .025, unobstructedBody.minY + .025, unobstructedBody.minZ + .025]), 4);

const boundaryRay = raycastAABB([0, 0, -1], [0, 0, 1], new AABB(0, 0, 0, 1, 1, 1));
assert.ok(Number.isNaN(boundaryRay?.distance));
const report = {
  runtime: process.version,
  versions: Object.fromEntries(['core','wasm-mesher','aabb','physics-engine','raycast'].map(name => [name,
    JSON.parse(readFileSync(new URL(`node_modules/@voxelize/${name}/package.json`, work))).version])),
  wasmSHA256,
  checkedSource: Boolean(values['verify-source']),
  fixture: {sourcePosition: fixture.sourcePosition, trialPosition: at, parts: fixture.composition.parts, boxes: boxes.length},
  mesh: {...meshSummary, id65535: extractID(placed), id65536: extractID(overflow), stage: extractStage(placed), removeAndRestore: true},
  raycast: {hit, direction, distances: hits, distance: distance(hit.point),
    reverseDistance: distance(reverseHit.point), boundaryDistanceNaN: Number.isNaN(boundaryRay?.distance)},
  physics: {collisionTravel, resting, afterRemoveTravel: 4, afterRemoveResting: noCollision},
};
console.log(JSON.stringify(report, null, 2));
writeFileSync(new URL('result.json', work), JSON.stringify(report, null, 2) + '\n');
