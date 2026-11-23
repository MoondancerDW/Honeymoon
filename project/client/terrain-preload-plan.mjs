import {altitudeAssetUrl,altitudeFiles} from './altitude-assets.mjs';

export function planTerrainPreload({manifest,build,lowDevice},available,limits) {
  const {lod,vista}=manifest;
  const tiles=(directory,hash,regions,suffix)=>regions.map(pair=>`/generated/${directory}/${hash}/${pair.join('.')}${suffix}`);
  const candidates=[
    vista && {layer:'altitude',paths:altitudeFiles.map(path=>altitudeAssetUrl(path,build))},
    !lowDevice && lod?.maxDistance>=32 && {layer:'primitive',hash:lod.contentHash,paths:tiles('lod',lod.contentHash,lod.regions,'.outer.bin')},
    vista && {layer:'vista',hash:vista.hash,paths:tiles('vista',vista.hash,vista.regions,'.bin')},
    !lowDevice && lod && {layer:'simplified',hash:lod.contentHash,paths:tiles('lod',lod.contentHash,lod.regions,'.bin')},
  ].filter(Boolean);
  const layers=[], skipped=[], unavailable=[];
  for (const candidate of candidates) {
    const {layer,hash,paths}=candidate;
    const entry=available?.[layer];
    if (!entry || (hash!==undefined && entry.hash!==hash) || !Number.isSafeInteger(entry.bytes) || entry.bytes<1 ||
        !paths.length || entry.count!==paths.length || new Set(paths).size!==paths.length) {
      unavailable.push(layer);
      continue;
    }
    const {maxBytes,maxEntries}=limits[layer];
    if (entry.bytes>maxBytes || entry.count>maxEntries) skipped.push(layer);
    else layers.push({...candidate,bytes:entry.bytes,count:entry.count});
  }
  return {layers,skipped,unavailable};
}
