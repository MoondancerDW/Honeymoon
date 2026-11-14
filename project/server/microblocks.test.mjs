import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import * as geometry from '../world/geometry.mjs';
import {guidedMicroblock, microblockKey} from '../world/microblocks.mjs';
import {voxelIndex, voxelMaterialAt} from '../world/voxel-chisel.mjs';
import {createHoneymoonServer} from './index.mjs';

const originalKey = 'cover:750:0:original-panel';
const floor = {slot: 0, shape: 0, material: 2};
const roof = {slot: 1, shape: 0, material: 5};
const bar = {slot: 28, shape: 0, material: 6};
const height = {floor: 1.125, roof: 2, bar: 1.5};
const bounds = {minX: 0, maxX: 15, minY: 0, maxY: 15, minZ: 0, maxZ: 15};
const compositions = {[originalKey]: {parts: [floor]}};
const point = (x, y, z) => ({x, y, z});

function fixture(hash = 'test-microblocks', authored = true) {
  return {
    manifest: {bounds, spawn: [8.5, 1, 8.5], compositions}, hash,
    catalog: new Set(['legacy:1:0', 'legacy:20:0', originalKey]),
    inBounds(x, y, z) { return x >= 0 && x <= 15 && y >= 0 && y <= 15 && z >= 0 && z <= 15; },
    getCell(x, y, z) {
      const key = y === 0 ? 'legacy:1:0' : authored && x === 8 && y === 1 && z === 10 ? originalKey : 'air';
      return {key, object: null};
    },
  };
}

