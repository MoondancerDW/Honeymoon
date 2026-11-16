import {randomUUID} from 'node:crypto';
import {RequestError} from './errors.mjs';

const moduleName = 'warps';
const stateKey = 'public';
const validId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function createWarps(store) {
  const list = () => store.getState(moduleName,'',stateKey)?.value ?? {revision:0,warps:[]};
  const change = update => store.atomic(()=>{
    const previous = list();
    const next = {revision:previous.revision+1,warps:update(previous.warps)};
    store.putState(moduleName,'',stateKey,1,next);
    return next;
  });
  function find(warps,id) {
    if (typeof id !== 'string' || !validId.test(id)) throw new RequestError(400,'invalid_warp');
    const warp = warps.find(warp=>warp.id === id);
    if (!warp) throw new RequestError(404,'warp_missing');
    return warp;
  }
  return {
    list,
    get: id => find(list().warps,id),
    add(title,position) {
      if (typeof title !== 'string' || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(title)) throw new RequestError(400,'invalid_warp_title');
      title = title.normalize('NFC').trim();
      if (!title || title.length > 64) throw new RequestError(400,'invalid_warp_title');
      return change(warps=>[...warps,{id:randomUUID(),title,position}]);
    },
    remove(id) {
      return change(warps=>{
        const warp = find(warps,id);
        return warps.filter(candidate=>candidate !== warp);
      });
    },
  };
}
