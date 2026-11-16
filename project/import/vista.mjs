import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {gzipSync} from 'node:zlib';
import {readRegionChunk} from './nbt.mjs';
import {makeMaterials} from './lod-mesh.mjs';
import {VISTA_VERSION,VISTA_STEP,VISTA_SIDE,VISTA_RECORD,vistaBytes,vistaCell} from '../client/vista-format.mjs';

const regionName = /^r\.(-?\d+)\.(-?\d+)\.mca$/;
const atlas = makeMaterials();
const atlasEntry = new Map();

function material(id,meta) {
  const key = id * 16 + meta;
  if (!atlasEntry.has(key)) {
    const part = atlas.materials[atlas.materialFor(`legacy:${id}:${meta}`)];
    const shape = part?.shape;
    const style = part?.sides[3] && atlas.styles[part.sides[3]];
    atlasEntry.set(key,shape && style ? {tile:style[0],light:style[1],rgb:style.slice(3),height:shape.y1} : null);
  }
  return atlasEntry.get(key);
}

function sampleColumn(sections, height, x, z) {
  for (let y=Math.min(255,height); y>=0; y--) {
    const section = sections[y>>4];
    if (!section) { y &= ~15; continue; }
    const index = x+16*z+256*(y&15);
    const shift = (index & 1) * 4;
    const id = section.Blocks[index] | ((section.Add?.[index>>1] >> shift & 15) << 8);
    if (!id) continue;
    const style = material(id,section.Data[index>>1] >> shift & 15);
    if (!style) continue;
    const packed = style.light === 256 ? 256 : ((section.SkyLight?.[index>>1] >> shift & 15) << 4) |
      (section.BlockLight?.[index>>1] >> shift & 15);
    return {height:y+style.height,tile:style.tile,light:packed || 240,rgb:style.rgb};
  }
}

function setChunk(content,chunk,cx,cz) {
  const sections = [];
  for (const section of chunk.Sections ?? []) if (section.Blocks?.length === 4096) sections[section.Y] = section;
  const highest = (sections.length << 4) - 1;
  if (highest < 0) return;
  const cells = 16 / VISTA_STEP;
  const samples = [];
  for (let sz=0; sz<cells; sz++) for (let sx=0; sx<cells; sx++) {
    samples.length = 0;
    for (let dz=1; dz<VISTA_STEP; dz+=2) for (let dx=1; dx<VISTA_STEP; dx+=2) {
      const x = sx*VISTA_STEP+dx, z = sz*VISTA_STEP+dz;
      const height = chunk.HeightMap?.[x+z*16];
      const sample = sampleColumn(sections,Number.isInteger(height) ? Math.min(highest,height) : highest,x,z);
      if (sample) samples.push(sample);
    }
    if (!samples.length) continue;
    samples.sort((a,b) => a.height-b.height);
    // Use the upper half of the height distribution so a roof or tree does
    // not flatten to the height of the surrounding path at the next tier.
    const {height,tile,light,rgb} = samples[Math.floor(samples.length * .6)];
    const index = vistaCell(cx*cells+sx,cz*cells+sz);
    content.writeUInt16LE(Math.round(height * 8),index);
    content.writeUInt16LE(tile,index+2);
    content.writeUInt16LE(light,index+4);
    content.set(rgb,index+6);
  }
}

export function buildVista(world,output,bounds,progress = () => {}) {
  if (!bounds || bounds.length !== 4 || !bounds.every(Number.isSafeInteger) || bounds[0] > bounds[2] || bounds[1] > bounds[3]) {
    throw new Error('Expected inclusive vista bounds in chunks: minX,minZ,maxX,maxZ');
  }
  const [minX,minZ,maxX,maxZ] = bounds;
  const source = resolve(world,'region');
  const out = resolve(output);
  if (existsSync(out)) throw new Error('Use a new vista output directory');
  mkdirSync(out,{recursive:true});
  const regions = [], payloads = new Map(), corrupt = [], files = readdirSync(source).sort();
  const digest = createHash('sha256');
  let chunks = 0, bytes = 0, gzipBytes = 0;
  for (const file of files) {
    const match = regionName.exec(file);
    if (!match) continue;
    const rx = Number(match[1]), rz = Number(match[2]);
    if (rx*32 > maxX || rx*32+31 < minX || rz*32 > maxZ || rz*32+31 < minZ) continue;
    const raw = readFileSync(join(source,file));
    const content = Buffer.alloc(vistaBytes);
    content.write('HVST');
    content[4] = VISTA_VERSION;
    content[5] = VISTA_STEP;
    let count = 0;
    for (let z=0; z<32; z++) for (let x=0; x<32; x++) {
      if (rx*32+x < minX || rx*32+x > maxX || rz*32+z < minZ || rz*32+z > maxZ) continue;
      if (raw.length < 8192 || raw.readUInt32BE(4*(x+32*z)) === 0) continue;
      try {
        const chunk = readRegionChunk(raw,rx*32+x,rz*32+z);
        if (chunk) { setChunk(content,chunk,x,z); count++; }
      } catch (error) {
        corrupt.push([rx*32+x,rz*32+z,error.message]);
      }
    }
    if (!count) continue;
    regions.push([rx,rz]);
    payloads.set(`${rx}.${rz}`,content);
    chunks += count;
    if (regions.length % 32 === 0) progress({regions:regions.length,chunks});
  }
  if (!regions.length) throw new Error('No readable Anvil regions for the distant vista');
  for (const [rx,rz] of regions) {
    const content = payloads.get(`${rx}.${rz}`);
    // Adjacent heights allow both render tiles to close the same cliff edge.
    for (const [dx,dz] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const neighbor = payloads.get(`${rx+dx}.${rz+dz}`);
      if (!neighbor) continue;
      for (let i=0; i<VISTA_SIDE; i++) {
        const targetX = dx === 0 ? i : dx < 0 ? -1 : VISTA_SIDE;
        const targetZ = dz === 0 ? i : dz < 0 ? -1 : VISTA_SIDE;
        const sourceX = dx === 0 ? i : dx < 0 ? VISTA_SIDE-1 : 0;
        const sourceZ = dz === 0 ? i : dz < 0 ? VISTA_SIDE-1 : 0;
        const start = vistaCell(sourceX,sourceZ);
        neighbor.copy(content,vistaCell(targetX,targetZ),start,start+VISTA_RECORD);
      }
    }
    const name = `${rx}.${rz}.bin`;
    const packed = gzipSync(content,{level:3});
    writeFileSync(join(out,name),content);
    writeFileSync(join(out,name+'.gz'),packed);
    digest.update(name+'\n');
    digest.update(content);
    bytes += content.length;
    gzipBytes += packed.length;
  }
  const manifest = {version:VISTA_VERSION,hash:digest.digest('hex'),regions,bounds,chunks,bytes,gzipBytes,corrupt};
  writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest)+'\n');
  return manifest;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const {values} = parseArgs({options:{world:{type:'string'},out:{type:'string'},bounds:{type:'string'}}});
  const result = buildVista(values.world,values.out,values.bounds?.split(',').map(Number),status=>console.log(JSON.stringify(status)));
  console.log(JSON.stringify({...result,regions:result.regions.length,corrupt:result.corrupt.length}));
}
