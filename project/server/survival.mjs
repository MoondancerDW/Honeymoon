import {RequestError} from './errors.mjs';

export const healthCells=10;
const modes=new Set(['game','creative']);
const scope='player-mode';
const recoveryMs=5000;
const strikeMs=450;

export function createSurvival(store,initialMode,{now=Date.now}={}) {
  if (initialMode!==undefined && !modes.has(initialMode)) throw new TypeError('Unknown initial game mode');
  const states=new Map(),falling=new Map(),strikes=new Map();
  const defaultMode=()=>store.getState(scope,'','default')?.value??initialMode??'creative';
  const override=player=>store.getState(scope,player,'mode')?.value??null;
  const mode=player=>override(player)??defaultMode();
  const isGame=player=>mode(player)==='game';
  function record(player) {
    let status=states.get(player);
    if (!status) {
      const saved=store.getState(scope,player,'health')?.value;
      status={health:saved?.health??healthCells,death:saved?.death??null,recoverAt:now()+recoveryMs};
      states.set(player,status);
    }
    return status;
  }
  const status=player=>{
    const {health,death}=record(player);
    return {mode:mode(player),health,death};
  };
  const dead=player=>isGame(player)&&Boolean(record(player).death);
  function save(player,state) {
    const {health,death}=state;
    store.putState(scope,player,'health',1,{health,death});
    return status(player);
  }
  function damage(player,amount,point,floor) {
    if (!isGame(player)||dead(player)||!Number.isFinite(amount)||amount<1) return;
    const state=record(player);
    state.health=Math.max(0,state.health-Math.floor(amount));
    state.recoverAt=now()+recoveryMs;
    if (state.health===0) state.death={at:now(),position:point,floor};
    return save(player,state);
  }
  function heal(player,amount=healthCells) {
    if (!isGame(player)||dead(player)||record(player).health===healthCells) return;
    const state=record(player);
    state.health=Math.min(healthCells,state.health+amount);
    state.recoverAt=now()+recoveryMs;
    return save(player,state);
  }
  function reset(player) {
    falling.delete(player);
    const state=record(player);
    state.health=healthCells;
    state.death=null;
    state.recoverAt=now()+recoveryMs;
    return save(player,state);
  }
  function canStrike(player) {
    const time=now();
    if (time<(strikes.get(player)??0)) return false;
    strikes.set(player,time+strikeMs);
    return true;
  }
  function observe(player,previous,position,{grounded,protectedFall}) {
    if (!isGame(player)||protectedFall||dead(player)) {
      falling.delete(player);
      return 0;
    }
    const highest=Math.max(falling.get(player)??previous.y,previous.y,position.y);
    if (!grounded) {
      falling.set(player,highest);
      return 0;
    }
    falling.delete(player);
    return Math.max(0,Math.ceil(highest-position.y-3-.001));
  }
  function tick(players,emit) {
    const time=now();
    for (const player of players) {
      if (!isGame(player)) continue;
      const state=record(player);
      if (state.death||state.health>=healthCells||time<state.recoverAt) continue;
      state.health++;
      state.recoverAt=time+recoveryMs;
      emit(player,save(player,state));
    }
  }
  function setMode(player,value) {
    if (!modes.has(value)&&!(player&&value===null)) throw new RequestError(400,'invalid_game_mode');
    if (player) {
      store.putState(scope,player,'mode',1,value);
      if (!isGame(player)) reset(player);
    } else store.putState(scope,'','default',1,value);
  }
  return {enabled:initialMode!==undefined,defaultMode,override,mode,isGame,dead,status,damage,heal,reset,
    canStrike,observe,tick,setMode,avatarDeath:player=>initialMode!==undefined&&dead(player)?status(player).death:null,
    clearFall:player=>falling.delete(player)};
}
