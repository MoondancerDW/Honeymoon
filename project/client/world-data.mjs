export const chunkKey = (x, z) => x + ',' + z;
export const sectionKey = (x, y, z) => x + ',' + y + ',' + z;
export const cellKey = sectionKey;
const blockIndex = (x, y, z) => (x & 15) + (z & 15) * 16 + (y & 15) * 256;

export function decodeBytes(encoded) {
  return encoded ? Uint8Array.from(atob(encoded), c => c.charCodeAt(0)) : null;
}

export function decodeIndices(encoded) {
  const bytes = decodeBytes(encoded);
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
    this.objects = new Map();
    this.overrides = new Map();
  }

  addChunk(chunk) {
    const sections = new Map(chunk.sections.map(({y, indices, skyLight, blockLight}) => [y, {
      indices: decodeIndices(indices), sky: decodeBytes(skyLight), block: decodeBytes(blockLight)
    }]));
    const stored = {x: chunk.x, z: chunk.z, sections, entities: chunk.entities || []};
    this.chunks.set(chunkKey(chunk.x, chunk.z), stored);
    for (const object of chunk.objects || []) this.objects.set(cellKey(...object.position), object);
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
    this.overrides.set(position, {...change, index: this.addPalette(key)});
    return true;
  }

  hasChunk(x, z) {
    return this.chunks.has(chunkKey(Math.floor(x / 16), Math.floor(z / 16)));
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
    const key = this.palette[this.indexAt(x, y, z)] || 'air';
    if (key === 'air') return null;
    const position = cellKey(x, y, z);
    const override = this.overrides.get(position);
    const object = override ? override.object : this.objects.get(position);
    const composition = this.manifest.compositions?.[key];
    if (!composition && !object) return key;
    return {key, ...composition, object};
  }

  revisionAt(x, y, z) {
    return this.overrides.get(cellKey(x, y, z))?.revision || 0;
  }

  halo(cx, cy, cz) {
    const indices = new Uint16Array(18 ** 3);
    const light = new Uint8Array(indices.length);
    const objects = [];
    let i = 0;
    for (let dy = -1; dy <= 16; dy++) {
      const y = cy * 16 + dy;
      for (let dz = -1; dz <= 16; dz++) {
        const z = cz * 16 + dz;
        for (let dx = -1; dx <= 16; dx++, i++) {
          const x = cx * 16 + dx;
          const key = cellKey(x, y, z);
          const override = this.overrides.get(key);
          const section = this.section(x, y, z);
          const index = blockIndex(x, y, z);
          indices[i] = override?.index ?? section?.indices[index] ?? 0;
          const shift = (index & 1) * 4;
          const sky = section?.sky ? (section.sky[index >> 1] >> shift) & 15 : 15;
          const block = section?.block ? (section.block[index >> 1] >> shift) & 15 : 0;
          light[i] = Math.max(sky, block);
          const object = override ? override.object : this.objects.get(key);
          if (object && indices[i]) objects.push([i, object]);
        }
      }
    }
    return {indices, light, objects};
  }
}
