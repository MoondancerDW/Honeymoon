import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { RequestError } from './errors.mjs';

const maxFiles = 64;
const maxPacketBytes = 8 * 1024 * 1024;
const maxActive = 3;

function wholeNumber(value) {
  if (!/^\d+$/.test(value ?? '')) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function integerBytes(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

export function createTerrainPreload(lod, vista) {
  const active = new Set();
  const layers = new Map();
  if (lod) layers.set('simplified', { assets:lod, hash:lod.descriptor.contentHash, suffix:'.bin.gz' });
  if (lod?.descriptor.maxDistance >= 32) {
    layers.set('primitive', { assets:lod, hash:lod.descriptor.contentHash, suffix:'.outer.bin.gz' });
  }
  if (vista) layers.set('vista', { assets:vista, hash:vista.descriptor.hash, suffix:'.bin.gz' });

  return async function terrainPreload(response, params, player) {
    const layer = layers.get(params.get('layer'));
    const start = wholeNumber(params.get('start'));
    const count = wholeNumber(params.get('count'));
    if (!layer) throw new RequestError(404, 'terrain_layer_missing');
    if (layer.hash !== params.get('hash')) throw new RequestError(409, 'terrain_version_changed');
    const { regions } = layer.assets.descriptor;
    if (start === null || start >= regions.length || count === null || count < 1 || count > maxFiles) {
      throw new RequestError(400, 'invalid_terrain_packet');
    }
    if (active.has(player) || active.size >= maxActive) {
      response.setHeader('Retry-After', '1');
      throw new RequestError(429, 'terrain_preload_busy');
    }

    active.add(player);
    try {
      const files = [];
      let length = 4;
      for (const [x,z] of regions.slice(start, start + count)) {
        if (response.destroyed) return;
        const path = join(layer.assets.directory, `${x}.${z}${layer.suffix}`);
        const info = await stat(path).catch(error => {
          if (error.code === 'ENOENT') throw new RequestError(404, 'terrain_packet_missing');
          throw error;
        });
        if (!info.isFile() || info.size === 0) throw new RequestError(404, 'terrain_packet_missing');
        if (length + 4 + info.size > maxPacketBytes) break;
        files.push({ path, size:info.size });
        length += 4 + info.size;
      }
      if (!files.length) throw new RequestError(413, 'terrain_packet_too_large');
      if (response.destroyed) return;

      response.writeHead(200, {
        'Content-Type':'application/octet-stream', 'Content-Length':length,
        'Cache-Control':'private, no-store', Vary:'Cookie', 'Cross-Origin-Resource-Policy':'same-origin',
      });
      await pipeline(async function* ({ signal }) {
        yield integerBytes(files.length);
        for (const { path, size } of files) {
          yield integerBytes(size);
          yield* createReadStream(path, { signal });
        }
      }, response);
    } finally {
      active.delete(player);
    }
  };
}
