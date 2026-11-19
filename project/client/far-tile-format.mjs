const HEADER = 72;
const RECORD = 16;
const CHUNKS = 16;
const faceAxes = [[2,1], [1,2], [0,2], [2,0], [1,0], [0,1]];
export const LOD_VERSION = 5;
export const DETAILED_LOD_DISTANCES = Object.freeze([8,12,16,20,24,28]);
export const DEFAULT_DETAILED_LOD_DISTANCE = 20;
export const WATER_HEIGHT_SCALE = 9;
export const TRANSITION_FACE = 8;
export const RAIL_FACE = 16;
export const MICRO_FACE = 32;
export const CUTOUT_FACE = 64;
export const MICRO_SCALE = 8;
export const supportedLodVersion = value => Number.isInteger(value) && value >= 1 && value <= LOD_VERSION;
export const lodDistance = version => version >= 3 ? 32 : 24;

export function validateDetailedLodDistance(distance) {
  if (!DETAILED_LOD_DISTANCES.includes(distance)) throw new RangeError('Unsupported detailed LOD distance');
  return distance;
}

function layer(count, heightScale = 1, coordinateScale = 1) {
  return {count, at:0, offset:new Uint16Array(count * 3), span:new Uint16Array(count * 2),
    surface:new Uint16Array(count * 2), light:new Uint16Array(count), color:new Uint8Array(count * 3),
    minY:256, maxY:0, heightScale, coordinateScale};
}

function subtractArea(rectangles,cutU0,cutV0,cutU1,cutV1) {
  let result;
  for (let i=0;i<rectangles.length;i++) {
    const [u0,v0,u1,v1]=rectangles[i];
    const lowU=Math.max(u0,cutU0), lowV=Math.max(v0,cutV0);
    const highU=Math.min(u1,cutU1), highV=Math.min(v1,cutV1);
    if (lowU>=highU || lowV>=highV) {
      result?.push(rectangles[i]);
      continue;
    }
    result??=rectangles.slice(0,i);
    if (u0<lowU) result.push([u0,v0,lowU,v1]);
    if (highU<u1) result.push([highU,v0,u1,v1]);
    if (v0<lowV) result.push([lowU,v0,highU,lowV]);
    if (highV<v1) result.push([lowU,highV,highU,v1]);
  }
  return result??rectangles;
}

// Opaque materials own a shared surface before cutouts, then the lower atlas tile wins.
const facePriority=(surface,i)=>(surface[i*2+1]&256)*256+surface[i*2];

function cutFace(clipped,i,u0,v0,u1,v1,cutU0,cutV0,cutU1,cutV1) {
  const remaining=clipped[i]??[[u0,v0,u1,v1]];
  const pieces=subtractArea(remaining,cutU0,cutV0,cutU1,cutV1);
  if (pieces===remaining) return 0;
  clipped[i]=pieces;
  return pieces.length-remaining.length;
}

function rebuildFaces(source,clipped,size,scale=1) {
  if (!clipped.length) return source;
  const {count,offset,span,surface,light,color}=source;
  const result=layer(size,source.heightScale*scale,source.coordinateScale*scale);
  result.minY=source.minY;
  result.maxY=source.maxY;
  function copy(i) {
    const at=result.at++;
    for (let axis=0;axis<3;axis++) {
      result.offset[at*3+axis]=offset[i*3+axis]*scale;
      result.color[at*3+axis]=color[i*3+axis];
    }
    result.span[at*2]=span[i*2]*scale;
    result.span[at*2+1]=span[i*2+1]*scale;
    result.surface[at*2]=surface[i*2];
    result.surface[at*2+1]=surface[i*2+1];
    result.light[at]=light[i];
    return at;
  }
  for (let i=0;i<count;i++) {
    if (!clipped[i]) {
      copy(i);
      continue;
    }
    const [u,v]=faceAxes[surface[i*2+1]&7];
    for (const [u0,v0,u1,v1] of clipped[i]) {
      const at=copy(i);
      result.offset[at*3+u]=u0;
      result.offset[at*3+v]=v0;
      result.span[at*2]=u1-u0;
      result.span[at*2+1]=v1-v0;
    }
  }
  return result;
}

