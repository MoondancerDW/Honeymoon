import {hasHatchRung} from './west-cellar.mjs';
import {VOXEL_SIZE, voxelFluidAt} from './voxel-chisel.mjs';
import {liquidAt} from './logged-fluid.mjs';
import {fluidState,fluidSurface} from './fluid-state.mjs';

const keyOf = cell => typeof cell === 'string' ? cell : cell?.key;

export function isLadder(cell) {
  const key = keyOf(cell);
  return key?.startsWith('legacy:65:') || key?.startsWith('legacy:106:') || hasHatchRung(cell);
}

export function liquidLevel(cell) {
  const fluid = fluidState(cell);
  return fluid?.kind === 'water' && !fluid.logged ? fluidSurface(fluid) : null;
}

export function fluidAt(cellAt, x, y, z, models) {
  const xx = Math.floor(x), yy = Math.floor(y), zz = Math.floor(z);
  const cell = cellAt(xx,yy,zz);
  const fluid = fluidState(cell);
  if (fluid?.fake) return null;
  if (fluid?.logged) return liquidAt(cell,[x-xx,y-yy,z-zz],
    (dx,dy,dz)=>cellAt(xx+dx,yy+dy,zz+dz),models) ?? null;
  if (fluid && y-yy < fluidSurface(fluid,fluidState(cellAt(xx,yy+1,zz)))) return fluid.kind;
  if (cell?.voxels) return voxelFluidAt(cell.voxels,Math.floor((x-xx)*VOXEL_SIZE),
    Math.floor((y-yy)*VOXEL_SIZE),Math.floor((z-zz)*VOXEL_SIZE)) ?? null;
  return null;
}

export function movementMedium(cellAt, x, y, z, models) {
  if (isLadder(cellAt(Math.floor(x),Math.floor(y+.00001),Math.floor(z)))) return 'ladder';
  return fluidAt(cellAt,x,y+.1,z,models);
}

const offsets = [[1,0],[-1,0],[0,1],[0,-1]];
export function fluidCurrent(cellAt, x, y, z, medium) {
  const bx=Math.floor(x), by=Math.floor(y+.1), bz=Math.floor(z);
  const fluid=fluidState(cellAt(bx,by,bz));
  if (!fluid || fluid.fake || fluid.kind !== medium) return [0,0,0];
  let dx=0,dz=0;
  for (const [sx,sz] of offsets) {
    const neighbor=fluidState(cellAt(bx+sx,by,bz+sz));
    const below=neighbor ? null : fluidState(cellAt(bx+sx,by-1,bz+sz));
    if (neighbor?.fake) continue;
    const slope=neighbor?.kind === medium ? (neighbor.falling ? 0 : neighbor.level)-fluid.level :
      below?.kind === medium && !below.fake ? 8+below.level-fluid.level : 0;
    dx+=slope*sx;
    dz+=slope*sz;
  }
  const magnitude=Math.hypot(dx,dz);
  const speed=(medium === 'water' ? 1.35 : .45)*Math.min(1,magnitude/3);
  return [magnitude ? speed*dx/magnitude : 0,fluid.falling ? -1.65 : 0,magnitude ? speed*dz/magnitude : 0];
}
