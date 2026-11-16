import {shapeFor} from '../world/geometry.mjs';

const side = 18, vertical = side * side;
const lateral = [[1,0,1],[-1,0,-1],[0,1,side],[0,-1,-side]];
const grassTint = shapeFor('legacy:31:1')[0].tint;
const grassTile = shapeFor('legacy:31:1')[0].faces[0];
const leafLimit = 88, grassLimit = 96, rootLimit = 24;

export function leafBlock(key) {
  return Boolean(key?.startsWith('legacy:18:') || key?.startsWith('legacy:243:'));
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

export function appendFoliage({indices,palette,light,origin,emit}) {
  const kind = palette.map(key => leafBlock(key) ? 1 : key?.startsWith('legacy:2:') ? 2 :
    /^legacy:17:[0-3]$/.test(key ?? '') ? 3 : 0);
  let leaves = 0, grass = 0, roots = 0;
  for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const at = x + 1 + (z + 1) * side + (y + 1) * vertical;
    const type = kind[indices[at]];
    if (!type) continue;
    const seed = mixSeed(origin[0] + x,origin[1] + y,origin[2] + z);
    const angle = ((seed >>> 16) & 15) / 16 * Math.PI;
    if (type === 1 && leaves < leafLimit && (seed & 3) === 0) {
      const faces = lateral.filter(([, , delta]) => !indices[at + delta]);
      if (!faces.length || faces.length === 1 && indices[at + vertical]) continue;
      const [dx,dz,delta] = faces[(seed >>> 2) % faces.length];
      const px = x + .5 + dx * .55, pz = z + .5 + dz * .55;
      const py = y + .22 + ((seed >>> 8) & 7) * .05;
      const [tile,tint] = color(palette[indices[at]]);
      if (tile < 0) continue;
      const width = .23 + ((seed >>> 13) & 3) * .045;
      emit(angledCard(px,py,pz,width,.47,angle,.35),tile,light[at+delta],tint,.91,225);
      emit(angledCard(px,py-.05,pz,width,.47,angle+Math.PI/2,-.25),tile,light[at+delta],tint,.86,190);
      leaves += 2;
    } else if (type === 2 && grass < grassLimit && (seed & 7) === 0 && !indices[at + vertical]) {
      const px = x + .25 + ((seed >>> 6) & 7) * .07, pz = z + .25 + ((seed >>> 10) & 7) * .07;
      const height = .12 + ((seed >>> 13) & 7) * .015;
      emit(angledCard(px,y+1,pz,.15,height,angle,.30),grassTile,light[at+vertical],grassTint,.91,124);
      emit(angledCard(px,y+1,pz,.14,height*.86,angle+Math.PI/2,.26),grassTile,light[at+vertical],grassTint,.83,110);
      grass += 2;
    } else if (type === 3 && roots < rootLimit) {
      const soil = palette[indices[at - vertical]];
      if (!/^legacy:(?:2|3|12|13):/.test(soil ?? '')) continue;
      const [tile] = color(palette[indices[at]]);
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
