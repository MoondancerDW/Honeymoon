import {CREATIVE_INVISIBLE_FRAME_KEY,microblockDamageFromPart} from './creative-items.mjs';
import {FAKE_WATER} from './fluid-state.mjs';
import {voxelAtHit,voxelCoordinate,voxelIndex,voxelMaterialAt} from './voxel-chisel.mjs';

const blockAsItem=new Map([[26,355],[55,331],[63,323],[64,324],[68,323],[71,330],[93,356],[94,356]]);
const code=(id,variant)=>Number.isInteger(id) && id>0 && Number.isInteger(variant) && variant>=0 ? `${id}:${variant}` : null;
const microblockCode=part=>code(750,microblockDamageFromPart(part));

export function minecraftBlockCode(cell) {
  const key=typeof cell==='string'?cell:cell?.key;
  if (key===FAKE_WATER) return '9:0';
  const match=/^(?:legacy|cover):(\d+):(\d+)(?::|$)/.exec(key??'');
  return match?code(Number(match[1]),Number(match[2])):null;
}

export function minecraftTargetCode(target) {
  if (!target) return null;
  if (target.part) {
    const part = microblockCode(target.part);
    if (part) return part;
  }
  const voxels = target.cell?.voxels;
  if (voxels && !target.liquid) {
    const index = target.voxel ?? voxelAtHit(target,target.hit,target.offset,true,voxels);
    const material = minecraftBlockCode(voxelMaterialAt(voxels,index));
    if (material) {
      const [id,variant] = material.split(':').map(Number);
      const [x,y,z] = voxelCoordinate(index);
      const quarter = voxels.quarters?.includes(voxelIndex(x & ~1,y & ~1,z & ~1));
      // Chisel pieces use a range above the 16-bit RedPower item damage.
      return code(750,0x10000 + (id * 16 + variant) * 2 + Number(Boolean(quarter)));
    }
  }
  return minecraftBlockCode(target.cell);
}

export function minecraftItemCode(stack,entry) {
  const key=stack?.key??entry?.key;
  if (key===CREATIVE_INVISIBLE_FRAME_KEY) return '389:0';
  const item=/^creative:(\d+):(\d+)$/.exec(key??'');
  if (item) return code(Number(item[1]),Number(item[2]));
  if (stack?.part) {
    const part = microblockCode(stack.part);
    if (part) return part;
  }
  const block=minecraftBlockCode(key??stack?.cell);
  if (block) {
    const id=blockAsItem.get(Number(block.split(':')[0]));
    return id?code(id,0):block;
  }
  return code(entry?.id,entry?.damage??entry?.meta??0)??minecraftBlockCode(stack?.cell);
}

export const formatMinecraftId=value=>value?`id ${value}`:'';
