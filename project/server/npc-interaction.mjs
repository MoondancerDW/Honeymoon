import {RequestError} from './errors.mjs';
import {stackType} from '../world/item-text.mjs';
import {itemStackLimit} from '../world/item-stack.mjs';
import {list,number,text} from './npc-source.mjs';

const day=86400000;
const playerStateKey='progress';
const playerStateVersion=1;
const noData=()=>({dialogs:{},active:{},completed:{},gifts:{},transport:{},banks:{},kills:{},experience:0});
const hasConversation = info => Boolean(info.message || info.lines.length || info.dialog || info.dialogs.length ||
  info.quests.length || info.trade.length || info.transport.length || info.bank || info.follower || info.jobData);
const isNative = /^(?:creative|legacy):(\d+):(\d+)$/;
const itemIdentity = item => {
  const native=isNative.exec(item.key);
  return !native ? stackType(item) : JSON.stringify([native[1],native[2],stackType({key:'',nbt:item.nbt})]);
};
const itemCount=(state,wanted) => {
  const key=itemIdentity(wanted);
  return state.slots.reduce((quantity,item)=>quantity+(item && itemIdentity(item)===key?item.count:0),0);
};

function takeItems(state,requirements) {
  for (const wanted of requirements) {
    const key=itemIdentity(wanted);
    let remaining=wanted.count;
    for (let slot=0; slot<state.slots.length && remaining; slot++) {
      const item=state.slots[slot];
      if (!item || itemIdentity(item)!==key) continue;
      const amount=Math.min(item.count,remaining);
      remaining-=amount;
      state.slots[slot]=item.count===amount?null:{...item,count:item.count-amount};
    }
    if (remaining) throw new RequestError(409,'npc_missing_items');
  }
}
function canTake(state,requirements) {
  try { takeItems({...state,slots:state.slots.slice()},requirements);return true; }
  catch (error) { if (error.code==='npc_missing_items') return false;throw error; }
}

function availability(rules,progress,worldTick) {
  if (!rules) return true;
  const night=worldTick>=12542 && worldTick<23460;
  if (rules.day==='day' && night || rules.day==='night' && !night) return false;
  return list(rules.dialogs).every(({rule,id})=>rule==='after'?Boolean(progress.dialogs[id]):!progress.dialogs[id]) &&
    list(rules.quests).every(({rule,id})=>({
      after:Boolean(progress.completed[id]),before:!progress.completed[id],active:Boolean(progress.active[id]),inactive:!progress.active[id],
    }[rule]??true));
}
function mayRepeat(quest,finished,time) {
  if (finished===undefined) return true;
  return quest.repeat==='repeat'||quest.repeat==='daily'&&time-finished>=day||quest.repeat==='weekly'&&time-finished>=7*day;
}
function questStatus(quest,progress,time) {
  if (progress.active[quest.id]) return 'active';
  return mayRepeat(quest,progress.completed[quest.id],time)?'available':'completed';
}
function npcCanFinish(quest,npc) {
  return !quest.completer || quest.completer===npc.name;
}
function condition(quest,progress,inventory) {
  const accepted=progress.active[quest.id];
  if (!accepted) return false;
  if (quest.type==='item') return canTake(inventory,quest.items);
  if (quest.type==='dialog') return quest.dialogs.every(id=>Boolean(progress.dialogs[id]));
  if (quest.type==='kill') return list(quest.kills).every(row=>number(progress.kills[row.name])-number(accepted.kills?.[row.name])>=row.count);
  return false;
}
function playerText(value,profile) {
  const user=profile?.nickname ?? profile?.name ?? 'Игрок';
  return text(value).replace(/\{player\}/gi,()=>user);
}
function editableDialog(row,progress,profile,tick) {
  return {...row,text:playerText(row.text,profile),options:row.options.map(option=>{
    const {command, ...publicOption}=option;
    return {...publicOption,title:playerText(option.title,profile),
      ...(option.type==='command' && !/^\/?say\s+[^\r\n]+$/i.test(command) && {type:'disabled'})};
  })};
}
function ownBank(tenant,bank) {
  return tenant.banks[bank.id] ?? {capacity:Math.min(bank.max,bank.start)*9,unlocked:!bank.cost.length,items:[]};
}

