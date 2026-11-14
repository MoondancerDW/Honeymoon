import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FACE_SHADE, coverShade, legacyLight, linearByte, sunlightAt, writeLightmap } from './lighting.mjs';
import { World } from './world-data.mjs';

test('preserves independent sky and block lighting from the imported section', () => {
  const world = new World({palette: ['air']});
  const sky = Buffer.alloc(2048, 0x1f).toString('base64');
  const block = Buffer.alloc(2048, 0xe4).toString('base64');
  world.addChunk({x:-1, z:-1, sections:[{y:4, indices:Buffer.alloc(8192).toString('base64'),
    skyLight:sky, blockLight:block}]});
  const {light} = world.halo(-1,4,-1);
  assert.equal(light[343], 0xf4);
  assert.equal(light[344], 0x1e);
});

test('mesh halos retain a diagonal neighbor object, packed light and a cell override', () => {
  const world = new World({palette:['air', 'legacy:1:0', 'legacy:2:0']});
  const indices = Buffer.alloc(8192);
  indices.writeUInt16LE(1, 2 * (15 + 15 * 16));
  const object = {position:[-17, 64, -17], type:'Sign'};
  world.addChunk({x:-2, z:-2, objects:[object], sections:[{y:4, indices:indices.toString('base64'),
    skyLight:Buffer.alloc(2048, 0xab).toString('base64'), blockLight:Buffer.alloc(2048, 0xcd).toString('base64')}]});
  const index = 18 ** 2;
  const halo = () => world.halo(-1, 4, -1);
  assert.equal(halo().indices[index], 1);
  assert.equal(halo().light[index], 0xac);
  assert.deepEqual(halo().objects, [[index, object]]);
  world.setOverride({x:-17, y:64, z:-17, cell:'legacy:2:0', object:null, revision:1});
  world.blockLightOverrides.set('-17,64,-17', 3);
  assert.equal(halo().indices[index], 2);
  assert.equal(halo().light[index], 0xa3);
  assert.deepEqual(halo().objects, []);
});

test('legacy lighting keeps shaded interiors and the warm block-light curve', () => {
  assert.deepEqual(legacyLight(0x00), [14,14,14]);
  assert.deepEqual(legacyLight(0x08), [93,74,51]);
  assert.deepEqual(legacyLight(0x80), [67,67,67]);
  assert.deepEqual(legacyLight(0xf0), [250,250,250]);
  assert.equal(linearByte(255, FACE_SHADE[0], 255), 81);
  assert.equal(linearByte(255, FACE_SHADE[3], 255), 255);
  assert.equal(coverShade(0xf0), 1);
  assert.ok(Math.abs(coverShade(0xb7) - 11/27) < 1e-9);
});

test('native day cycle dims sky light without scaling block light', () => {
  assert.equal(sunlightAt(6000), 1);
  assert.equal(sunlightAt(18000), .2);
  assert.equal(sunlightAt(18000 + 24000), .2);
  const light = new Uint8Array(16 * 17 * 4);
  writeLightmap(light, sunlightAt(18000));
  assert.ok(light[240 * 4] < 100);
  assert.deepEqual([...light.slice(8 * 4, 8 * 4 + 3)], legacyLight(8));
  assert.deepEqual([...light.slice(256 * 4, 256 * 4 + 4)], [255,255,255,255]);
});

function lightingWorld() {
  const world = new World({palette:['air', 'legacy:219:0', 'legacy:1:0', 'legacy:20:0']});
  const indices = Buffer.alloc(8192);
  for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) indices.writeUInt16LE(2, 2 * (8 + z * 16 + y * 256));
  world.addChunk({x:0,z:0,sections:[{y:0,indices:indices.toString('base64'),
    skyLight:Buffer.alloc(2048,0xaa).toString('base64'),blockLight:Buffer.alloc(2048).toString('base64')}]});
  return world;
}

test('a switched lamp lights its side of a wall and the light disappears when switched off', () => {
  const world = lightingWorld();
  world.setOverride({x:6,y:7,z:7,cell:'legacy:219:0',revision:1});
  assert.ok(world.updateLighting().has('0,0,0'));
  assert.equal(world.lightAt(6,7,7), 0xaf);
  assert.equal(world.lightAt(7,7,7), 0xae);
  assert.equal(world.lightAt(9,7,7), 0xa0);
  world.setOverride({x:8,y:7,z:7,cell:'legacy:20:0',revision:2});
  world.updateLighting();
  assert.equal(world.lightAt(9,7,7), 0xac);
  world.setOverride({x:6,y:7,z:7,cell:'legacy:220:0',revision:3});
  world.updateLighting();
  assert.equal(world.lightAt(7,7,7), 0xa0);
  assert.equal(world.lightAt(9,7,7), 0xa0);
});

test('restored overrides are lit after their destination chunk loads', () => {
  const world = new World({palette:['air']});
  world.setOverride({x:15,y:8,z:8,cell:'legacy:50:5',revision:1});
  const chunk = x => world.addChunk({x,z:0,sections:[{y:0,indices:Buffer.alloc(8192).toString('base64')}]});
  world.updateLighting(chunk(0));
  assert.equal(world.lightAt(15,8,8) & 15, 14);
  world.updateLighting(chunk(1));
  assert.equal(world.lightAt(16,8,8) & 15, 13);
});
