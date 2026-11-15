import assert from 'node:assert/strict';
import test from 'node:test';
import {buildRegion,makeMaterials,sampleChunk} from './lod-mesh.mjs';
import {LOD_VERSION,WATER_HEIGHT_SCALE} from '../client/far-tile-format.mjs';
import {shapeFor, tiles} from '../world/geometry.mjs';

const air = 'air';
const rock = 'legacy:1:0';
const masonry = 'legacy:98:0';
const water = 'legacy:9:0';
const supplied = (x,z,sample,palette=[air,rock,masonry,water]) => {
  const indices = Buffer.alloc(8192);
  for (let y=0; y<16; y++) for (let dz=0; dz<16; dz++) for (let dx=0; dx<16; dx++) {
    indices.writeUInt16LE(sample(dx,y,dz),2*(dx+16*dz+256*y));
  }
  return {x,z,palette,compositions:{},sections:[{y:0,indices:indices.toString('base64')}]};
};

function faces(content, slot = 0) {
  const start = 8 + 16 * 4;
  let first = start;
  for (let i=0; i<slot; i++) first += 16 * content.readUInt32LE(8+4*i);
  const count = content.readUInt32LE(8+4*slot);
  return Array.from({length:count},(_,i) => {
    const at=first+i*16;
    const flags=content[at+8];
    const water = Boolean(flags&128);
    return {x:content[at],z:content[at+1],y:content.readUInt16LE(at+2)/(water ? WATER_HEIGHT_SCALE : 1),
      w:content.readUInt16LE(at+4),h:content.readUInt16LE(at+6),face:flags&7,water,tile:content.readUInt16LE(at+9)};
  });
}

function pack(chunks,minX=0,maxX=1,minZ=0,maxZ=0) {
  const catalog=makeMaterials();
  const sampled=new Map(chunks.map(chunk => [`${chunk.x},${chunk.z}`,sampleChunk(chunk,catalog)]));
  return buildRegion(0,0,(x,z) => sampled.get(`${x},${z}`),catalog,minX,maxX,minZ,maxZ);
}

test('prebuilds solid tops as one face and excludes cutoff walls and internal boundaries', () => {
  const {content,quads} = pack([supplied(0,0,(_x,y) => Number(y < 8)), supplied(1,0,(_x,y) => Number(y < 8))]);
  assert.equal(content.toString('ascii',0,4),'HLOD');
  assert.equal(content.readUInt16LE(4),LOD_VERSION);
  assert.equal(content.length,72+quads*16);
  assert.equal(quads,2);
  const roof = {x:0,z:0,y:8,w:16,h:16,face:3,water:false,tile:1};
  assert.deepEqual(faces(content,0),[roof]);
  assert.deepEqual(faces(content,1),[roof]);
});

test('admits a one-block masonry tower and omits geometry inside sealed air', () => {
  const {content} = pack([supplied(0,0,(x,y,z) => {
    if (x === 8 && z === 8 && y < 16 && y >= 8) return 2;
    if (y >= 8) return 0;
    return x >= 4 && x < 8 && z >= 4 && z < 8 && y>=2 && y<6 ? 0 : 1;
  })],0,0);
  const geometry = faces(content);
  assert.ok(geometry.some(face => face.tile===54 && face.face===3 && face.y===16));
  assert.ok(geometry.every(face => face.y>=8));
});

test('ignores standalone covers and attached microblock panels only in simplified terrain', () => {
  const cover = 'cover:750:0:test';
  const coveredFrame = 'cover:768:0:test';
  const parts = [{slot:1, shape:0, material:28}];
  const simplified = supplied(0,0,(x,y) => y < 8 ? 1 : x < 4 ? 2 : x < 8 ? 3 : x < 12 ? 4 : 5,
    [air, rock, cover, 'legacy:750:0', 'cover-material:28', coveredFrame]);
  simplified.compositions[cover] = {parts};
  simplified.compositions[coveredFrame] = {parts};
  const bareFrame = supplied(0,0,(x,y) => y < 8 ? 1 : x < 12 ? 0 : 2,[air,rock,'legacy:768:0']);
  assert.deepEqual(pack([simplified],0,0).content, pack([bareFrame],0,0).content);
  assert.ok(shapeFor({key:cover, parts}).some(box => box.partSlot === 1));
});

test('keeps a one-block grass course above stone in the sampled terrain', () => {
  const {content} = pack([supplied(0,0,(_x,y) => y < 7 ? 1 : y === 7 ? 2 : 0,
    [air,rock,'legacy:2:0'])],0,0);
  assert.deepEqual(faces(content),[{x:0,z:0,y:8,w:16,h:16,face:3,water:false,tile:0}]);
});

test('marks water faces separately while preserving visible shallow underwater material', () => {
  const {content} = pack([supplied(0,0,(_x,y) => y<4 ? 1 : y<8 ? 3 : 0)],0,0);
  const geometry=faces(content);
  assert.ok(geometry.some(face => face.water && face.tile===tiles.water && face.face===3 && face.y===7+8/9));
  assert.ok(geometry.some(face => !face.water && face.tile===1 && face.face===3 && face.y===4));
});

test('keeps a one-block stream in a mixed shore cell at the original flowing levels', () => {
  const river = (x,y,z) => y < 4 ? 1 : z === 7 && y === 4 ? (x < 8 ? 3 : 4) : 0;
  const {content} = pack([supplied(0,0,river,[air,rock,masonry,water,'legacy:8:3'])],0,0);
  assert.deepEqual(faces(content).filter(face => face.water),[
    {x:0,z:7,y:4+8/9,w:1,h:8,face:3,water:true,tile:tiles.water},
    {x:8,z:7,y:4+5/9,w:1,h:8,face:3,water:true,tile:tiles.water},
  ]);
});

test('one-block wet banks and shallow beds do not cover the lowered water surface', () => {
  const river = (_x,y,z) => y < 5 ? 1 : y === 5 ? (z === 7 ? 3 : 1) : 0;
  const {content} = pack([supplied(0,0,river)],0,0);
  const tops = faces(content).filter(face => face.face === 3);
  const inStream = tops.filter(face => face.z <= 7 && 7 < face.z+face.w);
  assert.deepEqual(inStream.map(face => face.y).sort(),[5,5+8/9]);
  assert.ok(tops.some(face => face.y === 6 && face.z === 6 && face.w === 1));
});
