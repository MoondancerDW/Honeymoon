import {VISTA_STITCH_FACE} from './vista-stitch.mjs';

export const VISTA_VERSION = 2;
export const supportedVistaVersion = version => version === 1 || version === VISTA_VERSION;
export const VISTA_STEP = 8;
export const VISTA_BLOCKS = 512;
export const VISTA_SIDE = VISTA_BLOCKS / VISTA_STEP;
export const VISTA_HEADER = 8;
export const VISTA_LOFT = 9;
export const VISTA_RECORD = 22;
const STRIDE = VISTA_SIDE + 2;
const SCALE = 8;
const address = (x,z,record) => VISTA_HEADER + (x+1+(z+1)*STRIDE)*record;
export const vistaCell = (x,z) => address(x,z,VISTA_RECORD);
export const vistaBytes = VISTA_HEADER+STRIDE**2*VISTA_RECORD;

export function readVista(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < VISTA_HEADER || view.getUint32(0) !== 0x48565354 ||
      !supportedVistaVersion(view.getUint8(4)) || view.getUint8(5) !== VISTA_STEP) throw new Error('Invalid vista tile');
  if (view.byteLength !== (view.getUint8(4) === 1 ? VISTA_HEADER+STRIDE**2*VISTA_LOFT : vistaBytes)) {
    throw new Error('Invalid vista tile length');
  }
  return view;
}

function coarsen(view,cell,hasLofts) {
  const bytes = new Uint8Array(view.buffer);
  const cells = new Array(4);
  // Keep the source samples along the two outer rows and columns. Their
  // neighbours can close the same cliff even when using a different tier.
  for (let z=2; z<VISTA_SIDE-2; z+=2) for (let x=2; x<VISTA_SIDE-2; x+=2) {
    cells[0] = cell(x,z);
    cells[1] = cell(x+1,z);
    cells[2] = cell(x,z+1);
    cells[3] = cell(x+1,z+1);
    if (cells.some(offset => view.getUint16(offset,true)===0)) continue;
    cells.sort((a,b) => view.getUint16(a,true)-view.getUint16(b,true));
    const height=view.getUint16(cells[2],true);
    if (hasLofts && cells.some(offset=>{
      const base=view.getUint16(offset+VISTA_LOFT+9,true);
      return base && base<height+2*SCALE;
    })) continue;
    const sample = bytes.subarray(cells[2],cells[2]+VISTA_LOFT);
    for (const offset of cells) bytes.set(sample,offset);
  }
}

