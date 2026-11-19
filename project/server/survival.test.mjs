import assert from 'node:assert/strict';
import test from 'node:test';
import {createSurvival} from './survival.mjs';
import {openStore} from './store.mjs';
import {createGame} from './game.mjs';
import {createInventory} from './inventory.mjs';
import {createChat} from './chat.mjs';
import {harvestRule} from '../world/survival-tools.mjs';
import * as geometry from '../world/geometry.mjs';
import {signItemKey,signPlacementCell} from '../world/creative-items.mjs';
import {encodeVoxels,VOXEL_COUNT,voxelIndex,voxelKey} from '../world/voxel-chisel.mjs';

test('game mode damage, recovery, death and personal creative overrides follow the server clock',t=>{
  const store=openStore(':memory:');
  t.after(()=>store.close());
  let time=500;
  const mode=createSurvival(store,'game',{now:()=>time});
  const {id}=store.createPlayer();
  const point={x:3,y:70,z:4};
  assert.deepEqual(mode.status(id),{mode:'game',health:10,maxHealth:10,death:null});
  assert.equal(mode.damage(id,1,point,70).health,9);
  assert.ok(mode.canStrike(id));
  assert.ok(!mode.canStrike(id));
  time+=4999;
  mode.tick([id],()=>assert.fail('recovery fired early'));
  time++;
  mode.tick([id],(_id,state)=>assert.equal(state.health,10));
  assert.equal(mode.observe(id,{...point,y:75},point,{grounded:true,protectedFall:false}),2);
  assert.equal(mode.observe(id,{...point,y:81},point,{grounded:true,protectedFall:true}),0);
  assert.equal(mode.damage(id,10,point,69).death.floor,69);
  assert.ok(mode.dead(id));
  assert.equal(createSurvival(store,'game',{now:()=>time}).status(id).health,0);
  assert.equal(mode.reset(id).health,10);
  mode.setMode(id,'creative');
  assert.equal(mode.mode(id),'creative');
  assert.equal(mode.damage(id,3,point,70),undefined);
  mode.setMode(id,null);
  assert.equal(mode.mode(id),'game');
});

test('continuous lava contact deals one point per second and a lava death revives at spawn',t=>{
  const store=openStore(':memory:');
  t.after(()=>store.close());
  let time=0;
  const clock=()=>time;
  const survival=createSurvival(store,'game',{now:clock});
  const {id}=store.createPlayer();
  const spawn={x:3.5,y:1,z:3.5};
  const lava={x:6.5,y:1,z:5.5};
  const edge={...lava,x:5.8};
  const dry={...edge,x:5.65};
  const base={hash:'lava-survival',manifest:{spawn:Object.values(spawn),bounds:{minX:0,maxX:15,minY:0,maxY:15,minZ:0,maxZ:15}},
    catalog:new Set(['legacy:1:0','legacy:11:0']),inBounds:(...point)=>point.every(n=>n>=0&&n<=15),
    getCell(x,y,z){return {key:y===0?'legacy:1:0':x===6&&y===1&&z===5?'legacy:11:0':'air',object:null};}};
  const updates=[];
  const game=createGame(base,store,geometry,{modules:[],clock,survival,survivalChanged:(_id,state)=>updates.push(state)});
  const tick=(delta,online=true)=>{
    time+=delta;
    game.advanceLava(online?[id]:[]);
    return survival.status(id).health;
  };

  game.teleport(id,edge);
  assert.equal(tick(999),10);
  assert.equal(tick(1),9);
  time+=600;
  game.position(id,dry);
  game.position(id,edge);
  assert.equal(tick(999),9);
  assert.equal(tick(1),8);
  assert.equal(tick(2400),6);
  assert.equal(tick(1,false),6);
  assert.equal(tick(5000),6);
  assert.equal(tick(999),6);
  assert.equal(tick(1),5);

  assert.throws(()=>game.setSpectator(id,{enabled:true}),{code:'creative_required'});
  game.teleport(id,lava);
  assert.equal(tick(4900),1);
  assert.equal(tick(100),0);
  assert.equal(tick(5000),0);
  const death=survival.status(id).death;
  assert.deepEqual(death,{at:time-5000,position:lava,floor:1,cause:'lava'});
  assert.deepEqual(createSurvival(store,'game',{now:clock}).avatarDeath(id),death);
  assert.equal(updates.filter(({death})=>Boolean(death)).length,1);
  const chat=createChat({store,publish:()=>{}});
  chat.playerDeath({nickname:'Проверка'},death.cause);
  assert.deepEqual(chat.history(id).map(({kind,cause,text})=>({kind,cause,text})),
    [{kind:'death',cause:'lava',text:'Сгорел'}]);
  assert.deepEqual(game.revive(id,death).position,spawn);
  assert.equal(survival.reset(id).health,10);
  assert.equal(tick(5000),10);

  const samples=new Uint8Array(VOXEL_COUNT);
  samples[voxelIndex(6,4,4)]=1;
  game.worldEdit.write(id,[
    {x:8,y:1,z:5,cell:voxelKey,object:null,voxels:encodeVoxels(samples,['legacy:11:0'])},
    {x:10,y:1,z:5,cell:'legacy:44:0',object:null,fluid:'lava'},
  ]);
  game.teleport(id,{x:8.55,y:1,z:5.55});
  assert.equal(tick(1000),9);
  game.teleport(id,{x:10.5,y:1.5,z:5.5});
  assert.equal(tick(1000),8);
  game.teleport(id,{...lava,y:1.9});
  assert.equal(tick(1000),8);

  game.teleport(id,edge);
  time+=1001;
  game.position(id,dry);
  assert.equal(survival.status(id).health,7,'exiting after a full second counts before the next timer tick');

  survival.setMode(id,'creative');
  game.teleport(id,lava);
  assert.equal(tick(5000),10);
  assert.equal(survival.status(id).death,null);
});

