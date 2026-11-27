import {createHash} from 'node:crypto';
import {bagKind,canvasBagSize,itemStackLimit,itemStackPortion,seedBagSize} from '../world/item-stack.mjs';
import {itemName,plainMinecraftText,stackType} from '../world/item-text.mjs';
import {seedPlant} from '../world/seed-plants.mjs';
import {rawContainerStack,stackFromRaw} from './containers.mjs';
import {RequestError} from './errors.mjs';

const maxCounts={inventory:36,storage:canvasBagSize};
const isSlot=(slot,size)=>Number.isInteger(slot) && slot>=0 && slot<size;

function inventorySlot(slot) {
  if (!isSlot(slot,maxCounts.inventory)) throw new RequestError(400,'invalid_inventory_slot');
  return slot;
}

function endpoint(input) {
  const {side,slot}=input??{};
  if (!Object.hasOwn(maxCounts,side) || !isSlot(slot,maxCounts[side])) throw new RequestError(400,'invalid_inventory_slot');
  return {side,slot};
}

export function bagOpenInput(body,input) {
  return body.slot===undefined ? input : {...input,slot:inventorySlot(body.slot)};
}

export function bagMoveInput(body,input) {
  const {slot,version,count}=body;
  if (typeof version!=='string' || !/^[a-f0-9]{64}$/.test(version)) throw new RequestError(400,'invalid_bag_version');
  if (count!==undefined && (!Number.isInteger(count) || count<1 || count>64)) {
    throw new RequestError(400,'invalid_inventory_count');
  }
  return {...input,slot:inventorySlot(slot),version,from:endpoint(body.from),to:endpoint(body.to),...(count!==undefined && {count})};
}

