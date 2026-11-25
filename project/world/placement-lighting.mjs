import {blockKey, blockState, jammyLamp} from './block-interactions.mjs';
import {placementFace} from './placement-heading.mjs';

const torchMetadata = [0, 5, 4, 3, 2, 1];
const critterMetadata = [6, 5, 4, 3, 2, 1];
// Captured Jammy variants use 0 for ceiling lights, 4–7 for wall lanterns,
// and 8 for table lamps. The higher bits select the item, not its direction.
const jammyMetadata = [0, 8, 4, 6, 7, 5];
const fixtureNames = ['Потолочный светильник', 'Настенный фонарь', 'Настольная лампа'];
// Unused 12–15 damage states share the captured ceiling mesh.
const jammyFixture = meta => meta >= 12 ? 0 : meta & 12;

export const isCandle = id => id >= 3909 && id <= 3924;
export const isTwilightCritter = id => id === 2160 || id === 2171 || id === 2178;

export function lightingPlacementName(id, meta) {
  if (jammyLamp(id)) return fixtureNames[jammyFixture(meta) >> 2];
}

export function orientedLightPlacement(key, {against}, target) {
  const [id, meta] = blockState(key);
  if (!against) return;

  const torch = id === 50 || id === 75 || id === 76 || isCandle(id);
  const jammy = jammyLamp(id);
  const redpower = id === 768;
  const critter = isTwilightCritter(id);
  if (!torch && !jammy && !redpower && !critter) return;

  const face = placementFace(target, against);
  if (face < 0 || torch && face === 0) return {error:torch ? 'invalid_control_face' : 'invalid_mount_face'};
  if (redpower) return {cell:key, mountFace:face};
  if (torch) return {cell:blockKey(id === 75 ? 76 : id, torchMetadata[face]), requireSupport:face};
  if (critter) return {cell:blockKey(id, critterMetadata[face]), requireSupport:face};

  const fixture = jammyFixture(meta);
  const mounted = jammyMetadata[face];
  if ((mounted & 12) !== fixture) return {error:'invalid_mount_face'};
  return {cell:blockKey(id, mounted), requireSupport:face};
}
