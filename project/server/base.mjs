import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { relatedBlockStates } from '../world/block-interactions.mjs';
import { isWestCellarHatch, westCellarHatch, westCellarLadder } from '../world/west-cellar.mjs';

const CHUNK_BYTES_PER_SECTION = 16 ** 3 * 2;
const MAX_CACHED_CHUNKS = 80;
const safeTileFields = new Set([
  'Text1', 'Text2', 'Text3', 'Text4', 'rotation', 'Rotation', 'direction', 'Direction',
  'orientation', 'Orientation', 'rot', 'Rot', 'facing', 'Facing', 'color', 'Color',
  'Colour', 'colour', 'type', 'Type', 'style', 'Style', 'open', 'Open', 'active', 'Active', 'sid',
  'bookcaseAngle', 'filledBottomSlots', 'filledTopSlots', 'deskAngle', 'hasWrittenBook',
  'leftBookStack', 'rightBookStack', 'genericShelfAngle', 'potionshelfAngle', 'caseAngle', 'rackAngle',
  'labelAngle', 'LidOpen', 'ps', 'cons',
]);
const jacketTiles = new Set(['Redwire', 'RedCable', 'Bluewire']);
const wireTiles = new Set([...jacketTiles, 'InsRedwire']);

const visibleItems = {
  ArmorStandTile: ['StandInventory', 4],
  GenericShelfTile: ['ShelfInventory', 4],
  PotionShelfTile: ['PotionInventory', 12],
  ToolRackTile: ['RackInventory', 4],
  WeaponCaseTile: ['CaseInventory', 1],
  WoodLabelTile: ['LabelInventory', 3],
};

function displayItems(inventory, slots, armor) {
  if (!Array.isArray(inventory)) return [];
  const result = [];
  for (const item of inventory) {
    const {id, Damage = 0, Slot} = item ?? {};
    if (!Number.isInteger(id) || id <= 0 || id > 32767 || !Number.isInteger(Damage) ||
        !Number.isInteger(Slot) || Slot < 0 || Slot >= slots) continue;
    const data = {id, Damage, Slot};
    const color = item.tag?.display?.color;
    if (armor && Number.isInteger(color) && color >= 0 && color <= 0xffffff) {
      data.tag = {display: {color}};
    }
    result.push(data);
  }
  return result;
}

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
  if (Object.hasOwn(visibleItems, object.type)) {
    const [field, slots] = visibleItems[object.type];
    data[field] = displayItems(object.data?.[field], slots, object.type === 'ArmorStandTile');
  }
  if (jacketTiles.has(object.type)) {
    if (Number.isInteger(object.data?.post)) data.post = object.data.post & 255;
  }
  if (wireTiles.has(object.type)) {
    if (Number.isInteger(object.data?.md)) data.md = object.data.md & 255;
    if (Number.isInteger(object.data?.pwr)) data.pwr = object.data.pwr & 255;
  }
  if (object.type === 'RPTube' && Number.isInteger(object.data?.pCol)) {
    data.pCol = object.data.pCol & 255;
  }
  if (object.type === 'Music' && Number.isInteger(object.data?.note)) {
    data.note = Math.min(24, Math.max(0, object.data.note));
  }
  if (object.type === 'RecordPlayer') {
    const recordId = object.data?.RecordItem?.id ?? object.data?.Record;
    if (Number.isInteger(recordId) && recordId >= 2256 && recordId <= 2267) data.Record = recordId;
  }
  if (object.type === 'WestCellarHatch') data.ladderRung = westCellarLadder;
  return { key: object.key, position: object.position, type: object.type, data };
}

