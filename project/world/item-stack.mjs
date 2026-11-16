import {bucketKeys} from './fluid-state.mjs';
import {ponyArmor} from './pony-armor.mjs';

export function itemStackLimit(key) {
  if (key === bucketKeys.empty) return 16;
  return key === bucketKeys.water || key === bucketKeys.lava || ponyArmor(key) ? 1 : 64;
}
