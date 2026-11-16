import {shapeFor} from '../world/geometry.mjs';
import {canopySlot,foliageLeafIds,shortGrassSlot,shortGrassTile} from './canopy-card.mjs';

const side = 18, vertical = side * side;
const lateral = [[1,0,1],[-1,0,-1],[0,1,side],[0,-1,-side]];
const grassTint = shapeFor('legacy:31:1')[0].tint;
const leafLimit=280, grassLimit=400, rootLimit=24;
const leafIds = new Set(foliageLeafIds);
const trunks = new Set([17,245,701,2163,2176,3251]);
const legacyId=key=>Number(key?.slice(7,key.indexOf(':',7)));
const fullUV = [[0,1],[1,1],[1,0],[0,0]];
const mirrorUV = fullUV.map(([u,v]) => [1-u,v]);
const leafUVs = Array.from({length:8},(_,index) => {
  const uv = index&4 ? mirrorUV : fullUV;
  const turns = index&3;
  return uv.slice(turns).concat(uv.slice(0,turns));
});

export function leafBlock(key) {
  return key?.startsWith('legacy:') && leafIds.has(legacyId(key));
}

export function biomeLeaf(key) {
  const species=Number(key.slice(10))&3;
  return key.startsWith('legacy:18:') && (species===0 || species===3);
}

function mixSeed(x,y,z) {
  let value = Math.imul(x,374761393) ^ Math.imul(y,668265263) ^ Math.imul(z,1919643887);
  value = Math.imul(value ^ (value >>> 13),1274126177);
  return (value ^ (value >>> 16)) >>> 0;
}

function angledCard(x,y,z,halfWidth,height,axis,lean = 0) {
  const dx = Math.cos(axis) * halfWidth, dz = Math.sin(axis) * halfWidth;
  return [[x-dx,y,z-dz], [x+dx,y,z+dz],
    [x+dx-dz*lean,y+height,z+dz+dx*lean], [x-dx-dz*lean,y+height,z-dz+dx*lean]];
}

function mergeLight(a,b) {
  return Math.max(a>>4,b>>4)<<4 | Math.max(a&15,b&15);
}

export function appendFoliage({indices,palette,light,origin,biomeTints,emit}) {
  const kind = palette.map(key => leafBlock(key) ? 1 : key?.startsWith('legacy:2:') ? 2 :
    key?.startsWith('legacy:') && trunks.has(legacyId(key)) ? 3 : 0);
  let leaves = 0, grass = 0, roots = 0;
  // If a dense section reaches the cap, keep the canopy silhouette first.
  for (let y = 15; y >= 0; y--) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const at = x + 1 + (z + 1) * side + (y + 1) * vertical;
    const type = kind[indices[at]];
    if (!type) continue;
    const seed = mixSeed(origin[0] + x,origin[1] + y,origin[2] + z);
    const tintIndex=(z*16+x)*2;
    if (type===1 && leaves<leafLimit) {
      const top=!indices[at+vertical];
      let exposed = Number(!indices[at-vertical]);
      let sideLight=light[at];
      for (const [, , delta] of lateral) {
        if (indices[at+delta]) continue;
        exposed++;
        sideLight=mergeLight(sideLight,light[at+delta]);
      }
      if (!top && (!exposed || exposed===1 && (seed&7)>=5)) continue;
      const key=palette[indices[at]];
      const shape=shapeFor(key)[0];
      const tile=shape.faces[0], slot=canopySlot.get(tile);
      if (!slot) continue;
      const tint=biomeLeaf(key) ? biomeTints?.[tintIndex+1] ?? shape.tint : shape.tint;
      const offsetAngle = ((seed>>>6)&63)*Math.PI/32;
      const offset=.12+((seed>>>12)&3)*.017;
      const px=x+.5+Math.cos(offsetAngle)*offset, pz=z+.5+Math.sin(offsetAngle)*offset;
      const size=1.25+((seed>>>14)&7)*.022;
      const width=size*Math.SQRT1_2, height=width*2;
      const bottom=y+.5-height/2+(((seed>>>17)&15)-7.5)*.013;
      const aim=Math.PI/4+(((seed>>>25)&7)-3.5)*.025;
      const upper=top ? mergeLight(sideLight,light[at+vertical]) : sideLight;
      const packed=[sideLight,sideLight,upper,upper];
      emit(angledCard(px,bottom,pz,width,height,aim,.04),tile,packed,tint,.97,-86,slot,leafUVs[(seed>>>21)&7]);
      emit(angledCard(px,bottom,pz,width,height,aim+Math.PI/2,-.04),tile,packed,tint,.92,-79,slot,leafUVs[(seed>>>28)&7]);
      leaves += 2;
    } else if (type===2 && grass<grassLimit && (seed&15)<13 && !indices[at+vertical]) {
      const offsetAngle = ((seed>>>6)&63)*Math.PI/32;
      const offset=.10+((seed>>>12)&7)*.014;
      const px=x+.5+Math.cos(offsetAngle)*offset, pz=z+.5+Math.sin(offsetAngle)*offset;
      const height=.41+((seed>>>15)&7)*.023;
      const tint=biomeTints?.[tintIndex] ?? grassTint, packed=light[at+vertical];
      const width=.43+((seed>>>18)&3)*.025;
      const angle=Math.PI/4+(((seed>>>20)&7)-3.5)*.038;
      emit(angledCard(px,y+1,pz,width,height,angle,.07),shortGrassTile,packed,tint,.98,147,shortGrassSlot,seed&16 ? mirrorUV : fullUV);
      emit(angledCard(px,y+1,pz,width,height,angle+Math.PI/2,-.07),shortGrassTile,packed,tint,.93,133,shortGrassSlot,seed&32 ? mirrorUV : fullUV);
      grass += 2;
    } else if (type === 3 && roots < rootLimit) {
      const soil = palette[indices[at - vertical]];
      if (!/^legacy:(?:2|3|12|13):/.test(soil ?? '')) continue;
      const tile=shapeFor(palette[indices[at]])[0].faces[0];
      for (const [dx,dz,delta] of lateral) {
        const below = palette[indices[at + delta - vertical]];
        if (roots >= rootLimit || indices[at+delta] || below && below !== 'air' && !/^legacy:[89]:/.test(below)) continue;
        const width = .13, endWidth = .04;
        const sx = x + .5 + dx * .37, sz = z + .5 + dz * .37;
        const ex = x + .5 + dx * .95, ez = z + .5 + dz * .95;
        const foot = y - .48, base = y + .22;
        emit([[sx+dz*width,base,sz-dx*width],[sx-dz*width,base,sz+dx*width],
          [ex-dz*endWidth,foot,ez+dx*endWidth],[ex+dz*endWidth,foot,ez-dx*endWidth]],tile,light[at+delta],0xffffff,.8);
        emit([[sx,base-.18,sz],[sx,base+.09,sz],[ex,foot+.035,ez],[ex,foot-.04,ez]],tile,light[at+delta],0xffffff,.71);
        roots += 2;
      }
    }
  }
  return leaves + grass + roots;
}