test('game mode rejects forged creative acquisition and bare-handed stone, and supplies a crafting path',t=>{
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const survival=createSurvival(store,'game');
  const {id}=store.createPlayer();
  const cells=new Map([['3,1,4','legacy:1:0'],['4,1,4','legacy:3:0']]);
  const catalog=new Set(['legacy:3:0','legacy:4:0','legacy:5:0','legacy:17:0']);
  const blocks=new Set(catalog),items=new Map();
  const base={hash:'stack-test',manifest:{spawn:[3.5,1,6.5],bounds:{minX:0,maxX:15,minY:0,maxY:15,minZ:0,maxZ:15}},
    catalog,inBounds:(x,y,z)=>[x,y,z].every(n=>n>=0&&n<=15),hasPlayableChunk:(x,z)=>x===0&&z===0,
    getCell(x,y,z){return {key:cells.get([x,y,z].join(','))??(y===0?'legacy:1:0':'air'),object:null};}};
  const game=createGame(base,store,geometry,{modules:[],allowRemoval:true,creativeBlocks:blocks,creativeItems:items,survival});
  assert.equal(game.action(id,{type:'inventory_give',requestId:'give-test-1',slot:0,key:'legacy:4:0'}).output.error,'creative_only');
  const breakAt=(x,z,requestId)=>game.action(id,{type:'remove',requestId,x,y:1,z,expectedRevision:0,
    hit:{x:x+.5,y:1.8,z:z+1}});
  assert.equal(breakAt(3,4,'stone-hand').output.error,'tool_required');
  assert.equal(breakAt(4,4,'dirt-hand1').status,200);
  assert.equal(game.droppedItemSnapshot(id)[0].item.key,'legacy:3:0');
  const inventory=createInventory(store,blocks,items);
  inventory.put(id,{key:'legacy:17:0',cell:'legacy:17:0',count:2});
  game.craft(id,'planks');
  game.craft(id,'planks');
  game.craft(id,'sticks');
  const tools=game.craft(id,'wood-pickaxe');
  const slot=tools.slots.findIndex(stack=>stack?.key==='creative:270:0');
  assert.ok(slot>=0);
  game.action(id,{type:'inventory_select',requestId:'select-pick',slot});
  assert.equal(breakAt(3,4,'stone-pick').status,200);
  assert.ok(game.droppedItemSnapshot(id).some(drop=>drop.item.key==='legacy:4:0'));
  assert.equal(harvestRule('legacy:56:0',{key:'creative:270:0'}),null);
  assert.equal(harvestRule('legacy:56:0',{key:'creative:257:0'}).drops[0].key,'creative:264:0');
});

