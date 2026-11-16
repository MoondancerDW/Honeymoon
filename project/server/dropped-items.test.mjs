import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {createDroppedItems} from './dropped-items.mjs';
import {createGame} from './game.mjs';
import {createHoneymoonServer} from './index.mjs';
import {openStore} from './store.mjs';
import * as geometry from '../world/geometry.mjs';

const dirt = 'legacy:3:0';
const stone = 'legacy:1:0';
const bounds = {minX:0, maxX:15, minY:0, maxY:15, minZ:0, maxZ:15};
const available = new Set([dirt,stone]);
const at = (key,count) => ({key,cell:key,count});
const miniature = (wall = false) => ({
  hash:'drop-fixture', manifest:{bounds, spawn:[8.5,1,8.5]}, catalog:available,
  inBounds:(x,y,z) => [x,y,z].every(value => value >= 0 && value < 16),
  getCell(x,y,z) { return {key:y === 0 ? stone : wall && x === 9 && y < 4 ? 'legacy:102:0' : 'air',object:null}; },
});

function fixture(t, wall = false) {
  const store = openStore(':memory:');
  t.after(() => store.close());
  let sequence = 0, now = 0;
  const base = miniature(wall);
  const open = () => createGame(base,store,geometry,{modules:[],clock:() => now,creativeBlocks:available});
  let game = open();
  const player = store.createPlayer().id;
  const observer = store.createPlayer().id;
  const request = (person, type, fields = {}, requestId = 'drop-fixture-' + ++sequence) =>
    game.action(person,{requestId,type,...fields});
  const action = (person,type,fields,requestId) => {
    const result = request(person,type,fields,requestId);
    assert.equal(result.status,200,JSON.stringify(result.output));
    return result.output;
  };
  const move = (person,x,y,z) => game.teleport(person,{x,y,z});
  const tick = (count = 1) => {
    for (let i = 0; i < count; i++) {
      now += 50;
      game.advanceDroppedItems();
    }
  };
  return {player,observer,request,action,move,tick, nearby:person => game.droppedItemSnapshot(person),
    inventory:person => game.session(person).inventory,
    reload() { game.clearDroppedItems(); game = open(); }};
}

test('indexed inventory moves, splits, swaps and caps matching stacks', t => {
  const {player,action,request,inventory,reload} = fixture(t);
  assert.equal(inventory(player).slots.length,36);
  assert.equal(inventory(player).selected,0);
  action(player,'inventory_give',{slot:5,key:dirt,count:64});
  action(player,'inventory_move',{from:5,to:14,count:63});
  action(player,'inventory_give',{slot:7,key:dirt,count:3});
  const merged = action(player,'inventory_move',{from:7,to:14}).inventory;
  assert.deepEqual(merged.slots[14],at(dirt,64));
  assert.deepEqual(merged.slots[7],at(dirt,2));
  action(player,'inventory_give',{slot:32,key:stone,count:16});
  assert.equal(request(player,'inventory_move',{from:32,to:7,count:1}).output.error,'occupied_inventory_slot');
  action(player,'inventory_move',{from:32,to:7});
  action(player,'inventory_select',{slot:5});
  action(player,'inventory_trash',{slot:32});
  assert.equal(request(player,'inventory_give',{slot:0,key:'legacy:4095:15'}).output.error,'unknown_cell_type');
  reload();
  const after = inventory(player);
  assert.equal(after.selected,5);
  assert.deepEqual(after.slots[7],at(stone,16));
  assert.equal(after.slots[32],null);
});

test('drops fall and settle, and manual pickup cannot claim a placed block or the same item twice', t => {
  const {player,observer,action,request,move,tick,nearby,inventory} = fixture(t);
  action(player,'inventory_give',{slot:0,key:dirt,count:4});
  const first = action(player,'drop_item',{yaw:0},'repeat-drop-command');
  assert.equal(first.inventory.slots[0].count,3);
  assert.equal(request(player,'drop_item',{yaw:0},'repeat-drop-command').replay,true);
  const second = action(player,'drop_item',{yaw:0});
  assert.equal(second.inventory.slots[0].count,2);
  assert.equal(nearby(observer).length,2);
  const original = nearby(player)[0].position;
  tick(1);
  assert.ok(nearby(player)[0].position[1] < original[1]);
  tick(60);
  const resting = nearby(observer);
  assert.ok(resting.every(item => item.resting && Math.abs(item.position[1] - 1) < .01));
  assert.ok(resting[0].position[2] < original[2] - .8);
  assert.equal(inventory(observer).slots[0],null);
  move(observer,12,1,12);
  assert.equal(action(observer,'pickup_item').pickedItem,undefined);
  const [x,,z] = resting[0].position;
  move(observer,x,1,z);
  move(player,x,1,z);
  const picked = action(observer,'pickup_item');
  assert.ok([first.droppedItem,second.droppedItem].includes(picked.pickedItem));
  assert.deepEqual(picked.inventory.slots[0],at(dirt,1));
  assert.equal(nearby(observer).length,1);
  const other = action(player,'pickup_item');
  assert.notEqual(other.pickedItem,picked.pickedItem);
  assert.equal(other.inventory.slots[0].count,3);
  assert.equal(action(observer,'pickup_item').pickedItem,undefined);
  assert.deepEqual(nearby(observer),[]);
});

