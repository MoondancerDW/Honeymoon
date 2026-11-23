import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createInventory,inventoryInput} from './inventory.mjs';
import {bucketKeys} from '../world/fluid-state.mjs';
import {offhandSlot} from '../world/item-stack.mjs';
import {offhandAppearance} from '../world/item-appearance.mjs';
import {heldLightLevel} from '../world/held-light.mjs';

test('older inventories gain equipment and armor only moves to the matching slot',()=>{
  const helmet = 'creative:306:0', leggings = 'creative:308:0', stone = 'legacy:1:0';
  let value = {selected:0,slots:Array(36).fill(null)};
  value.slots[0] = {key:stone,cell:stone,count:2};
  const store = {getState:()=>({value:structuredClone(value)}),
    putState(_module,_player,_record,_version,state) { value = structuredClone(state); }};
  const player = 'player';
  const inventory = createInventory(store,new Set([stone]),new Map([[helmet,{}],[leggings,{}]]));
  assert.deepEqual(inventory.read(player).equipment,[null,null,null,null]);
  assert.throws(()=>inventory.edit(player,{type:'inventory_move',from:0,to:36}),
    error=>error.code === 'invalid_equipment');
  inventory.edit(player,{type:'inventory_give',slot:5,key:helmet,count:64});
  assert.equal(inventory.read(player).slots[5].count,1);
  assert.throws(()=>inventory.edit(player,{type:'inventory_give',slot:36,key:leggings,count:1}),
    error=>error.code === 'invalid_equipment');
  const wearing = inventory.edit(player,{type:'inventory_move',from:5,to:36});
  assert.equal(wearing.slots[5],null);
  assert.deepEqual(wearing.equipment[0],{key:helmet,count:1});
  assert.equal(inventory.take(player,{slot:36,all:true}).stack.key,helmet);
  assert.equal(inventory.read(player).equipment[0],null);
  assert.equal(inventory.take(player,{key:leggings,count:1}).stack.key,leggings);
  assert.equal(inventory.read(player).slots[0].count,2);
  assert.throws(()=>inventoryInput({type:'drop_item',slot:offhandSlot+1,yaw:0},{}),error=>error.code === 'invalid_drop');
});

test('Lilium headwear and pendants use their equipment slots and keep their original item data',()=>{
  const hood='creative:5930:0', glasses='creative:6293:0', pendant='creative:5872:0';
  let value={selected:0,slots:Array(36).fill(null)};
  value.slots[0]={key:hood,count:1};
  value.slots[1]={key:pendant,count:1,nbt:{display:{Name:'Амулет'}}};
  value.slots[2]={key:glasses,count:1};
  const store={getState:()=>({value:structuredClone(value)}),
    putState(_module,_player,_record,_version,state) {value=structuredClone(state);}};
  const inventory=createInventory(store,new Set(),new Map());
  const move=(from,to)=>inventory.edit('pony',{type:'inventory_move',from,to});
  assert.throws(()=>move(1,36),{code:'invalid_equipment'});
  assert.throws(()=>move(0,37),{code:'invalid_equipment'});
  assert.equal(move(0,36).equipment[0].key,hood);
  assert.equal(move(1,37).equipment[1].nbt.display.Name,'Амулет');
  const worn=move(2,36);
  assert.equal(worn.equipment[0].key,glasses);
  assert.equal(worn.slots[2].key,hood);
  assert.equal(worn.slots[0],null);
  assert.equal(worn.slots[1],null);
  assert.equal(move(37,1).slots[1].key,pendant);
});

test('the second hand stores full stacks and hides access when the player loses the horn',()=>{
  const torch={key:'legacy:50:0',cell:'legacy:50:0',count:32};
  const book={key:'creative:387:0',count:1,damage:2,nbt:{pages:['Текст'],title:'Журнал',author:'Пони'}};
  let value={slots:Array(36).fill(null),selected:3};
  value.slots[3]=book;
  value.slots[12]=torch;
  let horn = false;
  const store = {getState:()=>({value:structuredClone(value)}),
    putState(_module,_player,_record,_version,state) { value=structuredClone(state); }};
  const inventory=createInventory(store,new Set(),new Map(),{canOffhand:()=>horn});
  const move={type:'inventory_move',from:12,to:offhandSlot};
  const swap={type:'inventory_swap_hands'};
  assert.equal(inventory.read('pony').offhand,null);
  assert.throws(()=>inventory.edit('pony',move),{code:'offhand_unavailable'});
  assert.throws(()=>inventory.edit('pony',swap),{code:'offhand_unavailable'});
  horn = true;
  const equipped=inventory.edit('pony',move);
  assert.deepEqual(equipped.offhand,torch);
  assert.equal(heldLightLevel(offhandAppearance(equipped.offhand)),14);
  assert.equal(equipped.slots[12],null);
  const swapped=inventory.edit('pony',swap);
  assert.equal(swapped.selected,3);
  assert.deepEqual(swapped.slots[3],torch);
  assert.deepEqual(swapped.offhand,book);
  horn = false;
  assert.throws(()=>inventory.take('pony',{slot:offhandSlot,all:true}),{code:'offhand_unavailable'});
  assert.throws(()=>inventory.edit('pony',{type:'inventory_trash',slot:offhandSlot}),{code:'offhand_unavailable'});
  assert.deepEqual(inventory.read('pony').offhand,book);
  horn = true;
  assert.deepEqual(inventory.edit('pony',swap).slots[3],book);
});

test('filling a bucket preserves the remaining empty buckets and rejects a full inventory atomically',()=>{
  const {empty,water} = bucketKeys;
  let value;
  const store = {getState:()=>value && ({value:structuredClone(value)}),
    putState(_module,_player,_record,_version,state) { value = structuredClone(state); }};
  const inventory = createInventory(store,new Set(),new Map([[empty,{}],[water,{}]]));
  inventory.edit('player',{type:'inventory_give',slot:0,key:empty,count:64});
  assert.equal(value.slots[0].count,16);
  assert.equal(inventory.replaceSelectedOne('player',water).slots[1].count,1);
  assert.equal(value.slots[0].count,15);
  for (let slot=2;slot<36;slot++) inventory.edit('player',{type:'inventory_give',slot,key:water,count:64});
  assert.equal(value.slots[35].count,1);
  assert.throws(()=>inventory.replaceSelectedOne('player',water), error=>error.code === 'inventory_full');
  assert.equal(value.slots[0].count,15);
});
