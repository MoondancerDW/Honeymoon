import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chiselMaterialShape, collisionFor, shapeFor, tiles} from './geometry.mjs';
import {decodeVoxels, encodeVoxels, filledVoxels, isChiselMaterial, isFullVoxels, voxelAtHit, voxelBox,
  voxelCoordinate, voxelFaces, voxelIndex, voxelKey, voxelMaterialAt, voxelPlacementAtHit, writeVoxel} from './voxel-chisel.mjs';

const stone = 'legacy:1:0', grass = 'legacy:2:0', dirt = 'legacy:3:0';
const at = (x,y,z) => ({x,y,z});
const cell = voxels => ({key:voxelKey, voxels});

test('canonical volume packs exactly 512 samples and stores only used materials', () => {
  const samples = new Uint8Array(512);
  samples[0] = 1;
  samples[1] = 2;
  const state = encodeVoxels(samples, [dirt, stone, grass]);
  const wire = JSON.parse(JSON.stringify(state));
  assert.equal(state.data.length, 684);
  assert.deepEqual(state.materials, [stone, dirt]);
  assert.deepEqual(Array.from(decodeVoxels(wire).slice(0,4)), [2,1,0,0]);
  assert.equal(decodeVoxels({...wire,data:wire.data.slice(0,-1)}), null);
  assert.equal(decodeVoxels({...wire,materials:[stone, stone]}), null);
  assert.equal(voxelMaterialAt(writeVoxel(state,1,null),0), dirt);
  assert.equal(writeVoxel(writeVoxel(state,1,null),0,null), null);
  assert.equal(isFullVoxels(filledVoxels(grass)), true);
  assert.equal(isFullVoxels(state), false);

  const manyMaterials = Array.from({length:16}, (_, i) => `legacy:35:${i}`);
  const different = new Uint8Array(512);
  for (let i = 0; i < 16; i++) different[i] = i + 1;
  const fullPalette = encodeVoxels(different, manyMaterials);
  assert.equal(voxelMaterialAt(writeVoxel(fullPalette, 16, stone), 16), stone);
  assert.equal(voxelMaterialAt(writeVoxel(fullPalette, 15, stone), 15), stone);
  const widePalette = [1,2,3,4,5,7,12,13,14,15,16,17,19,20,21,22].flatMap(id =>
    Array.from({length:16}, (_, meta) => `legacy:${id}:${meta}`));
  const wideData = new Uint16Array(512);
  for (let i = 0; i < widePalette.length; i++) wideData[i] = i + 1;
  const wide = JSON.parse(JSON.stringify(encodeVoxels(wideData, widePalette)));
  assert.equal(wide.materials.length, 256);
  assert.equal(wide.data.length, 1368);
  assert.deepEqual(widePalette.map((_, i) => voxelMaterialAt(wide, i)), widePalette);
  const back = writeVoxel(wide, 255, null);
  assert.equal(back.data.length, 684);
  assert.equal(voxelMaterialAt(back,254), widePalette[254]);
});

test('full cube materials include translucent and luminous blocks and preserve their faces', () => {
  for (const key of [stone, dirt, grass, 'legacy:17:8', 'legacy:35:6', 'legacy:20:0', 'legacy:89:0',
    'legacy:23:0', 'legacy:46:0', 'legacy:124:0', 'legacy:52:0', 'legacy:73:0', 'legacy:88:0',
    'legacy:138:0', 'legacy:201:0', 'legacy:2162:0']) assert.ok(isChiselMaterial(key), key);
  for (const key of ['legacy:54:0', 'legacy:44:0', 'legacy:36:0', 'legacy:750:0', 'legacy:699:0', 'legacy:035:02']) {
    assert.equal(isChiselMaterial(key), false, key);
  }
  for (const material of [grass, 'legacy:17:8','legacy:20:0','legacy:89:0']) {
    const [source] = shapeFor(material);
    for (const {face,box} of voxelFaces(filledVoxels(material))) {
      assert.equal(box.faces[face], source.faces[face]);
      assert.equal(box.tintFaces?.[face], source.tintFaces?.[face]);
      assert.equal(box.mode, source.mode);
      assert.equal(box.emissive, source.emissive);
    }
  }
});

