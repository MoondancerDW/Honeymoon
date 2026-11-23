import {blockState} from './block-interactions.mjs';

export const cakeBlock = 92;
export const flowerPot = 140;
export const glassJar = 2168;
export const workbenchBlock = 58;
export const cakeItemKey = 'creative:354:0';
export const flowerPotItemKey = 'creative:390:0';
export const blockedPlaceTargets = new Set([cakeBlock,flowerPot,glassJar,workbenchBlock]);

const plants=[null,[38,0],[37,0],[6,0],[6,1],[6,2],[6,3],[40,0],[39,0],[81,0],[32,0],[31,2]];

export function pottedPlantKey(meta) {
  const plant=plants[meta];
  return plant ? `legacy:${plant.join(':')}` : null;
}

export function pottedPlantMeta(stack) {
  const [id,meta]=blockState(stack?.cell??stack?.key);
  const index=plants.findIndex(plant=>plant?.[0]===id && plant[1]===(id===6?meta&3:meta));
  return Math.max(index,0);
}

export function jarInsert(stack) {
  if (stack?.key==='creative:357:0') return 'cookie';
  if (blockState(stack?.cell??stack?.key)[0]===2160) return 'firefly';
}

export function decorationContents(cell) {
  const [id,meta]=blockState(cell);
  const plant=id===flowerPot && pottedPlantKey(meta);
  if (plant) return {key:plant,cell:plant,count:1};
  if (id!==glassJar) return null;
  if (cell?.object?.data?.jarContent==='cookie') return {key:'creative:357:0',count:1};
  if (cell?.object?.data?.jarContent==='firefly') return {key:'legacy:2160:0',cell:'legacy:2160:0',count:1};
  return null;
}
