import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {readRegionChunk} from './nbt.mjs';

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
  const {values: {world,converted,out}} = parseArgs({options:{world:{type:'string'},converted:{type:'string'},out:{type:'string'}}});
  console.log(JSON.stringify(buildBiomes(world,converted,out)));
}
