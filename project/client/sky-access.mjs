import {staticOpacity} from '../world/block-light-properties.mjs';
import {blockState} from '../world/block-interactions.mjs';
import {coverBoxes,shapeFor} from '../world/geometry.mjs';
import {heldLightOcclusion} from '../world/held-light.mjs';
import {fullVoxelFluid,isOpaqueFullVoxels} from '../world/voxel-chisel.mjs';

const SKY=15, RADIUS=15, OUTSIDE=0xffff;
const DOWN=1<<8, UP=1<<9, ALL_FACES=0x3f<<4;
const axes=['x','z','y'];
const terrain=new Map();
const partSeals=new WeakMap();

function seals(boxes) {
  let mask=0;
  for (const box of boxes) {
    if (box.mode !== 'opaque' || box.kind) continue;
    for (let axis=0;axis<3;axis++) {
      const u=axes[(axis+1)%3], v=axes[(axis+2)%3];
      if (box[u+'0']===0 && box[u+'1']===1 && box[v+'0']===0 && box[v+'1']===1) mask |= 3<<(4+axis*2);
    }
  }
  return mask;
}

// The lower nibble is material absorption, including zero for clean air.
// Higher bits seal the two faces of each block axis.
export function skyProfile(cell) {
  const {key} = cell;
  if (!key || key==='air') return 0;
  if (cell.voxels && isOpaqueFullVoxels(cell.voxels)) return SKY;
  const water=cell.fluid==='water' || fullVoxelFluid(cell.voxels)==='water';
  if (cell.parts?.length) {
    let faces=partSeals.get(cell.parts);
    if (faces===undefined) {
      faces=(heldLightOcclusion(cell)&~15) | seals(coverBoxes(cell.parts));
      partSeals.set(cell.parts,faces);
    }
    return faces | (water ? staticOpacity[9] : 0);
  }
  if (cell.voxels) return water ? staticOpacity[9] : 0;
  let profile=terrain.get(key);
  if (profile===undefined) {
    const id=blockState(key)[0] || Number(/^cover:(\d+):/.exec(key)?.[1] ?? 0);
    const opacity=Math.min(SKY,staticOpacity[id] ?? 0);
    const faces=seals(shapeFor(key));
    profile=opacity===SKY && faces!==0 && faces!==ALL_FACES ? faces : opacity | faces;
    if (terrain.size>=4096) terrain.clear();
    terrain.set(key,profile);
  }
  return water ? (profile & ~15) | Math.max(profile&15,staticOpacity[9]) : profile;
}

export function skyCellProfile(world,x,y,z,original,chunk) {
  const cell=world.lightCell(x,y,z,original,chunk);
  if (!cell.parts && cell.key?.startsWith('cover:')) {
    cell.parts=(chunk.compositions ?? world.manifest.compositions)?.[cell.key]?.parts;
  }
  return skyProfile(cell);
}

function direct(light,previous,profile) {
  if (previous & DOWN || profile & UP) return 0;
  return Math.max(0,light-Math.max(Number(light<SKY),profile&15));
}

