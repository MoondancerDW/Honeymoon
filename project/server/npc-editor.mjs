import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {RequestError} from './errors.mjs';
import {clamp,list,npcAnimations,npcJobs,npcRoles,npcSharedCollections,number,point,text} from './npc-source.mjs';

const digest = value => createHash('sha256').update(value).digest();
const nonEmpty = (value,cap=128) => typeof value==='string' && value.trim().length>0 && value.length<=cap &&
  !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value);
const names = ['stationary','wander','route'];
const textureId = value => /^\/(?:mob|twilightforest|mods|generated\/npcs\/skins)\/(?!.*(?:\.\.|[\\:?#]))[\p{L}\p{N} ._()\/-]+\.png$/iu.test(value);
const allowedId = /^[-a-z0-9]{1,64}$/i;
const stackKey = /^(?:creative|legacy):\d{1,5}:\d{1,5}$/;
const compound = value => value && typeof value==='object' && !Array.isArray(value);

export function npcEditorAuth(key,now) {
  const admins=new Set(), attempts=new Map();
  const expected=typeof key==='string' && key.length>0 ? digest(key) : null;
  return {
    available:Boolean(expected),
    isAdmin:player=>admins.has(player),
    unlock(player,value,source) {
      if (!expected) throw new RequestError(403,'npc_editor_disabled');
      if (admins.has(player)) return;
      const time=now();
      let limit=attempts.get(source);
      if (!limit || limit.at+60_000<=time) {
        if (attempts.size>=1024) attempts.delete(attempts.keys().next().value);
        limit={at:time,count:0};
        attempts.set(source,limit);
      }
      if (limit.count>=8) throw new RequestError(429,'npc_editor_rate_limit');
      if (typeof value!=='string' || value.length>1024 || !timingSafeEqual(digest(value),expected)) {
        limit.count++;
        throw new RequestError(403,'npc_editor_key');
      }
      attempts.delete(source);
      admins.add(player);
    },
    require(player) {
      if (!admins.has(player)) throw new RequestError(403,'npc_editor_required');
    },
  };
}

function item(value) {
  if (!compound(value) || !stackKey.test(value.key) || !Number.isInteger(value.count??1) ||
      (value.count??1)<1 || (value.count??1)>127) throw new RequestError(400,'invalid_npc_stack');
  return {...value,count:value.count??1};
}

function items(rows,cap=64) {
  return list(rows).slice(0,cap).map(item);
}

function npcLocation(input,inBounds) {
  const location=point(input);
  if (!location || !inBounds(location)) throw new RequestError(400,'invalid_npc_position');
  return location;
}

export function sanitizeNpc(raw,previous,inBounds) {
  if (!compound(raw) || !nonEmpty(raw.name) || !/^[a-z][a-z0-9_.-]{0,63}$/i.test(raw.model??'')) {
    throw new RequestError(400,'invalid_npc_definition');
  }
  const {movement={},combat={},jobData={},lines={}}=raw;
  if (![movement,combat,jobData,lines].every(compound)) throw new RequestError(400,'invalid_npc_definition');
  const id=previous?.id ?? randomUUID();
  const texture=text(raw.texture).slice(0,260);
  const cloak=text(raw.cloak).slice(0,260);
  if (texture && texture!==previous?.texture && !textureId(texture) ||
      cloak && cloak!==previous?.cloak && !textureId(cloak)) {
    throw new RequestError(400,'invalid_npc_texture');
  }
  return {
    id,name:raw.name.trim(),title:text(raw.title).slice(0,128),position:npcLocation(raw.position,inBounds),
    revision:(previous?.revision??0)+1,yaw:number(raw.yaw)% (Math.PI*2),pitch:clamp(number(raw.pitch),-Math.PI/2,Math.PI/2),
    model:raw.model,scale:clamp(number(raw.scale,1),.2,6),texture,cloak,showName:raw.showName!==false,
    animation:npcAnimations.slice(0,6).includes(raw.animation)?raw.animation:'idle',
    health:clamp(number(raw.health,20),1,10000),invulnerable:Boolean(raw.invulnerable),
    rotation:['head','body','fixed'].includes(raw.rotation)?raw.rotation:'head',
    factionId:number(raw.factionId),role:npcRoles.includes(raw.role)?raw.role:'none',job:npcJobs.includes(raw.job)?raw.job:'none',
    movement:{mode:names.includes(movement.mode)?movement.mode:'stationary',
      speed:clamp(number(movement.speed,1.5),.1,12),range:clamp(number(movement.range,5),0,96),
      route:list(movement.route).slice(0,128).map(location=>npcLocation(location,inBounds)),
      loop:movement.loop!==false,wait:clamp(number(movement.wait),0,60)},
    combat:{damage:clamp(number(combat.damage,5),0,100),range:clamp(number(combat.range,2),1,32),
      speed:clamp(number(combat.speed,1.8),.1,12),interval:clamp(number(combat.interval,900),150,12000),
      behavior:['fight','retreat','ignore'].includes(combat.behavior)?combat.behavior:'fight',
      respawn:clamp(number(combat.respawn,20),0,3600),hideWhenKilled:Boolean(combat.hideWhenKilled),
      hostile:Boolean(combat.hostile),guard:Boolean(combat.guard),attackOtherFactions:Boolean(combat.attackOtherFactions),
      experience:clamp(number(combat.experience),0,100000),
      drops:list(combat.drops).slice(0,64).map(row=>({stack:item(row.stack),chance:clamp(number(row.chance,100),0,100)}))},
    dialogIds:list(raw.dialogIds).filter(value=>Number.isSafeInteger(value) && value>=0).slice(0,128),
    trades:list(raw.trades).slice(0,128).map(row=>({costs:items(row.costs,9),reward:item(row.reward)})),
    transport:list(raw.transport).slice(0,128).map(row=>({name:text(row.name).slice(0,128),position:npcLocation(row.position,inBounds),
      dimension:0,type:0})),
    transporterId:number(raw.transporterId,-1),bankId:number(raw.bankId),
    equipment:Array.from({length:4},(_,i)=>raw.equipment?.[i]?item(raw.equipment[i]):null),
    held:raw.held?{...item(raw.held),kind:'item'}:null,
    ...(raw.model==='item' && {item:item(raw.item)}),
    jobData:{items:items(jobData.items),lines:list(jobData.lines).map(row=>text(row).slice(0,2000)).slice(0,32),
      givingMethod:clamp(number(jobData.givingMethod),0,4),cooldownType:clamp(number(jobData.cooldownType),0,2),
      cooldown:clamp(number(jobData.cooldown,10),0,86400),song:text(jobData.song).slice(0,256),instrument:clamp(number(jobData.instrument),0,4),
      streamer:Boolean(jobData.streamer),minRange:clamp(number(jobData.minRange,3),0,64),
      maxRange:clamp(number(jobData.maxRange,16),1,96),guardRange:clamp(number(jobData.guardRange,16),1,96)},
    lines:Object.fromEntries(['interact','world','attack','kill'].map(kind=>
      [kind,list(lines[kind]).map(value=>text(value).slice(0,2000)).filter(Boolean).slice(0,32)])),
    ...(previous?.native ? {native:previous.native} : {}),
  };
}

function safeAvailability(input) {
  return {
    day:['always','day','night'].includes(input?.day)?input.day:'always',
    dialogs:list(input?.dialogs).filter(row=>Number.isSafeInteger(row?.id) && ['after','before'].includes(row.rule)).slice(0,16),
    quests:list(input?.quests).filter(row=>Number.isSafeInteger(row?.id) && ['after','before','active','inactive'].includes(row.rule)).slice(0,16),
  };
}

export function sanitizeNpcContent(collection,raw,id,inBounds) {
  if (!compound(raw) || !Number.isSafeInteger(id) || id<0 || id>100000000) throw new RequestError(400,'invalid_npc_content');
  const content={...raw,id};
  if (collection==='dialogs') {
    return {...content,title:text(raw.title).slice(0,128),text:text(raw.text).slice(0,20000),questId:number(raw.questId,-1),
      options:list(raw.options).slice(0,32).map(row=>({title:text(row?.title).slice(0,128),
        type:['close','dialog','disabled','role','command'].includes(row?.type)?row.type:'disabled',
        dialogId:number(row?.dialogId,-1),color:clamp(number(row?.color,0xe0e0e0),0,0xffffff),command:text(row?.command).slice(0,1000)})),
      availability:safeAvailability(raw.availability)};
  }
  if (collection==='quests') {
    return {...content,title:text(raw.title).slice(0,128),text:text(raw.text).slice(0,20000),
      completeText:text(raw.completeText).slice(0,20000),items:items(raw.items),rewards:items(raw.rewards),
      dialogs:list(raw.dialogs).filter(Number.isSafeInteger).slice(0,32),
      kills:list(raw.kills).filter(row=>nonEmpty(row?.name)&&Number.isSafeInteger(row.count)&&row.count>0).slice(0,32),
      type:['item','dialog','kill'].includes(raw.type)?raw.type:'item',completion:raw.completion==='instant'?'instant':'npc',
      repeat:['once','repeat','daily','weekly'].includes(raw.repeat)?raw.repeat:'once',completer:text(raw.completer).slice(0,128),
      experience:clamp(number(raw.experience),0,100000)};
  }
  if (collection==='transport') return {...content,dimension:0,position:npcLocation(raw.position,inBounds),
    name:text(raw.name).slice(0,128),type:clamp(number(raw.type),0,2)};
  if (collection==='factions') return {...content,name:text(raw.name).slice(0,128),color:clamp(number(raw.color,0xffffff),0,0xffffff),
    attackFactions:list(raw.attackFactions).filter(Number.isSafeInteger).slice(0,128)};
  if (collection==='recipes') return {...content,name:text(raw.name).slice(0,128),items:items(raw.items,9),
    result:item(raw.result),global:Boolean(raw.global),availability:safeAvailability(raw.availability)};
  if (collection==='banks') return {...content,name:text(raw.name).slice(0,128),cost:items(raw.cost),upgrade:items(raw.upgrade),
    start:clamp(number(raw.start,1),1,64),max:clamp(number(raw.max,6),1,64)};
  throw new RequestError(400,'invalid_npc_content');
}

export function createNpcEditor({store,original,auth,inBounds,onChange}) {
  const source=new Map(original.definitions.map(npc=>[npc.id,npc]));
  const edits=new Map(store.getState('npcs','','definitions')?.value ?? []);
  const shared=store.getState('npcs','','shared')?.value ?? original.shared;
  const definitions=new Map(source);
  for (const [id,entry] of edits) {
    if (entry===null) definitions.delete(id);
    else definitions.set(id,entry);
  }
  const response=()=>({definitions:[...definitions.values()],shared,editor:true});
  const persist=changes=>store.atomic(()=>store.putState('npcs','','definitions',1,[...changes]));
  function set(id,entry) {
    const updated=new Map(edits);
    if (entry===null && !source.has(id)) updated.delete(id);
    else updated.set(id,entry);
    persist(updated);
    if (updated.has(id)) edits.set(id,entry); else edits.delete(id);
    if (entry) definitions.set(id,entry); else definitions.delete(id);
    onChange(id);
  }
  return {
    definitions,shared,
    read(player) {
      auth.require(player);
      return response();
    },
    edit(player,body,location) {
      auth.require(player);
      const {action,npcId,definition,collection}=body;
      const id=npcId ?? definition?.id;
      if (id!==undefined && !allowedId.test(id)) throw new RequestError(400,'invalid_npc');
      if (action==='save') {
        const previous=definitions.get(id);
        if (id && !previous) throw new RequestError(404,'npc_missing');
        if (previous && definition.revision!==undefined && (previous.revision??0)!==definition.revision) {
          throw new RequestError(409,'npc_definition_changed');
        }
        const npc=sanitizeNpc(definition,previous,inBounds);
        set(npc.id,npc);
      } else if (action==='remove' || action==='clone') {
        const npc=definitions.get(id);
        if (!npc) throw new RequestError(404,'npc_missing');
        if (action==='clone') {
          const clone=sanitizeNpc({...npc,position:point(body.position)??location},undefined,inBounds);
          set(clone.id,clone);
        } else set(id,null);
      } else if (action==='saveShared' || action==='removeShared') {
        const changed={...shared};
        if (body.shared && action==='saveShared') {
          for (const name of npcSharedCollections) {
            if (!Array.isArray(body.shared[name]) || body.shared[name].length>1024) throw new RequestError(400,'invalid_npc_content');
            changed[name]=body.shared[name].map(row=>{
              const kept=shared[name].find(entry=>entry.id===row.id && entry.dimension!==0);
              return kept && JSON.stringify(kept)===JSON.stringify(row)?kept:sanitizeNpcContent(name,row,row.id,inBounds);
            });
          }
        } else {
          if (!npcSharedCollections.includes(collection)) throw new RequestError(400,'invalid_npc_content');
          const contentId=body.id ?? definition?.id ?? (action==='saveShared' ?
            1+list(shared[collection]).reduce((highest,row)=>Math.max(highest,row.id),0) : undefined);
          if (!Number.isSafeInteger(contentId)) throw new RequestError(400,'invalid_npc_content');
          const others=list(shared[collection]).filter(entry=>entry.id!==contentId);
          changed[collection]=action==='saveShared'?[...others,sanitizeNpcContent(collection,definition,contentId,inBounds)]:others;
        }
        store.atomic(()=>store.putState('npcs','','shared',1,changed));
        Object.assign(shared,changed);
        onChange();
      } else throw new RequestError(400,'invalid_npc_action');
      return response();
    },
  };
}