test('broken signs return a blank placeable item; a rejected mount preserves the stack',t=>{
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const {id}=store.createPlayer();
  const cells=new Map([['5,1,5','legacy:63:0'],['6,1,5','legacy:1:0'],['6,3,6','legacy:1:0']]);
  const base={hash:'sign-placement',manifest:{spawn:[5.5,1,8.5],bounds:{minX:0,maxX:15,minY:0,maxY:15,minZ:0,maxZ:15}},
    catalog:new Set(['legacy:1:0','legacy:63:0']),
    inBounds:(...point)=>point.every(n=>n>=0&&n<=15),
    getCell(x,y,z){return {key:cells.get([x,y,z].join(','))??(y===0?'legacy:1:0':'air'),object:null};}};
  const survival=createSurvival(store,'game');
  const inventory=createInventory(store,new Set(),new Map());
  const game=createGame(base,store,geometry,{modules:[],allowRemoval:true,survival});
  const run=(type,requestId,fields)=>game.action(id,{type,requestId,expectedRevision:0,...fields});
  assert.equal(run('remove','break-original-sign',{x:5,y:1,z:5}).status,200);
  const [drop]=game.droppedItemSnapshot(id);
  assert.equal(drop.item.key,signItemKey);
  inventory.put(id,{...drop.item,count:2});
  const mounted=run('place','place-held-sign',{x:6,y:1,z:6,against:{x:6,y:1,z:5},cell:signPlacementCell,creativeItem:signItemKey,yaw:0});
  assert.equal(mounted.status,200,JSON.stringify(mounted));
  assert.equal(mounted.output.changes[0].cell,'legacy:68:3');
  assert.equal(mounted.output.changes[0].object.data.Text1,'');
  assert.equal(inventory.selected(id).count,1);
  const ceiling=run('place','reject-ceiling-sign',{x:6,y:2,z:6,against:{x:6,y:3,z:6},
    cell:signPlacementCell,creativeItem:signItemKey,yaw:0});
  assert.equal(ceiling.output.error,'invalid_sign_face',JSON.stringify(ceiling));
  assert.equal(inventory.selected(id).count,1);
  const floor=run('place','place-floor-sign',{x:5,y:1,z:6,against:{x:5,y:0,z:6},cell:signPlacementCell,creativeItem:signItemKey,yaw:0});
  assert.equal(floor.status,200,JSON.stringify(floor));
  assert.equal(floor.output.changes[0].cell,'legacy:63:0');
  assert.equal(inventory.selected(id),null);
});

test('block copy preserves occupied hotbar slots and reselects duplicate items',t=>{
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const {id}=store.createPlayer();
  const inventory=createInventory(store,new Set(['legacy:1:0','legacy:3:0']),new Map());
  inventory.edit(id,{type:'inventory_give',slot:0,key:'legacy:1:0',count:9});
  store.putClipboard(id,{cell:'legacy:3:0'});
  const first=inventory.copyToFreeSlot(id,0);
  assert.equal(first.inventory.selected,1);
  assert.equal(first.inventory.slots[0].count,9);
  assert.equal(first.inventory.slots[1].key,'legacy:3:0');
  assert.deepEqual(inventory.copyToFreeSlot(id,1),first);
  const filled=inventory.read(id);
  filled.slots.fill(filled.slots[0]);
  inventory.replace(id,filled);
  assert.throws(()=>inventory.copyToFreeSlot(id,0),{code:'inventory_full'});
  assert.equal(inventory.read(id).slots[0].key,'legacy:1:0');
});
