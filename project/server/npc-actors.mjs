import {clamp,npcAnimations,npcSpinSpeed,number} from './npc-source.mjs';

const distance = (a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const horizontal = (a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const turn = (source,target)=>Math.atan2(source.x-target.x,source.z-target.z);
const radius=96;
const gazeRadius=7;
const headLimit=Math.PI/4;
const spinSyncMs=2000;
const fullTurn=Math.PI*2;
const angleDelta=(from,to)=>Math.atan2(Math.sin(to-from),Math.cos(to-from));
const nearest = (point,rows,max,location=row=>row.position) => {
  let best=null;
  for (const row of rows) {
    const range=distance(point,location(row));
    if (range<max) { best=row;max=range; }
  }
  return best;
};
const initial = npc => ({position:npc.position,yaw:npc.yaw,headYaw:npc.headYaw??0,pitch:npc.pitch,health:npc.health,moving:false,
  step:0,wanderAt:0,lastAttack:0,target:null,haltUntil:0,animation:npc.animation});
const round = number => Math.round(number*100)/100;
function leaveIdle(current) {
  current.spinAt=undefined;
  current.headYaw=0;
  current.pitch=0;
}

export function createNpcActors({definitions,shared,walk,visibility,damagePlayer,sound,now,random=Math.random,
  settleBed=()=>undefined}) {
  const states=new Map();
  let lastTick=0;
  function state(npc) {
    const previous=npc.position;
    const contact=settleBed(npc);
    let current=states.get(npc.id);
    if (!current) {
      current=initial(npc);
      states.set(npc.id,current);
    } else if (contact && current.position===previous) current.position=contact;
    return current;
  }
  function get(id) {
    const npc=definitions.get(id);
    return npc && state(npc);
  }
  function view(npc,current=state(npc),time=now()) {
    const {id,name,title,model,scale,texture,cloak,showName,showNameWhenAttacking,equipment,held,item,job,jobData}=npc;
    const position=current.position===npc.position ? current.position :
      Object.fromEntries(Object.entries(current.position).map(([axis,value])=>[axis,round(value)]));
    const animation=current.health<=0?'dead':time<current.swingUntil?'attack':time<current.hurtUntil?'hurt':
      current.moving?'walk':npcAnimations.includes(current.animation)?current.animation:'idle';
    return {id,name,title,position,yaw:round(current.yaw),headYaw:round(current.headYaw),pitch:round(current.pitch??0),
      spinSpeed:current.spinAt===undefined?null:npcSpinSpeed(npc.spinSpeed),model,scale,texture,cloak,showName,
      ...(showNameWhenAttacking && {showNameWhenAttacking}),
      animation,moving:current.moving,health:current.health,maxHealth:npc.health,equipment,held,item,
      revision:npc.revision??0,
      ...(job==='bard' && jobData?.song && {bard:{song:jobData.song,instrument:jobData.instrument,minRange:jobData.minRange,
        maxRange:jobData.maxRange,sound:sound(jobData.song)}}),
      ...(current.line && current.line.until>time && {line:current.line.text})};
  }
  function inRange(position,max=radius,includeHidden=false) {
    const result=[];
    for (const npc of definitions.values()) {
      const current=states.get(npc.id);
      if (!includeHidden && current?.health<=0 && npc.combat.hideWhenKilled) continue;
      if (distance(position,current?.position??npc.position)<=max) result.push(npc);
    }
    return result;
  }
  const snapshot=position=>inRange(position).map(npc=>view(npc));
  function say(npc,current,kind,time) {
    const lines=npc.lines?.[kind]??[];
    if (lines.length) current.line={text:lines[Math.floor(random()*lines.length)],until:time+3300};
  }
  const faction=npc=>shared.factions.find(row=>row.id===npc.factionId);
  function hurt(npc,current,damage,time) {
    if (npc.invulnerable || current.health<=0) return false;
    current.health=Math.max(0,current.health-damage);
    if (current.health<=0) {
      current.deadAt=time;
      current.moving=false;
      current.target=null;
      leaveIdle(current);
      say(npc,current,'kill',time);
      return true;
    }
    current.hurtUntil=time+300;
    return false;
  }
  function receiveAttack(npc,player,point,time=now(),damage=3) {
    const current=state(npc);
    if (damage<=0 || current.health<=0 || npc.invulnerable || faction(npc)?.canBeAttacked===false) return false;
    const killed=hurt(npc,current,damage,time);
    if (!killed && npc.combat.behavior!=='ignore') {
      current.target={player,until:time+8000};
      current.yaw=turn(current.position,point);
      leaveIdle(current);
      say(npc,current,'attack',time);
    }
    return killed;
  }
  function spinYaw(npc,current,time) {
    return (current.yaw+(time-current.spinAt)*npcSpinSpeed(npc.spinSpeed)*Math.PI/180_000)%fullTurn;
  }

  function orient(npc,current,rotation,target,time) {
    current.headYaw=npc.headYaw??0;
    current.pitch=npc.pitch??0;
    if (rotation==='spin') {
      current.spinAt??=time;
      if (time-current.spinAt>=spinSyncMs) {
        current.yaw=spinYaw(npc,current,time);
        current.spinAt=time;
      }
      return;
    }
    if (current.spinAt!==undefined) {
      current.yaw=spinYaw(npc,current,time);
      current.spinAt=undefined;
    }
    if (npc.movement.mode==='stationary' && npc.rotation!=='spin') current.yaw=npc.yaw;
    if (!target || rotation!=='body' && rotation!=='head') return;
    const range=horizontal(current.position,target);
    if (range<.01) return;
    const yaw=turn(current.position,target);
    if (rotation==='body') current.yaw=yaw;
    else current.headYaw=clamp(angleDelta(current.yaw,yaw),-headLimit,headLimit);
    current.pitch=clamp(-Math.atan2(target.y-current.position.y,range),-.6,.6);
  }

  function face(npc,point,time=now()) {
    const current=state(npc);
    if (npc.interactionRotation==='none') return;
    current.haltUntil=time+5000;
    const rotation=!npc.interactionRotation || npc.interactionRotation==='default' ? npc.rotation : npc.interactionRotation;
    if (rotation!=='head' && rotation!=='body') return;
    current.interactionLook={point,rotation,until:current.haltUntil};
    orient(npc,current,rotation,point,time);
  }
  function steer(npc,current,target,speed,dt) {
    const {position}=current;
    const range=horizontal(position,target);
    if (range<=.025) return false;
    const length=Math.min(range,speed*dt);
    const x=(target.x-position.x)/range,z=(target.z-position.z)/range;
    const used=npc.movement.mode==='route'||current.target?[0,.42,-.42,.84,-.84,Math.PI/2,-Math.PI/2]:[0,.45,-.45,1,-1];
    if (current.avoid) used.sort((a,b)=>Number(Math.sign(a)!==current.avoid)-Number(Math.sign(b)!==current.avoid));
    for (const angle of used) {
      const tx=position.x+length*(x*Math.cos(angle)-z*Math.sin(angle));
      const tz=position.z+length*(x*Math.sin(angle)+z*Math.cos(angle));
      const next=walk(position,{x:tx,y:position.y,z:tz},npc);
      if (!next) continue;
      current.avoid=angle ? Math.sign(angle) : 0;
      current.position=next;
      current.yaw=turn(position,next);
      return true;
    }
    return false;
  }
  function retreat(current,point) {
    const {position}=current;
    return {x:position.x+(position.x-point.x),y:position.y,z:position.z+(position.z-point.z)};
  }
  function moveByHabit(npc,current,time,dt) {
    const {movement}=npc;
    if (movement.mode==='stationary'||time<current.haltUntil) return false;
    if (movement.mode==='route' && movement.route.length) {
      if (current.routePause>time || movement.loop===false && current.step>=movement.route.length) return false;
      const target=movement.route[current.step % movement.route.length];
      if (horizontal(current.position,target)<.25 && Math.abs(current.position.y-target.y)<=1) {
        current.step++;
        current.routePause=time+number(movement.wait)*1000;
        return false;
      }
      return steer(npc,current,target,movement.speed,dt);
    }
    if (movement.mode==='wander' && movement.range>0) {
      if (time>=current.wanderAt) {
        const angle=random()*Math.PI*2, range=.4+random()*movement.range;
        current.wander={x:npc.position.x+Math.sin(angle)*range,y:npc.position.y,z:npc.position.z+Math.cos(angle)*range};
        current.wanderAt=time+3500+random()*4000;
      }
      return current.wander && distance(current.position,current.wander)>.35 && steer(npc,current,current.wander,movement.speed,dt);
    }
    return false;
  }
  function tick(players) {
    const time=now();
    const dt=clamp((time-lastTick)/1000,0,.25);
    lastTick=time;
    if (!players.length) return;
    const people=players.filter(player=>!player.spectator);
    const active=new Map();
    for (const player of players) for (const npc of inRange(player.position,72,true)) active.set(npc.id,npc);
    for (const npc of active.values()) {
      let current=state(npc);
      if (current.health<=0) {
        if (!npc.combat.respawn || time-current.deadAt<npc.combat.respawn*1000) continue;
        current=initial(npc);
        states.set(npc.id,current);
      }
      current.moving=false;
      if (npc.lines.world.length && time>=number(current.nextLine)) {
        current.nextLine=time+15000+random()*19000;
        say(npc,current,'world',time);
      }
      if (current.following) {
        leaveIdle(current);
        const guide=players.find(player=>player.id===current.following);
        if (guide && distance(current.position,guide.position)>2) current.moving=steer(npc,current,guide.position,npc.movement.speed,dt);
        continue;
      }
      const {combat}=npc;
      const victim=current.target?.until>time ? people.find(player=>player.id===current.target.player) : null;
      const hostile= combat.hostile || faction(npc)?.attackPlayers;
      const target=victim ?? (hostile ? nearest(current.position,people,Math.max(combat.range,9)) : null);
      if (target) {
        leaveIdle(current);
        const {position}=target;
        const range=distance(current.position,position);
        if (range>Math.max(combat.range,24)) current.target=null;
        else if (combat.behavior==='retreat') current.moving=steer(npc,current,retreat(current,position),combat.speed,dt);
        else if (range>Math.min(combat.range,2.3)) current.moving=steer(npc,current,position,combat.speed,dt);
        else if (time-current.lastAttack>=combat.interval && visibility(current.position,position)) {
          current.lastAttack=time;
          current.swingUntil=time+350;
          current.yaw=turn(current.position,position);
          damagePlayer(target.id,combat.damage,npc);
        }
        continue;
      }
      if (combat.guard || combat.attackOtherFactions) {
        const enemies=faction(npc)?.attackFactions??[];
        const target=nearest(current.position,[...active.values()]
          .filter(other=>other!==npc && enemies.includes(other.factionId) && state(other).health>0),
        npc.jobData.guardRange,other=>state(other).position);
        if (target) {
          leaveIdle(current);
          const victim=state(target);
          if (distance(current.position,victim.position)>Math.min(combat.range,2.3))
            current.moving=steer(npc,current,victim.position,combat.speed,dt);
          else if (time-current.lastAttack>=combat.interval && visibility(current.position,victim.position)) {
            current.lastAttack=time;
            current.swingUntil=time+350;
            current.yaw=turn(current.position,victim.position);
            hurt(target,victim,combat.damage,time);
          }
          continue;
        }
      }
      current.moving=Boolean(moveByHabit(npc,current,time,dt));
      if (current.moving) {
        leaveIdle(current);
        continue;
      }
      if (current.interactionLook?.until>time) {
        const {point,rotation}=current.interactionLook;
        orient(npc,current,rotation,point,time);
      } else {
        current.interactionLook=undefined;
        const {rotation}=npc;
        const person=rotation==='head'||rotation==='body'?nearest(current.position,people,gazeRadius):null;
        const target=person && visibility(current.position,person.position)?person.position:null;
        orient(npc,current,rotation,target,time);
      }
    }
  }
  return {snapshot,get,view,tick,face,receiveAttack,clear:id=>states.delete(id)};
}
