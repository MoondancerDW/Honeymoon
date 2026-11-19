import assert from 'node:assert/strict';
import test from 'node:test';
import {buildRegion,makeMaterials,outerChunk,sampleChunk,OUTER_STEP} from './lod-mesh.mjs';
import {CUTOUT_FACE,decodeFarTile,LOD_VERSION,MICRO_FACE,MICRO_SCALE,TRANSITION_FACE,WATER_HEIGHT_SCALE} from '../client/far-tile-format.mjs';
import {shapeFor, tiles} from '../world/geometry.mjs';
import {fullCoverMaterial} from '../world/cover-plane.mjs';

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

function faces(content, slot = 0, transition = false) {
  const start = 8 + 16 * 4;
  let first = start;
  for (let i=0; i<slot; i++) first += 16 * content.readUInt32LE(8+4*i);
  const count = content.readUInt32LE(8+4*slot);
  return Array.from({length:count},(_,i) => {
    const at=first+i*16;
    const flags=content[at+8];
    const water = Boolean(flags&128);
    const scale = flags&MICRO_FACE ? MICRO_SCALE : 1;
    const light = content.readUInt16LE(at+11);
    return {x:content[at]/scale,z:content[at+1]/scale,y:content.readUInt16LE(at+2)/(water ? WATER_HEIGHT_SCALE : scale),
      w:content.readUInt16LE(at+4)/scale,h:content.readUInt16LE(at+6)/scale,face:flags&7,water,tile:content.readUInt16LE(at+9),
      ...(flags & CUTOUT_FACE && {cutout:true}),
      ...(light !== 240 && {light}), transition:Boolean(flags & TRANSITION_FACE)};
  }).filter(face => face.transition === transition).map(({transition:_,...face}) => face);
}

function pack(chunks,minX=0,maxX=1,minZ=0,maxZ=0,outer=false) {
  const catalog=makeMaterials();
  const sampled=new Map(chunks.map(chunk => {
    const level = sampleChunk(chunk,catalog);
    return [`${chunk.x},${chunk.z}`,outer ? outerChunk(level,catalog) : level];
  }));
  return buildRegion(0,0,(x,z) => sampled.get(`${x},${z}`),catalog,minX,maxX,minZ,maxZ,outer ? OUTER_STEP : undefined);
}

test('keeps sign boards and represents both halves of open and closed doors in both terrain tiers', () => {
  const palette=[air,rock,'legacy:63:4','legacy:68:2','legacy:64:0','legacy:64:4','legacy:64:8'];
  function scene(open) {
    return supplied(0,0,(x,y,z)=>{
      if (y<6) return 1;
      if (x===4 && y===6 && z===4) return 2;
      if (x===7 && y===6 && z===4) return 3;
      if (x!==9 || z!==4) return 0;
      if (y===6) return open ? 5 : 4;
      return y===7 ? 6 : 0;
    },palette);
  }
  for (const outer of [false,true]) {
    const closed=faces(pack([scene(false)],0,0,0,0,outer).content);
    const opened=faces(pack([scene(true)],0,0,0,0,outer).content);
    for (const geometry of [closed,opened]) {
      assert.ok(geometry.some(face=>face.tile>=3303 && face.tile<=3308));
      assert.ok(geometry.some(face=>face.tile===tiles.sign));
      assert.ok(geometry.some(face=>face.tile===97 && face.face!==3));
      assert.ok(geometry.some(face=>face.tile===81 && face.face!==3));
    }
    assert.notDeepEqual(closed.filter(face=>[81,97].includes(face.tile)),opened.filter(face=>[81,97].includes(face.tile)));
  }
});