export function createNpcInteraction({store,inventory,definitions,shared,actors,profile,now,worldTick,near,worldBounds,
  teleportPlayer,healPlayer,prepareLoot,random=Math.random}) {
  function tx(player,run) {
    return store.atomic(()=>{
      const progress=store.getState('npcs',player,playerStateKey)?.value ?? noData();
      const state=inventory.read(player);
      const flags={progress:false,inventory:false};
      const context={player,progress,state,flags,time:now(),tick:worldTick(),profile:profile(player)};
      const result=run(context);
      if (flags.progress) store.putState('npcs',player,playerStateKey,playerStateVersion,progress);
      if (flags.inventory) result.inventory=inventory.replace(player,state);
      return result;
    });
  }

  function offerQuest(quest,npc,ctx) {
    const {progress}=ctx;
    const active=progress.active[quest.id];
    const listed=dialogRoots(npc,ctx).some(row=>row.questId===quest.id);
    return active && npcCanFinish(quest,npc) ||
      Boolean(progress.completed[quest.id]!==undefined && quest.completer===npc.name) || Boolean(listed);
  }
  function dialogRoots(npc,{progress,tick}) {
    return npc.dialogIds.flatMap(id=>{
      const row=shared.dialogs.find(dialog=>dialog.id===id);
      return row && availability(row.availability,progress,tick) ? [row] : [];
    });
  }

  function allowedTransport(npc,ctx) {
    const current=shared.transport.find(row=>row.id===npc.transporterId);
    let routes=npc.transport;
    if (!routes.length && current) routes=shared.transport.filter(row=>row.id!==current.id && row.category===current.category);
    return routes.map(route=>({...route,
      available:!route.dimension && worldBounds(route.position) &&
        (route.id===undefined || route.type===1 || Boolean(ctx.progress.transport[route.id])),
      ...(route.dimension && {reason:'npc_transport_dimension'}),
    }));
  }
  function giftReady(npc,ctx) {
    const at=ctx.progress.gifts[npc.id]?.at;
    const {cooldownType,cooldown,items}=npc.jobData;
    if (!items.length) return false;
    if (!Number.isFinite(at)) return true;
    return cooldownType===0&&ctx.time-at>=cooldown*1000||cooldownType===2&&ctx.time-at>=day;
  }
  function output(npc,ctx,dialog,extra={}) {
    const {progress,state,time}=ctx;
    const trade=npc.role==='trader'?npc.trades.map(row=>({...row,affordable:canTake(state,row.costs)})):[];
    const quests=shared.quests.filter(quest=>offerQuest(quest,npc,ctx)||dialog?.questId===quest.id).map(quest=>({
      ...quest,state:questStatus(quest,progress,time),canComplete:npcCanFinish(quest,npc)&&condition(quest,progress,state),
    }));
    const bank=npc.role==='bank'&&shared.banks.find(row=>row.id===npc.bankId);
    const bankView=bank&&ownBank(progress,bank);
    const transport=npc.role==='transport'?allowedTransport(npc,ctx):[];
    const npcState=actors.get(npc.id);
    return {npc:actors.view(npc,npcState,time),interaction:{
      role:npc.role,job:npc.job,
      lines:npc.lines.interact.map(value=>playerText(value,ctx.profile)),
      dialog:dialog ? editableDialog(dialog,progress,ctx.profile,ctx.tick) : null,
      dialogs:dialogRoots(npc,ctx).map(({id,title})=>({id,title})),quests,trade,transport,
      ...(bankView&&{bank:{...bankView,name:bank.name,max:bank.max*9,cost:bank.cost,upgrade:bank.upgrade}}),
      ...(npc.role==='follower' && {follower:{following:npcState.following===ctx.player,costs:[]}}),
      ...(npc.job==='itemGiver'&&{jobData:{giftAvailable:giftReady(npc,ctx)}}),
      ...(npc.job==='healer'&&{jobData:{healer:true}}),
      ...(npc.job==='bard'&&{jobData:{bard:{song:npc.jobData.song,instrument:npc.jobData.instrument}}}),
      ...extra,
    }};
  }
  function give(ctx,stacks) {
    if (!stacks.length) return;
    for (const stack of stacks) if (inventory.insert(ctx.state,stack)) throw new RequestError(409,'inventory_full');
    ctx.flags.inventory=true;
  }
  function charge(ctx,items) {
    if (!items.length) return;
    takeItems(ctx.state,items);
    ctx.flags.inventory=true;
  }
  function accept(quest,ctx) {
    if (!quest || questStatus(quest,ctx.progress,ctx.time)!=='available') return false;
    ctx.progress.active[quest.id]={at:ctx.time,...(quest.type==='kill'&&{kills:{...ctx.progress.kills}})};
    ctx.flags.progress=true;
    return true;
  }
  function complete(quest,ctx) {
    if (quest.type==='item') charge(ctx,quest.items);
    give(ctx,quest.rewards);
    ctx.progress.completed[quest.id]=ctx.time;
    if (quest.experience) ctx.progress.experience+=quest.experience;
    delete ctx.progress.active[quest.id];
    ctx.flags.progress=true;
    return playerText(quest.completeText,ctx.profile);
  }
  function tryInstant(ctx) {
    const messages=[];
    for (const quest of shared.quests) {
      if (quest.completion!=='instant'||!condition(quest,ctx.progress,ctx.state)) continue;
      const draft={slots:ctx.state.slots.slice()};
      if (quest.type==='item') takeItems(draft,quest.items);
      if (!quest.rewards.some(stack=>inventory.insert(draft,stack))) messages.push(complete(quest,ctx));
    }
    return messages.filter(Boolean);
  }
  function readDialog(row,ctx) {
    ctx.progress.dialogs[row.id]=true;
    ctx.flags.progress=true;
    if (row.questId>=0) accept(shared.quests.find(quest=>quest.id===row.questId),ctx);
    return row;
  }
  function findDialog(id,ctx) {
    const row=shared.dialogs.find(dialog=>dialog.id===id);
    if (!row || !availability(row.availability,ctx.progress,ctx.tick)) throw new RequestError(409,'npc_dialog_unavailable');
    return row;
  }
  function getGift(npc,ctx,automatic) {
    if (!giftReady(npc,ctx)) return '';
    const data=npc.jobData;
    const previous=ctx.progress.gifts[npc.id]??{};
    let selected=data.items;
    if (data.givingMethod===0) selected=[selected[Math.floor(random()*selected.length)]];
    if (data.givingMethod===2) selected=selected.filter(item=>itemCount(ctx.state,item)<item.count);
    if (data.givingMethod===3 && selected.some(item=>itemCount(ctx.state,item))) return '';
    if (data.givingMethod===4) selected=[selected[number(previous.index)%selected.length]];
    if (!selected.length) return '';
    if (automatic) {
      const draft={...ctx.state,slots:ctx.state.slots.slice()};
      if (selected.some(stack=>inventory.insert(draft,stack))) return '';
    }
    give(ctx,selected);
    ctx.progress.gifts[npc.id]={at:ctx.time,index:number(previous.index)+1};
    ctx.flags.progress=true;
    return playerText(data.lines[0],ctx.profile);
  }
  const opened=new Map();
  const attackAt=new Map();

  function bankAction(npc,ctx,body) {
    const bank=npc.role==='bank'&&shared.banks.find(row=>row.id===npc.bankId);
    if (!bank) throw new RequestError(409,'npc_bank_missing');
    const saved=ownBank(ctx.progress,bank);
    const {action,slot,count}=body;
    if (action==='bankUpgrade') {
      if (!saved.unlocked) {
        charge(ctx,bank.cost);
        saved.unlocked=true;
      } else if (saved.capacity<bank.max*9) {
        charge(ctx,bank.upgrade);
        saved.capacity+=9;
      }
    } else {
      if (!saved.unlocked) throw new RequestError(409,'npc_bank_locked');
      const deposit=action==='bankDeposit';
      const items=deposit?ctx.state.slots:saved.items;
      if (!Number.isInteger(slot)||slot<0||slot>=(deposit?ctx.state.slots.length:saved.capacity)||
          count!==undefined&&(!Number.isInteger(count)||count<1||count>127)) throw new RequestError(400,'invalid_inventory_slot');
      const selected=items[slot];
      if (!selected) throw new RequestError(409,'npc_missing_items');
      const stack={...selected,count:Math.min(selected.count,count??selected.count)};
      if (deposit) {
        const draft={slots:Array.from({length:saved.capacity},(_,index)=>saved.items[index]??null)};
        if (inventory.insert(draft,stack)) throw new RequestError(409,'npc_bank_full');
        saved.items=draft.slots;
        ctx.flags.inventory=true;
      } else give(ctx,[stack]);
      items[slot]=selected.count===stack.count?null:{...selected,count:selected.count-stack.count};
    }
    ctx.progress.banks[bank.id]=saved;
    ctx.flags.progress=true;
  }

  function act(player,body,position,cancelled) {
    const npc=definitions.get(body.npcId);
    const current=actors.get(body.npcId);
    if (!npc || !current || current.health<=0) throw new RequestError(404,'npc_missing');
    if (!near(player,current.position,npc)) throw new RequestError(403,'outside_reach');
    const active=opened.get(player);
    if (body.action==='attack') {
      const time=now();
      if ((attackAt.get(player)??-Infinity)+300>time) throw new RequestError(429,'npc_attack_cooldown');
      attackAt.set(player,time);
      const killed=actors.receiveAttack(npc,player,position,time);
      let releaseLoot;
      const result=tx(player,ctx=>{
        if (killed) {
          ctx.progress.kills[npc.name]=number(ctx.progress.kills[npc.name])+1;
          ctx.progress.kills[npc.model]=number(ctx.progress.kills[npc.model])+1;
          ctx.progress.experience+=npc.combat.experience;
          ctx.flags.progress=true;
          const loot=npc.combat.drops.filter(row=>random()*100<row.chance).map(row=>row.stack);
          if (prepareLoot) {
            try { releaseLoot=prepareLoot(current.position,loot); }
            catch (error) { if (!(error instanceof RequestError)) throw error; }
          }
          if (!releaseLoot) for (const stack of loot) {
            if (inventory.insert(ctx.state,stack)<stack.count) ctx.flags.inventory=true;
          }
          tryInstant(ctx);
        }
        return {npc:actors.view(npc),interaction:{closed:true}};
      });
      releaseLoot?.();
      return result;
    }
    if (body.action!=='interact' && (!active||active.npcId!==npc.id)) throw new RequestError(409,'npc_interaction_required');
    if (body.action==='close') {
      opened.delete(player);
      return {npc:actors.view(npc),interaction:{closed:true}};
    }
    let interactionUpdate=active?.dialogId ?? null;
    let targetTravel,follow,heal=false;
    const response=tx(player,ctx=>{
      let row=interactionUpdate===null?null:shared.dialogs.find(dialog=>dialog.id===interactionUpdate);
      let message='';
      const {action}=body;
      if (action==='interact') {
        row=null;
        if (npc.job==='itemGiver') message=getGift(npc,ctx,true);
        if (npc.job==='healer') heal=true;
        if (npc.role==='transport'&&npc.transporterId>=0) {
          ctx.progress.transport[npc.transporterId]=true;
          ctx.flags.progress=true;
        }
        const roots=dialogRoots(npc,ctx);
        if (roots.length===1) row=readDialog(roots[0],ctx);
      } else if (action==='dialog') {
        if (!dialogRoots(npc,ctx).some(dialog=>dialog.id===body.dialogId)) throw new RequestError(409,'npc_dialog_unavailable');
        row=readDialog(findDialog(body.dialogId,ctx),ctx);
      } else if (action==='option') {
        if (!row || body.dialogId!==undefined&&body.dialogId!==row.id) throw new RequestError(409,'npc_dialog_unavailable');
        const option=row.options[body.index??body.option];
        if (!option || option.type==='disabled') throw new RequestError(400,'npc_dialog_option');
        if (option.type==='close') {
          interactionUpdate=undefined;
          return {npc:actors.view(npc),interaction:{closed:true}};
        }
        if (option.type==='dialog') row=readDialog(findDialog(option.dialogId,ctx),ctx);
        if (option.type==='role') row=null;
        if (option.type==='command') {
          const say=/^\/?say\s+([^\r\n]+)$/i.exec(option.command);
          if (!say) throw new RequestError(409,'npc_command_unavailable');
          message=playerText(say[1],ctx.profile);
        }
      } else if (action==='acceptQuest'||action==='completeQuest') {
        const quest=shared.quests.find(quest=>quest.id===body.questId);
        if (!quest) throw new RequestError(404,'npc_quest_missing');
        if (action==='acceptQuest') {
          if (row?.questId!==quest.id&&!offerQuest(quest,npc,ctx) || !accept(quest,ctx)) throw new RequestError(409,'npc_quest_unavailable');
        } else {
          if (!npcCanFinish(quest,npc)||!condition(quest,ctx.progress,ctx.state)) throw new RequestError(409,'npc_quest_unfinished');
          message=complete(quest,ctx);
        }
      } else if (action==='trade') {
        const offer=npc.role==='trader'&&npc.trades[body.index];
        if (!offer) throw new RequestError(404,'npc_trade_missing');
        charge(ctx,offer.costs);
        give(ctx,[offer.reward]);
      } else if (action==='transport') {
        const route=npc.role==='transport'&&allowedTransport(npc,ctx)[body.index];
        if (!route?.available) throw new RequestError(409,route?.reason??'npc_transport_unavailable');
        targetTravel=route.position;
        interactionUpdate=undefined;
        return {npc:actors.view(npc),interaction:{closed:true}};
      } else if (action==='gift') {
        if (npc.job!=='itemGiver'||!giftReady(npc,ctx)) throw new RequestError(409,'npc_gift_unavailable');
        message=getGift(npc,ctx,false);
      } else if (action==='heal') {
        if (npc.job!=='healer') throw new RequestError(409,'npc_heal_unavailable');
        heal=true;
      } else if (action==='follow') {
        if (npc.role!=='follower') throw new RequestError(409,'npc_follower_unavailable');
        if (current.following && current.following!==player) throw new RequestError(409,'npc_follower_unavailable');
        follow=current.following?null:player;
      } else if (['bankDeposit','bankWithdraw','bankUpgrade'].includes(action)) bankAction(npc,ctx,body);
      else throw new RequestError(400,'invalid_npc_action');
      interactionUpdate=row?.id??null;
      const messages=[message,...tryInstant(ctx)].filter(Boolean);
      return output(npc,ctx,row,{...(messages.length&&{message:messages.join('\n')})});
    });
    if (targetTravel) {
      const trip=teleportPlayer(player,targetTravel,cancelled);
      if (trip instanceof Promise) return trip.then(teleport=>{
        opened.delete(player);
        return {...response,teleport};
      });
      response.teleport=trip;
    }
    if (heal) healPlayer(player);
    if (follow!==undefined) {
      current.following=follow;
      response.interaction.follower.following=Boolean(follow);
    }
    if (body.action==='interact') {
      const responds=hasConversation(response.interaction);
      if (responds || npc.interactionRotation==='head' || npc.interactionRotation==='body') actors.face(npc,position);
      response.npc=actors.view(npc);
      if (!responds) {
        response.interaction={closed:true};
        interactionUpdate=undefined;
      }
    }
    if (interactionUpdate===undefined) opened.delete(player);
    else opened.set(player,{npcId:npc.id,dialogId:interactionUpdate});
    return response;
  }
  return {act,leave(player) { opened.delete(player);attackAt.delete(player); }};
}
