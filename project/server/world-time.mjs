import {clockTick, dayTicks} from '../world/world-time.mjs';
import {RequestError} from './errors.mjs';
import {isWeather} from '../world/weather.mjs';

const minute=60_000;
const weatherPhases={
  clear:{mode:'clear',minutes:[15,35]},
  gathering:{mode:'cloudy',minutes:[2,5]},
  rain:{mode:'rain',minutes:[5,12]},
  snow:{mode:'snow',minutes:[5,12]},
  clearing:{mode:'cloudy',minutes:[1,3]},
};
const initialPhase={clear:'clear',cloudy:'gathering',rain:'rain',snow:'snow'};

export function createWorldTime(store, now = Date.now, random = Math.random) {
  const saved = store.getState('world-time', '', 'clock')?.value;
  const savedWeather = store.getState('world-time', '', 'weather')?.value;
  const mode=isWeather(savedWeather?.mode)?savedWeather.mode:'clear';
  const phase=weatherPhases[savedWeather?.phase]?.mode===mode?savedWeather.phase:initialPhase[mode];
  const dynamic=savedWeather?.dynamic===true;
  function phaseEnd(phase,at) {
    const [min,max]=weatherPhases[phase].minutes;
    return Math.trunc(at+(min+(max-min)*random())*minute);
  }
  let conditions={mode,dynamic,phase,nextChangeAt:dynamic?
    (Number.isSafeInteger(savedWeather.nextChangeAt)&&savedWeather.nextChangeAt>0?savedWeather.nextChangeAt:phaseEnd(phase,now())):null};
  let state = {tick:saved?.tick ?? 6000, frozen:saved?.frozen ?? false, at:now()};
  const snapshot = () => ({tick:clockTick(state, now() - state.at), frozen:state.frozen});
  const weatherSettings=()=>{
    const {mode,dynamic,nextChangeAt}=conditions;
    return {mode,dynamic,nextChangeAt};
  };
  function applyWeather(mode,dynamic,phase,nextChangeAt) {
    const next={mode,dynamic,phase,nextChangeAt};
    if (Object.keys(next).every(key=>next[key]===conditions[key])) return;
    store.putState('world-time','','weather',2,next);
    conditions=next;
  }
  return {
    snapshot,
    weather: () => conditions.mode,
    weatherSettings,
    setWeather({mode,dynamic}={}) {
      if ((mode===undefined&&dynamic===undefined)||(mode!==undefined&&!isWeather(mode))) {
        throw new RequestError(400,'invalid_weather');
      }
      if (dynamic!==undefined&&typeof dynamic!=='boolean') throw new RequestError(400,'invalid_weather');
      const nextMode=mode??conditions.mode;
      const nextDynamic=dynamic??conditions.dynamic;
      const nextPhase=mode===undefined?conditions.phase:initialPhase[nextMode];
      const keepDeadline=conditions.dynamic&&mode===undefined;
      const when=nextDynamic?(keepDeadline?conditions.nextChangeAt:phaseEnd(nextPhase,now())):null;
      applyWeather(nextMode,nextDynamic,nextPhase,when);
      return weatherSettings();
    },
    advanceWeather() {
      if (!conditions.dynamic) return;
      const at=now();
      if (at<conditions.nextChangeAt) return;
      const nextPhase=conditions.phase==='clear'?'gathering':conditions.phase==='gathering'?(random()<.65?'rain':'clear'):
        conditions.phase==='clearing'?'clear':'clearing';
      applyWeather(weatherPhases[nextPhase].mode,true,nextPhase,phaseEnd(nextPhase,at));
      return weatherSettings();
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
