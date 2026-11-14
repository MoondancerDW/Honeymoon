const keyOf = cell => typeof cell === 'string' ? cell : cell?.key;

export function isLadder(cell) {
  const key = keyOf(cell);
  return key?.startsWith('legacy:65:') || key?.startsWith('legacy:106:') || false;
}

export function liquidLevel(cell) {
  const match = /^legacy:(8|9):(\d+)$/.exec(keyOf(cell) ?? '');
  if (!match) return null;
  const meta = Number(match[2]);
  return 1 - ((meta < 8 ? meta : 0) + 1) / 9;
}

export function movementMedium(cellAt, x, y, z) {
  const xx = Math.floor(x), zz = Math.floor(z), yy = Math.floor(y);
  const atFeet = cellAt(xx, yy, zz);
  if (isLadder(atFeet)) return 'ladder';
  const level = liquidLevel(atFeet);
  if (level !== null && (liquidLevel(cellAt(xx, yy + 1, zz)) !== null || y + .1 < yy + level)) return 'water';
  return null;
}
