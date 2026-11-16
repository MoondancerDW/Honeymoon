import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {loadBase} from '../server/base.mjs';

const snowLayer = /^legacy:78:(\d+)$/;
const fullSnow = /^legacy:80:/;
const highGround = new Set([1,2,3,12,13,24,82,110]);
const chunkKey = (x,z) => `${x >> 4}.${z >> 4}`;
const cellKey = (x,y,z) => `${x},${y},${z}`;
const localRadius = 7;
export const SNOW_CONTEXT_RADIUS = 24;
const highSnowY = 96;

export function findStraySnow(snow,cellAt,candidates = snow) {
  const buckets = new Map();
  const cellIndices = new Map();
  for (const point of snow) {
    const key = chunkKey(point.x,point.z);
    if (!buckets.has(key)) buckets.set(key,[]);
    buckets.get(key).push(point);
  }
  function snowAt(x,y,z) {
    const key = chunkKey(x,z);
    const points = buckets.get(key);
    if (!points) return undefined;
    if (!cellIndices.has(key)) cellIndices.set(key,new Map(points.map(point=>[cellKey(point.x,point.y,point.z),point])));
    return cellIndices.get(key).get(cellKey(x,y,z));
  }
  function inSnowyTerrain({x,y,z}) {
    let nearby = 0, regional = 0;
    for (let cz=(z-SNOW_CONTEXT_RADIUS)>>4; cz<=(z+SNOW_CONTEXT_RADIUS)>>4; cz++) {
      for (let cx=(x-SNOW_CONTEXT_RADIUS)>>4; cx<=(x+SNOW_CONTEXT_RADIUS)>>4; cx++) {
        for (const point of buckets.get(`${cx}.${cz}`) ?? []) {
          const dx = point.x-x, dz = point.z-z, dy = Math.abs(point.y-y);
          const distance = dx*dx+dz*dz;
          if (distance > SNOW_CONTEXT_RADIUS**2 || dy > 16) continue;
          const weight = point.full ? 2 : 1;
          regional += weight;
          if (distance <= localRadius**2 && dy <= 6) {
            if (point.full) return true;
            nearby += weight;
          }
          if (nearby >= 10 || regional >= 48) return true;
        }
      }
    }
    return false;
  }
  function inContinuousPatch(origin) {
    const seen = new Set([origin]);
    const queue = [origin];
    for (const {x,y,z} of queue) {
      for (let dz=-1; dz<=1; dz++) for (let dx=-1; dx<=1; dx++) {
        if (dx === 0 && dz === 0) continue;
        for (let dy=-1; dy<=1; dy++) {
          const next = snowAt(x+dx,y+dy,z+dz);
          if (!next || seen.has(next)) continue;
          if (next.full || next.layers > 2) return true;
          seen.add(next);
          if (seen.size >= 10) return true;
          queue.push(next);
        }
      }
    }
    return false;
  }
  return candidates.filter(point => {
    if (point.full || point.layers > 2) return false;
    const {x,y,z} = point;
    if (y >= highSnowY) {
      const supportId = point.supportId ?? Number(/^legacy:(\d+):/.exec(cellAt?.(x,y-1,z))?.[1]);
      if (highGround.has(supportId)) return false;
    }
    return !inSnowyTerrain(point) && !inContinuousPatch(point);
  });
}

export function buildSnowCleanup(directory,output) {
  const base = loadBase(directory,{cleanSnow:false});
  const {manifest} = base;
  const snow = [];
  for (const [cx,cz] of manifest.chunks) {
    const chunk = JSON.parse(readFileSync(join(directory,'chunks',`${cx}.${cz}.json`),'utf8'));
    const palette = chunk.palette ?? manifest.palette;
    const markers = new Uint8Array(palette.length);
    let marked = false;
    for (let i=0; i<palette.length; i++) {
      const layer = snowLayer.exec(palette[i]);
      markers[i] = layer ? 1+(Number(layer[1]) & 7) : fullSnow.test(palette[i]) ? 255 : 0;
      marked ||= markers[i]>0;
    }
    if (!marked) continue;
    for (const section of chunk.sections) {
      const bytes = Buffer.from(section.indices,'base64');
      const cells = new Uint16Array(bytes.buffer,bytes.byteOffset,bytes.length/2);
      for (let i=0; i<cells.length; i++) {
        const marker = markers[cells[i]];
        if (marker) snow.push({x:cx*16+(i&15),y:section.y*16+(i>>8),z:cz*16+((i>>4)&15),
          full:marker===255,layers:marker});
      }
    }
  }
  const removed = findStraySnow(snow,(...point) => base.getCell(...point).key);
  const chunks = {};
  for (const {x,y,z} of removed) (chunks[chunkKey(x,z)] ??= []).push((y << 8) | ((z & 15) << 4) | (x & 15));
  writeFileSync(output,JSON.stringify({version:1,world:base.hash,chunks})+'\n',{flag:'wx'});
  return {layers:snow.filter(point=>!point.full).length,removed:removed.length,chunks:Object.keys(chunks).length};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const {values} = parseArgs({options:{world:{type:'string'},out:{type:'string'}}});
  if (!values.world || !values.out) throw new Error('Use --world GENERATED_WORLD --out SNOW_CLEANUP_JSON');
  console.log(buildSnowCleanup(resolve(values.world),resolve(values.out)));
}