test('a wall stops thrown items and blocks pickup from the other side', t => {
  const {player,observer,action,move,tick,nearby} = fixture(t,true);
  move(player,8.5,1,8.5);
  action(player,'inventory_give',{slot:0,key:dirt});
  action(player,'drop_item',{yaw:-Math.PI/2});
  tick(40);
  const [item] = nearby(observer);
  assert.ok(item.resting);
  assert.ok(item.position[0] < 9.44);
  assert.ok(Math.hypot(10.07 - item.position[0], 1.48 - item.position[1], 8.5 - item.position[2]) < 1.8);
  move(observer,10.07,1,8.5);
  assert.equal(action(observer,'pickup_item').pickedItem,undefined);
  move(observer,8.5,1,8.5);
  assert.deepEqual(action(observer,'pickup_item').inventory.slots[0],at(dirt,1));
});

test('collecting a dropped stack transfers one unit while keeping its remaining entity and pose', t => {
  const {player,observer,action,nearby} = fixture(t);
  action(player,'inventory_give',{slot:0,key:dirt,count:3});
  const thrown = action(player,'drop_item',{yaw:0,all:true});
  assert.equal(thrown.inventory.slots[0],null);
  const original = nearby(observer)[0];
  assert.equal(original.item.count,3);
  for (const count of [1,2]) {
    const selected = action(observer,'pickup_item');
    assert.equal(selected.pickedItem,original.key);
    assert.equal(selected.inventory.slots[0].count,count);
    assert.deepEqual(nearby(observer),[{...original,item:{...original.item,count:3-count}}]);
  }
  assert.equal(action(observer,'pickup_item').inventory.slots[0].count,3);
  assert.deepEqual(nearby(observer),[]);
});

test('drops expire ten minutes after being thrown and are cleared on restart', t => {
  const {player,action,nearby,tick,reload} = fixture(t);
  action(player,'inventory_give',{slot:0,key:dirt,count:3});
  const first = action(player,'drop_item',{yaw:0}).droppedItem;
  tick(11_999);
  assert.equal(nearby(player)[0].key,first);
  tick();
  assert.deepEqual(nearby(player),[]);
  const second = action(player,'drop_item',{yaw:0}).droppedItem;
  assert.equal(nearby(player)[0].key,second);
  reload();
  assert.deepEqual(nearby(player),[]);
});

test('clearing drops reaches outside viewers, frees capacity and cannot restore an old drop', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const near = {x:8.5,y:1,z:8.5};
  const far = {x:136.5,y:1,z:8.5};
  store.putState('dropped-items','world','entities',1,[{key:'old-drop',position:[near.x,near.y,near.z]}]);
  const base = {manifest:{bounds:{...bounds,maxX:255}}};
  const open = () => createDroppedItems({base,store,clock:() => 0,collides:() => false,visible:() => true});
  const drops = open();
  assert.deepEqual(drops.snapshot(near),[]);
  const stacks = Array.from({length:256},() => at(dirt,2));
  for (const view of [near,far]) {
    for (const drop of drops.prepareScatter(stacks,[Math.floor(view.x),view.y,Math.floor(view.z)])) drops.accept(drop);
  }
  assert.equal(drops.snapshot(near).length,256);
  assert.equal(drops.snapshot(far).length,256);
  assert.throws(() => drops.prepareScatter([at(dirt,1)],[8,1,8]), {code:'too_many_dropped_items'});
  assert.equal(drops.clear(),512);
  assert.deepEqual(drops.snapshot(near),[]);
  assert.deepEqual(drops.snapshot(far),[]);
  assert.equal(drops.clear(),0);
  assert.equal(drops.prepareScatter([at(dirt,1)],[8,1,8]).length,1);
  assert.deepEqual(store.getState('dropped-items','world','entities').value,[]);
  assert.deepEqual(open().snapshot(far),[]);
});

