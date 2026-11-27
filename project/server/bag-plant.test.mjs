import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as geometry from '../world/geometry.mjs';
import {seedPlant,seedSpiral} from '../world/seed-plants.mjs';
import {createGame} from './game.mjs';
import {openStore} from './store.mjs';
import {createSurvival} from './survival.mjs';

const farmland='legacy:60:0', stone='legacy:1:0', crop='legacy:59:0';
const seeds=[{Slot:0,id:295,Count:2,Damage:0,tag:{example:'first'}},
  {Slot:8,id:295,Count:1,Damage:0,tag:{example:'last'}}];
const seedBag={key:'creative:9299:574',count:1,nbt:{display:{Name:'Пшеница'},contents:seeds}};
const bounds={minX:0,maxX:15,minY:0,maxY:15,minZ:0,maxZ:15};
const target={x:8,y:0,z:6,hit:{x:8.5,y:.9375,z:6.5}};

function scenario(t,mode,bag=seedBag) {
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const player=store.createPlayer().id;
  const slots=[bag,...Array(35).fill(null)];
  const base={hash:'seed-placement',manifest:{bounds,spawn:[8.5,1,8.5],compositions:{}},catalog:new Set([farmland,stone]),
    inBounds:(x,y,z)=>[x,y,z].every(n=>n>=0&&n<16),getCell(x,y,z) {
      const field=x>=6&&x<=10&&z>=4&&z<=8;
      const key=y===0?(field?farmland:stone):(x===7&&y===1&&z===6)?stone:'air';
      return {key,object:null};
    }};
  const game=createGame(base,store,geometry,{modules:[],survival:createSurvival(store,mode)});
  store.putState('inventory',player,'slots',3,{selected:0,slots});
  game.session(player);
  return (requestId,location=target)=>game.action(player,{requestId,type:'bag_plant',expectedRevision:0,...location});
}

test('Seed Bag plants at most the held seeds in survival and consumes them only once per request',t=>{
  const action=scenario(t,'game');
  const failed=action('seed-on-stone',{x:11,y:0,z:8,hit:{x:11.5,y:1,z:8.5}});
  assert.equal(failed.output.error,'seed_soil_required');
  const first=action('seed-plant-survival');
  assert.equal(first.status,200,JSON.stringify(first.output));
  assert.deepEqual(first.output.changes.map(({x,y,z,cell})=>[x,y,z,cell]),[
    [8,1,6,crop],[8,1,5,crop],[7,1,5,crop],
  ]);
  assert.equal(first.output.inventory.slots[0].key,'creative:9299:0');
  assert.deepEqual(first.output.inventory.slots[0].nbt,{display:{Name:'Пшеница'},contents:[]});
  const replay=action('seed-plant-survival');
  assert.equal(replay.replay,true);
  assert.deepEqual(replay.output,first.output);
});

test('creative Seed Bag skips protected or occupied plots and preserves its exact NBT',t=>{
  const action=scenario(t,'creative');
  const planted=action('seed-plant-creative');
  assert.equal(planted.status,200,JSON.stringify(planted.output));
  assert.equal(planted.output.changes.length,23);
  assert.ok(planted.output.changes.every(({cell})=>cell===crop));
  assert.ok(!planted.output.changes.some(({x,z})=>x===7&&z===6||x===8&&z===8));
  assert.deepEqual(planted.output.inventory.slots[0],seedBag);
});

test('RedPower traverses a 5×5 spiral and uses the original crop ID and soil',()=>{
  const plots=[...seedSpiral(0,0)];
  assert.deepEqual(plots.slice(0,6),[[0,0],[0,-1],[-1,-1],[-1,0],[-1,1],[0,1]]);
  assert.equal(new Set(plots.map(String)).size,25);
  assert.ok(plots.every(([x,z])=>Math.abs(x)<=2&&Math.abs(z)<=2));
  assert.deepEqual(seedPlant('creative:9296:0'),{cell:'legacy:246:0',soil:60});
  assert.deepEqual(seedPlant('creative:372:0'),{cell:'legacy:115:0',soil:88});
  for (const key of ['creative:338:0','legacy:6:0','creative:4998:6']) assert.equal(seedPlant(key),undefined);
});
