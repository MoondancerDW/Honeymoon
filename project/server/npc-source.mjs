import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {blockKey} from '../world/block-interactions.mjs';
import {ponyArmor} from '../world/pony-armor.mjs';

export const npcRoles = ['none','trader','follower','bank','transport'];
export const npcJobs = ['none','bard','healer','guard','itemGiver'];
export const npcAnimations = ['idle','walk','sit','crawl','sneak','dance','attack','hurt','dead'];
export const npcRotations = ['head','body','fixed','spin'];
export const npcInteractionRotations = ['default','none','head','body'];
export const list = value => Array.isArray(value) ? value : [];
export const text = (value, fallback = '') => typeof value === 'string' ? value : fallback;
export const number = (value,fallback=0) => Number.isFinite(value) ? value : fallback;
export const clamp = (value,min,max) => Math.min(max,Math.max(min,value));
export const npcSpinSpeed = value => clamp(number(value)||45,-180,180);
export const point = value => {
  const [x,y,z] = Array.isArray(value) ? value : [value?.x,value?.y,value?.z];
  return [x,y,z].every(Number.isFinite) ? {x,y,z} : null;
};
export const nativeItems = value => list(value?.NpcMiscInv ?? value);
const idOf = row => row?.DialogId ?? row?.Id ?? row?.ID;
export const npcSharedCollections = ['dialogs','quests','transport','factions','recipes','banks'];
const radians = degrees => number(degrees) * Math.PI / 180;
const wrapAngle = angle => Math.atan2(Math.sin(angle),Math.cos(angle));
// Minecraft yaw 0 faces +Z and 90 faces -X. The web model starts facing -Z.
const nativeYaw = degrees => wrapAngle(Math.PI-radians(degrees));
const ordered = (rows,key) => list(rows).toSorted((a,b)=>number(a[key])-number(b[key]));

export function nativeNpcStack(raw, creativeBlocks, creativeItems) {
  const {id, Count:count=1, Damage:damage=0, Slot:_, tag, ...legacyNbt} = raw ?? {};
  if (!Number.isInteger(id) || id<1 || id>32767 || !Number.isInteger(count) || count<1 || count>127 ||
      !Number.isInteger(damage) || damage<0 || damage>32767) return null;
  const sourceKey = `creative:${id}:${damage}`;
  const entry = creativeItems.get(sourceKey);
  const legacy = blockKey(id,damage);
  const cell = entry?.blockKey ?? (!entry && creativeBlocks.has(legacy) ? legacy : undefined);
  return {key:entry || !cell ? sourceKey : cell,count,...(cell && {cell}),...(entry?.part && {part:entry.part,pattern:entry.part.pattern}),
    ...(tag !== undefined && {nbt:tag}),...(Object.keys(legacyNbt).length && {legacyNbt})};
}

function nativeAvailability(raw) {
  return {
    day:['always','night','day'][raw.AvailabilityDayTime] ?? 'always',
    dialogs:[['AvailabilityDialog','AvailabilityDialogId'],['AvailabilityDialog2','AvailabilityDialog2Id']].flatMap(([rule,key])=>
      raw[rule] && Number.isInteger(raw[key]) && raw[key]>=0 ? [{id:raw[key],rule:['always','after','before'][raw[rule]]}] : []),
    quests:[['AvailabilityQuest','AvailabilityQuestId'],['AvailabilityQuest2','AvailabilityQuest2Id']].flatMap(([rule,key])=>
      raw[rule] && Number.isInteger(raw[key]) && raw[key]>=0 ? [{id:raw[key],rule:['always','after','before','active','inactive'][raw[rule]]}] : []),
  };
}

