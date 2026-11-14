const legacyCell = /^legacy:(\d+):(\d+)$/;
const noBlock = [0, 0];

export function blockState(cell) {
  const match = legacyCell.exec(typeof cell === 'string' ? cell : cell?.cell ?? cell?.key ?? '');
  return match ? [Number(match[1]), Number(match[2])] : noBlock;
}

export const blockKey = (id, meta) => `legacy:${id}:${meta}`;
export const signalSides = [[0,-1,0], [0,1,0], [0,0,-1], [0,0,1], [-1,0,0], [1,0,0]];
export const buttonDuration = id => id === 77 ? 1000 : id === 143 ? 1500 : 0;
export const pressurePlate = id => id === 70 || id === 72;
export const manualHatch = id => id === 96 || id === 107;
export const jammyLamp = id => id === 219 || id === 220;
export const biblioWeaponCase = id => id === 2255;

export function jammyUseSound(id, meta) {
  if (id === 203 && meta >= 4 && meta < 8) return 'jfm.radio';
  if (id === 207 && meta >= 12 && meta < 16) return 'jfm.toilet';
  return null;
}

export function jammyAppliance(id, meta) {
  if (id === 205 && meta < 8) return meta < 4 ? 'Холодильник' : 'Морозильник';
  if (id === 206 && meta < 4) return 'Посудомоечная машина';
  return null;
}

export function relatedBlockStates(key) {
  const [id, meta] = blockState(key);
  if (((id === 64 || id === 71) && meta < 8) || id === 96) return [blockKey(id, meta ^ 4)];
  if (id === 107) return [blockKey(id, meta ^ 4), blockKey(id, meta ^ 2), blockKey(id, meta ^ 6)];
  if (id === 69 || buttonDuration(id)) return [blockKey(id, meta ^ 8)];
  if (pressurePlate(id)) return [blockKey(id, meta ^ 1)];
  if (id === 55) return Array.from({length: 16}, (_, power) => blockKey(id, power));
  if (id === 75 || id === 76) return [blockKey(id === 75 ? 76 : 75, meta)];
  if (id === 93 || id === 94) return [93, 94].flatMap(state =>
    [0, 4, 8, 12].map(delay => blockKey(state, (meta & 3) | delay)));
  if (id === 123 || id === 124) return [blockKey(id === 123 ? 124 : 123, meta)];
  if (jammyLamp(id)) return [blockKey(id === 219 ? 220 : 219, meta)];
  if (id >= 756 && id <= 759) return [blockKey(id ^ 1, meta)];
  return [];
}
