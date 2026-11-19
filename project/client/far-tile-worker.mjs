import {decodeFarTile} from './far-tile-format.mjs';
import {decodeVista} from './vista-format.mjs';
import {lodBoundaryHeights} from './vista-stitch.mjs';
import {readTerrain} from './terrain-cache.mjs';

const active = new Map();
self.onmessage = async ({data:{id, url, vista, coarse, persistentTerrain}}) => {
  if (!url) {
    active.get(id)?.abort();
    return;
  }
  const controller = new AbortController();
  active.set(id, controller);
  try {
    const signal=AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]);
    const tile = await readTerrain(url,{priority:'low',signal},persistentTerrain,async response=>{
      if (!response.ok) throw new Error(`Far terrain tile returned ${response.status}`);
      const buffer=await response.arrayBuffer();
      return vista ? decodeVista(buffer,coarse,!coarse) : decodeFarTile(buffer);
    });
    if (controller.signal.aborted) return;
    const buffers = tile.layers.flatMap(({offset,span,surface,light,color}) =>
      [offset.buffer,span.buffer,surface.buffer,light.buffer,color.buffer]);
    if (!vista) {
      tile.boundary = lodBoundaryHeights(tile.layers[0]);
      buffers.push(tile.boundary.buffer);
    }
    self.postMessage({id,tile}, [tile.counts.buffer,...buffers]);
  } catch (error) {
    if (!controller.signal.aborted) self.postMessage({id,error:error.message});
  } finally {
    active.delete(id);
  }
};
