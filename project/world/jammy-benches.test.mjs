import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as geometry from './geometry.mjs';
import { extractedModel, placementModelObject, withExtractedModels } from './extracted-models.mjs';

test('captured chair joins as a bench in four directions, with straight seats and restored ends', t => {
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(new URL('../generated/models/jammy.json', import.meta.url)));
  } catch (error) {
    if (error.code === 'ENOENT') return t.skip('Generate the Jammy catalog from the supplied client');
    throw error;
  }
  const models = {jammy:catalog};
  const shared = withExtractedModels(geometry, models);
  const chair = 'legacy:203:0';
  for (let turns = 0; turns < 4; turns++) {
    const raw = catalog.models[`legacy:203:${turns}`];
    const cell = {key:chair, object:placementModelObject(models, chair, null, [1, 4, 6], turns)};
    const alongX = (turns & 1) === 0;
    const axis = alongX ? 0 : 2;
    const adjacent = new Map();
    const neighbors = (dx, dy, dz) => dy === 0 && (alongX ? dz === 0 : dx === 0) && adjacent.get(alongX ? dx : dz);
    const model = () => extractedModel(models, cell, neighbors);
    const connected = side => ({key:chair, object:placementModelObject(models, chair, null, [1 + side, 4, 6], turns)});
    assert.equal(model().surfaces, raw.surfaces);
    adjacent.set(1, {key:`legacy:203:${(turns + 1) & 3}`});
    assert.equal(model().surfaces, raw.surfaces);
    adjacent.set(1, connected(1));
    const edgeName = alongX ? 'x1' : 'z1';
    assert.equal(shared.selectionFor(cell, neighbors)[0][edgeName], 1);
    assert.equal(model().surfaces.length, 34);
    assert.deepEqual(model().surfaces.slice(0, 24), raw.surfaces.slice(0, 24));
    adjacent.set(-1, connected(-1));
    const mainBoard = model().surfaces.slice(24, 28);
    assert.equal(model().surfaces.length, 32);
    assert.ok(mainBoard.flatMap(({positions}) => positions.filter((_, i) => i % 3 === axis)).every(n => n === 0 || n === 1));
    assert.deepEqual(shared.collisionFor(cell, neighbors), raw.collision);
    adjacent.clear();
    assert.equal(model().surfaces, raw.surfaces);
  }
});
