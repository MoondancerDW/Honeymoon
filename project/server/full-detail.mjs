import {closeSync,openSync,readFileSync,readSync} from 'node:fs';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {DETAIL_HEADER_SIZE,DETAIL_INDEX_OFFSET,FULL_DETAIL_VERSION,detailCoverage,detailSlot} from '../world/full-detail.mjs';

const maxChunkBytes=32*1024*1024;

export function loadFullDetail(directory,sourceHash) {
  let source;
  try { source=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8')); }
  catch (error) {
    if (error.code==='ENOENT') return null;
    throw error;
  }
  if (source.sourceHash!==sourceHash) return null;
  const {version,hash,bounds,regions}=source;
  if (version!==FULL_DETAIL_VERSION || !/^[0-9a-f]{64}$/.test(hash) ||
      !Array.isArray(bounds) || bounds.length!==4 || !bounds.every(Number.isInteger) ||
      !Array.isArray(regions) || !regions.length || !regions.every(region=>Array.isArray(region) &&
        region.length===3 && Number.isInteger(region[0]) && Number.isInteger(region[1]) &&
        typeof region[2]==='string' && /^[A-Za-z0-9+/]{171}=$/.test(region[2]))) {
    throw new Error('Invalid generated full detail manifest');
  }
  const descriptor={version,hash,bounds,regions};
  const hasChunk=detailCoverage(descriptor);
  const indexes=new Map();

  function chunkAt(x,z) {
    if (!hasChunk(x,z)) return null;
    const key=`${x>>5}.${z>>5}`;
    const fd=openSync(join(directory,`${key}.bin`),'r');
    try {
      let index=indexes.get(key);
      if (!index) {
        index=Buffer.alloc(DETAIL_HEADER_SIZE);
        if (readSync(fd,index,0,index.length,0)!==index.length || index.toString('ascii',0,4)!=='HDTL' ||
            index.readUInt16LE(4)!==FULL_DETAIL_VERSION) throw new Error(`Invalid full detail index ${key}`);
        if (indexes.size>=24) indexes.delete(indexes.keys().next().value);
        indexes.set(key,index);
      }
      const entry=DETAIL_INDEX_OFFSET+8*detailSlot(x,z);
      const offset=index.readUInt32LE(entry), length=index.readUInt32LE(entry+4);
      if (offset<DETAIL_HEADER_SIZE || !length || length>maxChunkBytes) throw new Error(`Invalid full detail chunk ${x},${z}`);
      const data=Buffer.allocUnsafe(length);
      if (readSync(fd,data,0,length,offset)!==length) throw new Error(`Truncated full detail chunk ${x},${z}`);
      return JSON.parse(gunzipSync(data,{maxOutputLength:maxChunkBytes}).toString('utf8'));
    } finally {closeSync(fd);}
  }
  return {descriptor,hasChunk,chunkAt};
}
