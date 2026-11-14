import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { canonicalJson, readNbt, readRegionChunk, sectionBlocks } from './nbt.mjs';
import { terrainRadii, writeTerrainRings } from './terrain.mjs';

const PROJECT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE_TREE = resolve(PROJECT, '../sources');
const DEFAULT_SOURCE = resolve(SOURCE_TREE, 'Honeymoon/saves/equestria');
const DEFAULT_OUTPUT = resolve(PROJECT, 'generated/world');
const DEFAULT_RADIUS = 4;
const DEFAULT_VISUAL_RADIUS = 6;
const DATA_VERSION = 1;
const LAST_VANILLA_ID = 145;
const SAMPLE_POINTS = {
  armchair: [-34, 65, -61], bookcase: [-59, 76, -50], sign: [-54, 70, -49], lamp: [-51, 73, -50],
};

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const positionKey = (x, y, z) => `${x}:${y}:${z}`;
const cellOffset = (x, y, z) => (x & 15) + 16 * (z & 15) + 256 * (y & 15);

function regionLoader(folder) {
  const cache = new Map();
  return (x, z) => {
    const file = `r.${Math.floor(x / 32)}.${Math.floor(z / 32)}.mca`;
    try {
      if (!cache.has(file)) {
        const path = join(folder, file);
        cache.set(file, existsSync(path) ? readFileSync(path) : null);
      }
      const region = cache.get(file);
      return region && readRegionChunk(region, x, z);
    } catch (error) {
      throw new Error(`Cannot read chunk ${x},${z} from ${file}`, { cause: error });
    }
  };
}

function countsBy(items, key) {
  const counts = Object.create(null);
  for (const item of items) counts[item[key]] = (counts[item[key]] ?? 0) + 1;
  return counts;
}

function partData(tile, id, meta) {
  if (!Number.isInteger(tile.cvm) || !Buffer.isBuffer(tile.cvs)) return null;
  const mask = tile.cvm & (tile.id === 'RPFrame' ? 0x3f : 0x1fffffff);
  const parts = [];
  for (let slot = 0; slot < 29; slot += 1) {
    if (((mask >>> slot) & 1) === 0) continue;
    const offset = parts.length * 2;
    if (offset + 1 >= tile.cvs.length) break;
    parts.push({ slot, material: tile.cvs[offset], shape: tile.cvs[offset + 1] });
  }
  const cvm = tile.cvm;
  const cvs = tile.cvs.toString('base64');
  const identity = { id, meta, type: tile.id, cvm, cvs };
  const key = `cover:${id}:${meta}:${sha256(canonicalJson(identity))}`;
  const expectedLength = mask.toString(2).replaceAll('0', '').length * 2;
  return { key, definition: { ...identity, parts, malformed: expectedLength !== tile.cvs.length } };
}

function makeObjects(level) {
  return (level.TileEntities ?? []).map((data) => {
    const { x, y, z, id: type } = data;
    if (![x, y, z].every(Number.isInteger) || typeof type !== 'string') {
      throw new Error(`Invalid tile entity in chunk ${level.xPos},${level.zPos}`);
    }
    return { key: `tile:${positionKey(x, y, z)}`, position: [x, y, z], type, data };
  });
}

function makeEntities(level) {
  const ids = new Map();
  return (level.Entities ?? []).map((data) => {
    const type = data.id ?? null;
    const coordinates = Array.isArray(data.Pos) ? data.Pos : [data.TileX, data.TileY, data.TileZ];
    const position = coordinates.length === 3 && coordinates.every(Number.isFinite) ? coordinates : null;
    const uuid = [data.UUIDMost?.value, data.UUIDLeast?.value];
    const identity = uuid.every((part) => typeof part === 'string')
      ? sha256(uuid.join(':')) : `${level.xPos}:${level.zPos}:${sha256(canonicalJson({ type, position, data }))}`;
    const occurrence = ids.get(identity) ?? 0;
    ids.set(identity, occurrence + 1);
    return { key: `entity:${identity}:${occurrence}`, position, type, data };
  });
}

function configEvidence(config, missingIds) {
  const evidence = Object.create(null);
  if (!existsSync(config)) return evidence;
  const readFolder = (folder) => {
    const entries = readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) readFolder(path);
      else if (entry.isFile() && /\.(cfg|conf)$/i.test(entry.name)) {
        for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
          const match = line.match(/^\s*([\w.:-]+)\s*=\s*(\d+)\s*$/);
          if (match && missingIds.has(Number(match[2]))) {
            (evidence[match[2]] ??= []).push({ file: relative(config, path).split(sep).join('/'), key: match[1] });
          }
        }
      }
    }
  };
  readFolder(config);
  return evidence;
}

