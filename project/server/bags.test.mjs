import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as geometry from '../world/geometry.mjs';
import {bagKind,itemStackLimit,itemStackPortion} from '../world/item-stack.mjs';
import {bagMoveInput,bagOpenInput,createBags} from './bags.mjs';
import {createContainers} from './containers.mjs';
import {createGame} from './game.mjs';
import {createInventory} from './inventory.mjs';
import {openStore} from './store.mjs';

const canvas='creative:9268:0';
const canvasRed='creative:9268:14';
const seed='creative:9299:0';
const wheat='creative:295:0';
const pumpkin='creative:361:0';
const stone='legacy:1:0';
const player='bag-player';
const bagSlot=10;
const inv=slot=>({side:'inventory',slot});
const inside=slot=>({side:'storage',slot});

function fixture(t,{bag,extra={},selected=0}) {
  const creativeBlocks=new Set([stone]);
  const creativeItems=new Map([canvas,canvasRed,seed,wheat,pumpkin].map(key=>[key,{}]));
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const inventory=createInventory(store,creativeBlocks,creativeItems);
  const state=inventory.read(player);
  state.selected=selected;
  state.slots[bagSlot]=bag;
  for (const [slot,stack] of Object.entries(extra)) state.slots[slot]=stack;
  inventory.replace(player,state);
  const bags=createBags({inventory,creativeBlocks,creativeItems});
  function open() {return bags.open(player,{slot:bagSlot});}
  function move(from,to,count,version=open().bag.version) {
    const input=bagMoveInput({slot:bagSlot,version,from,to,count},{type:'bag_move'});
    return store.atomic(()=>bags.move(player,input));
  }
  return {bags,inventory,open,move,store,creativeBlocks,creativeItems};
}

test('native bag types have one item per stack and action inputs validate the owning slot',()=>{
  assert.equal(bagKind(canvasRed),'canvas');
  assert.equal(bagKind('creative:9268:16'),undefined);
  assert.equal(bagKind('creative:9299:576'),'seed');
  assert.equal(bagKind('creative:9299:577'),undefined);
  assert.equal(itemStackLimit(canvasRed),1);
  assert.equal(itemStackLimit('creative:9299:576'),1);
  assert.deepEqual(bagOpenInput({slot:35},{type:'bag_open'}),{type:'bag_open',slot:35});
  assert.throws(()=>bagOpenInput({slot:36},{}),{code:'invalid_inventory_slot'});
  assert.throws(()=>bagMoveInput({slot:1,version:'short',from:inv(1),to:inside(0)},{}),{code:'invalid_bag_version'});
});

test('imports a coloured Canvas Bag and preserves bag tag and nested item metadata through split and merge',t=>{
  const display={Name:'Сумка путешественника',Lore:['Первая сумка']};
  const tag={display:{Name:'Старый камень'},custom:{rows:[{test:1},{test:2}]}};
  const contents=[{Slot:26,id:1,Damage:0,Count:9,tag,other:{flags:[2,3]}}];
  const {open,move,inventory}=fixture(t,{bag:{key:canvasRed,count:1,nbt:{display,contents,foreign:{a:1}}}});
  const initial=open();
  assert.equal(initial.bag.size,27);
  assert.equal(initial.bag.inventorySlot,bagSlot);
  assert.equal(initial.bag.title,display.Name);
  assert.equal(initial.bag.slots[26].count,9);
  const split=move(inside(26),inv(2),4);
  assert.equal(split.bag.slots[26].count,5);
  assert.deepEqual(split.inventory.slots[2],{key:stone,cell:stone,count:4,nbt:tag,legacyNbt:{other:{flags:[2,3]}}});
  const merged=move(inv(2),inside(26));
  assert.equal(merged.inventory.slots[2],null);
  assert.deepEqual(inventory.read(player).slots[bagSlot].nbt,{display,contents,foreign:{a:1}});
});

test('Canvas Bag protects its active slot from moves, rejects nesting in any Canvas Bag colour and keeps a Seed Bag with its contents',t=>{
  const seedStack={key:'creative:9299:572',count:1,nbt:{contents:[{Slot:0,id:295,Damage:0,Count:5}]}};
  const {move,open}=fixture(t,{bag:{key:canvas,count:1},extra:{0:{key:canvasRed,count:1},1:seedStack}});
  assert.throws(()=>move(inv(bagSlot),inside(0)),{code:'bag_slot_locked'});
  assert.throws(()=>move(inv(0),inside(0)),{code:'bag_nesting'});
  const result=move(inv(1),inside(0));
  assert.deepEqual(result.bag.slots[0],seedStack);
  assert.deepEqual(open().inventory.slots[bagSlot].nbt.contents,[{Slot:0,id:9299,Damage:572,Count:1,tag:seedStack.nbt}]);
  assert.deepEqual(move(inside(0),inv(1)).inventory.slots[1],seedStack);
});

