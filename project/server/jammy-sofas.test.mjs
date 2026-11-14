import assert from 'node:assert/strict';
import {test} from 'node:test';
import {World} from '../client/world-data.mjs';
import * as baseGeometry from '../world/geometry.mjs';
import {extractedModel, withExtractedModels} from '../world/extracted-models.mjs';
import {createGame} from './game.mjs';
import {openStore} from './store.mjs';

test('placing and removing owned Jammy seats updates the browser assembly and preserves original seats', t => {
  const source = 'legacy:216:0';
  const floor = 'legacy:1:0';
  const palette = ['air', floor, source];
  const bounds = {minX: 0, minY: 0, minZ: 0, maxX: 15, maxY: 15, maxZ: 15};
  const manifest = {spawn: [6.5, 1, 3.5], bounds, compositions: {}, palette};
  const original = {key: 'tile:3:1:6', position: [3, 1, 6], type: 'TileEntitySofaCenter', data: {}};
  const base = {
    hash: 'jammy-sofa-fixture', manifest, catalog: new Set(palette),
    inBounds: (x, y, z) => [x, y, z].every(value => value >= 0 && value <= 15),
    getCell: (x, y, z) => x === 3 && y === 1 && z === 6 ? {key: source, object: original} :
      {key: y === 0 ? floor : 'air', object: null},
  };
  const box = {x0: .05, y0: 0, z0: .1, x1: .95, y1: 1, z1: .9};
  const sofaIds = {chair: 213, left: 214, right: 215, center: 216, corner: 217};
  const models = Object.fromEntries(Object.entries(sofaIds).map(([role, id]) =>
    [`legacy:${id}:0`, {selection: [box], collision: [box], surfaces: [role]}]));
  models['legacy:213:1'] = {selection: [box], collision: [box], surfaces: ['chair turned']};
  const catalogs = {jammy: {sofaIds, models}};
  const geometry = withExtractedModels(baseGeometry, catalogs);
  const store = openStore(':memory:');
  t.after(() => store.close());
  const game = createGame(base, store, geometry, {modules: []});
  const player = store.createPlayer().id;
  game.session(player);

  const browser = new World(manifest);
  const indices = Buffer.alloc(8192);
  for (let offset = 0; offset < 256; offset++) indices.writeUInt16LE(1, 2 * offset);
  indices.writeUInt16LE(2, 2 * (3 + 6 * 16 + 256));
  browser.addChunk({x: 0, z: 0, sections: [{y: 0, indices: indices.toString('base64')}], objects: [original]});
  const role = x => extractedModel(catalogs, browser.cellAt(x, 1, 6), (dx, dy, dz) => browser.cellAt(x + dx, 1 + dy, 6 + dz))?.surfaces[0];

  function action(type, x, expectedRevision, extras) {
    const result = game.action(player, {type, requestId: `jammy-${type}-${x}`, x, y: 1, z: 6, expectedRevision, ...extras});
    assert.equal(result.status, 200, JSON.stringify(result.output));
    for (const change of result.output.changes) browser.setOverride(change);
    return result.output;
  }
  const copied = action('copy', 3, 0);
  const place = x => action('place', x, 0, {cell: copied.cell, against: {x, y: 0, z: 6},
    hit: {x: x + .5, y: 1, z: 6.5}}).changes[0];
  const first = place(5);
  assert.deepEqual(first.object, {type: 'JammySofa', position: [5, 1, 6], key: 'tile:5:1:6', data: {}});
  assert.equal(role(5), 'chair');
  place(6);
  assert.deepEqual([role(5), role(6)], ['right', 'left']);
  const third = place(7);
  assert.deepEqual([role(5), role(6), role(7)], ['right', 'center', 'left']);
  action('remove', 7, third.revision);
  assert.deepEqual([role(3), role(5), role(6), role(7)], ['center', 'right', 'left', undefined]);
  const rotated = action('place', 7, 4, {cell: copied.cell, turns: 1, against: {x: 7, y: 0, z: 6},
    hit: {x: 7.5, y: 1, z: 6.5}, requestId: 'jammy-rotate-seat'}).changes[0];
  assert.equal(rotated.cell, source);
  assert.equal(rotated.object.data.rotation, 1);
  assert.equal(role(6), 'left');
  assert.equal(role(7), 'chair turned');
  assert.equal(game.snapshot(player).overrides.find(change => change.x === 5).object.type, 'JammySofa');
  const protectedOriginal = game.action(player, {type: 'remove', requestId: 'remove-original-sofa', x: 3, y: 1, z: 6, expectedRevision: 0});
  assert.equal(protectedOriginal.output.error, 'block_not_owned');
});
