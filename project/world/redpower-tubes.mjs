import {signalSides} from './block-interactions.mjs';

const machineAtlas = 512;
const rpFaceForBox = [4, 5, 0, 1, 2, 3];
const tubeKey = /^(?:legacy|cover):750:(7|8|9|10|11)(?::|$)/;
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
const subtype = cell => Number(tubeKey.exec(keyOf(cell))?.[1]);
const tubeTextures = {7:[26,28], 8:[64,65], 9:[64,65], 10:[76,77], 11:[21,22]};

function covered(cell, side) {
  // TileTube removes a side for a plate/slab; hollow covers retain that opening.
  return cell?.parts?.some(({slot, shape}) => slot === side && shape < 3);
}

function compatibleTube(cell, side, paint, pipe) {
  if (tubeKey.test(keyOf(cell))) {
    const otherPaint = paintOf(cell);
    return (subtype(cell) === 7) === pipe && !covered(cell, side) && (!paint || !otherPaint || paint === otherPaint);
  }
  const type = cell?.object?.type ?? dataOf(cell)?.id;
  if (pipe) return type === 'RPPump';
  const rotation = dataOf(cell)?.rot;
  if (type === 'RPTranspose') return (rotation >> 1) === (side >> 1);
  if (type === 'RPRelay' || type === 'RPEject') return Number.isInteger(rotation);
  if (type === 'RPBuffer') return true;
  return inventoryIds.has(Number(keyOf(cell).split(':')[1]));
}

function connections(cell, neighbors) {
  const paint = paintOf(cell);
  const pipe = subtype(cell) === 7;
  return signalSides.reduce((mask, offset, side) =>
    !covered(cell, side) && compatibleTube(neighbors?.(...offset), side ^ 1, paint, pipe) ? mask | (1 << side) : mask, 0);
}

function part(bounds, faces, redPowerUv, tint = 0xffffff) {
  const [x0, y0, z0, x1, y1, z1] = bounds;
  return {x0, y0, z0, x1, y1, z1, faces, mode:'cutout', solid:false, redPowerUv, tint};
}

export const tubeCore = Object.freeze({...part(center, Array(6).fill(machineAtlas + 65), centerUv), solid:true});

const pipeCenter = [.375, .375, .375, .625, .625, .625];
export const pipeCore = Object.freeze({...part(pipeCenter, Array(6).fill(machineAtlas + 28), centerUv), solid:true});

export function connectedTubeMesh(cell, neighbors) {
  const mask = connections(cell, neighbors);
  const meta = subtype(cell);
  const [nativeSide, nativeEnd] = tubeTextures[meta] ?? tubeTextures[8];
  const boundsAtCenter = meta === 7 ? pipeCenter : center;
  const paintTiles = meta === 10 ? [78,79] : [66,67];
  const sideTile = machineAtlas + nativeSide;
  const endTile = machineAtlas + nativeEnd;
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
    const bounds = [...boundsAtCenter];
    bounds[straightAxis] = 0;
    bounds[straightAxis + 3] = 1;
    shell(bounds, sides.map((tile, face) => (face >> 1) === straightAxis ? -1 : tile), straightUv[straightAxis], paintTiles[1]);
    return result;
  }

  shell(boundsAtCenter, rpFaceForBox.map(face => mask & (1 << face) ? -1 : endTile), centerUv, paintTiles[0]);
  for (const [face, rpFace] of rpFaceForBox.entries()) {
    if (!(mask & (1 << rpFace))) continue;
    const bounds = [...boundsAtCenter];
    const axis = face >> 1;
    bounds[axis] = face & 1 ? boundsAtCenter[axis + 3] : 0;
    bounds[axis + 3] = face & 1 ? 1 : boundsAtCenter[axis];
    shell(bounds, sides.map((tile, side) => (side >> 1) === axis ? -1 : tile), straightUv[axis], paintTiles[1]);
  }
  return result;
}