function solve(world, bounds, original) {
  const {minX,maxX,minY,maxY,minZ,maxZ,height}=bounds;
  const width=maxX-minX+3, depth=maxZ-minZ+3, plane=width*depth;
  const profiles=new Uint16Array(plane*(maxY-minY+3)).fill(OUTSIDE);
  const light=new Uint8Array(profiles.length);
  const strides=[-1,1,-width,width,-plane,plane];
  const frontier=Array.from({length:SKY+1},()=>[]);
  const at=(x,y,z)=>(x-minX+1)+(z-minZ+1)*width+(y-minY+1)*plane;
  for (let z=minZ;z<=maxZ;z++) for (let x=minX;x<=maxX;x++) {
    const key=`${x>>4},${z>>4}`;
    const chunk=world.chunks.get(key);
    if (!chunk?.hasSky || chunk.visualOnly) continue;
    const useBase=original || !world.overridesByChunk.has(key);
    const horizontalEdge=x===minX || x===maxX || z===minZ || z===maxZ;
    let beam=SKY, previous=0;
    for (let y=Math.max(maxY,Math.min(height.max,chunk.skyTop));y>=minY;y--) {
      if (y>maxY && !beam) {
        y=maxY+1;
        continue;
      }
      const profile=skyCellProfile(world,x,y,z,useBase,chunk);
      beam=direct(beam,previous,profile);
      previous=profile;
      if (y>maxY) continue;
      const index=at(x,y,z);
      const boundary=horizontalEdge || y===maxY && y<height.max || y===minY && y>height.min;
      profiles[index]=profile;
      let level=beam;
      if (boundary) {
        const sample=(original ? world.baseLightAt(x,y,z) : world.lightAt(x,y,z))>>4;
        level=Math.max(level,Math.min(sample,SKY-(profile&15)));
      }
      light[index]=level;
      if (level>1) frontier[level].push(index);
    }
  }
  for (let level=SKY;level>1;level--) for (const index of frontier[level]) {
    if (light[index]!==level) continue;
    for (let face=0;face<6;face++) {
      const next=index+strides[face];
      const loss=profiles[next];
      if (profiles[index] & (1<<(face+4)) || loss & (1<<((face^1)+4))) continue;
      const reduced=level-Math.max(1,loss&15);
      if (reduced<=light[next]) continue;
      light[next]=reduced;
      if (reduced>1) frontier[reduced].push(next);
    }
  }
  return {light,profiles,at};
}

// Recalculate an edit against the same analytical model of the unedited
// map. Applying only the difference keeps imported lighting at chunk
// boundaries and around decorative models that have their own baked shades.
export function updateSkyAccess(world,changes) {
  const dirty=new Set();
  const height={min:world.manifest.bounds?.minY ?? 0,max:world.manifest.bounds?.maxY ?? 255};
  const bounds={minX:Infinity,maxX:-Infinity,minY:Infinity,maxY:-Infinity,minZ:Infinity,maxZ:-Infinity,height};
  for (const [x,y,z] of changes) {
    const chunk=world.chunks.get(`${x>>4},${z>>4}`);
    if (!chunk?.hasSky || chunk.visualOnly) continue;
    let floor=y;
    for (let below=y-1;below>=height.min;below--) {
      const old=skyCellProfile(world,x,below,z,true,chunk);
      const current=skyCellProfile(world,x,below,z,false,chunk);
      if (direct(SKY,0,old)===0 && direct(SKY,0,current)===0) break;
      floor=below;
    }
    bounds.minX=Math.min(bounds.minX,x-RADIUS);
    bounds.maxX=Math.max(bounds.maxX,x+RADIUS);
    bounds.minZ=Math.min(bounds.minZ,z-RADIUS);
    bounds.maxZ=Math.max(bounds.maxZ,z+RADIUS);
    bounds.minY=Math.min(bounds.minY,Math.max(height.min,floor-RADIUS));
    bounds.maxY=Math.max(bounds.maxY,Math.min(height.max,y+RADIUS));
  }
  if (bounds.minX===Infinity) return dirty;
  const original=solve(world,bounds,true), updated=solve(world,bounds,false);
  for (let zz=bounds.minZ+1;zz<bounds.maxZ;zz++) for(let xx=bounds.minX+1;xx<bounds.maxX;xx++) {
    for (let yy=bounds.minY;yy<=bounds.maxY;yy++) {
      if (yy===bounds.minY && yy>height.min || yy===bounds.maxY && yy<height.max) continue;
      const index=updated.at(xx,yy,zz);
      if (updated.profiles[index]===OUTSIDE) continue;
      const delta=updated.light[index]-original.light[index];
      const key=`${xx},${yy},${zz}`;
      if (!delta && !world.skyLightOverrides.has(key)) continue;
      const base=world.baseLightAt(xx,yy,zz)>>4;
      const current=world.skyLightOverrides.get(key) ?? base;
      const next=!delta ? base : Math.max(0,Math.min(SKY,base+delta));
      if (next===current) continue;
      if (next===base) world.skyLightOverrides.delete(key);
      else world.skyLightOverrides.set(key,next);
      for (const [dx,dy,dz] of [[0,0,0],[-1,0,0],[1,0,0],[0,-1,0],[0,1,0],[0,0,-1],[0,0,1]]) {
        dirty.add(`${(xx+dx)>>4},${(yy+dy)>>4},${(zz+dz)>>4}`);
      }
    }
  }
  return dirty;
}
