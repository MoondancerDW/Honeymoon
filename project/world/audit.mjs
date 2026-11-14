import { statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { readRegionChunk } from '../import/nbt.mjs';
import { ATLAS_GRID, TILE_SIZE, bedMesh, chestMesh, redPowerTubeMesh, redPowerWireMesh,
  shapeFor, sourceAtlasModel, standingSignMesh, tiles } from './geometry.mjs';
import { extractedModel, modelFamilies } from './extracted-models.mjs';

const PROJECT = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: {
  'world-data': { type: 'string', default: join(PROJECT, 'generated/world') },
  'source-world': { type: 'string', default: join(PROJECT, '../sources/Honeymoon/saves/equestria') },
  radius: { type: 'string', default: '32' },
  output: { type: 'string', default: join(PROJECT, 'generated/world-audit.json') },
} });
const radius = Number(values.radius);
if (!Number.isInteger(radius) || radius < 4 || radius > 32) throw new RangeError('Radius must be 4–32 chunks');

function sourceCompositions(source, radius) {
  const definitions = new Map();
  let coverCells = 0;
  let readChunks = 0;
  for (let rz = Math.floor(-radius / 32); rz <= Math.floor((radius - 1) / 32); rz++) {
    for (let rx = Math.floor(-radius / 32); rx <= Math.floor((radius - 1) / 32); rx++) {
      const regionPath = join(source, 'region', 'r.' + rx + '.' + rz + '.mca');
      let region;
      try {
        region = readFileSync(regionPath);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      for (let z = Math.max(-radius, rz * 32); z < Math.min(radius, (rz + 1) * 32); z++) {
        for (let x = Math.max(-radius, rx * 32); x < Math.min(radius, (rx + 1) * 32); x++) {
          const chunk = readRegionChunk(region, x, z);
          if (!chunk) continue;
          readChunks++;
          for (const tile of chunk.TileEntities ?? []) {
            if (tile.id !== 'Covers' || !Buffer.isBuffer(tile.cvs)) continue;
            coverCells++;
            const cvm = tile.cvm & 0x1fffffff;
            const cvs = tile.cvs.toString('base64');
            const identity = cvm + ':' + cvs;
            if (definitions.has(identity)) continue;
            const parts = [];
            for (let slot = 0; slot <= 28; slot++) {
              if (!(cvm & (1 << slot))) continue;
              const offset = parts.length * 2;
              if (offset + 1 >= tile.cvs.length) break;
              parts.push({ slot, material: tile.cvs[offset], shape: tile.cvs[offset + 1] });
            }
            definitions.set(identity, { cvm, cvs, parts });
          }
        }
      }
    }
  }
  return { readChunks, coverCells, definitions: [...definitions.values()] };
}

function bench(label, definitions, sourceCells, chunks) {
  const partsData = definitions.map(({ cvm, cvs, parts }) => ({ cvm, cvs, parts }));
  let start = performance.now();
  const rendered = partsData.map(definition => shapeFor({ key: 'cover:750:0:audit', ...definition }));
  const buildAllMs = performance.now() - start;
  const visibleTiles = new Set(rendered.flatMap(boxes => boxes.flatMap(box => box.faces)).filter(tile => tile >= 0));
  // A uses compact tuples and material faces referencing the same atlas as B.
  // Real Voxelize wire records add identifiers, flags and model fields.
  const fixedShapes = rendered.map(boxes => boxes.map(box => [
    box.x0, box.y0, box.z0, box.x1, box.y1, box.z1, box.faces, box.mode,
  ]));
  const measure = value => {
    const json = JSON.stringify(value);
    const compressed = gzipSync(json);
    start = performance.now();
    JSON.parse(json);
    return { jsonBytes: Buffer.byteLength(json), gzipBytes: compressed.length, parseMs: round(performance.now() - start) };
  };
  return {
    label, chunks, sourceCells, definitions: definitions.length,
    free16BitIdsBeforeOtherBlockTypes: 65536 - definitions.length,
    fixedDefinitionRegistry: measure(fixedShapes),
    compositionDataRegistry: measure(partsData),
    materialTilesSharedByBoth: visibleTiles.size,
    atlasBytesIfDuplicatingOneUniqueTilePerMaterialRGBA: visibleTiles.size * 16 * 16 * 4,
    sourceBoxes: rendered.reduce((count, boxes) => count + boxes.length, 0),
    buildAllMs: round(buildAllMs),
  };
}

const round = value => Number(value.toFixed(2));
const world = JSON.parse(readFileSync(join(values['world-data'], 'world.json'), 'utf8'));
const coreDefinitions = Object.values(world.compositions).filter(def => def.type === 'Covers');
const benchmarks = [bench('Detailed district', coreDefinitions, world.counts.covers, world.counts.chunks)];
if (radius > 4) {
  const broader = sourceCompositions(resolve(values['source-world']), radius);
  benchmarks.push(bench('Source radius ' + radius, broader.definitions, broader.coverCells, broader.readChunks));
}

const modelsDirectory = join(values['world-data'], '..', 'models');
const catalogs = {};
for (const family of modelFamilies) {
  try {
    catalogs[family] = JSON.parse(readFileSync(join(modelsDirectory, family + '.json'), 'utf8'));
    statSync(join(modelsDirectory, family + '.png'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    delete catalogs[family];
  }
}

const approximations = new Map(), unknownTextures = new Map();
const readChunk = (x, z) => JSON.parse(readFileSync(join(values['world-data'], 'chunks', x + '.' + z + '.json')));
const mapChunks = [...world.chunks, ...(world.visualChunks ?? [])];
let reviewedCells = 0, modelCells = 0;
const staticReasons = new Map();
for (const [x, z] of mapChunks) {
  const chunk = readChunk(x, z);
  const palette = chunk.palette ?? world.palette;
  const compositions = chunk.compositions ?? world.compositions;
  const objectsBySection = new Map();
  for (const object of chunk.objects) {
    if (!object.position) continue;
    const [bx, by, bz] = object.position;
    const cy = by >> 4;
    if (!objectsBySection.has(cy)) objectsBySection.set(cy, new Map());
    objectsBySection.get(cy).set((bx & 15) + 16 * (bz & 15) + 256 * (by & 15), object);
  }
  for (const section of chunk.sections) {
    const indices = Buffer.from(section.indices, 'base64');
    const objects = objectsBySection.get(section.y);
    for (let at = 0; at < 4096; at++) {
      const index = indices.readUInt16LE(at * 2);
      const key = palette[index];
      if (key === 'air') continue;
      reviewedCells++;
      const object = objects?.get(at);
      let diagnostics = object ? undefined : staticReasons.get(key);
      if (!diagnostics) {
        const cell = {key, ...compositions[key], object};
        const model = extractedModel(catalogs, cell) ?? sourceAtlasModel(key);
        const boxes = model ? [] : standingSignMesh(key) ?? redPowerTubeMesh(cell) ?? redPowerWireMesh(cell) ??
          chestMesh(cell) ?? bedMesh(key) ?? shapeFor(cell);
        const reasons = [...new Set(boxes.map(box => box.approximation).filter(Boolean))];
        if (!model && !boxes.length) reasons.push('Empty or absent legacy part payload');
        diagnostics = {model: Boolean(model), reasons, unknownTexture: boxes.some(box => box.faces?.includes(tiles.unknown))};
        if (!object) staticReasons.set(key, diagnostics);
      }
      modelCells += Number(diagnostics.model);
      if (!diagnostics.reasons.length && !diagnostics.unknownTexture) continue;
      const position = [16 * x + (at & 15), 16 * section.y + (at >> 8), 16 * z + (at >> 4 & 15)];
      if (diagnostics.unknownTexture) {
        const texture = unknownTextures.get(key) ?? {key, cells: 0, sample:position};
        texture.cells++;
        unknownTextures.set(key, texture);
      }
      if (!diagnostics.reasons.length) continue;
      const id = Number(key.split(':')[1]);
      const block = approximations.get(id) ?? {id, cells: 0, reasons: new Map(), sample:position};
      block.cells++;
      for (const reason of diagnostics.reasons) block.reasons.set(reason, (block.reasons.get(reason) ?? 0) + 1);
      approximations.set(id, block);
    }
  }
}

const atlasPath = join(PROJECT, 'generated/textures/atlas.png');
const entities = world.counts.entities;
const report = {
  worldHash: world.contentHash,
  atlas: {
    width: ATLAS_GRID * TILE_SIZE, height: ATLAS_GRID * TILE_SIZE, pngBytes: statSync(atlasPath).size,
    rgba8Bytes: (ATLAS_GRID * TILE_SIZE) ** 2 * 4,
  },
  benchmarks,
  renderer: {chunks: mapChunks.length, reviewedCells, modelCells,
    unknownTextures: [...unknownTextures.values()].sort((a, b) => b.cells - a.cells)},
  approximations: [...approximations.values()].sort((a, b) => b.cells - a.cells).map(block => ({
    ...block, reasons: Object.fromEntries(block.reasons),
  })),
  entityRendering: {
    Painting: { count: entities.Painting, status: 'original atlas, preserved Motive and direction' },
    preservedOnly: Object.fromEntries(Object.entries(entities).filter(([kind]) => kind !== 'Painting')),
  },
};
writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
