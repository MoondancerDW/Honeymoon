import {collisionFor,coverBoxes} from '../world/geometry.mjs';
import {fluidState,fluidSurface} from '../world/fluid-state.mjs';
import {extractedModel} from '../world/extracted-models.mjs';
import {leafBlock} from './foliage-mesh.mjs';

const unknown = {top:Infinity,parts:[],kind:'stone'};
const glass = new Set([20,102,2802,2803]);
const wood = new Set([5,17,47,53,54,64,85,96,107,125,126,134,135,136,162,242]);
const woodCover = new Set([4,12,13,14,16,48,49,50,51,52,56,57,58,59,60,65]);
const listenerSamples = [[0,0],[.44,0],[-.44,0],[0,.44],[0,-.44],[1.25,0],[-1.25,0],[0,1.25],[0,-1.25]];

export function rainRoofKind(cell,coverMaterial) {
  if (coverMaterial===7) return 'glass';
  if (woodCover.has(coverMaterial)) return 'wood';
  const key=typeof cell==='string' ? cell : cell?.key;
  const id=Number(key?.split(':')[1]);
  if (id===106 || leafBlock(key)) return 'foliage';
  if (glass.has(id)) return 'glass';
  if (wood.has(id)) return 'wood';
  return 'stone';
}

export class RainCover {
  constructor(world) {
    this.world = world;
    this.columns = new Map();
  }

  beginFrame() { this.budget = 32; }

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
    let top = -Infinity, kind;
    for (;y>=0 && y+1.5>top;y--) {
      const cell = this.world.cellAt(x,y,z);
      if (!cell) continue;
      const neighbors = (dx,dy,dz)=>this.world.cellAt(x+dx,y+dy,z+dz);
      let boxes = extractedModel(this.world.models,cell,neighbors)?.collision ?? collisionFor(cell,neighbors);
      if (cell.voxels && cell.parts) boxes = [...boxes,...coverBoxes(cell.parts)];
      const fluid=fluidState(cell);
      if (fluid) {
        const floor=y+fluidSurface(fluid,fluidState(neighbors(0,1,0)));
        if (floor>top) {top=floor; kind='water';}
      }
      for (const {x0,x1,y1,z0,z1,material} of boxes) {
        if (x0>=x1 || z0>=z1 || y+y1<=top) continue;
        const surface=rainRoofKind(cell,material);
        if (x0<=0 && x1>=1 && z0<=0 && z1>=1) {top=y+y1; kind=surface;}
        else parts.push({x0,x1,z0,z1,top:y+y1,kind:surface});
      }
    }
    if (this.columns.size >= 2200 && !saved) this.columns.delete(this.columns.keys().next().value);
    const entry = {chunk,top,kind,parts:parts.filter(part=>part.top>top)};
    this.columns.set(key,entry);
    return entry;
  }

  heightAt(x,z) {
    return this.surfaceAt(x,z).top;
  }

  surfaceAt(x,z) {
    const bx = Math.floor(x), bz = Math.floor(z);
    let highest=this.column(bx,bz);
    x -= bx;
    z -= bz;
    for (const part of highest.parts) {
      if (part.top>highest.top && x>=part.x0 && x<=part.x1 && z>=part.z0 && z<=part.z1) highest=part;
    }
    return highest;
  }

  listener({x,y,z}) {
    const direct=this.surfaceAt(x,z);
    const sheltered=y<=direct.top;
    let exposed=0, nearest=direct;
    for (const [dx,dz] of listenerSamples) {
      const surface=this.surfaceAt(x+dx,z+dz);
      if (y>surface.top) exposed++;
      else if (surface.top<nearest.top) nearest=surface;
    }
    return {sheltered,exposure:exposed/listenerSamples.length,
      roof:sheltered ? (direct.top===Infinity ? nearest.kind : direct.kind) : undefined,
      roofHeight:sheltered ? Math.max(0,(direct.top===Infinity ? nearest.top : direct.top)-y) : 0};
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
