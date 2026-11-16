import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeFarTile, farVisibilityMask, LOD_VERSION, WATER_HEIGHT_SCALE,
  DETAILED_LOD_DISTANCES, DEFAULT_DETAILED_LOD_DISTANCE, validateDetailedLodDistance} from './far-tile-format.mjs';

test('detailed LOD settings accept only the supported numeric distances', () => {
  assert.deepEqual(DETAILED_LOD_DISTANCES,[8,12,16,20,24,28]);
  assert.equal(DEFAULT_DETAILED_LOD_DISTANCE,20);
  assert.ok(Object.isFrozen(DETAILED_LOD_DISTANCES));
  for (const distance of DETAILED_LOD_DISTANCES) assert.equal(validateDetailedLodDistance(distance),distance);
  for (const distance of [undefined,null,'20',4,8.5,18,32,NaN,Infinity]) {
    assert.throws(() => validateDetailedLodDistance(distance),RangeError);
  }
});

function sample() {
  const buffer = new ArrayBuffer(104);
  const data = new DataView(buffer);
  data.setUint32(0,0x484c4f44);
  data.setUint16(4,1,true);
  data.setUint8(6,4);
  data.setUint8(7,16);
  data.setUint32(8 + 4*5,1,true);
  data.setUint32(8 + 4*14,1,true);
  for (const [offset,flags] of [[72,0],[88,131]]) {
    data.setUint8(offset,16);
    data.setUint8(offset + 1,2);
    data.setUint16(offset + 2,64,true);
    data.setUint16(offset + 4,4,true);
    data.setUint16(offset + 6,6,true);
    data.setUint8(offset + 8,flags);
    data.setUint16(offset + 9,4096,true);
    data.setUint16(offset + 11,240,true);
    data.setUint8(offset + 13,87);
  }
  return buffer;
}

test('packed far terrain preserves geometry, lighting, water and chunk anchors', () => {
  const tile = decodeFarTile(sample());
  const [land,water] = tile.layers;
  assert.equal(tile.triangles,4);
  assert.equal(tile.bytes,38);
  assert.deepEqual([...land.offset],[32,64,18]);
  assert.deepEqual([...water.offset],[48,64,50]);
  assert.deepEqual([...land.span],[4,6]);
  assert.deepEqual([...land.surface],[4096,40]);
  assert.deepEqual([...water.surface],[4096,115]);
  assert.deepEqual([...water.light],[240]);
  assert.deepEqual([...water.color],[87,0,0]);
  assert.equal(land.maxY,70);
  assert.equal(water.maxY,64);
  assert.equal(farVisibilityMask(-2,-1,(x,z) => x === -7 && z === -3,tile.counts),1 << 14);
});

test('far terrain decoder checks shape, version and exact byte length', () => {
  assert.throws(() => decodeFarTile(new ArrayBuffer(1)),/Invalid far terrain/);
  const wrongCount = sample();
  new DataView(wrongCount).setUint32(8,10,true);
  assert.throws(() => decodeFarTile(wrongCount),/size/);
  const wrongFace = sample();
  new DataView(wrongFace).setUint8(80,6);
  assert.throws(() => decodeFarTile(wrongFace),/face/);
});

test('fractional source water heights use the same file size and correct mesh bounds', () => {
  const buffer = sample();
  const data = new DataView(buffer);
  data.setUint16(4,LOD_VERSION,true);
  data.setUint16(90,64*WATER_HEIGHT_SCALE-1,true);
  const [land,water] = decodeFarTile(buffer).layers;
  assert.equal(land.heightScale,1);
  assert.equal(water.heightScale,9);
  assert.equal(water.minY,64-1/9);
  assert.equal(water.maxY,water.minY);
  data.setUint8(96,128);
  assert.throws(() => decodeFarTile(buffer),/face/);
});

test('transition faces are reserved for vertical boundaries in version 3', () => {
  const buffer = sample();
  const data = new DataView(buffer);
  data.setUint16(4,2,true);
  data.setUint8(80,8);
  assert.throws(() => decodeFarTile(buffer),/face/);
  data.setUint16(4,LOD_VERSION,true);
  const [land,,boundary] = decodeFarTile(buffer).layers;
  assert.equal(land.count,0);
  assert.deepEqual([...boundary.surface],[4096,168]);
  data.setUint8(80,11);
  assert.throws(() => decodeFarTile(buffer),/face/);
});
