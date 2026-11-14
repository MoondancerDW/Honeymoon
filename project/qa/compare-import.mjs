import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson, readRegionChunk, sectionBlocks } from '../import/nbt.mjs';

const [worldDirectory = 'generated/world', source = '../sources/Honeymoon/saves/equestria', output] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(join(worldDirectory, 'world.json'), 'utf8'));
assert.equal(manifest.coordinateTransform, 'identity');
const regionFor = ([x, z]) => `r.${Math.floor(x / 32)}.${Math.floor(z / 32)}.mca`;
const counts = { chunks: 0, playableChunks: manifest.chunks.length, sceneryChunks: manifest.visualChunks?.length ?? 0,
  sections: 0, blocks: 0, air: 0, skyLightValues: 0, blockLightValues: 0,
  multipartCells: 0, malformedMultipartCells: 0, parts: 0, tiles: 0, entities: 0 };
const variants = new Uint8Array(65536);
const itemMaps = new Set();
const sha256 = value => createHash('sha256').update(value).digest('hex');
assert.equal(manifest.palette[0], 'air', 'Global palette starts with air');
const globalStates = new Map(manifest.palette.map(key => {
  if (key === 'air') return [key, { id: 0, meta: 0 }];
  const match = /^(legacy|cover):(\d+):(\d+)(?::([a-f0-9]{64}))?$/.exec(key);
  assert.ok(match, `Invalid palette key ${key}`);
  const [, prefix, rawId, rawMeta, hash] = match;
  const id = Number(rawId), meta = Number(rawMeta), composition = manifest.compositions[key];
  assert.ok(id > 0 && id <= 4095 && meta <= 15 &&
    (prefix === 'cover' ? hash && composition : !hash && !composition), `Invalid palette data ${key}`);
  return [key, { id, meta, composition }];
}));
const globalPalette = manifest.palette.map(key => globalStates.get(key));

function readPalette(imported, label) {
  if (!manifest.chunkPalettes) return globalPalette;
  const { palette, compositions } = imported;
  assert.equal(palette[0], 'air', `${label} local palette starts with air`);
  const localKeys = new Set(palette);
  assert.equal(localKeys.size, palette.length, `${label} duplicate local palette keys`);
  for (const key of Object.keys(compositions)) {
    assert.ok(localKeys.has(key), `${label} composition outside local palette ${key}`);
  }
  return palette.map(key => {
    const state = globalStates.get(key);
    assert.ok(state, `${label} local key outside global palette ${key}`);
    assert.deepEqual(compositions[key], state.composition, `${label} local composition ${key}`);
    return state;
  });
}

const localIndex = ({ x, y, z }) => (x & 15) + 16 * (z & 15) + 256 * y;

function compareMultipart(tile, state, label) {
  assert.ok(tile && state.composition, `Missing multipart data at ${label}`);
  const { type, cvm, cvs, parts, malformed } = state.composition;
  assert.equal(type, tile.id, `Multipart type at ${label}`);
  assert.equal(cvm, tile.cvm, `Multipart mask at ${label}`);
  assert.equal(cvs, tile.cvs.toString('base64'), `Multipart bytes at ${label}`);
  const expectedParts = [];
  const mask = tile.id === 'RPFrame' ? tile.cvm & 63 : tile.cvm & 0x1fffffff;
  let expectedLength = 0;
  for (let slot = 0; slot < 29; slot++) {
    if (!(mask & (1 << slot))) continue;
    const offset = expectedLength;
    expectedLength += 2;
    if (offset + 1 < tile.cvs.length) expectedParts.push({ slot, material: tile.cvs[offset], shape: tile.cvs[offset + 1] });
  }
  assert.equal(malformed, expectedLength !== tile.cvs.length, `Multipart length at ${label}`);
  assert.deepEqual(parts, expectedParts, `Multipart geometry inputs at ${label}`);
  counts.malformedMultipartCells += Number(malformed);
  counts.multipartCells++;
  counts.parts += parts.length;
}

function compareRecords(actual, expected, name, scope) {
  assert.ok(actual.every(record => record.type === (record.data.id ?? null)), `${scope} ${name} types`);
  assert.equal(new Set(actual.map(record => record.key)).size, actual.length, `${scope} ${name} keys`);
  const coordinates = ({ x, y, z, Pos, TileX, TileY, TileZ }) =>
    name === 'tiles' ? [x, y, z] : Pos ?? [TileX, TileY, TileZ];
  for (const record of actual) {
    const point = coordinates(record.data);
    assert.deepEqual(record.position, point.length === 3 && point.every(Number.isFinite) ? point : null,
      `${scope} ${name} position`);
  }
  assert.deepEqual(actual.map(record => canonicalJson(record.data)).sort(),
    expected.map(canonicalJson).sort(), `${scope} ${name} payloads`);
  counts[name] += actual.length;
}

