import {verifyAltitudeAsset} from './altitude-assets.mjs';
import {missingTerrain,savePrefetchedTerrain,terrainCacheLimits,terrainCacheUsage} from './terrain-cache.mjs';
import {planTerrainPreload} from './terrain-preload-plan.mjs';
import {readVista} from './vista-format.mjs';

const batchSize=64;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let deferred=false;

class PreloadFailure extends Error {
  constructor(phase) {
    super(`Could not save terrain preload: ${phase}`);
    this.phase=phase;
  }
}

async function save(path,blob,{bytes,count}) {
  const result=await savePrefetchedTerrain(path,blob,{bytes,count});
  if (result==='saved') return;
  if (result==='quota') throw new PreloadFailure('quota');
  if (result==='obsolete') throw new PreloadFailure('unavailable');
  if (result==='limit') throw new PreloadFailure('limited');
  throw new PreloadFailure('storage');
}

async function backgroundFetch(path,timeout) {
  while (deferred) await sleep(1200);
  return fetch(path,{priority:'low',signal:AbortSignal.timeout(timeout)});
}

async function fetchPacket(layer,hash,start,count) {
  const query=new URLSearchParams({layer,hash,start:String(start),count:String(count)});
  for (let attempt=0;attempt<4;attempt++) {
    const response=await backgroundFetch('/api/terrain-preload?'+query,60_000);
    if (response.ok) return response.arrayBuffer();
    if (response.status!==429 && response.status<500) throw new Error('Terrain preload returned '+response.status);
    await sleep(1500*2**attempt);
  }
  throw new Error('Terrain preload is busy');
}

async function storePacket(buffer,entry,paths) {
  const packet=new DataView(buffer);
  let offset=4;
  const count=packet.getUint32(0,true);
  if (!count || count>paths.length) throw new Error('Invalid terrain packet size');
  for(let i=0;i<count;i++) {
    const size=packet.getUint32(offset,true);
    offset+=4;
    if (!size || offset+size>buffer.byteLength) throw new Error('Truncated terrain packet');
    const gzip=new Blob([new Uint8Array(buffer,offset,size)]);
    const decoded=await new Response(gzip.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    if (entry.layer==='vista') readVista(decoded);
    else if (decoded.byteLength<72 || new DataView(decoded).getUint32(0)!==0x484c4f44) {
      throw new Error('Invalid terrain tile');
    }
    await save(paths[i],new Blob([decoded],{type:'application/octet-stream'}),entry);
    offset+=size;
  }
  if (offset!==buffer.byteLength) throw new Error('Terrain packet has unexpected data');
  return count;
}

async function preload(options) {
  const response=await backgroundFetch('/api/terrain-preload/plan',60_000);
  if (!response.ok) {
    if (response.status>=400 && response.status<500 && response.status!==429) throw new PreloadFailure('unavailable');
    throw new Error('Terrain preload plan returned '+response.status);
  }
  const {layers,skipped,unavailable}=planTerrainPreload(options,(await response.json()).layers,terrainCacheLimits(options));
  const pathsToKeep=layers.flatMap(layer=>layer.paths);
  const total=pathsToKeep.length;
  const absent=total ? await missingTerrain(pathsToKeep) : [];
  if (absent===null) throw new PreloadFailure('storage');
  const missing=new Set(absent);
  const done=()=>skipped.length?'limited':!total || unavailable.length?'unavailable':'ready';
  const send=phase=>self.postMessage({phase,total,loaded:total-missing.size,
    ...(skipped.length && {skipped}),...(unavailable.length && {unavailable})});
  if (!missing.size) {send(done());return;}
  send('loading');
  for (const entry of layers) {
    try {
      await preloadLayer(entry,missing,()=>send('loading'));
    } catch (error) {
      if (!(error instanceof PreloadFailure) || error.phase!=='limited') throw error;
      skipped.push(entry.layer);
    }
  }
  const remaining=await missingTerrain(layers.filter(entry=>!skipped.includes(entry.layer)).flatMap(entry=>entry.paths));
  if (remaining===null) throw new PreloadFailure('storage');
  if (remaining.length) {
    const usage=await terrainCacheUsage();
    for (const {layer,bytes} of layers) {
      if (!skipped.includes(layer) && bytes>usage?.buckets?.[layer]?.maxBytes) skipped.push(layer);
    }
    const skippedPaths=new Set(layers.filter(entry=>skipped.includes(entry.layer)).flatMap(entry=>entry.paths));
    if (remaining.some(path=>!skippedPaths.has(path))) throw new PreloadFailure('storage');
  }
  send(done());
}

async function preloadLayer(entry,missing,progress) {
  const {layer,hash,paths}=entry;
  if (layer==='altitude') {
    for (const path of paths) if (missing.has(path)) {
      const response=await backgroundFetch(path,30_000);
      await save(path,await verifyAltitudeAsset(path,response),entry);
      missing.delete(path);
      progress();
    }
    return;
  }
  for (let index=0;index<paths.length;) {
    if (!missing.has(paths[index])) {index++;continue;}
    let count=1;
    while (count<batchSize && index+count<paths.length && missing.has(paths[index+count])) count++;
    const packet=await fetchPacket(layer,hash,index,count);
    const stored=await storePacket(packet,entry,paths.slice(index,index+count));
    for (let i=0;i<stored;i++) missing.delete(paths[index+i]);
    index+=stored;
    progress();
    await sleep(45);
  }
}

self.onmessage=({data})=>{
  if (data.type==='defer') {deferred=data.enabled;return;}
  if (data.type!=='start') return;
  void preload(data).catch(error=>self.postMessage({phase:error instanceof PreloadFailure?error.phase:'retry'}));
};