function nativeShared(source, stack) {
  const inventory = rows => nativeItems(rows).map(stack).filter(Boolean);
  const categoryRows = (categories,translate) => list(categories).flatMap(group =>
    list(group.Dialogs).filter(row=>Number.isInteger(idOf(row))).map(row=>translate(row,text(group.Title))));
  const dialogs = categoryRows(source.dialog?.Data,(raw,category)=>({
    id:raw.DialogId,title:text(raw.DialogTitle),text:text(raw.DialogText),category,questId:number(raw.DialogQuest,-1),
    options:ordered(raw.Options,'OptionSlot').map(entry=>entry.Option).filter(Boolean).map(option=>({
      title:text(option.Title),type:['close','dialog','disabled','role','command'][option.OptionType] ?? 'disabled',
      dialogId:number(option.Dialog,-1),color:number(option.DialogColor,0xe0e0e0),command:text(option.DialogCommand),
    })),availability:nativeAvailability(raw),
  }));
  const quests = categoryRows(source.quests?.Data,(raw,category)=>({
    id:raw.Id,title:text(raw.Title),text:text(raw.Text),completeText:text(raw.CompleteText),category,
    type:['item','dialog','kill'][raw.Type] ?? 'item',items:inventory(raw.Items),rewards:inventory(raw.Rewards),
    dialogs:list(raw.QuestDialogs).map(row=>row.Integer).filter(Number.isInteger),
    kills:list(raw.QuestKills ?? raw.Targets).flatMap(row=>typeof row.Name==='string' ? [{name:row.Name,count:number(row.Count,1)}] : []),
    completer:text(raw.CompleterNpc),completion:raw.QuestCompletion===1?'instant':'npc',
    repeat:['once','repeat','daily','weekly'][raw.QuestRepeat] ?? 'once',experience:number(raw.RewardExp),
  }));
  const transport = list(source.transport?.NPCTransportCategories).flatMap(group=>list(group.CategoryLocations)
    .flatMap(raw=>{
      const position=point([raw.PosX,raw.PosY,raw.PosZ]);
      const anchor=point([raw.PosNpcX+.5,raw.PosNpcY+1,raw.PosNpcZ+.5]);
      return position ? [{id:raw.Id,name:text(raw.Name),position,anchor,category:group.CategoryId,categoryName:text(group.CategoryTitle),
        dimension:number(raw.Dimension),type:number(raw.Type)}] : [];
    }));
  const factions = list(source.factions?.NPCFactions).map(raw=>({
    id:raw.Slot,name:text(raw.Name),color:number(raw.Color,0xffffff),attackPlayers:Boolean(raw.AttackPlayers),
    attackFactions:list(raw.AttackFactions).map(row=>row.Integer).filter(Number.isInteger),
    canBeAttacked:Boolean(raw.CanBeAttacked),helpEachOther:Boolean(raw.HelpEachOther),
  }));
  const recipes = list(source.recipes?.Data).flatMap(raw=>{
    const result=stack(raw.Item);
    return result ? [{id:raw.ID,name:text(raw.Name),items:inventory(raw.Materials),materials:ordered(raw.Materials,'Slot')
      .flatMap(row=>stack(row)?[{slot:row.Slot,item:stack(row)}]:[]),
      result,width:number(raw.Width,1),height:number(raw.Height,1),global:Boolean(raw.Global),
      availability:nativeAvailability(raw.Availability ?? {})}] : [];
  });
  const banks = list(source.bank?.Data).map(raw=>({
    id:raw.BankID,name:text(raw.Username),start:number(raw.StartSlots,1),max:number(raw.MaxSlots,6),
    cost:inventory(raw.BankCurrency),upgrade:inventory(raw.BankUpgrade),types:list(raw.BankTypes),
  }));
  return {dialogs,quests,transport,factions,recipes,banks};
}