function clipMicroFaces(source) {
  const {count,offset,span,surface}=source;
  if (count<2) return source;
  const planes=new Map(), next=new Int32Array(count);
  for (let i=0;i<count;i++) {
    const ownerAndFace=surface[i*2+1]&127;
    const axis=(ownerAndFace&7)>>1;
    // A chunk's render mask must never let a hidden face occlude another owner's geometry.
    const key=(offset[i*3+axis]<<7)|ownerAndFace;
    next[i]=planes.get(key)??-1;
    planes.set(key,i);
  }
  const clipped=[];
  let size=count;
  for (const [key,first] of planes) {
    const [u,v]=faceAxes[key&7];
    for (let a=first;next[a]>=0;a=next[a]) {
      const aU=offset[a*3+u], aV=offset[a*3+v];
      const aRight=aU+span[a*2], aTop=aV+span[a*2+1];
      const aPriority=facePriority(surface,a);
      for (let b=next[a];b>=0;b=next[b]) {
        const bU=offset[b*3+u], bRight=bU+span[b*2];
        if (aRight<=bU || bRight<=aU) continue;
        const bV=offset[b*3+v], bTop=bV+span[b*2+1];
        if (aTop<=bV || bTop<=aV) continue;
        const bPriority=facePriority(surface,b);
        const aWins=aPriority<bPriority || aPriority===bPriority && a<b;
        const lost=aWins?b:a;
        size+=cutFace(clipped,lost,aWins?bU:aU,aWins?bV:aV,aWins?bRight:aRight,aWins?bTop:aTop,
          Math.max(aU,bU),Math.max(aV,bV),Math.min(aRight,bRight),Math.min(aTop,bTop));
      }
    }
  }
  return rebuildFaces(source,clipped,size);
}

function clipTerrainCovers(land,micro) {
  if (!land.count || !micro.count) return [land,micro];
  // Whole-block greedy masks emit each patch once. Only the separate micro layer
  // can cover part of such a patch, and only on the same whole-block plane.
  const planes=new Map(), next=new Int32Array(land.count);
  for (let i=0;i<land.count;i++) {
    const ownerAndFace=land.surface[i*2+1]&127;
    const axis=(ownerAndFace&7)>>1;
    const key=(land.offset[i*3+axis]<<7)|ownerAndFace;
    next[i]=planes.get(key)??-1;
    planes.set(key,i);
  }
  const landClipped=[], microClipped=[];
  let landCount=land.count, microCount=micro.count;
  for (let b=0;b<micro.count;b++) {
    const ownerAndFace=micro.surface[b*2+1]&127;
    const face=ownerAndFace&7;
    const plane=micro.offset[b*3+(face>>1)]/MICRO_SCALE;
    if (!Number.isInteger(plane)) continue;
    const first=planes.get((plane<<7)|ownerAndFace);
    if (first===undefined) continue;
    const [u,v]=faceAxes[face];
    const bU=micro.offset[b*3+u], bV=micro.offset[b*3+v];
    const bRight=bU+micro.span[b*2], bTop=bV+micro.span[b*2+1];
    const bPriority=facePriority(micro.surface,b);
    for (let a=first;a>=0;a=next[a]) {
      const aU=land.offset[a*3+u]*MICRO_SCALE, aV=land.offset[a*3+v]*MICRO_SCALE;
      const aRight=aU+land.span[a*2]*MICRO_SCALE, aTop=aV+land.span[a*2+1]*MICRO_SCALE;
      if (aRight<=bU || bRight<=aU || aTop<=bV || bTop<=aV) continue;
      const cutU0=Math.max(aU,bU), cutV0=Math.max(aV,bV), cutU1=Math.min(aRight,bRight), cutV1=Math.min(aTop,bTop);
      if (bPriority<facePriority(land.surface,a)) {
        landCount+=cutFace(landClipped,a,aU,aV,aRight,aTop,cutU0,cutV0,cutU1,cutV1);
      } else {
        microCount+=cutFace(microClipped,b,bU,bV,bRight,bTop,cutU0,cutV0,cutU1,cutV1);
      }
    }
  }
  return [rebuildFaces(land,landClipped,landCount,MICRO_SCALE),rebuildFaces(micro,microClipped,microCount)];
}

