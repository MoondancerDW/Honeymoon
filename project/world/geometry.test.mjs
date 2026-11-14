import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { displayObject } from '../server/base.mjs';
import { ATLAS_GRID, collisionFor, redPowerWireMesh, shapeFor, signFor, standingSignMesh, tiles } from './geometry.mjs';

const aabb = box => [box.x0, box.y0, box.z0, box.x1, box.y1, box.z1];
const inside = (box, [x, y, z]) => x > box.x0 && x < box.x1
  && y > box.y0 && y < box.y1 && z > box.z0 && z < box.z1;

test('cake keeps its half-block model and a 7/16 collision top at every bite', () => {
  for (let bites = 0; bites < 6; bites++) {
    const key = `legacy:92:${bites}`;
    assert.deepEqual(aabb(shapeFor(key)[0]), [(1 + bites * 2) / 16, 0, 1 / 16, 15 / 16, 1 / 2, 15 / 16]);
    assert.deepEqual(aabb(collisionFor(key)[0]), [(1 + bites * 2) / 16, 0, 1 / 16, 15 / 16, 7 / 16, 15 / 16]);
  }
});

test('standing sign board and text share the original sixteen-way heading', () => {
  const sign = 'legacy:63:6';
  const [board, post] = standingSignMesh(sign);
  assert.equal(board.angle, -3 * Math.PI / 4);
  assert.equal(signFor(sign).rotation, board.angle);
  assert.equal(board.y0, 7 / 12);
  assert.equal(board.y1, 13 / 12);
  assert.equal(post.y1, board.y0);
  assert.deepEqual(aabb(shapeFor(sign)[0]), [.25, 0, .25, .75, 1, .75]);
  assert.deepEqual(collisionFor(sign), []);
});

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

test('RedPower flat wires have no collision and center posts use the original half-block cube', () => {
  const parts = [{ slot: 3, material: 20, shape: 0 }, { slot: 4, material: 20, shape: 0 }];
  const key = 'cover:750:1:fixture';
  const wire = cons => ({ key, parts, object: displayObject({ type: 'Redwire', data: { cons } }) });
  const covers = collisionFor({ key: 'cover:750:0:fixture', parts });
  assert.deepEqual(collisionFor(wire(1)).map(aabb), covers.map(aabb));
  assert.deepEqual(collisionFor(wire(64)).map(aabb), [...covers.map(aabb), [.25, .25, .25, .75, .75, .75]]);
  assert.ok(shapeFor(wire(1)).length > covers.length);
  for (const meta of [1, 2, 3, 5]) {
    assert.deepEqual(collisionFor({ key: `legacy:750:${meta}`, data: { cons: 63 } }), []);
    assert.deepEqual(collisionFor({ key: `legacy:750:${meta}`, data: { cons: 65 } }).map(aabb),
      [[.25, .25, .25, .75, .75, .75]]);
  }
});

test('RedPower jacketed street light uses the silver wire cover and original post collision', () => {
  const object = displayObject({ type: 'Redwire', data: { cons: 64, post: 66, pwr: 0 } });
  const cell = { key: 'legacy:750:1', object };
  const lamp = { key: 'legacy:768:0', data: { rot: 0 } };
  const adjacent = (x, y, z) => y > 0 ? lamp : y < 0 ? cell : 'air';
  const [post] = redPowerWireMesh(cell, adjacent);
  assert.deepEqual(aabb(post), [.25, 0, .25, .75, 1, .75]);
  assert.deepEqual(post.faces, [339, 339, 1797, 1797, 339, 339]);
  assert.deepEqual(collisionFor(cell, adjacent).map(aabb), [[.25, .25, .25, .75, .75, .75]]);
});

test('RedPower buffer chest has source face tiles and a full collision cube', () => {
  const chest = rot => ({ key: 'legacy:751:2', object: displayObject({ type: 'RPBuffer', data: { rot } }) });
  assert.deepEqual(shapeFor(chest(0))[0].faces, [600, 600, 599, 601, 600, 600]);
  const [upsideDown] = shapeFor(chest(1));
  assert.deepEqual(upsideDown.faces, [600, 600, 601, 599, 600, 600]);
  assert.deepEqual(upsideDown.redPowerUv, [3, 3, 3, 3, 3, 3]);
  assert.deepEqual(collisionFor(chest(1)).map(aabb), [[0, 0, 0, 1, 1, 1]]);
});

