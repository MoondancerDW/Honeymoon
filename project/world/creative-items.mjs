import {coverBoxes} from './geometry.mjs';
import {isMicroPart, microblockPattern} from './microblocks.mjs';

export const CREATIVE_MINECART_KEY = 'creative:328:0';

// CoverLib.damageToCoverData stores the kind in the upper byte, then
// thickness/flags, internal shape and material. Type 0 also covers hollow panels.
export function creativeMicroblock(entry) {
  if (entry?.kind !== 'microblock' || !Number.isSafeInteger(entry.coverData)) return null;
  const type = entry.coverData >>> 24;
  const slot = [0,6,14,26][type];
  const part = {slot, shape:(entry.coverData >> 8) & 255, material:entry.coverData & 255};
  if (!isMicroPart(part)) return null;
  const pattern = microblockPattern(coverBoxes([part]));
  return pattern ? {...part, pattern} : null;
}

// TileShapedLamp uses the clicked face's opposite side for the mount.
export function shapedLampData(damage, rot = 0) {
  return {style:(damage & 1023) >> 5, color:damage & 15, ps:damage & 16 ? 2 : 0, rot};
}
