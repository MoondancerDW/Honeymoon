import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {gzipSync} from 'node:zlib';
import {readRegionChunk} from './nbt.mjs';
import {makeMaterials} from './lod-mesh.mjs';
import {findStraySnow,SNOW_CONTEXT_RADIUS} from './snow-cleanup.mjs';
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

function sourceId(section,index) {
  const shift = (index & 1) * 4;
  return section.Blocks[index] | ((section.Add?.[index>>1] >> shift & 15) << 8);
}

function sampleColumn(sections, height, x, z, removedSnow) {
  for (let y=Math.min(255,height); y>=0; y--) {
    const section = sections[y>>4];
    if (!section) { y &= ~15; continue; }
    const index = x+16*z+256*(y&15);
    const shift = (index & 1) * 4;
    const id = sourceId(section,index);
    if (!id) continue;
    const metadata = section.Data[index>>1] >> shift & 15;
    if (id === 78 && removedSnow?.has(y*256+(index&255))) continue;
    const style = material(id,metadata);
    if (!style) continue;
    const packed = style.light === 256 ? 256 : ((section.SkyLight?.[index>>1] >> shift & 15) << 4) |
      (section.BlockLight?.[index>>1] >> shift & 15);
    return {height:y+style.height,tile:style.tile,light:packed || 240,rgb:style.rgb,thinSnow:id === 78 && (metadata&7) < 2};
  }
}

function chunkSections(chunk) {
  const sections = [];
  for (const section of chunk.Sections ?? []) if (section.Blocks?.length === 4096) sections[section.Y] = section;
  return sections;
}

function setChunk(content,chunk,cx,cz,removedSnow) {
  const sections = chunkSections(chunk);
  const highest = (sections.length << 4) - 1;
  if (highest < 0) return null;
  const cells = 16 / VISTA_STEP;
  const samples = [];
  let thinSnow;
  for (let sz=0; sz<cells; sz++) for (let sx=0; sx<cells; sx++) {
    samples.length = 0;
    for (let dz=1; dz<VISTA_STEP; dz+=2) for (let dx=1; dx<VISTA_STEP; dx+=2) {
      const x = sx*VISTA_STEP+dx, z = sz*VISTA_STEP+dz;
      const height = chunk.HeightMap?.[x+z*16];
      const sample = sampleColumn(sections,Number.isInteger(height) ? Math.min(highest,height) : highest,x,z,removedSnow);
      if (sample) {
        samples.push(sample);
        if (sample.thinSnow) {
          thinSnow ??= new Set();
          thinSnow.add(z*16+x);
        }
      }
    }
    const index = vistaCell(cx*cells+sx,cz*cells+sz);
    if (!samples.length) {
      if (removedSnow) content.fill(0,index,index+VISTA_RECORD);
      continue;
    }
    samples.sort((a,b) => a.height-b.height);
    // Use the upper half of the height distribution so a roof or tree does
    // not flatten to the height of the surrounding path at the next tier.
    const {height,tile,light,rgb} = samples[Math.floor(samples.length * .6)];
    content.writeUInt16LE(Math.round(height * 8),index);
    content.writeUInt16LE(tile,index+2);
    content.writeUInt16LE(light,index+4);
    content.set(rgb,index+6);
  }
  return thinSnow;
}

function collectSnow(chunk,snow,candidates,samples) {
  const sections = chunkSections(chunk);
  for (const section of sections) {
    if (!section) continue;
    for (const id of [78,80]) {
      for (let index=section.Blocks.indexOf(id); index>=0; index=section.Blocks.indexOf(id,index+1)) {
        if (sourceId(section,index) !== id) continue;
        const y = section.Y*16+(index>>8);
        const layers = id === 80 ? 8 : (section.Data[index>>1] >> ((index&1)*4) & 7)+1;
        const below = sections[(y-1)>>4];
        const supportId = below ? sourceId(below,(index-256)&4095) : 0;
        const point = {x:chunk.xPos*16+(index&15),y,z:chunk.zPos*16+((index>>4)&15),layers,full:id===80,supportId};
        snow.push(point);
        if (id === 78 && layers <= 2 && samples?.has(index&255)) candidates.push(point);
      }
    }
  }
}

function removeScatteredSnow(source,bounds,rx,rz,raw,content,candidateChunks) {
  if (!candidateChunks.size) return;
  const radius = Math.ceil(SNOW_CONTEXT_RADIUS/16);
  const [minX,minZ,maxX,maxZ] = bounds;
  const sources = new Map([[`${rx},${rz}`,raw]]);
  function readChunk(x,z) {
    const sourceX = x>>5, sourceZ = z>>5;
    const key = `${sourceX},${sourceZ}`;
    if (!sources.has(key)) {
      const file = join(source,`r.${sourceX}.${sourceZ}.mca`);
      sources.set(key,existsSync(file) ? readFileSync(file) : null);
    }
    const region = sources.get(key);
    if (!region) return null;
    try { return readRegionChunk(region,x,z); }
    catch { return null; } // The main pass reports unreadable chunks in the manifest.
  }
  const nearby = new Map();
  for (const {x:cx,z:cz} of candidateChunks.values()) {
    for (let z=Math.max(minZ,cz-radius);z<=Math.min(maxZ,cz+radius);z++) {
      for (let x=Math.max(minX,cx-radius);x<=Math.min(maxX,cx+radius);x++) nearby.set(`${x},${z}`,[x,z]);
    }
  }
  const snow = [], candidates = [];
  for (const [key,[x,z]] of nearby) {
    const chunk = readChunk(x,z);
    if (chunk) collectSnow(chunk,snow,candidates,candidateChunks.get(key)?.samples);
  }
  const removed = new Map();
  for (const {x,y,z} of findStraySnow(snow,undefined,candidates)) {
    const key = `${x>>4},${z>>4}`;
    if (!removed.has(key)) removed.set(key,new Set());
    removed.get(key).add(y*256+(z&15)*16+(x&15));
  }
  for (const [key,offsets] of removed) {
    const {x,z} = candidateChunks.get(key);
    const chunk = readChunk(x,z);
    if (chunk) setChunk(content,chunk,x&31,z&31,offsets);
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
    const snowCandidates = new Map();
    for (let z=0; z<32; z++) for (let x=0; x<32; x++) {
      if (rx*32+x < minX || rx*32+x > maxX || rz*32+z < minZ || rz*32+z > maxZ) continue;
      if (raw.length < 8192 || raw.readUInt32BE(4*(x+32*z)) === 0) continue;
      try {
        const cx = rx*32+x, cz = rz*32+z;
        const chunk = readRegionChunk(raw,cx,cz);
        if (chunk) {
          const samples = setChunk(content,chunk,x,z);
          if (samples) snowCandidates.set(`${cx},${cz}`,{x:cx,z:cz,samples});
          count++;
        }
      } catch (error) {
        corrupt.push([rx*32+x,rz*32+z,error.message]);
      }
    }
    if (!count) continue;
    removeScatteredSnow(source,bounds,rx,rz,raw,content,snowCandidates);
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
