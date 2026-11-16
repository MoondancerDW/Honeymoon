import {randomUUID} from 'node:crypto';
import {displayEntity} from './base.mjs';
import {RequestError} from './errors.mjs';
import {fluidCurrent,liquidLevel} from '../world/block-movement.mjs';
import {blockState} from '../world/block-interactions.mjs';
import {boatHeading,isRideableBoat} from '../world/boats.mjs';

const maxBoats = 128;
const maxSpeed = 6;
const historyTime = 300;
const stateModule = 'boats';
const yawDegrees = radians => radians * 180 / Math.PI;
const angle = radians => Math.atan2(Math.sin(radians),Math.cos(radians));

export function createBoats({base,store,clock,cellAt,canMove}) {
  const boats = new Map((store.getState(stateModule,'world','entities')?.value ?? [])
    .filter(record => isRideableBoat(record.entity) && base.inBounds(...record.entity.position.map(Math.floor)))
    .map(record => [record.entity.key,record]));
  const histories = new Map(), controls = new Map(), originals = new Map();
  let lastTick = clock(), lastSave = lastTick, changed = false, dirty = false;

  function water(x,y,z) {
    const cell = cellAt(x,y,z);
    const level = liquidLevel(cell?.cell);
    return level !== null && blockState(cell)[1] >= 8 ? 1 : level;
  }

  function surface(x,y,z) {
    const bx = Math.floor(x), bz = Math.floor(z);
    const center = Math.floor(y);
    for (let yy = center + 1; yy >= center - 1; yy--) {
      const height = water(bx,yy,bz);
      if (height !== null && water(bx,yy+1,bz) === null && Math.abs(yy + height - y) <= .55) return yy + height;
    }
    return null;
  }

  function occupied(entity) {
    const [x,y,z] = entity.position;
    const overlaps = other => other.key !== entity.key && Math.abs(other.position[1]-y) < .55 &&
      Math.hypot(other.position[0]-x,other.position[2]-z) < 1.32;
    if ([...boats.values()].some(record => overlaps(record.entity))) return true;
    for (let cz = Math.floor((z-1.4)/16); cz <= Math.floor((z+1.4)/16); cz++) {
      for (let cx = Math.floor((x-1.4)/16); cx <= Math.floor((x+1.4)/16); cx++) {
        const key = cx + ',' + cz;
        if (!originals.has(key)) {
          if (originals.size >= 64) originals.delete(originals.keys().next().value);
          originals.set(key,(base.publicChunk?.(cx,cz)?.entities ?? []).filter(isRideableBoat));
        }
        if (originals.get(key).some(other => !boats.has(other.key) && overlaps(other))) return true;
      }
    }
    return false;
  }

  function save(records = boats) {
    store.putState(stateModule,'world','entities',1,[...records.values()]);
  }

  function place({x,y,z,yaw = 0}) {
    if (boats.size >= maxBoats) throw new RequestError(409,'boat_limit');
    const height = water(x,y,z);
    if (height === null || water(x,y+1,z) !== null) throw new RequestError(409,'boat_requires_water');
    const entity = {type:'Boat',key:'boat:' + randomUUID(),position:[x+.5,y+height,z+.5],
      data:{Rotation:[yawDegrees(yaw),0]}};
    if (occupied(entity) || !canMove(entity)) throw new RequestError(409,'occupied');
    const boat = {entity,speed:0,placed:true};
    save(new Map(boats).set(entity.key,boat));
    return boat;
  }

  function remove(key) {
    if (!boats.get(key)?.placed) throw new RequestError(403,'protected_cell');
    const state = new Map(boats);
    state.delete(key);
    save(state);
  }

  function current(x,z,key) {
    const record = boats.get(key);
    if (record) return record.entity;
    const original = base.getEntity?.(x,z,key);
    return isRideableBoat(original) ? displayEntity(original) : null;
  }

  function board(entity) {
    if (boats.has(entity.key) || boats.size >= maxBoats) return;
    boats.set(entity.key,{entity,speed:0,placed:false});
    changed = dirty = true;
  }

  function recent(entity) {
    const previous = (histories.get(entity.key) ?? []).filter(sample => sample.at >= clock() - historyTime)
      .map(sample => sample.entity);
    const all = [...previous,entity];
    return all.flatMap((to,index) => {
      const from = all[index-1];
      if (!from) return [to];
      const yaw = boatHeading(from), delta = angle(boatHeading(to)-yaw);
      return [.33,.67,1].map(t => ({...to,
        position:to.position.map((value,axis) => from.position[axis]+(value-from.position[axis])*t),
        data:{Rotation:[yawDegrees(yaw+delta*t),0]},
      }));
    });
  }

  function steering(key, drive) {
    if (!drive || drive.every(value => value === 0)) controls.delete(key);
    else controls.set(key,{drive,expires:clock()+450});
  }

  function advance(riders,updateRider) {
    const now = clock();
    const seconds = Math.max(0,Math.min((now-lastTick)/1000,.12));
    lastTick = now;
    if (!seconds) return false;
    for (const [key,record] of boats) {
      const {entity,speed} = record;
      const rider = riders.get(key), control = controls.get(key);
      const [throttle,turn] = control?.expires >= now && rider ? control.drive : [0,0];
      const [x,y,z] = entity.position;
      const level = surface(x,y,z);
      if (level === null) {
        if (rider) { updateRider(rider.player,null); changed = true; }
        if (speed) { record.speed = 0; dirty = true; }
        continue;
      }
      let nextSpeed = (speed+throttle*8*seconds) * .93 ** (seconds/.05);
      nextSpeed = Math.max(-maxSpeed*.55,Math.min(maxSpeed,nextSpeed));
      if (Math.abs(nextSpeed) < .025) nextSpeed = 0;
      const [flowX,,flowZ]=fluidCurrent(cellAt,x,level-.35,z,'water');
      if (!nextSpeed && !turn && !flowX && !flowZ && y === level) {
        if (speed) { record.speed = 0; dirty = true; }
        continue;
      }
      const yaw = angle(boatHeading(entity)-turn*2.15*seconds);
      const nx = x + (flowX*.54-Math.sin(yaw)*nextSpeed)*seconds;
      const nz = z + (flowZ*.54-Math.cos(yaw)*nextSpeed)*seconds;
      const destination = surface(nx,y,nz);
      let next = {...entity,position:[nx,destination,nz],data:{Rotation:[yawDegrees(yaw),0]}};
      if (destination === null || occupied(next) || !canMove(next,rider)) {
        next = {...next,position:[x,level,z]};
        nextSpeed = 0;
        if (occupied(next) || !canMove(next,rider)) next = entity;
      }
      if (record.speed !== nextSpeed) { record.speed = nextSpeed; dirty = true; }
      if (next === entity || next.position.every((value,i) => value === entity.position[i]) &&
          next.data.Rotation[0] === entity.data.Rotation?.[0]) continue;
      const previous = (histories.get(key) ?? []).filter(sample => sample.at >= now-historyTime);
      histories.set(key,[...previous,{at:now,entity}]);
      record.entity = next;
      if (rider) updateRider(rider.player,next);
      changed = dirty = true;
    }
    if (dirty && now-lastSave >= 1000) { save(); lastSave = now; dirty = false; }
    const updated = changed;
    changed = false;
    return updated;
  }

  return {
    place,remove,current,board,recent,steering,advance,
    accept(placed,removed) {
      if (placed) boats.set(placed.entity.key,placed);
      if (removed) { boats.delete(removed); histories.delete(removed); controls.delete(removed); }
    },
    snapshot:() => [...boats.values()].map(record => record.entity),
    flush() { if (dirty) save(); },
  };
}
