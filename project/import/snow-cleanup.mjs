import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {loadBase} from '../server/base.mjs';

const snowLayer = /^legacy:78:(\d+)$/;
const fullSnow = /^legacy:80:/;
const canopy = /^(?:legacy:(?:17|18|161|162):)/;
const roof = /^(?:cover:|legacy:(?:5|35|44|53|67|108|109|114|126|128|134|135|136|28(?:0[89]|[12]\d|3[01])|3230|324[789]|40[3456]\d):)/;
const chunkKey = (x,z) => `${x >> 4}.${z >> 4}`;

export function findStraySnow(snow,cellAt) {
  const buckets = new Map();
  for (const point of snow) {
    const key = chunkKey(point.x,point.z);
    if (!buckets.has(key)) buckets.set(key,[]);
    buckets.get(key).push(point);
  }
  function snowyArea({x,y,z}) {
    let nearby = 0, connected = 0;
    for (let cz=(z-7)>>4; cz<=(z+7)>>4; cz++) for (let cx=(x-7)>>4; cx<=(x+7)>>4; cx++) {
      for (const point of buckets.get(`${cx}.${cz}`) ?? []) {
        const dx = point.x-x, dz = point.z-z, dy = Math.abs(point.y-y);
        if (dx*dx+dz*dz > 49 || dy > 6) continue;
        nearby += point.full ? 2 : 1;
        if (Math.abs(dx)<=2 && Math.abs(dz)<=2 && dy<=1) connected++;
        if (nearby >= 10 || connected >= 4) return true;
      }
    }
    return false;
  }
  return snow.filter(point => {
    if (point.full || point.layers > 2) return false;
    const {x,y,z} = point;
    const support = cellAt(x,y-1,z);
    let sheltered = roof.test(support) || canopy.test(support);
    for (let dy=1; dy<=7 && !sheltered; dy++) sheltered = canopy.test(cellAt(x,y+dy,z));
    return sheltered && !snowyArea(point);
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
      markers[i] = layer ? 1+Number(layer[1]) : fullSnow.test(palette[i]) ? 255 : 0;
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
