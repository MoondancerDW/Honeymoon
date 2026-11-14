import {clockTick, dayTicks} from '../world/world-time.mjs';
import {RequestError} from './errors.mjs';

export function createWorldTime(store, now = Date.now) {
  const saved = store.getState('world-time', '', 'clock')?.value;
  let state = {tick:saved?.tick ?? 6000, frozen:saved?.frozen ?? false, at:now()};
  const snapshot = () => ({tick:clockTick(state, now() - state.at), frozen:state.frozen});
  return {
    snapshot,
    set({tick, frozen}) {
      if (tick === undefined && frozen === undefined ||
          tick !== undefined && (!Number.isSafeInteger(tick) || tick < 0 || tick >= dayTicks) ||
          frozen !== undefined && typeof frozen !== 'boolean') throw new RequestError(400, 'invalid_world_time');
      const next = {tick:tick ?? snapshot().tick, frozen:frozen ?? state.frozen};
      store.putState('world-time', '', 'clock', 1, next);
      state = {...next, at:now()};
      return snapshot();
    },
  };
}
