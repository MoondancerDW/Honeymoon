// Legacy RenderBlocks renders the track twice with opposite winding.
const coordinates = [
  [[1, 0], [1, 1], [0, 1], [0, 0]],
  [[1, 1], [0, 1], [0, 0], [1, 0]],
  [[0, 1], [0, 0], [1, 0], [1, 1]],
  [[0, 0], [1, 0], [1, 1], [0, 1]],
];
const orientations = [0, 1, 1, 1, 0, 0, 0, 1, 2, 3];
const cornersUv = [[1, 0], [1, 1], [0, 1], [0, 0]];

export function railShape(id, meta) {
  const direction = id === 66 ? meta : meta & 7;
  const tile = id === 66 ? (meta >= 6 ? 112 : 128) : id === 27 ? (meta & 8 ? 179 : 163) : 195;
  const slope = direction >= 2 && direction <= 5;
  const raisesFirstEdge = direction === 2 || direction === 4;
  const corners = coordinates[orientations[direction] ?? 0].map(([x, z], index) => {
    const firstEdge = index === 0 || index === 3;
    return [x, 1 / 16 + Number(slope && firstEdge === raisesFirstEdge), z];
  });
  return {
    x0: 0, y0: 0, z0: 0, x1: 1, y1: slope ? 5 / 8 : 1 / 8, z1: 1,
    faces: Array(6).fill(tile), mode: 'cutout', solid: false,
    kind: 'rail', corners, uv: cornersUv,
  };
}
