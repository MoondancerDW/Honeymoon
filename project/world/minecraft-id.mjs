import {CREATIVE_INVISIBLE_FRAME_KEY,microblockDamageFromPart} from './creative-items.mjs';
import {FAKE_WATER} from './fluid-state.mjs';

const blockAsItem=new Map([[26,355],[55,331],[63,323],[64,324],[68,323],[71,330],[93,356],[94,356]]);
const code=(id,variant)=>Number.isInteger(id) && id>0 && Number.isInteger(variant) && variant>=0 ? `${id}:${variant}` : null;

export function minecraftBlockCode(cell) {
  const key=typeof cell==='string'?cell:cell?.key;
  if (key===FAKE_WATER) return '9:0';
  const match=/^(?:legacy|cover):(\d+):(\d+)(?::|$)/.exec(key??'');
  return match?code(Number(match[1]),Number(match[2])):null;
}

export function minecraftItemCode(stack,entry) {
  const key=stack?.key??entry?.key;
  if (key===CREATIVE_INVISIBLE_FRAME_KEY) return '389:0';
  const item=/^creative:(\d+):(\d+)$/.exec(key??'');
  if (item) return code(Number(item[1]),Number(item[2]));
  if (stack?.part) {
    const damage=microblockDamageFromPart(stack.part);
    if (damage!==null) return code(750,damage);
  }
  const block=minecraftBlockCode(key??stack?.cell);
  if (block) {
    const id=blockAsItem.get(Number(block.split(':')[0]));
    return id?code(id,0):block;
  }
  return code(entry?.id,entry?.damage??entry?.meta??0)??minecraftBlockCode(stack?.cell);
}

export const formatMinecraftId=value=>value?`id ${value.replace(/:0$/,'')}`:'';
