import {displayEntity} from './base.mjs';
import {RequestError} from './errors.mjs';
import {signalSides} from '../world/block-interactions.mjs';
import {itemFrameHit,itemFrameMount} from '../world/item-frames.mjs';
import {isDecoration,paintingArt,paintingAt,paintingHit,paintingItemKey,paintingMount} from '../world/paintings.mjs';
import {CREATIVE_FRAME_KEY,CREATIVE_INVISIBLE_FRAME_KEY} from '../world/creative-items.mjs';

const module = 'item-frames';
const world = 'world';
const state = 'entities';
const axes = ['x','y','z'];
const samePoint = (left,right) => left?.every((value,index) => value === right[index]);
const faceKey=(support,side)=>`${support.join(',')}:${side}`;
const motives=Object.keys(paintingArt).sort((a,b)=>{
  const [, ,aw,ah]=paintingArt[a], [, ,bw,bh]=paintingArt[b];
  return bw*bh-aw*ah;
});

function mountData(entity) {
  if (entity.type==='Painting') return paintingMount(entity);
  const mount=itemFrameMount(entity);
  if (mount?.support) return {...mount,supports:[mount.support]};
}

function contentsStack({id,Damage=0,Block,tag}) {
  const cell=Block || id<256 ? `legacy:${id}:${Damage&15}` : undefined;
  return {key:cell??`creative:${id}:${Damage}`,count:1,...(cell&&{cell}),...(tag&&{tag})};
}

function tombstone({key,position,type},revision) {
  return {key,position,type,revision,removed:true};
}

