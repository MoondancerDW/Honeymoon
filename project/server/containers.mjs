import {createHash} from 'node:crypto';
import {RequestError} from './errors.mjs';
import {containerSpec,containerVisualState} from '../world/containers.mjs';
import {blockKey,blockState} from '../world/block-interactions.mjs';
import {paneOpaqueBlocks} from '../world/block-geometry-properties.mjs';
import {itemStackLimit} from '../world/item-stack.mjs';
import {stackType} from '../world/item-text.mjs';
import {ponyArmor} from '../world/pony-armor.mjs';

export const containerActions = new Set(['container_open','container_read','container_move','container_close']);
const maxStacks = {inventory:36, storage:64};
const chestNeighbors = [[0,-1],[-1,0],[1,0],[0,1]];
const coordinates = cell => [cell.x,cell.y,cell.z];
const compound = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const inSlot = (slot,size) => Number.isInteger(slot) && slot >= 0 && slot < size;
const nativeKey = /^(?:creative|legacy):(\d+):(\d+)$/;
const STACK_EXTENSION = 'HoneymoonStack';

function endpoint(input) {
  const {side,slot} = input ?? {};
  if (!Object.hasOwn(maxStacks,side) || !inSlot(slot,maxStacks[side])) throw new RequestError(400,'invalid_inventory_slot');
  return {side,slot};
}

export function containerInput(body, input) {
  const {containerView} = body;
  if (containerView !== undefined) {
    const valid = containerView === 'summary' && ['container_open','container_read','container_close'].includes(body.type) ||
      containerView === 'details' && ['container_read','container_move'].includes(body.type);
    if (!valid) throw new RequestError(400,'invalid_container_view');
    input = {...input,containerView};
  }
  if (body.type !== 'container_move') return input;
  const {version,count} = body;
  if (typeof version !== 'string' || !/^[0-9:,-]{1,160}$/.test(version)) throw new RequestError(400,'invalid_container_version');
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 64)) {
    throw new RequestError(400,'invalid_inventory_count');
  }
  return {...input,version,from:endpoint(body.from),to:endpoint(body.to),...(count !== undefined && {count})};
}

function rawSlot(item, single) {
  return single ? 0 : item?.Slot;
}

export function rawContainerStack(stack, slot, single = false) {
  const fields = nativeKey.exec(stack.key);
  const {count,nbt,legacyNbt,...extension} = stack;
  const retainExtension = !fields || Boolean(extension.object || extension.copied);
  return {...legacyNbt,id:Number(fields?.[1] ?? 750),Damage:Number(fields?.[2] ?? 0),Count:count,
    ...(!single && {Slot:slot}),...(Object.hasOwn(stack,'nbt') && {tag:nbt}),
    ...(retainExtension && {[STACK_EXTENSION]:extension})};
}

function permits(spec, slot, stack) {
  if (!stack) return true;
  const id = Number(stack.key.split(':')[1]);
  switch (spec.filter) {
    case 'armor': return ponyArmor(stack.key)?.slot === 3-slot;
    case 'book': return [340,386,387,403].includes(id);
    case 'desk': return [339,340,386,387,403].includes(id);
    case 'potion': return id === 373 || id === 374;
    case 'record': return id >= 2256 && id <= 2267;
    default: return true;
  }
}

function withData(cell, spec, data) {
  const position = coordinates(cell);
  const object = cell.object ?? {type:spec.type,position,key:`tile:${position.join(':')}`};
  return {...cell,object:{...object,data}};
}

export function stackFromRaw(item,creativeBlocks,creativeItems) {
  const {id,Damage:damage=0,Count:count=1,Slot:_,tag,[STACK_EXTENSION]:extension,...legacyNbt} = item ?? {};
  if (!validStack(id,damage,count)) return null;
  const creativeKey = `creative:${id}:${damage}`;
  const variant = creativeItems.get(creativeKey);
  const legacy = id < 4096 && damage < 16 ? blockKey(id,damage) : undefined;
  const cell = variant?.blockKey ?? (!variant && (creativeBlocks.has(legacy) || legacyNbt.Block === true) ? legacy : undefined);
  const key = variant || !cell ? creativeKey : cell;
  const portable = compound(extension) && typeof extension.key === 'string' && extension.key.length <= 128 &&
    (extension.key === 'copy:part' || extension.key.startsWith('cover:') || nativeKey.test(extension.key));
  if (extension !== undefined && !portable) legacyNbt[STACK_EXTENSION] = extension;
  const stack = portable ? {key:extension.key,...(typeof extension.cell === 'string' && {cell:extension.cell}),
      ...(extension.part && {part:extension.part,pattern:extension.pattern}),
      ...(compound(extension.object) && {object:extension.object}),
      ...(extension.copied === true && {copied:true}),
      ...(typeof extension.name === 'string' && {name:extension.name})} :
    {key,...(cell && {cell}),...(variant?.part && {part:variant.part,pattern:variant.part.pattern})};
  return {...stack,count,
    ...(tag !== undefined && {nbt:tag}),...(Object.keys(legacyNbt).length && {legacyNbt})};
}