function compareChunk(x, z, raw, imported) {
  const label = `Chunk ${x},${z}`;
  assert.deepEqual([imported.x, imported.z], [x, z], label);
  const palette = readPalette(imported, label);
  const paletteKeys = imported.palette ?? manifest.palette;
  compareRecords(imported.objects, raw.TileEntities ?? [], 'tiles', label);
  compareRecords(imported.entities, raw.Entities ?? [], 'entities', label);
  for (const {id, Item} of raw.Entities ?? []) {
    if (id === 'ItemFrame' && Item?.id === 358 && Number.isInteger(Item.Damage) && Item.Damage >= 0) {
      itemMaps.add(Item.Damage);
    }
  }
  const sections = new Map(imported.sections.map(section => [section.y, section]));
  const sourceSections = raw.Sections ?? [];
  assert.equal(sections.size, sourceSections.length, `${label} sections`);
  assert.equal(imported.sections.length, sections.size, `${label} duplicate sections`);
  const tiles = new Map();
  for (const tile of raw.TileEntities ?? []) {
    if ((tile.x >> 4) === x && (tile.z >> 4) === z && Number.isInteger(tile.cvm) && Buffer.isBuffer(tile.cvs)) {
      tiles.set(localIndex(tile), tile);
    }
  }
  for (const sourceSection of sourceSections) {
    const section = sections.get(sourceSection.Y);
    const sectionLabel = `${label} section ${sourceSection.Y}`;
    assert.ok(section, sectionLabel);
    const { blocks, variants: metadata } = sectionBlocks(sourceSection);
    for (const [sourceKey, outputKey] of [['SkyLight', 'skyLight'], ['BlockLight', 'blockLight']]) {
      assert.equal(section[outputKey], sourceSection[sourceKey]?.toString('base64'), `${sectionLabel} ${sourceKey}`);
      counts[outputKey + 'Values'] += (sourceSection[sourceKey]?.length ?? 0) * 2;
    }
    const indices = Buffer.from(section.indices, 'base64');
    assert.equal(indices.length, 2 * blocks.length, `${sectionLabel} palette indices`);
    const firstCell = section.y * 4096;
    for (let i = 0; i < blocks.length; i++) {
      const paletteIndex = indices.readUInt16LE(2 * i);
      const state = palette[paletteIndex];
      if (state?.id !== blocks[i] || state.id && state.meta !== metadata[i]) {
        throw new Error(`${sectionLabel} index ${i}: expected ${blocks[i]}:${metadata[i]}, got ${paletteKeys[paletteIndex]}`);
      }
      if (!state.id) {
        counts.air++;
        continue;
      }
      if (state.composition || tiles.size && tiles.has(firstCell + i)) {
        const position = [16 * x + (i & 15), 16 * section.y + (i >> 8), 16 * z + ((i >> 4) & 15)];
        compareMultipart(tiles.get(firstCell + i), state, position.join(','));
      }
      variants[state.id * 16 + state.meta] = 1;
      counts.blocks++;
    }
    counts.sections++;
  }
  counts.chunks++;
}

const coordinates = [...manifest.chunks, ...(manifest.visualChunks ?? [])];
assert.equal(new Set(coordinates.map(([x,z]) => `${x}.${z}`)).size, coordinates.length, 'Duplicate chunk coordinates');
const { minX, maxX, minZ, maxZ } = manifest.bounds;
assert.ok([minX, maxX + 1, minZ, maxZ + 1].every(value => Number.isInteger(value / 16)), 'Chunk-aligned bounds');
assert.equal(manifest.chunks.length, (maxX - minX + 1) * (maxZ - minZ + 1) / 256, 'Complete playable rectangle');
for (const [x, z] of manifest.chunks) {
  assert.ok(Number.isInteger(x) && x * 16 >= minX && x * 16 <= maxX &&
    Number.isInteger(z) && z * 16 >= minZ && z * 16 <= maxZ, `Playable chunk ${x},${z} inside bounds`);
  assert.ok(/^[a-f0-9]{64}$/.test(manifest.chunkHash?.[`${x}.${z}.json`]), `Missing playable hash for ${x},${z}`);
}
const sceneryHashes = Object.create(null);
for (const [file, regionChunks] of Map.groupBy(coordinates, regionFor)) {
  const region = readFileSync(join(source, 'region', file));
  for (const [x, z] of regionChunks) {
    const raw = readRegionChunk(region, x, z);
    assert.ok(raw, `Source chunk ${x},${z}`);
    const key = `${x}.${z}.json`;
    const data = readFileSync(join(worldDirectory, 'chunks', key), 'utf8');
    const hash = sha256(data);
    if (manifest.chunkHash?.[key] !== undefined) assert.equal(hash, manifest.chunkHash[key], `Imported hash of ${key}`);
    else if (manifest.visualHash) sceneryHashes[key] = hash;
    compareChunk(x, z, raw, JSON.parse(data));
  }
}
if (manifest.visualHash) assert.equal(sha256(canonicalJson(sceneryHashes)), manifest.visualHash, 'Imported scenery hash');
const mountedMaps = [...itemMaps].sort((a,b) => a-b);
if (manifest.itemMaps) assert.deepEqual(manifest.itemMaps, mountedMaps, 'Mounted maps match source entities');
const report = { worldHash: manifest.contentHash, bounds: manifest.bounds, ...counts,
  nonAirVariants: variants.reduce((count, present) => count + present, 0), itemMaps:mountedMaps };
if (output) writeFileSync(resolve(output), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
