import {blockKey,blockState} from './block-interactions.mjs';
import {containerSpec} from './containers.mjs';
import {placementFace,placementHeading} from './placement-heading.mjs';
import {redPowerBoardSpin} from './redpower-wires.mjs';

const jammyYawGroups = {
  200: [1,5],
  201: [0,4,8],
  203: [4],
  204: [0,4,8],
  205: [0,4,8],
  206: [0,4],
  207: [0,4,8,12],
  208: [0,4,8],
  211: [12],
  218: [0,4],
};
const jammyWallAngles = [undefined,undefined,0,2,3,1];
const biblioWallAngles = [undefined,undefined,1,3,0,2];
const biblioFields = {
  2248: 'deskAngle',
  2250: 'bookcaseAngle',
  2251: 'labelAngle',
  2252: 'potionshelfAngle',
  2253: 'rackAngle',
  2254: 'genericShelfAngle',
  2255: 'caseAngle',
};

function jammyWallGroup(id,meta) {
  if (id===200 && meta>=9 && meta<=12) return 9;
  if (id===203 && meta>=8) return meta&12;
  if (id>=209 && id<=212 && !(id===211 && meta>=12)) return meta&12;
}

export function orientModBlock(key,input,target,models) {
  const [id,meta]=blockState(key);
  const face=placementFace(target,input.against);
  if (face<0) return;
  if ((id===2163 || id===2176) && (meta&12)!==12) {
    return blockKey(id,(meta&3)|(face>=4?4:face>=2?8:0));
  }
  if (id===2174 || id>=2783 && id<=2785) {
    // Native horizontal head states and straight body states are separate variants.
    if (meta===12 || meta===13 || meta===14) return blockKey(id,face>=4?12:face>=2?13:14);
    if (meta<4) {
      if (face>=2) return blockKey(id,face-2);
      if (input.yaw!==undefined) return blockKey(id,[1,3,0,2][placementHeading(input.yaw)]);
    }
  }
  if (input.yaw===undefined) return;
  const heading=placementHeading(input.yaw);
  if (id===1526) return blockKey(id,(2-heading)&3);
  if (id===2249 && meta<4 && models?.biblio?.models?.[key]) return blockKey(id,(heading+2)&3);
  if (!models?.jammy?.models?.[key]) return;
  const group=jammyYawGroups[id]?.find(base=>meta>=base && meta<base+4);
  if (group===undefined) return;
  const oriented=blockKey(id,group+((2-heading)&3));
  if (models.jammy.models[oriented]) return oriented;
}

export function modWallPlacement(key,input,target,models) {
  if (!input.against) return;
  const [id,meta]=blockState(key);
  const face=placementFace(target,input.against);
  const group=models?.jammy?.models?.[key] ? jammyWallGroup(id,meta) : undefined;
  if (group!==undefined) {
    if (face<2) return {error:'invalid_mount_face'};
    const cell=blockKey(id,group+jammyWallAngles[face]);
    if (models.jammy.models[cell]) return {cell,requireSupport:face};
  }
  const biblioMount=models?.biblio?.models?.[key] && (id===2251 || id===2255);
  if (biblioMount || id===753) {
    if (face<0 || id===2251 && face<2 || id===2255 && face===0) return {error:'invalid_mount_face'};
    return {cell:key,requireSupport:face};
  }
}

function tileAt(key,object,position,fields,fallbackType) {
  return {...object,type:object?.type??containerSpec(key)?.type??fallbackType,position,
    key:`tile:${position.join(':')}`,data:{...object?.data,...fields}};
}

export function orientModObject(key,object,position,input,models) {
  if (!input.against) return object;
  const [id,meta]=blockState(key);
  const [x,y,z]=position;
  const face=placementFace({x,y,z},input.against);
  if (face<0) return object;
  const heading=input.yaw===undefined ? undefined : placementHeading(input.yaw);
  const field=models?.biblio?.models?.[key] && biblioFields[id];
  if (field) {
    if (face>=2 && (id===2251 || id===2255)) {
      const angle=biblioWallAngles[face]+(id===2255?4:0);
      return tileAt(key,object,position,{[field]:angle});
    }
    if (heading!==undefined) return tileAt(key,object,position,{[field]:(3-heading)&3});
  }
  if (id===753) {
    const mount=face^1;
    const spin=heading===undefined?0:redPowerBoardSpin(mount,input.yaw,input.pitch);
    return tileAt(key,object,position,{rot:(mount<<2)|spin},'RPLogic');
  }
  if (heading===undefined) return object;
  if (id>=3254 && id<=3256) return tileAt(key,object,position,{rot:heading},'mlb_cloudmachine');
  if (id===764 && meta===4) {
    const mount=face^1;
    return tileAt(key,object,position,{rot:(mount<<2)|redPowerBoardSpin(mount,input.yaw,input.pitch)},'RPXfmr');
  }
  if (id===751 && meta===2 || id===763 && meta!==6 && meta!==11 || id===764 && meta>=2 && meta<=3
      || id===766 && meta<2 || id===767) {
    const direction=input.pitch>Math.PI/3?1:input.pitch< -Math.PI/3?0:[2,4,3,5][heading];
    let rot=direction;
    if (id===763 && meta===7) rot=(direction<<2)|(direction<2?(heading+2)&3:0);
    if (id===764 && meta===3) rot^=1;
    return tileAt(key,object,position,{rot},'RedPowerMachine');
  }
  if (id===764 && meta===1) return tileAt(key,object,position,{rot:-heading&3},'RPPump');
  if (id>=760 && id<=762) return tileAt(key,object,position,{rot:(3-heading)&3},'RedPowerMachine');
  if (id===751 && meta<=5) return tileAt(key,object,position,{rot:(2-heading)&3},'RedPowerMachine');
  return object;
}
