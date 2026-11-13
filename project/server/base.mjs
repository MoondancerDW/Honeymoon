import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CHUNK_BYTES_PER_SECTION = 16 ** 3 * 2;
const MAX_CACHED_CHUNKS = 80;
const safeTileFields = new Set([
  'Text1', 'Text2', 'Text3', 'Text4', 'rotation', 'Rotation', 'direction', 'Direction',
  'orientation', 'Orientation', 'rot', 'Rot', 'facing', 'Facing', 'color', 'Color',
  'Colour', 'colour', 'type', 'Type', 'style', 'Style', 'open', 'Open', 'active', 'Active',
  'bookcaseAngle', 'filledBottomSlots', 'filledTopSlots', 'deskAngle', 'hasWrittenBook',
  'leftBookStack', 'rightBookStack', 'genericShelfAngle', 'potionshelfAngle', 'caseAngle', 'rackAngle', 'ps',
]);

export function cellAddress(x, y, z) {
  return `${x},${y},${z}`;
}

export function displayObject(object) {
  if (!object) return null;
  const data = {};
  for (const [key, value] of Object.entries(object.data ?? {})) {
    if (safeTileFields.has(key) && ['string', 'number', 'boolean'].includes(typeof value)) {
      data[key] = value;
    }
  }
  return { key: object.key, position: object.position, type: object.type, data };
}

function displayEntity(entity) {
  const type = entity.type ?? entity.data?.id;
  if (type !== 'Painting') return { key: entity.key, position: entity.position, type, data: {} };
  const { Motive, Dir, Direction, TileX, TileY, TileZ } = entity.data ?? {};
  return { key: entity.key, position: entity.position, type, data: { Motive, Dir, Direction, TileX, TileY, TileZ } };
}

export function loadBase(directory) {
  const rawManifest = readFileSync(join(directory, 'world.json'), 'utf8');
  const manifest = JSON.parse(rawManifest);
  if (manifest.schemaVersion !== 1 || manifest.palette[0] !== 'air') {
    throw new Error('Unsupported import format. Rebuild the base world before launching.');
  }

  const coordinates = new Set(manifest.chunks.map(([x, z]) => `${x}.${z}`));
  const chunks = new Map();
  const bounds = manifest.bounds;
  const hash = manifest.contentHash ?? createHash('sha256').update(rawManifest).digest('hex');
  const catalog = new Set(manifest.palette);

  function inBounds(x, y, z) {
    return x >= bounds.minX && x < bounds.maxX + 1 && y >= bounds.minY && y < bounds.maxY + 1
      && z >= bounds.minZ && z < bounds.maxZ + 1;
  }

  function getChunk(cx, cz) {
    const chunkKey = `${cx}.${cz}`;
    if (!coordinates.has(chunkKey)) return null;
    const cached = chunks.get(chunkKey);
    if (cached) {
      chunks.delete(chunkKey);
      chunks.set(chunkKey, cached);
      return cached;
    }
    const source = JSON.parse(readFileSync(join(directory, 'chunks', `${chunkKey}.json`), 'utf8'));
    if (source.x !== cx || source.z !== cz) throw new Error(`Mismatched chunk coordinates ${chunkKey}`);
    const sections = new Map();
    for (const section of source.sections) {
      const indices = Buffer.from(section.indices, 'base64');
      if (indices.length !== CHUNK_BYTES_PER_SECTION) throw new Error(`Malformed section in ${chunkKey}`);
      sections.set(section.y, indices);
    }
    const objects = new Map(source.objects.map(object => [cellAddress(...object.position), object]));
    const chunk = { source, sections, objects };
    chunks.set(chunkKey, chunk);
    if (chunks.size > MAX_CACHED_CHUNKS) chunks.delete(chunks.keys().next().value);
    return chunk;
  }

  function getCell(x, y, z) {
    if (!inBounds(x, y, z)) return { key: 'air', object: null };
    const cx = Math.floor(x / 16);
    const cy = Math.floor(y / 16);
    const cz = Math.floor(z / 16);
    const chunk = getChunk(cx, cz);
    const section = chunk?.sections.get(cy);
    if (!section) return { key: 'air', object: null };
    const index = (x - cx * 16) + (z - cz * 16) * 16 + (y - cy * 16) * 256;
    const key = manifest.palette[section.readUInt16LE(index * 2)];
    if (!key) throw new Error(`Palette index outside catalog at ${cellAddress(x, y, z)}`);
    return { key, object: chunk.objects.get(cellAddress(x, y, z)) ?? null };
  }

  function publicChunk(cx, cz) {
    const chunk = getChunk(cx, cz);
    if (!chunk) return null;
    return {
      ...chunk.source,
      objects: chunk.source.objects.map(displayObject),
      entities: chunk.source.entities.map(displayEntity),
    };
  }

  return { manifest, hash, catalog, inBounds, getCell, publicChunk };
}