test('water and lava levels produce static eighths with the original texture and no solid collision', () => {
  for (const [id, fluid, mode, emissive] of [[8,'water','blend',false], [9,'water','blend',false],
    [10,'lava','opaque',true], [11,'lava','opaque',true]]) {
    for (const meta of [0,3,7,8,15]) {
      const key = `legacy:${id}:${meta}`;
      const material = chiselMaterialShape(key);
      assert.deepEqual([material.mode, material.emissive, material.solid, material.fluid], [mode,emissive,false,fluid], key);
      assert.ok(material.faces.every(tile => tile === tiles[fluid]));
      assert.equal(material.y1, 1, key);
      const volume = writeVoxel(null,0,key);
      assert.equal(shapeFor(cell(volume)).length, 1, key);
      assert.equal(collisionFor(cell(volume)).length, 0, key);
    }
  }
});

test('full Jammy models use their exact exterior faces and heading', () => {
  assert.deepEqual(chiselMaterialShape('legacy:201:0').faces, [3880,3881,3882,3883,3884,3885]);
  assert.deepEqual(chiselMaterialShape('legacy:201:4').faces, [3892,3893,3894,3895,3896,3897]);
  assert.deepEqual(chiselMaterialShape('legacy:205:9').faces, [3909,3908,3910,3911,3904,3905]);
  assert.deepEqual(chiselMaterialShape('legacy:206:7').faces, [3920,3921,3926,3927,3917,3916]);
  assert.deepEqual(chiselMaterialShape('legacy:208:12').faces, [3928,3929,3930,3931,3932,3933]);
  for (const partial of ['legacy:205:4', 'legacy:206:0', 'legacy:208:13']) {
    assert.equal(chiselMaterialShape(partial), null);
  }
});

test('grid hit handles negative coordinates, internal faces and tangential boundaries', () => {
  const west = [-1,0,0], east = [1,0,0], hit = at(-4,2.25,-6.5), host = at(-4,2,-7);
  assert.equal(voxelAtHit(host, hit, west),voxelIndex(0,2,4));
  assert.deepEqual(voxelPlacementAtHit(host,hit,west), {x:-5,y:2,z:-7,voxel:voxelIndex(7,2,4)});
  const lower = voxelIndex(0,1,4), sparse = writeVoxel(null,lower,stone);
  assert.equal(voxelAtHit(host, hit, west, true,sparse), lower);
  assert.deepEqual(voxelPlacementAtHit(host,at(-3.875,2.2,-6.45),east,sparse),
    {x:-4,y:2,z:-7,voxel:voxelIndex(1,1,4)});
  assert.equal(voxelAtHit(host,at(-3.875,2.6,-6.45),east,true,sparse),null);
  assert.equal(voxelAtHit(host,at(-3.86,2.2,-6.45),east,true,sparse),null);
  assert.deepEqual(voxelCoordinate(lower), [0,1,4]);
  assert.deepEqual(voxelBox(lower), {x0:0,y0:.125,z0:.5,x1:.125,y1:.25,z1:.625});
});

test('collision uses exact merged occupancy and rendering culls adjacent surfaces', () => {
  const volume = filledVoxels(stone);
  assert.equal(collisionFor(cell(volume)).length, 1);
  const pair = writeVoxel(writeVoxel(null, voxelIndex(0,0,0), stone), voxelIndex(1,0,0), dirt);
  assert.deepEqual(collisionFor(cell(pair)), [{x0:0,y0:0,z0:0,x1:.25,y1:.125,z1:.125,solid:true,mode:'opaque'}]);
  assert.equal(voxelFaces(pair).length, 10, 'two materials share a hidden interior face');
  assert.equal(voxelFaces(writeVoxel(pair,voxelIndex(1,0,0),stone)).length, 6);
  const right = cell(writeVoxel(null,voxelIndex(0,0,0),stone));
  assert.equal(voxelFaces(volume, face => face === 1 ? right : null).length, 7, 'one shared eighth masks its area');
  assert.equal(voxelFaces(volume, face => face === 1 ? cell(volume) : null).length, 5);
  assert.equal(voxelFaces(volume, undefined, face => face === 1).length, 5);

  const checker = new Uint8Array(512);
  for (let i = 0; i < 512; i++) checker[i] = voxelCoordinate(i).reduce((sum, value) => sum + value, 0) & 1;
  const isolated = encodeVoxels(checker, [stone]);
  assert.equal(collisionFor(cell(isolated)).length, 256);
  assert.equal(voxelFaces(isolated).length, 1536);
});
