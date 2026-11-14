import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as geometry from '../world/geometry.mjs';
import { extractedModel, modelFamilies, placementModelObject, withExtractedModels } from '../world/extracted-models.mjs';
import { displayObject, loadBase } from './base.mjs';
import { createHoneymoonServer } from './index.mjs';
import { physics } from './physics.mjs';
import { isLadder } from '../world/block-movement.mjs';
import { createGame } from './game.mjs';
import { openStore } from './store.mjs';

const directory = fileURLToPath(new URL('../generated/world/', import.meta.url));
const sampleChunkRadius = 8;
const inOriginalDistrict = ([x,z]) => x >= -sampleChunkRadius && x < sampleChunkRadius &&
  z >= -sampleChunkRadius && z < sampleChunkRadius;

test('mounted item frames expose their visual state without the original NBT payload', {
  skip: !existsSync(join(directory, 'world.json')) ? 'Run the Anvil import to verify item frames' : false,
}, () => {
  const base = loadBase(directory);
  const chunks = base.manifest.chunkPalettes ? base.manifest.chunks.filter(inOriginalDistrict) : base.manifest.chunks;
  const frames = chunks.flatMap(([x, z]) => base.publicChunk(x, z).entities
    .filter(entity => entity.type === 'ItemFrame'));
  if (!base.manifest.chunkPalettes) assert.equal(frames.length, base.manifest.counts.entities.ItemFrame);
  assert.ok(frames.some(frame => frame.data.Item?.id === 260));
  for (const frame of frames) {
    assert.equal(frame.position.length, 3);
    assert.ok([0, 1, 2, 3].includes(frame.data.Dir ?? frame.data.Direction));
    assert.ok(!Object.hasOwn(frame.data, 'UUIDMost'));
    if (frame.data.Item) assert.deepEqual(Object.keys(frame.data.Item), ['id', 'Damage']);
  }
});

test('west cellar rung is public and works with an older saved hatch state', {
  skip: !existsSync(join(directory, 'world.json')) ? 'Run the Anvil import to verify the west cellar' : false,
}, () => {
  const base = loadBase(directory);
  const [x, y, z] = [-60, 64, 56];
  const fixture = base.getCell(x, y, z);
  assert.equal(fixture.key, 'legacy:96:12');
  assert.equal(base.getCell(x, y - 1, z).key, 'legacy:65:3');
  assert.deepEqual(base.publicChunk(x >> 4, z >> 4).objects.find(item => item.type === 'WestCellarHatch'), fixture.object);
  assert.equal(isLadder(fixture), true);
  assert.equal(isLadder({...fixture, key: 'legacy:96:8'}), false);
  assert.equal(geometry.shapeFor(fixture).length, 2);
  assert.equal(geometry.collisionFor(fixture).length, 1);
  assert.equal(base.getCell(-72, 73, 28).object, null);
  const store = openStore(':memory:');
  try {
    const game = createGame(base, store, geometry);
    const {id} = store.createPlayer();
    store.writeEdit({x, y, z, cell: 'legacy:96:12', object: null, revision: 1}, null);
    const hatch = game.snapshot(id).overrides.find(edit => edit.x === x && edit.y === y && edit.z === z);
    assert.deepEqual(hatch.object, fixture.object);
  } finally {
    store.close();
  }
});
const stairs = new Set([53, 67, 108, 109, 114, 128, 134, 135, 136]);
const directions = [[1, 0, 0], [-1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]];
const cases = [
  { name: 'full block', preferred: [-8, 64, -20], match: ({ id }) => [1, 2, 4].includes(id), expect: boxes => boxes.length === 1 && boxes[0].y1 === 1 },
  { name: 'lower slab', match: ({ id, meta }) => [44, 126].includes(id) && (meta & 8) === 0, expect: boxes => boxes[0].y0 === 0 && boxes[0].y1 === 0.5 },
  { name: 'upper slab', match: ({ id, meta }) => [44, 126].includes(id) && (meta & 8) !== 0, expect: boxes => boxes[0].y0 === 0.5 && boxes[0].y1 === 1 },
  { name: 'stairs east/west', match: ({ id, meta }) => stairs.has(id) && (meta & 2) === 0, expect: boxes => boxes.length > 1 },
  { name: 'stairs north/south', match: ({ id, meta }) => stairs.has(id) && (meta & 2) !== 0, expect: boxes => boxes.length > 1 },
  { name: 'glass', match: ({ id }) => id === 20 || id === 102, expect: boxes => boxes.some(box => box.mode !== 'opaque') },
  { name: 'plant', match: ({ id }) => [31, 37, 38, 4000].includes(id), expect: (boxes, collision) => boxes.some(box => box.kind === 'cross') && !collision.length },
  { name: 'RedPower mixed Cover', match: ({ id, meta, parts }) => id === 750 && meta === 0 && new Set(parts?.map(part => part.material)).size > 1, expect: boxes => boxes.length > 1 },
  { name: 'RedPower frame or tube', match: ({ id, meta }) => id === 765 || id === 750 && meta === 8, expect: (boxes, collision) => boxes.length && collision.length },
  { name: 'armchair', preferred: [-34, 65, -61], match: ({ id }) => id === 213, expect: boxes => boxes.length > 4 },
  { name: 'bookcase', preferred: [-59, 76, -50], match: ({ id }) => id === 2250, expect: boxes => boxes.length > 4 },
  { name: 'cloud', match: ({ id }) => id === 3246, expect: (boxes, collision) => boxes.length === 1 && collision.length === 1 },
  { name: 'sign', preferred: [-54, 70, -49], match: ({ id, object }) => [63, 68].includes(id) && Object.entries(object?.data ?? {}).some(([key, value]) => /^Text[1-4]$/.test(key) && value.trim()), expect: (boxes, collision) => boxes.length && !collision.length },
  { name: 'unlit Jammy lamp', preferred: [-51, 73, -50], match: ({ id }) => id === 220, expect: boxes => boxes.length > 1 && boxes.every(box => !box.emissive) },
  { name: 'lit lamp', match: ({ id, object }) => [219, 756, 758].includes(id) || id === 768 && Boolean((object?.data?.ps ?? 0) & 1) !== Boolean((object?.data?.ps ?? 0) & 2), expect: boxes => boxes.some(box => box.emissive) },
];

