import {coverBoxes} from './geometry.mjs';

// RedPower bounds use an eighth-block grid. Count only material touching the
// same cell boundary, so projecting pieces through a gap cannot fill the face.
export function fullCoverMaterial(parts, frame = false) {
  if (!parts?.length) return undefined;
  const bounds = coverBoxes(parts, frame).map(({x0,y0,z0,x1,y1,z1,material}) =>
    ({min:[x0,y0,z0], max:[x1,y1,z1], material}));
  // Keep the roof material for distant shells with multiple closed sides.
  for (const face of [3,2,0,1,4,5]) {
    const axis = face >> 1, high = face & 1;
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    const cells = new Int16Array(64).fill(-1);
    for (const {min,max,material} of bounds) {
      if ((high ? max[axis] : min[axis]) !== high) continue;
      for (let y = min[v] * 8; y < max[v] * 8; y++) {
        cells.fill(material, y * 8 + min[u] * 8, y * 8 + max[u] * 8);
      }
    }
    if (cells.includes(-1)) continue;
    const counts = new Map();
    for (const material of cells) counts.set(material, (counts.get(material) ?? 0) + 1);
    let dominant = cells[0];
    for (const [material, count] of counts) {
      if (count > counts.get(dominant)) dominant = material;
    }
    return dominant;
  }
  return undefined;
}
