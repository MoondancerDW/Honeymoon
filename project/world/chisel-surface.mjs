import {blockState} from './block-interactions.mjs';
import {encodeVoxels, filledVoxels, VOXEL_COUNT, VOXEL_SIZE, voxelAtHit, voxelPlacementAtHit} from './voxel-chisel.mjs';

const water = 'legacy:9:0';
const lava = 'legacy:11:0';
const axes = ['x', 'y', 'z'];

export function chiselMaterialKey(key) {
  const [id] = blockState(key);
  if (id === 8 || id === 9) return water;
  if (id === 10 || id === 11) return lava;
  return key;
}

function layersForHeight(height) {
  return Math.ceil(height * VOXEL_SIZE - 1e-6);
}

function usesSurfaceHeight(key) {
  const [id] = blockState(key);
  return id >= 8 && id <= 11 || id === 88;
}

// Placing beside a regular source cell uses the outer boundary of that cell.
// Its actual hit remains separate and is still used for reach validation.
function materialFace(cell, hit, face, wholeBlock) {
  if (!wholeBlock) return hit;
  const normal = face.findIndex(Boolean);
  if (normal < 0) return hit;
  const axis = axes[normal];
  return {...hit, [axis]:cell[axis] + Number(face[normal] > 0)};
}

export function chiselVoxelAtHit(cell, hit, face, voxels, sourceKey) {
  if (!voxels && face[1] === 1 && usesSurfaceHeight(sourceKey)) {
    const layers = Math.max(1, layersForHeight(hit.y - cell.y));
    return voxelAtHit(cell, {...hit, y:cell.y + layers / VOXEL_SIZE}, face);
  }
  return voxelAtHit(cell, materialFace(cell, hit, face, !voxels), face, true, voxels);
}

export function chiselPlacementAtHit(cell, hit, face, voxels, partSlot) {
  return voxelPlacementAtHit(cell, materialFace(cell, hit, face, !voxels && partSlot === undefined), face, voxels);
}

export function chiselSourceVolume(sourceKey, boxes) {
  const material = chiselMaterialKey(sourceKey);
  if (!usesSurfaceHeight(sourceKey)) return filledVoxels(material);
  const layers = Math.max(1, Math.min(VOXEL_SIZE, layersForHeight(boxes[0]?.y1 ?? 1)));
  return encodeVoxels(new Uint8Array(VOXEL_COUNT).fill(1, 0, layers * VOXEL_SIZE ** 2), [material]);
}
