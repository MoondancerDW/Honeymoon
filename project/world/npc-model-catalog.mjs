const modelAssetRoot='/generated/npcs/';

export const npcModelCatalog=Object.freeze([
  {id:'npcpony',label:'Пони',category:'Custom NPCs',defaultTexture:'/mob/bpony_0.png'},
  {id:'npchumanmale',label:'Человек',category:'Custom NPCs',defaultTexture:'/mob/humanmale/Steve.png'},
]);

let manifest;
export function loadNpcModelManifest() {
  if (!manifest) manifest=fetch(modelAssetRoot+'models.json').then(async response=>{
    if (!response.ok) throw new Error('NPC model catalogue is unavailable');
    return response.json();
  }).catch(error=>{manifest=undefined;throw error;});
  return manifest;
}
export async function loadNpcModelCatalog() {
  return (await loadNpcModelManifest()).catalog;
}
export function npcSkinUrl(path) {
  if (typeof path!=='string') return null;
  const segments=path.replace(/^\//,'').split('/');
  if (!['mob','twilightforest','mods','item'].includes(segments[0]) || !/\.png$/i.test(segments.at(-1)) ||
      segments.some(segment=>!segment || segment==='.' || segment==='..' || /[:\\]/.test(segment))) return null;
  return modelAssetRoot+'skins/'+segments.map(encodeURIComponent).join('/');
}
