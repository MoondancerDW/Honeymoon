// Full tree logs from the imported block registry, including the modded woods.
export const isTreeLog = key => /^legacy:(?:17|245|701|2163|2176|3251):\d+$/.test(key);

export function logAxis(faces) {
  // The registry stores the actual face pair after metadata and mod rotations.
  for (let axis = 0; axis < 3; axis++) {
    const end = faces[axis * 2];
    if (end < 0 || end !== faces[axis * 2 + 1]) continue;
    const bark = faces[(axis * 2 + 2) % 6];
    if (bark >= 0 && bark !== end && faces.every((tile, face) => tile === ((face >> 1) === axis ? end : bark))) {
      return axis;
    }
  }
  // All-bark wood remains square, and its neighbors treat it as a side joint.
  return -1;
}

export const joinsLogEnds = (axis, otherAxis, face) => axis === (face >> 1) && axis === otherAxis;

const inset = 3 / 16;
const lip = 1 - inset;
const ring = [[inset,0],[lip,0],[1,inset],[1,lip],[lip,1],[inset,1],[0,lip],[0,inset]];
const capQuads = [[0,1,2,7],[7,2,3,6],[6,3,4,5]];

export const roundedLogSurfaces = [0, 1, 2].map(axis => {
  const u = (axis + 1) % 3, v = (axis + 2) % 3;
  const sides = [2 * v, 2 * u + 1, 2 * v + 1, 2 * u];
  function point(index, end) {
    const p = [0, 0, 0];
    [p[u], p[v]] = ring[index];
    p[axis] = end;
    return p;
  }
  const surfaces = ring.map((_, index) => {
    const next = (index + 1) % ring.length;
    const side = index >> 1;
    return {
      face: sides[side],
      bevel: index & 1 ? sides[(side + 1) % 4] : undefined,
      points: [point(index, 0), point(next, 0), point(next, 1), point(index, 1)],
    };
  });
  for (const end of [0, 1]) {
    for (const indices of capQuads) {
      surfaces.push({face: 2 * axis + end, points: (end ? indices : indices.toReversed()).map(index => point(index, end))});
    }
  }
  return surfaces;
});