export function createItemFrames({base,store,physical,getCurrent,faceSupports,protectedCell}) {
  const snapshot = () => store.getState(module,world,state)?.value ?? [];
  const publicFrames=entries=>entries.map(entity=>entity.removed ? entity :
    {...displayEntity(entity),revision:entity.revision,...(entity.placed&&{placed:true})});

  function originalAround(cells) {
    const chunks=new Set();
    for (const [x,,z] of cells) {
      for (let cx=(x-4)>>4;cx<=(x+4)>>4;cx++) for (let cz=(z-4)>>4;cz<=(z+4)>>4;cz++) {
        chunks.add(`${cx},${cz}`);
      }
    }
    const entities=new Map();
    for (const key of chunks) {
      const [cx,cz]=key.split(',').map(Number);
      for (const entity of base.publicDecorations?.(cx,cz) ?? base.publicChunk?.(cx,cz)?.entities ?? []) {
        if (isDecoration(entity)) entities.set(entity.key,entity);
      }
    }
    return entities;
  }

  function occupiedFaces(cells,entries) {
    const entities=originalAround(cells);
    for (const entry of entries) entities.set(entry.key,entry);
    const faces=new Set();
    for (const entity of entities.values()) {
      if (entity.removed) continue;
      const mount=mountData(entity);
      for (const support of mount?.supports??[]) faces.add(faceKey(support,mount.side));
    }
    return faces;
  }

  function placementFace(input,sight) {
    const {x,y,z,hit}=input;
    const at=physical.targetAtHit(sight,x,y,z,hit);
    if (!at) throw new RequestError(403,'outside_reach');
    return {at,side:signalSides.findIndex(normal=>samePoint(normal,at.face)),support:[x,y,z]};
  }

  function write(entries,entity,key) {
    const revision = store.nextRevision();
    const frames = entries.filter(frame => frame.key !== key);
    if (entity) frames.push({...entity,revision});
    store.putState(module,world,state,1,frames);
    return {worldRevision:revision,changes:[],effects:[],frames:publicFrames(frames)};
  }

  function place(input,sight,invisible = false) {
    const {x,y,z,yaw = 0} = input;
    const {at,side,support}=placementFace(input,sight);
    if (side < 0 || !faceSupports(x,y,z,side,.125)) throw new RequestError(409,'invalid_frame_face');
    const next = support.map((value,index) => value + at.face[index]);
    if (!base.inBounds(...next) || protectedCell(...next)) throw new RequestError(403,'protected_cell');
    if (getCurrent(...next).cell !== null) throw new RequestError(409,'occupied');
    const entries = snapshot();
    if (entries.filter(entry=>entry.placed&&!entry.removed).length >= 512) throw new RequestError(409,'frame_limit');
    if (occupiedFaces([support],entries).has(faceKey(support,side))) throw new RequestError(409,'occupied');
    const key = 'frame:' + support.join(':') + ':' + side;
    const position = support.map((value,index) => value + .5 + at.face[index] * .54);
    const data = {TileX:x,TileY:y,TileZ:z,MountSide:side,MountTurn:Math.round(yaw * 2 / Math.PI) & 3,ItemRotation:0,
      ...(invisible && {Invisible:true})};
    return write(entries,{type:'ItemFrame',key,position,data,placed:true},key);
  }

  function placePainting(input,sight) {
    const {at,side,support}=placementFace(input,sight);
    if (side<2) throw new RequestError(409,'invalid_frame_face');
    const entries=snapshot();
    if (entries.filter(entry=>entry.placed&&!entry.removed).length>=512) throw new RequestError(409,'frame_limit');
    const occupied=occupiedFaces([support],entries);
    for (const motive of motives) {
      const entity=paintingAt(support,side,motive);
      const mount=paintingMount(entity);
      if (!mount.supports.every(back=>{
        const front=back.map((value,axis)=>value+at.face[axis]);
        return [back,front].every(([x,y,z])=>base.inBounds(x,y,z) &&
          (!base.hasPlayableChunk || base.hasPlayableChunk(x>>4,z>>4)) && !protectedCell(x,y,z)) &&
          faceSupports(...back,side,.125) && getCurrent(...front).cell===null && !occupied.has(faceKey(back,side));
      })) continue;
      return write(entries,entity,entity.key);
    }
    throw new RequestError(409,'invalid_frame_face');
  }

  function edit(input,sight,stack) {
    const {type,x,y,z,entity:key,hit,expectedRevision} = input;
    const entries = snapshot();
    let entity = entries.find(frame => frame.key === key);
    if (!entity) {
      const original=base.getEntity?.(x,z,key);
      entity=isDecoration(original) ? displayEntity(original) : originalAround([[x,y,z]]).get(key);
    }
    if (!entity || entity.removed || !samePoint(entity.position?.map(Math.floor),[x,y,z])) throw new RequestError(409,'not_a_frame');
    if ((entity.revision ?? 0) !== expectedRevision) throw new RequestError(409,'stale_frame',{
      frames:publicFrames(entries),worldRevision:store.worldRevision()});
    const origin = [sight.x,sight.y+(sight.eye ?? 1.62),sight.z];
    const target = axes.map(axis => hit[axis]);
    const delta = target.map((value,index) => value - origin[index]);
    const distance = Math.hypot(...delta);
    const painting=entity.type==='Painting';
    const measure=painting?paintingHit:itemFrameHit;
    if (distance < .00001 || distance > 6 || !physical.visiblePoint(origin,target) ||
        Math.abs(measure(entity,origin,delta.map(value => value / distance),distance + .003) - distance) > .003) {
      throw new RequestError(403,'outside_reach');
    }
    function remove(removedStack) {
      if (protectedCell(x,y,z) || mountData(entity)?.supports.some(point=>protectedCell(...point))) {
        throw new RequestError(403,'protected_cell');
      }
      const hidden=entity.placed ? null : tombstone(entity);
      return {...write(entries,hidden,key),removedStack};
    }
    if (painting) {
      if (type!=='frame_remove') throw new RequestError(409,'not_a_frame');
      return remove({key:paintingItemKey,count:1});
    }
    const data = {...entity.data};
    if (type === 'frame_item') {
      data.Item = stack;
      data.ItemRotation = 0;
    } else if (type === 'frame_use') {
      if (!data.Item) return {worldRevision:store.worldRevision(),changes:[],effects:[]};
      data.ItemRotation = ((data.ItemRotation ?? 0) + 1) & 3;
    } else if (data.Item) {
      const removedStack=contentsStack(data.Item);
      delete data.Item;
      data.ItemRotation = 0;
      return {...write(entries,{...entity,data},key),removedStack};
    } else {
      return remove({key:entity.data?.Invisible?CREATIVE_INVISIBLE_FRAME_KEY:CREATIVE_FRAME_KEY,count:1});
    }
    return write(entries,{...entity,data},key);
  }

  function removeSupported(x,y,z) {
    return removeSupportedMany([{x,y,z}]);
  }

  function removeSupportedMany(cells) {
    if (!cells.length) return;
    const supports=new Set(cells.map(({x,y,z})=>`${x},${y},${z}`));
    const entries=snapshot();
    const originals=originalAround(cells.map(({x,y,z})=>[x,y,z]));
    const entriesByKey=new Map(entries.map(entry=>[entry.key,entry]));
    for (const entry of entries) originals.set(entry.key,entry);
    let changed=false;
    for (const entity of originals.values()) {
      if (entity.removed || !mountData(entity)?.supports.some(point=>supports.has(point.join(',')))) continue;
      if (entity.placed) entriesByKey.delete(entity.key);
      else entriesByKey.set(entity.key,tombstone(entity,store.worldRevision()));
      changed=true;
    }
    if (!changed) return;
    const remaining=[...entriesByKey.values()];
    store.putState(module,world,state,1,remaining);
    return publicFrames(remaining);
  }

  function hasMountAt(x,y,z) {
    return snapshot().some(entity=>!entity.removed && (samePoint(entity.position?.map(Math.floor),[x,y,z]) ||
      mountData(entity)?.supports.some(point=>samePoint(point,[x,y,z]))));
  }

  return {snapshot:()=>publicFrames(snapshot()),place,placePainting,edit,removeSupported,removeSupportedMany,hasMountAt};
}
