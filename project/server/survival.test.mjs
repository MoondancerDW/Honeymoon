import assert from 'node:assert/strict';
import test from 'node:test';
import {createSurvival} from './survival.mjs';
import {openStore} from './store.mjs';
import {createGame} from './game.mjs';
import {createInventory} from './inventory.mjs';
import {harvestRule} from '../world/survival-tools.mjs';
import * as geometry from '../world/geometry.mjs';

test('game mode damage, recovery, death and personal creative overrides follow the server clock',t=>{
  const store=openStore(':memory:');
  t.after(()=>store.close());
  let time=500;
  const mode=createSurvival(store,'game',{now:()=>time});
  const {id}=store.createPlayer();
  const point={x:3,y:70,z:4};
  assert.deepEqual(mode.status(id),{mode:'game',health:10,death:null});
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
