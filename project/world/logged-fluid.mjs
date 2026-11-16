import {extractedModel} from './extracted-models.mjs';
import {shapeFor} from './geometry.mjs';

const min = ['x0', 'y0', 'z0'];
const max = ['x1', 'y1', 'z1'];
const cube = {x0:0, y0:0, z0:0, x1:1, y1:1, z1:1};
const sources = {water:'legacy:9:0', lava:'legacy:11:0'};

export function liquidKind(cell) {
  const key = typeof cell === 'string' ? cell : cell?.key ?? cell?.cell;
  const match = /^legacy:(8|9|10|11):\d+$/.exec(key ?? '');
  if (match) return Number(match[1]) < 10 ? 'water' : 'lava';
}

export const liquidCell = kind => sources[kind];

function subtractBox(box, obstruction, axes) {
  const intersection = {...box};
  for (const axis of axes) {
    const lower = min[axis], upper = max[axis];
    intersection[lower] = Math.max(box[lower], obstruction[lower]);
    intersection[upper] = Math.min(box[upper], obstruction[upper]);
    if (intersection[lower] >= intersection[upper]) return [box];
  }
  const remainder = [];
  const middle = {...box};
  for (const axis of axes) {
    const lower = min[axis], upper = max[axis];
    if (middle[lower] < intersection[lower]) {
      remainder.push({...middle, [upper]:intersection[lower]});
      middle[lower] = intersection[lower];
    }
    if (middle[upper] > intersection[upper]) {
      remainder.push({...middle, [lower]:intersection[upper]});
      middle[upper] = intersection[upper];
    }
  }
  return remainder;
}

const axes = [0, 1, 2];
export function liquidCavity(cell, neighbors, models) {
  const key = typeof cell === 'string' ? cell : cell?.key;
  if (!key || key === 'air' || liquidKind(key)) return [];
  const boxes = (extractedModel(models, cell, neighbors)?.collision ?? shapeFor(cell, neighbors))
    .filter(box => !box.kind && (box.solid !== false || box.climbable || box.fluid));
  if (!boxes.length) return [];
  // Subtract the host in local block space, preserving thin covers and exact stair corners.
  let volume = [cube];
  for (const box of boxes) {
    volume = volume.flatMap(open => subtractBox(open, box, axes));
    if (!volume.length) break;
  }
  return volume;
}

export const canLogLiquid = (cell, neighbors, models) => liquidCavity(cell, neighbors, models).length > 0;

export function withLoggedFluid(boxes, cell, neighbors, models) {
  if (!cell?.fluid) return boxes;
  return [...boxes, ...liquidCavity(cell, neighbors, models).map(box => ({...box, solid:false, loggedFluid:cell.fluid}))];
}

export function liquidAt(cell, point, neighbors, models) {
  return cell?.fluid && liquidCavity(cell, neighbors, models).some(box =>
    axes.every(axis => point[axis] >= box[min[axis]] && point[axis] < box[max[axis]])) ? cell.fluid : undefined;
}

export function clipLiquidFace(box, face, adjacent) {
  const axis = face >> 1;
  const inside = face & 1 ? min[axis] : max[axis];
  const edge = face & 1 ? 0 : 1;
  const tangents = axes.filter(value => value !== axis);
  let pieces = [box];
  for (const obstacle of adjacent) {
    if (face & 1 ? obstacle[inside] > edge : obstacle[inside] < edge) continue;
    pieces = pieces.flatMap(piece => subtractBox(piece, obstacle, tangents));
    if (!pieces.length) break;
  }
  return pieces;
}
