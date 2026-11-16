import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {gzipSync} from 'node:zlib';
import {readRegionChunk} from './nbt.mjs';

export function encodeBiomePalette(columns) {
  const palette=[...new Set(columns)];
  if (palette.length>16) return Buffer.concat([Buffer.of(0),columns]);
  const width=palette.length<=2 ? 1 : palette.length<=4 ? 2 : 4;
  const encoded=Buffer.alloc(1+palette.length+32*width);
  encoded[0]=palette.length;
  encoded.set(palette,1);
  const ids=new Map(palette.map((id,index)=>[id,index]));
  for (let i=0;i<columns.length;i++) {
    const bit=i*width;
    encoded[1+palette.length+(bit>>3)]|=ids.get(columns[i])<<(bit&7);
  }
  return encoded;
}

export function buildWorldBiomes(world, cropped, output) {
  const {bounds:[x0,z0,x1,z1],regions}=JSON.parse(readFileSync(cropped,'utf8'));
  const width=x1-x0+1, depth=z1-z0+1;
  const table=Buffer.alloc(16+4*width*depth);
  table.write('HBIO');
  table.writeUInt16LE(2,4);
  table.writeInt16LE(x0,6);
  table.writeInt16LE(z0,8);
  table.writeUInt16LE(width,10);
  table.writeUInt16LE(depth,12);
  const mixes=[];
  let chunks=0, bytes=table.length;
  for (const [rx,rz,mask] of regions) {
    const points=Buffer.from(mask,'base64');
    const raw=readFileSync(join(world,'region',`r.${rx}.${rz}.mca`));
    for (let slot=0;slot<1024;slot++) {
      if (!(points[slot>>3]&(1<<(slot&7)))) continue;
      const x=rx*32+(slot&31), z=rz*32+(slot>>5);
      const chunk=readRegionChunk(raw,x,z);
      const columns=chunk?.Biomes;
      if (columns?.length!==256 || columns.every(id=>id===255)) continue;
      let entry=columns[0]+1;
      if (!columns.every(id=>id===columns[0])) {
        entry=(bytes|0x80000000)>>>0;
        const packed=encodeBiomePalette(columns);
        mixes.push(packed);
        bytes+=packed.length;
      }
      table.writeUInt32LE(entry,16+4*((z-z0)*width+x-x0));
      chunks++;
    }
  }
  const map=Buffer.concat([table,...mixes],bytes);
  const compressed=gzipSync(map,{level:6});
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output+'.gz.tmp',compressed);
  writeFileSync(output+'.tmp',map);
  renameSync(output+'.gz.tmp',output+'.gz');
  renameSync(output+'.tmp',output);
  return {chunks,mixed:mixes.length,bytes,compressed:compressed.length};
}

function encodeColumns(columns) {
  const runs = [];
  for (let start=0;start<columns.length;) {
    let end = start+1;
    while (end<columns.length && columns[end]===columns[start]) end++;
    runs.push(columns[start],end-start-1);
    start=end;
  }
  return runs.length>=columns.length ? columns.toString('base64') : `r:${Buffer.from(runs).toString('base64')}`;
}

export function buildBiomes(world,converted,output) {
  const {chunks} = JSON.parse(readFileSync(join(converted,'world.json'),'utf8'));
  const regions = new Map();
  for (const point of chunks) {
    const [x,z] = point;
    const region = `r.${x>>5}.${z>>5}.mca`;
    if (!regions.has(region)) regions.set(region,[]);
    regions.get(region).push(point);
  }
  const result = [], counts = new Map();
  for (const [region,points] of regions) {
    const file = join(world,'region',region);
    if (!existsSync(file)) continue;
    const raw = readFileSync(file);
    for (const [x,z] of points) {
      const columns = readRegionChunk(raw,x,z)?.Biomes;
      if (columns?.length !== 256) continue;
      let uniform = columns[0] !== 255;
      for (const biome of columns) {
        uniform &&= biome === columns[0];
        counts.set(biome,(counts.get(biome) ?? 0)+1);
      }
      if (uniform || columns.some(biome=>biome!==255)) result.push([x,z,uniform ? columns[0] : encodeColumns(columns)]);
    }
  }
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify({version:1,chunks:result})+'\n');
  return {chunks:result.length,biomes:Object.fromEntries(counts)};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const {values: {world,converted,cropped,out}} = parseArgs({options:{world:{type:'string'},converted:{type:'string'},
    cropped:{type:'string'},out:{type:'string'}}});
  console.log(JSON.stringify(cropped ? buildWorldBiomes(world,cropped,out) : buildBiomes(world,converted,out)));
}
