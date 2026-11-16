import {collisionFor,coverBoxes} from '../world/geometry.mjs';
import {fluidState,fluidSurface} from '../world/fluid-state.mjs';

const unknown = {top:Infinity,parts:[]};

export class RainCover {
  constructor(world) {
    this.world = world;
    this.columns = new Map();
  }

  beginFrame() { this.budget = 24; }

  invalidate(x,z) {
    for (let dz=-1;dz<=1;dz++) for (let dx=-1;dx<=1;dx++) this.columns.delete(`${x+dx},${z+dz}`);
  }

  column(x,z) {
    const chunk = this.world.chunks.get(`${x>>4},${z>>4}`);
    if (!chunk || chunk.visualOnly) return unknown;
    const key = `${x},${z}`;
    const saved = this.columns.get(key);
    if (saved?.chunk === chunk) return saved;
    if (!this.budget) return unknown;
    this.budget--;
    let y = chunk.skyTop ?? -1;
    if (y < 0) for (const cy of chunk.sections.keys()) y = Math.max(y,cy*16+15);
    if (!chunk.hasSky) for (const edit of this.world.editsInChunk?.(x>>4,z>>4) ?? []) {
      if (edit.x===x && edit.z===z && edit.cell) y=Math.max(y,edit.y);
    }
    const parts = [];
    let top = -Infinity;
    for (;y>=0 && y+1.5>top;y--) {
      const cell = this.world.cellAt(x,y,z);
      if (!cell) continue;
      const neighbors = (dx,dy,dz)=>this.world.cellAt(x+dx,y+dy,z+dz);
      let boxes = collisionFor(cell,neighbors);
      if (cell.voxels && cell.parts) boxes = [...boxes,...coverBoxes(cell.parts)];
      const fluid=fluidState(cell);
      if (fluid) top=Math.max(top,y+fluidSurface(fluid,fluidState(neighbors(0,1,0))));
      for (const {x0,x1,y1,z0,z1} of boxes) {
        if (x0>=x1 || z0>=z1 || y+y1<=top) continue;
        if (x0<=0 && x1>=1 && z0<=0 && z1>=1) top = y+y1;
        else parts.push({x0,x1,z0,z1,top:y+y1});
      }
    }
    if (this.columns.size >= 2200 && !saved) this.columns.delete(this.columns.keys().next().value);
    const entry = {chunk,top,parts:parts.filter(part=>part.top>top)};
    this.columns.set(key,entry);
    return entry;
  }

  heightAt(x,z) {
    const bx = Math.floor(x), bz = Math.floor(z);
    const {top,parts} = this.column(bx,bz);
    x -= bx;
    z -= bz;
    let height = top;
    for (const part of parts) {
      if (x>=part.x0 && x<=part.x1 && z>=part.z0 && z<=part.z1) height = Math.max(height,part.top);
    }
    return height;
  }

  // The streak rises from its falling tip toward its tail. The first hit
  // against the vertical shadow of an overhead part is the end of the streak.
  fraction(x,y,z,dx,dy,dz,padding = 0) {
    let exposed = 1;
    const xEnd = x+dx, zEnd = z+dz;
    for (let bx=Math.floor(Math.min(x,xEnd)-padding);bx<=Math.floor(Math.max(x,xEnd)+padding);bx++) {
      for (let bz=Math.floor(Math.min(z,zEnd)-padding);bz<=Math.floor(Math.max(z,zEnd)+padding);bz++) {
        const {top,parts} = this.column(bx,bz);
        if (top>=y) exposed = Math.min(exposed,roofEntry(x-bx,y,z-bz,dx,dy,dz,0,1,0,1,top,padding));
        for (const part of parts) {
          if (part.top<y) continue;
          exposed = Math.min(exposed,roofEntry(x-bx,y,z-bz,dx,dy,dz,part.x0,part.x1,part.z0,part.z1,part.top,padding));
        }
        if (exposed === 0) return 0;
      }
    }
    return exposed;
  }
}

function roofEntry(x,y,z,dx,dy,dz,x0,x1,z0,z1,top,padding) {
  x0 -= padding; x1 += padding;
  z0 -= padding; z1 += padding;
  let enter = 0, leave = Math.min(1,(top-y)/dy);
  if (dx) {
    const a = (x0-x)/dx, b = (x1-x)/dx;
    enter = Math.max(enter,Math.min(a,b));
    leave = Math.min(leave,Math.max(a,b));
  } else if (x<x0 || x>x1) return 1;
  if (dz) {
    const a = (z0-z)/dz, b = (z1-z)/dz;
    enter = Math.max(enter,Math.min(a,b));
    leave = Math.min(leave,Math.max(a,b));
  } else if (z<z0 || z>z1) return 1;
  return enter<=leave ? enter : 1;
}
