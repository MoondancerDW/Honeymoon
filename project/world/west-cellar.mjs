export const westCellarHatch = Object.freeze({x: -60, y: 64, z: 56});
export const westCellarLadder = 3;

export function isWestCellarHatch(x, y, z) {
  return x === westCellarHatch.x && y === westCellarHatch.y && z === westCellarHatch.z;
}

export function hasHatchRung(cell) {
  const match = /^legacy:96:(\d+)$/.exec(cell?.key ?? '');
  return Boolean(match && (Number(match[1]) & 4) && cell.object?.data?.ladderRung === westCellarLadder);
}
