import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openStore} from './store.mjs';
import {createNpcs} from './npcs.mjs';
import {createInventory} from './inventory.mjs';
import {sanitizeNpc} from './npc-editor.mjs';

const emerald={key:'creative:388:0',count:3};
const prize={key:'creative:267:0',count:1,nbt:{display:{Name:'Present'}}};
const apple={key:'creative:260:0',count:2};
const at=(x=0,y=65,z=0)=>({x,y,z});
const merchant=sanitizeNpc({name:'Shop',position:at(1),model:'npcpony',role:'trader',dialogIds:[1],
  trades:[{costs:[emerald],reward:prize}]},undefined,()=>true);
const witness=sanitizeNpc({name:'Witness',position:at(2),model:'npcpony',dialogIds:[2]},undefined,()=>true);
const bank=sanitizeNpc({name:'Bank',position:at(3),model:'npcpony',role:'bank',bankId:1},undefined,()=>true);
const carrier=sanitizeNpc({name:'Ride',position:at(4),model:'npcpony',role:'transport',transporterId:3},undefined,()=>true);
const mover=sanitizeNpc({name:'Walk',position:at(5),model:'item',item:apple,role:'follower',
  movement:{mode:'route',speed:2,loop:false,route:[at(7)]}},undefined,()=>true);
const shared={dialogs:[
  {id:1,title:'Hello',text:'Hi {player}',questId:1,options:[{type:'dialog',title:'Next',dialogId:2},{type:'close',title:'Bye'}]},
  {id:2,title:'Next',text:'Second',options:[]},{id:3,title:'Unrelated',options:[]},
],quests:[{id:1,title:'Quest',items:[],rewards:[apple],dialogs:[2],completer:'Witness',completion:'npc',repeat:'once',type:'dialog'}],
transport:[{id:3,name:'Start',position:at(4),category:1,type:1},
  {id:4,name:'Far home',position:at(45),category:1,type:1},
  {id:5,name:'Excluded',position:at(46),category:1,type:1,dimension:-19}],
factions:[],recipes:[{id:1,name:'Snack',items:[emerald],global:true,result:apple}],
banks:[{id:1,name:'Bank',start:1,max:2,cost:[],upgrade:[]}]};

function setup(t) {
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const positions=new Map();
  let time=10_000;
  const catalog=new Map([388,267,260].map(id=>[`creative:${id}:0`,{id}]));
  const inventory=createInventory(store,new Set(),catalog);
  const game={
    session:player=>({position:positions.get(player)??at()}),
    npcReach:(player,target)=>Math.abs(target.x-game.session(player).position.x)<=6,
    npcWalk:(from,to)=>to,
  };
  const input={store,creativeItems:catalog,source:{definitions:[merchant,witness,bank,carrier,mover],shared:structuredClone(shared)},
    adminKey:'secret-key',base:{inBounds:()=>true},worldTime:{snapshot:()=>({tick:6000})},game,
    profile:()=>({nickname:'Moon'}),now:()=>time,teleportPlayer:(player,position)=>{
      positions.set(player,position);return{position,stance:'stand',changes:[],effects:[],worldRevision:0};
    }};
  const npcs=createNpcs(input);
  const act=(npc,action,args={},player='mine')=>npcs.action(player,{npcId:npc.id,action,...args});
  return {npcs,act,inventory,input,tick:(elapsed)=>{time+=elapsed;npcs.tick([{id:'mine',position:at()}]);}};
}

