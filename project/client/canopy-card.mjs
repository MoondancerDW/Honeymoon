import {ATLAS_GRID,TILE_SIZE,shapeFor} from '../world/geometry.mjs';

// Vanilla, RedPower rubber, Twilight oak and magic trees, and Mine Little Brony fruit trees.
export const foliageLeafIds = [18,243,2164,2177,3250];
const leafTiles = [...new Set(foliageLeafIds.flatMap(id => Array.from({length:4}, (_, species) =>
  shapeFor(`legacy:${id}:${species}`)[0].faces[0])))];
export const canopySlot = new Map(leafTiles.map((tile,index) => [tile,index+1]));
export const shortGrassTile = shapeFor('legacy:31:1')[0].faces[0];
export const shortGrassSlot = leafTiles.length+1;
export const foliageAtlasColumns = 4;
export const foliageAtlasRows = Math.ceil(shortGrassSlot/foliageAtlasColumns);
const spriteSize = TILE_SIZE*2;
const stride = spriteSize*2;
const gutter = spriteSize/2;
const clamp = coordinate => Math.min(spriteSize-1,Math.max(0,coordinate));
const fineTiles = new Set([18,2164].map(id => shapeFor(`legacy:${id}:1`)[0].faces[0]));

function roundMask(x,y,fine) {
  const u = (x+.5-gutter)/gutter;
  const v = (y+.5-gutter)/gutter;
  const radius = Math.hypot(u,v);
  const angle = Math.atan2(v,u);
  const edge = .93 + .072*Math.sin(angle*5+.6) + .042*Math.cos(angle*11-1.6);
  if (radius > edge) return 0;
  // Cutting small gaps in the outline keeps opaque modded leaf textures leafy too.
  const pores = Math.sin(x*1.27+y*.69) + Math.cos(y*1.17-x*.37);
  return pores > (fine ? 1.13 : 1.54+.27*(1-radius)) ? 0 : 255;
}

// Better Foliage builds a round sprite by tiling the pack's leaf sprite 2×2
// and masking its alpha. Keep the pack's pixel colors, texture holes and tint rules.
export function foliageAtlasPixels(source,sourceWidth,sourceRows) {
  const width = foliageAtlasColumns*stride;
  const height = foliageAtlasRows*stride;
  const pixels = new Uint8Array(width*height*4);
  for (const [slot,tile] of [...leafTiles,shortGrassTile].entries()) {
    if (tile >= sourceRows*ATLAS_GRID) continue;
    const grass = slot+1===shortGrassSlot;
    const fine = fineTiles.has(tile);
    const inputX = tile%ATLAS_GRID*TILE_SIZE;
    const inputY = Math.floor(tile/ATLAS_GRID)*TILE_SIZE;
    const outputX = (slot%foliageAtlasColumns)*stride;
    const outputY = Math.floor(slot/foliageAtlasColumns)*stride;
    const grassOffset = spriteSize*3/8;
    for (let py=0;py<stride;py++) for (let px=0;px<stride;px++) {
      const x=px-gutter, y=py-gutter;
      const sx=grass ? clamp(x)>>1 : clamp(x)%TILE_SIZE;
      const sy=grass ? Math.max(0,clamp(y)-grassOffset)>>1 : clamp(y)%TILE_SIZE;
      const from=(inputX+sx+(inputY+sy)*sourceWidth)*4;
      const into=(outputX+px+(height-1-outputY-py)*width)*4;
      pixels[into]=source[from];
      pixels[into+1]=source[from+1];
      pixels[into+2]=source[from+2];
      if (x<0||x>=spriteSize||y<0||y>=spriteSize) continue;
      if (grass ? y>=grassOffset : roundMask(x,y,fine)) pixels[into+3]=source[from+3];
    }
  }
  return {pixels,width,height};
}