test('drop updates hide private inventory and only an admin can clear them from the world', async t => {
  const npcAdminKey = 'local-owner-clear-drops-test';
  const app = createHoneymoonServer({base:miniature(),geometry,state:':memory:',clock:() => 0,npcAdminKey});
  t.after(() => app.close());
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  const address = 'http://127.0.0.1:' + app.server.address().port;
  const session = () => fetch(address + '/api/session',{method:'POST',
    headers:{'Content-Type':'application/json'}, body:'{}'}).then(async response => {
    assert.equal(response.status,200,await response.clone().text());
    return response.headers.get('set-cookie').split(';')[0];
  });
  const thrower = await session(), observer = await session();
  const bootstrap = await fetch(address + '/api/access/owner',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({key:npcAdminKey,profileName:'Map Admin'}),
  });
  assert.equal(bootstrap.status,200,await bootstrap.clone().text());
  const admin = bootstrap.headers.get('set-cookie').split(';')[0];
  let sequence = 0;
  const action = (cookie,type,fields = {}) => fetch(address + '/api/action',{
    method:'POST', headers:{Cookie:cookie,'Content-Type':'application/json'},
    body:JSON.stringify({requestId:'http-' + type + '-' + ++sequence,type,...fields}),
  }).then(async response => {
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  });
  async function clear(cookie,origin) {
    const response = await fetch(address + '/api/admin/dropped-items/clear',{
      method:'POST',headers:{'Content-Type':'application/json',...(cookie&&{Cookie:cookie}),...(origin&&{Origin:origin})},
      body:'{}',
    });
    return [response.status,await response.json()];
  }

  const response = await fetch(address + '/api/events?droppedItems=1',{
    headers:{Cookie:observer}, signal:AbortSignal.timeout(4000),
  });
  const stream = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  async function nextDrops() {
    while (true) {
      const separator = pending.indexOf('\n\n');
      if (separator >= 0) {
        const event = pending.slice(0,separator);
        pending = pending.slice(separator + 2);
        if (event.startsWith('event: dropped-items\n')) return JSON.parse(event.split('\ndata: ')[1]).entities;
      } else {
        const {value,done} = await stream.read();
        assert.ok(!done);
        pending += decoder.decode(value,{stream:true});
      }
    }
  }
  try {
    assert.deepEqual(await nextDrops(),[]);
    const given = await action(thrower,'inventory_give',{slot:0,key:dirt,count:2});
    assert.equal(given.inventory.slots[0].count,2);
    const thrown = await action(thrower,'drop_item',{yaw:0});
    const [item] = await nextDrops();
    assert.equal(item.key,thrown.droppedItem);
    assert.deepEqual(item.item,at(dirt,1));
    const picked = await action(observer,'pickup_item');
    assert.equal(picked.pickedItem,thrown.droppedItem);
    assert.equal(picked.inventory.slots[0].count,1);
    assert.deepEqual(await nextDrops(),[]);
    assert.deepEqual(await action(observer,'pickup_item'),{worldRevision:0,changes:[],effects:[],inventory:picked.inventory});

    await action(thrower,'inventory_give',{slot:0,key:dirt,count:2});
    const second = await action(thrower,'drop_item',{yaw:0});
    assert.equal((await nextDrops())[0].key,second.droppedItem);
    assert.deepEqual(await clear(),[401,{error:'session_required'}]);
    assert.deepEqual(await clear(observer),[403,{error:'admin_required'}]);
    assert.deepEqual(await clear(admin,'http://untrusted.example'),[403,{error:'origin_denied'}]);
    const before = await fetch(address + '/api/world',{headers:{Cookie:observer}}).then(reply => reply.json());
    assert.equal(before.droppedItems[0].key,second.droppedItem);
    assert.deepEqual(await clear(admin),[200,{removed:1}]);
    assert.deepEqual(await nextDrops(),[]);
    const after = await fetch(address + '/api/world',{headers:{Cookie:observer}}).then(reply => reply.json());
    assert.deepEqual(after.droppedItems,[]);
    assert.deepEqual(after.inventory,before.inventory);
    assert.equal(after.worldRevision,before.worldRevision);
    assert.deepEqual(await clear(admin),[200,{removed:0}]);
  } finally {
    await stream.cancel();
  }
});
