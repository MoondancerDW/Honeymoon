import test from 'node:test';
import assert from 'node:assert/strict';
import {itemFrameModel} from './item-frames.mjs';
import {mapPixels} from './item-frame-maps.mjs';

test('frame attaches at the supporting block face in all four legacy directions', () => {
  const coordinates = {TileX: -70, TileY: 67, TileZ: -24};
  const headings = [[0, 0, [-69.5, 67.5, -23]], [1, -Math.PI / 2, [-70, 67.5, -23.5]],
    [2, Math.PI, [-69.5, 67.5, -24]], [3, Math.PI / 2, [-69, 67.5, -23.5]]];
  for (const [direction, rotationY, center] of headings) {
    const model = itemFrameModel({data: {...coordinates, Direction: direction}});
    assert.deepEqual(model.center, center);
    assert.equal(model.rotationY, rotationY);
    assert.equal(model.frame.length, 30);
    assert.deepEqual(model.item, []);
  }
});

test('framed sprites rotate in 90-degree steps and unsupported items leave an empty frame', () => {
  const item = {id: 260, Damage: 0};
  const variants = {'260:0': {uv: [0.1, 0.2, 0.3, 0.4]}};
  const base = {Dir: 0, TileX: 0, TileY: 0, TileZ: 0, Item: item};
  const original = itemFrameModel({data: {...base, ItemRotation: 0}}, variants);
  const rotated = itemFrameModel({data: {...base, ItemRotation: 1}}, variants);
  assert.equal(original.item.length, 1);
  assert.ok(original.item[0].positions[0] < 0);
  assert.ok(rotated.item[0].positions[0] > 0);
  assert.deepEqual(rotated.item[0].uv, original.item[0].uv);
  assert.deepEqual(itemFrameModel({data: base}).item, []);
});

test('framed solid block and RedPower covers use distinct depth', () => {
  const faces = Array(6).fill([0, 0, 1, 1]);
  const items = {'35:0': {faces}, '750:35': {faces, cover: true}};
  const data = {Dir: 0, TileX: 0, TileY: 0, TileZ: 0};
  const extent = id => {
    const item = itemFrameModel({data: {...data, Item: {id, Damage: id === 35 ? 0 : 35}}}, items).item;
    assert.equal(item.length, 6);
    return item[3].positions[2] - item[2].positions[2];
  };
  assert.equal(extent(35), 5 / 16);
  assert.equal(extent(750), 5 / 128);
});

test('filled map pixels use native colors, shades and transparent checker', () => {
  const width = 128;
  const colors = Buffer.alloc(width * width);
  colors.set([0, 0, 4, 5, 6, 7]);
  const rgba = mapPixels({width, height: width, colors});
  assert.deepEqual([...rgba.subarray(0, 8)], [0, 0, 0, 16, 0, 0, 0, 24]);
  assert.deepEqual([...rgba.subarray(8, 24)], [89, 125, 39, 255, 109, 153, 48, 255,
    127, 178, 56, 255, 109, 153, 48, 255]);
  const items = {'358:68': {map: true, uv: [0.25, 0.25, 0.4, 0.4]}};
  const model = itemFrameModel({data: {Direction: 0, TileX: 0, TileY: 0, TileZ: 0,
    Item: {id: 358, Damage: 68}}}, items);
  assert.equal(model.item[0].positions[0], -71 / 256);
});
