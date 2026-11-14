export function intersectSelection(origin, direction, box, x, y, z, range = 6) {
  const starts = [x + box.x0, y + box.y0, z + box.z0];
  const ends = [x + box.x1, y + box.y1, z + box.z1];
  let entry = -Infinity, exit = Infinity, face = -1;
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(direction[axis]) < 1e-9) {
      if (origin[axis] < starts[axis] || origin[axis] > ends[axis]) return null;
      continue;
    }
    const low = (starts[axis] - origin[axis]) / direction[axis];
    const high = (ends[axis] - origin[axis]) / direction[axis];
    if (Math.min(low, high) > entry) {
      entry = Math.min(low, high);
      face = 2 * axis + Number(low > high);
    }
    exit = Math.min(exit, Math.max(low, high));
    if (entry > exit) return null;
  }
  if (exit < 0 || entry > range || face < 0) return null;
  const offset = [0, 0, 0];
  offset[face >> 1] = face & 1 ? 1 : -1;
  return {length: Math.max(0, entry), offset};
}
