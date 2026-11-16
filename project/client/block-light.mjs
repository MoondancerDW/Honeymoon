import {attenuationOf, emissionOf} from '../world/block-light.mjs';
import {fullVoxelFluid, isOpaqueFullVoxels} from '../world/voxel-chisel.mjs';

const RADIUS = 15;
const SIDE = RADIUS * 2 + 3;
const MIDDLE = RADIUS + 1;
const PLANE = SIDE * SIDE;
const STRIDES = [-1, 1, -SIDE, SIDE, -PLANE, PLANE];

const samples = [];
for (let dy = -MIDDLE; dy <= MIDDLE; dy++) {
  for (let dz = -MIDDLE; dz <= MIDDLE; dz++) {
    for (let dx = -MIDDLE; dx <= MIDDLE; dx++) {
      const distance = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
      if (distance > MIDDLE) continue;
      samples.push({dx, dy, dz, distance, i: dx + MIDDLE + (dz + MIDDLE) * SIDE + (dy + MIDDLE) * PLANE});
    }
  }
}

function cellAttenuation(cell, emission) {
  // Light still propagates on the original block grid. A fully flooded cell
  // absorbs the same light as a source block. Small open shapes use air.
  if (cell.fluid === 'water') return attenuationOf('legacy:9:0');
  if (cell.voxels) {
    if (isOpaqueFullVoxels(cell.voxels) && !emission) return 15;
    if (fullVoxelFluid(cell.voxels) === 'water') return attenuationOf('legacy:9:0');
    return 1;
  }
  return attenuationOf(cell.key, emission);
}

function cellEmission(cell) {
  const fluidEmission = cell.fluid === 'lava' ? emissionOf('legacy:11:0') : 0;
  if (!cell.voxels) return Math.max(fluidEmission, emissionOf(cell.key, cell.object?.data));
  let emission = fluidEmission;
  for (const material of cell.voxels?.materials ?? []) emission = Math.max(emission, emissionOf(material));
  return emission;
}

export function lightChanged(before, after) {
  const oldEmission = cellEmission(before);
  const newEmission = cellEmission(after);
  return oldEmission !== newEmission || cellAttenuation(before, oldEmission) !== cellAttenuation(after, newEmission);
}

export function updateBlockLight(world, x, y, z, previousCenter) {
  const values = new Uint8Array(SIDE ** 3);
  const attenuation = new Uint8Array(values.length).fill(255);
  const buckets = Array.from({length: 16}, () => []);
  const {minY=0,maxY=255} = world.manifest?.bounds ?? {};
  for (const {dx, dy, dz, distance, i} of samples) {
    const xx = x + dx, yy = y + dy, zz = z + dz;
    if (yy < minY || yy > maxY || !world.chunks.has(`${xx >> 4},${zz >> 4}`)) continue;
    if (distance === MIDDLE) {
      values[i] = world.lightAt(xx, yy, zz) & 15;
    } else {
      const cell = world.lightCell(xx, yy, zz);
      const level = cellEmission(cell);
      values[i] = level;
      attenuation[i] = cellAttenuation(cell, level);
    }
    if (values[i]) buckets[values[i]].push(i);
  }

  for (let level = 15; level > 1; level--) {
    for (const i of buckets[level]) {
      if (values[i] !== level) continue;
      for (const step of STRIDES) {
        const next = i + step;
        const reduced = level - attenuation[next];
        if (!(reduced > values[next])) continue;
        values[next] = reduced;
        buckets[reduced].push(next);
      }
    }
  }

  const dirty = new Set();
  for (const {dx, dy, dz, distance, i} of samples) {
    if (distance > RADIUS || attenuation[i] === 255) continue;
    const xx = x + dx, yy = y + dy, zz = z + dz;
    const key = `${xx},${yy},${zz}`;
    const original = world.baseLightAt(xx, yy, zz) & 15;
    const current = world.lightAt(xx, yy, zz) & 15;
    const prior = distance === 0 ? previousCenter ?? current : current;
    if (values[i] === original) world.blockLightOverrides.delete(key);
    else world.blockLightOverrides.set(key, values[i]);
    if (values[i] === prior) continue;
    for (const [ox, oy, oz] of [[0,0,0], [-1,0,0], [1,0,0], [0,-1,0], [0,1,0], [0,0,-1], [0,0,1]]) {
      dirty.add(`${(xx + ox) >> 4},${(yy + oy) >> 4},${(zz + oz) >> 4}`);
    }
  }
  return dirty;
}
