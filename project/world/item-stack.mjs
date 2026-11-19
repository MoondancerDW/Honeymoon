import {nativeStackLimits} from './native-stack-limits.mjs';
import {equipmentLabels,ponyArmor} from './pony-armor.mjs';

export const offhandSlot = 36 + equipmentLabels.length;

export function itemStackLimit(key) {
  const id=Number(/^(?:creative|legacy):(\d+):/.exec(key??'')?.[1]);
  return nativeStackLimits.get(id) ?? (ponyArmor(key)?1:64);
}
