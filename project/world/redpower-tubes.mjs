import {signalSides} from './block-interactions.mjs';

const machineAtlas = 512;
const rpFaceForBox = [4, 5, 0, 1, 2, 3];
const tubeKey = /^(?:legacy|cover):750:8(?::|$)/;
const inventoryIds = new Set([23, 54, 61, 62, 146]);
const paintTints = [0xffffff, 0xff8000, 0xff00ff, 7110911, 0xffff00, 65280, 16737408, 0x535353,
  0x939393, 65535, 0x8000ff, 255, 5187328, 32768, 0xff0000, 0x1f1f1f];

const center = [.25, .25, .25, .75, .75, .75];
const straightTextures = [187200, 1773, 184365];
const centerTextures = 55;
const faceFlags = flags => rpFaceForBox.map(face => (flags >> (face * 3)) & 7);
const straightUv = straightTextures.map(faceFlags);
const centerUv = faceFlags(centerTextures);

const keyOf = cell => typeof cell === 'string' ? cell : cell?.key ?? '';
const dataOf = cell => cell?.object?.data ?? cell?.data;
const paintOf = cell => dataOf(cell)?.pCol ?? 0;

function covered(cell, side) {
  // TileTube removes a side for a plate/slab; hollow covers retain that opening.
  return cell?.parts?.some(({slot, shape}) => slot === side && shape < 3);
}

function compatibleTube(cell, side, paint) {
  if (tubeKey.test(keyOf(cell))) {
    const otherPaint = paintOf(cell);
    return !covered(cell, side) && (!paint || !otherPaint || paint === otherPaint);
  }
  const type = cell?.object?.type ?? dataOf(cell)?.id;
  const rotation = dataOf(cell)?.rot;
  if (type === 'RPTranspose') return (rotation >> 1) === (side >> 1);
  if (type === 'RPRelay' || type === 'RPEject') return Number.isInteger(rotation);
  if (type === 'RPBuffer') return true;
  return inventoryIds.has(Number(keyOf(cell).split(':')[1]));
}

function connections(cell, neighbors) {
  const paint = paintOf(cell);
  return signalSides.reduce((mask, offset, side) =>
    !covered(cell, side) && compatibleTube(neighbors?.(...offset), side ^ 1, paint) ? mask | (1 << side) : mask, 0);
}

function part(bounds, faces, redPowerUv, tint = 0xffffff) {
  const [x0, y0, z0, x1, y1, z1] = bounds;
  return {x0, y0, z0, x1, y1, z1, faces, mode:'cutout', solid:false, redPowerUv, tint};
}

export const tubeCore = Object.freeze({...part(center, Array(6).fill(machineAtlas + 65), centerUv), solid:true});

export function connectedTubeMesh(cell, neighbors) {
  const mask = connections(cell, neighbors);
  const sideTile = machineAtlas + 64;
  const endTile = machineAtlas + 65;
  const sides = Array(6).fill(sideTile);
  const result = [];
  const paintTint = paintTints[paintOf(cell) - 1];
  function shell(bounds, faces, uv, paintTile) {
    result.push(part(bounds, faces, uv));
    if (paintTint === undefined || mask === 0) return;
    // Keep the paint overlay just outside the RGB shell to avoid z-fighting.
    const overlay = bounds.map((value, index) => value + (index < 3 ? -0.0001 : 0.0001));
    result.push(part(overlay, faces.map(face => face < 0 ? face : machineAtlas + paintTile), uv, paintTint));
  }

  const straightAxis = [48, 3, 12].indexOf(mask);
  if (straightAxis >= 0) {
    const bounds = [...center];
    bounds[straightAxis] = 0;
    bounds[straightAxis + 3] = 1;
    shell(bounds, sides.map((tile, face) => (face >> 1) === straightAxis ? -1 : tile), straightUv[straightAxis], 67);
    return result;
  }

  shell(center, rpFaceForBox.map(face => mask & (1 << face) ? -1 : endTile), centerUv, 66);
  for (const [face, rpFace] of rpFaceForBox.entries()) {
    if (!(mask & (1 << rpFace))) continue;
    const bounds = [...center];
    const axis = face >> 1;
    bounds[axis] = face & 1 ? .75 : 0;
    bounds[axis + 3] = face & 1 ? 1 : .25;
    shell(bounds, sides.map((tile, side) => (side >> 1) === axis ? -1 : tile), straightUv[axis], 67);
  }
  return result;
}
