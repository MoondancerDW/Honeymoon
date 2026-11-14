import {createReadStream, readFileSync} from 'node:fs';
import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {pipeline} from 'node:stream/promises';

const coordinate = point => Array.isArray(point) && point.length === 2 && point.every(Number.isSafeInteger);

export function loadLodAssets(generated, worldHash) {
  const directory = join(generated, 'lod');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const {schemaVersion, contentHash, assetHash, maxDistance, tileChunks, regions} = manifest;
  if (contentHash !== worldHash) return null;
  if (schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(contentHash) || !/^[a-f0-9]{64}$/.test(assetHash) || maxDistance !== 24 || tileChunks !== 4 ||
      !Array.isArray(regions) || !regions.length || !regions.every(coordinate)) {
    throw new Error('Invalid far terrain manifest');
  }
  const packs = new Set(regions.map(([x,z]) => `${x}.${z}`));
  return {directory, packs, descriptor:{version:schemaVersion, contentHash:assetHash, maxDistance, tileChunks}};
}

async function fileSize(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function serveLodTile(assets, request, response, path, acceptsGzip) {
  const tile = /^\/generated\/lod\/([a-f0-9]{64})\/(-?\d+\.-?\d+)\.bin$/.exec(path);
  if (!tile || tile[1] !== assets?.descriptor.contentHash || !assets.packs.has(tile[2])) return false;
  const rawPath = join(assets.directory, `${tile[2]}.bin`);
  let length = acceptsGzip ? await fileSize(`${rawPath}.gz`) : null;
  const compressed = length !== null;
  if (!compressed) length = await fileSize(rawPath);
  if (length === null) return false;
  response.writeHead(200, {
    'Content-Type':'application/octet-stream', 'Content-Length':length, Vary:'Accept-Encoding',
    'Cache-Control':'public, max-age=31536000, immutable', ...(compressed && {'Content-Encoding':'gzip'}),
  });
  if (request.method === 'HEAD') response.end();
  else await pipeline(createReadStream(compressed ? `${rawPath}.gz` : rawPath), response);
  return true;
}
