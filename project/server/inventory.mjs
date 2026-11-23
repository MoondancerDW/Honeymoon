import {RequestError} from './errors.mjs';
import {equipmentLabels, ponyEquipment} from '../world/pony-armor.mjs';
import {itemStackLimit,offhandSlot} from '../world/item-stack.mjs';
import {bookPageLimit,bookPages,bookPagesLimit,bookTitleLimit,bookType,itemNameLimit,loreLimit,loreLineLimit,
  stackRevision,stackType,writtenBook} from '../world/item-text.mjs';

const inventorySize = 36;
const hotbarSize = 9;
const stackLimit = 64;
const version = 3;
const moduleName = 'inventory';
const itemSlot = slot => Number.isInteger(slot) && slot >= 0 && slot < inventorySize;
const anySlot = slot => Number.isInteger(slot) && slot >= 0 && slot <= offhandSlot;
const equipmentSlot = slot => slot >= inventorySize && slot < offhandSlot;
const quantity = count => Number.isInteger(count) && count >= 1 && count <= stackLimit;
const inventoryKey = key => typeof key === 'string' && key.length > 0 && key.length <= 128;

const documentActions=new Set(['inventory_annotate','inventory_book_page','inventory_book_sign']);
const inventoryTypes = new Set(['inventory_select','inventory_give','inventory_move','inventory_trash','inventory_copy',
  'inventory_clone','inventory_swap_hands',...documentActions]);
const transportTypes = new Set(['drop_item','pickup_item']);
export const isInventoryAction = type => inventoryTypes.has(type) || transportTypes.has(type);

