import {randomUUID} from 'node:crypto';
import {RequestError} from './errors.mjs';

const moduleName = 'dropped-items';
const worldOwner = 'world';
const stateKey = 'entities';
const maxDrops = 512;
const itemBody = {halfWidth:.09, height:.18};
const pickupDistance = 1.8;
const gravity = 18;
const cellAxis = ['x','y','z'];
const coordinates = position => cellAxis.map(axis => position[axis]);
const center = ([x,y,z]) => [x,y + itemBody.height / 2,z];
const escapeOffsets = [.2,.4,.7,1.1].flatMap(step =>
  [[0,step,0],[step,0,0],[-step,0,0],[0,0,step],[0,0,-step]]);

function sweep(position, velocity, seconds, blocked) {
  const next = [...position];
  const count = Math.max(1, Math.ceil(Math.max(...velocity.map(Math.abs)) * seconds / .1));
  const dt = seconds / count;
  let grounded = false;
  for (let step = 0; step < count; step++) {
    for (const axis of [0,2,1]) {
      const speed = velocity[axis];
      if (!speed) continue;
      const previous = next[axis];
      next[axis] += speed * dt;
      if (!blocked(next)) continue;
      let clear = previous, occupied = next[axis];
      for (let pass = 0; pass < 7; pass++) {
        next[axis] = (clear + occupied) / 2;
        if (blocked(next)) occupied = next[axis];
        else clear = next[axis];
      }
      next[axis] = clear;
      if (axis === 1) {
        grounded ||= speed < 0;
        velocity[axis] = speed < -1.5 ? -speed * .24 : 0;
      } else {
        velocity[axis] *= -.18;
      }
    }
  }
  return {position:next, grounded};
}

function publicItem({key, stack, position, resting}) {
  const {key:itemKey, count, cell, part} = stack;
  return {key, item:{key:itemKey,count, ...(cell && {cell}), ...(part && {part})},
    position:center(position), resting};
}

export function createDroppedItems({base, store, clock, collides, visible}) {
  const {bounds} = base.manifest;
  const inWorld = ([x,y,z]) => x - itemBody.halfWidth >= bounds.minX && z - itemBody.halfWidth >= bounds.minZ &&
    x + itemBody.halfWidth <= bounds.maxX + 1 && z + itemBody.halfWidth <= bounds.maxZ + 1 &&
    y >= bounds.minY && y + itemBody.height <= bounds.maxY + 1 &&
    (!base.hasPlayableChunk || base.hasPlayableChunk(Math.floor(x / 16), Math.floor(z / 16)));
  const blocked = position => !inWorld(position) ||
    collides({x:position[0],y:position[1],z:position[2]}, itemBody);
  const supported = ([x,y,z]) => blocked([x,y-.035,z]);
  const items = new Map((store.getState(moduleName, worldOwner, stateKey)?.value ?? [])
    .filter(item => inWorld(item.position)).map(item => [item.key, {...item, resting:item.resting && supported(item.position)}]));
  let previousTick = clock();
  let previousSave = previousTick;
  let dirty = false;
  const save = (entries = items) => store.putState(moduleName, worldOwner, stateKey, 1, [...entries.values()]);

  function drop(stack, position, sight, yaw) {
    if (items.size >= maxDrops) throw new RequestError(409, 'too_many_dropped_items');
    const key = randomUUID();
    const angle = yaw + (Number.parseInt(key.slice(0,4),16) / 65535 - .5) * .24;
    const speed = 3.18 + Number.parseInt(key.slice(4,8),16) / 65535 * .54;
    const dx = -Math.sin(angle), dz = -Math.cos(angle);
    const initial = [sight.x, position.y + (sight.eye ?? 1.35) - .22, sight.z];
    const local = [position.x, initial[1], position.z];
    const forward = [initial[0] + dx * .4, initial[1], initial[2] + dz * .4];
    const start = [forward, initial, local, coordinates(position)].find(point =>
      !blocked(point) && visible(center(local), center(point)));
    if (!start) throw new RequestError(409, 'drop_obstructed');
    const item = {key,stack,position:start,velocity:[dx * speed,2.15,dz * speed],resting:false};
    save(new Map(items).set(item.key, item));
    return item;
  }

  function nearest(position, sight) {
    const origin = [position.x, position.y + .48, position.z];
    const eyes = [sight.x, position.y + (sight.eye ?? 1.35), sight.z];
    let closest = null, minimum = pickupDistance;
    for (const item of items.values()) {
      const target = center(item.position);
      const distance = Math.hypot(...target.map((value, i) => value - origin[i]));
      if (distance <= minimum && (!closest || distance < minimum) && visible(eyes,target)) {
        closest = item;
        minimum = distance;
      }
    }
    return closest;
  }

  function pick(item) {
    const next = new Map(items);
    const count = item.stack.count - 1;
    const remaining = count > 0 ? {...item,stack:{...item.stack,count}} : null;
    if (remaining) next.set(item.key,remaining);
    else next.delete(item.key);
    save(next);
    return remaining;
  }

  function accept(created, removed) {
    if (created) items.set(created.key, created);
    if (removed) items.delete(removed);
  }

  function terrainChanged(changes) {
    if (!changes.length || !items.size) return;
    for (const item of items.values()) {
      const [x,y,z] = item.position;
      if (!changes.some(change => Math.abs(change.x + .5 - x) < 1.6 &&
          Math.abs(change.y + .5 - y) < 1.6 && Math.abs(change.z + .5 - z) < 1.6)) continue;
      if (blocked(item.position)) {
        const escape = escapeOffsets.map(([dx,dy,dz]) => [x+dx,y+dy,z+dz]).find(point => !blocked(point));
        if (!escape) continue;
        item.position = escape;
        item.velocity = [0,0,0];
        item.resting = false;
        dirty = true;
        continue;
      }
      if (item.resting && !supported(item.position)) {
        item.resting = false;
        dirty = true;
      }
    }
  }

  function advance() {
    const now = clock();
    const seconds = Math.min(.12, Math.max(0,(now - previousTick) / 1000));
    previousTick = now;
    if (!seconds) return false;
    let moved = false, settled = false;
    for (const item of items.values()) {
      if (item.resting) continue;
      const velocity = [...item.velocity];
      velocity[1] = Math.max(-16, velocity[1] - gravity * seconds);
      const {position, grounded} = sweep(item.position, velocity, seconds, blocked);
      const drag = Math.exp(-(grounded ? 11 : 1.15) * seconds);
      velocity[0] *= drag;
      velocity[2] *= drag;
      const resting = grounded && velocity[1] === 0 && Math.hypot(velocity[0],velocity[2]) < .13;
      Object.assign(item,{position, velocity:resting ? [0,0,0] : velocity, resting});
      settled ||= resting;
      moved = dirty = true;
    }
    if (dirty && (settled || now - previousSave >= 1000)) flush();
    return moved;
  }

  function flush() {
    if (!dirty) return;
    save();
    dirty = false;
    previousSave = previousTick;
  }

  function snapshot(position) {
    return [...items.values()].filter(({position:[x,y,z]}) =>
      Math.abs(x-position.x) <= 60 && Math.abs(z-position.z) <= 60 && Math.abs(y-position.y) <= 60)
      .map(publicItem);
  }
  return {drop, nearest, pick, accept, terrainChanged, advance, flush, snapshot};
}
