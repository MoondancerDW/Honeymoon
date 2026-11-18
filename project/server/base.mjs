import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { relatedBlockStates } from '../world/block-interactions.mjs';
import { containerSpec } from '../world/containers.mjs';
import { isRideableMinecart } from '../world/minecarts.mjs';
import { isRideableBoat } from '../world/boats.mjs';
import { isWestCellarHatch, westCellarHatch, westCellarLadder } from '../world/west-cellar.mjs';
import { loadSnowCleanup } from './snow-cleanup.mjs';
import { loadFullDetail } from './full-detail.mjs';
import { soloRegionFile } from './solo-assets.mjs';

const CHUNK_BYTES_PER_SECTION = 16 ** 3 * 2;
const MAX_CACHED_CHUNKS = 160;
const unavailableCell = Object.freeze({key:'legacy:1:0',object:null});
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
  if (object.type === 'RPCharge' && Number.isInteger(object.data?.stor)) {
    data.stor = Math.min(3000, Math.max(0, object.data.stor));
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
      if (entity.data?.Invisible === true || entity.data?.Invisible === 1) data.Invisible = true;
      if (Number.isInteger(Item?.id)) data.Item = {id: Item.id, Damage: Number.isInteger(Item.Damage) ? Item.Damage : 0};
    }
  } else if (isRideableMinecart(entity)) {
    data.Type = 0;
    data.Rotation = [Number.isFinite(entity.data.Rotation?.[0]) ? entity.data.Rotation[0] : 0];
  } else if (isRideableBoat(entity)) {
    const facing = entity.data?.Rotation?.[0];
    data.Rotation = [Number.isFinite(facing) ? 180-facing : 0,0];
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

export function loadBase(directory, {cleanSnow = true, partial} = {}) {
  if (partial && typeof partial.has !== 'function') throw new TypeError('Partial world needs an installed-file lookup');
  const rawManifest = readFileSync(join(directory, 'world.json'), 'utf8');
  const manifest = JSON.parse(rawManifest);
  if (manifest.schemaVersion !== 1 || manifest.palette[0] !== 'air') {
    throw new Error('Unsupported import format. Rebuild the base world before launching.');
  }

  const coordinates = new Set([...manifest.chunks, ...(manifest.visualChunks ?? [])].map(([x, z]) => `${x}.${z}`));
  const playableCoordinates = new Set(manifest.chunks.map(([x, z]) => `${x}.${z}`));
  const chunks = new Map();
  const originalHash = manifest.contentHash ?? createHash('sha256').update(rawManifest).digest('hex');
  const fullDetail = manifest.chunkPalettes ? loadFullDetail(join(directory,'..','full-world'),originalHash) : null;
  if (partial && !fullDetail) throw new Error('Missing full detail manifest for partial world');
  const bounds = {...manifest.bounds,maxY:Math.max(manifest.bounds.maxY,511)};
  if (fullDetail) {
    const [west,north,east,south]=fullDetail.descriptor.bounds;
    Object.assign(bounds,{minX:Math.min(bounds.minX,west*16),maxX:Math.max(bounds.maxX,east*16+15),
      minZ:Math.min(bounds.minZ,north*16),maxZ:Math.max(bounds.maxZ,south*16+15)});
  }
  const cleanup = cleanSnow ? loadSnowCleanup(directory,originalHash) : null;
  const hash = cleanup?.hash ?? originalHash;
  const publicManifest = publicWorld({...manifest,bounds}, hash);
  if (fullDetail) {
    publicManifest.fullChunks=fullDetail.descriptor;
    publicManifest.fullWorldPlayable=true;
  }
  const corePalette = manifest.palette.slice(0, manifest.corePaletteSize ?? manifest.palette.length);
  const catalog = new Set(corePalette);
  for (const key of corePalette) {
    for (const variant of relatedBlockStates(key)) catalog.add(variant);
  }
  const detailCoverage = (x,z) => Boolean(fullDetail?.hasChunk(x,z));
  const worldCoverage = (x,z) => playableCoordinates.has(`${x}.${z}`) || detailCoverage(x,z);
  const installedDetail = (x,z) => detailCoverage(x,z) && (!partial || partial.has(soloRegionFile(x,z)));
  const hasPlayableChunk = partial ? installedDetail : worldCoverage;

  function inBounds(x, y, z) {
    return x >= bounds.minX && x < bounds.maxX + 1 && y >= bounds.minY && y < bounds.maxY + 1
      && z >= bounds.minZ && z < bounds.maxZ + 1;
  }

  function getChunk(cx, cz) {
    const chunkKey = `${cx}.${cz}`;
    const local=!partial && coordinates.has(chunkKey);
    if (!local && !installedDetail(cx,cz)) return null;
    const cached = chunks.get(chunkKey);
    if (cached) {
      chunks.delete(chunkKey);
      chunks.set(chunkKey, cached);
      return cached;
    }
    const source = local ? JSON.parse(readFileSync(join(directory,'chunks',`${chunkKey}.json`),'utf8')) : fullDetail.chunkAt(cx,cz);
    if (source.x !== cx || source.z !== cz) throw new Error(`Mismatched chunk coordinates ${chunkKey}`);
    cleanup?.apply(source,manifest.palette);
    const palette = manifest.chunkPalettes ? source.palette : manifest.palette;
    if (!Array.isArray(palette) || palette[0] !== 'air') throw new Error(`Malformed palette in ${chunkKey}`);
    const sections = new Map(source.sections.map(section=>[section.y,section.indices]));
    const objects = new Map(source.objects.map(object => [cellAddress(...object.position), object]));
    const chunk = { source, palette, sections, objects, local };
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
    // Collision and edit checks run synchronously, including reads into neighboring columns.
    if (!chunk && partial && worldCoverage(cx,cz)) return unavailableCell;
    let section = chunk?.sections.get(cy);
    if (!section) return { key: 'air', object: null };
    if (typeof section === 'string') {
      section=Buffer.from(section,'base64');
      if (section.length !== CHUNK_BYTES_PER_SECTION) throw new Error(`Malformed section in ${cx}.${cz}`);
      chunk.sections.set(cy,section);
    }
    const index = (x - cx * 16) + (z - cz * 16) * 16 + (y - cy * 16) * 256;
    const key = chunk.palette[section.readUInt16LE(index * 2)];
    if (!key) throw new Error(`Palette index outside catalog at ${cellAddress(x, y, z)}`);
    const address = cellAddress(x, y, z);
    let object = chunk.objects.get(address) ?? null;
    // Local compiled chunks carry public render data. Read private inventories from the original chunk pack.
    if (containerSpec(key) && chunk.local && fullDetail?.hasChunk(cx,cz)) {
      chunk.originalObjects ??= new Map(fullDetail.chunkAt(cx,cz).objects.map(entry=>[cellAddress(...entry.position),entry]));
      const original = chunk.originalObjects.get(address);
      if (original && (!object || object.type === original.type)) object = original;
    }
    // The original save stays available for Minecraft comparison.
    if (isWestCellarHatch(x, y, z) && (key === 'legacy:96:12' || key === 'legacy:96:8') &&
        getCell(x, y - 1, z).key === `legacy:65:${westCellarLadder}`) {
      return { key, object: {key: `tile:${x}:${y}:${z}`, position: [x, y, z], type: 'WestCellarHatch',
        data: {ladderRung: westCellarLadder}} };
    }
    return { key, object };
  }

  function publicChunk(cx, cz, highOnly=false) {
    if (partial && !installedDetail(cx,cz)) return null;
    if (highOnly && manifest.bounds.maxY<256) {
      const key=`${cx}.${cz}`;
      if (!coordinates.has(key) && !fullDetail?.hasChunk(cx,cz)) return null;
      return {x:cx,z:cz,sections:[],palette:['air'],objects:[],entities:[],highOnly:true};
    }
    const chunk = getChunk(cx, cz);
    if (!chunk) return null;
    const objects = chunk.source.objects.map(displayObject);
    const {x, y, z} = westCellarHatch;
    if (cx === (x >> 4) && cz === (z >> 4)) {
      const fixture = getCell(x, y, z).object;
      if (fixture?.type === 'WestCellarHatch') objects.push(displayObject(fixture));
    }
    const result={
      ...chunk.source,
      objects,
      entities: (partial && coordinates.has(`${cx}.${cz}`) ? chunk.source.entities.filter(entity=>
        entity.type==='Painting' || entity.type==='ItemFrame' || isRideableMinecart(entity)) : chunk.source.entities).map(displayEntity),
    };
    if (highOnly) {
      result.sections=result.sections.filter(section=>section.y>=16);
      result.objects=result.objects.filter(object=>object.position[1]>=256);
      result.entities=result.entities.filter(entity=>entity.position[1]>=256);
      result.highOnly=true;
    }
    return result;
  }

  function getEntity(x, z, key) {
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    return getChunk(cx, cz)?.source.entities.find(entity => entity.key === key);
  }

  return { manifest:{...manifest,bounds}, publicManifest, hash, catalog, inBounds, getCell, getEntity, publicChunk,
    hasPlayableChunk, worldCoverage };
}
