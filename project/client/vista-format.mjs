export const VISTA_VERSION = 1;
export const VISTA_STEP = 8;
export const VISTA_BLOCKS = 512;
export const VISTA_SIDE = VISTA_BLOCKS / VISTA_STEP;
export const VISTA_HEADER = 8;
export const VISTA_RECORD = 9;
const STRIDE = VISTA_SIDE + 2;
const SCALE = 8;
export const vistaCell = (x,z) => VISTA_HEADER + (x+1+(z+1)*STRIDE)*VISTA_RECORD;
export const vistaBytes = VISTA_HEADER+STRIDE**2*VISTA_RECORD;

export function readVista(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength !== vistaBytes || view.getUint32(0) !== 0x48565354 ||
      view.getUint8(4) !== VISTA_VERSION || view.getUint8(5) !== VISTA_STEP) throw new Error('Invalid vista tile');
  return view;
}

function coarsen(view) {
  const bytes = new Uint8Array(view.buffer);
  const cells = new Array(4);
  // Keep the source samples along the two outer rows and columns. Their
  // neighbours can close the same cliff even when using a different tier.
  for (let z=2; z<VISTA_SIDE-2; z+=2) for (let x=2; x<VISTA_SIDE-2; x+=2) {
    cells[0] = vistaCell(x,z);
    cells[1] = vistaCell(x+1,z);
    cells[2] = vistaCell(x,z+1);
    cells[3] = vistaCell(x+1,z+1);
    if (cells.some(offset => view.getUint16(offset,true) === 0)) continue;
    cells.sort((a,b) => view.getUint16(a,true)-view.getUint16(b,true));
    const sample = bytes.subarray(cells[2],cells[2]+VISTA_RECORD);
    for (const offset of cells) bytes.set(sample,offset);
  }
}

export function decodeVista(buffer,coarse = false) {
  const view = readVista(coarse ? buffer.slice(0) : buffer);
  if (coarse) coarsen(view);
  const offsets = [], spans = [], surfaces = [], lights = [], colors = [];
  let minY = 256, maxY = 0;
  function emit(x,z,base,width,height,face,at,shade) {
    offsets.push(x*SCALE,base,z*SCALE);
    spans.push(width,height);
    const tile = view.getUint16(at+2,true);
    const light = view.getUint16(at+4,true);
    const leaf = tile === 304 || tile === 305;
    surfaces.push(leaf ? 304 : tile,face);
    lights.push(leaf ? 240 | (light & 15) : light);
    for (let i=0; i<3; i++) colors.push(Math.round(view.getUint8(at+6+i)*shade));
    minY = Math.min(minY,base/SCALE);
  }
  const step = VISTA_STEP * SCALE;
  const heightAt = (x,z) => view.getUint16(vistaCell(x,z),true);
  const exposed = new Uint8Array(VISTA_SIDE**2);
  const edges = new Uint8Array(VISTA_SIDE**2);
  const sameSample = (next,at) => view.getUint32(next) === view.getUint32(at) &&
      view.getUint32(next+4) === view.getUint32(at+4) && view.getUint8(next+8) === view.getUint8(at+8);
  function matches(x,z,at) {
    return !exposed[x+z*VISTA_SIDE] && sameSample(vistaCell(x,z),at);
  }
  function flatTop(x,z,at) {
    let width = 1, length = 1;
    while (x+width < VISTA_SIDE && matches(x+width,z,at)) width++;
    rows: while (z+length < VISTA_SIDE) {
      for (let dx=0; dx<width; dx++) if (!matches(x+dx,z+length,at)) break rows;
      length++;
    }
    let row = x+z*VISTA_SIDE;
    for (let dz=0; dz<length; dz++,row+=VISTA_SIDE) exposed.fill(1,row,row+width);
    emit(x*VISTA_STEP,z*VISTA_STEP,view.getUint16(at,true),length*step,width*step,3,at,1);
  }
  function cliff(x,z,top,at,dx,dz,face,bit) {
    const base = heightAt(x+dx,z+dz);
    if (!base || base >= top || edges[x+z*VISTA_SIDE] & bit) return;
    const limit = dx ? VISTA_SIDE-z : VISTA_SIDE-x;
    let length = 1;
    for (; length < limit; length++) {
      const nx = x+(dz ? length : 0), nz = z+(dx ? length : 0);
      if (!sameSample(vistaCell(nx,nz),at) || heightAt(nx+dx,nz+dz) !== base) break;
      edges[nx+nz*VISTA_SIDE] |= bit;
    }
    emit((x+Number(dx > 0))*VISTA_STEP,(z+Number(dz > 0))*VISTA_STEP,base,
      face === 0 || face === 5 ? length*step : top-base,
      face === 0 || face === 5 ? top-base : length*step,face,at,dx ? .78 : .92);
  }
  for (let z=0; z<VISTA_SIDE; z++) for (let x=0; x<VISTA_SIDE; x++) {
    const top = heightAt(x,z);
    if (!top) continue;
    maxY = Math.max(maxY,top/SCALE);
    const at = vistaCell(x,z);
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
