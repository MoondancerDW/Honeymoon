import {shapeFor} from '../world/geometry.mjs';

const side = 18, vertical = side * side;
const lateral = [[1,0,1],[-1,0,-1],[0,1,side],[0,-1,-side]];
const grassTint = shapeFor('legacy:31:1')[0].tint;
const grassTile = shapeFor('legacy:31:1')[0].faces[0];
const leafLimit=280, grassLimit=400, rootLimit=24;
// Vanilla, RedPower rubber, Twilight oak and magic trees, and Mine Little Brony fruit trees.
const leaves = new Set([18,243,2164,2177,3250]);
const trunks = new Set([17,245,701,2163,2176,3251]);
const legacyId=key=>Number(key?.slice(7,key.indexOf(':',7)));

export function leafBlock(key) {
  return key?.startsWith('legacy:') && leaves.has(legacyId(key));
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

function color(key) {
  const shape = shapeFor(key)[0];
  return [shape.faces[0],shape.tint];
}

function angledCard(x,y,z,radius,height,axis,lean = 0) {
  const dx = Math.cos(axis) * radius, dz = Math.sin(axis) * radius;
  return [[x-dx,y,z-dz], [x+dx,y,z+dz],
    [x+dx-dz*lean,y+height,z+dz+dx*lean], [x-dx-dz*lean,y+height,z-dz+dx*lean]];
}

export function appendFoliage({indices,palette,light,origin,biomeTints,emit}) {
  const kind = palette.map(key => leafBlock(key) ? 1 : key?.startsWith('legacy:2:') ? 2 :
    key?.startsWith('legacy:') && trunks.has(legacyId(key)) ? 3 : 0);
  let leaves = 0, grass = 0, roots = 0;
  for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const at = x + 1 + (z + 1) * side + (y + 1) * vertical;
    const type = kind[indices[at]];
    if (!type) continue;
    const seed = mixSeed(origin[0] + x,origin[1] + y,origin[2] + z);
    const angle = ((seed >>> 16) & 15) / 16 * Math.PI;
    const tintIndex=(z*16+x)*2;
    if (type===1 && leaves<leafLimit && (seed&7)<5) {
      const faces = lateral.filter(([, , delta]) => !indices[at + delta]);
      const top=!indices[at+vertical];
      if (!faces.length && !top) continue;
      if (!top && faces.length===1 && (seed&7)>2) continue;
      const [dx,dz,delta]=faces[(seed>>>3)%faces.length] ?? [0,0,vertical];
      const px=x+.5+dx*.35, pz=z+.5+dz*.35;
      const py=top ? y+.54+((seed>>>9)&3)*.035 : y+.02+((seed>>>9)&3)*.035;
      const key=palette[indices[at]];
      const [tile,nativeTint]=color(key);
      const tint=biomeLeaf(key) ? biomeTints?.[tintIndex+1] ?? nativeTint : nativeTint;
      if (tile < 0) continue;
      const width=.57+((seed>>>13)&3)*.05;
      const aim=angle*.56+Math.atan2(dz,dx);
      const height=.70+((seed>>>6)&7)*.045;
      const packed=light[top ? at+vertical : at+delta];
      emit(angledCard(px,py,pz,width,height,aim,.20),tile,packed,tint,.94,155,1);
      emit(angledCard(px,py-.07,pz,width*.95,height*.88,aim+Math.PI/2,-.19),tile,packed,tint,.91,148,1);
      leaves += 2;
    } else if (type===2 && grass<grassLimit && (seed&7)<6 && !indices[at+vertical]) {
      const px=x+.23+((seed>>>6)&7)*.073, pz=z+.23+((seed>>>10)&7)*.073;
      const height=.15+((seed>>>13)&7)*.027;
      const tint=biomeTints?.[tintIndex] ?? grassTint, packed=light[at+vertical];
      const width=.31+((seed>>>5)&3)*.027;
      emit(angledCard(px,y+.998,pz,width,height,angle,.22),grassTile,packed,tint,1,147);
      emit(angledCard(px,y+.998,pz,width*.92,height*.88,angle+Math.PI/2,.18),grassTile,packed,tint,.94,133);
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
