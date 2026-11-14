import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import * as geometry from '../world/geometry.mjs';
import { blockKey, relatedBlockStates } from '../world/block-interactions.mjs';
import { extractedModel } from '../world/extracted-models.mjs';
import { cellAddress, loadBase } from './base.mjs';
import { createGame } from './game.mjs';
import { registerMechanics } from './mechanics.mjs';
import { openStore } from './store.mjs';

function fixture(entries, spawn = [5.5, 1, 4.5], hash = 'fixture-1') {
  const cells = new Map(entries.map(([x, y, z, id, meta]) => [cellAddress(x, y, z), blockKey(id, meta)]));
  const catalog = new Set(['air', 'legacy:1:0']);
  for (const key of cells.values()) [key, ...relatedBlockStates(key)].forEach(variant => catalog.add(variant));
  const bounds = {minX: 0, minY: 0, minZ: 0, maxX: 15, maxY: 15, maxZ: 15};
  return {
    hash, catalog, manifest: {spawn, bounds, compositions: {}},
    inBounds: (x, y, z) => x >= 0 && x < 16 && y >= 0 && y < 16 && z >= 0 && z < 16,
    getCell: (x, y, z) => ({key: cells.get(cellAddress(x, y, z)) ?? (y === 0 ? 'legacy:1:0' : 'air'), object: null}),
  };
}

function gameFor(base, store, clock) {
  const modules = registerMechanics(base, store, geometry).filter(module => module.id !== 'diagnostic');
  return createGame(base, store, geometry, {clock, modules});
}

function command(requestId, [x, y, z], expectedRevision = 0) {
  return {type: 'interact', requestId, x, y, z, expectedRevision};
}

test('pressed wooden button opens both iron door halves and survives a restart until timed release', t => {
  const base = fixture([[5, 1, 6, 71, 1], [5, 2, 6, 71, 8], [6, 2, 6, 143, 3]]);
  const store = openStore(':memory:');
  t.after(() => store.close());
  let now = 0;
  const clock = () => now;
  let game = gameFor(base, store, clock);
  const player = store.createPlayer().id;
  game.session(player);
  assert.equal(game.action(player, command('hand-iron-door', [5, 1, 6])).output.error, 'no_interaction');
  const request = command('press-timber', [6, 2, 6]);
  const press = game.action(player, request);
  assert.equal(press.status, 200, JSON.stringify(press.output));
  assert.deepEqual(press.output.changes.map(change => [change.cell, change.revision]), [
    ['legacy:143:11', 1], ['legacy:71:5', 1], ['legacy:71:8', 1],
  ]);
  assert.deepEqual(press.output.effects.map(effect => effect.sound), ['click.on', 'door.open']);
  assert.equal(game.action(player, request).replay, true);
  game = gameFor({...base, hash: 'fixture-2'}, store, clock);
  assert.deepEqual(game.conflicts, []);
  now = 1499;
  assert.equal(game.advance(), null);
  now++;
  const release = game.advance();
  assert.deepEqual(release.changes.map(change => change.cell), ['legacy:143:3', 'legacy:71:1', 'legacy:71:8']);
  assert.deepEqual(release.effects.map(effect => effect.sound), ['click.off', 'door.close']);
  assert.equal(game.advance(), null);
});

test('lever powers vanilla dust, repeaters, and compatible lamps with their native delays', t => {
  const base = fixture([
    [5, 1, 6, 69, 5], [6, 1, 6, 55, 0], [7, 1, 6, 55, 0], [8, 1, 6, 93, 5],
    [9, 1, 6, 123, 0], [6, 1, 7, 757, 0],
  ]);
  const store = openStore(':memory:');
  t.after(() => store.close());
  let now = 0;
  const game = gameFor(base, store, () => now);
  const player = store.createPlayer().id;
  game.session(player);
  const power = game.action(player, command('switch-power-on', [5, 1, 6]));
  assert.equal(power.status, 200, JSON.stringify(power.output));
  assert.deepEqual(power.output.changes.slice(0, 3).map(change => change.cell), [
    'legacy:69:13', 'legacy:55:15', 'legacy:55:14',
  ]);
  assert.equal(store.getEdit(8,1,6), undefined);
  now = 199;
  assert.equal(game.advance(), null);
  now++;
  assert.deepEqual(game.advance().changes.map(change => change.cell), ['legacy:94:5', 'legacy:124:0']);
  const off = game.action(player, command('switch-power-off', [5, 1, 6], 1));
  assert.equal(off.status, 200);
  assert.equal(store.getEdit(6, 1, 6).cell, 'legacy:55:0');
  now += 200;
  assert.equal(game.advance().changes[0].cell, 'legacy:93:5');
  assert.equal(store.getEdit(9, 1, 6).cell, 'legacy:124:0');
  now += 200;
  assert.equal(game.advance().changes[0].cell, 'legacy:123:0');
});

