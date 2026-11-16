import {randomUUID} from 'node:crypto';
import {displayEntity} from './base.mjs';
import {RequestError} from './errors.mjs';
import {isRideableMinecart, minecartRotation} from '../world/minecarts.mjs';
import {PLAYER} from '../world/player-body.mjs';
import {railFor, railPoint, railTangent} from '../world/rails.mjs';

const height = 3 / 8;
const maxSpeed = 8;
const maxCarts = 128;
const historyTime = 300;
const contactRadius = .54 + PLAYER.halfWidth;
const coordinates = ['x','y','z'];
const worldPoint = (track, local) => local.map((value, axis) => value + track[coordinates[axis]]);
const directionAt = (track, rail) => railTangent(rail, track.t).map(value => value * track.direction);
const degrees = rad => rad * 180 / Math.PI;
const sameEnd = (a,b) => a.every((value,index) => value === b[index]);

function onRail(entity, track, rail) {
  const position = worldPoint(track, railPoint(rail, track.t));
  position[1] += height;
  const [dx,dy,dz] = directionAt(track, rail);
  const yaw = Math.atan2(-dz,dx);
  const tilt = Math.atan2(dy,Math.hypot(dx,dz));
  return {...entity, position, data:{Type:0, Rotation:[180 - degrees(yaw), degrees(tilt)]}};
}

function adjoiningTrack(track, rail, exit, cellAt) {
  const end = rail.ends[exit];
  const point = worldPoint(track,end);
  const x = track.x + end[0] * 2 - 1;
  const z = track.z + end[2] * 2 - 1;
  for (const y of [point[1],point[1] - 1]) {
    const next = {x,y,z};
    const incoming = railFor(cellAt(x,y,z));
    const entry = incoming?.ends.findIndex(endpoint => sameEnd(worldPoint(next,endpoint),point)) ?? -1;
    if (entry >= 0) return {rail:incoming, track:{...next,t:entry,direction:track.direction * (entry === exit ? -1 : 1)}};
  }
  return null;
}

function alongTrack(track, rail, travel, cellAt) {
  while (true) {
    const t = track.t + travel * track.direction / rail.length;
    if (t >= 0 && t <= 1) return {track:{...track,t},rail,stopped:false};
    const exit = Number(t > 1);
    const next = adjoiningTrack(track,rail,exit,cellAt);
    if (!next) return {track:{...track,t:exit ? .98 : .02},rail,stopped:true};
    travel = (t - exit) * track.direction * rail.length;
    ({track,rail} = next);
  }
}

function degreeDelta(from,to) {
  const difference = (to - from + 180) % 360;
  return (difference < 0 ? difference + 360 : difference) - 180;
}

function walkingContact(from,to,[x,y,z],canTouch) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const distanceSquared = dx * dx + dz * dz;
  const offsetX = x - from.x, offsetZ = z - from.z;
  const approach = offsetX * dx + offsetZ * dz;
  if (distanceSquared < .000025 || approach <= 0) return null;
  const t = Math.min(1,approach / distanceSquared);
  const feet = [from.x + dx * t, from.y + (to.y - from.y) * t, from.z + dz * t];
  if (feet[1] >= y + .32 || feet[1] + PLAYER.height <= y - height ||
      Math.hypot(x - feet[0],z - feet[2]) >= contactRadius) return null;
  if (!canTouch([feet[0],Math.max(feet[1] + .04,y),feet[2]],[x,y,z])) return null;
  return [offsetX,offsetZ];
}

