import {clockTick, dayTicks} from '../world/world-time.mjs';
import {RequestError} from './errors.mjs';
import {isWeather} from '../world/weather.mjs';

export function createWorldTime(store, now = Date.now) {
  const saved = store.getState('world-time', '', 'clock')?.value;
  const savedWeather = store.getState('world-time', '', 'weather')?.value?.mode;
  let weather = isWeather(savedWeather) ? savedWeather : 'clear';
  let state = {tick:saved?.tick ?? 6000, frozen:saved?.frozen ?? false, at:now()};
  const snapshot = () => ({tick:clockTick(state, now() - state.at), frozen:state.frozen});
  return {
    snapshot,
    weather: () => weather,
    setWeather(mode) {
      if (!isWeather(mode)) throw new RequestError(400,'invalid_weather');
      store.putState('world-time','','weather',1,{mode});
      weather = mode;
      return weather;
    },
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
