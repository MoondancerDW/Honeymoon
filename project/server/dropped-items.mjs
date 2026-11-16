import {randomUUID} from 'node:crypto';
import {RequestError} from './errors.mjs';

const moduleName = 'dropped-items';
const worldOwner = 'world';
const stateKey = 'entities';
const maxDrops = 512;
const itemBody = {halfWidth:.09, height:.18};
const pickupDistance = 1.8;
const gravity = 24;
const lifetime = 10 * 60 * 1000;
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
        velocity[axis] = speed < -2 ? -speed * .19 : 0;
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
    position:[...position], resting};
}

export function createDroppedItems({base, store, clock, collides, visible, liquidAt=()=>null, currentAt=()=>[0,0,0]}) {
  const {bounds} = base.manifest;
  const inWorld = ([x,y,z]) => x - itemBody.halfWidth >= bounds.minX && z - itemBody.halfWidth >= bounds.minZ &&
    x + itemBody.halfWidth <= bounds.maxX + 1 && z + itemBody.halfWidth <= bounds.maxZ + 1 &&
    y >= bounds.minY && y + itemBody.height <= bounds.maxY + 1 &&
    (!base.hasPlayableChunk || base.hasPlayableChunk(Math.floor(x / 16), Math.floor(z / 16)));
  const blocked = position => !inWorld(position) ||
    collides({x:position[0],y:position[1],z:position[2]}, itemBody);
  const supported = ([x,y,z]) => blocked([x,y-.035,z]);
  const items = new Map();
  // Clear drops saved by older servers. Drop entities only live until this server closes.
  if (store.getState(moduleName, worldOwner, stateKey)?.value?.length) store.putState(moduleName, worldOwner, stateKey, 1, []);
  let previousTick = clock();

  function drop(stack, position, sight, yaw) {
    if (items.size >= maxDrops) throw new RequestError(409, 'too_many_dropped_items');
    const key = randomUUID();
    const angle = yaw + (Number.parseInt(key.slice(0,4),16) / 65535 - .5) * .24;
    const speed = 2.45 + Number.parseInt(key.slice(4,8),16) / 65535 * .45;
    const dx = -Math.sin(angle), dz = -Math.cos(angle);
    const initial = [sight.x, position.y + (sight.eye ?? 1.35) - .22, sight.z];
    const local = [position.x, initial[1], position.z];
    const forward = [initial[0] + dx * .4, initial[1], initial[2] + dz * .4];
    const start = [forward, initial, local, coordinates(position)].find(point =>
      !blocked(point) && visible(center(local), center(point)));
    if (!start) throw new RequestError(409, 'drop_obstructed');
    return {key,stack,position:start,velocity:[dx * speed,.7,dz * speed],resting:false,expires:clock() + lifetime};
  }

  function nearest(position, sight) {
    const origin = [position.x, position.y + .48, position.z];
    const eyes = [sight.x, position.y + (sight.eye ?? 1.35), sight.z];
    const now = clock();
    let closest = null, minimum = pickupDistance;
    for (const item of items.values()) {
      if (item.expires <= now) continue;
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
    const count = item.stack.count - 1;
    return count > 0 ? {...item,stack:{...item.stack,count}} : null;
  }

  function accept(created, removed) {
    if (created) items.set(created.key, created);
    if (removed) items.delete(removed);
  }

  function scatter(cell, [x,y,z]) {
    if (items.size >= maxDrops) return;
    const key = randomUUID();
    const position = [x+.5,y+.28,z+.5];
    if (!blocked(position)) items.set(key,{key,stack:{key:cell,cell,count:1},position,
      velocity:[.28,.8,-.21],resting:false,expires:clock()+lifetime});
  }

  function prepareScatter(stacks,[x,y,z]) {
    if (!stacks.length) return [];
    if (items.size+stacks.length > maxDrops) throw new RequestError(409,'too_many_dropped_items');
    const center=[x+.5,y+.28,z+.5];
    const position=[center,...escapeOffsets.map((offset)=>center.map((value,i)=>value+offset[i]))]
      .find(point=>!blocked(point));
    if (!position) throw new RequestError(409,'drop_obstructed');
    const expires=clock()+lifetime;
    return stacks.map((stack,index)=>{
      const angle=index*2.399963229728653;
      const speed=.46+(index%5)*.17;
      return {key:randomUUID(),stack,position:[...position],velocity:[Math.cos(angle)*speed,.85,Math.sin(angle)*speed],
        resting:false,expires};
    });
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
        continue;
      }
      if (item.resting && !supported(item.position)) {
        item.resting = false;
      }
    }
  }

  function advance() {
    const now = clock();
    const seconds = Math.min(.12, Math.max(0,(now - previousTick) / 1000));
    previousTick = now;
    if (!seconds) return false;
    let moved = false;
    for (const item of items.values()) {
      const medium=liquidAt(...center(item.position));
      if (item.expires <= now || medium === 'lava') {
        items.delete(item.key);
        moved = true;
        continue;
      }
      if (item.resting && medium !== 'water') continue;
      const velocity = [...item.velocity];
      if (medium === 'water') {
        const [x,y,z]=currentAt(...item.position,'water');
        const damp=Math.exp(-3.8*seconds);
        velocity[0]=velocity[0]*damp+x*seconds*2;
        velocity[1]=Math.min(.52,velocity[1]*damp+(3.8+y)*seconds);
        velocity[2]=velocity[2]*damp+z*seconds*2;
      } else velocity[1] = Math.max(-16, velocity[1] - gravity * seconds);
      const {position, grounded} = sweep(item.position, velocity, seconds, blocked);
      const drag = Math.exp(-(grounded ? 11 : 1.15) * seconds);
      velocity[0] *= drag;
      velocity[2] *= drag;
      const resting = medium !== 'water' && grounded && velocity[1] === 0 && Math.hypot(velocity[0],velocity[2]) < .13;
      Object.assign(item,{position, velocity:resting ? [0,0,0] : velocity, resting});
      moved = true;
    }
    return moved;
  }

  function clear() {
    const removed = items.size;
    items.clear();
    return removed;
  }

  function snapshot(position) {
    const now = clock();
    return [...items.values()].filter(({position:[x,y,z]}) =>
      Math.abs(x-position.x) <= 60 && Math.abs(z-position.z) <= 60 && Math.abs(y-position.y) <= 60)
      .filter(item => item.expires > now)
      .map(publicItem);
  }
  return {drop, nearest, pick, accept, scatter, prepareScatter, terrainChanged, advance, clear, snapshot};
}
