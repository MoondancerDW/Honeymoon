import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createInventory,inventoryInput} from './inventory.mjs';
import {bucketKeys} from '../world/fluid-state.mjs';

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
  assert.throws(()=>inventoryInput({type:'drop_item',slot:40,yaw:0},{}),error=>error.code === 'invalid_drop');
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
