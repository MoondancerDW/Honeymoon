import {RequestError} from './errors.mjs';

const inventorySize = 36;
const hotbarSize = 9;
const stackLimit = 64;
const version = 1;
const moduleName = 'inventory';
const itemSlot = slot => Number.isInteger(slot) && slot >= 0 && slot < inventorySize;
const quantity = count => Number.isInteger(count) && count >= 1 && count <= stackLimit;
const stackType = ({count: _, copied: _copied, ...type}) => JSON.stringify(type);

const inventoryTypes = new Set(['inventory_select','inventory_give','inventory_move','inventory_trash','inventory_copy']);
const transportTypes = new Set(['drop_item','pickup_item']);
export const isInventoryAction = type => inventoryTypes.has(type) || transportTypes.has(type);

export function inventoryInput(body, input) {
  const {type, slot, from, to, count, key, yaw, all} = body;
  if (type === 'drop_item') {
    if (!Number.isFinite(yaw) || all !== undefined && typeof all !== 'boolean') throw new RequestError(400, 'invalid_drop');
    return {...input, yaw:yaw % (2 * Math.PI), ...(all && {all:true})};
  }
  if (type === 'pickup_item') return input;
  if (type === 'inventory_move') {
    if (!itemSlot(from) || !itemSlot(to)) throw new RequestError(400, 'invalid_inventory_slot');
    if (count !== undefined && !quantity(count)) throw new RequestError(400, 'invalid_inventory_count');
    return {...input, from, to, ...(count !== undefined && {count})};
  }
  if (!itemSlot(slot) || type === 'inventory_select' && slot >= hotbarSize) throw new RequestError(400, 'invalid_inventory_slot');
  if (type !== 'inventory_give') return {...input, slot};
  if (typeof key !== 'string' || key.length > 128) throw new RequestError(400, 'unknown_cell_type');
  if (count !== undefined && !quantity(count)) throw new RequestError(400, 'invalid_inventory_count');
  return {...input, slot, key, count:count ?? 1};
}

export function createInventory(store, creativeBlocks, creativeItems) {
  const read = player => (player && store.getState(moduleName, player, 'slots')?.value) ??
    {slots:Array(inventorySize).fill(null), selected:0};
  const write = (player, state) => {
    store.putState(moduleName, player, 'slots', version, state);
    return state;
  };

  function creativeStack(key, count) {
    if (creativeBlocks.has(key)) return {key, cell:key, count};
    const entry = creativeItems.get(key);
    if (!entry) throw new RequestError(400, 'unknown_cell_type');
    return {key, count, ...(entry.blockKey && {cell:entry.blockKey}),
      ...(entry.part && {part:entry.part, pattern:entry.part.pattern})};
  }

  function copiedStack(player) {
    const clipboard = store.getClipboard(player);
    if (clipboard?.part) return {key:'copy:part', count:1, copied:true, name:'Микроблок', part:clipboard.part, pattern:clipboard.pattern};
    if (!clipboard?.cell) throw new RequestError(409, 'nothing_to_copy');
    return {key:clipboard.cell, cell:clipboard.cell, count:1, copied:true, ...(clipboard.object && {object:clipboard.object})};
  }

  function move(state, {from, to, count}) {
    const source = state.slots[from], target = state.slots[to];
    if (!source || from === to) return;
    const transfer = Math.min(count ?? source.count, source.count);
    if (target && stackType(source) !== stackType(target)) {
      if (transfer < source.count) throw new RequestError(409, 'occupied_inventory_slot');
      state.slots[from] = target;
      state.slots[to] = source;
      return;
    }
    const moved = Math.min(transfer, stackLimit - (target?.count ?? 0));
    state.slots[to] = {...source, count:(target?.count ?? 0) + moved};
    state.slots[from] = source.count > moved ? {...source, count:source.count - moved} : null;
  }

  function edit(player, input) {
    const state = read(player);
    const {type, slot, key, count} = input;
    if (type === 'inventory_select') state.selected = slot;
    else if (type === 'inventory_move') move(state, input);
    else if (type === 'inventory_trash') state.slots[slot] = null;
    else {
      state.slots[slot] = type === 'inventory_copy' ? copiedStack(player) : creativeStack(key, count);
      if (slot < hotbarSize) state.selected = slot;
    }
    return write(player, state);
  }

  function take(player, all) {
    const state = read(player);
    const stack = state.slots[state.selected];
    if (!stack) throw new RequestError(409, 'empty_inventory_slot');
    const count = all ? stack.count : 1;
    state.slots[state.selected] = count < stack.count ? {...stack, count:stack.count - count} : null;
    return {stack:{...stack, count}, inventory:write(player, state)};
  }

  function put(player, stack) {
    const state = read(player);
    const key = stackType(stack);
    let left = stack.count;
    for (let slot = 0; slot < inventorySize && left; slot++) {
      const previous = state.slots[slot];
      if (!previous || stackType(previous) !== key || previous.count >= stackLimit) continue;
      const amount = Math.min(left, stackLimit - previous.count);
      state.slots[slot] = {...previous, count:previous.count + amount};
      left -= amount;
    }
    if (left) {
      const free = state.slots.indexOf(null);
      if (free === -1) throw new RequestError(409, 'inventory_full');
      state.slots[free] = {...stack, count:left};
    }
    return write(player, state);
  }
  function selected(player) {
    const state = read(player);
    return state.slots[state.selected];
  }
  return {read, edit, take, put, selected};
}