test('prebuilds solid tops as one face and excludes cutoff walls and internal boundaries', () => {
  const {content,quads} = pack([supplied(0,0,(_x,y) => Number(y < 8)), supplied(1,0,(_x,y) => Number(y < 8))]);
  assert.equal(content.toString('ascii',0,4),'HLOD');
  assert.equal(content.readUInt16LE(4),LOD_VERSION);
  assert.equal(content.length,72+quads*16);
  assert.equal(quads,4);
  const roof = {x:0,z:0,y:8,w:16,h:16,face:3,water:false,tile:1};
  assert.deepEqual(faces(content,0),[roof]);
  assert.deepEqual(faces(content,1),[roof]);
  assert.deepEqual(faces(content,0,true),[{x:16,z:0,y:0,w:8,h:16,face:1,water:false,tile:1}]);
  assert.deepEqual(faces(content,1,true),[{x:0,z:0,y:0,w:16,h:8,face:0,water:false,tile:1}]);
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

test('keeps partial standalone covers and the underlying attached frame in simplified terrain', () => {
  const cover = 'cover:750:0:test';
  const coveredFrame = 'cover:768:0:test';
  const parts = [{slot:1, shape:3, material:28}];
  const simplified = supplied(0,0,(x,y) => y < 8 ? 1 : x < 4 ? 2 : x < 8 ? 3 : x < 12 ? 4 : 5,
    [air, rock, cover, 'legacy:750:0', 'cover-material:28', coveredFrame]);
  simplified.compositions[cover] = {parts};
  simplified.compositions[coveredFrame] = {parts};
  const bareFrame = supplied(0,0,(x,y) => y < 8 ? 1 : x < 12 ? 0 : 2,[air,rock,'legacy:768:0']);
  const detailed = pack([simplified],0,0).content;
  const bare = pack([bareFrame],0,0).content;
  const layer = decodeFarTile(Uint8Array.from(detailed).buffer).layers[4];
  assert.ok(layer.count > 0);
  assert.equal(layer.coordinateScale,8);
  assert.equal(decodeFarTile(Uint8Array.from(bare).buffer).layers[4].count,0);
  assert.ok(shapeFor({key:cover, parts}).some(box => box.partSlot === 1));
});

test('keeps the center of a hollow cover open in both tiers and draws each material on its own plane', () => {
  const cover = 'cover:750:0:test';
  const slab = {slot:1, shape:3, material:28};
  const center = {slot:29, material:1, bounds:[[2,7,2,6,8,6]]};
  assert.equal(fullCoverMaterial([slab]), undefined);
  assert.equal(fullCoverMaterial([{...slab, shape:0}]), 28);
  assert.equal(fullCoverMaterial([slab, center]), 28);
  assert.equal(fullCoverMaterial([slab, {...center, bounds:[[2,6,2,6,7,6]]}]), undefined);

  const tinyRoof = supplied(0,0,(x,y,z) => y < 8 ? 1 : x === 8 && y === 8 && z === 8 ? 2 : 0,
    [air, rock, cover]);
  tinyRoof.compositions[cover] = {parts:[slab,center]};
  const {content} = pack([tinyRoof],0,0);
  const tile = shapeFor('cover-material:28')[0].faces[3];
  assert.ok(faces(content).some(face => face.tile === tile && face.face === 3 && face.y === 9));
  assert.ok(faces(content).some(face => face.tile === 1 && face.face === 3 && face.y === 9 && face.x === 8.25 && face.z === 8.25));
  tinyRoof.compositions[cover] = {parts:[slab]};
  for (const outer of [false,true]) {
    const partial = faces(pack([tinyRoof],0,0,0,0,outer).content);
    const top = partial.filter(face => face.tile === tile && face.face === 3 && face.y === 9);
    assert.equal(top.reduce((area,face) => area+face.w*face.h,0),.75);
    assert.ok(top.every(face => face.x > 8.5 || face.x + face.h <= 8.5 || face.z > 8.5 || face.z + face.w <= 8.5));
  }
});

test('leaf faces share the exact texture and retain alpha test in both tiers', () => {
  const grove = supplied(0,0,(_x,y) => y < 4 ? 1 : y < 8 ? 2 : 0,[air,rock,'legacy:18:0']);
  for (const outer of [false,true]) {
    const tops = faces(pack([grove],0,0,0,0,outer).content).filter(face => face.face === 3);
    assert.ok(tops.some(face => face.tile === 52 && face.cutout));
  }
});

test('both distance tiers retain saved block light and the inner tier keeps lit lamp surfaces', () => {
  const chunk = supplied(0,0,(x,y,z) => y < 4 ? 1 : x === 8 && z === 8 && y === 4 ? 2 : 0,
    [air,rock,'legacy:768:0']);
  chunk.sections[0].blockLight = Buffer.alloc(2048,0xcc).toString('base64');
  chunk.objects = [{position:[8,4,8],data:{ps:1,color:5}}];
  const inner = faces(pack([chunk],0,0).content);
  const outer = faces(pack([chunk],0,0,0,0,true).content);
  assert.ok(inner.some(face => face.face === 3 && face.light === 252 && face.tile === 1));
  assert.ok(outer.some(face => face.face === 3 && face.light === 252 && face.tile === 1));
  assert.ok(inner.some(face => face.face === 3 && face.light === 256 && face.tile === tiles.redPowerLighting + 37));
});

test('a glass shell keeps its illuminated core in the simplified mesh', () => {
  const shell = supplied(0,0,(x,y,z) => {
    if (x===8 && y===8 && z===8) return 3;
    return x>=6 && x<=10 && y>=6 && y<=10 && z>=6 && z<=10 ? 2 : 0;
  }, [air,rock,'legacy:20:0','legacy:89:0']);
  const catalog = makeMaterials();
  assert.equal(catalog.materials[catalog.get('legacy:20:0')].glass,true);
  assert.equal(catalog.materials[catalog.materialFor('cover-material:7')].glass,true);
  const inner = faces(pack([shell],0,0).content);
  assert.ok(inner.some(face=>face.tile===105 && face.light===256),'the glowstone core remains visible behind glass');
  assert.ok(inner.some(face=>face.tile===49),'the shell retains its cutout texture');
});

test('keeps a one-block grass course above stone in the sampled terrain', () => {
  const {content} = pack([supplied(0,0,(_x,y) => y < 7 ? 1 : y === 7 ? 2 : 0,
    [air,rock,'legacy:2:0'])],0,0);
  assert.deepEqual(faces(content),[{x:0,z:0,y:8,w:16,h:16,face:3,water:false,tile:0}]);
});

test('exposed terrain keeps its original odd height at the exact chunk boundary', () => {
  const soil = [air,rock,'legacy:2:0'];
  const west = supplied(0,0,(_x,y) => y < 6 ? 1 : y === 6 ? 2 : 0,soil);
  const east = supplied(1,0,(_x,y) => y < 6 ? 1 : y === 6 ? 2 : 0,soil);
  for (const outer of [false,true]) {
    const geometry = pack([west,east],0,1,0,0,outer).content;
    for (const slot of [0,1]) {
      const tops = faces(geometry,slot).filter(face => face.face===3);
      assert.deepEqual(tops,[{x:0,z:0,y:7,w:16,h:16,face:3,water:false,tile:0}]);
      assert.ok(faces(geometry,slot,true).every(face => face.y < 7));
    }
  }
});

test('lawns remain one block below a coarsened cell ceiling under roofs and beside leaf blocks', () => {
  const lawn = supplied(0,0,(x,y,z) => {
    if (y<6) return 1;
    if (y===6) return z<8 ? 2 : 1;
    if (y===7 && x===9 && z===5) return 3;
    return y===10 && x>=4 && x<12 && z>=3 && z<7 ? 4 : 0;
  },[air,rock,'legacy:2:0','legacy:18:0',masonry]);
  for (const outer of [false,true]) {
    const tops=faces(pack([lawn],0,0,0,0,outer).content).filter(face=>face.face===3 && face.tile===0);
    const at=(x,z)=>tops.filter(f=>f.x<=x && x<f.x+f.h && f.z<=z && z<f.z+f.w);
    assert.deepEqual(at(5,4).map(face=>face.y),[7]);
    assert.deepEqual(at(8,5).map(face=>face.y),[7]);
    assert.ok(tops.every(face=>face.y===7));
  }
});

test('inner terrain preserves straight, sloped, powered and curved tracks', () => {
  const tracks = [air,rock,'legacy:66:1','legacy:66:2','legacy:27:9','legacy:66:9'];
  const chunk = supplied(0,0,(x,y,z) => y < 7 ? 1 : y === 7 && z===5 && x<4 ? x+2 : 0,tracks);
  const {content} = pack([chunk],0,0);
  const rails = decodeFarTile(Uint8Array.from(content).buffer).layers[3];
  assert.equal(rails.count,4);
  assert.deepEqual([...rails.offset],[0,7,5,1,7,5,2,7,5,3,7,5]);
  assert.deepEqual([...rails.span],[1,1,2,1,1,1,9,1]);
  assert.deepEqual([...rails.surface],[128,0,128,0,179,0,112,0]);
  assert.equal(rails.maxY,8+1/16);
  assert.equal(decodeFarTile(Uint8Array.from(pack([chunk],0,0,0,0,true).content).buffer).layers[3].count,0);
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