function at(base, x, y, z) {
  const { key, object } = base.getCell(x, y, z);
  return { key, object, parts: base.manifest.compositions[key]?.parts };
}

function availableCases(base) {
  const { palette, chunks, spawn, compositions } = base.manifest;
  const matchesKey = key => {
    const [, id, meta] = key.split(':');
    const block = Number(id);
    const parts = compositions[key]?.parts;
    return cases.filter(candidate => {
      if (candidate.name === 'sign') return [63, 68].includes(block);
      if (candidate.name === 'lit lamp' && block === 768) return true;
      return candidate.match({ id: block, meta: Number(meta), parts });
    });
  };
  const matched = new Map(palette.map(key => [key, matchesKey(key)]));
  // This test exercises block actions in the original district. The exhaustive
  // source comparison covers the expanded map without running an HTTP server per block family.
  const sortedChunks = chunks.filter(inOriginalDistrict).sort((a, b) => {
    const distance = ([x, z]) => Math.hypot(x * 16 + 8 - spawn[0], z * 16 + 8 - spawn[2]);
    return distance(a) - distance(b);
  });
  const candidates = new Map(cases.map(candidate => [candidate.name, candidate.preferred ? [candidate.preferred] : []]));
  const capPerType = 128;

  for (const [cx, cz] of sortedChunks) {
    const chunk = base.publicChunk(cx, cz);
    const entries = chunk.palette ?? palette;
    const chunkMatches = entries.map(key => matched.get(key));
    for (const { y: sy, indices } of chunk.sections) {
      const bytes = Buffer.from(indices, 'base64');
      for (let offset = 0; offset < 4096; offset++) {
        const index = bytes.readUInt16LE(offset * 2);
        if (!index) continue;
        if (!chunkMatches[index].some(candidate => candidates.get(candidate.name).length < capPerType)) continue;
        const position = [cx * 16 + (offset & 15), sy * 16 + (offset >> 8), cz * 16 + ((offset >> 4) & 15)];
        const [, id, meta] = entries[index].split(':');
        const { object, parts } = at(base, ...position);
        for (const candidate of chunkMatches[index]) {
          const list = candidates.get(candidate.name);
          if (list.length < capPerType && candidate.match({ id: Number(id), meta: Number(meta), object, parts })) list.push(position);
        }
      }
    }
  }
  return candidates;
}

function findStand(base, target, original, physicalGeometry) {
  const [x, y, z] = target;
  const before = physics(base, physicalGeometry, (a, b, c) => at(base, a, b, c));
  const after = physics(base, physicalGeometry, (a, b, c) => a === x && b === y && c === z ? null : at(base, a, b, c));
  const anchors = directions.map(([dx, dy, dz]) => [x + dx, y + dy, z + dz])
    .filter(position => at(base, ...position).key !== 'air');
  if (!anchors.length) return null;
  for (let distance = 1; distance <= 4; distance++) {
    for (let dx = -distance; dx <= distance; dx++) {
      for (let dz = -distance; dz <= distance; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== distance) continue;
        const sx = x + dx + 0.5;
        const sz = z + dz + 0.5;
        for (const dy of [0, -1, 1, -2, 2, -3, 3]) {
          const gy = y + dy - 1;
          if (!base.inBounds(sx, gy + 1, sz)) continue;
          const floor = physicalGeometry.collisionFor(at(base, x + dx, gy, z + dz),
            (nx, ny, nz) => at(base, x + dx + nx, gy + ny, z + dz + nz));
          const tops = new Set(floor.filter(box => box.x0 < 0.5 && box.x1 > 0.5 && box.z0 < 0.5 && box.z1 > 0.5).map(box => gy + box.y1));
          for (const sy of tops) {
            const stand = { x: sx, y: sy, z: sz };
            if (before.collides(stand) || before.overlaps(stand, x, y, z, original.key) || !before.visible(stand, ...target)) continue;
            const anchor = anchors.find(position => after.visible(stand, ...position));
            if (anchor) return { stand, anchor };
          }
        }
      }
    }
  }
  return null;
}

