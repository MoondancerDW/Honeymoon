import assert from 'node:assert/strict';
import test from 'node:test';
import {createGame} from './game.mjs';
import {openStore} from './store.mjs';
import {createSurvival} from './survival.mjs';
import * as geometry from '../world/geometry.mjs';

function fixture(t) {
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const survival=createSurvival(store,'creative');
  const {id}=store.createPlayer();
  const cells=new Map([['4,1,4','legacy:58:0'],['5,1,4','legacy:2168:0']]);
  const catalog=new Set(['legacy:1:0','legacy:58:0','legacy:2168:0','legacy:54:0','legacy:37:0','legacy:5:0']);
  const base={hash:'world-use',catalog,manifest:{spawn:[4.5,1,7.5],bounds:{minX:0,maxX:15,minY:0,maxY:15,minZ:0,maxZ:15}},
    inBounds:(...point)=>point.every(n=>n>=0&&n<=15),
    getCell(x,y,z) {return {key:cells.get([x,y,z].join(','))??(y===0?'legacy:1:0':'air'),object:null};}};
  const creativeItems=new Map([['creative:354:0',{id:354,damage:0,blockKey:'legacy:92:0'}],
    ['creative:390:0',{id:390,damage:0,blockKey:'legacy:140:0'}],['creative:357:0',{id:357,damage:0}]]);
  const game=createGame(base,store,geometry,{allowRemoval:true,modules:[],creativeBlocks:catalog,creativeItems,survival});
  game.session(id);
  let sequence=0;
  const call=body=>game.action(id,{requestId:`objects-${++sequence}`,expectedRevision:0,...body});
  const action=body=>{
    const result=call(body);
    assert.equal(result.status,200,JSON.stringify(result.output));
    return result.output;
  };
  const give=(key,count=1)=>action({type:'inventory_give',key,count,slot:0});
  return {game,survival,id,call,action,give};
}

test('placing a pot item and planting a flower writes one ground-level block and spends the flower',t=>{
  const {action,give,survival,id}=fixture(t);
  give('creative:390:0');
  const position={x:3,y:1,z:5};
  const placed=action({type:'place',...position,creativeItem:'creative:390:0',cell:'legacy:140:0',yaw:0,
    against:{...position,y:0}}).changes[0];
  give('legacy:37:0',2);
  survival.setMode(id,'game');
  const planted=action({type:'interact',...position,expectedRevision:placed.revision});
  assert.equal(planted.changes.length,1);
  assert.equal(planted.changes[0].y,position.y);
  assert.equal(planted.changes[0].cell,'legacy:140:2');
  assert.equal(planted.inventory.slots[0].count,1);
  assert.ok(geometry.shapeFor('legacy:140:2').some(box=>box.kind==='cross'));
});

test('jar stores and shows a cookie and cake heals two health for each of six slices',t=>{
  const {action,give,survival,id}=fixture(t);
  give('creative:357:0');
  const filled=action({type:'interact',x:5,y:1,z:4}).changes[0];
  assert.equal(filled.object.data.jarContent,'cookie');
  assert.ok(geometry.shapeFor({key:filled.cell,object:filled.object}).length>2);

  give('creative:354:0');
  const position={x:3,y:1,z:5};
  let cake=action({type:'place',...position,creativeItem:'creative:354:0',cell:'legacy:92:0',against:{...position,y:0}}).changes[0];
  survival.setMode(id,'game');
  for (let slice=1;slice<=6;slice++) {
    survival.damage(id,3,{x:4.5,y:1,z:7.5},1);
    const before=survival.status(id).health;
    cake=action({type:'interact',...position,expectedRevision:cake.revision}).changes[0];
    assert.equal(survival.status(id).health,before+2);
    assert.equal(cake.cell,slice===6?null:`legacy:92:${slice}`);
  }
});

test('workbench crafting validates the visible table and existing chests face the player',t=>{
  const {action,give,game,id}=fixture(t);
  give('legacy:5:0',8);
  assert.throws(()=>game.craft(id,'chest'),{code:'workbench_required'});
  assert.throws(()=>game.craft(id,'chest',{x:4,y:1,z:4,expectedRevision:1}),{code:'stale_cell'});
  const state=game.craft(id,'chest',{x:4,y:1,z:4,expectedRevision:0});
  assert.equal(state.slots.find(stack=>stack?.key==='legacy:54:0')?.count,1);
  const position={x:3,y:1,z:5};
  let result=action({type:'place',...position,against:{...position,y:0},cell:'legacy:54:0',yaw:Math.PI/2});
  assert.equal(result.changes[0].cell,'legacy:54:5');
  result=action({type:'remove',...position,expectedRevision:result.changes[0].revision});
  assert.ok(result.effects.some(effect=>effect.type==='break'&&effect.sound==='block.break'));
});
