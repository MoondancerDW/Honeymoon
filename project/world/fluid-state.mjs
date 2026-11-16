export const FAKE_WATER = 'legacy:4095:0';
export const bucketKeys = {empty:'creative:325:0',water:'creative:326:0',lava:'creative:327:0'};
export const bucketCell = key => key === bucketKeys.water ? 'legacy:9:0' : key === bucketKeys.lava ? 'legacy:11:0' : null;
const keyOf = cell => typeof cell === 'string' ? cell : cell?.key ?? cell?.cell;

export function fluidState(cell) {
  const key = keyOf(cell);
  if (key === FAKE_WATER) return {kind:'water',level:0,fake:true};
  if (cell?.fluid === 'water' || cell?.fluid === 'lava') return {kind:cell.fluid,level:0,logged:true};
  const match = /^legacy:(8|9|10|11):(\d+)$/.exec(key ?? '');
  if (!match) return null;
  const meta = Number(match[2]);
  return {kind:Number(match[1]) < 10 ? 'water' : 'lava',level:meta & 7,falling:meta >= 8};
}

export const flowingCell = (kind, level, falling = false) =>
  `legacy:${(kind === 'water' ? 8 : 10) + Number(!level && !falling)}:${falling ? 8 + level : level}`;

export function fluidSurface(fluid, above) {
  return fluid.falling || above?.kind === fluid.kind ? 1 : (8 - fluid.level) / 9;
}

export const plantBlock = {
  ground:[6,31,32,37,38,39,40,59,83,104,105,115,141,142],
  aquatic:[111],
};

export function plantSubstrate(id, wrapped = false) {
  if (id === 115) return new Set([88]);
  if (id === 59 || id === 104 || id === 105 || id === 141 || id === 142) return new Set([60]);
  if (id === 32 || id === 83) return new Set([2,3,12,18,243]);
  if (id === 39 || id === 40) return new Set([1,2,3,4,18,110,243]);
  if (id === 111 && !wrapped) return new Set([8,9,4095]);
  return new Set([2,3,18,60,110,243]);
}
