import assert from 'node:assert/strict';
import {test} from 'node:test';
import {displayObject} from '../server/base.mjs';
import {biblioFor} from './biblio-models.mjs';

const surface = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  uv: [0, 0, 1, 0, 1, 1, 0, 1],
};

test('BiblioCraft uses its saved heading for both the mesh and the source bounds', () => {
  const catalog = {models: {'legacy:2250:1': {surfaces: [surface], groups: {bottom1: [surface]}}}};
  const result = biblioFor(catalog, 2250, 1, {bookcaseAngle: 0, filledBottomSlots: 1});
  assert.equal(result.surfaces.length, 2);
  assert.deepEqual(result.surfaces[0].positions, [1, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 0]);
  assert.deepEqual(result.surfaces[0].uv, surface.uv);
  assert.deepEqual(result.collision, [{x0: .5, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1}]);
  assert.deepEqual(result.selection, result.collision);
});

test('BiblioCraft sends visible item slots and armor color without exposing item tags', () => {
  const item = {id: 298, Slot: 0, Count: 1, tag: {display: {color: 5000268, Name: 'hidden'}, author: 'hidden'}};
  const stand = displayObject({type: 'ArmorStandTile', data: {StandInventory: [item, {...item, Slot: 12}], Inventory: [item]}});
  assert.deepEqual(stand.data, {StandInventory: [{id: 298, Damage: 0, Slot: 0, tag: {display: {color: 5000268}}}]});
  const shelf = displayObject({type: 'GenericShelfTile', data: {genericShelfAngle: 2, ShelfInventory: [item]}});
  assert.deepEqual(shelf.data, {genericShelfAngle: 2, ShelfInventory: [{id: 298, Damage: 0, Slot: 0}]});
});
