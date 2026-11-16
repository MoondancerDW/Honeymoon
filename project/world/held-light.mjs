import {attenuationOf, emissionOf} from './block-light.mjs';
import {coverBoxes} from './geometry.mjs';
import {fullVoxelFluid, isOpaqueFullVoxels} from './voxel-chisel.mjs';

// Lava, glowstone dust, the two Lilium lamps, Essence of Light and Torchberries.
const glowingItems = new Map([['327:0',15], ['348:0',4], ['5750:0',12], ['5767:0',13], ['9085:0',6], ['27984:0',4]]);

export function heldLamp(key) {
  const damage = Number(/^creative:768:(\d{1,2})$/.exec(key ?? '')?.[1]);
  if (damage < 64) return {color:damage & 15, style:damage >> 5, ps:damage & 16 ? 2 : 0, rot:0};
  return null;
}

export function heldLightLevel(held) {
  if (held?.kind === 'item') return glowingItems.get(held.key) ?? 0;
  if (held?.kind === 'block') {
    const lamp = heldLamp(held.key);
    return emissionOf(lamp ? 'legacy:768:0' : held.key, lamp);
  }
  return 0;
}

export const HELD_LIGHT_RADIUS = 15;
export const HELD_LIGHT_SIDE = HELD_LIGHT_RADIUS * 2 + 1;
const plane = HELD_LIGHT_SIDE ** 2;
export const HELD_LIGHT_VOXELS = HELD_LIGHT_SIDE ** 3;
const center = (1 + HELD_LIGHT_SIDE + plane) * HELD_LIGHT_RADIUS;
const stride = [-1, 1, -HELD_LIGHT_SIDE, HELD_LIGHT_SIDE, -plane, plane];
const axes = [0,0,2,2,1,1];
const min = ['x0','y0','z0'], max = ['x1','y1','z1'];
const closedFaces = new WeakMap();

function opaqueCoverFaces(parts) {
  if (closedFaces.has(parts)) return closedFaces.get(parts);
  const boxes = coverBoxes(parts).filter(box=>box.mode === 'opaque');
  const rows = new Uint8Array(8);
  let mask = 0;
  for (const [face,axis] of axes.entries()) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    rows.fill(0);
    for (const box of boxes) {
      if (face & 1 ? box[max[axis]] !== 1 : box[min[axis]] !== 0) continue;
      const columns = (1 << (8 * box[max[u]])) - (1 << (8 * box[min[u]]));
      for (let y = 8 * box[min[v]]; y < 8 * box[max[v]]; y++) rows[y] |= columns;
    }
    if (rows.every(value=>value === 255)) mask |= 1 << face;
  }
  closedFaces.set(parts,mask);
  return mask;
}

export function heldLightOcclusion(cell) {
  if (isOpaqueFullVoxels(cell.voxels)) return 15;
  const opacity = cell.fluid === 'water' || fullVoxelFluid(cell.voxels) === 'water'
    ? attenuationOf('legacy:9:0') : attenuationOf(cell.key);
  const closed = cell.parts?.length ? opaqueCoverFaces(cell.parts) : 0;
  return opacity | closed << 4;
}

// Byte values encode levels 0–15 in a normalized R8 texture. The 15th ring
// stays at zero, so neighbors of positive cells never wrap to another row.
export function fillHeldLight(values, attenuation, x, y, z, intensity, opacityAt) {
  values.fill(0);
  attenuation.fill(0);
  const frontier = Array.from({length:16}, () => []);
  const local = attenuation[center] = opacityAt(x, y, z);
  if ((local & 15) === 15) return;
  const levelAtSource = Math.max(0, intensity - (local & 15) + 1);
  if (!levelAtSource) return;
  values[center] = levelAtSource * 17;
  frontier[levelAtSource].push(center);
  for (let level = levelAtSource; level > 1; level--) {
    for (const index of frontier[level]) {
      if (values[index] !== level * 17) continue;
      const blocked = attenuation[index] >> 4;
      for (let face = 0; face < stride.length; face++) {
        if (blocked & (1 << face)) continue;
        const next = index + stride[face];
        if (values[next] >= (level - 1) * 17) continue;
        let loss = attenuation[next];
        if (!loss) {
          const dx = next % HELD_LIGHT_SIDE - HELD_LIGHT_RADIUS;
          const dz = Math.floor(next / HELD_LIGHT_SIDE) % HELD_LIGHT_SIDE - HELD_LIGHT_RADIUS;
          const dy = Math.floor(next / plane) - HELD_LIGHT_RADIUS;
          loss = attenuation[next] = opacityAt(x + dx, y + dy, z + dz);
        }
        if (loss >> 4 & (1 << (face ^ 1))) continue;
        const reduced = level - (loss & 15);
        if (reduced * 17 <= values[next]) continue;
        values[next] = reduced * 17;
        frontier[reduced].push(next);
      }
    }
  }
}
