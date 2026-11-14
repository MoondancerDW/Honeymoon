import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sectionBlocks } from './nbt.mjs';

const STEP = 4;
const LEVEL_CELLS = 64;
const MIN_OCCUPANCY = 3;
const RING_RADII = [8, 16, 32];
const COVER_MATERIAL_BASE = 65536;
const FINE_DECORATION = new Set([
  6, 27, 28, 30, 31, 32, 37, 38, 39, 40, 50, 51, 55, 59, 63, 65, 66, 68, 69, 70,
  72, 75, 76, 77, 83, 104, 105, 106, 111, 115, 131, 132, 141, 142, 143, 147, 148,
]);

export const terrainRadii = [0, ...RING_RADII];

function coarseSection(section, coverMaterials, palette, indexByKey) {
  const { blocks, variants } = sectionBlocks(section);
  const coarse = Buffer.alloc(LEVEL_CELLS * 2);
  const counts = new Uint8Array(COVER_MATERIAL_BASE + 256);
  const keys = new Uint32Array(64);
  let occupiedCells = 0;
  for (let cy = 0; cy < 4; cy += 1) {
    for (let cz = 0; cz < 4; cz += 1) {
      for (let cx = 0; cx < 4; cx += 1) {
        let occupancy = 0;
        let keyCount = 0;
        for (let dy = 0; dy < STEP; dy += 1) {
          for (let dz = 0; dz < STEP; dz += 1) {
            const row = STEP * cx + 16 * (STEP * cz + dz) + 256 * (STEP * cy + dy);
            for (let dx = 0; dx < STEP; dx += 1) {
              const index = row + dx;
              const id = blocks[index];
              if (id === 0 || FINE_DECORATION.has(id)) continue;
              const key = coverMaterials?.get(index) ?? id * 16 + variants[index];
              occupancy += 1;
              if (counts[key] === 0) {
                keys[keyCount] = key;
                keyCount += 1;
              }
              counts[key] += 1;
            }
          }
        }

        let bestKey = 0;
        for (let index = 0; index < keyCount; index += 1) {
          const key = keys[index];
          if (counts[key] > counts[bestKey] || (counts[key] === counts[bestKey] && key < bestKey)) bestKey = key;
        }
        for (let index = 0; index < keyCount; index += 1) counts[keys[index]] = 0;
        if (occupancy < MIN_OCCUPANCY) continue;

        const name = bestKey < COVER_MATERIAL_BASE
          ? `legacy:${bestKey >> 4}:${bestKey & 15}`
          : `cover-material:${bestKey - COVER_MATERIAL_BASE}`;
        if (!indexByKey.has(name)) {
          if (palette.length >= 65536) throw new Error('Terrain palette exceeds uint16');
          indexByKey.set(name, palette.length);
          palette.push(name);
        }
        coarse.writeUInt16LE(indexByKey.get(name), (cx + 4 * cz + 16 * cy) * 2);
        occupiedCells += 1;
      }
    }
  }
  return occupiedCells ? { y: section.Y, indices: coarse.toString('base64'), occupiedCells } : null;
}

function scanCompositions(level, compositions) {
  const materials = new Map();
  for (const tile of level.TileEntities ?? []) {
    if (tile.id !== 'Covers' || !Buffer.isBuffer(tile.cvs) || !Number.isInteger(tile.cvm)) continue;
    compositions.add(`${tile.cvm}:${tile.cvs.toString('hex')}`);
    if (!tile.cvs.length) continue;
    const sectionY = Math.floor(tile.y / 16);
    const offset = (tile.x & 15) + 16 * (tile.z & 15) + 256 * (tile.y & 15);
    if (!materials.has(sectionY)) materials.set(sectionY, new Map());
    materials.get(sectionY).set(offset, COVER_MATERIAL_BASE + tile.cvs[0]);
  }
  return materials;
}

export function writeTerrainRings(output, maxRadius, loadChunk, detailRadius) {
  const compositions = new Set();
  const summary = [];
  let innerRadius = detailRadius;
  for (const radius of RING_RADII) {
    if (radius > maxRadius) break;
    const chunks = [];
    const palette = ['air'];
    const indexByKey = new Map([['air', 0]]);
    const missingChunks = [];
    let occupiedCells = 0;
    for (let z = -radius; z < radius; z += 1) {
      for (let x = -radius; x < radius; x += 1) {
        const inner = x >= -innerRadius && x < innerRadius && z >= -innerRadius && z < innerRadius;
        if (inner && innerRadius !== detailRadius) continue;
        const level = loadChunk(x, z);
        if (!level) {
          if (!inner) missingChunks.push([x, z]);
          continue;
        }
        const coverMaterials = scanCompositions(level, compositions);
        if (inner) continue;
        const levels = [];
        for (const section of [...(level.Sections ?? [])].sort((left, right) => left.Y - right.Y)) {
          const coarse = coarseSection(section, coverMaterials.get(section.Y), palette, indexByKey);
          if (!coarse) continue;
          occupiedCells += coarse.occupiedCells;
          levels.push({ y: coarse.y, indices: coarse.indices });
        }
        chunks.push({ x, z, levels });
      }
    }

    const file = `terrain-${radius}.json`;
    const path = join(output, file);
    const ring = { schemaVersion: 1, step: STEP, innerRadius, radius, palette, chunks, missingChunks };
    writeFileSync(path, `${JSON.stringify(ring)}\n`);
    summary.push({
      file, radius, innerRadius, chunks: chunks.length, missing: missingChunks.length, occupiedCells,
      coverPatternsThroughRadius: compositions.size, bytes: statSync(path).size,
    });
    innerRadius = radius;
  }
  return summary;
}
