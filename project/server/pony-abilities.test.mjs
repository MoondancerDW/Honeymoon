import assert from 'node:assert/strict';
import test from 'node:test';
import * as geometry from '../world/geometry.mjs';
import {ponyAbilities} from '../world/pony-abilities.mjs';
import {createGame} from './game.mjs';
import {openStore} from './store.mjs';
import {createSurvival} from './survival.mjs';

function scenario(t, race) {
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const {id}=store.createPlayer();
  const spawn={x:.5,y:1,z:.5};
  let now=1000;
  const clock=()=>now;
  const playerPonyType=()=>race;
  const survival=createSurvival(store,'game',{now:clock,healthLimit:()=>ponyAbilities(race).maxHealth});
  const bounds={minX:-65,maxX:64,minY:0,maxY:64,minZ:-65,maxZ:64};
  const base={hash:'pony-abilities',manifest:{bounds,spawn:Object.values(spawn)},
    inBounds:(x,y,z)=>x>=bounds.minX && x<=bounds.maxX && y>=bounds.minY && y<=bounds.maxY && z>=bounds.minZ && z<=bounds.maxZ,
    getCell:(x,y)=>({key:y===0 || x===12 && y<=6 ? 'legacy:1:0' : 'air',object:null})};
  const open=()=>createGame(base,store,geometry,{modules:[],clock,playerPonyType,survival});
  return {id,spawn,survival,open,game:open(),advance:ms=>now+=ms,raceTo:value=>{race=value;}};
}

test('race changes preserve damage and only winged survival ponies may fly or ignore landing damage',t=>{
  const {game,id,spawn,survival,raceTo,advance}=scenario(t,'earth');
  assert.equal(survival.status(id).health,15);
  assert.throws(()=>game.setFlight(id,'device',{enabled:true,sequence:1}),{code:'flight_unavailable'});
  assert.throws(()=>game.setSpectator(id,{enabled:true}),{code:'creative_required'});
  survival.damage(id,3,spawn,spawn.y);
  raceTo('unicorn');
  game.reconcileRace(id);
  assert.equal(survival.status(id).health,8);
  assert.equal(survival.status(id).maxHealth,10);
  raceTo('earth');
  game.reconcileRace(id);
  assert.equal(survival.status(id).health,12);
  survival.setMode(id,'creative');
  assert.equal(game.setFlight(id,'device',{enabled:true,sequence:1}),true);
  survival.setMode(id,'game');
  game.reconcileFlight(id);
  assert.equal(game.abilityState(id).flight,false);
  advance(300);
  assert.throws(()=>game.position(id,{...spawn,y:spawn.y+2,pose:{motion:'fly'}}),{code:'movement_blocked'});
  const land=()=>{
    game.teleport(id,{...spawn,y:6});
    advance(250);
    game.position(id,{...spawn,pose:{motion:'fly'}});
  };
  land();
  assert.equal(survival.status(id).health,13,'the motion label alone cannot prevent fall damage');
  raceTo('pegasus');
  game.reconcileRace(id);
  assert.equal(game.setFlight(id,'device',{enabled:true,sequence:2}),true);
  assert.equal(game.setFlight(id,'device',{enabled:false,sequence:3}),false);
  const before=survival.status(id).health;
  land();
  assert.equal(survival.status(id).health,before);
});

test('grounded charged jump grants expire unspent and two consumed charges return on independent timers',t=>{
  const {id,spawn,game,open,advance}=scenario(t,'earth');
  assert.deepEqual(game.grantChargedJump(id).jumpCharge,{charges:1,readyInMs:[3000]});
  advance(3000);
  assert.equal(game.abilityState(id).jumpCharge.charges,2);
  function spend(number) {
    assert.equal(game.grantChargedJump(id).jumpCharge.charges,2-number);
    advance(200);
    const from=[spawn.x,spawn.y,spawn.z,'stand'];
    const target={...spawn,y:spawn.y+.25};
    game.position(id,{...target,from,trail:[[target.x,target.y,target.z,'stand']],page:'fixture',requestId:`jump-use-${number}`});
    game.teleport(id,spawn);
  }
  spend(1);
  advance(1500);
  spend(2);
  assert.equal(game.abilityState(id).jumpCharge.charges,0);
  assert.throws(()=>game.grantChargedJump(id),{code:'jump_cooldown'});
  assert.deepEqual(open().abilityState(id).jumpCharge,{charges:0,readyInMs:[4300,6000]});
  advance(4300);
  assert.deepEqual(game.abilityState(id).jumpCharge,{charges:1,readyInMs:[1700]});
  advance(1700);
  assert.deepEqual(game.abilityState(id).jumpCharge,{charges:2,readyInMs:[]});
});

test('magic stops on the near side of a wall, honors both ranges, and keeps its cooldown after reconnect',t=>{
  const {id,game,open,advance,raceTo}=scenario(t,'unicorn');
  const stopped=game.magicTeleport(id,{yaw:-Math.PI/2,pitch:0});
  assert.ok(stopped.position.x>11.6 && stopped.position.x<11.7);
  assert.equal(stopped.position.y,1);
  assert.equal(stopped.magicCooldownMs,20000);
  assert.throws(()=>open().magicTeleport(id,{yaw:Math.PI/2,pitch:0}),{code:'magic_cooldown'});
  advance(20000);
  const across=game.magicTeleport(id,{yaw:Math.PI/2,pitch:0});
  assert.ok(Math.abs(stopped.position.x-across.position.x-50)<.00001);
  advance(20000);
  const up=game.magicTeleport(id,{yaw:0,pitch:Math.PI/2});
  assert.equal(up.position.y-across.position.y,30);
  raceTo('pegasus');
  game.reconcileRace(id);
  assert.throws(()=>game.magicTeleport(id,{yaw:0,pitch:0}),{code:'magic_unavailable'});
});

test('aiming at visible ground teleports to its surface when standing on the same floor',t=>{
  const {game,id,spawn}=scenario(t,'unicorn');
  const result=game.magicTeleport(id,{yaw:Math.PI/2,pitch:-.22});
  assert.equal(result.position.y,spawn.y);
  assert.ok(spawn.x-result.position.x>7&&spawn.x-result.position.x<8);
});