const validStack = (id,damage,count) => Number.isInteger(id) && id>=1 && id<=32767 &&
  Number.isInteger(damage) && damage>=0 && damage<=32767 && Number.isInteger(count) && count>=1 && count<=127;

function rawCount(item) {
  const {id,Damage:damage=0,Count:count=1} = item ?? {};
  return validStack(id,damage,count) ? count : null;
}

export function createContainers({store, inventory, getCell, getOriginalCell, creativeBlocks, creativeItems}) {
  function storedData(cell, spec) {
    const data=cell.object?.data ?? {};
    const inventory=data[spec.field];
    const missing=!Object.hasOwn(data,spec.field);
    const preview=!spec.single && Array.isArray(inventory) && inventory.some(stack=>stack?.Count===undefined);
    if ((!missing && !preview) || spec.personal || !cell.revision || !cell.object || !getOriginalCell ||
        store.getEditOwner(...coordinates(cell))) return data;
    // Previous releases saved display-only tile records when toggling a lid.
    const original=getOriginalCell(...coordinates(cell));
    const source=original.object?.data?.[spec.field];
    if (original.key!==cell.cell || original.object?.type!==cell.object.type || source===undefined) return data;
    if (spec.single && data.Record!==undefined && data.Record!==source?.id) return data;
    if (missing) return {...data,[spec.field]:source};
    if (!Array.isArray(source)) return data;
    return {...data,[spec.field]:inventory.map(stack=>{
      if (!stack || stack.Count!==undefined) return stack;
      return source.find(native=>native.Slot===stack.Slot && native.id===stack.id &&
        (native.Damage??0)===(stack.Damage??0)) ?? stack;
    })};
  }

  function materials(player, current, mode='details') {
    const spec = containerSpec(current);
    if (!spec) throw new RequestError(409,'not_a_container');
    const cells = [current];
    if (spec.pair) {
      const other = chestNeighbors.map(([dx,dz]) => getCell(current.x+dx,current.y,current.z+dz))
        .find(cell => blockState(cell)[0] === 54);
      if (other) cells.push(other);
      cells.sort((a,b)=>a.z-b.z || a.x-b.x);
    }
    const personal = spec.personal ? store.getState('container',player,'ender')?.value : null;
    const groups = cells.map(cell => {
      const data = storedData(cell,spec);
      const original = spec.personal ? personal?.items :
        spec.single ? data[spec.field] && [data[spec.field]] : data[spec.field];
      const raw = Array.isArray(original) ? original : [];
      const slots = mode==='data' ? [] : Array(spec.size).fill(null);
      for (const item of raw) {
        const slot = rawSlot(item,spec.single);
        if (inSlot(slot,slots.length) && !slots[slot]) {
          slots[slot] = mode==='summary' ? rawCount(item) : stackFromRaw(item,creativeBlocks,creativeItems);
        }
      }
      return {cell,data,raw,slots};
    });
    return {
      spec,groups,personalVersion:personal?.revision ?? 0,
      slots:groups.flatMap(group=>group.slots),
      version:groups.map(({cell})=>[cell.x,cell.y,cell.z,cell.revision].join(',')).join(':') +
        (spec.personal ? ':'+String(personal?.revision ?? 0) : ''),
    };
  }

  function info(current, view, mode) {
    const {spec,groups,slots,version} = view;
    const custom = groups.map(({data})=>data.CustomName).find(name => typeof name === 'string' && name.trim());
    const title = custom ?? (groups.length === 2 ? 'Двойной сундук' : spec.title);
    const description = {x:current.x,y:current.y,z:current.z,version,title};
    if (!mode) return {...description,slots};
    // The shape and full contents identify cached details independently of the lid animation.
    const contentVersion = createHash('sha256').update(JSON.stringify([spec.size,groups.map(({raw})=>raw)])).digest('hex');
    return {...description,contentVersion,...(mode==='summary' ? {counts:slots} : {slots})};
  }

  function lid(current, spec, groups, open) {
    let active = groups;
    if (open && (spec.pair || spec.personal) && active.some(({cell}) =>
      paneOpaqueBlocks.has(blockState(getCell(cell.x,cell.y+1,cell.z))[0]))) throw new RequestError(409,'occupied');
    if (!spec.lid) return {cells:[],effects:[]};
    active = active.filter(({data})=>Boolean(data[spec.lid]) !== open);
    const cells = active.map(({cell,data})=>withData(cell,spec,{...data,[spec.lid]:open}));
    return {cells,effects:cells.length ? [{
      type:'sound',sound:spec.lid === 'LidOpen' ? `jds.bibliocraft.sound.case${open ? 'open' : 'close'}` :
        `chest.${open ? 'open' : 'close'}`,position:coordinates(current),volume:.5,
    }] : []};
  }

  function transfer(player, input, current, view) {
    if (input.version !== view.version) throw new RequestError(409,'stale_container',{container:info(current,view,input.containerView)});
    const state = inventory.read(player);
    const slots = {inventory:state.slots,storage:view.slots};
    const {from,to,count} = input;
    if (!inSlot(from.slot,slots[from.side].length) || !inSlot(to.slot,slots[to.side].length)) {
      throw new RequestError(400,'invalid_inventory_slot');
    }
    if (from.side === to.side && from.slot === to.slot) return {cells:[],effects:[]};
    const first = slots[from.side][from.slot], second = slots[to.side][to.slot];
    if (!first) return {cells:[],effects:[]};
    const {spec,groups} = view;
    const accepts = (target,stack) => target.side === 'inventory' || permits(spec,target.slot % spec.size,stack);
    const limit = (target,stack) => Math.min(itemStackLimit(stack.key),target.side === 'storage' ? spec.limit ?? 64 : 64);
    if (!accepts(to,first)) throw new RequestError(409,'wrong_container_item');
    const changes = {inventory:new Map(),storage:new Map()};
    const set = (target,stack) => changes[target.side].set(target.slot,stack);
    const amount = Math.min(count ?? first.count,first.count);
    if (second && stackType(first) !== stackType(second)) {
      if (amount !== first.count || amount > limit(to,first) || second.count > limit(from,second) || !accepts(from,second)) {
        throw new RequestError(409,'occupied_inventory_slot');
      }
      set(from,second);
      set(to,first);
    } else {
      const moved = Math.min(amount,limit(to,first) - (second?.count ?? 0));
      if (moved <= 0) throw new RequestError(409,'inventory_full');
      set(from,moved < first.count ? {...first,count:first.count-moved} : null);
      set(to,{...first,count:(second?.count ?? 0)+moved});
    }
    for (const [slot,stack] of changes.inventory) state.slots[slot] = stack;
    if (changes.inventory.size) inventory.replace(player,state);
    const cells = [];
    for (const [half,group] of groups.entries()) {
      const changed = new Map([...changes.storage]
        .filter(([slot])=>Math.floor(slot/spec.size) === half).map(([slot,stack])=>[slot%spec.size,stack]));
      if (!changed.size) continue;
      const raw = group.raw.filter(item=>!changed.has(rawSlot(item,spec.single)));
      for (const [slot,stack] of changed) {
        group.slots[slot] = stack;
        if (stack) raw.push(rawContainerStack(stack,slot,spec.single));
      }
      if (spec.personal) {
        store.putState('container',player,'ender',1,{items:raw,revision:view.personalVersion+1});
      } else {
        const data = {...group.data,[spec.field]:spec.single ? raw[0] ?? null : raw,...containerVisualState(spec,group.slots)};
        if (spec.single) data.Record = raw[0]?.id ?? 0;
        const cell=spec.single ? {...group.cell,cell:blockKey(blockState(group.cell)[0],raw.length ? 1 : 0)} : group.cell;
        cells.push(withData(cell,spec,data));
      }
    }
    return {cells,effects:[]};
  }

  return {
    contents(player,current) {
      const spec=containerSpec(current);
      if (!spec || spec.personal) return [];
      return materials(player,current).groups.find(group=>group.cell.x===current.x && group.cell.z===current.z).slots.filter(Boolean);
    },
    prepare(player,current,input) {
      if (input.type === 'container_read') return {cells:[],effects:[]};
      if (input.type === 'container_move') return transfer(player,input,current,materials(player,current));
      const view = materials(player,current,'data');
      return lid(current,view.spec,view.groups,input.type === 'container_open');
    },
    response(player,input) {
      if (input.type === 'container_close' && !input.containerView) return {};
      const current = getCell(input.x,input.y,input.z);
      const mode = input.containerView;
      return {container:info(current,materials(player,current,mode),mode),
        ...((!mode || input.type==='container_move') && {inventory:inventory.read(player)})};
    },
  };
}
