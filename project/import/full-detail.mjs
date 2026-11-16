import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {availableParallelism} from 'node:os';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {isMainThread,parentPort,Worker} from 'node:worker_threads';
import {gzipSync} from 'node:zlib';
import {createChunkEncoder} from './anvil.mjs';
import {readRegionChunk} from './nbt.mjs';
import {DETAIL_HEADER_SIZE,DETAIL_INDEX_OFFSET,FULL_DETAIL_VERSION,detailSlot} from '../world/full-detail.mjs';

const pattern=/^r\.(-?\d+)\.(-?\d+)\.mca$/;
const within=(path,root)=>{
  const suffix=relative(root,path);
  return !isAbsolute(suffix) && suffix!=='..' && !suffix.startsWith(`..${sep}`);
};

const encode=createChunkEncoder();

function convertRegion({world,out,bounds,rx,rz}) {
  const [minX,minZ,maxX,maxZ]=bounds;
  const raw=readFileSync(join(world,'region',`r.${rx}.${rz}.mca`));
  const index=Buffer.alloc(DETAIL_HEADER_SIZE), mask=Buffer.alloc(128);
  index.write('HDTL');
  index.writeUInt16LE(FULL_DETAIL_VERSION,4);
  const parts=[index], errors=[];
  let count=0, bytes=DETAIL_HEADER_SIZE, rawBytes=0;
  for (let z=Math.max(rz*32,minZ);z<=Math.min(rz*32+31,maxZ);z++) {
    for (let x=Math.max(rx*32,minX);x<=Math.min(rx*32+31,maxX);x++) {
      try {
        const chunk=readRegionChunk(raw,x,z);
        if (!chunk) continue;
        const converted=Buffer.from(encode(chunk).bytes);
        const payload=gzipSync(converted,{level:1});
        const slot=detailSlot(x,z), entry=DETAIL_INDEX_OFFSET+8*slot;
        index.writeUInt32LE(bytes,entry);
        index.writeUInt32LE(payload.length,entry+4);
        mask[slot>>3] |= 1<<(slot&7);
        parts.push(payload);
        count++;
        bytes+=payload.length;
        rawBytes+=converted.length;
      } catch (error) {
        errors.push([x,z,error.message]);
      }
    }
  }
  const name = `${rx}.${rz}.bin`, data=Buffer.concat(parts,bytes);
  if (count) writeFileSync(join(out,name),data,{flag:'wx'});
  return {rx,rz,count,bytes:count ? bytes : 0,rawBytes,errors,mask:mask.toString('base64'),
    hash:count ? createHash('sha256').update(data).digest('hex') : null};
}

if (!isMainThread) parentPort.on('message',args=>parentPort.postMessage(convertRegion(args)));

export async function buildFullDetail({world,out,converted,bounds,workers=Math.min(6,availableParallelism())},progress=()=>{}) {
  if (!Array.isArray(bounds) || bounds.length!==4 || !bounds.every(value=>Number.isInteger(value)&&Math.abs(value)<=1_875_000) ||
      bounds[0]>bounds[2] || bounds[1]>bounds[3]) throw new Error('Expected inclusive detail bounds in chunks');
  if (!Number.isInteger(workers) || workers<1 || workers>16) throw new Error('Expected one to sixteen detail workers');
  world=realpathSync(resolve(world));
  converted=realpathSync(resolve(converted));
  const sourceHash=JSON.parse(readFileSync(join(converted,'world.json'),'utf8')).contentHash;
  if (!/^[0-9a-f]{64}$/.test(sourceHash)) throw new Error('Expected a converted Honeymoon world');
  out=resolve(out);
  if (within(out,world) || within(out,converted) || existsSync(out)) throw new Error('Use a new folder outside the source saves');
  mkdirSync(dirname(out),{recursive:true});
  out=join(realpathSync(dirname(out)),basename(out));
  if (within(out,world) || within(out,converted)) throw new Error('Detail output resolves into a source save');
  const [minX,minZ,maxX,maxZ]=bounds;
  const jobs=readdirSync(join(world,'region')).flatMap(file=>{
    const match=pattern.exec(file);
    if (!match) return [];
    const rx=Number(match[1]), rz=Number(match[2]);
    if (rx*32>maxX || rx*32+31<minX || rz*32>maxZ || rz*32+31<minZ) return [];
    return [{world,out,bounds,rx,rz}];
  }).sort((a,b)=>a.rz-b.rz || a.rx-b.rx);
  if (!jobs.length) throw new Error('No original regions inside detail bounds');
  mkdirSync(out);
  let next=0, finished=0, chunks=0, bytes=0, rawBytes=0;
  const results=new Array(jobs.length);
  const engines=Array.from({length:Math.min(workers,jobs.length)},()=>new Worker(new URL(import.meta.url)));
  try {
    await Promise.all(engines.map(engine=>new Promise((done,fail)=>{
      let index;
      function requestNext() {
        index=next++;
        if (index>=jobs.length) done();
        else engine.postMessage(jobs[index]);
      }
      engine.on('error',fail);
      engine.on('exit',code=>{if (code && index<jobs.length) fail(new Error(`Detail worker exited with ${code}`));});
      engine.on('message',result=>{
        results[index]=result;
        finished++;
        chunks+=result.count;
        bytes+=result.bytes;
        rawBytes+=result.rawBytes;
        if (finished%16===0 || finished===jobs.length) progress({finished,total:jobs.length,chunks,bytes,rawBytes});
        requestNext();
      });
      requestNext();
    })));
  } finally {
    await Promise.all(engines.map(engine=>engine.terminate()));
  }
  const errors=results.flatMap(row=>row.errors);
  if (errors.length) {
    writeFileSync(join(out,'errors.json'),JSON.stringify(errors)+'\n');
    throw new Error(`Detail conversion found ${errors.length} unreadable chunks. See errors.json`);
  }
  if (!chunks) throw new Error('No readable chunks inside detail bounds');
  const covered=results.filter(row=>row.count);
  const regions=covered.map(({rx,rz,mask})=>[rx,rz,mask]);
  const hashes=Object.fromEntries(covered.map(({rx,rz,hash})=>[`${rx}.${rz}`,hash]));
  const hash=createHash('sha256').update(JSON.stringify([sourceHash,bounds,hashes])).digest('hex');
  const manifest={version:FULL_DETAIL_VERSION,sourceHash,hash,bounds,regions,hashes,chunks,bytes,rawBytes};
  writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest)+'\n',{flag:'wx'});
  return manifest;
}

if (isMainThread && process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const {values}=parseArgs({options:{world:{type:'string'},converted:{type:'string'},out:{type:'string'},bounds:{type:'string'},workers:{type:'string'}}});
  const start=performance.now();
  const {regions,hashes,...stats}=await buildFullDetail({...values,bounds:values.bounds?.split(',').map(Number),
    workers:values.workers && Number(values.workers)},status=>console.log(JSON.stringify(status)));
  console.log(JSON.stringify({...stats,regions:regions.length,seconds:Math.round((performance.now()-start)/100)/10}));
}