async function checkActions(base, candidate, target, { stand, anchor }, catalogs) {
  const [x, y, z] = target;
  const [ax, ay, az] = anchor;
  const original = at(base, x, y, z);
  const neighbors = (dx, dy, dz) => at(base, x + dx, y + dy, z + dz);
  const model = extractedModel(catalogs, original);
  if (model) {
    assert.ok(model.surfaces.length && model.selection.length, 'model geometry and selection');
    for (const { positions, uv } of model.surfaces) {
      assert.ok(positions.length === 12 && positions.every(Number.isFinite), 'model quad positions');
      assert.ok(uv.length === 8 && uv.every(value => value >= 0 && value <= 1), 'model atlas coordinates');
    }
  } else {
    const shape = geometry.shapeFor(original, neighbors);
    const collision = geometry.collisionFor(original, neighbors);
    assert.ok(candidate.expect(shape, collision), 'shape or collision expectation');
    for (const part of shape) {
      const visibleTiles = part.faces.filter(index => index >= 0);
      assert.ok(visibleTiles.length && visibleTiles.every(index => Number.isInteger(index) && index < geometry.ATLAS_GRID ** 2), 'atlas tile indices');
    }
  }
  const scenario = { ...base, manifest: { ...base.manifest, spawn: [stand.x, stand.y, stand.z] } };
  const app = createHoneymoonServer({ base: scenario, geometry, state: ':memory:', allowRemoval: true });
  try {
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    let cookie;
    async function request(path, input) {
      const response = await fetch(origin + path, {
        method: input ? 'POST' : 'GET',
        headers: { ...(cookie && { Cookie: cookie }), ...(input && { 'Content-Type': 'application/json' }) },
        ...(input && { body: JSON.stringify(input) }),
      });
      cookie ??= response.headers.get('set-cookie')?.split(';')[0];
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    }
    assert.deepEqual((await request('/api/session', {})).position, stand);
    await request('/api/position', stand);
    const action = (type, expectedRevision, extra) => request('/api/action', {
      type, requestId: `world-sample-${type}`, x, y, z, expectedRevision, ...extra,
    });
    const copy = await action('copy', 0);
    assert.equal(copy.cell, original.key);
    const removed = await action('remove', 0);
    assert.deepEqual(removed.changes[0], { x, y, z, cell: null, object: null, revision: 1 });
    const placed = await action('place', 1, { cell: copy.cell, against: { x: ax, y: ay, z: az } });
    const placedObject = placementModelObject(catalogs, original.key, displayObject(original.object), target);
    assert.deepEqual(placed.changes[0], { x, y, z, cell: original.key, object: displayObject(placedObject), revision: 2,
      ...(base.manifest.chunkPalettes && original.parts && {parts:original.parts}) });
    const restored = (await request('/api/world')).overrides.find(cell => cell.x === x && cell.y === y && cell.z === z);
    assert.deepEqual(restored, placed.changes[0]);
    return `cell ${target.join(',')}, stand ${[stand.x, stand.y, stand.z].join(',')}, ${original.key.slice(0, 32)}`;
  } finally {
    await app.close();
  }
}

test('copy, remove and restore actual Honeymoon block families through HTTP', {
  skip: !existsSync(join(directory, 'world.json')) && 'Generate the world with npm run import:world', timeout: 120000,
}, async t => {
  const base = loadBase(directory);
  if (base.manifest.chunks.length < 64) {
    t.skip('This matrix requires the complete 64-chunk district');
    return;
  }
  const catalogs = {};
  for (const family of modelFamilies) {
    const file = join(directory, '..', 'models', `${family}.json`);
    if (existsSync(file) && existsSync(join(directory, '..', 'models', `${family}.png`))) {
      catalogs[family] = JSON.parse(readFileSync(file, 'utf8'));
    }
  }
  const physicalGeometry = withExtractedModels(geometry, catalogs);
  const available = availableCases(base);
  for (const candidate of cases) {
    await t.test(candidate.name, async t => {
      for (const target of available.get(candidate.name)) {
        const original = at(base, ...target);
        const [, id, meta] = original.key.split(':');
        if (!candidate.match({ id: Number(id), meta: Number(meta), ...original })) continue;
        const setup = findStand(base, target, original, physicalGeometry);
        if (!setup) continue;
        t.diagnostic(await checkActions(base, candidate, target, setup, catalogs));
        return;
      }
      assert.fail(`No visible, safely editable cell found for ${candidate.name}`);
    });
  }
});
