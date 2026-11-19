import {altitudeAssetUrl,altitudeFiles,verifyAltitudeAsset} from './altitude-assets.mjs';
import {missingTerrain,storePrefetchedTerrain} from './terrain-cache.mjs';
import {readVista} from './vista-format.mjs';

const batchSize=64;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let deferred=false;

async function save(path,blob) {
  if (!await storePrefetchedTerrain(path,blob)) throw new DOMException('Terrain cache has no space','QuotaExceededError');
}

async function fetchPacket(layer,hash,start,count) {
  const query=new URLSearchParams({layer,hash,start:String(start),count:String(count)});
  for (let attempt=0;attempt<4;attempt++) {
    while (deferred) await sleep(1200);
    const response=await fetch('/api/terrain-preload?'+query,{priority:'low',signal:AbortSignal.timeout(60_000)});
    if (response.ok) return response.arrayBuffer();
    if (response.status!==429 && response.status<500) throw new Error('Terrain preload returned '+response.status);
    await sleep(1500*2**attempt);
  }
  throw new Error('Terrain preload is busy');
}

async function storePacket(buffer,layer,paths) {
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
    if (layer==='vista') readVista(decoded);
    else if (decoded.byteLength<72 || new DataView(decoded).getUint32(0)!==0x484c4f44) {
      throw new Error('Invalid terrain tile');
    }
    await save(paths[i],new Blob([decoded],{type:'application/octet-stream'}));
    offset+=size;
  }
  if (offset!==buffer.byteLength) throw new Error('Terrain packet has unexpected data');
  return count;
}

async function preload({manifest,build,simplified}) {
  const lod=manifest.lod;
  const vista=manifest.vista;
  const layers=[
    lod?.maxDistance>=32 && {layer:'primitive',hash:lod.contentHash,regions:lod.regions,directory:'lod',suffix:'.outer.bin'},
    vista && {layer:'vista',hash:vista.hash,regions:vista.regions,directory:'vista',suffix:'.bin'},
    simplified && lod && {layer:'simplified',hash:lod.contentHash,regions:lod.regions,directory:'lod',suffix:'.bin'},
  ].filter(Boolean);
  for(const layer of layers) {
    layer.paths=layer.regions.map(pair=>`/generated/${layer.directory}/${layer.hash}/${pair.join('.')}${layer.suffix}`);
  }
  const assets=vista ? altitudeFiles.map(path=>altitudeAssetUrl(path,build)) : [];
  const pathsToKeep=[...assets,...layers.flatMap(layer=>layer.paths)];
  const total=pathsToKeep.length;
  const absent=await missingTerrain(pathsToKeep);
  if (absent===null) throw new DOMException('Terrain cache unavailable','QuotaExceededError');
  const missing=new Set(absent);
  const send=(phase)=>self.postMessage({phase,total,loaded:total-missing.size});
  if (!missing.size) {send('ready');return;}
  send('loading');
  for (const url of assets) if (missing.has(url)) {
    const response=await fetch(url,{priority:'low',signal:AbortSignal.timeout(30_000)});
    await save(url,await verifyAltitudeAsset(url,response));
    missing.delete(url);
    send('loading');
  }
  for(const {layer,hash,paths} of layers) {
    for(let index=0;index<paths.length;) {
      if (!missing.has(paths[index])) {index++;continue;}
      let count=1;
      while(count<batchSize && index+count<paths.length && missing.has(paths[index+count])) count++;
      const packet=await fetchPacket(layer,hash,index,count);
      const stored=await storePacket(packet,layer,paths.slice(index,index+count));
      for(let i=0;i<stored;i++) missing.delete(paths[index+i]);
      index+=stored;
      send('loading');
      await sleep(45);
    }
  }
  const remaining=await missingTerrain(pathsToKeep);
  if (remaining===null || remaining.length) throw new DOMException('Terrain cache has no space','QuotaExceededError');
  send('ready');
}

self.onmessage=({data})=>{
  if (data.type==='defer') {deferred=data.enabled;return;}
  if (data.type!=='start') return;
  void preload(data).catch(error=>self.postMessage({phase:error.name==='QuotaExceededError'?'storage':'retry'}));
};