function nativeEntity(raw, stack) {
  const position = point(raw.Pos);
  if (!position || typeof raw.id!=='string') return null;
  const vital = number(raw.MaxHealth,20);
  const name = text(raw.Name,raw.id);
  const sourceId = raw.sourceId ?? [raw.UUIDMost?.value??raw.UUIDMost,raw.UUIDLeast?.value??raw.UUIDLeast,
    raw.id,raw.Dimension,...raw.Pos].join(':');
  const id = 'native-'+createHash('sha256').update(String(sourceId)).digest('hex').slice(0,24);
  const lines = rows => list(rows).map(row=>text(row.Line)).filter(Boolean);
  const animation = ['idle','walk','sit','crawl','sneak','walk','dance'][raw.MoveState] ?? 'idle';
  const rotation = ['head','body','fixed','body'][raw.StandingState] ?? 'head';
  // The old renderer uses the authored orientation for the head-only and fixed modes.
  const staticBody=rotation==='head'||rotation==='fixed';
  const facing=staticBody&&Number.isFinite(raw.Orientation)?raw.Orientation:raw.Rotation?.[0];
  const pitch=radians(rotation==='fixed'?(raw.HeadRotationY??raw.Rotation?.[1]):raw.Rotation?.[1]);
  const walking = raw.MoveState===1 || raw.MoveState===5;
  const role = npcRoles[raw.Role] ?? 'none';
  const job = npcJobs[raw.NpcJob] ?? 'none';
  const equipment = [null,null,null,null];
  for (const item of nativeItems(raw.Armor)) {
    const converted = stack(item);
    const slot = converted && (ponyArmor(converted.key)?.slot ?? 3-item.Slot);
    if (slot>=0 && slot<equipment.length) equipment[slot]=converted;
  }
  const weapons = nativeItems(raw.Weapons).map(stack).filter(Boolean);
  const drops = nativeItems(raw.NpcInv).flatMap(item=>{
    const converted=stack(item);
    const chance=list(raw.DropChance).find(row=>row.Slot===item.Slot)?.Integer ?? 100;
    return converted ? [{stack:converted,chance}] : [];
  });
  const dialogIds = ordered(raw.NPCDialogOptions,'DialogSlot').map(row=>row.NPCDialog?.Dialog)
    .filter(id=>Number.isInteger(id)&&id>=0);
  const trades = ordered(nativeItems(raw.TraderSold),'Slot').flatMap(rawItem=>{
    const reward=stack(rawItem);
    const cost=stack(nativeItems(raw.TraderCurrency).find(item=>item.Slot===rawItem.Slot));
    return reward && cost ? [{costs:[cost],reward}] : [];
  });
  return {
    id,name,title:text(raw.Title),position,yaw:nativeYaw(facing),pitch,
    ...(rotation==='fixed' && Number.isFinite(raw.HeadRotationX) && {headYaw:wrapAngle(radians(number(facing)-raw.HeadRotationX))}),
    model:raw.id,scale:clamp(number(raw.Size,5)/5,.2,6),
    texture:text(raw.Texture),cloak:text(raw.CloakTexture),showName:raw.ShowName!==1 && raw.ShowName!==2,
    ...(raw.ShowName===2 && {showNameWhenAttacking:true}),animation,factionId:number(raw.FactionID),
    health:clamp(vital,1,10000),invulnerable:Boolean(raw.Invulnerable),rotation,
    movement:{mode:walking?'wander':'stationary',speed:clamp(number(raw.WalkingSpeed,5)*.34,.1,12),
      range:clamp(number(raw.WalkingRange,5),0,96),route:[]},
    combat:{damage:clamp(number(raw.AttackStrenght,5),0,100),range:clamp(number(raw.AttackRange,2),1,32),
      speed:clamp(number(raw.AttackWalkingSpeed,5)*.34,.1,12),interval:clamp(number(raw.AttackSpeed,20)*50,150,12000),
      behavior:['fight','retreat','ignore'][raw.OnAttack] ?? 'fight',respawn:clamp(number(raw.RespawnTime,20),0,3600),
      hideWhenKilled:Boolean(raw.HideWhenKilled),hostile:false,guard:job==='guard',drops,
      experience:number(raw.MaxExp),attackOtherFactions:Boolean(raw.AttackOtherFactions)},
    equipment,held:weapons[0]?{kind:'item',key:weapons[0].key}:null,
    role,job,dialogIds,trades,transport:[],transporterId:number(raw.TransporterId,-1),bankId:number(raw.BankId ?? raw.BankID),
    jobData:{items:nativeItems(raw.igJobInventory).map(stack).filter(Boolean),lines:lines(raw.igLines),
      givingMethod:number(raw.igGivingMethod),cooldownType:number(raw.igCooldownType),cooldown:number(raw.igCooldown,10),
      song:text(raw.BardSong),instrument:number(raw.BardInstrument),streamer:Boolean(raw.BardStreamer),
      minRange:number(raw.BardMinRange,3),maxRange:number(raw.BardMaxRange,16),guardRange:number(raw.GuardAttackRange,16)},
    lines:{interact:lines(raw.NpcInteractLines),world:lines(raw.NpcLines),attack:lines(raw.NpcAttackLines),kill:lines(raw.NpcKilledLines)},
    native:raw,
  };
}

export function loadNpcSource(generated,{creativeBlocks=new Set(),creativeItems=new Map()}={}) {
  let source;
  try { source=JSON.parse(readFileSync(join(generated,'npcs','original.json'),'utf8')); }
  catch (error) {
    if (error.code!=='ENOENT') throw error;
    source={};
  }
  const stack=raw=>nativeNpcStack(raw,creativeBlocks,creativeItems);
  const shared=nativeShared(source.shared ?? {},stack);
  const definitions=list(source.entities).map(raw=>nativeEntity(raw,stack)).filter(Boolean);
  for (const npc of definitions) {
    if (npc.role!=='transport' || npc.transporterId>=0) continue;
    const {x,y,z}=npc.position;
    const bound=shared.transport.find(({anchor,dimension})=>!dimension && anchor &&
      Math.hypot(x-anchor.x,y-anchor.y,z-anchor.z)<1.5);
    if (bound) npc.transporterId=bound.id;
  }
  return {definitions,shared};
}