function getBlock(chunks, x, y, z) {
  if (y < 0 || y > 255) return null;
  const key = `${Math.floor(x / 16)}:${Math.floor(z / 16)}`;
  const chunk = chunks.get(key);
  if (!chunk) return null;
  const section = chunk.get(Math.floor(y / 16));
  return section ? section.readUInt16LE(cellOffset(x, y, z) * 2) : 0;
}

function findSpawn(sourceSpawn, chunks, palette) {
  const [x, y, z] = sourceSpawn;
  const solidSpawnBlocks = new Set([1, 2, 3, 4, 5, 7, 12, 13, 17, 24, 35, 41, 42, 43, 45,
    48, 49, 57, 80, 82, 87, 88, 89, 98, 112, 121, 125, 133, 155]);
  for (let radius = 0; radius <= 8; radius += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        for (const dy of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
          const feet = y + dy;
          const support = palette[getBlock(chunks, x + dx, feet - 1, z + dz)];
          if (!support?.startsWith('legacy:') || !solidSpawnBlocks.has(Number(support.split(':')[1]))) continue;
          if (getBlock(chunks, x + dx, feet, z + dz) === 0 && getBlock(chunks, x + dx, feet + 1, z + dz) === 0) {
            return [x + dx + 0.5, feet, z + dz + 0.5];
          }
        }
      }
    }
  }
  throw new Error(`No clear spawn with a full block floor found near ${sourceSpawn.join(', ')}`);
}

