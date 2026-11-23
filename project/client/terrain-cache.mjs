import {createPersistentCache} from './persistent-cache.mjs';

const chunkPath=/^\/generated\/world\/chunks\/([a-f0-9]{64})\/-?\d+\.-?\d+\.json(?:\?height=upper)?$/;
const tilePath=/^\/generated\/(lod|vista)\/([a-f0-9]{64})\/-?\d+\.-?\d+(\.outer)?\.bin$/;
const altitudePath=/^\/(?:altitude-heights\.png|altitude-colors\.webp|altitude-detail\.webp|altitude-landmark-data\.mjs)\?build=(\d+)$/;
const MiB=1024*1024;
const inactiveAge=45*24*60*60_000;

function partitionOf(url) {
  if (altitudePath.test(url)) return 'altitude';
  if (chunkPath.test(url)) return 'detailed';
  const tile=tilePath.exec(url);
  if (tile?.[1]==='lod') return tile[3]?'primitive':'simplified';
  if (tile && !tile[3]) return 'vista';
  return null;
}

function versionOf(url,scope) {
  if (scope==='altitude') return altitudePath.exec(url)?.[1];
  if (scope==='detailed') return chunkPath.exec(url)?.[1];
  return tilePath.exec(url)?.[2];
}

export function terrainCacheLimits({mobile=false,lowDevice=false}={}) {
  const detailed=mobile?(lowDevice?76:512):(lowDevice?226:2048);
  const simplified=lowDevice?(mobile?34:96):288;
  return {
    detailed:{maxBytes:detailed*MiB,maxEntries:detailed*64,maxAgeMs:inactiveAge},
    simplified:{maxBytes:simplified*MiB,maxEntries:4096,maxAgeMs:lowDevice?inactiveAge:Infinity,
      preserveOnQuota:!lowDevice},
    primitive:{maxBytes:192*MiB,maxEntries:4096,maxAgeMs:Infinity,preserveOnQuota:!lowDevice},
    vista:{maxBytes:64*MiB,maxEntries:2048,maxAgeMs:Infinity,preserveOnQuota:true},
    altitude:{maxBytes:4*MiB,maxEntries:16,maxAgeMs:Infinity,preserveOnQuota:true},
  };
}

const cache=createPersistentCache({name:'honeymoon-terrain-v1',partitionOf,versionOf,partitions:terrainCacheLimits(),
  quotaReliefPartitions:['detailed','simplified','primitive']});

export function configureTerrainCache(settings={}) {
  const {altitudeBuild,manifest,requestedAt}=settings;
  const versions={};
  if (Number.isSafeInteger(altitudeBuild)) versions.altitude=String(altitudeBuild);
  if (manifest) {
    versions.detailed=manifest.chunkCacheVersion??null;
    versions.primitive=versions.simplified=manifest.lod?.contentHash??null;
    versions.vista=manifest.vista?.hash??null;
  }
  return cache.configure(terrainCacheLimits(settings),Object.keys(versions).length?versions:undefined,requestedAt);
}

export const pruneTerrainCache=()=>cache.prune();
export const terrainCacheUsage=()=>cache.usage();
export const storePrefetchedTerrain=(url,blob)=>cache.put(url,blob);
export const savePrefetchedTerrain=(url,blob,requirements)=>cache.putWithStatus(url,blob,requirements);
export const missingTerrain=paths=>cache.missing(paths.filter(partitionOf));

export async function readTerrain(url,init,enabled,decode,{waitForStore=false,isStale}={}) {
  if (!enabled || !partitionOf(url)) {
    const value=await decode(await fetch(url,init));
    if (!isStale?.(value)) return value;
    try {
      return await decode(await fetch(url,{...init,cache:'reload'}));
    } catch {
      init?.signal?.throwIfAborted();
      return value;
    }
  }
  init?.signal?.throwIfAborted();
  const cached=await cache.get(url);
  init?.signal?.throwIfAborted();
  let stale;
  if (cached) {
    try {
      const value=await decode(new Response(cached));
      if (!isStale?.(value)) return value;
      stale=value;
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
      const saved=copy.blob().then(blob=>cache.put(url,blob)).catch(()=>{});
      if (waitForStore) await saved;
      return value;
    } catch (error) {
      void copy.body?.cancel().catch(()=>{});
      if (!retry || options?.signal?.aborted) throw error;
      return download({...options,cache:'reload'},false);
    }
  }
  try {
    return await (cached ? download({...init,cache:'reload'},false) : download(init,true));
  } catch (error) {
    init?.signal?.throwIfAborted();
    if (stale!==undefined) return stale;
    throw error;
  }
}
