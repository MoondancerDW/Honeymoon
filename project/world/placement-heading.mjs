import {blockKey,blockState} from './block-interactions.mjs';

const frontSideBlocks=new Set([54,61,62,130,146]);
const stairs=new Set([53,67,108,109,114,128,134,135,136,156]);
const sideParts=new Set([65,68]);
const lookingFaces=[3,5,2,4];
const angleFields=['deskAngle',null,'bookcaseAngle','labelAngle','potionshelfAngle','rackAngle','genericShelfAngle','caseAngle'];

export function placementHeading(yaw) {
  return Math.round(yaw*2/Math.PI)&3;
}

export function orientPlacedBlock(key,{yaw,hit,against},target,{jammy,biblio}={}) {
  if (yaw===undefined || !against) return key;
  const [id,meta]=blockState(key);
  const heading=placementHeading(yaw);
  if (frontSideBlocks.has(id)) return blockKey(id,lookingFaces[heading]);
  if (id===86 || id===91 || id===120 || id===1526) return blockKey(id,(meta&12)|((2-heading)&3));
  if (id===145) return blockKey(id,(meta&12)|((heading+1)&1));
  if (stairs.has(id) || id>=2808 && id<=2831 || id>=4035 && id<=4050) {
    const top=against.y>target.y || against.y===target.y && hit?.y-target.y>.5;
    return blockKey(id,[3,1,2,0][heading]|(top?4:0));
  }
  if (id===17 || id===162 || id===170) {
    const axis=against.x!==target.x?4:against.z!==target.z?8:0;
    if (id===17 && (meta&12)===12) return key;
    return blockKey(id,(meta&3)|axis);
  }
  if (id===44 || id===126 || id===3248 || id>=4051 && id<=4066) {
    const top=against.y>target.y || against.y===target.y && hit?.y-target.y>.5;
    return blockKey(id,(meta&7)|(top?8:0));
  }
  if (sideParts.has(id)) {
    const face=against.x>target.x?4:against.x<target.x?5:against.z>target.z?2:against.z<target.z?3:undefined;
    return face===undefined?key:blockKey(id,face);
  }
  if (id===96) {
    const side=against.x>target.x?2:against.x<target.x?3:against.z>target.z?0:against.z<target.z?1:[1,3,0,2][heading];
    const top=against.y>target.y || against.y===target.y && hit?.y-target.y>.5;
    return blockKey(id,side|(top?8:0));
  }
  if (id===131 || id===127) {
    const direction=against.x>target.x?1:against.x<target.x?3:against.z>target.z?2:against.z<target.z?0:undefined;
    return direction===undefined?key:blockKey(id,(meta&12)|direction);
  }
  if (id>=200 && id<=217 && jammy?.models?.[key]) {
    const oriented=blockKey(id,(meta&12)|((2-heading)&3));
    if (jammy.models[oriented]) return oriented;
  }
  if (biblio?.models?.[key] && id===2249) {
    const oriented=blockKey(id,(meta&12)|((heading+2)&3));
    if (biblio.models[oriented]) return oriented;
  }
  return key;
}

export function orientFurnitureObject(key,object,position,{yaw,against},models) {
  const [id,meta]=blockState(key);
  if (yaw===undefined || !against) return object;
  const heading=placementHeading(yaw);
  const angle=models?.biblio?.models?.[key] && angleFields[id-2248];
  if (angle) {
    const type=object?.type??`${angle.slice(0,-5)}Tile`;
    return {...object,type,position,key:`tile:${position.join(':')}`,data:{...object?.data,
      [angle]:[1,0,3,2][heading]+(id===2255 && (meta&4)?4:0)}};
  }
  if (id===751 || id===761 || id===763 || id===766 || id===767) {
    return {...object,type:object?.type??'RedPowerMachine',position,key:`tile:${position.join(':')}`,
      data:{...object?.data,rot:[2,1,0,3][heading]}};
  }
  return object;
}