function detailedMap({ world, out, radius, visualRadius, loadChunk }) {
  const level = readNbt(gunzipSync(readFileSync(join(world, 'level.dat'))));
  const sourceSpawn = ['SpawnX', 'SpawnY', 'SpawnZ'].map((key) => level.Data?.[key]);
  if (!sourceSpawn.every(Number.isInteger)) throw new Error('Missing original spawn in level.dat');
  const allRegistry = new Map((level.FML?.ModItemData ?? []).map((item) => [item.ItemId, item]));
  const palette = ['air'];
  const indexByKey = new Map([['air', 0]]);
  const byLegacy = new Uint16Array(65536);
  const compositions = Object.create(null);
  const variantCounts = new Uint32Array(65536);
  const legacyRegistry = Object.create(null);
  const countsByKey = Object.create(null);
  const chunks = [];
  const chunkHash = Object.create(null);
  const chunkSections = new Map();
  const allObjects = [];
  const allEntities = [];
  const counts = { sections: 0, cells: 0, occupied: 0, covers: 0, malformedCompositions: 0 };
  const coverPatterns = new Set();
  const knownVariants = Object.create(null);
  const getPaletteIndex = (key) => {
    if (!indexByKey.has(key)) {
      if (palette.length >= 65536) throw new Error('Detailed palette exceeds uint16. Reduce the detailed radius.');
      indexByKey.set(key, palette.length);
      palette.push(key);
    }
    return indexByKey.get(key);
  };
  const directory = join(out, 'chunks');
  mkdirSync(directory);

  function importChunk(x, z, playable, hashes) {
    const chunk = loadChunk(x, z);
    if (!chunk) {
      if (playable) throw new Error(`Detailed map missing chunk ${x},${z}`);
      return false;
    }
    const objects = makeObjects(chunk);
    const entities = makeEntities(chunk);
    if (playable) {
      allObjects.push(...objects);
      allEntities.push(...entities);
    }
    const objectsAt = new Map(objects.map((object) => [positionKey(...object.position), object]));
    const sections = [];
    const byY = new Map();
    for (const source of [...(chunk.Sections ?? [])].sort((left, right) => left.Y - right.Y)) {
      const { blocks, variants } = sectionBlocks(source);
      if (byY.has(source.Y)) throw new Error(`Duplicate section ${source.Y} in chunk ${x},${z}`);
      if (playable) {
        counts.sections += 1;
        counts.cells += blocks.length;
      }
      const indices = Buffer.alloc(blocks.length * 2);
      const tiles = new Map();
      for (const object of objects) {
        const [tx, ty, tz] = object.position;
        if (Math.floor(ty / 16) === source.Y && Math.floor(tx / 16) === x && Math.floor(tz / 16) === z) {
          tiles.set(cellOffset(tx, ty, tz), object);
        }
      }

      for (let index = 0; index < blocks.length; index += 1) {
        const id = blocks[index];
        const meta = variants[index];
        const legacy = id * 16 + meta;
        if (playable) variantCounts[legacy] += 1;
        if (id === 0) continue;
        if (playable) counts.occupied += 1;
        if (!byLegacy[legacy]) byLegacy[legacy] = getPaletteIndex(`legacy:${id}:${meta}`);
        let paletteIndex = byLegacy[legacy];
        const tile = tiles.get(index);
        if (tile) {
          const composition = partData(tile.data, id, meta);
          if (composition) {
            const { key, definition } = composition;
            paletteIndex = getPaletteIndex(key);
            compositions[key] = definition;
            if (playable) {
              if (definition.malformed) counts.malformedCompositions += 1;
              if (tile.type === 'Covers') {
                counts.covers += 1;
                coverPatterns.add(`${definition.cvm}:${definition.cvs}`);
              }
            }
          }
        }
        const key = palette[paletteIndex];
        if (playable) countsByKey[key] = (countsByKey[key] ?? 0) + 1;
        indices.writeUInt16LE(paletteIndex, index * 2);
      }

      const section = { y: source.Y, indices: indices.toString('base64') };
      if (source.SkyLight?.length === 2048) section.skyLight = source.SkyLight.toString('base64');
      if (source.BlockLight?.length === 2048) section.blockLight = source.BlockLight.toString('base64');
      sections.push(section);
      byY.set(source.Y, indices);
    }

    const data = `${canonicalJson({ x, z, sections, objects, entities })}\n`;
    const file = `${x}.${z}.json`;
    hashes[file] = sha256(data);
    writeFileSync(join(directory, file), data);
    if (!playable) return true;
    chunkSections.set(`${x}:${z}`, byY);
    chunks.push([x, z]);
    for (const [name, position] of Object.entries(SAMPLE_POINTS)) {
      const [sx, sy, sz] = position;
      if (Math.floor(sx / 16) !== x || Math.floor(sz / 16) !== z) continue;
      knownVariants[name] = {
        position, cell: palette[getBlock(chunkSections, sx, sy, sz)],
        objectType: objectsAt.get(positionKey(sx, sy, sz))?.type ?? null,
      };
    }
    return true;
  }

  for (let z = -radius; z < radius; z += 1) {
    for (let x = -radius; x < radius; x += 1) importChunk(x, z, true, chunkHash);
  }

  const variants = [];
  const missingIds = new Set();
  for (let index = 0; index < variantCounts.length; index += 1) {
    if (!variantCounts[index]) continue;
    const id = index >> 4;
    variants.push({ id, meta: index & 15, cells: variantCounts[index] });
    if (allRegistry.has(id)) legacyRegistry[id] = allRegistry.get(id);
    else if (id > LAST_VANILLA_ID) missingIds.add(id);
  }

  const evidence = configEvidence(resolve(world, '../../config'), missingIds);
  const unknownRegistry = [...missingIds].map((id) => ({
    id, variants: variants.filter((variant) => variant.id === id), config: evidence[id] ?? [],
  }));
  counts.chunks = chunks.length;
  counts.ids = new Set(variants.map(({ id }) => id)).size;
  counts.variants = variants.length;
  counts.coverPatterns = coverPatterns.size;
  counts.compositions = Object.keys(compositions).length;
  counts.objects = countsBy(allObjects, 'type');
  counts.entities = countsBy(allEntities, 'type');
  const spawn = findSpawn(sourceSpawn, chunkSections, palette);
  const bounds = { minX: -radius * 16, maxX: radius * 16 - 1, minZ: -radius * 16, maxZ: radius * 16 - 1,
    minY: 0, maxY: 255 };
  const manifest = { schemaVersion: DATA_VERSION, importVersion: DATA_VERSION, catalogVersion: 1, bounds, spawn,
    sourceSpawn, coordinateTransform: 'identity', chunks, palette, compositions, legacyRegistry, chunkHash,
    counts, countsByKey, unknownRegistry, variants, samples: knownVariants };
  // Keep authoritative data and palette indices stable when only the scenery changes.
  const contentHash = sha256(canonicalJson(manifest));
  if (!visualRadius) return { ...manifest, contentHash };
  const corePaletteSize = palette.length;
  const visualChunks = [];
  const visualChunkHash = Object.create(null);
  for (let z = -visualRadius; z < visualRadius; z += 1) {
    for (let x = -visualRadius; x < visualRadius; x += 1) {
      if (x >= -radius && x < radius && z >= -radius && z < radius) continue;
      if (importChunk(x, z, false, visualChunkHash)) visualChunks.push([x, z]);
    }
  }
  return { ...manifest, contentHash, corePaletteSize, visualChunks, visualRadius,
    visualHash: sha256(canonicalJson(visualChunkHash)) };
}