test('a stale bag version rejects a delayed move after another inventory change',t=>{
  const {move,open,inventory}=fixture(t,{bag:{key:canvas,count:1},extra:{0:{key:stone,cell:stone,count:5}}});
  const initial=open();
  const state=inventory.read(player);
  state.slots[0].count=2;
  inventory.replace(player,state);
  assert.throws(()=>move(inv(0),inside(0),2,initial.bag.version),error=>{
    assert.equal(error.code,'stale_bag');
    assert.equal(error.details.inventory.slots[0].count,2);
    assert.notEqual(error.details.bag.version,initial.bag.version);
    return true;
  });
  assert.deepEqual(open().bag.slots,Array(27).fill(null));
});

test('Seed Bag accepts only one plantable variety without merging unlike tags and counts seeds in native slot order',t=>{
  const tagA={display:{Name:'Первый посев'}};
  const tagB={display:{Name:'Второй посев'}};
  const {bags,open,move,inventory}=fixture(t,{bag:{key:seed,count:1},extra:{
    0:{key:wheat,count:3,nbt:tagA},1:{key:wheat,count:4,nbt:tagB},2:{key:pumpkin,count:2},3:{key:stone,cell:stone,count:5},
  }});
  assert.equal(open().bag.size,9);
  assert.throws(()=>move(inv(3),inside(1)),{code:'wrong_bag_item'});
  assert.throws(()=>move(inv(0),inside(9)),{code:'invalid_inventory_slot'});
  assert.equal(move(inv(0),inside(0)).bag.key,'creative:9299:574');
  assert.throws(()=>move(inv(2),inside(1)),{code:'wrong_bag_item'});
  assert.throws(()=>move(inv(1),inside(0),1),{code:'occupied_inventory_slot'});
  assert.equal(move(inv(1),inside(8)).bag.key,'creative:9299:570');
  assert.deepEqual(bags.seedContents(player,bagSlot),{key:wheat,count:7,slot:bagSlot,stack:{key:wheat,count:3,nbt:tagA}});
  assert.throws(()=>bags.consumeSeeds(player,{key:wheat,slot:bagSlot,count:8}),{code:'not_enough_seeds'});
  assert.equal(bags.seedContents(player,bagSlot).count,7);
  bags.consumeSeeds(player,{key:wheat,slot:bagSlot,count:5});
  const stored=inventory.read(player).slots[bagSlot];
  assert.equal(stored.key,'creative:9299:575');
  assert.deepEqual(stored.nbt.contents,[{Slot:8,id:295,Damage:0,Count:2,tag:tagB}]);
  bags.consumeSeeds(player,{key:wheat,slot:bagSlot,count:2});
  assert.equal(open().bag.key,seed);
  assert.equal(bags.seedContents(player,bagSlot),undefined);
});

test('existing invalid rows are either preserved or rejected without rewriting the bag',t=>{
  const unknown={Slot:44,id:1,Count:15,extra:{test:true}};
  const {bags,move,inventory}=fixture(t,{bag:{key:canvas,count:1,nbt:{contents:[unknown]}},
    extra:{0:{key:stone,cell:stone,count:5}},selected:0});
  assert.throws(()=>bags.open(player),{code:'not_a_bag'});
  const after=move(inv(0),inside(0));
  assert.deepEqual(after.inventory.slots[bagSlot].nbt.contents,[{Slot:0,id:1,Damage:0,Count:5},unknown]);
  const state=inventory.read(player);
  state.slots[bagSlot].nbt.contents.push({Slot:0,id:1,Count:2});
  inventory.replace(player,state);
  assert.throws(()=>bags.open(player,{slot:bagSlot}),{code:'invalid_bag_contents'});
  assert.deepEqual(inventory.read(player),state);
});

test('a saved Canvas Bag aggregate opens and retains its only contents on partial inventory moves and drops',t=>{
  const display={Name:'Старая сумка'};
  const contents=[{Slot:2,id:1,Damage:0,Count:7,tag:{quality:1}}];
  const {inventory,open,move}=fixture(t,{bag:{key:canvasRed,count:61,nbt:{display,contents}}});
  assert.equal(open().bag.slots[2].count,7);
  assert.deepEqual(open().inventory.slots[bagSlot],{key:canvasRed,count:61,nbt:{display,contents}});
  const pulled=move(inside(2),inv(3),1);
  assert.equal(pulled.inventory.slots[bagSlot].count,61);
  assert.equal(pulled.bag.slots[2].count,6);
  const remaining={display,contents:[{...contents[0],Count:6}]};
  const split=inventory.edit(player,{type:'inventory_move',from:bagSlot,to:1,count:1});
  assert.deepEqual(split.slots[1],{key:canvasRed,count:1,nbt:{display}});
  assert.deepEqual(split.slots[bagSlot],{key:canvasRed,count:60,nbt:remaining});
  const dropped=inventory.take(player,{slot:bagSlot,count:1});
  assert.deepEqual(dropped.stack,{key:canvasRed,count:1,nbt:{display}});
  assert.deepEqual(dropped.inventory.slots[bagSlot],{key:canvasRed,count:59,nbt:remaining});
  const last=inventory.take(player,{slot:bagSlot,all:true});
  assert.deepEqual(last.stack,{key:canvasRed,count:59,nbt:remaining});
  assert.equal(last.inventory.slots[bagSlot],null);
});

