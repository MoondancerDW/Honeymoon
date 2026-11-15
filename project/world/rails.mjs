import {blockKey, blockState} from './block-interactions.mjs';

const north = [.5, 0, 0], south = [.5, 0, 1], west = [0, 0, .5], east = [1, 0, .5];
const raised = ([x, , z]) => [x, 1, z];
const endsByShape = [
  [north, south], [west, east], [west, raised(east)], [raised(west), east],
  [raised(north), south], [north, raised(south)], [south, east], [south, west], [north, west], [north, east],
];

export function railFor(cell) {
  const [id, meta] = blockState(cell);
  if ((id !== 66 && id !== 27 && id !== 28) || meta > 15) return null;
  const shape = id === 66 ? meta : meta & 7;
  if (shape > (id === 66 ? 9 : 5)) return null;
  return {id, meta, shape, powered: id === 27 && Boolean(meta & 8), ends:endsByShape[shape],
    length: shape >= 6 ? Math.PI / 4 : shape >= 2 ? Math.SQRT2 : 1};
}

function curve([from, to]) {
  const x = from[0] === .5 ? to[0] : from[0];
  const z = from[2] === .5 ? to[2] : from[2];
  const start = Math.atan2(from[2] - z, from[0] - x);
  const end = Math.atan2(to[2] - z, to[0] - x);
  const turn = Math.atan2(Math.sin(end - start), Math.cos(end - start));
  return {x, z, start, turn};
}

export function railPoint(rail, t) {
  const [from, to] = rail.ends;
  if (rail.shape < 6) return from.map((value, axis) => value + (to[axis] - value) * t);
  const {x, z, start, turn} = curve(rail.ends);
  const angle = start + turn * t;
  return [x + .5 * Math.cos(angle), 0, z + .5 * Math.sin(angle)];
}

export function railTangent(rail, t) {
  if (rail.shape < 6) return rail.ends[1].map((value, axis) => (value - rail.ends[0][axis]) / rail.length);
  const {start, turn} = curve(rail.ends);
  const angle = start + turn * t;
  return [-Math.sin(angle) * Math.sign(turn), 0, Math.cos(angle) * Math.sign(turn)];
}

export function orientedRail(rail, neighbors, preferred = rail.shape) {
  let best = preferred, rating = -1;
  const topShape = rail.id === 66 ? 9 : 5;
  for (let shape = 0; shape <= topShape; shape++) {
    const ends = endsByShape[shape];
    const hits = ends.map(([x,y,z]) => neighbors(x * 2 - 1, y, z * 2 - 1));
    // Raising an endpoint requires a connection at the higher level.
    if (ends.some((end, index) => end[1] && !hits[index])) continue;
    const score = Number(hits[0]) + Number(hits[1]);
    if (score > rating || (score === rating && shape === preferred)) {
      best = shape;
      rating = score;
    }
  }
  return blockKey(rail.id, best | (rail.id === 66 ? 0 : rail.meta & 8));
}