export function inventoryInput(body, input) {
  const {type, slot, from, to, count, key, yaw, all,clone} = body;
  if (type === 'drop_item') {
    if (!Number.isFinite(yaw) || all !== undefined && typeof all !== 'boolean' ||
        slot !== undefined && !anySlot(slot) || key !== undefined && (!inventoryKey(key) || slot !== undefined) ||
        count !== undefined && !quantity(count) || clone !== undefined && (clone!==true || !anySlot(slot) || key!==undefined)) {
      throw new RequestError(400, 'invalid_drop');
    }
    return {...input, yaw:yaw % (2 * Math.PI), all, slot, key, count,clone};
  }
  if (type === 'pickup_item' || type === 'inventory_swap_hands') return input;
  if (type === 'inventory_move' || type === 'inventory_clone') {
    if (!anySlot(from) || !anySlot(to)) throw new RequestError(400, 'invalid_inventory_slot');
    if (count !== undefined && !quantity(count)) throw new RequestError(400, 'invalid_inventory_count');
    return {...input, from, to, ...(count !== undefined && {count})};
  }
  if (documentActions.has(type)) {
    const validText=(value,cap,multiline=false)=>typeof value==='string' && value.length<=cap &&
      !(multiline ? /[\u0000-\u0008\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value);
    if (!anySlot(slot) || !/^[\da-f]{16}$/.test(body.expected??'')) throw new RequestError(400,'invalid_inventory_slot');
    const document={...input,slot,expected:body.expected};
    if (type==='inventory_annotate') {
      if (!validText(body.name,itemNameLimit) || !Array.isArray(body.lore) || body.lore.length>loreLineLimit ||
          body.lore.some(line=>!validText(line,loreLimit)) || body.lore.join('\n').length>loreLimit) {
        throw new RequestError(400,'invalid_item_text');
      }
      return {...document,name:body.name,lore:body.lore};
    }
    if (type==='inventory_book_sign') {
      if (!validText(body.title,bookTitleLimit) || !body.title.trim()) throw new RequestError(400,'invalid_book_title');
      return {...document,title:body.title.trim()};
    }
    if (!Number.isInteger(body.page) || body.page<0 || body.page>=bookPagesLimit ||
        !validText(body.text,bookPageLimit,true)) throw new RequestError(400,'invalid_book_page');
    return {...document,page:body.page,text:body.text};
  }
  if (!anySlot(slot) || type === 'inventory_select' && slot >= hotbarSize ||
      type === 'inventory_copy' && !itemSlot(slot)) throw new RequestError(400, 'invalid_inventory_slot');
  if (type !== 'inventory_give') return {...input, slot};
  if (!inventoryKey(key)) throw new RequestError(400, 'unknown_cell_type');
  if (count !== undefined && !quantity(count)) throw new RequestError(400, 'invalid_inventory_count');
  return {...input, slot, key, count:count ?? 1};
}

export function createInventory(store, creativeBlocks, creativeItems, {canOffhand = () => false} = {}) {
  const read = player => {
    const stored = player && store.getState(moduleName, player, 'slots')?.value;
    return {slots:stored?.slots ?? Array(inventorySize).fill(null), selected:stored?.selected ?? 0,
      equipment:stored?.equipment ?? Array(equipmentLabels.length).fill(null), offhand:stored?.offhand ?? null};
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

  function copyToFreeSlot(player, preferred) {
    const state = read(player);
    const stack = copiedStack(player);
    const identity = stackType(stack);
    const same = state.slots.findIndex(item => item && stackType(item) === identity);
    const emptyHotbar = state.slots.slice(0, hotbarSize).findIndex(item => !item);
    const hotbar = !state.slots[preferred] && preferred < hotbarSize ? preferred : emptyHotbar;
    if (same >= 0 && same < hotbarSize) {
      state.selected = same;
      return {inventory:write(player,state)};
    }
    if (hotbar >= 0) {
      state.slots[hotbar] = same >= 0 ? state.slots[same] : stack;
      if (same >= 0) state.slots[same] = null;
      state.selected = hotbar;
      return {inventory:write(player,state)};
    }
    if (same >= 0) return {inventory:state, copiedToBackpack:true};
    const backpack = state.slots.findIndex(item => !item);
    if (backpack < 0) throw new RequestError(409,'inventory_full');
    state.slots[backpack] = stack;
    return {inventory:write(player,state), copiedToBackpack:true};
  }

  function requireOffhand(player, {type,slot,from,to}) {
    if ((type === 'inventory_swap_hands' || slot === offhandSlot || from === offhandSlot || to === offhandSlot) &&
        !canOffhand(player)) throw new RequestError(403,'offhand_unavailable');
  }

  const stackAt = (state, slot) => slot === offhandSlot ? state.offhand :
    itemSlot(slot) ? state.slots[slot] : state.equipment[slot-inventorySize];
  function setStack(state, slot, stack) {
    if (slot === offhandSlot) state.offhand = stack;
    else if (itemSlot(slot)) state.slots[slot] = stack;
    else state.equipment[slot-inventorySize] = stack;
  }

  function accepts(slot, stack) {
    return !stack || itemSlot(slot) || slot === offhandSlot || ponyEquipment(stack.key)?.slot === slot-inventorySize;
  }

  function move(state, {from, to, count}) {
    const source = stackAt(state,from), target = stackAt(state,to);
    if (!source || from === to) return;
    if (!accepts(to,source)) throw new RequestError(409,'invalid_equipment');
    const transfer = Math.min(count ?? source.count, source.count);
    if (target && stackType(source) !== stackType(target)) {
      if (transfer < source.count || !accepts(from,target)) throw new RequestError(409, 'occupied_inventory_slot');
      if (equipmentSlot(to) && source.count > 1) throw new RequestError(409,'occupied_inventory_slot');
      setStack(state,from,target);
      setStack(state,to,source);
      return;
    }
    const moved = Math.min(transfer, itemStackLimit(source.key) - (target?.count ?? 0));
    if (moved <= 0) return;
    setStack(state,to,{...source,count:(target?.count ?? 0) + moved});
    setStack(state,from,source.count > moved ? {...source,count:source.count-moved} : null);
  }

  function cloneStack(state, {from,to,count}) {
    const source=stackAt(state,from),target=stackAt(state,to);
    if (!source) throw new RequestError(409,'empty_inventory_slot');
    if (!accepts(to,source)) throw new RequestError(409,'invalid_equipment');
    if (target && stackType(source)!==stackType(target)) throw new RequestError(409,'occupied_inventory_slot');
    const limit=itemStackLimit(source.key);
    setStack(state,to,{...source,count:Math.min(limit,(target?.count??0)+(count??limit))});
  }

  function updateDocument(player,state,input) {
    const {slot,expected,type}=input;
    const stack=stackAt(state,slot);
    if (!stack || stackRevision(stack)!==expected) throw new RequestError(409,'stale_inventory_item',{inventory:state});
    const nbt={...stack.nbt};
    if (type==='inventory_annotate') {
      const display={...nbt.display};
      if (input.name) display.Name=input.name; else delete display.Name;
      if (input.lore.some(Boolean)) display.Lore=input.lore; else delete display.Lore;
      if (Object.keys(display).length) nbt.display=display; else delete nbt.display;
    } else {
      if (bookType(stack)!=='draft') throw new RequestError(409,'book_already_signed');
      if (type==='inventory_book_sign') {
        nbt.title=input.title;
        nbt.author=store.getProfile(player)?.nickname || 'Гость';
        nbt.pages=bookPages(stack);
        setStack(state,slot,{...stack,key:writtenBook,count:1,nbt,damage:0});
        return;
      }
      const pages=[...bookPages(stack)];
      while (pages.length<=input.page) pages.push('');
      pages[input.page]=input.text;
      nbt.pages=pages;
    }
    const changed={...stack};
    if (Object.keys(nbt).length) changed.nbt=nbt; else delete changed.nbt;
    setStack(state,slot,changed);
  }

  function edit(player, input) {
    requireOffhand(player,input);
    const state = read(player);
    const {type, slot, key, count} = input;
    if (type === 'inventory_copy') return copyToFreeSlot(player,slot).inventory;
    if (type === 'inventory_select') state.selected = slot;
    else if (type === 'inventory_swap_hands') {
      const main = stackAt(state,state.selected);
      setStack(state,state.selected,state.offhand);
      state.offhand = main;
    }
    else if (type === 'inventory_move') move(state, input);
    else if (type === 'inventory_clone') cloneStack(state,input);
    else if (documentActions.has(type)) updateDocument(player,state,input);
    else if (type === 'inventory_trash') setStack(state,slot,null);
    else {
      const stack = creativeStack(key, count);
      if (!accepts(slot,stack)) throw new RequestError(409,'invalid_equipment');
      setStack(state,slot,stack);
    }
    return write(player, state);
  }

  function take(player, input) {
    const state = read(player);
    const {slot = state.selected, all, key, count,clone} = typeof input === 'object' && input !== null ? input : {all:input};
    requireOffhand(player,{slot});
    if (key !== undefined) {
      return {stack:creativeStack(key,count ?? (all ? stackLimit : 1)), inventory:state};
    }
    const stack = stackAt(state,slot);
    if (!stack) throw new RequestError(409, 'empty_inventory_slot');
    if (clone) return {stack:{...stack,count:Math.min(count??itemStackLimit(stack.key),itemStackLimit(stack.key))},inventory:state};
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
  return {read, edit, take, put, selected, copyToFreeSlot, replaceSelectedOne,replace:write,stackAt,setStack,accepts,insert};
}
