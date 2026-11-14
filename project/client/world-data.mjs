import {lightChanged, updateBlockLight} from './block-light.mjs';

export const chunkKey = (x, z) => x + ',' + z;
export const sectionKey = (x, y, z) => x + ',' + y + ',' + z;
export const cellKey = sectionKey;
const blockIndex = (x, y, z) => (x & 15) + (z & 15) * 16 + (y & 15) * 256;
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function decodeBytes(encoded) {
  if (!encoded) return null;
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(encoded);
  const input = atob(encoded);
  const bytes = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) bytes[i] = input.charCodeAt(i);
  return bytes;
}

export function decodeIndices(encoded) {
  const bytes = decodeBytes(encoded);
  if (littleEndian) return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const input = new DataView(bytes.buffer);
  const indices = new Uint16Array(bytes.length / 2);
  for (let i = 0; i < indices.length; i++) indices[i] = input.getUint16(i * 2, true);
  return indices;
}

export async function json(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(url + ' — ' + response.status);
  return response.json();
}

export class World {
  constructor(manifest) {
    this.manifest = manifest;
    this.palette = manifest.palette.slice();
    this.indices = new Map(this.palette.map((key, index) => [key, index]));
    this.chunks = new Map();
    this.overrides = new Map();
    this.blockLightOverrides = new Map();
    this.pendingLights = new Map();
  }

  addChunk(chunk, visualOnly = false) {
    const sections = new Map(chunk.sections.map(({y, indices, skyLight, blockLight}) => [y, {
      indices: decodeIndices(indices), sky: decodeBytes(skyLight), block: decodeBytes(blockLight)
    }]));
    const stored = {x: chunk.x, z: chunk.z, sections, visualOnly, entities: chunk.entities || []};
    this.chunks.set(chunkKey(chunk.x, chunk.z), stored);
    const objects = new Map();
    for (const object of chunk.objects || []) {
      const [x, y, z] = object.position;
      let layer = objects.get(y >> 4);
      if (!layer) { layer = new Map(); objects.set(y >> 4, layer); }
      layer.set(blockIndex(x, y, z), object);
    }
    stored.objects = objects;
    return stored;
  }

  addPalette(key) {
    if (this.indices.has(key)) return this.indices.get(key);
    if (this.palette.length >= 65536) throw new Error('Palette exceeds uint16');
    const index = this.palette.length;
    this.palette.push(key);
    this.indices.set(key, index);
    return index;
  }

  setOverride(change) {
    const position = cellKey(change.x, change.y, change.z);
    const previous = this.overrides.get(position);
    if (previous && previous.revision >= change.revision) return false;
    const key = change.cell || 'air';
    const {x, y, z} = change;
    if (this.chunks.has(chunkKey(x >> 4, z >> 4)) && lightChanged(this.lightCell(x, y, z), {key, object: change.object})) {
      if (!this.pendingLights.has(position)) this.pendingLights.set(position, [x, y, z, this.lightAt(x, y, z) & 15]);
    }
    this.overrides.set(position, {...change, index: this.addPalette(key)});
    return true;
  }

  hasChunk(x, z) {
    const chunk = this.chunks.get(chunkKey(Math.floor(x / 16), Math.floor(z / 16)));
    return Boolean(chunk && !chunk.visualOnly);
  }

  section(x, y, z) {
    return this.chunks.get(chunkKey(Math.floor(x / 16), Math.floor(z / 16)))?.sections.get(Math.floor(y / 16));
  }

  indexAt(x, y, z) {
    const override = this.overrides.get(cellKey(x, y, z));
    if (override) return override.index;
    return this.section(x, y, z)?.indices[blockIndex(x, y, z)] || 0;
  }

  cellAt(x, y, z) {
    if (!this.hasChunk(x, z)) return null;
    const {key, object} = this.lightCell(x, y, z);
    if (key === 'air') return null;
    const composition = this.manifest.compositions?.[key];
    if (!composition && !object) return key;
    return {key, ...composition, object};
  }