async function start(base, state, allowRemoval) {
  const app = createHoneymoonServer({base, geometry, state, allowRemoval});
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api/`;
  return {
    ...app,
    async request(path, payload, cookie) {
      const response = await fetch(url + path, {method: payload === undefined ? 'GET' : 'POST',
        headers: {...(cookie && {Cookie: cookie}), 'Content-Type': 'application/json'},
        body: payload === undefined ? undefined : JSON.stringify(payload)});
      const nextCookie = response.headers.get('set-cookie')?.split(';')[0];
      return {status: response.status, body: await response.json(), ...(nextCookie && {cookie: nextCookie})};
    },
  };
}

function command(type, requestId, coordinates, expectedRevision, extra = {}) {
  return {type, requestId, ...coordinates, expectedRevision, ...extra};
}

function originalPart(type, requestId, revision = 0, partSlot = 0) {
  return command(type, requestId, point(8, 1, 10), revision, {
    partSlot, hit: point(8.5, height.floor, 10.5),
  });
}

function workspace(t, base = fixture()) {
  const work = fileURLToPath(new URL('../work/', import.meta.url));
  mkdirSync(work, {recursive: true});
  const directory = mkdtempSync(join(work, 'test-microblocks-'));
  const state = join(directory, 'state.sqlite');
  let app;
  t.after(async () => {
    if (app) await app.close();
    rmSync(directory, {recursive: true, force: true});
  });
  return async (nextBase = base, allowRemoval = false) => {
    if (app) await app.close();
    app = await start(nextBase, state, allowRemoval);
    return app;
  };
}

test('individual RedPower edits preserve originals and ownership through retries, races and restart', async t => {
  const restart = workspace(t);
  let app = await restart();
  const userA = (await app.request('session', {})).cookie;
  const userB = (await app.request('session', {})).cookie;
  const edit = (player, data) => app.request('action', data, player);
  const cell = point(8, 1, 10);
  const copied = await edit(userA, originalPart('copy_part', 'copy-original'));
  assert.equal(copied.status, 200);
  assert.deepEqual(copied.body.part, floor);
  assert.deepEqual(await edit(userA, originalPart('remove_part', 'remove-original')), {
    status: 403, body: {error: 'part_not_owned'},
  });

  const placeA = command('place_part', 'add-own-roof', cell, 0, {
    part: roof, against: {...cell, partSlot: 0}, hit: point(8.5, height.floor, 10.5),
  });
  const placeB = command('place_part', 'add-own-bar-racing', cell, 0, {
    part: bar, against: {...cell, partSlot: 0}, hit: point(8.5, height.floor, 10.5),
  });
  const race = await Promise.all([edit(userA, placeA), edit(userB, placeB)]);
  assert.deepEqual(race.map(result => result.status).sort(), [200, 409]);
  const firstAction = race[0].status === 200 ? placeA : placeB;
  const firstPlayer = race[0].status === 200 ? userA : userB;
  const first = race.find(result => result.status === 200);
  assert.deepEqual(await edit(firstPlayer, firstAction), first);
  assert.equal(race.find(result => result.status === 409).body.error, 'stale_cell');
  const next = race[0].status === 200 ? placeB : placeA;
  const nextPlayer = race[0].status === 200 ? userB : userA;
  const installed = await edit(nextPlayer, {...next, requestId: 'second-part-current', expectedRevision: first.body.worldRevision,
    // The bar hides the center of the floor when the first edit hits at z=10.5.
    hit: point(8.85, height.floor, 10.25)});
  assert.equal(installed.status, 200, JSON.stringify(installed.body));
  const revision = installed.body.worldRevision;
  assert.deepEqual(installed.body.changes, [{...cell, cell: microblockKey, object: null, revision, parts: [floor, roof, bar]}]);

  const fakeHit = await edit(userA, {...originalPart('copy_part', 'copy-hidden', revision), hit: point(8.5, height.roof, 10.5)});
  assert.deepEqual(fakeHit, {status: 403, body: {error: 'outside_reach'}});
  const wholeCopy = await edit(userA, command('copy', 'copy-whole-mixed', cell, revision));
  assert.deepEqual(wholeCopy, {status: 409, body: {error: 'part_required'}});
  const wholeRemove = await edit(userA, command('remove', 'remove-whole-mixed', cell, revision));
  assert.deepEqual(wholeRemove, {status: 409, body: {error: 'part_required'}});
  const overlap = await edit(userA, {...placeA, requestId: 'duplicate-roof-slot', expectedRevision: revision,
    hit: point(8.85, height.floor, 10.25)});
  assert.deepEqual(overlap, {status: 409, body: {error: 'incompatible_part'}});

  app = await restart();
  const snapshot = await app.request('world', undefined, userA);
  assert.deepEqual(snapshot.body.overrides.find(change => change.x === 8 && change.z === 10), installed.body.changes[0]);
  const removeBar = command('remove_part', 'remove-others-bar', cell, revision, {
    partSlot: bar.slot, hit: point(8.5, 1.61, 10.375),
  });
  assert.deepEqual(await edit(userA, removeBar), {status: 403, body: {error: 'part_not_owned'}});
  const removed = await edit(userB, removeBar);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.deepEqual(removed.body.changes[0].parts, [floor, roof]);
  assert.deepEqual(await edit(userA, originalPart('remove_part', 'remove-source-again', removed.body.worldRevision)), {
    status: 403, body: {error: 'part_not_owned'},
  });

  app = await restart(fixture('changed-microblock-base', false));
  const rebased = await app.request('world', undefined, userA);
  assert.equal(rebased.body.overrides.some(change => change.x === 8 && change.z === 10), false);
  assert.equal(app.game.conflicts.find(conflict => conflict.x === 8 && conflict.z === 10)?.reason, 'original_cell_changed');
});

test('last player detail returns the cell to air and retains its revision', async t => {
  const restart = workspace(t, fixture('test-microblocks-empty', false));
  let app = await restart();
  const player = (await app.request('session', {})).cookie;
  const cell = point(8, 1, 10);
  const put = command('place_part', 'place-floor-piece', cell, 0, {
    part: floor, against: point(8, 0, 10), hit: point(8.5, 1, 10.5),
  });
  const placed = await app.request('action', put, player);
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  const removed = await app.request('action', originalPart('remove_part', 'remove-floor-piece', placed.body.worldRevision), player);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.deepEqual(removed.body.changes, [{...cell, cell: null, object: null, revision: removed.body.worldRevision, parts: []}]);
  const stale = await app.request('action', {...put, requestId: 'place-after-retired'}, player);
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.current, removed.body.changes[0]);
  app = await restart(fixture('test-microblocks-new-origin'));
  const snapshot = await app.request('world', undefined, player);
  assert.equal(snapshot.body.overrides.some(change => change.x === 8 && change.z === 10), false);
});

test('an older owned Cover assembly lazily splits into individual parts', async t => {
  const base = fixture('legacy-owned-parts', false);
  const edge = {slot: 14, shape: 3, material: 3};
  const recipe = 'cover:750:0:owned-panel-edge';
  base.catalog.add(recipe);
  base.manifest = {...base.manifest, compositions: {...compositions, [recipe]: {parts: [floor, edge]}}};
  const restart = workspace(t, base);
  let app = await restart(base, true);
  const player = (await app.request('session', {})).cookie;
  const cell = point(8, 1, 10);
  const installed = await app.request('action', command('place', 'legacy-cover-assembly', cell, 0, {
    cell: recipe, against: point(8, 0, 10), hit: point(8.75, 1, 10.75),
  }), player);
  assert.equal(installed.status, 200, JSON.stringify(installed.body));
  app = await restart();
  const removed = await app.request('action', {...originalPart('remove_part', 'legacy-owned-panel', installed.body.worldRevision),
    hit: point(8.5, height.floor, 10.9)}, player);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.deepEqual(removed.body.changes[0].parts, [edge]);
});

test('puts exact copies and chisel materials in one imported cell and preserves ownership after restart', async t => {
  const restart = workspace(t);
  let app = await restart();
  const userA = (await app.request('session', {})).cookie;
  const userB = (await app.request('session', {})).cookie;
  const edit = (player, data) => app.request('action', data, player);
  const at = point(8,1,10);
  const source = await edit(userA, originalPart('copy_part', 'guided-copy-panel'));
  const {part: copied, pattern} = source.body;
  assert.deepEqual(pattern, [[0,0,0,8,1,8]]);
  const place = (height, slot, anchor, revision) => {
    const hit = point(8.5,height,10.5);
    const proposal = guidedMicroblock({...at, partSlot:anchor, hit, offset:[0,1,0]}, {...copied,slot}, pattern, 0);
    // Preserve the kind from the copied part while assigning a new independent placement ID.
    proposal.part.sourceSlot = copied.slot;
    return command('place_part', `guided-placement-${slot}`, at, revision, {...proposal,hit});
  };
  const put = place(height.floor,29,0,0);
  const invalid = structuredClone(put);
  invalid.requestId = 'guided-tampered-box';
  invalid.part.bounds[0][1]++;
  invalid.part.bounds[0][4]++;
  assert.equal((await edit(userA,invalid)).body.error,'outside_reach');
  const placed = await edit(userA,put);
  assert.equal(placed.status,200,JSON.stringify(placed.body));
  const stacked = await edit(userA,place(1.25,30,29,placed.body.worldRevision));
  assert.equal(stacked.status,200,JSON.stringify(stacked.body));
  assert.equal(stacked.body.changes[0].parts[2].bounds[0][1],2);
  const hit = point(8.4375,1.375,10.4375);
  const voxel = voxelIndex(3,3,3);
  const chisel = command('place_voxel','guided-place-glass',at,stacked.body.worldRevision,
    {material:'legacy:20:0', against:{...at,partSlot:30}, voxel, hit});
  const mixed = await edit(userB,chisel);
  assert.equal(mixed.status,200,JSON.stringify(mixed.body));
  assert.equal(voxelMaterialAt(mixed.body.changes[0].voxels,voxel),'legacy:20:0');
  assert.equal(mixed.body.changes[0].parts.length,3);

  app = await restart(fixture('guided-parts-reimported'));
  const {body:world} = await app.request('world',undefined,userA);
  const saved = world.overrides.find(change => change.x === at.x && change.y === at.y && change.z === at.z);
  assert.deepEqual(saved,mixed.body.changes[0]);
  const removeGlass = command('remove_voxel','guided-remove-glass',at,saved.revision,{voxel, hit:{...hit,y:1.5}});
  assert.equal((await edit(userA,removeGlass)).body.error,'voxel_not_owned');
  const removed = await edit(userB,removeGlass);
  assert.equal(removed.status,200,JSON.stringify(removed.body));
  assert.equal(removed.body.changes[0].voxels,undefined);
  assert.equal(removed.body.changes[0].parts.length,3);
  const removeStack = command('remove_part','guided-remove-panel-30',at,removed.body.worldRevision,{partSlot:30,hit});
  assert.equal((await edit(userB,removeStack)).body.error,'part_not_owned');
  assert.equal((await edit(userA,removeStack)).status,200);
});
