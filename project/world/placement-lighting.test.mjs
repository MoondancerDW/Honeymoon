import assert from 'node:assert/strict';
import {test} from 'node:test';
import {blockKey, signalSides} from './block-interactions.mjs';
import {shapedLampData} from './creative-items.mjs';
import {collisionFor, selectionFor, shapeFor} from './geometry.mjs';
import {orientPlacedBlock} from './placement-heading.mjs';
import {lightingPlacementName, orientedLightPlacement} from './placement-lighting.mjs';
import {lampBounds} from './redpower-lamps.mjs';

const against = {x:12, y:64, z:-31};
const placements = signalSides.map(([x,y,z]) => ({x:against.x+x, y:against.y+y, z:against.z+z}));
const place = (key, face, yaw = 0) => orientedLightPlacement(key, {against,yaw}, placements[face]);
const supportEdges = ['y1','y0','z1','z0','x1','x0'];
const supportCoordinate = face => (face & 1) ^ 1;
const invalidMount = {error:'invalid_mount_face'};

test('Jammy ceiling, wall and table fixtures retain their type and meet the clicked support', () => {
  const selected = [0,8,4,4,4,4];
  const expected = [0,8,4,6,7,5];
  for (const id of [219,220]) {
    assert.deepEqual([0,4,8].map(meta => lightingPlacementName(id,meta)),
      ['Потолочный светильник','Настенный фонарь','Настольная лампа']);
    for (const [face, meta] of expected.entries()) {
      const cell = blockKey(id,meta);
      assert.deepEqual(place(blockKey(id,selected[face]), face), {cell, requireSupport:face});
      assert.equal(selectionFor(cell)[0][supportEdges[face]], supportCoordinate(face), cell);
    }
    assert.deepEqual(place(blockKey(id,7),2,Math.PI), {cell:blockKey(id,4),requireSupport:2});
    assert.deepEqual(place(blockKey(id,15),0), {cell:blockKey(id,0),requireSupport:0});
    assert.deepEqual(place(blockKey(id,0),1), invalidMount);
    assert.deepEqual(place(blockKey(id,4),0), invalidMount);
    assert.deepEqual(place(blockKey(id,4),1), invalidMount);
    assert.deepEqual(place(blockKey(id,8),5), invalidMount);
  }
});

test('vanilla torches and all HarvestCraft candle colors use their floor and wall variants', () => {
  const expected = [null,5,4,3,2,1];
  const candles = Array.from({length:16}, (_, index) => 3909 + index);
  for (const id of [50,75,76,...candles]) {
    for (const [face, meta] of expected.entries()) {
      assert.deepEqual(place(blockKey(id,0),face),meta === null ? {error:'invalid_control_face'} :
        {cell:blockKey(id === 75 ? 76 : id,meta), requireSupport:face});
    }
  }
});

test('Twilight Forest critters render and can be targeted against all six faces without collision', () => {
  const visibleFaces = [2,3,4,5,0,1];
  for (const id of [2160,2171,2178]) {
    for (const [face, visible] of visibleFaces.entries()) {
      const {cell, requireSupport} = place(blockKey(id,0),face);
      assert.equal(cell, blockKey(id,6-face));
      assert.equal(requireSupport, face);
      const [shape] = shapeFor(cell);
      assert.equal(shape[supportEdges[face]], supportCoordinate(face));
      assert.deepEqual(shape.faces.flatMap((tile, index) => tile >= 0 ? [index] : []), [visible]);
      assert.deepEqual(selectionFor(cell), [shape]);
      assert.deepEqual(collisionFor(cell), []);
    }
  }
});

test('RedPower shaped lamps keep their appearance and point away from all six mounting faces', () => {
  const key = blockKey(768,0);
  for (const [face] of placements.entries()) {
    const {cell, mountFace} = place(key,face);
    assert.equal(cell,key);
    assert.equal(mountFace,face);
    const data = shapedLampData(32 + 16 + 3, mountFace ^ 1);
    assert.deepEqual(data, {style:1,color:3,ps:2,rot:face ^ 1});
    assert.equal(lampBounds(data)[supportEdges[face]], supportCoordinate(face));
    assert.equal(shapeFor({key,object:{data}})[0][supportEdges[face]],supportCoordinate(face));
  }
});

test('jack-o’-lanterns face the player while symmetric jars and lanterns keep their state', () => {
  for (const [heading, visible] of [5,1,4,0].entries()) {
    const cell = orientPlacedBlock(blockKey(91,0),{against,yaw:heading*Math.PI/2},placements[1]);
    const [shape] = shapeFor(cell);
    const side = shape.faces[visible === 0 ? 1 : 0];
    assert.notEqual(shape.faces[visible], side);
    assert.equal([0,1,4,5].filter(index => shape.faces[index] !== side).length,1);
  }
  for (const id of [123,124,756,757,758,759,2168]) assert.equal(place(blockKey(id,0),2),undefined);
});
