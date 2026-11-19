import {rasterFarMap,rasterVistaMap} from './altitude-map-raster.mjs';
import {readTerrain} from './terrain-cache.mjs';

const active=new Map();
let palette;
self.onmessage=async ({data:{id,url,vista,cancel,colors,persistentTerrain}})=>{
  if (colors) {
    palette=colors;
    return;
  }
  if (cancel) {
    active.get(id)?.abort();
    return;
  }
  const controller=new AbortController();
  active.set(id,controller);
  try {
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(12000)]);
    const {pixels,size}=await readTerrain(url,{priority:'low',signal},persistentTerrain,async response=>{
      if (!response.ok) throw new Error(`Map tile returned ${response.status}`);
      const buffer=await response.arrayBuffer();
      return vista ? rasterVistaMap(buffer,palette) : rasterFarMap(buffer,palette);
    });
    self.postMessage({id,pixels,size},[pixels.buffer]);
  } catch {
    self.postMessage({id,retry:!controller.signal.aborted});
  } finally {
    active.delete(id);
  }
};
