import {hasHatchRung} from './west-cellar.mjs';
import {VOXEL_SIZE, voxelFluidAt} from './voxel-chisel.mjs';

const keyOf = cell => typeof cell === 'string' ? cell : cell?.key;

export function isLadder(cell) {
  const key = keyOf(cell);
  return key?.startsWith('legacy:65:') || key?.startsWith('legacy:106:') || hasHatchRung(cell);
}

export function liquidLevel(cell) {
  const match = /^legacy:(8|9):(\d+)$/.exec(keyOf(cell) ?? '');
  if (!match) return null;
  const meta = Number(match[2]);
  return 1 - ((meta < 8 ? meta : 0) + 1) / 9;
}

export function movementMedium(cellAt, x, y, z) {
  // A collision may settle the feet a few micrometres below the floor plane.
  const xx = Math.floor(x), zz = Math.floor(z), yy = Math.floor(y + .00001);
  const atFeet = cellAt(xx, yy, zz);
  if (isLadder(atFeet)) return 'ladder';
  const level = liquidLevel(atFeet);
  const depth = y + .1;
  let above;
  if (level !== null) {
    above = cellAt(xx, yy + 1, zz);
    if (liquidLevel(above) !== null || depth < yy + level) return 'water';
  }
  const sampleY = Math.floor(depth);
  const sample = sampleY === yy ? atFeet : (above ?? cellAt(xx, sampleY, zz));
  if (sample?.voxels && voxelFluidAt(sample.voxels,
      Math.floor((x - xx) * VOXEL_SIZE), Math.floor((depth - sampleY) * VOXEL_SIZE),
      Math.floor((z - zz) * VOXEL_SIZE)) === 'water') return 'water';
  return null;
}