export function createMinecarts({base,store,clock,cellAt,solidAt,canMove,canTouch = () => true}) {
  const saved = store.getState('minecarts','world','entities');
  const carts = new Map((saved?.value ?? []).filter(cart => isRideableMinecart(cart.entity) &&
    base.inBounds(...cart.entity.position.map(Math.floor))).map(cart => [cart.entity.key,cart]));
  const originals = new Map();
  const history = new Map();
  const drivers = new Map();
  let changed = false;
  let dirty = false;
  let lastTick = clock();
  let lastSave = lastTick;

  function save(records = carts) {
    store.putState('minecarts','world','entities',1,[...records.values()]);
  }

  function candidateTrack(entity) {
    const [px,py,pz] = entity.position;
    const x = Math.floor(px), z = Math.floor(pz);
    for (let y = Math.floor(py); y >= Math.floor(py) - 1; y--) {
      const rail = railFor(cellAt(x,y,z));
      if (!rail) continue;
      let closest = Infinity, closestT = 0;
      for (let index = 0; index <= 16; index++) {
        const t = index / 16;
        const [rx,ry,rz] = worldPoint({x,y,z},railPoint(rail,t));
        const distance = Math.hypot(px-rx,py-ry-height,pz-rz);
        if (distance < closest) { closest = distance; closestT = t; }
      }
      if (closest > .7) continue;
      const yaw = minecartRotation(entity);
      const [dx,,dz] = railTangent(rail,closestT);
      return {x,y,z,t:closestT,direction:dx * Math.cos(yaw) - dz * Math.sin(yaw) >= 0 ? 1 : -1};
    }
    return null;
  }

  function originalCartsAt(cx,cz) {
    const address = cx + ',' + cz;
    if (!originals.has(address)) {
      if (originals.size >= 128) originals.delete(originals.keys().next().value);
      originals.set(address,(base.publicChunk?.(cx,cz)?.entities ?? []).filter(isRideableMinecart));
    }
    return originals.get(address);
  }

  function occupied(entity) {
    const [x,y,z] = entity.position;
    const overlaps = other => other.key !== entity.key &&
      Math.abs(other.position[1] - y) < .75 && Math.hypot(other.position[0] - x,other.position[2] - z) < .85;
    if ([...carts.values()].some(cart => overlaps(cart.entity))) return true;
    for (let cz = Math.floor((z - 1) / 16); cz <= Math.floor((z + 1) / 16); cz++) {
      for (let cx = Math.floor((x - 1) / 16); cx <= Math.floor((x + 1) / 16); cx++) {
        if (originalCartsAt(cx,cz).some(other => !carts.has(other.key) && overlaps(other))) return true;
      }
    }
    return false;
  }

  function place({x,y,z,yaw = 0}, rail) {
    if (carts.size >= maxCarts) throw new RequestError(409,'minecart_limit');
    const [dx,,dz] = railTangent(rail,.5);
    const direction = -dx * Math.sin(yaw) - dz * Math.cos(yaw) >= 0 ? 1 : -1;
    const track = {x,y,z,t:.5,direction};
    const entity = onRail({type:'Minecart',key:'minecart:' + randomUUID()},track,rail);
    if (occupied(entity) || !canMove(entity,undefined,track,rail)) throw new RequestError(409,'occupied');
    const cart = {entity,track,speed:0,placed:true};
    save(new Map(carts).set(entity.key,cart));
    return cart;
  }

  function remove(key) {
    if (!carts.get(key)?.placed) throw new RequestError(403,'protected_cell');
    const remaining = new Map(carts);
    remaining.delete(key);
    save(remaining);
  }

  function current(x,z,key) {
    if (carts.has(key)) return carts.get(key).entity;
    const original = base.getEntity?.(x,z,key);
    return isRideableMinecart(original) ? displayEntity(original) : null;
  }

  function recent(entity) {
    const previous = (history.get(entity.key) ?? []).filter(sample => sample.at >= clock() - historyTime)
      .map(sample => sample.entity);
    const endpoints = [...previous,entity];
    return endpoints.flatMap((to,index) => {
      const from = endpoints[index - 1];
      if (!from) return [to];
      const angles = to.data.Rotation;
      return [.25,.5,.75,1].map(t => ({...to,
        position:to.position.map((value,axis) => from.position[axis] + (value - from.position[axis]) * t),
        data:{Type:0,Rotation:angles.map((value,axis) => {
          const start = from.data.Rotation?.[axis] ?? 0;
          return start + degreeDelta(start,value) * t;
        })},
      }));
    });
  }

  function board(entity) {
    if (carts.has(entity.key) || carts.size >= maxCarts) return;
    const track = candidateTrack(entity);
    if (!track) return;
    const display = displayEntity(entity);
    carts.set(entity.key,{entity:display,track,speed:0,placed:false});
    changed = dirty = true;
  }

  function steering(key, direction) {
    if (direction === 0) drivers.delete(key);
    else drivers.set(key,{direction,expires:clock() + 400});
  }

  function pushAlongPath(start, trail) {
    const path = [start,...trail];
    if (!trail.some((point,index) => Math.hypot(point.x - path[index].x,point.z - path[index].z) >= .005)) return;
    const xs = path.map(point => point.x), zs = path.map(point => point.z);
    const left = Math.min(...xs) - contactRadius, right = Math.max(...xs) + contactRadius;
    const front = Math.min(...zs) - contactRadius, back = Math.max(...zs) + contactRadius;
    const nearby = entity => {
      const [x,,z] = entity.position;
      return x > left && x < right && z > front && z < back;
    };
    const entities = new Map();
    for (const {entity} of carts.values()) {
      if (nearby(entity)) entities.set(entity.key,entity);
    }
    for (let cz = Math.floor(front / 16); cz <= Math.floor(back / 16); cz++) {
      for (let cx = Math.floor(left / 16); cx <= Math.floor(right / 16); cx++) {
        for (const entity of originalCartsAt(cx,cz)) {
          if (!carts.has(entity.key) && nearby(entity)) entities.set(entity.key,entity);
        }
      }
    }
    for (const entity of entities.values()) {
      let contact;
      for (let i = 0; i < trail.length && !contact; i++) {
        contact = walkingContact(path[i],trail[i],entity.position,canTouch);
      }
      if (!contact) continue;
      const existing = carts.get(entity.key);
      const track = existing ? existing.track : candidateTrack(entity);
      const rail = track && railFor(cellAt(track.x,track.y,track.z));
      if (!rail) continue;
      const [dx,,dz] = directionAt(track,rail);
      const along = (contact[0] * dx + contact[1] * dz) / Math.hypot(...contact);
      if (Math.abs(along) < .025) continue;
      if (!existing) board(entity);
      const cart = carts.get(entity.key);
      const speed = 1.2 + 1.3 * Math.abs(along);
      const direction = Math.sign(along);
      if (cart && cart.speed * direction < speed) {
        cart.speed = direction * speed;
        dirty = true;
      }
    }
  }

  function advance(riders, updateRider) {
    const now = clock();
    const seconds = Math.max(0,Math.min((now - lastTick) / 1000,.15));
    lastTick = now;
    if (!seconds) return false;
    for (const [key, cart] of carts) {
      const rider = riders.get(key);
      if (!cart.track) continue;
      const {x,y,z} = cart.track;
      const rail = railFor(cellAt(x,y,z));
      if (!rail) {
        cart.track = null;
        cart.speed = 0;
        if (rider) updateRider(rider.player,null);
        changed = dirty = true;
        continue;
      }
      const [dx,dy,dz] = directionAt(cart.track,rail);
      let speed = cart.speed;
      const driving = drivers.get(key);
      const input = driving?.expires >= now && rider ? driving.direction : 0;
      if (!speed && !input && rail.powered && !dy) {
        const [first,last] = rail.ends.map(([ex,ey,ez]) => solidAt(x + ex * 2 - 1,y + ey,z + ez * 2 - 1));
        if (first !== last) speed = (first ? 1 : -1) * cart.track.direction * .6;
      }
      if (!speed && !input && !dy) continue;
      const facing = input && (-dx * Math.sin(rider.yaw) - dz * Math.cos(rider.yaw));
      speed += (10 * input * Math.sign(facing) - 4 * dy) * seconds;
      if (rail.powered && speed) speed += 6 * Math.sign(speed) * seconds;
      const drag = rail.id === 27 && !rail.powered ? .5 : input || rail.powered ? .99 : .96;
      speed *= drag ** (seconds / .05);
      if (Math.abs(speed) < .04) { cart.speed = 0; continue; }
      speed = Math.max(-maxSpeed,Math.min(maxSpeed,speed));
      const next = alongTrack(cart.track,rail,speed * seconds,cellAt);
      const entity = onRail(cart.entity,next.track,next.rail);
      if (!canMove(entity,rider,next.track,next.rail) || occupied(entity)) { cart.speed = 0; continue; }
      cart.track = next.track;
      cart.speed = next.stopped ? 0 : speed;
      if (entity.position.every((value,axis) => value === cart.entity.position[axis])) continue;
      const previous = (history.get(key) ?? []).filter(sample => sample.at >= now - historyTime);
      history.set(key,[...previous,{at:now,entity:cart.entity}]);
      cart.entity = entity;
      if (rider) updateRider(rider.player,entity);
      changed = dirty = true;
    }
    if (dirty && now - lastSave >= 1000) {
      save();
      lastSave = now;
      dirty = false;
    }
    const updated = changed;
    changed = false;
    return updated;
  }

  return {
    place, remove, current, recent, board, steering, pushAlongPath, advance,
    accept(cart, removed) {
      if (cart) carts.set(cart.entity.key,cart);
      if (removed) { carts.delete(removed); drivers.delete(removed); history.delete(removed); }
    },
    snapshot: () => [...carts.values()].map(cart => cart.entity),
    trackCells: () => [...carts.values()].flatMap(({track}) => track ? [[track.x,track.y,track.z]] : []),
    flush() { if (dirty) save(); },
  };
}