export function decodeVista(buffer,coarse = false,stitch = false) {
  const view = readVista(coarse ? buffer.slice(0) : buffer);
  const hasLofts = view.getUint8(4)>1;
  const cell = hasLofts ? vistaCell : (x,z)=>address(x,z,VISTA_LOFT);
  if (coarse) coarsen(view,cell,hasLofts);
  const offsets = [], spans = [], surfaces = [], lights = [], colors = [];
  let minY = 256, maxY = 0;
  function emit(x,z,base,width,height,face,at,shade,ground=false) {
    offsets.push(x*SCALE,base,z*SCALE);
    spans.push(width,height);
    const tile = view.getUint16(at+2,true);
    const light = view.getUint16(at+4,true);
    const leaf = tile === 304 || tile === 305;
    surfaces.push(leaf ? 304 : tile,face+(stitch && ground ? VISTA_STITCH_FACE : 0));
    lights.push(leaf ? 240 | (light & 15) : light);
    for (let i=0; i<3; i++) colors.push(Math.round(view.getUint8(at+6+i)*shade));
    minY = Math.min(minY,base/SCALE);
  }
  const step = VISTA_STEP * SCALE;
  const heightAt = (x,z) => view.getUint16(cell(x,z),true);
  const exposed = new Uint8Array(VISTA_SIDE**2);
  const edges = new Uint8Array(VISTA_SIDE**2);
  const loftCaps = new Uint8Array(VISTA_SIDE**2);
  const sameSample = (next,at) => view.getUint32(next) === view.getUint32(at) &&
      view.getUint32(next+4) === view.getUint32(at+4) && view.getUint8(next+8) === view.getUint8(at+8);
  function matches(x,z,at) {
    return !exposed[x+z*VISTA_SIDE] && sameSample(cell(x,z),at);
  }
  function flatTop(x,z,at) {
    let width = 1, length = 1;
    // At an active boundary every sample corner may have a different
    // height. Keep those vertices even when the raw plateau could merge.
    if (!stitch) {
      while (x+width < VISTA_SIDE && matches(x+width,z,at)) width++;
      rows: while (z+length < VISTA_SIDE) {
        for (let dx=0; dx<width; dx++) if (!matches(x+dx,z+length,at)) break rows;
        length++;
      }
    }
    let row = x+z*VISTA_SIDE;
    for (let dz=0; dz<length; dz++,row+=VISTA_SIDE) exposed.fill(1,row,row+width);
    emit(x*VISTA_STEP,z*VISTA_STEP,view.getUint16(at,true),length*step,width*step,3,at,1,true);
  }
  function cliff(x,z,top,at,dx,dz,face,bit) {
    const base = heightAt(x+dx,z+dz);
    if (!base || base >= top || edges[x+z*VISTA_SIDE] & bit) return;
    const limit = stitch ? 1 : dx ? VISTA_SIDE-z : VISTA_SIDE-x;
    let length = 1;
    for (; length < limit; length++) {
      const nx = x+(dz ? length : 0), nz = z+(dx ? length : 0);
      if (!sameSample(cell(nx,nz),at) || heightAt(nx+dx,nz+dz) !== base) break;
      edges[nx+nz*VISTA_SIDE] |= bit;
    }
    emit((x+Number(dx > 0))*VISTA_STEP,(z+Number(dz > 0))*VISTA_STEP,base,
      face === 0 || face === 5 ? length*step : top-base,
      face === 0 || face === 5 ? top-base : length*step,face,at,dx ? .78 : .92,true);
  }
  function wholeLoftCaps(x,z,at,base,top) {
    if (loftCaps[x+z*VISTA_SIDE]) return;
    const step = VISTA_STEP*SCALE;
    function sameLoft(nx,nz) {
      const other=cell(nx,nz)+VISTA_LOFT;
      return !loftCaps[nx+nz*VISTA_SIDE] && view.getUint16(other+11,true)===65535 &&
        view.getUint16(other+9,true)===base && sameSample(other,at);
    }
    let width=1, length=1;
    while (x+width<VISTA_SIDE && sameLoft(x+width,z)) width++;
    rows: while (z+length<VISTA_SIDE) {
      for (let dx=0;dx<width;dx++) if (!sameLoft(x+dx,z+length)) break rows;
      length++;
    }
    let row=x+z*VISTA_SIDE;
    for (let dz=0;dz<length;dz++,row+=VISTA_SIDE) loftCaps.fill(1,row,row+width);
    emit(x*VISTA_STEP,z*VISTA_STEP,top,length*step,width*step,3,at,1);
    emit(x*VISTA_STEP,z*VISTA_STEP,base,width*step,length*step,2,at,.66);
  }
  function lofts(x,z,at) {
    at+=VISTA_LOFT;
    const top = view.getUint16(at,true), base = view.getUint16(at+9,true);
    const mask = view.getUint16(at+11,true);
    if (top<=base || !mask) return;
    maxY = Math.max(maxY,top/SCALE);
    const cellStep = VISTA_STEP/4, unit=cellStep*SCALE;
    const whole=mask===65535;
    if (whole) wholeLoftCaps(x,z,at,base,top);
    let remaining = whole ? 0 : mask;
    for (let sz=0;sz<4;sz++) for (let sx=0;sx<4;sx++) {
      const bit = 1<<(sx+sz*4);
      if (!(mask&bit)) continue;
      const worldX=x*VISTA_STEP+sx*cellStep, worldZ=z*VISTA_STEP+sz*cellStep;
      if (remaining&bit) {
        let width=1, length=1;
        while (sx+width<4 && remaining&(bit<<width)) width++;
        const row=(2**width-1)<<(sx+sz*4);
        while (sz+length<4 && (remaining&(row<<(length*4)))===(row<<(length*4))) length++;
        for (let dz=0;dz<length;dz++) remaining &= ~(row<<(dz*4));
        emit(worldX,worldZ,top,length*unit,width*unit,3,at,1);
        emit(worldX,worldZ,base,width*unit,length*unit,2,at,.66);
      }
      for (const [dx,dz,face] of loftEdges) {
        const nx=x*4+sx+dx, nz=z*4+sz+dz;
        const neighbor=cell(nx>>2,nz>>2);
        const floor=Math.max(base,view.getUint16(neighbor,true));
        if (floor>=top) continue;
        const neighborLoft=neighbor+VISTA_LOFT;
        const otherMask=view.getUint16(neighborLoft+11,true);
        const covered=otherMask&(1<<((nx&3)+(nz&3)*4));
        const otherTop=covered ? view.getUint16(neighborLoft,true) : floor;
        const otherBase=covered ? view.getUint16(neighborLoft+9,true) : floor;
        const fx=worldX+Number(dx>0)*cellStep, fz=worldZ+Number(dz>0)*cellStep;
        const low=Math.min(top,otherBase), high=Math.max(floor,otherTop);
        if (low>floor) emit(fx,fz,floor,face===0 || face===5 ? unit : low-floor,
          face===0 || face===5 ? low-floor : unit,face,at,dx ? .78 : .92);
        if (top>high) emit(fx,fz,high,face===0 || face===5 ? unit : top-high,
          face===0 || face===5 ? top-high : unit,face,at,dx ? .78 : .92);
      }
    }
  }
  for (let z=0; z<VISTA_SIDE; z++) for (let x=0; x<VISTA_SIDE; x++) {
    const top = heightAt(x,z);
    const at = cell(x,z);
    if (hasLofts) lofts(x,z,at);
    if (!top) continue;
    maxY = Math.max(maxY,top/SCALE);
    if (!exposed[x+z*VISTA_SIDE]) flatTop(x,z,at);
    cliff(x,z,top,at,-1,0,0,1);
    cliff(x,z,top,at,1,0,1,2);
    cliff(x,z,top,at,0,-1,4,4);
    cliff(x,z,top,at,0,1,5,8);
  }
  const layer = {count:lights.length,offset:Uint16Array.from(offsets),span:Uint16Array.from(spans),
    surface:Uint16Array.from(surfaces),color:Uint8Array.from(colors),light:Uint16Array.from(lights),
    minY,maxY,heightScale:SCALE,coordinateScale:SCALE};
  return {layers:[layer],counts:new Uint32Array(),bytes:layer.count*19,triangles:layer.count*2};
}

const loftEdges = [[-1,0,0],[1,0,1],[0,-1,4],[0,1,5]];