test('plate uses actual player overlap, and the handmade trapdoor and lamps preserve metadata', t => {
  const base = fixture([[5, 1, 5, 72, 0], [6, 1, 5, 756, 3], [4, 1, 6, 96, 8], [7, 2, 5, 220, 4]]);
  const store = openStore(':memory:');
  t.after(() => store.close());
  let now = 0;
  const game = gameFor(base, store, () => now);
  const player = store.createPlayer().id;
  game.session(player);
  const entry = game.position(player, {x:5.5, y:1, z:5.1});
  assert.equal(entry.changes[0].cell, 'legacy:72:1');
  assert.equal(entry.effects[0].sound, 'click.on');
  now = 1000;
  assert.deepEqual(game.advance().changes, []);
  game.position(player, {x:5.5, y:1, z:4.65});
  now = 2000;
  assert.equal(game.advance().changes[0].cell, 'legacy:72:0');
  const hatch = game.action(player, command('toggle-trapdoor', [4, 1, 6]));
  assert.equal(hatch.status, 200, JSON.stringify(hatch.output));
  assert.equal(hatch.output.changes[0].cell, 'legacy:96:12');
  const lamp = game.action(player, command('toggle-jammy-lamp', [7, 2, 5]));
  assert.equal(lamp.status, 200, JSON.stringify(lamp.output));
  assert.equal(lamp.output.changes[0].cell, 'legacy:219:4');
  assert.deepEqual(lamp.output.effects, []);
});

test('the actual western iron door opens with the imported wooden button', t => {
  let base;
  try { base = loadBase(fileURLToPath(new URL('../generated/world/', import.meta.url))); }
  catch (error) {
    if (error.code === 'ENOENT') return t.skip('Generated source world required');
    throw error;
  }
  const button = [-90, 66, 39];
  if (base.getCell(...button).key !== 'legacy:143:4') return t.skip('Extended playable district required');
  const store = openStore(':memory:');
  t.after(() => store.close());
  const game = gameFor({...base, manifest: {...base.manifest, spawn: [-88.5, 65, 37.5]}}, store, () => 0);
  const player = store.createPlayer().id;
  game.session(player);
  const press = game.action(player, command('western-door-button', button));
  assert.equal(press.status, 200, JSON.stringify(press.output));
  assert.ok(press.output.changes.some(({x,y,z,cell}) => x === -91 && y === 65 && z === 39 && cell === 'legacy:71:6'));
});

test('placing a connecting wire updates its signal and switches a lamp in the same commit', t => {
  const base = fixture([[5, 1, 6, 69, 13], [6, 0, 6, 123, 0], [0, 1, 0, 55, 0]]);
  const store = openStore(':memory:');
  t.after(() => store.close());
  const game = gameFor(base, store, () => 0);
  const player = store.createPlayer().id;
  game.session(player);
  const result = game.action(player, {
    type: 'place', requestId: 'place-wire-test', cell: 'legacy:55:0', x: 6, y: 1, z: 6,
    against: {x: 6, y: 0, z: 6}, expectedRevision: 0,
  });
  assert.equal(result.status, 200, JSON.stringify(result.output));
  assert.deepEqual(result.output.changes.map(({cell, revision}) => [cell, revision]),
    [['legacy:55:15', 1], ['legacy:124:0', 1]]);
  assert.deepEqual(result.output.effects.map(effect => effect.sound), ['block.place']);
});

test('a gate opens away from a player facing the opposite side', t => {
  const base = fixture([[5, 1, 6, 107, 2]]);
  const store = openStore(':memory:');
  t.after(() => store.close());
  const game = gameFor(base, store, () => 0);
  const player = store.createPlayer().id;
  game.session(player);
  const first = game.action(player, {...command('gate-open-north', [5, 1, 6]), yaw: Math.PI});
  assert.equal(first.status, 200, JSON.stringify(first.output));
  assert.equal(first.output.changes[0].cell, 'legacy:107:4');
  assert.equal(geometry.collisionFor('legacy:107:4').length, 0);
  assert.equal(geometry.collisionFor('legacy:107:2')[0].y1, 1.5);
});

test('a Jammy appliance opens the native door mesh and keeps imported storage', t => {
  let catalogs;
  try {
    const jammy = JSON.parse(readFileSync(new URL('../generated/models/jammy.json', import.meta.url), 'utf8'));
    if (jammy.schemaVersion !== 2) return t.skip('Generate the Jammy open appliance poses first');
    catalogs = {jammy};
  } catch (error) {
    if (error.code === 'ENOENT') return t.skip('Generated Jammy models required');
    throw error;
  }
  const base = fixture([[5, 1, 6, 205, 1]]);
  const object = {key: 'tile:5:1:6', position: [5,1,6], type: 'TileEntityIronBlocksOne',
    data: {Items: [{Slot: 1, id: 260, Count: 1}]}};
  const getCell = base.getCell;
  base.getCell = (x, y, z) => ({...getCell(x, y, z), object: x === 5 && y === 1 && z === 6 ? object : null});
  const store = openStore(':memory:');
  t.after(() => store.close());
  const game = gameFor(base, store, () => 0);
  const player = store.createPlayer().id;
  game.session(player);
  const start = extractedModel(catalogs, {key: 'legacy:205:1', object});
  const opened = game.action(player, command('appliance-open-test', [5, 1, 6]));
  assert.equal(opened.status, 200, JSON.stringify(opened.output));
  assert.equal(opened.output.effects[0].sound, 'chest.open');
  const shown = opened.output.changes[0].object;
  assert.deepEqual(shown.data, {open: true});
  const after = extractedModel(catalogs, {key: 'legacy:205:1', object: shown});
  assert.notDeepEqual(after.surfaces, start.surfaces);
  assert.deepEqual(after.collision, start.collision);
  assert.deepEqual(store.getEdit(5, 1, 6).object.data.Items, object.data.Items);
  const close = game.action(player, command('appliance-close-test', [5, 1, 6], 1));
  assert.equal(close.output.changes[0].object.data.open, false);
  assert.equal(close.output.effects[0].sound, 'chest.close');
});
