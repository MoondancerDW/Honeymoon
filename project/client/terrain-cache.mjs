import {createPersistentCache} from './persistent-cache.mjs';

const terrainPath = /^\/generated\/(?:world\/chunks\/[a-f0-9]{64}\/-?\d+\.-?\d+\.json(?:\?height=upper)?|(?:lod|vista)\/[a-f0-9]{64}\/-?\d+\.-?\d+(?:\.outer)?\.bin)$/;
const cache = createPersistentCache({name:'honeymoon-terrain-v1',maxBytes:160*1024*1024,maxEntries:2400,
  maxAgeMs:45*24*60*60_000});

export function pruneTerrainCache() {
  return cache.prune();
}

export async function readTerrain(url,init,enabled,decode) {
  if (!enabled || !terrainPath.test(url)) return decode(await fetch(url,init));
  init?.signal?.throwIfAborted();
  const cached=await cache.get(url);
  init?.signal?.throwIfAborted();
  if (cached) {
    try {
      return await decode(new Response(cached));
    } catch {
      await cache.delete(url);
    }
  }
  async function download(options,retry) {
    const response=await fetch(url,options);
    if (!response.ok) return decode(response);
    const copy=response.clone();
    try {
      const value=await decode(response);
      void copy.blob().then(blob=>cache.put(url,blob)).catch(()=>{});
      return value;
    } catch (error) {
      void copy.body?.cancel().catch(()=>{});
      if (!retry || options?.signal?.aborted) throw error;
      return download({...options,cache:'reload'},false);
    }
  }
  return cached ? download({...init,cache:'reload'},false) : download(init,true);
}