test('door halves use the legacy panels, hinge and inset edge UVs', () => {
  const lower = shapeFor('legacy:64:3', () => 'legacy:64:8')[0];
  const upper = shapeFor('legacy:64:8', () => 'legacy:64:3')[0];
  const open = shapeFor('legacy:64:8', () => 'legacy:64:7')[0];
  assert.deepEqual(aabb(lower), [0, 0, 0.8125, 1, 1, 1]);
  assert.deepEqual(aabb(upper), aabb(lower));
  assert.deepEqual(aabb(open), [0, 0, 0, 0.1875, 1, 1]);
  assert.deepEqual(lower.faces, [97, 97, 97, 97, 97, 97]);
  assert.deepEqual(upper.faces, [81, 81, 97, 97, 81, 81]);
  assert.equal(upper.mirrorFaces[4], true);
  assert.equal(upper.mirrorFaces[5], false);
  assert.equal(open.mirrorFaces[0], true);
  assert.equal(upper.uv, undefined);
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

test('HarvestCraft cinnamon is a solid trunk and vanilla bean remains a crossed plant', () => {
  assert.deepEqual(aabb(collisionFor('legacy:3968:7')[0]), [0, 0, 0, 1, 1, 1]);
  assert.deepEqual(shapeFor('legacy:3968:7')[0].faces, Array(6).fill(3266));
  assert.equal(shapeFor('legacy:3989:7')[0].kind, 'cross');
  assert.deepEqual(collisionFor('legacy:3989:7'), []);
});

test('HarvestCraft fruit uses the original growth textures and leaves clear passage', () => {
  for (const [id, tile] of [[4031, 3286], [3983, 3289], [3977, 3292], [4084, 3295]]) {
    for (const [meta, stage] of [[0, 0], [3, 0], [4, 1], [6, 1], [7, 2], [8, 2], [9, 0]]) {
      const key = `legacy:${id}:${meta}`;
      const [part] = shapeFor(key);
      assert.equal(part.kind, 'cross');
      assert.equal(part.faces[0], tile + stage);
      assert.equal(part.x0, 0.05);
      assert.equal(part.y1, 1);
      assert.equal(part.tint, undefined);
      assert.deepEqual(collisionFor(key), []);
    }
  }
  assert.deepEqual(aabb(collisionFor('legacy:4053:0')[0]), [0, 0, 0, 1, 0.5, 1]);
  assert.deepEqual(aabb(collisionFor('legacy:4053:8')[0]), [0, 0.5, 0, 1, 1, 1]);
  assert.equal(shapeFor('legacy:4053:0')[0].faces[0], 194);
});

test('HarvestCraft food crates and sink are solid while wild crops use crossed sprites', () => {
  for (const [key, tile] of [['legacy:3823:0', 3604], ['legacy:3999:6', 3623]]) {
    assert.deepEqual(shapeFor(key)[0].faces, Array(6).fill(tile));
    assert.deepEqual(collisionFor(key).map(aabb), [[0, 0, 0, 1, 1, 1]]);
  }
  assert.deepEqual(shapeFor('legacy:3943:0')[0].faces, [3645, 3645, 3649, 3641, 3645, 3645]);
  assert.deepEqual(collisionFor('legacy:3943:0').map(aabb), [[0, 0, 0, 1, 1, 1]]);
  assert.equal(shapeFor('legacy:3902:0')[0].faces[0], 3633);
  assert.equal(shapeFor('legacy:4068:0')[0].kind, 'cross');
  assert.deepEqual(collisionFor('legacy:4068:0'), []);
});

test('Chisel fixtures use the selected source tiles and keep full cube collision', () => {
  for (const [key, faces] of [['legacy:2779:7', Array(6).fill(3298)],
    ['legacy:2835:13', Array(6).fill(3299)], ['legacy:2804:12', [3300, 3300, 3302, 3301, 3300, 3300]]]) {
    assert.deepEqual(shapeFor(key)[0].faces, faces);
    assert.deepEqual(aabb(collisionFor(key)[0]), [0, 0, 0, 1, 1, 1]);
  }
});

test('MoCreatures native rock and log use their own terrain rather than the placeholder', () => {
  assert.deepEqual(shapeFor('legacy:162:1')[0].faces, Array(6).fill(3653));
  assert.deepEqual(shapeFor('legacy:701:1')[0].faces, [3654, 3654, 3655, 3655, 3654, 3654]);
  assert.deepEqual(collisionFor('legacy:701:1').map(aabb), [[0, 0, 0, 1, 1, 1]]);
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