test('splitting and reinserting a Seed Bag aggregate transfers exactly one native contents list',t=>{
  const contents=[{Slot:7,id:295,Damage:0,Count:5,tag:{quality:2}}];
  const display={Name:'Старый мешочек'};
  const aggregate={key:'creative:9299:572',damage:572,count:3,nbt:{contents,display}};
  const blank={key:seed,damage:0,count:1,nbt:{display}};
  assert.deepEqual(itemStackPortion(aggregate,1),blank);
  assert.deepEqual(itemStackPortion(aggregate,3),aggregate);
  const {inventory}=fixture(t,{bag:{key:canvas,count:1}});
  const result=inventory.put(player,aggregate);
  assert.deepEqual(result.slots.slice(0,3),[blank,blank,{...aggregate,count:1}]);
  assert.deepEqual(aggregate.nbt.contents,contents);
});

test('part of a stored bag aggregate stays empty when withdrawn through either container type',t=>{
  const tag={display:{Name:'Внутренняя сумка'},contents:[{Slot:0,id:295,Damage:0,Count:2}]};
  const stored={id:9299,Damage:575,Count:62,Slot:0,tag};
  const {move,inventory,store,creativeBlocks,creativeItems}=fixture(t,{bag:{key:canvas,count:1,nbt:{contents:[stored]}}});
  const blank={key:seed,count:1,nbt:{display:tag.display}};
  const fromCanvas=move(inside(0),inv(1));
  assert.deepEqual(fromCanvas.inventory.slots[1],blank);
  assert.deepEqual(fromCanvas.inventory.slots[bagSlot].nbt.contents,[{...stored,Count:61}]);

  const current={x:2,y:3,z:4,cell:'legacy:54:3',revision:0,
    object:{key:'tile:2:3:4',type:'Chest',position:[2,3,4],data:{Items:[stored]}}};
  const getCell=(x,y,z)=>x===2&&y===3&&z===4?current:{x,y,z,cell:null};
  const containers=createContainers({store,inventory,creativeBlocks,creativeItems,getCell});
  const {container}=containers.response(player,{type:'container_read',x:2,y:3,z:4,containerView:'details'});
  const plan=containers.prepare(player,current,{type:'container_move',from:inside(0),to:inv(2),version:container.version});
  assert.deepEqual(inventory.read(player).slots[2],blank);
  assert.deepEqual(plan.cells[0].object.data.Items,[{...stored,Count:61}]);
});

test('bag action receipts safely retry a move without applying it twice',t=>{
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const player=store.createPlayer().id;
  const bounds={minX:0,maxX:15,minY:0,maxY:15,minZ:0,maxZ:15};
  const base={hash:'bag-qa',manifest:{bounds,spawn:[8.5,1,8.5],compositions:{},palette:['air',stone]},
    catalog:new Set(['air',stone]),inBounds:(x,y,z)=>[x,y,z].every(n=>n>=0&&n<16),
    getCell:(_x,y,_z)=>({key:y===0?stone:'air',object:null})};
  const game=createGame(base,store,geometry,{modules:[],creativeBlocks:new Set([stone]),creativeItems:new Map([[canvas,{}]])});
  assert.equal(game.action(player,{requestId:'bag-receipt-bag',type:'inventory_give',slot:0,key:canvas,count:1}).status,200);
  assert.equal(game.action(player,{requestId:'bag-receipt-stone',type:'inventory_give',slot:1,key:stone,count:5}).status,200);
  const opened=game.action(player,{requestId:'bag-receipt-open',type:'bag_open'});
  assert.equal(opened.status,200);
  const input={requestId:'bag-receipt-move',type:'bag_move',slot:0,version:opened.output.bag.version,from:inv(1),to:inside(4),count:2};
  const moved=game.action(player,input);
  assert.equal(moved.status,200);
  assert.equal(moved.output.inventory.slots[1].count,3);
  assert.equal(moved.output.bag.slots[4].count,2);
  const replay=game.action(player,input);
  assert.equal(replay.replay,true);
  assert.deepEqual(replay.output,moved.output);
  const stale=game.action(player,{...input,requestId:'bag-receipt-stale'});
  assert.equal(stale.status,409);
  assert.equal(stale.output.error,'stale_bag');
  assert.equal(stale.output.bag.slots[4].count,2);
});
