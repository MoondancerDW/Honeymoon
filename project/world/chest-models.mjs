const CHEST_START = 3660;
const OPEN_CHEST_START = 3744;
const YAW = {2: Math.PI, 3: 0, 4: -Math.PI / 2, 5: Math.PI / 2};
const DIRECTIONS = [[0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
const PARTNER_OFFSETS = {
  2: [[-1, 0, 0], [1, 0, 0]],
  3: [[1, 0, 0], [-1, 0, 0]],
  4: [[0, 0, 1], [0, 0, -1]],
  5: [[0, 0, -1], [0, 0, 1]],
};

function isChest(cell) {
  return (typeof cell === 'string' ? cell : cell?.key)?.startsWith('legacy:54:');
}

export function chestCollision(id, neighbors) {
  const bounds = [1 / 16, 0, 1 / 16, 15 / 16, 14 / 16, 15 / 16];
  if (id === 54 && neighbors) {
    // BlockChest updates its collision bounds from the facing tile in this order.
    const direction = DIRECTIONS.findIndex(offset => isChest(neighbors(...offset)));
    if (direction >= 0) bounds[[2, 5, 0, 3][direction]] = direction % 2;
  }
  return bounds;
}

function openedChest(cell) {
  return cell?.object?.data?.open === true;
}

function tiltLid([x0, y0, z0, x1, y1, z1]) {
  // The vanilla hinge is 9 px above the bottom and 1 px in from the rear.
  return [x0, z0 + 8 / 16, 10 / 16 - y1, x1, z1 + 8 / 16, 10 / 16 - y0];
}

export function chestShape(id, meta, cell, neighbors, box) {
  const partners = PARTNER_OFFSETS[meta] ?? PARTNER_OFFSETS[3];
  const adjacent = id === 54 && neighbors ? partners.map(offset => neighbors(...offset)) : [];
  const half = adjacent.findIndex(isChest);
  const variant = id === 130 ? 1 : half < 0 ? 0 : 2 + half;
  const start = CHEST_START + variant * 18;
  const opened = openedChest(cell) || (half >= 0 && openedChest(adjacent[half]));
  const faces = part => {
    const first = opened && part > 0 ? OPEN_CHEST_START + variant * 12 + (part - 1) * 6 : start + part * 6;
    return Array.from({length: 6}, (_, face) => half >= 0 && face === 1 - half ? -1 : first + face);
  };
  const x0 = half === 1 ? 0 : 1 / 16;
  const x1 = half === 0 ? 1 : 15 / 16;
  const lockX = half === 0 ? 15 / 16 : half === 1 ? 0 : 7 / 16;
  const lockEnd = half === 0 ? 1 : half === 1 ? 1 / 16 : 9 / 16;
  // The old TESR drew both halves in one call lit at the north or west cell.
  const offset = partners[half];
  const chestLightOffset = offset?.some(component => component < 0) ? offset : undefined;
  const options = {uv: 'box', angle: YAW[meta] ?? 0, chestLightOffset};
  const lid = [x0, (opened ? 9 : 10) / 16, 1 / 16, x1, 14 / 16, 15 / 16];
  const lock = [lockX, 7 / 16, 15 / 16, lockEnd, 11 / 16, 1];
  return [
    box([x0, 0, 1 / 16, x1, 10 / 16, 15 / 16], faces(0), options),
    box(opened ? tiltLid(lid) : lid, faces(1), options),
    box(opened ? tiltLid(lock) : lock, faces(2), {...options, solid: false}),
  ];
}
