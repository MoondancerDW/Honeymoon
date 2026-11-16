import {createReadStream, readFileSync} from 'node:fs';
import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {lodDistance,supportedLodVersion} from '../client/far-tile-format.mjs';
import {supportedVistaVersion} from '../client/vista-format.mjs';

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
  if (!supportedLodVersion(schemaVersion) || !/^[a-f0-9]{64}$/.test(contentHash) || !/^[a-f0-9]{64}$/.test(assetHash) || maxDistance !== lodDistance(schemaVersion) || tileChunks !== 4 ||
      !Array.isArray(regions) || !regions.length || !regions.every(coordinate)) {
    throw new Error('Invalid far terrain manifest');
  }
  const packs = new Set(regions.map(([x,z]) => `${x}.${z}`));
  return {directory,packs,descriptor:{version:schemaVersion,contentHash:assetHash,maxDistance,tileChunks,regions}};
}

export function loadVistaAssets(generated) {
  const directory = join(generated,'vista');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const {version,hash,regions} = manifest;
  if (!supportedVistaVersion(version) || !/^[0-9a-f]{64}$/.test(hash) ||
      !Array.isArray(regions) || !regions.length || !regions.every(coordinate)) throw new Error('Invalid vista manifest');
  return {directory,packs:new Set(regions.map(([x,z]) => `${x}.${z}`)),descriptor:{version,hash,regions}};
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
  const tile = /^\/generated\/lod\/([a-f0-9]{64})\/(-?\d+\.-?\d+)(\.outer)?\.bin$/.exec(path);
  if (!tile || tile[1] !== assets?.descriptor.contentHash || !assets.packs.has(tile[2]) ||
      tile[3] && assets.descriptor.maxDistance < 32) return false;
  return serveTile(join(assets.directory, `${tile[2]}${tile[3] ?? ''}.bin`),request,response,acceptsGzip);
}

export async function serveVistaTile(assets, request, response, path, acceptsGzip) {
  const tile = /^\/generated\/vista\/([a-f0-9]{64})\/(-?\d+\.-?\d+)\.bin$/.exec(path);
  if (!tile || tile[1] !== assets?.descriptor.hash || !assets.packs.has(tile[2])) return false;
  return serveTile(join(assets.directory,`${tile[2]}.bin`),request,response,acceptsGzip);
}

export function serveClimateMap(generated,request,response,acceptsGzip) {
  return serveTile(join(generated,'weather','biomes.bin'),request,response,acceptsGzip,'no-cache');
}

async function serveTile(rawPath,request,response,acceptsGzip,cacheControl='public, max-age=31536000, immutable') {
  let length = acceptsGzip ? await fileSize(`${rawPath}.gz`) : null;
  const compressed = length !== null;
  if (!compressed) length = await fileSize(rawPath);
  if (length === null) return false;
  const authenticated=response.getHeader('Vary')==='Cookie';
  response.writeHead(200, {
    'Content-Type':'application/octet-stream', 'Content-Length':length, Vary:authenticated?'Cookie, Accept-Encoding':'Accept-Encoding',
    'Cache-Control':authenticated?`private, ${cacheControl.replace(/^public, /,'')}`:cacheControl,
    ...(compressed && {'Content-Encoding':'gzip'}),
  });
  if (request.method === 'HEAD') response.end();
  else await pipeline(createReadStream(compressed ? `${rawPath}.gz` : rawPath), response);
  return true;
}
