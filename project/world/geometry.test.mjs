import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ATLAS_GRID, collisionFor, shapeFor, signFor, tiles } from './geometry.mjs';

const aabb = box => [box.x0, box.y0, box.z0, box.x1, box.y1, box.z1];
const inside = (box, [x, y, z]) => x > box.x0 && x < box.x1
  && y > box.y0 && y < box.y1 && z > box.z0 && z < box.z1;

test('slabs and the four stair headings use their legacy metadata', () => {
  assert.deepEqual(aabb(shapeFor('legacy:44:0')[0]), [0, 0, 0, 1, 0.5, 1]);
  assert.deepEqual(aabb(shapeFor('legacy:44:8')[0]), [0, 0.5, 0, 1, 1, 1]);
  const expected = [
    [0.5, 0.5, 0, 1, 1, 1], [0, 0.5, 0, 0.5, 1, 1],
    [0, 0.5, 0.5, 1, 1, 1], [0, 0.5, 0, 1, 1, 0.5],
  ];
  for (let meta = 0; meta < expected.length; meta++) {
    assert.deepEqual(aabb(collisionFor('legacy:109:' + meta)[1]), expected[meta]);
  }
  const upsideDown = collisionFor('legacy:109:4');
  assert.deepEqual(aabb(upsideDown[0]), [0, 0.5, 0, 1, 1, 1]);
  assert.deepEqual(aabb(upsideDown[1]), [0.5, 0, 0, 1, 0.5, 1]);
  const outsideCorner = collisionFor('legacy:109:0', (x, y, z) => x === 1 ? 'legacy:109:2' : 'air');
  assert.deepEqual(aabb(outsideCorner[1]), [0.5, 0.5, 0.5, 1, 1, 1]);
});

test('RedPower hollow cover is physically open and retains multiple materials', () => {
  const cell = { key: 'cover:750:0:fixture', parts: [
    { slot: 2, material: 28, shape: 3 },
    { slot: 6, material: 7, shape: 0 },
    { slot: 26, material: 3, shape: 0 },
  ] };
  const result = collisionFor(cell);
  assert.equal(result.some(box => inside(box, [0.5, 0.5, 0.0625])), false);
  assert.equal(result.some(box => inside(box, [0.125, 0.5, 0.0625])), true);
  assert.equal(result.some(box => inside(box, [0.5, 0.5, 0.5])), true);
  assert.deepEqual([...new Set(result.flatMap(box => box.faces))].sort(), [176, 192, 198, 208]);
  const glassCover = shapeFor({ key: 'cover:750:0:glass', parts: [{ slot: 5, material: 7, shape: 2 }] })[0];
  assert.equal(glassCover.mode, 'cutout');
  assert.deepEqual(aabb(glassCover), [0.5, 0, 0, 1, 1, 1]);
  assert.equal(shapeFor('cover-material:28')[0].faces[0], 198);
});

test('frame is pickable and full collision; clouds use their source collision height', () => {
  const frame = { key: 'cover:765:0:fixture', parts: [] };
  assert.equal(shapeFor(frame).length, 6);
  assert.deepEqual(aabb(collisionFor(frame)[0]), [0, 0, 0, 1, 1, 1]);
  assert.equal(collisionFor('legacy:3246:0')[0].y1, 1);
  assert.equal(collisionFor('legacy:3246:1')[0].y1, 1);
  assert.equal(collisionFor('legacy:3246:2')[0].y1, 0.5);
  assert.equal(shapeFor('legacy:756:0')[0].emissive, true);
  assert.equal(shapeFor('legacy:757:0')[0].emissive, false);
  assert.equal(shapeFor('legacy:219:0').some(box => box.emissive), true);
  assert.equal(shapeFor('legacy:220:0').some(box => box.emissive), false);
});

test('read source chair, bookshelf and Russian sign across negative chunk coordinates', t => {
  const root = new URL('../generated/world/', import.meta.url);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(new URL('world.json', root), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return t.skip('Run the Anvil import to verify real district coordinates');
  }
  function at([x, y, z]) {
    const chunkFile = Math.floor(x / 16) + '.' + Math.floor(z / 16) + '.json';
    const chunk = JSON.parse(readFileSync(new URL('chunks/' + chunkFile, root)));
    const section = chunk.sections.find(section => section.y === Math.floor(y / 16));
    const index = (x & 15) + 16 * (z & 15) + 256 * (y & 15);
    const key = manifest.palette[Buffer.from(section.indices, 'base64').readUInt16LE(index * 2)];
    const object = chunk.objects.find(object => object.position.every((coordinate, i) => coordinate === [x, y, z][i]));
    return { key, object, ...manifest.compositions[key] };
  }
  const chair = at([-34, 65, -61]);
  assert.equal(chair.key, 'legacy:213:0');
  assert.equal(chair.object.type, 'TileEntityArmChair');
  assert.equal(shapeFor(chair).length, 11);
  assert.ok(shapeFor(chair).every(box => box.faces.every(tile => tile >= tiles.armchair && tile < tiles.bookcase)));
  assert.equal(shapeFor(chair).some(box => inside(box, [0.5, 0.6, 0.5])), false);
  assert.equal(shapeFor(chair).some(box => inside(box, [0.5, 0.6, 0.9])), true);
  const bookcase = at([-59, 76, -50]);
  assert.equal(bookcase.key, 'legacy:2250:1');
  assert.equal(bookcase.object.type, 'BookcaseTile');
  assert.equal(shapeFor(bookcase).length, 6);
  const cell = at([-54, 70, -49]);
  assert.equal(cell.key, 'legacy:68:2');
  const sign = signFor(cell);
  assert.deepEqual(sign.lines, [cell.object.data.Text1, cell.object.data.Text2, cell.object.data.Text3, cell.object.data.Text4]);
  assert.match(sign.lines.join(' '), /\p{Script=Cyrillic}/u);
  assert.ok(sign.z < shapeFor(cell)[0].z0);
  assert.ok(shapeFor(cell)[0].faces.every(tile => tile < ATLAS_GRID ** 2));
});
