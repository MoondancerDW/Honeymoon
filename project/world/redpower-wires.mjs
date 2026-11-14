import {signalSides} from './block-interactions.mjs';

const atlas = 1792;
const wireIds = new Set([1, 2, 3, 5]);
const rpFaceForBox = [4, 5, 0, 1, 2, 3];
const boxFaceForRp = [2, 3, 4, 5, 0, 1];
const localShade = [.7, .7, .5, 1, .7, .7];
// MathLib.orientMatrix(side, 0), as signed local axes for the world X/Y/Z coordinates.
const axesForSide = [[1, 2, 3], [1, -2, -3], [3, 1, 2], [-3, 1, -2], [2, 1, -3], [-2, 1, 3]];
const wireKey = /^(?:legacy|cover):750:(1|2|3|5)(?::|$)/;
const vanillaConnectors = new Set([23, 55, 69, 70, 72, 75, 76, 77, 143]);
const sidesOf = cell => (cell?.object?.data ?? cell?.data)?.cons ?? 0;
const dataOf = cell => cell?.object?.data ?? cell?.data;
const keyOf = cell => typeof cell === 'string' ? cell : cell?.key ?? '';

function spec(meta, data) {
  const md = data?.md ?? 0;
  const powered = (data?.pwr & 255) > 0;
  if (meta === 1) return {width:.125, height:.125, top:1, center:2, side:1,
    tint:Math.round(255 * .3 + .7 * (data?.pwr & 255)) << 16, powerClass:1};
  if (meta === 2) return {width:.25, height:Math.fround(.188), top:16 + md, center:(powered ? 48 : 32) + md,
    side:16 + md, powerClass:2 + md};
  if (meta === 3) return {width:.375, height:.25, top:md ? 63 + md : 3, center:md ? 79 + md : 4,
    side:3, powerClass:18 + md};
  if (md === 2) return {width:.5, height:.3125, top:97, center:98, side:99, longSide:96, end:100, powerClass:69};
  return md === 1 ? {width:.375, height:.25, top:11, center:12, side:11, powerClass:68}
    : {width:.25, height:Math.fround(.188), top:8, center:9, side:8, powerClass:64};
}

function compatible(a, b) {
  if (a === b) return true;
  const [lower, upper] = a < b ? [a, b] : [b, a];
  if (lower <= 1) return upper <= 17 || upper === 65;
  if (lower <= 17) return (upper >= 18 && upper <= 34) || upper === 65;
  if (lower === 18) return upper <= 34;
  return (lower === 64 || lower === 65 || lower === 66) && (upper === 67 || lower === 64 && upper === 65);
}

function localDirection(axis, face) {
  const signed = axis[face >> 1];
  return (Math.abs(signed) - 1) * 2 + ((signed > 0) === Boolean(face & 1) ? 1 : 0);
}

function worldOffset(axes, local) {
  return axes.map(axis => local[Math.abs(axis) - 1] * Math.sign(axis));
}

function blockedByCover(cell, direction) {
  return cell?.parts?.some(({slot}) => slot === direction);
}

function wireConnection(cell, neighbor, mount, direction, powerClass) {
  if (blockedByCover(cell, direction) || blockedByCover(neighbor, direction ^ 1)) return false;
  const match = wireKey.exec(keyOf(neighbor));
  if (match) return Boolean(sidesOf(neighbor) & (1 << mount))
    && compatible(powerClass, spec(Number(match[1]), dataOf(neighbor)).powerClass);
  const [, id, meta] = keyOf(neighbor).split(':').map(Number);
  if (id === 93 || id === 94) return mount === 0 && compatible(powerClass, 0)
    && (direction >> 1) === ((meta & 1) ? 2 : 1);
  return vanillaConnectors.has(id) && compatible(powerClass, 0);
}

