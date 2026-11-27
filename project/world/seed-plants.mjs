import {blockKey,blockState} from './block-interactions.mjs';

// These items implement Forge IPlantable in the original client.
const farmCrops=new Map([
  [295,59], [361,104], [362,105], [391,141], [392,142], [9296,246],
]);

export function seedPlant(stack) {
  const match=/^creative:(\d+):0$/.exec(typeof stack==='string'?stack:stack?.key);
  if (!match) return;
  const id=Number(match[1]);
  if (id===372) return {cell:blockKey(115,0),soil:88};
  const crop=farmCrops.get(id);
  if (crop) return {cell:blockKey(crop,0),soil:60};
}

export function seedSoil(plant,cell) {
  return blockState(cell)[0]===plant.soil && !cell.parts?.length && !cell.voxels && !cell.fluid;
}

// RedPower begins at the clicked square and spirals north, west, south, east.
export function* seedSpiral(x,z) {
  const sides=[[0,-1],[-1,0],[0,1],[1,0]];
  let distance=1, index=0;
  yield [x,z];
  while (index<24) {
    const side=(distance&1)?0:2;
    for (const [stepX,stepZ] of sides.slice(side,side+2)) {
      for (let walked=0;walked<distance && index<24;walked++,index++) {
        x+=stepX;
        z+=stepZ;
        yield [x,z];
      }
    }
    distance++;
  }
}
