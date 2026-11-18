import {RequestError} from './errors.mjs';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createInventory} from './inventory.mjs';
import {createNpcActors} from './npc-actors.mjs';
import {createNpcEditor,npcEditorAuth} from './npc-editor.mjs';
import {createNpcInteraction} from './npc-interaction.mjs';
import {clamp,loadNpcSource} from './npc-source.mjs';

export function createNpcs({generated,store,creativeBlocks,creativeItems,adminKey,editorAuth,base,game,worldTime,profile,
  teleportPlayer,damagePlayer=()=>{},healPlayer=()=>{},now=Date.now,random=Math.random,source}) {
  creativeBlocks ??= new Set();
  creativeItems ??= new Map();
  const auth=editorAuth??npcEditorAuth(adminKey,now);
  const inBounds=({x,y,z})=>base.inBounds(x,y,z) && (!base.hasPlayableChunk || base.hasPlayableChunk(x>>4,z>>4));
  const travelBounds = base.worldCoverage ? ({x,y,z})=>base.inBounds(x,y,z) &&
    base.worldCoverage(Math.floor(x/16),Math.floor(z/16)) : inBounds;
  const original=source??loadNpcSource(generated,{creativeBlocks,creativeItems});
  const editor=createNpcEditor({original,auth,store,inBounds,onChange:id=>actors.clear(id)});
  const {definitions,shared}=editor;
  const sounds=new Set();
  if (generated) {
    try {
      for (const name of readdirSync(join(generated,'npcs','sound'))) if (/^[\p{L}\p{N} ._()-]+\.ogg$/iu.test(name)) sounds.add(name);
    } catch (error) { if (error.code!=='ENOENT') throw error; }
  }
  const actors=createNpcActors({
    definitions,shared,now,random,damagePlayer,
    sound:song=>sounds.has(song)?`/generated/npcs/sound/${encodeURIComponent(song)}`:undefined,
    walk:(from,target,npc)=>game.npcWalk ? game.npcWalk(from,target,npc) : (inBounds(target)?target:undefined),
    visibility:(a,b)=>game.npcVisibility ? game.npcVisibility(a,b) : true,
  });
  const inventory=createInventory(store,creativeBlocks,creativeItems);
  const interactions=createNpcInteraction({
    store,inventory,definitions,shared,actors,profile,now,random,teleportPlayer,healPlayer,prepareLoot:game.prepareNpcLoot,
    worldBounds:travelBounds,worldTick:()=>worldTime.snapshot().tick,
    near:(player,point,npc)=>game.npcReach ? game.npcReach(player,point,clamp(npc.scale,.35,2.5)) : near(player,point),
  });
  const playerView = game.npcPlayerView ?? game.session;
  function location(player) { return playerView(player).position; }
  const editorResponse=result=>({...result,sounds:[...sounds].sort()});
  function near(player,point) {
    const own=location(player);
    return Math.hypot(own.x-point.x,own.y-point.y,own.z-point.z)<=6;
  }
  return {
    isAdmin:auth.isAdmin,
    editorAvailable:auth.available,
    sounds,
    snapshot:player=>({npcs:actors.snapshot(location(player)),editor:auth.isAdmin(player),editorAvailable:auth.available}),
    admin(player,key,source) {
      if (!auth.unlock) throw new RequestError(403,'owner_only');
      auth.unlock(player,key,source);
      return {editor:true};
    },
    editor:player=>editorResponse(editor.read(player)),
    edit:(player,body)=>editorResponse(editor.edit(player,body,location(player))),
    action(player,body,cancelled) {
      const session=playerView(player);
      if (session.spectator) throw new RequestError(403,'spectator_action');
      return interactions.act(player,body,session.position,cancelled);
    },
    tick:players=>{if (definitions.size) actors.tick(players);},
    leave:interactions.leave,
  };
}
