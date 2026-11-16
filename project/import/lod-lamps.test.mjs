import assert from 'node:assert/strict';
import test from 'node:test';
import {lampCoverOverrides} from './lod-lamps.mjs';
import {makeMaterials, outerChunk, sampleChunk} from './lod-mesh.mjs';
import {shapeFor} from '../world/geometry.mjs';

const cubeSlots = [
  [[13,23,11], [25,1,24], [12,22,10]],
  [[21,3,19], [5,-1,4], [20,2,18]],
  [[9,15,7], [17,0,16], [8,14,6]],
];

function lantern(center = [8,6,8], direction = [0,1], change) {
  const chunks = new Map();
  const [cx,cy,cz] = center, [sx,sz] = direction;
  function put(x,y,z,key,parts) {
    const address = `${x >> 4},${z >> 4}`;
    if (!chunks.has(address)) chunks.set(address,{x:x>>4, z:z>>4, palette:['air'], compositions:{},
      sections:[{y:0,indices:Buffer.alloc(8192)}]});
    const chunk = chunks.get(address);
    let index = chunk.palette.indexOf(key);
    if (index < 0) index = chunk.palette.push(key) - 1;
    chunk.sections[0].indices.writeUInt16LE(index,2*((x&15)+(z&15)*16+y*256));
    if (parts) chunk.compositions[key] = {parts};
  }
  put(cx,cy,cz,'legacy:89:0');
  for (let dy=-1;dy<=1;dy++) for (let dz=-1;dz<=1;dz++) for (let dx=-1;dx<=1;dx++) {
    if (!dx && !dy && !dz) continue;
    const slot = cubeSlots[dy+1][dz+1][dx+1];
    const parts = [{slot,material:slot<6 ? 7 : 28,shape:0}];
    if (dx===sx && dz===sz || !dx && !dz && dy===1) parts.push({slot:26,material:28,shape:0});
    if (dy===1 && (dx===sx && dz===sz || !dx && !dz)) parts.push({slot:sx ? 28 : 27,material:28,shape:0});
    change?.(parts,dx,dy,dz);
    put(cx+dx,cy+dy,cz+dz,`cover:750:0:${dx}:${dy}:${dz}`,parts);
  }
  for (const dy of [-2,-3,-4]) {
    put(cx+sx,cy+dy,cz+sz,`cover:750:0:post:${dy}`,[{slot:26,material:28,shape:dy===-4 ? 1 : 0}]);
  }
  for (const chunk of chunks.values()) chunk.sections[0].indices = chunk.sections[0].indices.toString('base64');
  return [...chunks.values()];
}

test('only matching glass lantern shells are dropped while their wood support and glowstone survive', () => {
  for (const direction of [[0,1],[0,-1],[1,0],[-1,0]]) {
    const [chunk] = lantern([8,6,8],direction);
    const unchanged = JSON.stringify(chunk);
    const replacements = lampCoverOverrides(chunk);
    assert.equal(replacements.size,29);
    assert.equal([...replacements.values()].filter(key=>key==='cover-material:28').length,7);
    assert.equal(replacements.has(6*256+8*16+8),false);
    assert.equal(JSON.stringify(chunk),unchanged);
    const corner = chunk.palette.find(key=>key.startsWith('cover:750:0:-1:-1:-1'));
    assert.ok(shapeFor({key:corner,...chunk.compositions[corner]}).length,'the exact cover geometry remains present');
  }
});

test('glass variants, thicker trim and unsupported lamps retain their default simplified geometry', () => {
  const variants = [
    (parts,dx,dy,dz) => { if (dx===0 && dy===-1 && dz===0) parts[0].material = 28; },
    (parts,dx,dy,dz) => { if (dx===-1 && dy===-1 && dz===-1) parts[0].shape = 1; },
  ];
  for (const change of variants) {
    assert.equal(lampCoverOverrides(lantern([8,6,8],[0,1],change)[0]).size,0);
  }
  const [chunk] = lantern();
  const support = chunk.palette.findIndex(key=>key==='cover:750:0:post:-3');
  chunk.compositions[chunk.palette[support]].parts[0].material = 29;
  assert.equal(lampCoverOverrides(chunk).size,0);
});

test('lantern matching and both LOD tiers work across chunk boundaries', () => {
  const chunks = lantern([15,6,15]);
  const catalog = makeMaterials();
  let matches = 0;
  for (const chunk of chunks) {
    const replacements = lampCoverOverrides(chunk,chunks.filter(other=>other!==chunk));
    matches += replacements.size;
    const stripped = structuredClone(chunk);
    const bytes = Buffer.from(stripped.sections[0].indices,'base64');
    for (const [at,key] of replacements) {
      const material = key === 'cover-material:28' ? `cover:750:0:wood-only-${at}` : key;
      if (key === 'cover-material:28') {
        const previous = chunk.palette[bytes.readUInt16LE(2*at)];
        stripped.compositions[material] = {parts:chunk.compositions[previous].parts.filter(part => part.slot >= 26)};
      }
      let index = stripped.palette.indexOf(material);
      if (index<0) index = stripped.palette.push(material)-1;
      bytes.writeUInt16LE(index,2*at);
    }
    stripped.sections[0].indices = bytes.toString('base64');
    const actual = sampleChunk(chunk,catalog,chunks.filter(other=>other!==chunk));
    const expected = sampleChunk(stripped,catalog);
    assert.deepEqual(actual,expected);
    assert.deepEqual(outerChunk(actual),outerChunk(expected));
  }
  assert.equal(matches,29);
});