export function createBags({inventory,creativeBlocks,creativeItems}) {
  function readBag(state,slot) {
    const item=state.slots[inventorySlot(slot)];
    const kind=bagKind(item?.key);
    if (!kind) throw new RequestError(409,'not_a_bag');
    const raw=item.nbt?.contents===undefined?[]:item.nbt.contents;
    if (!Number.isInteger(item.count) || item.count<1 || item.count>127 ||
        item.nbt!==undefined && (!item.nbt || typeof item.nbt!=='object' || Array.isArray(item.nbt)) ||
        !Array.isArray(raw)) throw new RequestError(409,'invalid_bag_contents');
    const size=kind==='canvas'?canvasBagSize:seedBagSize;
    const slots=Array(size).fill(null);
    const rawSlots=new Map();
    for (const row of raw) {
      const index=row?.Slot;
      if (!isSlot(index,size)) continue;
      const stack=stackFromRaw(row,creativeBlocks,creativeItems);
      if (rawSlots.has(index) || !stack) throw new RequestError(409,'invalid_bag_contents');
      slots[index]=stack;
      rawSlots.set(index,row);
    }
    return {kind,item,size,slots,raw,rawSlots,slot};
  }

  function describe(player,state,view) {
    const {kind,item,size,slots,slot}=view;
    // Include the bag's owning slot and all inventory contents so delayed moves cannot target changed stacks.
    const version=createHash('sha256').update(JSON.stringify([player,slot,state])).digest('hex');
    const title=plainMinecraftText(itemName(item)).trim() || (kind==='canvas'?'Полотняная сумка':'Сумка для семян');
    return {kind,key:item.key,size,slots,version,title,inventorySlot:slot};
  }

  function open(player,{slot}={}) {
    const state=inventory.read(player);
    const view=readBag(state,slot??state.selected);
    return {bag:describe(player,state,view),inventory:state};
  }

  function writeBag(state,view,changes) {
    const raw=view.raw.filter(row=>!changes.has(row?.Slot));
    for (const [slot,stack] of changes) {
      if (!stack) continue;
      const previous=view.rawSlots.get(slot);
      raw.push(previous && stackType(view.slots[slot])===stackType(stack) ? {...previous,Count:stack.count} : rawContainerStack(stack,slot));
    }
    // Minecraft uses Slot for the native order. Keep unknown out-of-range data as received.
    raw.sort((a,b)=>(isSlot(a?.Slot,view.size)?a.Slot:view.size)-(isSlot(b?.Slot,view.size)?b.Slot:view.size));
    const item={...view.item,nbt:{...view.item.nbt,contents:raw}};
    if (view.kind==='seed') {
      const count=raw.reduce((total,row)=>total+(isSlot(row?.Slot,view.size)?row.Count??1:0),0);
      const damage=count===0?0:Math.max(1,577-count);
      item.key=`creative:9299:${damage}`;
      if (Object.hasOwn(item,'damage')) item.damage=damage;
    }
    state.slots[view.slot]=item;
  }

  function move(player,input) {
    const state=inventory.read(player);
    const {slot,version,from,to,count}=input;
    const view=readBag(state,slot);
    const current=describe(player,state,view);
    if (current.version!==version) throw new RequestError(409,'stale_bag',{bag:current,inventory:state});
    const slots={inventory:state.slots,storage:view.slots};
    for (const endpoint of [from,to]) {
      if (!isSlot(endpoint.slot,slots[endpoint.side]?.length)) throw new RequestError(400,'invalid_inventory_slot');
      if (endpoint.side==='inventory' && endpoint.slot===slot) throw new RequestError(409,'bag_slot_locked');
    }
    const first=slots[from.side][from.slot], second=slots[to.side][to.slot];
    if (!first || from.side===to.side && from.slot===to.slot) return {bag:current,inventory:state};
    const amount=Math.min(count??first.count,first.count);
    const changes={inventory:new Map(),storage:new Map()};
    const set=(end,stack)=>changes[end.side].set(end.slot,stack);
    const firstType=stackType(first);
    if (second && stackType(second)!==firstType) {
      if (amount!==first.count || first.count>itemStackLimit(first.key) || second.count>itemStackLimit(second.key)) {
        throw new RequestError(409,'occupied_inventory_slot');
      }
      set(from,second);
      set(to,first);
    } else {
      const moved=Math.min(amount,itemStackLimit(first.key)-(second?.count??0));
      if (moved<=0) throw new RequestError(409,'inventory_full');
      set(from,moved===first.count?null:{...first,count:first.count-moved});
      set(to,{...itemStackPortion(first,moved),count:(second?.count??0)+moved});
    }
    if (changes.storage.size) {
      const after=view.slots.map((before,index)=>changes.storage.has(index)?changes.storage.get(index):before);
      for (const [index,stack] of changes.storage) {
        if (!stack || view.slots[index] && stackType(view.slots[index])===stackType(stack) &&
            stack.count<view.slots[index].count) continue;
        if (bagKind(stack.key)===view.kind) throw new RequestError(409,'bag_nesting');
        if (view.kind==='seed' && (!seedPlant(stack) || after.some(item=>item && item.key!==stack.key))) {
          throw new RequestError(409,'wrong_bag_item');
        }
      }
      writeBag(state,view,changes.storage);
    }
    for (const [index,stack] of changes.inventory) state.slots[index]=stack;
    // game.action already wraps this update and its response in one atomic receipt.
    inventory.replace(player,state);
    return {bag:describe(player,state,readBag(state,slot)),inventory:state};
  }

  function seedView(state,slot) {
    const view=readBag(state,slot??state.selected);
    if (view.kind!=='seed') throw new RequestError(409,'not_a_bag');
    return view;
  }

  function seedContents(player,slot) {
    const view=seedView(inventory.read(player),slot);
    const first=view.slots.find(Boolean);
    if (!first || !seedPlant(first)) return;
    const count=view.slots.reduce((total,stack)=>total+(stack?.key===first.key?stack.count:0),0);
    return {key:first.key,count,slot:view.slot,stack:first};
  }

  function consumeSeeds(player,{slot,key,count}) {
    if (!Number.isInteger(count) || count<1) throw new RequestError(400,'invalid_inventory_count');
    const state=inventory.read(player);
    const view=seedView(state,slot);
    const changes=new Map();
    let left=count;
    for (let index=0;index<view.slots.length && left;index++) {
      const stack=view.slots[index];
      if (stack?.key!==key || !seedPlant(stack)) continue;
      const taken=Math.min(left,stack.count);
      left-=taken;
      changes.set(index,taken===stack.count?null:{...stack,count:stack.count-taken});
    }
    if (left) throw new RequestError(409,'not_enough_seeds');
    writeBag(state,view,changes);
    return inventory.replace(player,state);
  }

  return {open,move,seedContents,consumeSeeds};
}
