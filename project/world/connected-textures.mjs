export const CTM_START = 3328;

// Texture-space left, right, bottom, top for each face in geometry.FACES order.
const BORDERS = [
  [[0,0,-1], [0,0,1], [0,-1,0], [0,1,0]],
  [[0,0,1], [0,0,-1], [0,-1,0], [0,1,0]],
  [[-1,0,0], [1,0,0], [0,0,1], [0,0,-1]],
  [[-1,0,0], [1,0,0], [0,0,1], [0,0,-1]],
  [[1,0,0], [-1,0,0], [0,-1,0], [0,1,0]],
  [[-1,0,0], [1,0,0], [0,-1,0], [0,1,0]],
];

// OptiFine Fast mode uses the four face-plane neighbors and ignores the diagonals.
const CTM_INDEX = [0, 3, 1, 2, 12, 15, 13, 14, 36, 39, 37, 38, 24, 27, 25, 26];

function keyOf(cell) {
  return typeof cell === 'string' ? cell : cell?.key;
}

export function glassTexture(face, neighbors, metadata = 0) {
  const key = 'legacy:20:' + metadata;
  const borders = BORDERS[face];
  if (!borders) return null;
  let mask = 0;
  for (let edge = 0; edge < borders.length; edge++) {
    if (keyOf(neighbors?.(...borders[edge])) === key) mask |= 1 << edge;
  }
  const index = CTM_INDEX[mask];
  return CTM_START + Math.floor(index / 12) * 16 + index % 12;
}

function paneAt(neighbors, x, y, z) {
  return keyOf(neighbors?.(x, y, z))?.startsWith('legacy:102:') ?? false;
}

export function paneTexture(face, neighbors) {
  if (face === 2 || face === 3) return null;
  const alongZ = face === 0 || face === 1;
  const negative = paneAt(neighbors, alongZ ? 0 : -1, 0, alongZ ? -1 : 0);
  const positive = paneAt(neighbors, alongZ ? 0 : 1, 0, alongZ ? 1 : 0);
  const below = paneAt(neighbors, 0, -1, 0);
  const above = paneAt(neighbors, 0, 1, 0);
  const reverse = face === 1 || face === 4;
  const left = reverse ? positive : negative;
  const right = reverse ? negative : positive;
  const column = left ? (right ? 2 : 3) : Number(right);
  const row = above ? (below ? 2 : 3) : Number(below);
  return CTM_START + row * 16 + column;
}
