import {decodeFarTile} from './far-tile-format.mjs';
import {readVista,vistaCell,VISTA_HEADER,VISTA_LOFT,VISTA_SIDE} from './vista-format.mjs';

function paletteOffset(palette,tile) {
  if (!palette?.data) return null;
  const {width,height,data}=palette;
  const row=Math.floor(tile/width);
  if (row>=height) return null;
  return (tile%width+(height-1-row)*width)*4;
}

function surface(pixels,palette,index,tile,tint,red,green,blue) {
  const at=paletteOffset(palette,tile);
  const source=at===null ? null : palette.data;
  pixels[index]=(source ? source[at] : 156)*tint[red]/255;
  pixels[index+1]=(source ? source[at+1] : 161)*tint[green]/255;
  pixels[index+2]=(source ? source[at+2] : 145)*tint[blue]/255;
  pixels[index+3]=255;
}

function shade(pixels,heights,size,units=1) {
  for (let z=1; z<size; z++) for (let x=1; x<size; x++) {
    const index=x+z*size, y=heights[index];
    if (!pixels[4*index+3] || !Number.isFinite(y)) continue;
    const west=heights[index-1], north=heights[index-size];
    const rise=(Number.isFinite(west)?y-west:0)+(Number.isFinite(north)?y-north:0);
    const light=1+Math.max(-.18,Math.min(.16,rise/(24*units)));
    for (let channel=0; channel<3; channel++) pixels[index*4+channel]*=light;
  }
}

export function rasterFarMap(buffer,palette) {
  const {layers}=decodeFarTile(buffer);
  const size=64;
  const pixels=new Uint8ClampedArray(size*size*4);
  const heights=new Float32Array(size*size).fill(-Infinity);
  for (const layer of [layers[0],layers[1],layers[4]]) {
    const {count,offset,span,surface:material,color,heightScale,coordinateScale}=layer;
    for (let i=0; i<count; i++) {
      if ((material[2*i+1]&7)!==3) continue;
      const x=offset[3*i]/coordinateScale, z=offset[3*i+2]/coordinateScale;
      const height=offset[3*i+1]/heightScale;
      const right=Math.min(size,Math.ceil(x+span[2*i+1]/coordinateScale));
      const bottom=Math.min(size,Math.ceil(z+span[2*i]/coordinateScale));
      for (let nz=Math.floor(z); nz<bottom; nz++) for (let nx=Math.floor(x); nx<right; nx++) {
        const index=nx+nz*size;
        if (heights[index]>height) continue;
        heights[index]=height;
        surface(pixels,palette,index*4,material[2*i],color,3*i,3*i+1,3*i+2);
      }
    }
  }
  shade(pixels,heights,size);
  return {pixels,size};
}

export function rasterVistaMap(buffer,palette) {
  const view=readVista(buffer), bytes=new Uint8Array(buffer);
  const lofts=view.getUint8(4)>1;
  const stride=lofts?4:1, size=VISTA_SIDE*stride;
  const pixels=new Uint8ClampedArray(size*size*4);
  const heights=new Float32Array(size*size).fill(-Infinity);
  for (let z=0; z<VISTA_SIDE; z++) for (let x=0; x<VISTA_SIDE; x++) {
    const base=lofts ? vistaCell(x,z) : VISTA_HEADER+(x+1+(z+1)*(VISTA_SIDE+2))*VISTA_LOFT;
    const floor=view.getUint16(base,true);
    const loft=base+VISTA_LOFT;
    const roof=lofts ? view.getUint16(loft,true) : 0;
    const mask=roof>floor ? view.getUint16(loft+11,true) : 0;
    for (let dz=0; dz<stride; dz++) for (let dx=0; dx<stride; dx++) {
      const covered=mask&(1<<(dx+4*dz));
      const height=covered?roof:floor;
      if (!height) continue;
      const at=covered?loft:base;
      const index=x*stride+dx+(z*stride+dz)*size;
      heights[index]=height;
      surface(pixels,palette,index*4,view.getUint16(at+2,true),bytes,at+6,at+7,at+8);
    }
  }
  shade(pixels,heights,size,8);
  return {pixels,size};
}
