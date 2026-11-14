import assert from 'node:assert/strict';
import {test} from 'node:test';
import {extractedModel, placementModelObject, withExtractedModels} from './extracted-models.mjs';

const sofaIds = {chair: 313, left: 314, right: 315, center: 316, corner: 317};
const key = (role, meta) => `legacy:${sofaIds[role]}:${meta}`;
const models = {};
for (const role of Object.keys(sofaIds)) {
  for (let meta = 0; meta < 16; meta++) {
    const variant = key(role, meta);
    models[variant] = {surfaces: [variant], collision: [variant], selection: [variant]};
  }
}
const catalogs = {jammy: {sofaIds, models}};
const directions = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const side = value => directions[value & 3].join(',');

function placed(role, meta) {
  const variant = key(role, meta);
  return {key: variant, object: placementModelObject(catalogs, variant, null, [1, 2, 3])};
}

test('placed Jammy sofas choose matching seats in every color and rotation', () => {
  const geometry = withExtractedModels({}, catalogs);
  for (let meta = 0; meta < 16; meta++) {
    const end = placed('left', meta);
    const connected = new Map();
    const neighbors = (dx, dy, dz) => connected.get(`${dx},${dz}`);
    const surface = () => extractedModel(catalogs, end, neighbors).surfaces[0];
    assert.equal(surface(), key('chair', meta));
    connected.set(side(meta), placed('center', meta ^ 4));
    assert.equal(surface(), key('chair', meta));
    connected.set(side(meta), placed('center', meta));
    assert.equal(surface(), key('right', meta));
    connected.set(side(meta + 2), placed('right', meta));
    assert.equal(surface(), key('center', meta));
    assert.deepEqual(geometry.collisionFor(end, neighbors), [key('center', meta)]);
    assert.deepEqual(geometry.selectionFor(end, neighbors), [key('center', meta)]);
    connected.delete(side(meta));
    assert.equal(surface(), key('left', meta));
    connected.delete(side(meta + 2));
    assert.equal(surface(), key('chair', meta));
  }
});

test('corner opens both wings and reorients the remaining seat when a wing is removed', () => {
  for (let meta = 0; meta < 16; meta++) {
    const corner = placed('corner', meta);
    const turn = (meta & 12) | ((meta + 1) & 3);
    const forward = placed('center', meta);
    const wing = placed('center', turn);
    const connected = new Map([[side(meta), forward], [side(meta + 3), wing]]);
    const neighbors = (dx, dy, dz) => connected.get(`${dx},${dz}`);
    const surface = () => extractedModel(catalogs, corner, neighbors).surfaces[0];
    assert.equal(surface(), key('corner', meta));
    const forwardSurface = extractedModel(catalogs, forward, (dx, dy, dz) =>
      `${dx},${dz}` === side(meta + 2) ? corner : null).surfaces[0];
    const wingSurface = extractedModel(catalogs, wing, (dx, dy, dz) =>
      `${dx},${dz}` === side(meta + 1) ? corner : null).surfaces[0];
    assert.equal(forwardSurface, key('left', meta));
    assert.equal(wingSurface, key('right', turn));
    connected.delete(side(meta));
    assert.equal(surface(), key('left', turn));
    connected.delete(side(meta + 3));
    assert.equal(surface(), key('chair', meta));
  }
});

test('saved sofas retain their authored models until an adjacent new section changes the layout', () => {
  const saved = {key: key('left', 0), object: {type: 'TileEntitySofaLeft'}};
  const copied = placed('center', 0);
  assert.equal(extractedModel(catalogs, saved, () => null).surfaces[0], saved.key);
  assert.equal(extractedModel(catalogs, saved, dx => dx === 1 ? copied : null).surfaces[0], key('right', 0));
  assert.equal(extractedModel(catalogs, copied, (dx, dy, dz) => dx === 1 && dz === 0 ? saved : null).surfaces[0], key('right', 0));
  assert.equal(extractedModel(catalogs, copied, (dx, dy, dz) => dx === -1 && dz === 0 ? saved : null).surfaces[0], key('left', 0));
  assert.equal(placementModelObject(catalogs, key('chair', 0), null, [1, 2, 3]).type, 'JammySofa');
});
