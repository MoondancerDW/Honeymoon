// CampfireMod's ModelCampfire positions, sizes and rotations in model pixels.
const sticks = [[0, 0, .3490659, -.3926991], [-1, 0, .3490659, .3926991],
  [-1, -1, -.3490659, .3926991], [0, -1, -.3490659, -.3926991]];
const stones = [[-8, -8, 0], [-8, 8, Math.PI / 2], [6, -6, 0], [-6, -6, Math.PI / 2]];
const parts = [
  ...sticks.map(([x, z, pitch, roll]) => [[x, 0, z], [1, 16, 1], [0, 10, 0], [pitch, 0, roll], 0]),
  [[0, 0, 0], [12, 1, 12], [-6, 23, -6], [0, 0, 0], 1],
  ...stones.map(([x, z, yaw]) => [[0, 0, 0], [2, 4, 14], [x, 20, z], [0, yaw, 0], 2]),
];

const vertices = [[0,0,0], [1,0,0], [1,1,0], [0,1,0], [0,0,1], [1,0,1], [1,1,1], [0,1,1]];
// Original ModelBox vertex winding, in the order of textures.py's model_faces.
const faces = [[5,1,2,6], [0,4,7,3], [5,4,0,1], [2,3,7,6], [1,0,3,2], [4,5,6,7]];

function modelPoint(vertex, start, size, pivot, [pitch, yaw, roll]) {
  let [x, y, z] = vertices[vertex].map((point, axis) => start[axis] + point * size[axis]);
  [y, z] = [y * Math.cos(pitch) - z * Math.sin(pitch), y * Math.sin(pitch) + z * Math.cos(pitch)];
  [x, z] = [x * Math.cos(yaw) + z * Math.sin(yaw), z * Math.cos(yaw) - x * Math.sin(yaw)];
  [x, y] = [x * Math.cos(roll) - y * Math.sin(roll), x * Math.sin(roll) + y * Math.cos(roll)];
  // Renderer places the ModelBox origin 1.5 blocks up, then flips X and Y.
  return [0.5 - (x + pivot[0]) / 16, 1.5 - (y + pivot[1]) / 16, 0.5 + (z + pivot[2]) / 16];
}

export const campfireMesh = parts.flatMap(([start, size, pivot, rotation, tileGroup]) => {
  const points = vertices.map((_, index) => modelPoint(index, start, size, pivot, rotation));
  return faces.map((face, index) => {
    const tile = 3798 + tileGroup * 6 + index;
    const inset = 0.01;
    const u = tile % 64, v = Math.floor(tile / 64);
    const u0 = (u + inset) / 64, u1 = (u + 1 - inset) / 64;
    const v0 = (v + inset) / 64, v1 = (v + 1 - inset) / 64;
    const uv = index === 3 ? [u1, v1, u0, v1, u0, v0, u1, v0] : [u1, v0, u0, v0, u0, v1, u1, v1];
    return {positions: face.flatMap(vertex => points[vertex]), uv};
  });
});
