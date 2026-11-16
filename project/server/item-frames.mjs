import {displayEntity} from './base.mjs';
import {RequestError} from './errors.mjs';
import {signalSides} from '../world/block-interactions.mjs';
import {itemFrameHit,itemFrameMount} from '../world/item-frames.mjs';

const module = 'item-frames';
const world = 'world';
const state = 'entities';
const axes = ['x','y','z'];
const samePoint = (left,right) => left?.every((value,index) => value === right[index]);
const visibleEntity = raw => raw?.type === 'ItemFrame' ? displayEntity(raw) : null;

export function createItemFrames({base,store,physical,getCurrent,faceSupports,protectedCell}) {
  const snapshot = () => store.getState(module,world,state)?.value ?? [];
  function write(entries,entity,key) {
    const revision = store.nextRevision();
    const frames = entries.filter(frame => frame.key !== key);
    if (entity) frames.push({...entity,revision});
    store.putState(module,world,state,1,frames);
    return {worldRevision:revision,changes:[],effects:[],frames};
  }

  function place(input,sight,invisible = false) {
    const {x,y,z,hit,yaw = 0} = input;
    const at = physical.targetAtHit(sight,x,y,z,hit);
    if (!at) throw new RequestError(403,'outside_reach');
    const side = signalSides.findIndex(normal => samePoint(normal,at.face));
    if (side < 0 || !faceSupports(x,y,z,side,.125)) throw new RequestError(409,'invalid_frame_face');
    const support = [x,y,z];
    const next = support.map((value,index) => value + at.face[index]);
    if (!base.inBounds(...next) || protectedCell(...next)) throw new RequestError(403,'protected_cell');
    if (getCurrent(...next).cell !== null) throw new RequestError(409,'occupied');
    const entries = snapshot();
    if (entries.length >= 512) throw new RequestError(409,'frame_limit');
    const original = [support,next].flatMap(([ax,,az]) =>
      base.publicChunk?.(ax >> 4,az >> 4)?.entities ?? []).filter(frame => frame.type === 'ItemFrame');
    if ([...entries,...original].some(frame => {
      const mount = itemFrameMount(frame);
      return mount?.side === side && samePoint(mount.support,support);
    })) throw new RequestError(409,'occupied');
    const key = 'frame:' + support.join(':') + ':' + side;
    const position = support.map((value,index) => value + .5 + at.face[index] * .54);
    const data = {TileX:x,TileY:y,TileZ:z,MountSide:side,MountTurn:Math.round(yaw * 2 / Math.PI) & 3,ItemRotation:0,
      ...(invisible && {Invisible:true})};
    return write(entries,{type:'ItemFrame',key,position,data,placed:true},key);
  }

  function edit(input,sight,stack) {
    const {type,x,y,z,entity:key,hit,expectedRevision} = input;
    const entries = snapshot();
    const entity = entries.find(frame => frame.key === key) ?? visibleEntity(base.getEntity?.(x,z,key));
    if (!entity || !samePoint(entity.position?.map(Math.floor),[x,y,z])) throw new RequestError(409,'not_a_frame');
    if ((entity.revision ?? 0) !== expectedRevision) throw new RequestError(409,'stale_frame',{frames:entries,worldRevision:store.worldRevision()});
    const origin = [sight.x,sight.y+(sight.eye ?? 1.62),sight.z];
    const target = axes.map(axis => hit[axis]);
    const delta = target.map((value,index) => value - origin[index]);
    const distance = Math.hypot(...delta);
    if (distance < .00001 || distance > 6 || !physical.visiblePoint(origin,target) ||
        Math.abs(itemFrameHit(entity,origin,delta.map(value => value / distance),distance + .003) - distance) > .003) {
      throw new RequestError(403,'outside_reach');
    }
    const data = {...entity.data};
    if (type === 'frame_item') {
      data.Item = stack;
      data.ItemRotation = 0;
    } else if (type === 'frame_use') {
      if (!data.Item) return {worldRevision:store.worldRevision(),changes:[],effects:[]};
      data.ItemRotation = ((data.ItemRotation ?? 0) + 1) & 3;
    } else if (data.Item) {
      delete data.Item;
      data.ItemRotation = 0;
    } else {
      if (!entity.placed) throw new RequestError(403,'protected_cell');
      return write(entries,null,key);
    }
    return write(entries,{...entity,data},key);
  }

  function removeSupported(x,y,z) {
    const entries = snapshot();
    const remaining = entries.filter(frame => !frame.placed || !samePoint(itemFrameMount(frame)?.support,[x,y,z]));
    if (remaining.length === entries.length) return undefined;
    store.putState(module,world,state,1,remaining);
    return remaining;
  }

  function hasMountAt(x,y,z) {
    return snapshot().some(frame => samePoint(itemFrameMount(frame)?.support,[x,y,z]) ||
      samePoint(frame.position.map(Math.floor),[x,y,z]));
  }

  return {snapshot,place,edit,removeSupported,hasMountAt};
}
