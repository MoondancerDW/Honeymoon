import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { altitudeFiles } from '../client/altitude-assets.mjs';
import { RequestError } from './errors.mjs';

const maxFiles = 64;
const maxPacketBytes = 8 * 1024 * 1024;
const maxActive = 3;
const gzipSignature = Buffer.from([0x1f, 0x8b, 8]);

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

async function decodedTileBytes(path) {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 18 || info.size + 8 > maxPacketBytes) throw new Error('Invalid terrain packet file');
    const trailer = Buffer.alloc(4);
    const header = Buffer.alloc(gzipSignature.length);
    const { bytesRead: headerBytes } = await file.read(header, 0, header.length, 0);
    if (headerBytes !== header.length || !header.equals(gzipSignature)) throw new Error('Invalid terrain gzip header');
    // The terrain exporter writes one gzip member per tile, with its decoded size in ISIZE.
    const { bytesRead } = await file.read(trailer, 0, trailer.length, info.size - trailer.length);
    const size = trailer.readUInt32LE();
    if (bytesRead !== trailer.length || size === 0) throw new Error('Invalid terrain gzip trailer');
    return size;
  } finally {
    await file.close();
  }
}

function tilePath(layer, x, z) {
  return join(layer.assets.directory, `${x}.${z}${layer.suffix}`);
}

async function measureLayer(layer) {
  const { regions } = layer.assets.descriptor;
  if (layer.assets.packs.size !== regions.length) throw new Error('Duplicate terrain regions');
  let bytes = 0;
  for (const [x, z] of regions) bytes += await decodedTileBytes(tilePath(layer, x, z));
  return { hash:layer.hash, bytes, count:regions.length };
}

async function measureAltitude(project) {
  const files = await Promise.all(altitudeFiles.map(path => stat(join(project, 'client', path.slice(1)))));
  if (files.some(file => !file.isFile() || !file.size)) throw new Error('Invalid altitude file');
  return { bytes:files.reduce((total, file) => total + file.size, 0), count:files.length };
}

export function createTerrainPreload(lod, vista, project) {
  const active = new Set();
  const layers = new Map();
  if (lod) layers.set('simplified', { assets:lod, hash:lod.descriptor.contentHash, suffix:'.bin.gz' });
  if (lod?.descriptor.maxDistance >= 32) {
    layers.set('primitive', { assets:lod, hash:lod.descriptor.contentHash, suffix:'.outer.bin.gz' });
  }
  if (vista) layers.set('vista', { assets:vista, hash:vista.descriptor.hash, suffix:'.bin.gz' });

  let plan;
  async function readPlan() {
    const entries = [...layers].map(async ([name, layer]) => [name, await measureLayer(layer)]);
    if (vista) entries.push(measureAltitude(project).then(info => ['altitude', info]));
    const measured = await Promise.allSettled(entries);
    return { layers:Object.fromEntries(measured.filter(result => result.status === 'fulfilled').map(result => result.value)) };
  }

  async function sendPacket(response, params, player) {
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
        const path = tilePath(layer, x, z);
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
  }
  return { plan:() => plan ??= readPlan(), sendPacket };
}
