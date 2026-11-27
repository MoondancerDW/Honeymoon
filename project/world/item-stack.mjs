import {nativeStackLimits} from './native-stack-limits.mjs';
import {equipmentLabels,ponyArmor} from './pony-armor.mjs';

export const offhandSlot = 36 + equipmentLabels.length;
export const canvasBagSize = 27;
export const seedBagSize = 9;

export function bagKind(key) {
  const [family,id,damageText,...extra]=typeof key==='string' ? key.split(':') : [];
  const damage=Number(damageText);
  if (family!=='creative' || extra.length || damageText!==String(damage) || !Number.isInteger(damage) || damage<0) return;
  if (id==='9268' && damage<16) return 'canvas';
  if (id==='9299' && damage<=576) return 'seed';
}

export function itemStackLimit(key) {
  const id=Number(/^(?:creative|legacy):(\d+):/.exec(key??'')?.[1]);
  return nativeStackLimits.get(id) ?? (ponyArmor(key)?1:64);
}

export function itemStackPortion(stack,count) {
  const portion={...stack,count};
  const kind=bagKind(stack.key);
  if (!kind || count>=stack.count) return portion;
  // A legacy stacked bag records a single contents list. It remains with the last bag.
  if (stack.nbt && typeof stack.nbt==='object' && Object.hasOwn(stack.nbt,'contents')) {
    const {contents,...nbt}=stack.nbt;
    if (Object.keys(nbt).length) portion.nbt=nbt;
    else delete portion.nbt;
  }
  if (kind==='seed') {
    portion.key='creative:9299:0';
    if (Object.hasOwn(portion,'damage')) portion.damage=0;
  }
  return portion;
}
