import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson, readRegionChunk, sectionBlocks } from '../import/nbt.mjs';

const [worldDirectory = 'generated/world', source = '../sources/Honeymoon/saves/equestria', output] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(join(worldDirectory, 'world.json'), 'utf8'));
assert.equal(manifest.coordinateTransform, 'identity');
const regionFor = ([x, z]) => `r.${Math.floor(x / 32)}.${Math.floor(z / 32)}.mca`;
const counts = { chunks: 0, playableChunks: manifest.chunks.length, sceneryChunks: manifest.visualChunks?.length ?? 0,
  sections: 0, blocks: 0, air: 0, skyLightValues: 0, blockLightValues: 0,
  multipartCells: 0, parts: 0, tiles: 0, entities: 0 };
const variants = new Set();
const stateFor = manifest.palette.map(key => {
  if (key === 'air') return { id: 0, meta: 0 };
  const [, id, meta] = key.split(':');
  assert.ok(Number.isInteger(Number(id)) && Number.isInteger(Number(meta)), `Invalid palette key ${key}`);
  return { id: Number(id), meta: Number(meta), composition: manifest.compositions[key] };
});

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
  compareRecords(imported.objects, raw.TileEntities ?? [], 'tiles', label);
  compareRecords(imported.entities, raw.Entities ?? [], 'entities', label);
  const sections = new Map(imported.sections.map(section => [section.y, section]));
  assert.equal(sections.size, raw.Sections.length, `${label} sections`);
  assert.equal(imported.sections.length, sections.size, `${label} duplicate sections`);
  const tiles = new Map((raw.TileEntities ?? []).map(tile => [`${tile.x}:${tile.y}:${tile.z}`, tile]));
  for (const sourceSection of raw.Sections) {
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
    for (let i = 0; i < blocks.length; i++) {
      const paletteIndex = indices.readUInt16LE(2 * i);
      const state = stateFor[paletteIndex];
      if (state?.id !== blocks[i] || state.id && state.meta !== metadata[i]) {
        throw new Error(`${sectionLabel} index ${i}: expected ${blocks[i]}:${metadata[i]}, got ${manifest.palette[paletteIndex]}`);
      }
      if (!state.id) {
        counts.air++;
        continue;
      }
      const position = [16 * x + (i & 15), 16 * section.y + (i >> 8), 16 * z + ((i >> 4) & 15)];
      const tile = tiles.get(position.join(':'));
      if (state.composition || Number.isInteger(tile?.cvm) && Buffer.isBuffer(tile.cvs)) {
        assert.ok(tile && state.composition, `Missing multipart data at ${position}`);
        const { type, cvm, cvs, parts } = state.composition;
        assert.equal(type, tile.id, `Multipart type at ${position}`);
        assert.equal(cvm, tile.cvm, `Multipart mask at ${position}`);
        assert.equal(cvs, tile.cvs.toString('base64'), `Multipart bytes at ${position}`);
        const expectedParts = [];
        const mask = tile.id === 'RPFrame' ? tile.cvm & 63 : tile.cvm >>> 0;
        for (let slot = 0; slot < 29; slot++) {
          if (!(mask & (1 << slot))) continue;
          const offset = expectedParts.length * 2;
          expectedParts.push({ slot, material: tile.cvs[offset], shape: tile.cvs[offset + 1] });
        }
        assert.deepEqual(parts, expectedParts, `Multipart geometry inputs at ${position}`);
        counts.multipartCells++;
        counts.parts += parts.length;
      }
      variants.add(state.id * 16 + state.meta);
      counts.blocks++;
    }
    counts.sections++;
  }
  counts.chunks++;
}

const coordinates = [...manifest.chunks, ...(manifest.visualChunks ?? [])];
for (const [file, regionChunks] of Map.groupBy(coordinates, regionFor)) {
  const region = readFileSync(join(source, 'region', file));
  for (const [x, z] of regionChunks) {
    const raw = readRegionChunk(region, x, z);
    assert.ok(raw, `Source chunk ${x},${z}`);
    const imported = JSON.parse(readFileSync(join(worldDirectory, 'chunks', `${x}.${z}.json`), 'utf8'));
    compareChunk(x, z, raw, imported);
  }
}
const report = { worldHash: manifest.contentHash, bounds: manifest.bounds, ...counts, nonAirVariants: variants.size };
if (output) writeFileSync(resolve(output), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
