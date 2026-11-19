import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeFarTile, farVisibilityMask, lodDistance, LOD_VERSION, RAIL_FACE, WATER_HEIGHT_SCALE, MICRO_FACE, MICRO_SCALE,
  CUTOUT_FACE, TRANSITION_FACE, DETAILED_LOD_DISTANCES, DEFAULT_DETAILED_LOD_DISTANCE,
  validateDetailedLodDistance} from './far-tile-format.mjs';

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

test('v4 rail records cannot be confused with old transition or water records', () => {
  const buffer = sample();
  const data = new DataView(buffer);
  data.setUint16(4,3,true);
  data.setUint8(80,RAIL_FACE);
  data.setUint16(78,1,true);
  assert.equal(lodDistance(3),32);
  assert.throws(() => decodeFarTile(buffer),/face/);
  data.setUint16(4,4,true);
  assert.deepEqual([...decodeFarTile(buffer).layers[3].span],[4,1]);
  data.setUint16(76,10,true);
  assert.throws(() => decodeFarTile(buffer),/rail/);
});

function packedFaces(records) {
  const buffer=new ArrayBuffer(72+records.length*16);
  const data=new DataView(buffer);
  data.setUint32(0,0x484c4f44);
  data.setUint16(4,LOD_VERSION,true);
  data.setUint8(6,4);
  data.setUint8(7,16);
  for (const [i,{x,y,z,width,height,tile,face=4,chunk=0,flags=MICRO_FACE,cutout=false,light=240}] of records.entries()) {
    const bytes=72+i*16;
    const count=8+chunk*4;
    data.setUint32(count,data.getUint32(count,true)+1,true);
    data.setUint8(bytes,x);
    data.setUint8(bytes+1,z);
    data.setUint16(bytes+2,y,true);
    data.setUint16(bytes+4,width,true);
    data.setUint16(bytes+6,height,true);
    data.setUint8(bytes+8,flags|face|(cutout?CUTOUT_FACE:0));
    data.setUint16(bytes+9,tile,true);
    data.setUint16(bytes+11,light,true);
    data.setUint8(bytes+13,140);
  }
  return decodeFarTile(buffer);
}

test('packed micro faces keep one material in an overlapping joint without trimming its exposed strips', () => {
  const crossing={x:0,y:4,z:1,width:2,height:8,tile:194,light:221};
  const post={x:2,y:0,z:1,width:8,height:4,tile:130};
  const tile=packedFaces([crossing,post]);
  const micro=tile.layers[4];
  assert.equal(micro.count,3);
  assert.equal(tile.bytes,57);
  assert.equal(tile.triangles,6);
  assert.deepEqual([...micro.offset],[0,4,1, 6,4,1, 2,0,1]);
  assert.deepEqual([...micro.span],[2,2, 2,2, 8,4]);
  assert.deepEqual([...micro.surface],[194,4, 194,4, 130,4]);
  assert.deepEqual([...micro.light],[221,221,240]);
  assert.deepEqual([...micro.color],[140,0,0, 140,0,0, 140,0,0]);
});

test('packed micro overlap priority prefers opaque, then the earlier identical face in file order', () => {
  const panel={x:128,y:0,z:1,width:8,height:8};
  const {layers:[,,,,micro]}=packedFaces([
    {...panel,tile:30,cutout:true},
    {...panel,tile:194,light:221},
    {...panel,tile:194,light:222},
    {...panel,tile:400,face:5},
    {...panel,tile:401,z:2},
    {...panel,tile:402,x:0,chunk:1},
  ]);
  assert.equal(micro.count,4);
  assert.deepEqual([...micro.surface],[194,4, 400,5, 401,4, 402,12]);
  assert.deepEqual([...micro.light],[221,240,240,240]);
});

test('a preferred micro cover splits the ordinary face at exact fractional coordinates', () => {
  const {layers:[land,,,,micro]}=packedFaces([
    {x:2,y:5,z:4,width:2,height:2,tile:200,face:3,flags:0,light:205},
    {x:20,y:40,z:36,width:4,height:4,tile:130,face:3},
    {x:20,y:41,z:36,width:4,height:4,tile:130,face:3},
  ]);
  assert.equal(land.coordinateScale,MICRO_SCALE);
  assert.equal(land.heightScale,MICRO_SCALE);
  assert.equal(land.count,4);
  assert.deepEqual([...land.offset],[16,40,32, 16,40,40, 16,40,36, 24,40,36]);
  assert.deepEqual([...land.span],[4,16, 8,16, 4,4, 4,8]);
  assert.deepEqual([...land.surface],[200,3, 200,3, 200,3, 200,3]);
  assert.deepEqual([...land.light],[205,205,205,205]);
  assert.equal(micro.count,2);
  assert.deepEqual([...micro.offset],[20,40,36, 20,41,36]);
});

test('opaque ordinary faces clip intersecting cutout covers and preserve transition geometry', () => {
  const wall={x:2,y:5,z:4,width:1,height:1,tile:200,flags:0};
  const {layers:[land,,transition,,micro]}=packedFaces([
    wall,
    {...wall,tile:201,flags:TRANSITION_FACE},
    {x:12,y:40,z:32,width:8,height:16,tile:130,cutout:true},
  ]);
  assert.equal(land.coordinateScale,1);
  assert.equal(land.count,1);
  assert.equal(transition.coordinateScale,1);
  assert.equal(transition.count,1);
  assert.deepEqual([...transition.offset],[2,5,4]);
  assert.deepEqual([...transition.surface],[201,132]);
  assert.equal(micro.count,2);
  assert.deepEqual([...micro.offset],[12,40,32, 24,40,32]);
  assert.deepEqual([...micro.span],[8,4, 8,4]);
});
