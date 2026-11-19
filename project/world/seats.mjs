import {blockState} from './block-interactions.mjs';
import {jammyBenchState} from './jammy-benches.mjs';
import {jammySofaVariant} from './jammy-sofas.mjs';
import {BED_SURFACE_HEIGHT} from './geometry.mjs';

export const SEATED_EYE = 1.05;
export const SEATED_HEIGHT = 1.28;

const jammyFacings = [0, -Math.PI / 2, Math.PI, Math.PI / 2];
const bedDirections = [[0, 1], [-1, 0], [0, -1], [1, 0]];
const sofaIds = {chair:213, left:214, right:215, center:216, corner:217};

export function seatFor(cell, catalogs, heading = 0, neighbors) {
  const [id, meta] = blockState(cell);
  if (id === 26) return {height:BED_SURFACE_HEIGHT, yaw:jammyFacings[meta & 3], bed:true};
  const sofas = catalogs?.jammy?.sofaIds ?? sofaIds;
  let turns = meta & 3;
  let height;
  if (Object.values(sofas).includes(id)) {
    const rawRotation = cell.object?.type === 'JammySofa' ? cell.object.data?.rotation ?? 0 : 0;
    turns = jammySofaVariant(catalogs?.jammy, cell, neighbors)?.rotation ?? ((turns + rawRotation) & 3);
    height = .5;
  } else if (id === (catalogs?.jammy?.benchId ?? 203) && meta < 4) {
    turns = jammyBenchState(catalogs?.jammy, cell)?.rotation ?? turns;
    height = 7 / 16;
  } else if (id === 204) height = .4;
  else if (id === 207 && meta >= 12 && meta < 16) {
    // The original toilet retains the player's nearest cardinal heading.
    turns = (2 - Math.round(heading * 2 / Math.PI)) & 3;
    height = 7 / 16;
  } else return null;
  return {height, yaw:jammyFacings[turns]};
}

export function bedMate(cell, {x, y, z}, getCell) {
  const [, meta] = blockState(cell);
  const [dx, dz] = bedDirections[meta & 3];
  const head = Boolean(meta & 8);
  const other = {x:x + (head ? -dx : dx), y, z:z + (head ? -dz : dz)};
  const [otherId, otherMeta] = blockState(getCell(other.x, other.y, other.z));
  return otherId === 26 && (otherMeta & 11) === ((meta ^ 8) & 11) ? other : null;
}
