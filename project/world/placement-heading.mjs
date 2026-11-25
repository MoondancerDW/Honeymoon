import {blockKey,blockState,signalSides} from './block-interactions.mjs';

const frontSideBlocks=new Set([54,61,62,130]);
const stairs=new Set([53,67,108,109,114,128,134,135,136,3247]);
const lookingFaces=[3,5,2,4];
const wallAttachment=new Set([65,106,127,131,144]);

export function placementHeading(yaw) {
  return Math.round(yaw*2/Math.PI)&3;
}

export const placementRotation=yaw=>Math.round(yaw*8/Math.PI)&15;
export const isChiselStair=id=>id>=2808&&id<=2831;

export function placementFace(target,against) {
  return against ? signalSides.findIndex(([x,y,z])=>x===target.x-against.x && y===target.y-against.y && z===target.z-against.z) : -1;
}

export function orientWallAttachment(key,{against},target) {
  const [id,meta]=blockState(key);
  if (!against || !wallAttachment.has(id)) return;
  const face=placementFace(target,against);
  if (face<2 && !(id===106 && face===0 || id===144 && face===1)) return {error:'invalid_mount_face'};
  switch (id) {
    case 65: return {cell:blockKey(id,face),requireSupport:face};
    case 106: return {cell:blockKey(id,[0,0,1,4,8,2][face]),requireSupport:face};
    case 127: return {cell:blockKey(id,(meta&12)|[0,0,0,2,1,3][face]),requireSupport:face,jungleLog:true};
    case 131: return {cell:blockKey(id,[0,0,0,2,3,1][face]),requireSupport:face};
    case 144: return {cell:blockKey(id,face),requireSupport:face};
  }
}

export function orientPlacedBlock(key,{yaw,hit,against,creative},target) {
  const face=placementFace(target,against);
  if (face<0) return key;
  const [id,meta]=blockState(key);
  const top=face===0 || face>=2 && hit?.y-target.y>.5;
  if (id===17 && (meta&12)!==12) {
    return blockKey(id,(meta&3)|(face>=4?4:face>=2?8:0));
  }
  if (id===44 || id===126 || id===3248 || id>=4051 && id<=4066) {
    return blockKey(id,(meta&7)|(top?8:0));
  }
  if (yaw===undefined) return key;
  const heading=placementHeading(yaw);
  if (frontSideBlocks.has(id)) return blockKey(id,lookingFaces[heading]);
  if (id===86 || id===91) return blockKey(id,-heading&3);
  if (id===90) return blockKey(id,heading&1?2:1);
  if (id===120) return blockKey(id,(meta&4)|((2-heading)&3));
  if (id===145) return blockKey(id,(creative && meta<=2 ? meta<<2 : meta&12)|((heading+1)&1));
  if (stairs.has(id) || isChiselStair(id) || id>=4035 && id<=4050) {
    const material=isChiselStair(id)?meta&8:0;
    return blockKey(id,material|[3,1,2,0][heading]|(top?4:0));
  }
  if (id===96) {
    const side=face>=2?[0,1,2,3][face-2]:[1,3,0,2][heading];
    return blockKey(id,side|(top?8:0));
  }
  return key;
}
