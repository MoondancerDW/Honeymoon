import {decodeFarTile} from './far-tile-format.mjs';

const active = new Map();
self.onmessage = async ({data:{id, url}}) => {
  if (!url) {
    active.get(id)?.abort();
    return;
  }
  const controller = new AbortController();
  active.set(id, controller);
  try {
    const response = await fetch(url, {priority:'low', signal:AbortSignal.any([controller.signal, AbortSignal.timeout(12000)])});
    if (!response.ok) throw new Error(`Far terrain tile returned ${response.status}`);
    const tile = decodeFarTile(await response.arrayBuffer());
    if (controller.signal.aborted) return;
    const buffers = tile.layers.flatMap(({offset,span,surface,light,color}) =>
      [offset.buffer,span.buffer,surface.buffer,light.buffer,color.buffer]);
    self.postMessage({id,tile}, [tile.counts.buffer,...buffers]);
  } catch (error) {
    if (!controller.signal.aborted) self.postMessage({id,error:error.message});
  } finally {
    active.delete(id);
  }
};
