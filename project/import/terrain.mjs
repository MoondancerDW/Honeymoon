import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { coverParts, sectionBlocks } from './nbt.mjs';
import { fullCoverMaterial } from '../world/cover-plane.mjs';

const STEP = 4;
const LEVEL_CELLS = 64;
const MIN_OCCUPANCY = 3;
const COVER_MATERIAL_BASE = 65536;
const RING_RADII = [8, 16, 32];
const FINE_DECORATION = new Set([
  6, 27, 28, 30, 31, 32, 37, 38, 39, 40, 50, 51, 55, 59, 63, 65, 66, 68, 69, 70,
  72, 75, 76, 77, 83, 104, 105, 106, 111, 115, 131, 132, 141, 142, 143, 147, 148,
]);

export const terrainRadii = [0, ...RING_RADII];

function coarseSection(section, coverPlanes, palette, indexByKey) {
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
              const plane = coverPlanes.get(section.Y * 4096 + index);
              if (plane === undefined && (id === 0 || FINE_DECORATION.has(id) || (id === 750 && variants[index] === 0))) continue;
              const key = plane === undefined ? id * 16 + variants[index] : COVER_MATERIAL_BASE + plane;
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
        if (occupancy < MIN_OCCUPANCY && bestKey < COVER_MATERIAL_BASE) continue;

        const name = bestKey < COVER_MATERIAL_BASE
          ? `legacy:${bestKey >> 4}:${bestKey & 15}` : `full-cover-material:${bestKey - COVER_MATERIAL_BASE}`;
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

function scanCovers(level, compositions, collectPlanes) {
  const result = new Map();
  for (const tile of level.TileEntities ?? []) {
    if (!Buffer.isBuffer(tile.cvs) || !Number.isInteger(tile.cvm)) continue;
    if (tile.id === 'Covers') compositions.add(`${tile.cvm}:${tile.cvs.toString('hex')}`);
    if (!collectPlanes || ![tile.x,tile.y,tile.z].every(Number.isInteger)) continue;
    const material = fullCoverMaterial(coverParts(tile)?.parts, tile.id === 'RPFrame');
    if (material !== undefined) result.set((tile.x & 15) + (tile.z & 15) * 16 + tile.y * 256, material);
  }
  return result;
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
        const coverPlanes = scanCovers(level, compositions, !inner);
        if (inner) continue;
        const levels = [];
        for (const section of [...(level.Sections ?? [])].sort((left, right) => left.Y - right.Y)) {
          const coarse = coarseSection(section, coverPlanes, palette, indexByKey);
          if (!coarse) continue;
          occupiedCells += coarse.occupiedCells;
          levels.push({ y: coarse.y, indices: coarse.indices });
        }
        chunks.push({ x, z, levels });
      }
    }

    const file = `terrain-${radius}.json`;
    const path = join(output, file);
    const ring = { schemaVersion: 1, step: STEP, innerRadius: Math.min(innerRadius, radius), radius, palette, chunks, missingChunks };
    writeFileSync(path, `${JSON.stringify(ring)}\n`);
    summary.push({
      file, radius, innerRadius: ring.innerRadius, chunks: chunks.length, missing: missingChunks.length, occupiedCells,
      coverPatternsThroughRadius: compositions.size, bytes: statSync(path).size,
    });
    innerRadius = Math.max(innerRadius, radius);
  }
  return summary;
}