export function displayEntity(entity) {
  const type = entity.type ?? entity.data?.id;
  const data = {};
  if (type === 'Painting' || type === 'ItemFrame') {
    const { Motive, Dir, Direction, TileX, TileY, TileZ, ItemRotation, Item } = entity.data ?? {};
    Object.assign(data, {Dir, Direction, TileX, TileY, TileZ});
    if (type === 'Painting') data.Motive = Motive;
    else {
      data.ItemRotation = ItemRotation;
      if (Number.isInteger(Item?.id)) data.Item = {id: Item.id, Damage: Number.isInteger(Item.Damage) ? Item.Damage : 0};
    }
  }
  return { key: entity.key, position: entity.position, type, data };
}

function publicWorld(manifest, hash) {
  if (!manifest.chunkPalettes) return manifest;
  const {schemaVersion, importVersion, catalogVersion, bounds, spawn, sourceSpawn,
    coordinateTransform, chunks, legacyRegistry, terrain = []} = manifest;
  return {schemaVersion, importVersion, catalogVersion, bounds, spawn, sourceSpawn, coordinateTransform,
    chunks, legacyRegistry, terrain, palette:['air'], compositions:{}, contentHash:hash, chunkPalettes:true};
}

export function loadBase(directory) {
  const rawManifest = readFileSync(join(directory, 'world.json'), 'utf8');
  const manifest = JSON.parse(rawManifest);
  if (manifest.schemaVersion !== 1 || manifest.palette[0] !== 'air') {
    throw new Error('Unsupported import format. Rebuild the base world before launching.');
  }

  const coordinates = new Set([...manifest.chunks, ...(manifest.visualChunks ?? [])].map(([x, z]) => `${x}.${z}`));
  const chunks = new Map();
  const bounds = manifest.bounds;
  const hash = manifest.contentHash ?? createHash('sha256').update(rawManifest).digest('hex');
  const publicManifest = publicWorld(manifest, hash);
  const corePalette = manifest.palette.slice(0, manifest.corePaletteSize ?? manifest.palette.length);
  const catalog = new Set(corePalette);
  for (const key of corePalette) {
    for (const variant of relatedBlockStates(key)) catalog.add(variant);
  }

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
    const palette = manifest.chunkPalettes ? source.palette : manifest.palette;
    if (!Array.isArray(palette) || palette[0] !== 'air') throw new Error(`Malformed palette in ${chunkKey}`);
    const sections = new Map();
    for (const section of source.sections) {
      const indices = Buffer.from(section.indices, 'base64');
      if (indices.length !== CHUNK_BYTES_PER_SECTION) throw new Error(`Malformed section in ${chunkKey}`);
      sections.set(section.y, indices);
    }
    const objects = new Map(source.objects.map(object => [cellAddress(...object.position), object]));
    const chunk = { source, palette, sections, objects };
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
    const key = chunk.palette[section.readUInt16LE(index * 2)];
    if (!key) throw new Error(`Palette index outside catalog at ${cellAddress(x, y, z)}`);
    const object = chunk.objects.get(cellAddress(x, y, z)) ?? null;
    // The original save stays available for Minecraft comparison.
    if (isWestCellarHatch(x, y, z) && (key === 'legacy:96:12' || key === 'legacy:96:8') &&
        getCell(x, y - 1, z).key === `legacy:65:${westCellarLadder}`) {
      return { key, object: {key: `tile:${x}:${y}:${z}`, position: [x, y, z], type: 'WestCellarHatch',
        data: {ladderRung: westCellarLadder}} };
    }
    return { key, object };
  }

  function publicChunk(cx, cz) {
    const chunk = getChunk(cx, cz);
    if (!chunk) return null;
    const objects = chunk.source.objects.map(displayObject);
    const {x, y, z} = westCellarHatch;
    if (cx === (x >> 4) && cz === (z >> 4)) {
      const fixture = getCell(x, y, z).object;
      if (fixture?.type === 'WestCellarHatch') objects.push(displayObject(fixture));
    }
    return {
      ...chunk.source,
      objects,
      entities: chunk.source.entities.map(displayEntity),
    };
  }

  return { manifest, publicManifest, hash, catalog, inBounds, getCell, publicChunk };
}
