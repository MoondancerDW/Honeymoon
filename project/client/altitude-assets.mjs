import {readTerrain} from './terrain-cache.mjs';

const heights='/altitude-heights.png';
const colors='/altitude-colors.webp';
const detail='/altitude-detail.webp';
const landmarks='/altitude-landmark-data.mjs';
export const altitudeFiles=Object.freeze([heights,colors,detail,landmarks]);
export const altitudeAssetUrl=(path,build)=>path+'?build='+build;

export function altitudeLandmarkPayload(text) {
  const payload=/^export default "([A-Za-z0-9+/=]+)";\s*$/m.exec(text)?.[1];
  if (!payload) throw new Error('Invalid altitude landmarks');
  return payload;
}

export async function verifyAltitudeAsset(url,response) {
  if (!response.ok) throw new Error('Altitude asset returned '+response.status);
  const blob=await response.blob();
  if (url.startsWith(landmarks)) {
    altitudeLandmarkPayload(await blob.text());
  } else {
    const header=new Uint8Array(await blob.slice(0,12).arrayBuffer());
    const signature=String.fromCharCode(...header);
    if (url.startsWith(heights) ? !signature.startsWith('\x89PNG\r\n\x1a\n') :
        !signature.startsWith('RIFF') || signature.slice(8)!=='WEBP') throw new Error('Invalid altitude image');
  }
  return blob;
}

export async function loadAltitudeImage(path,build,persistent,loader) {
  if (!persistent) return loader.loadAsync(path);
  const url=altitudeAssetUrl(path,build);
  return readTerrain(url,{priority:'low'},true,async response=>{
    const source=URL.createObjectURL(await verifyAltitudeAsset(url,response));
    try {return await loader.loadAsync(source);}
    finally {URL.revokeObjectURL(source);}
  });
}