  revisionAt(x, y, z) {
    return this.overrides.get(cellKey(x, y, z))?.revision || 0;
  }

  lightAt(x, y, z) {
    const original = this.baseLightAt(x, y, z);
    if (!this.blockLightOverrides.size) return original;
    const block = this.blockLightOverrides.get(cellKey(x, y, z));
    return block === undefined ? original : (original & 240) | block;
  }

  baseLightAt(x, y, z) {
    return packedLight(this.section(x, y, z), blockIndex(x, y, z));
  }

  lightCell(x, y, z, base = false) {
    const override = !base && this.overrides.size ? this.overrides.get(cellKey(x, y, z)) : null;
    if (override) return {key: this.palette[override.index], object: override.object};
    const chunk = this.chunks.get(chunkKey(x >> 4, z >> 4));
    const local = blockIndex(x, y, z);
    const index = chunk?.sections.get(y >> 4)?.indices[local] ?? 0;
    return {key: this.palette[index], object: chunk?.objects.get(y >> 4)?.get(local)};
  }

  updateLighting(chunk) {
    if (chunk) {
      for (const [position, {x, y, z}] of this.overrides) {
        if (Math.abs((x >> 4) - chunk.x) > 1 || Math.abs((z >> 4) - chunk.z) > 1 || !this.chunks.has(chunkKey(x >> 4, z >> 4))) continue;
        if (lightChanged(this.lightCell(x, y, z, true), this.lightCell(x, y, z))) {
          this.pendingLights.set(position, [x, y, z, this.lightAt(x, y, z) & 15]);
        }
      }
    }
    const dirty = new Set();
    for (const changed of this.pendingLights.values()) for (const section of updateBlockLight(this, ...changed)) dirty.add(section);
    this.pendingLights.clear();
    return dirty;
  }

  halo(cx, cy, cz) {
    const indices = new Uint16Array(18 ** 3);
    const light = new Uint8Array(indices.length);
    const objects = [];
    const chunks = [-1, 0, 1].map(dz => [-1, 0, 1].map(dx => this.chunks.get(chunkKey(cx + dx, cz + dz))));
    const overrides = this.overrides;
    const blockOverrides = this.blockLightOverrides;
    let i = 0;
    for (let dy = -1; dy <= 16; dy++) {
      const y = cy * 16 + dy;
      for (let dz = -1; dz <= 16; dz++) {
        const z = cz * 16 + dz;
        const row = chunks[(dz >> 4) + 1];
        const ySection = y >> 4;
        const localRow = blockIndex(0, y, z);
        for (let segment = 0; segment < 3; segment++) {
          const chunk = row[segment];
          const section = chunk?.sections.get(ySection);
          const layer = chunk?.objects.get(ySection);
          const from = segment === 0 ? -1 : segment === 1 ? 0 : 16;
          const to = segment === 0 ? 0 : segment === 1 ? 16 : 17;
          for (let dx = from; dx < to; dx++, i++) {
            const key = overrides.size || blockOverrides.size ? cellKey(cx * 16 + dx, y, z) : null;
            const override = key && overrides.get(key);
            const index = localRow + (dx & 15);
            indices[i] = override?.index ?? section?.indices[index] ?? 0;
            const original = packedLight(section, index);
            const block = key ? blockOverrides.get(key) : undefined;
            light[i] = block === undefined ? original : (original & 240) | block;
            const object = override ? override.object : layer?.get(index);
            if (object && indices[i]) objects.push([i, object]);
          }
        }
      }
    }
    return {indices, light, objects};
  }
}

function packedLight(section, index) {
  const shift = (index & 1) * 4;
  const sky = section?.sky ? (section.sky[index >> 1] >> shift) & 15 : 15;
  const block = section?.block ? (section.block[index >> 1] >> shift) & 15 : 0;
  return (sky << 4) | block;
}
