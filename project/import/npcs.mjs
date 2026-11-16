import { mkdir,readFile,readdir,writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname,join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { isMainThread,parentPort,workerData,Worker } from 'node:worker_threads';
import { gunzipSync } from 'node:zlib';
import { canonicalJson,readNbt,readRegionChunk } from './nbt.mjs';

const regionName = /^r\.(-?\d+)\.(-?\d+)\.mca$/;
const sharedFiles = ['dialog','quests','transport','factions','recipes','bank'];

async function scanRegions({world,regions,bounds:[west,north,east,south]}) {
  const entities = [];
  let chunks = 0;
  for (const {name,rx,rz} of regions) {
    const bytes = await readFile(join(world,'region',name));
    for (let z=Math.max(north,rz*32);z<=Math.min(south,rz*32+31);z++) {
      for (let x=Math.max(west,rx*32);x<=Math.min(east,rx*32+31);x++) {
        const cell = readRegionChunk(bytes,x,z);
        if (!cell) continue;
        chunks++;
        for (const entity of cell.Entities ?? []) {
          if (typeof entity.id==='string' && /^npc/i.test(entity.id)) entities.push({x,z,entity});
        }
      }
    }
  }
  return {entities,chunks};
}

if (!isMainThread) parentPort.postMessage(await scanRegions(workerData));

export async function exportNativeNpcs({world,out,manifest,workers=Math.min(6,availableParallelism())}) {
  const {bounds,hash} = JSON.parse(await readFile(manifest,'utf8'));
  if (bounds?.length!==4 || !bounds.every(Number.isSafeInteger) || bounds[0]>bounds[2] || bounds[1]>bounds[3]) {
    throw new Error('Expected full-world manifest with inclusive chunk bounds');
  }
  if (!Number.isInteger(workers) || workers<1 || workers>16) throw new Error('Expected 1 to 16 workers');
  const [west,north,east,south] = bounds;
  const regions = (await readdir(join(world,'region'))).flatMap(name=>{
    const match=regionName.exec(name);
    if (!match) return [];
    const rx=Number(match[1]),rz=Number(match[2]);
    if (rx*32+31<west || rx*32>east || rz*32+31<north || rz*32>south) return [];
    return [{name,rx,rz}];
  }).sort((a,b)=>a.rz-b.rz || a.rx-b.rx);
  if (!regions.length) throw new Error('No original regions inside the manifest bounds');
  const jobs = Array.from({length:Math.min(workers,regions.length)},()=>[]);
  regions.forEach((region,index)=>jobs[index%jobs.length].push(region));
  const engines = jobs.map(regions=>new Worker(new URL(import.meta.url),{workerData:{regions,world,bounds}}));
  let result;
  try {
    result=await Promise.all(engines.map(engine=>new Promise((done,fail)=>{
      engine.once('message',done);
      engine.once('error',fail);
      engine.once('exit',code=>{if (code) fail(new Error(`NPC region worker exited with ${code}`));});
    })));
  } finally {
    await Promise.all(engines.map(engine=>engine.terminate()));
  }
  const entities=result.flatMap(part=>part.entities).sort((a,b)=>a.z-b.z||a.x-b.x)
    .map(row=>JSON.parse(canonicalJson(row.entity)));
  const shared=Object.fromEntries(await Promise.all(sharedFiles.map(async name=>{
    try {
      const raw=await readFile(join(world,'customnpcs',name+'.dat'));
      return [name,JSON.parse(canonicalJson(readNbt(gunzipSync(raw))))];
    } catch (error) {
      if (error.code==='ENOENT') return [name,{}];
      throw error;
    }
  })));
  const report={source:hash,regions:regions.length,chunks:result.reduce((total,part)=>total+part.chunks,0),
    npcTypes:{},data:{}};
  for (const row of entities) report.npcTypes[row.id]=(report.npcTypes[row.id]??0)+1;
  for (const [name,data] of Object.entries(shared)) {
    report.data[name]={lists:Object.fromEntries(Object.entries(data).filter(([,value])=>Array.isArray(value))
      .map(([key,value])=>[key,value.length]))};
  }
  out=resolve(out);
  const sourceRoot=resolve(world).toLowerCase();
  if (out.toLowerCase().startsWith(sourceRoot+(/[\\/]$/.test(sourceRoot)?'':process.platform==='win32'?'\\':'/'))) {
    throw new Error('Export must be outside the original save');
  }
  await mkdir(dirname(out),{recursive:true});
  await writeFile(out,JSON.stringify({report,entities,shared})+'\n',{flag:'wx'});
  return report;
}

if (isMainThread && process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const {values}=parseArgs({options:{world:{type:'string'},out:{type:'string'},manifest:{type:'string'},workers:{type:'string'}}});
  if (!values.world||!values.out||!values.manifest) throw new Error('Use --world, --manifest and --out');
  const report=await exportNativeNpcs({...values,workers:values.workers&&Number(values.workers)});
  console.log(JSON.stringify(report));
}