function reducedBox(local, axes, faces, flags, tint) {
  const first = axes.map(axis => axis > 0 ? local[axis - 1] : 1 - local[-axis + 2]);
  const last = axes.map(axis => axis > 0 ? local[axis + 2] : 1 - local[-axis - 1]);
  const [x0, y0, z0] = first, [x1, y1, z1] = last;
  const localFaces = rpFaceForBox.map((_, face) => localDirection(axes, face));
  return {x0, y0, z0, x1, y1, z1, faces:localFaces.map(face => faces[face]), solid:false, mode:'cutout', tint,
    redPowerUv:localFaces.map(face => (flags >> (rpFaceForBox[face] * 3)) & 7),
    redPowerLocalShade:localFaces.map(face => localShade[face]),
    redPowerAxes:axes, redPowerFaces:localFaces};
}

export function wirePanels(cell, meta, neighbors) {
  const style = spec(meta, dataOf(cell));
  const mounted = sidesOf(cell) & 63;
  const result = [];
  const low = .5 - style.width / 2, high = .5 + style.width / 2;
  const directions = [[0,0,-1], [0,0,1], [-1,0,0], [1,0,0]];
  for (let side = 0; side < 6; side++) {
    if (!(mounted & (1 << side))) continue;
    const axes = axesForSide[side];
    const path = directions.map(local => {
      const offset = worldOffset(axes, local);
      const direction = signalSides.findIndex(item => item.every((value, axis) => value === offset[axis]));
      const corner = Boolean(mounted & (1 << direction));
      return {corner, extend:corner || wireConnection(cell, neighbors?.(...offset), side, direction, style.powerClass)};
    });
    const ends = path.map(({corner, extend}, index) => corner ? (index & 1 ? 1 - style.height : style.height)
      : extend ? (index & 1 ? 1 : 0) : (index & 1 ? Math.fround(.74) : Math.fround(.26)));
    function append(local, longitudinal, flags, opened = []) {
      const faces = Array.from({length:6}, (_, face) => {
        if (face === 2 || opened.includes(face)) return -1;
        if (longitudinal < 0 && face === 3) return atlas + style.center;
        if ((face >> 1) === longitudinal) return atlas + (style.end ?? style.center);
        return atlas + (face === 3 ? style.top : longitudinal < 0 ? style.side : style.longSide ?? style.top);
      });
      result.push(reducedBox(local, axes, faces, flags, style.tint ?? 0xffffff));
    }
    const flagsX = [1, 2, 4].includes(side) ? 7512 : 35712;
    const flagsZ = 217640;
    if (!path[2].extend && !path[3].extend) {
      append([low, 0, ends[0], high, style.height, ends[1]], 2, flagsZ);
    } else if (!path[0].extend && !path[1].extend) {
      append([ends[2], 0, low, ends[3], style.height, high], 0, flagsX);
    } else {
      const openFaces = [4, 5, 0, 1].filter((_, index) => path[index].extend);
      append([low, 0, low, high, style.height, high], -1, [1, 2, 4].includes(side) ? 220488 : 220032, openFaces);
      for (const [index, {extend, corner}] of path.entries()) {
        if (!extend) continue;
        const axis = index < 2 ? 2 : 0;
        const face = index < 2 ? index + 4 : index - 2;
        const local = [low, 0, low, high, style.height, high];
        if (index & 1) [local[axis], local[axis + 3]] = [high, ends[index]];
        else [local[axis], local[axis + 3]] = [ends[index], low];
        append(local, axis, axis === 2 ? flagsZ : flagsX, [face ^ 1, ...(corner ? [face] : [])]);
      }
    }
  }
  return result;
}

export function wireSelection(cell, meta) {
  if (!wireIds.has(meta)) return [];
  const {height} = spec(meta, dataOf(cell));
  return boxFaceForRp.flatMap((face, side) => {
    if (!(sidesOf(cell) & (1 << side))) return [];
    const bounds = [0, 0, 0, 1, 1, 1];
    const axis = face >> 1;
    if (face & 1) bounds[axis] = 1 - height;
    else bounds[axis + 3] = height;
    const [x0, y0, z0, x1, y1, z1] = bounds;
    return [{x0, y0, z0, x1, y1, z1, faces:Array(6).fill(atlas), solid:false, mode:'cutout'}];
  });
}
