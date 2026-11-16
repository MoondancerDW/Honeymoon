import {RequestError} from './errors.mjs';
import {equipmentLabels, ponyArmor} from '../world/pony-armor.mjs';
import {itemStackLimit} from '../world/item-stack.mjs';

const inventorySize = 36;
const hotbarSize = 9;
const stackLimit = 64;
const version = 2;
const moduleName = 'inventory';
const itemSlot = slot => Number.isInteger(slot) && slot >= 0 && slot < inventorySize;
const anySlot = slot => itemSlot(slot) || Number.isInteger(slot) && slot >= inventorySize &&
  slot < inventorySize + equipmentLabels.length;
const quantity = count => Number.isInteger(count) && count >= 1 && count <= stackLimit;
const stackType = ({count: _, copied: _copied, ...type}) => JSON.stringify(type);
const inventoryKey = key => typeof key === 'string' && key.length > 0 && key.length <= 128;

const inventoryTypes = new Set(['inventory_select','inventory_give','inventory_move','inventory_trash','inventory_copy']);
const transportTypes = new Set(['drop_item','pickup_item']);
export const isInventoryAction = type => inventoryTypes.has(type) || transportTypes.has(type);

export function inventoryInput(body, input) {
  const {type, slot, from, to, count, key, yaw, all} = body;
  if (type === 'drop_item') {
    if (!Number.isFinite(yaw) || all !== undefined && typeof all !== 'boolean' ||
        slot !== undefined && !anySlot(slot) || key !== undefined && (!inventoryKey(key) || slot !== undefined) ||
        count !== undefined && !quantity(count)) throw new RequestError(400, 'invalid_drop');
    return {...input, yaw:yaw % (2 * Math.PI), all, slot, key, count};
  }
  if (type === 'pickup_item') return input;
  if (type === 'inventory_move') {
    if (!anySlot(from) || !anySlot(to)) throw new RequestError(400, 'invalid_inventory_slot');
    if (count !== undefined && !quantity(count)) throw new RequestError(400, 'invalid_inventory_count');
    return {...input, from, to, ...(count !== undefined && {count})};
  }
  if (!anySlot(slot) || type === 'inventory_select' && slot >= hotbarSize ||
      type === 'inventory_copy' && !itemSlot(slot)) throw new RequestError(400, 'invalid_inventory_slot');
  if (type !== 'inventory_give') return {...input, slot};
  if (!inventoryKey(key)) throw new RequestError(400, 'unknown_cell_type');
  if (count !== undefined && !quantity(count)) throw new RequestError(400, 'invalid_inventory_count');
  return {...input, slot, key, count:count ?? 1};
}