export function decodeFarTile(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < HEADER || view.getUint32(0) !== 0x484c4f44 ||
      !supportedLodVersion(view.getUint16(4, true)) || view.getUint8(6) !== 4 || view.getUint8(7) !== RECORD ||
      (view.byteLength - HEADER) % RECORD) throw new Error('Invalid far terrain tile');
  const version = view.getUint16(4, true);
  const counts = new Uint32Array(CHUNKS);
  let total = 0;
  for (let index = 0; index < CHUNKS; index++) {
    counts[index] = view.getUint32(8 + 4 * index, true);
    total += counts[index];
  }
  if (total !== (view.byteLength - HEADER) / RECORD) throw new Error('Invalid far terrain tile size');

  let water = 0, transitions = 0, rails = 0, micros = 0;
  for (let offset = HEADER; offset < view.byteLength; offset += RECORD) {
    const flags = view.getUint8(offset + 8);
    if (flags & 128) water++;
    else if (flags & TRANSITION_FACE) transitions++;
    else if (flags === RAIL_FACE) rails++;
    else if (flags & MICRO_FACE) micros++;
  }
  const layers = [layer(total-water-transitions-rails-micros), layer(water,version === 1 ? 1 : WATER_HEIGHT_SCALE),
    layer(transitions), layer(rails), layer(micros,MICRO_SCALE,MICRO_SCALE)];
  let byte = HEADER;
  for (let chunk = 0; chunk < CHUNKS; chunk++) {
    const x = (chunk & 3) * 16, z = (chunk >> 2) * 16;
    for (let i = 0; i < counts[chunk]; i++, byte += RECORD) {
      const flags = view.getUint8(byte + 8);
      const face = flags & 7;
      const skirt = flags & TRANSITION_FACE;
      const rail = flags === RAIL_FACE;
      const micro = flags & MICRO_FACE;
      const cutout = flags & CUTOUT_FACE;
      if (rail ? version < 4 : face >= 6 || flags & RAIL_FACE || (micro || cutout) && version < 5 ||
          micro && (skirt || flags & 128) || skirt && (version < 3 || face === 2 || face === 3 || flags & 128) ||
          version !== 1 && (flags & 128) && face !== 3) {
        throw new Error('Invalid far terrain face');
      }
      const data = layers[rail ? 3 : micro ? 4 : skirt ? 2 : flags >> 7];
      const at = data.at++;
      const y = view.getUint16(byte + 2, true);
      const width = view.getUint16(byte + 4, true);
      const height = view.getUint16(byte + 6, true);
      if (rail && (width > 9 || height !== 1)) throw new Error('Invalid far terrain rail');
      data.offset[at * 3] = x * data.coordinateScale + view.getUint8(byte);
      data.offset[at * 3 + 1] = y;
      data.offset[at * 3 + 2] = z * data.coordinateScale + view.getUint8(byte + 1);
      data.span[at * 2] = width;
      data.span[at * 2 + 1] = height;
      const tile = view.getUint16(byte + 9, true);
      const modLeaves = version >= 5 && tile === 305;
      data.surface[at * 2] = modLeaves ? 304 : tile;
      data.surface[at * 2 + 1] = face + chunk * 8 + (skirt ? 128 : 0) + (cutout || modLeaves ? 256 : 0);
      data.light[at] = view.getUint16(byte + 11, true);
      data.color[at * 3] = view.getUint8(byte + 13);
      data.color[at * 3 + 1] = view.getUint8(byte + 14);
      data.color[at * 3 + 2] = view.getUint8(byte + 15);
      data.minY = Math.min(data.minY, y / data.heightScale);
      const [u, v] = faceAxes[face];
      const rise = rail ? 1 / 16 + Number(width >= 2 && width <= 5) :
        (u === 1 ? width : v === 1 ? height : 0) / data.coordinateScale;
      data.maxY = Math.max(data.maxY, y / data.heightScale + rise);
    }
  }
  const landCount=layers[0].count;
  [layers[0],layers[4]]=clipTerrainCovers(layers[0],clipMicroFaces(layers[4]));
  total+=layers[0].count-landCount+layers[4].count-micros;
  return {counts, layers, bytes:total * 19, triangles:total * 2};
}

export function farVisibilityMask(regionX, regionZ, exact, counts) {
  let mask = 0;
  for (let i = 0; i < CHUNKS; i++) {
    if (counts[i] && !exact(regionX * 4 + (i & 3), regionZ * 4 + (i >> 2))) mask |= 1 << i;
  }
  return mask;
}
