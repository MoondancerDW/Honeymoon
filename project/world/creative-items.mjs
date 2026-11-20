import {coverBoxes} from './geometry.mjs';
import {isMicroPart, microblockPattern} from './microblocks.mjs';

export const CREATIVE_MINECART_KEY = 'creative:328:0';
export const CREATIVE_BOAT_KEY = 'creative:333:0';
export const CREATIVE_FRAME_KEY = 'creative:389:0';
export const CREATIVE_INVISIBLE_FRAME_KEY = 'creative:389:1';
export const signItemKey = 'creative:323:0';
export const signPlacementCell = 'legacy:63:0';

// RedPower's legacy item damage stores its material in the low byte and
// selects a cover, corner, strip or post using the high byte.
const coverDamage = [[0,0,0],[16,0,1],[17,0,2],[18,6,0],[19,6,1],[20,6,2],
  [21,14,0],[22,14,1],[23,14,2],...Array.from({length:11},(_,i)=>[24+i,0,3+i]),
  ...Array.from({length:4},(_,i)=>[35+i,6,3+i]),...Array.from({length:4},(_,i)=>[39+i,14,3+i]),
  [43,26,0],[44,26,1],[45,26,2]];
const coverDamageParts = new Map(coverDamage.map(([kind,slot,shape])=>[kind,{slot,shape}]));

export function microblockPartFromDamage(damage) {
  if (!Number.isInteger(damage) || damage < 0 || damage > 0xffff) return null;
  const variant = coverDamageParts.get(damage >> 8);
  const part = variant && {...variant,material:damage&255};
  return isMicroPart(part) ? part : null;
}

export function microblockDamageFromPart(part) {
  if (!isMicroPart(part)) return null;
  const slot=part.sourceSlot??part.slot;
  const category=slot<6?0:slot<14?6:slot<26?14:26;
  const variant=coverDamage.find(([,type,shape])=>type===category && shape===part.shape);
  return variant?(variant[0]<<8)|part.material:null;
}

// CoverLib.damageToCoverData stores the kind in the upper byte, then
// thickness/flags, internal shape and material. Type 0 also covers hollow panels.
export function creativeMicroblock(entry) {
  if (entry?.kind !== 'microblock' || !Number.isSafeInteger(entry.coverData)) return null;
  const type = entry.coverData >>> 24;
  const slot = [0,14,6,26][type];
  const part = {slot, shape:(entry.coverData >> 8) & 255, material:entry.coverData & 255};
  if (!isMicroPart(part)) return null;
  const pattern = microblockPattern(coverBoxes([part]));
  return pattern ? {...part, pattern} : null;
}

// TileShapedLamp uses the clicked face's opposite side for the mount.
export function shapedLampData(damage, rot = 0) {
  return {style:(damage & 1023) >> 5, color:damage & 15, ps:damage & 16 ? 2 : 0, rot};
}