export function createInventory(store, creativeBlocks, creativeItems) {
  const read = player => {
    const stored = player && store.getState(moduleName, player, 'slots')?.value;
    return {slots:stored?.slots ?? Array(inventorySize).fill(null), selected:stored?.selected ?? 0,
      equipment:stored?.equipment ?? Array(equipmentLabels.length).fill(null)};
  };
  const write = (player, state) => {
    store.putState(moduleName, player, 'slots', version, state);
    return state;
  };

  function creativeStack(key, count) {
    if (creativeBlocks.has(key)) return {key, cell:key, count};
    const entry = creativeItems.get(key);
    if (!entry) throw new RequestError(400, 'unknown_cell_type');
    return {key, count:Math.min(count,itemStackLimit(key)), ...(entry.blockKey && {cell:entry.blockKey}),
      ...(entry.part && {part:entry.part, pattern:entry.part.pattern})};
  }

  function copiedStack(player) {
    const clipboard = store.getClipboard(player);
    if (clipboard?.part) return {key:'copy:part', count:1, copied:true, name:'Микроблок', part:clipboard.part, pattern:clipboard.pattern};
    if (!clipboard?.cell) throw new RequestError(409, 'nothing_to_copy');
    return {key:clipboard.cell, cell:clipboard.cell, count:1, copied:true, ...(clipboard.object && {object:clipboard.object})};
  }

  const stackAt = (state, slot) => itemSlot(slot) ? state.slots[slot] : state.equipment[slot-inventorySize];
  function setStack(state, slot, stack) {
    if (itemSlot(slot)) state.slots[slot] = stack;
    else state.equipment[slot-inventorySize] = stack;
  }

  function accepts(slot, stack) {
    return !stack || itemSlot(slot) || ponyArmor(stack.key)?.slot === slot-inventorySize;
  }

  function move(state, {from, to, count}) {
    const source = stackAt(state,from), target = stackAt(state,to);
    if (!source || from === to) return;
    if (!accepts(to,source)) throw new RequestError(409,'invalid_equipment');
    const transfer = Math.min(count ?? source.count, source.count);
    if (target && stackType(source) !== stackType(target)) {
      if (transfer < source.count || !accepts(from,target)) throw new RequestError(409, 'occupied_inventory_slot');
      if (!itemSlot(to) && source.count > 1) throw new RequestError(409,'occupied_inventory_slot');
      setStack(state,from,target);
      setStack(state,to,source);
      return;
    }
    const moved = Math.min(transfer, itemStackLimit(source.key) - (target?.count ?? 0));
    if (moved <= 0) return;
    setStack(state,to,{...source,count:(target?.count ?? 0) + moved});
    setStack(state,from,source.count > moved ? {...source,count:source.count-moved} : null);
  }

  function edit(player, input) {
    const state = read(player);
    const {type, slot, key, count} = input;
    if (type === 'inventory_select') state.selected = slot;
    else if (type === 'inventory_move') move(state, input);
    else if (type === 'inventory_trash') setStack(state,slot,null);
    else {
      const stack = type === 'inventory_copy' ? copiedStack(player) : creativeStack(key, count);
      if (!accepts(slot,stack)) throw new RequestError(409,'invalid_equipment');
      setStack(state,slot,stack);
      if (type === 'inventory_copy' && slot < hotbarSize) state.selected = slot;
    }
    return write(player, state);
  }

  function take(player, input) {
    const state = read(player);
    const {slot = state.selected, all, key, count} = typeof input === 'object' && input !== null ? input : {all:input};
    if (key !== undefined) {
      return {stack:creativeStack(key,count ?? (all ? stackLimit : 1)), inventory:state};
    }
    const stack = stackAt(state,slot);
    if (!stack) throw new RequestError(409, 'empty_inventory_slot');
    const taken = Math.min(stack.count,count ?? (all ? stack.count : 1));
    setStack(state,slot,taken < stack.count ? {...stack,count:stack.count-taken} : null);
    return {stack:{...stack,count:taken}, inventory:write(player, state)};
  }

  function insert(state,stack) {
    const key = stackType(stack);
    const limit = itemStackLimit(stack.key);
    let left = stack.count;
    for (let slot = 0; slot < inventorySize && left; slot++) {
      const previous = state.slots[slot];
      if (!previous || stackType(previous) !== key || previous.count >= limit) continue;
      const amount = Math.min(left, limit - previous.count);
      state.slots[slot] = {...previous, count:previous.count + amount};
      left -= amount;
    }
    while (left > 0) {
      const free = state.slots.indexOf(null);
      if (free === -1) break;
      const amount = Math.min(left,limit);
      state.slots[free] = {...stack,count:amount};
      left -= amount;
    }
    return left;
  }

  function put(player, stack) {
    const state = read(player);
    if (insert(state,stack)) throw new RequestError(409, 'inventory_full');
    return write(player, state);
  }

  function replaceSelectedOne(player,key) {
    const state = read(player);
    const source = state.slots[state.selected];
    if (!source) throw new RequestError(409,'empty_inventory_slot');
    const output = creativeStack(key,1);
    if (source.count === 1) state.slots[state.selected] = output;
    else {
      state.slots[state.selected] = {...source,count:source.count-1};
      if (insert(state,output)) throw new RequestError(409,'inventory_full');
    }
    return write(player,state);
  }
  function selected(player) {
    const state = read(player);
    return state.slots[state.selected];
  }
  return {read, edit, take, put, selected, replaceSelectedOne};
}