function within(path, directory) {
  const suffix = relative(directory, path);
  return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
}

function checkExistingOutput(out) {
  if (!existsSync(out)) return;
  const files = readdirSync(out);
  if (!files.length) return;
  if (!files.includes('world.json') || files.some((file) => !/^(world\.json|chunks|terrain-(8|16|32)\.json)$/.test(file))) {
    throw new Error(`Refusing to replace an unrelated directory at ${out}`);
  }
  const previous = JSON.parse(readFileSync(join(out, 'world.json'), 'utf8'));
  if (!Number.isInteger(previous.schemaVersion) || !Array.isArray(previous.palette) || !Array.isArray(previous.chunks)) {
    throw new Error(`Existing world.json does not identify a generated Honeymoon world at ${out}`);
  }
}

export function importWorld({ world = DEFAULT_SOURCE, out = DEFAULT_OUTPUT, radius = DEFAULT_RADIUS,
  terrainRadius = 0, visualRadius = terrainRadius > 0 && radius < DEFAULT_VISUAL_RADIUS ? DEFAULT_VISUAL_RADIUS : 0 } = {}) {
  if (!Number.isInteger(radius) || radius < 1 || radius > 16) throw new Error('Detailed radius must be 1 to 16 chunks');
  if (!terrainRadii.includes(terrainRadius) || (terrainRadius > 0 && radius > 8)) {
    throw new Error('Terrain radius must be 0, 8, 16 or 32, with detailed radius at most 8 when terrain is enabled');
  }
  if (!Number.isInteger(visualRadius) ||
      (visualRadius !== 0 && (visualRadius <= radius || visualRadius > 16 || (terrainRadius && visualRadius > 8)))) {
    throw new Error('Visual radius must be 0 or greater than the detailed radius, up to 16 chunks (8 with coarse terrain)');
  }
  world = realpathSync(resolve(world));
  out = resolve(out);
  const sourceTrees = [world, SOURCE_TREE];
  if (sourceTrees.some((source) => within(out, source) || within(source, out))) {
    throw new Error('Output must be separate from the source and bundle roots');
  }
  mkdirSync(dirname(out), { recursive: true });
  const parent = realpathSync(dirname(out));
  out = join(parent, basename(out));
  if (sourceTrees.some((source) => within(out, source) || within(source, out)) ||
      (existsSync(out) && realpathSync(out) !== out)) {
    throw new Error('Output must not resolve into the source tree or be a symlink');
  }
  const staging = mkdtempSync(join(parent, '.honeymoon-import-'));
  const data = join(staging, 'data');
  const previous = join(staging, 'previous');
  mkdirSync(data);
  let keepPrevious = false;
  try {
    checkExistingOutput(out);
    const loadChunk = regionLoader(join(world, 'region'));
    const manifest = detailedMap({ world, out: data, radius, visualRadius, loadChunk });
    manifest.terrain = writeTerrainRings(data, terrainRadius, loadChunk, Math.max(radius, visualRadius));
    writeFileSync(join(data, 'world.json'), `${canonicalJson(manifest)}\n`);
    if (existsSync(out)) {
      checkExistingOutput(out);
      renameSync(out, previous);
      keepPrevious = true;
    }
    try {
      renameSync(data, out);
    } catch (error) {
      if (keepPrevious && !existsSync(out)) {
        renameSync(previous, out);
        keepPrevious = false;
      }
      throw error;
    }
    keepPrevious = false;
    return manifest;
  } finally {
    if (!keepPrevious && dirname(staging) === parent && basename(staging).startsWith('.honeymoon-import-')) {
      rmSync(staging, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: {
    world: { type: 'string' }, out: { type: 'string' }, radius: { type: 'string' },
    'terrain-radius': { type: 'string' }, 'visual-radius': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('node import/anvil.mjs [--world SOURCE_SAVE] [--out OUTPUT] [--radius 4] [--terrain-radius 0|8|16|32] [--visual-radius 0|N]');
  } else {
    const start = performance.now();
    const manifest = importWorld({ world: values.world, out: values.out,
      radius: Number(values.radius ?? DEFAULT_RADIUS), terrainRadius: Number(values['terrain-radius'] ?? 0),
      visualRadius: values['visual-radius'] === undefined ? undefined : Number(values['visual-radius']) });
    const { counts, samples, spawn, terrain, contentHash, visualChunks = [], visualRadius } = manifest;
    console.log(JSON.stringify({ seconds: (performance.now() - start) / 1000, contentHash, spawn, counts, samples,
      terrain, visualRadius, visualChunks: visualChunks.length }, null, 2));
  }
}