test('only an unlocked administrator can mutate original NPCs and new definitions persist across a restart',t=>{
  const {npcs,input}=setup(t);
  assert.equal(npcs.snapshot('mine').editor,false);
  assert.throws(()=>npcs.editor('mine'),{code:'npc_editor_required'});
  assert.throws(()=>npcs.admin('mine','wrong','localhost'),{code:'npc_editor_key'});
  npcs.admin('mine','secret-key','localhost');
  assert.equal(npcs.isAdmin('mine'),true);
  assert.equal(npcs.isAdmin('other'),false);
  const output=npcs.edit('mine',{action:'save',definition:{name:'New',model:'item',item:apple,position:at(6)}});
  const added=output.definitions.find(npc=>npc.name==='New');
  assert.equal(added.item.key,apple.key);
  const next=npcs.edit('mine',{action:'saveShared',collection:'dialogs',definition:{title:'Added',text:'Test'}});
  assert.equal(next.shared.dialogs.at(-1).id,4);
  const restarted=createNpcs(input);
  assert.equal(restarted.isAdmin('mine'),false);
  restarted.admin('mine','secret-key','localhost');
  assert.equal(restarted.editor('mine').definitions.some(npc=>npc.id===added.id),true);
  restarted.edit('mine',{action:'remove',npcId:merchant.id});
  assert.equal(createNpcs(input).snapshot('mine').npcs.some(npc=>npc.id===merchant.id),false);
});

test('dialog, quest, NBT trade and crafting resolve only original server-owned content',t=>{
  const {act,inventory}=setup(t);
  assert.throws(()=>act(merchant,'trade',{index:0}),{code:'npc_interaction_required'});
  const hello=act(merchant,'interact').interaction;
  assert.equal(hello.dialog.text,'Hi Moon');
  assert.equal(hello.trade[0].affordable,false);
  assert.throws(()=>act(merchant,'dialog',{dialogId:3}),{code:'npc_dialog_unavailable'});
  assert.throws(()=>act(merchant,'trade',{index:0,reward:apple}),{code:'npc_missing_items'});
  inventory.put('mine',emerald);
  const result=act(merchant,'trade',{index:0,reward:apple});
  assert.deepEqual(result.inventory.slots[0],prize);
  assert.equal(act(merchant,'option',{dialogId:1,index:0}).interaction.dialog.id,2);
  assert.throws(()=>act(merchant,'completeQuest',{questId:1}),{code:'npc_quest_unfinished'});
  assert.equal(act(witness,'interact').interaction.quests[0].canComplete,true);
  const done=act(witness,'completeQuest',{questId:1});
  assert.equal(done.interaction.quests[0].state,'completed');
  assert.ok(done.inventory.slots.some(item=>item?.key===apple.key));
  inventory.put('mine',emerald);
  const craft=act(witness,'craft',{recipeId:1});
  assert.ok(craft.inventory.slots.some(item=>item?.key===apple.key&&item.count===4));
});

test('transport points use authoritative coordinates and bank items stay private',t=>{
  const {act,inventory}=setup(t);
  inventory.put('mine',emerald);
  act(bank,'interact');
  const deposit=act(bank,'bankDeposit',{slot:0,count:2});
  assert.equal(deposit.interaction.bank.items[0].count,2);
  assert.equal(act(bank,'interact',{},'other').interaction.bank.items.length,0);
  const withdraw=act(bank,'bankWithdraw',{slot:0,count:1});
  assert.equal(withdraw.inventory.slots[0].count,2);
  const routes=act(carrier,'interact').interaction.transport;
  assert.deepEqual(routes.map(row=>row.available),[true,false]);
  assert.throws(()=>act(carrier,'transport',{index:1}),{code:'npc_transport_dimension'});
  assert.deepEqual(act(carrier,'transport',{index:0,position:at(777)}).teleport.position,at(45));
  assert.throws(()=>act(merchant,'interact'),{code:'outside_reach'});
});

test('server advances item-model NPC route for visible players and honors route end',t=>{
  const {npcs,tick}=setup(t);
  for (let i=0;i<10;i++) tick(200);
  const atEnd=()=>npcs.snapshot('mine').npcs.find(npc=>npc.id===mover.id);
  assert.ok(atEnd().position.x>6.7 && atEnd().position.x<=7);
  assert.equal(atEnd().moving,false);
  assert.equal(atEnd().item.key,apple.key);
  for (let i=0;i<10;i++) tick(200);
  assert.ok(atEnd().position.x>=6.7);
});
