import {consumableProfile} from '../world/held-consumables.mjs';
import {stackRevision} from '../world/item-text.mjs';
import {RequestError} from './errors.mjs';

const bow='creative:261:0', arrow='creative:262:0';
const drawMs=1000;
const step=.05;

function aim(look) {
  if (!Array.isArray(look)||look.length!==3||!look.every(Number.isFinite)) throw new RequestError(400,'invalid_aim');
  const length=Math.hypot(...look);
  if (Math.abs(length-1)>.01) throw new RequestError(400,'invalid_aim');
  return look.map(value=>value/length);
}

function hitTime(from,to,{x,y,z,height,halfWidth}) {
  const mins=[x-halfWidth,y,z-halfWidth], maxs=[x+halfWidth,y+height,z+halfWidth];
  let first=0,last=1;
  for (let axis=0;axis<3;axis++) {
    const delta=to[axis]-from[axis];
    if (Math.abs(delta)<1e-9) {
      if (from[axis]<mins[axis]||from[axis]>maxs[axis]) return Infinity;
      continue;
    }
    const a=(mins[axis]-from[axis])/delta,b=(maxs[axis]-from[axis])/delta;
    first=Math.max(first,Math.min(a,b));
    last=Math.min(last,Math.max(a,b));
    if (first>last) return Infinity;
  }
  return first;
}

const pointAt=(from,to,time)=>from.map((value,axis)=>value+(to[axis]-value)*time);

export function traceItemFlight(origin,direction,{speed,gravity,targets,visible}) {
  const points=[origin];
  let from=origin, velocity=direction.map(value=>value*speed);
  for (let i=0;i<60;i++) {
    const to=from.map((value,axis)=>value+velocity[axis]*step);
    let closest=Infinity, target;
    for (const body of targets) {
      const time=hitTime(from,to,body);
      if (time<closest) {closest=time;target=body.id;}
    }
    if (target!==undefined) {
      const point=pointAt(from,to,closest);
      if (visible(from,point)) return {points:[...points,point],target};
    }
    if (!visible(from,to)) {
      let low=0,high=1;
      for (let attempt=0;attempt<8;attempt++) {
        const mid=(low+high)/2;
        if (visible(from,pointAt(from,to,mid))) low=mid; else high=mid;
      }
      return {points:[...points,pointAt(from,to,low)],block:true};
    }
    points.push(to);
    from=to;
    velocity=velocity.map((value,axis)=>value*.99-(axis===1?gravity*step:0));
  }
  return {points};
}

export function createHeldItems({inventory,survival,clock,eye,body,visible,canUse,damage,changed}) {
  const drawing=new Map(), lastUse=new Map();
  const canConsume=player=>survival.isGame(player);
  const availableArrow=player=>inventory.read(player).slots.findIndex(stack=>stack?.key===arrow);

  function consume(player,profile) {
    if (!canConsume(player)) return inventory.read(player);
    return profile.remaining ? inventory.replaceSelectedOne(player,profile.remaining) : inventory.take(player,false).inventory;
  }

  function apply(player,profile,strength=1) {
    const heal=profile.heal && survival.heal(player,profile.heal);
    const cleared=profile.kind==='milk' && survival.clearEffects(player);
    const effect=survival.applyEffect(player,profile,strength,damage);
    if (profile.effect!=='harming' && (effect||cleared||heal)) changed?.(player,survival.status(player));
  }

  function use(player,input,onlinePlayers,ranged) {
    const type=input?.type;
    const now=clock();
    if (type==='cancel') {drawing.delete(player);return {};}
    canUse(player);
    const state=inventory.read(player), stack=state.slots[state.selected];
    if (type==='bow-start') {
      if (stack?.key!==bow) throw new RequestError(409,'held_item_changed');
      if (canConsume(player) && availableArrow(player)<0) throw new RequestError(409,'arrows_required');
      drawing.set(player,{at:now,slot:state.selected,revision:stackRevision(stack)});
      return {drawing:true};
    }
    const shot=drawing.get(player);
    drawing.delete(player);
    let profile, fraction=0;
    if (type==='bow-release') {
      if (!shot || stack?.key!==bow || shot.slot!==state.selected || shot.revision!==stackRevision(stack) || now-shot.at>30000) {
        throw new RequestError(409,'held_item_changed');
      }
      const held=Math.min(1,(now-shot.at)/drawMs);
      if (held<.15) return {};
      fraction=(held*held+held*2)/3;
    } else if (type==='consume') {
      profile=consumableProfile(stack);
      if (!profile) throw new RequestError(409,'not_consumable');
      if (input.key!==stack.key) throw new RequestError(409,'held_item_changed');
      if (profile.kind==='food'&&!profile.effect&&canConsume(player)&&survival.status(player).health>=survival.status(player).maxHealth) {
        throw new RequestError(409,'full_health');
      }
    } else throw new RequestError(400,'invalid_held_action');

    const projectile=type==='bow-release'||profile.splash;
    const direction=projectile&&aim(input.look);
    if (now<(lastUse.get(player)??-Infinity)) throw new RequestError(429,'item_use_cooldown');
    lastUse.set(player,now+450);
    if (!projectile) {
      const current=consume(player,profile);
      apply(player,profile);
      return {inventory:current,used:profile.kind};
    }

    const origin=eye(player);
    const targets=onlinePlayers.filter(id=>id!==player && survival.isGame(id)&&!survival.dead(id)).map(body);
    if (!profile && ranged) targets.push(...ranged.targets());
    const flight=traceItemFlight(origin,direction,{speed:profile?13:46*fraction,gravity:profile?15:18,targets,visible});
    const kind=profile?'splash':'arrow';
    if (!profile) {
      const slot=availableArrow(player);
      if (canConsume(player)&&slot<0) throw new RequestError(409,'arrows_required');
      if (canConsume(player)) inventory.take(player,{slot,count:1});
      const amount=Math.max(1,Math.round(8*fraction));
      if (flight.target?.npc!==undefined) ranged.hit(flight.target.npc,amount);
      else if (flight.target!==undefined) damage(flight.target,amount,'arrow');
      return {inventory:inventory.read(player),projectile:{kind,points:flight.points}};
    }

    const current=consume(player,profile), impact=flight.points.at(-1);
    for (const id of onlinePlayers) {
      const {x,y,z,height}=body(id);
      const distance=Math.hypot(impact[0]-x,impact[1]-y-height/2,impact[2]-z);
      if (distance<4) apply(id,profile,id===flight.target?1:1-distance/4);
    }
    return {inventory:current,projectile:{kind,points:flight.points}};
  }

  return {use,cancel:player=>drawing.delete(player)};
}
