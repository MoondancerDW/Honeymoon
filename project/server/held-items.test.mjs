import assert from 'node:assert/strict';
import test from 'node:test';
import {potionProfile} from '../world/held-consumables.mjs';
import {createInventory} from './inventory.mjs';
import {createSurvival} from './survival.mjs';
import {createHeldItems,traceItemFlight} from './held-items.mjs';
import {openStore} from './store.mjs';

const bow='creative:261:0', arrow='creative:262:0', bottle='creative:374:0', speed='creative:373:16274', apple='creative:260:0';
const splashSpeed='creative:373:32658';

function setup(t) {
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const inventory=createInventory(store,new Set(),new Map([bow,arrow,bottle,speed,apple,splashSpeed].map(key=>[key,{}])));
  let now=0;
  const survival=createSurvival(store,'game',{now:()=>now});
  const damage=(player,amount,cause)=>survival.damage(player,amount,{x:0,y:0,z:0},0,cause);
  const held=createHeldItems({inventory,survival,clock:()=>now,eye:()=>[0,1,0],
    body:id=>({id,x:5,y:0,z:0,height:1.6,halfWidth:.4}),visible:()=>true,canUse:()=>{},damage});
  const slot=(player,index,key,count=1)=>inventory.edit(player,{type:'inventory_give',slot:index,key,count});
  return {held,inventory,survival,damage,slot,advance:ms=>{now+=ms;}};
}

test('charging and releasing a bow uses one arrow, applies damage, and cannot replay a shot',t=>{
  const {held,survival,slot,advance}=setup(t);
  slot('a',0,bow);
  slot('a',1,arrow,2);
  held.use('a',{type:'bow-start'},['a','b']);
  advance(1000);
  const result=held.use('a',{type:'bow-release',look:[1,0,0]},['a','b']);
  assert.equal(result.projectile.kind,'arrow');
  assert.ok(result.projectile.points.at(-1)[0]>4);
  assert.equal(result.inventory.slots[1].count,1);
  assert.equal(survival.status('b').health,2);
  assert.throws(()=>held.use('a',{type:'bow-release',look:[1,0,0]},['a','b']),/held_item_changed/);
  assert.equal(traceItemFlight([0,1,0],[1,0,0],{speed:40,gravity:18,targets:[],visible:(_,to)=>to[0]<2}).block,true);
});

test('drinking keeps the glass bottle, food heals, and timed potion effects expire',t=>{
  const {held,survival,damage,slot,advance}=setup(t);
  slot('a',0,speed);
  let result=held.use('a',{type:'consume',key:speed},['a']);
  assert.equal(result.inventory.slots[0].key,bottle);
  assert.equal(survival.movementScale('a'),1.2);
  advance(181_000);
  survival.tick(['a'],()=>{});
  assert.equal(survival.movementScale('a'),1);
  damage('a',6,'fall');
  slot('a',0,apple,2);
  result=held.use('a',{type:'consume',key:apple},['a']);
  assert.equal(result.inventory.slots[0].count,1);
  assert.equal(survival.status('a').health,8);
});

test('poison cannot kill, regeneration heals, fire resistance blocks lava and strength changes melee',t=>{
  const {survival,damage,advance}=setup(t);
  const effect=damage=>potionProfile(`creative:373:${damage}`);
  survival.applyEffect('a',effect(16307));
  damage('a',8,'lava');
  assert.equal(survival.status('a').health,10);
  survival.applyEffect('a',effect(16281));
  assert.equal(survival.meleeModifier('a'),3);
  survival.applyEffect('a',effect(16312));
  assert.equal(survival.meleeModifier('a'),1);
  survival.applyEffect('a',effect(16276));
  advance(15000);
  survival.tick(['a'],()=>{});
  assert.equal(survival.status('a').health,1);
  survival.clearEffects('a');
  survival.applyEffect('a',effect(16273));
  advance(2500);
  survival.tick(['a'],()=>{});
  assert.ok(survival.status('a').health>1);
});

test('the remaining potion effects and sharing a splash dose use actual server state',t=>{
  const {held,survival,damage,slot,advance}=setup(t);
  const profile=metadata=>potionProfile(`creative:373:${metadata}`);
  slot('a',0,splashSpeed);
  const splash=held.use('a',{type:'consume',key:splashSpeed,look:[1,0,0]},['a','b']);
  assert.equal(splash.projectile.kind,'splash');
  assert.equal(splash.inventory.slots[0],null);
  assert.equal(survival.movementScale('b'),1.2);
  survival.applyEffect('b',profile(16314));
  assert.equal(survival.movementScale('b'),1.02);
  survival.applyEffect('b',profile(16310));
  assert.equal(survival.status('b').effects.nightVision.until,180_000);
  survival.applyEffect('b',profile(16318));
  assert.equal(survival.status('b').effects.invisibility.until,180_000);
  survival.applyEffect('b',profile(16348),1,damage);
  assert.equal(survival.status('b').health,4);
  survival.applyEffect('b',profile(16341));
  assert.equal(survival.status('b').health,8);
  advance(180_001);
  survival.tick(['b'],()=>{});
  assert.equal(survival.status('b').effects,undefined);
});
