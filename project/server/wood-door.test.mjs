import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as geometry from '../world/geometry.mjs';
import { loadBase } from './base.mjs';
import { createGame } from './game.mjs';
import { openStore } from './store.mjs';

const work = fileURLToPath(new URL('../work/', import.meta.url));
const lower = { x: 8, y: 1, z: 10 };
const upper = { ...lower, y: 2 };
const closed = 'legacy:64:1';
const open = 'legacy:64:5';
const hinge = 'legacy:64:8';
const object = {
  key: 'tile:8:1:10', position: [8, 1, 10], type: 'Door',
  data: { direction: 1, privateField: 'preserved in storage' },
};

function fixture(directory, contentHash = 'first') {
  const palette = ['air', 'legacy:1:0', closed, hinge, 'legacy:71:1', 'legacy:71:8'];
  const manifest = {
    schemaVersion: 1, contentHash, palette, chunks: [[0, 0]], compositions: {},
    bounds: { minX: 0, maxX: 15, minY: 0, maxY: 15, minZ: 0, maxZ: 15 },
    spawn: [8.5, 1, 8.5],
  };
  const indices = Buffer.alloc(8192);
  const put = (x, y, z, cell) => indices.writeUInt16LE(palette.indexOf(cell), 2 * (x + 16 * z + 256 * y));
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) put(x, 0, z, 'legacy:1:0');
  }
  put(8, 1, 10, closed);
  put(8, 2, 10, hinge);
  put(10, 1, 10, 'legacy:71:1');
  put(10, 2, 10, 'legacy:71:8');
  put(6, 1, 10, closed);
  mkdirSync(join(directory, 'chunks'), { recursive: true });
  writeFileSync(join(directory, 'world.json'), JSON.stringify(manifest));
  writeFileSync(join(directory, 'chunks', '0.0.json'), JSON.stringify({
    x: 0, z: 0, objects: [object], entities: [],
    sections: [{ y: 0, indices: indices.toString('base64') }],
  }));
  return loadBase(directory);
}

function command(requestId, position, expectedRevision) {
  return { type: 'interact', requestId, ...position, expectedRevision };
}

test('wooden door toggles as one durable revision and respects both halves of the new collision shape', t => {
  mkdirSync(work, { recursive: true });
  const directory = mkdtempSync(join(work, 'wood-door-test-'));
  const file = join(directory, 'state.sqlite');
  let store = openStore(file);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let now = 0;
  const options = { clock: () => now };
  let game = createGame(fixture(directory), store, geometry, options);
  const opener = store.createPlayer().id;
  const visitor = store.createPlayer().id;
  game.session(opener);
  game.session(visitor);

  const opening = command('door-open-1', lower, 0);
  const opened = game.action(opener, opening);
  assert.equal(opened.status, 200);
  assert.equal(opened.output.effects[0].open, true);
  assert.deepEqual(opened.output.changes.map(change => [change.cell, change.revision]), [[open, 1], [hinge, 1]]);
  assert.deepEqual(store.getEdit(lower.x, lower.y, lower.z).object, object);
  assert.deepEqual(opened.output.changes[0].object.data, { direction: 1 });
  assert.equal(game.action(opener, opening).replay, true);
  assert.equal(game.action(opener, command('stale-door', upper, 0)).output.error, 'stale_cell');

  now += 500;
  game.position(visitor, { x: 8.5, y: 1, z: 9.5 });
  now += 500;
  game.position(visitor, { x: 8.5, y: 2.25, z: 10.1 });
  const blocked = game.action(opener, command('door-blocked', upper, 1));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.output.error, 'occupied');
  assert.equal(game.worldRevision(), 1);
  assert.deepEqual(game.snapshot(opener).overrides.find(edit => edit.cell === open).object.data, { direction: 1 });

  store.close();
  store = openStore(file);
  game = createGame(fixture(directory, 'rebuilt'), store, geometry, options);
  assert.deepEqual(game.conflicts, []);
  assert.equal(store.getEdit(lower.x, lower.y, lower.z).cell, open);
  assert.equal(store.getEdit(upper.x, upper.y, upper.z).revision, 1);
  const closing = game.action(opener, command('door-close-1', upper, 1));
  assert.equal(closing.status, 200);
  assert.equal(closing.output.effects[0].open, false);
  assert.deepEqual(closing.output.changes.map(change => [change.cell, change.revision]), [[closed, 3], [hinge, 3]]);
  assert.equal(game.action(opener, command('iron-door', { x: 10, y: 1, z: 10 }, 0)).output.error, 'no_interaction');
  assert.equal(game.action(opener, command('orphan-door', { x: 6, y: 1, z: 10 }, 0)).output.error, 'no_interaction');
});
