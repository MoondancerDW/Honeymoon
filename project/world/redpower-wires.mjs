import {signalSides} from './block-interactions.mjs';

const atlas = 1792;
const wireIds = new Set([1, 2, 3, 5]);
const rpFaceForBox = [4, 5, 0, 1, 2, 3];
const boxFaceForRp = [2, 3, 4, 5, 0, 1];
const localShade = [.7, .7, .5, 1, .7, .7];
const directions = [[0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
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
  if (md === 2) return {width:.5, height:.3125, top:97, center:98, side:99, longSide:96, end:100, corner:101, powerClass:69};
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

function flatWireConnects(neighbor, match, mount, powerClass) {
  return Boolean(sidesOf(neighbor) & (1 << mount)) &&
    compatible(powerClass, spec(Number(match[1]), dataOf(neighbor)).powerClass);
}

function wireConnection(neighbor, mount, direction, powerClass) {
  if (blockedByCover(neighbor, direction ^ 1)) return false;
  const match = wireKey.exec(keyOf(neighbor));
  if (match) return flatWireConnects(neighbor, match, mount, powerClass);
  const [, id, meta] = keyOf(neighbor).split(':').map(Number);
  if (id === 768) return dataOf(neighbor)?.rot === mount && compatible(powerClass, 1);
  if (id === 93 || id === 94) return mount === 0 && compatible(powerClass, 0)
    && (direction >> 1) === ((meta & 1) ? 2 : 1);
  return vanillaConnectors.has(id) && compatible(powerClass, 0);
}

function exteriorWireConnection(neighbor, mount, direction, offset, neighbors, powerClass) {
  const key = keyOf(neighbor);
  if (key && key !== 'air' && !/^legacy:[89]:/.test(key)) {
    if (!/^cover:750:/.test(key) || (sidesOf(neighbor) & (1 << mount)) ||
        blockedByCover(neighbor, direction ^ 1) || blockedByCover(neighbor, mount)) return false;
  }
  const diagonal = neighbors?.(...offset.map((value, axis) => value + signalSides[mount][axis]));
  const match = wireKey.exec(keyOf(diagonal));
  return Boolean(match && flatWireConnects(diagonal, match, direction ^ 1, powerClass) &&
    !blockedByCover(diagonal, mount ^ 1));
}

function reducedBox(local, axes, faces, flags, tint, shift, shade) {
  const offset = shift ? worldOffset(axes, shift) : [0, 0, 0];
  const first = axes.map((axis, i) => offset[i] + (axis > 0 ? local[axis - 1] : 1 - local[-axis + 2]));
  const last = axes.map((axis, i) => offset[i] + (axis > 0 ? local[axis + 2] : 1 - local[-axis - 1]));
  const [x0, y0, z0] = first, [x1, y1, z1] = last;
  const localFaces = rpFaceForBox.map((_, face) => localDirection(axes, face));
  return {x0, y0, z0, x1, y1, z1, faces:localFaces.map(face => faces[face]), solid:false, mode:'cutout', tint,
    redPowerUv:localFaces.map(face => (flags >> (rpFaceForBox[face] * 3)) & 7),
    redPowerLocalShade:localFaces.map(face => shade[face]),
    redPowerAxes:axes, redPowerFaces:localFaces, ...(shift && {redPowerOffset:offset})};
}

function textureFor(style, row, face) {
  if (row === 0) return face < 2 ? style.center : style.side;
  if (row >= 5) {
    const across = row === 5 ? 2 : 1;
    return face === 0 || (face >> 1) === across ? style.corner ?? style.center : style.top;
  }
  const end = (row - 1) % 2 + 1;
  if ((face >> 1) === end) return style.end ?? style.center;
  if (row >= 3) return face < 2 && style.longSide !== undefined ? style.top : style.side;
  return face < 2 ? style.top : style.longSide ?? style.top;
}

// RedPower RenderWiring.renderSideWires: spanning faces keep a T junction's
// straight edge in one piece, while arms and the center supply the exposed faces.
function sideMasks(connections, corners) {
  const top = 2, zEnds = 12, xEnds = 48;
  const [north, south, west, east] = [1, 2, 4, 8];
  const arms = [0, 0, 0, 0];
  let acrossX = 0, acrossZ = 0, center = 0;
  const straight = !(connections & 3) || !(connections & 12);
  if (!(connections & 12)) {
    acrossZ = top | zEnds | xEnds;
  } else if (!(connections & 3)) {
    acrossX = top | zEnds | xEnds;
  } else {
    center = top | zEnds | xEnds;
    const faces = [4, 8, 16, 32];
    for (let index = 0; index < arms.length; index++) {
      if (connections & (1 << index)) {
        arms[index] = top | faces[index];
        center &= ~faces[index];
      }
    }
    for (const [direction, face] of [[west, 16], [east, 32]]) {
      if ((connections & (north | south | direction)) === (north | south)) {
        acrossZ |= zEnds | face;
        center &= ~face;
      } else {
        for (const index of [0, 1]) if (arms[index]) arms[index] |= face;
      }
    }
    for (const [direction, face] of [[north, 4], [south, 8]]) {
      if ((connections & (west | east | direction)) === (west | east)) {
        acrossX |= xEnds | face;
        center &= ~face;
      } else {
        for (const index of [2, 3]) if (arms[index]) arms[index] |= face;
      }
    }
  }
  const trimZ = ~((corners & 3) << 2), trimX = ~((corners & 12) << 2);
  return {straight, acrossX:acrossX & trimX, acrossZ:acrossZ & trimZ, center,
    arms:arms.map((mask, index) => mask & (index < 2 ? trimZ : trimX))};
}

export function wirePanels(cell, meta, neighbors) {
  const style = spec(meta, dataOf(cell));
  const mounted = sidesOf(cell) & 63;
  const result = [];
  const low = .5 - style.width / 2, high = .5 + style.width / 2;
  const height = style.height, outer = 1 - height;
  for (let side = 0; side < 6; side++) {
    if (!(mounted & (1 << side))) continue;
    const axes = axesForSide[side];
    const path = directions.map(local => {
      const offset = worldOffset(axes, local);
      const direction = signalSides.findIndex(item => item.every((value, axis) => value === offset[axis]));
      const corner = Boolean(mounted & (1 << direction));
      if (blockedByCover(cell, direction)) return {corner, extend:corner};
      const neighbor = neighbors?.(...offset);
      const exterior = exteriorWireConnection(neighbor, side, direction, offset, neighbors, style.powerClass);
      return {corner, exterior, extend:corner || exterior || wireConnection(neighbor, side, direction, style.powerClass)};
    });
    const reduceMask = (key) => path.reduce((mask, item, index) => mask | (item[key] ? 1 << index : 0), 0);
    const corners = reduceMask('corner');
    const {straight, acrossX, acrossZ, center, arms} = sideMasks(reduceMask('extend'), corners);
    const ends = path.map(({corner, extend}, index) => corner ? (index & 1 ? outer : height)
      : extend ? (index & 1 ? 1 : 0) : (index & 1 ? Math.fround(.74) : Math.fround(.26)));
    function append(local, row, flags, mask, shift, shade = localShade) {
      if (!mask) return;
      const faces = rpFaceForBox.map(face => mask & (1 << face) ? atlas + textureFor(style, row, face) : -1);
      result.push(reducedBox(local, axes, faces, flags, style.tint ?? 0xffffff, shift, shade));
    }
    const mirrored = side === 1 || side === 2 || side === 4;
    const flagsX = mirrored ? 7512 : 35712;
    const flagsZ = 217640;
    const rowZ = straight ? 1 : 3, rowX = rowZ + 1;
    const [north, south, west, east] = ends;
    append([west, 0, low, east, height, high], rowX, flagsX, acrossX);
    append([low, 0, north, high, height, south], rowZ, flagsZ, acrossZ);
    append([low, 0, low, high, height, high], 0, mirrored ? 220488 : 220032, center);
    append([low, 0, north, high, height, low], rowZ, flagsZ, arms[0]);
    append([low, 0, high, high, height, south], rowZ, flagsZ, arms[1]);
    append([west, 0, low, low, height, high], rowX, flagsX, arms[2]);
    append([high, 0, low, east, height, high], rowX, flagsX, arms[3]);

    // Wall-mounted runs also supply the two outside faces of a shared elbow.
    if (side < 2) continue;
    if (corners & 2) append([low, 0, outer, high, height, 1], 5, 73728, 48);
    if (corners & 4) append([0, 0, low, height, height, high], 6, mirrored ? 1152 : 1728, 12);
    if (corners & 8) append([outer, 0, low, 1, height, high], 6, mirrored ? 1728 : 1152, 12);

    // RenderWiring.renderEndCaps draws regular exterior joins only from these
    // wall-mounted directions. The cap is in the adjacent cell with local UVs.
    if (path[1].exterior) append([low, 0, 0, high, height, height], 5, 38444, 59, directions[1], [.7, .7, .7, 1, .7, 1]);
    if (path[2].exterior) append([outer, 0, low, 1, height, high], 6, mirrored ? 45658 : 3, 31, directions[2], [1, .7, .7, 1, .7, .7]);
    if (path[3].exterior) append([0, 0, low, height, height, high], 6, mirrored ? 24 : 102977, 47, directions[3], [.7, 1, .7, 1, .7, .7]);
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
