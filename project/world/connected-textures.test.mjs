import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CTM_START, glassTexture, paneTexture } from './connected-textures.mjs';

const block = 'legacy:20:0';
const pane = 'legacy:102:0';

function neighborhood(entries) {
  const cells = new Map(entries);
  return (x, y, z) => cells.get(`${x},${y},${z}`);
}

test('block glass removes only matching adjacent edges in the face plane', () => {
  const neighbors = neighborhood([
    ['1,0,0', block],
    ['0,1,0', {key: block}],
    ['0,-1,0', 'legacy:20:1'],
    ['0,0,1', block],
  ]);
  assert.equal(glassTexture(5, neighbors), CTM_START + 49);
  assert.equal(glassTexture(4, neighbors), CTM_START + 51);
  assert.equal(glassTexture(3, neighbors), CTM_START + 17);
  assert.equal(glassTexture(3, neighbors, 1), CTM_START);
});

test('a block glass panel uses its interior tile even with missing diagonals', () => {
  const neighbors = neighborhood([
    ['-1,0,0', block],
    ['1,0,0', block],
    ['0,-1,0', block],
    ['0,1,0', block],
  ]);
  assert.equal(glassTexture(5, neighbors), CTM_START + 34);
});

test('pane CTM connects pane IDs and reverses side columns for the back face', () => {
  const neighbors = neighborhood([
    ['1,0,0', pane],
    ['0,-1,0', 'legacy:102:2'],
    ['0,0,-1', {key: pane}],
    ['0,0,1', block],
  ]);
  assert.equal(paneTexture(5, neighbors), CTM_START + 17);
  assert.equal(paneTexture(4, neighbors), CTM_START + 19);
  assert.equal(paneTexture(0, neighbors), CTM_START + 19);
  assert.equal(paneTexture(1, neighbors), CTM_START + 17);
  assert.equal(paneTexture(3, neighbors), null);
});
