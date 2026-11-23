import {RequestError} from './errors.mjs';
import {movementEffect} from '../world/held-consumables.mjs';

export const healthCells=10;
const modes=new Set(['game','creative']);
const scope='player-mode';
const recoveryMs=5000;
const strikeMs=450;

export function createSurvival(store,initialMode,{now=Date.now,healthLimit=()=>healthCells}={}) {
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
      const limit=saved?.maxHealth??(saved ? healthCells : healthLimit(player));
      status={health:Math.max(0,Math.min(limit,saved?.health??limit)), maxHealth:limit,
        death:saved?.death??null,recoverAt:now()+recoveryMs,effects:{...saved?.effects}};
      states.set(player,status);
    }
    const limit=healthLimit(player);
    if (status.maxHealth!==limit) {
      status.health=status.health/status.maxHealth*limit;
      status.maxHealth=limit;
    }
    return status;
  }
  const status=player=>{
    const {health,maxHealth,death,effects}=record(player);
    const active=Object.fromEntries(Object.entries(effects).filter(([,effect])=>effect.until>now())
      .map(([id,{amplifier,until}])=>[id,{amplifier,until}]));
    return {mode:mode(player),health:health===0 ? 0 : Math.ceil(health-1e-9),maxHealth,death,
      ...(Object.keys(active).length && {effects:active})};
  };
  function effect(player,id) {
    const entry=record(player).effects[id];
    return entry?.until>now() ? entry : undefined;
  }
  const dead=player=>isGame(player)&&Boolean(record(player).death);
  function save(player,state) {
    const {health,maxHealth,death,effects}=state;
    store.putState(scope,player,'health',1,{health,maxHealth,death,...(Object.keys(effects).length&&{effects})});
    return status(player);
  }
  function damage(player,amount,point,floor,cause) {
    if (!isGame(player)||dead(player)||!Number.isFinite(amount)||amount<1) return;
    if (['lava','fire'].includes(cause)&&effect(player,'fireResistance')) return;
    const state=record(player);
    state.health=Math.max(0,state.health-Math.floor(amount));
    state.recoverAt=now()+recoveryMs;
    if (state.health<1e-9) {
      state.health=0;
      state.death={at:now(),position:point,floor,...(cause&&{cause})};
      state.effects={};
    }
    return save(player,state);
  }
  function heal(player,amount=Infinity) {
    if (!isGame(player)||dead(player)||!(amount>0)) return;
    const state=record(player);
    if (state.health===state.maxHealth) return;
    state.health=Math.min(state.maxHealth,state.health+amount);
    state.recoverAt=now()+recoveryMs;
    return save(player,state);
  }

  function clearEffects(player) {
    const state=record(player);
    if (!Object.keys(state.effects).length) return;
    state.effects={};
    return save(player,state);
  }

  function applyEffect(player,profile,strength=1,harm) {
    if (dead(player)||!profile.effect||!Number.isFinite(strength)||strength<=0) return;
    const {effect:id,amplifier,duration}=profile;
    if (id==='healing') return heal(player,Math.round((4<<amplifier)*strength));
    if (id==='harming') return harm?.(player,Math.round((6<<amplifier)*strength),'potion');
    const state=record(player), old=effect(player,id), time=now();
    const until=time+Math.round(duration*strength);
    if (until<=time || old && (old.amplifier>amplifier || old.amplifier===amplifier&&old.until>=until)) return;
    const interval=id==='poison'?1250:id==='regeneration'?2500:0;
    state.effects[id]={amplifier,until,...(interval&&{next:time+(interval>>amplifier)})};
    return save(player,state);
  }

  function meleeModifier(player) {
    const strong=effect(player,'strength'), weak=effect(player,'weakness');
    return (strong ? 3*(strong.amplifier+1):0)-(weak ? 2*(weak.amplifier+1):0);
  }
  function reset(player) {
    falling.delete(player);
    const state=record(player);
    state.health=state.maxHealth;
    state.death=null;
    state.effects={};
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
      const state=record(player);
      let changed=false;
      if (isGame(player)&&!state.death&&state.health<state.maxHealth&&time>=state.recoverAt) {
        state.health=Math.min(state.health+1,state.maxHealth);
        state.recoverAt=time+recoveryMs;
        changed=true;
      }
      for (const [id,item] of Object.entries(state.effects)) {
        if (item.next<=time && item.next<item.until) {
          const interval=(id==='poison'?1250:2500)>>item.amplifier;
          const pulses=1+Math.floor((Math.min(time,item.until-1)-item.next)/interval);
          if (isGame(player)&&!state.death) state.health=id==='poison' ? Math.max(1,state.health-pulses) :
            Math.min(state.maxHealth,state.health+pulses);
          item.next+=pulses*interval;
          changed=true;
        }
        if (item.until<=time) {delete state.effects[id];changed=true;}
      }
      if (changed) emit(player,save(player,state));
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
    effect,applyEffect,clearEffects,meleeModifier,movementScale:player=>movementEffect(status(player).effects),
    canStrike,observe,tick,setMode,avatarDeath:player=>initialMode!==undefined&&dead(player)?status(player).death:null,
    clearFall:player=>falling.delete(player)};
}
