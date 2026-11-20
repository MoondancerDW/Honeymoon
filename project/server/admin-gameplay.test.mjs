import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import * as geometry from '../world/geometry.mjs';
import {tickFromTime} from '../world/world-time.mjs';
import {createHoneymoonServer} from './index.mjs';
import {openStore} from './store.mjs';

const work=resolve(fileURLToPath(new URL('../work/',import.meta.url)));
const publicOrigin='https://game.example.test';
const key='fixture-owner-secret';
const idle={yaw:0,pitch:0,motion:'idle'};

async function call(url,path,{cookie,body,origin=url}={}) {
  const response=await fetch(url+path,{
    method:body===undefined?'GET':'POST',
    headers:{...(cookie&&{Cookie:cookie}),...(body!==undefined&&{Origin:origin,'Content-Type':'application/json'})},
    body:body===undefined?undefined:JSON.stringify(body),
    signal:AbortSignal.timeout(5000),
  });
  return {status:response.status,body:await response.json(),cookie:response.headers.getSetCookie()[0]?.split(';')[0]};
}

function result(response,status=200) {
  assert.equal(response.status,status,JSON.stringify(response.body));
  return response.body;
}

async function eventFeed(t,url,cookie) {
  const controller=new AbortController();
  t.after(()=>controller.abort());
  const response=await fetch(url+'/api/events?presence=1&social=1',{
    headers:{Cookie:cookie}, signal:AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]),
  });
  assert.equal(response.status,200);
  const reader=response.body.getReader(),decoder=new TextDecoder(),received=[];
  let pending='';
  async function next(type,check=()=>true) {
    for (;;) {
      const end=pending.indexOf('\n\n');
      if (end<0) {
        const part=await reader.read();
        assert.equal(part.done,false,'Event stream ended while waiting for '+type);
        pending+=decoder.decode(part.value,{stream:true});
      } else {
        const packet=pending.slice(0,end);
        pending=pending.slice(end+2);
        const event=/^event: (.+)$/m.exec(packet)?.[1];
        const data=/^data: (.+)$/m.exec(packet)?.[1];
        if (!event || data===undefined) continue;
        const body=JSON.parse(data);
        received.push({event,body});
        if (event===type && check(body)) return body;
      }
    }
  }
  return {next,received};
}

async function fixture(t) {
  mkdirSync(work,{recursive:true});
  const generated=mkdtempSync(join(work,'admin-gameplay-'));
  const state=join(generated,'game.sqlite');
  const chunks=join(generated,'world','chunks');
  mkdirSync(chunks,{recursive:true});
  const floor=Buffer.alloc(8192);
  for (let index=0;index<256;index++) floor.writeUInt16LE(1,index*2);
  const bounds={minX:0,minY:0,minZ:0,maxX:15,maxY:15,maxZ:15};
  writeFileSync(join(generated,'world','world.json'),JSON.stringify({
    schemaVersion:1,bounds,palette:['air','legacy:1:0'],chunks:[[0,0]],spawn:[8.5,1,8.5],
  }));
  writeFileSync(join(chunks,'0.0.json'),JSON.stringify({
    x:0,z:0,sections:[{y:0,indices:floor.toString('base64')}],objects:[],entities:[],
  }));
  const app=createHoneymoonServer({geometry,generated,state,secure:true,inviteRequired:true,
    allowedOrigin:publicOrigin,publicOrigin,ownerOnPrimary:false,npcAdminKey:key,initialMode:'game'});
  t.after(async()=>{
    await app.close();
    assert.equal(dirname(generated),work);
    assert.ok(basename(generated).startsWith('admin-gameplay-'));
    rmSync(generated,{recursive:true,force:true});
  });
  app.server.listen(0,'127.0.0.1');
  app.ownerServer.listen(0,'127.0.0.1');
  await Promise.all([once(app.server,'listening'),once(app.ownerServer,'listening')]);
  const publicUrl='http://127.0.0.1:'+app.server.address().port;
  const ownerUrl='http://127.0.0.1:'+app.ownerServer.address().port;
  const boot=await call(ownerUrl,'/api/access/owner',{body:{key,profileName:'Host Profile'}});
  function actor(session,url,origin,request) {
    const profile=result(session).access;
    const command=text=>request('/api/chat',{text,channel:'global'});
    return {uid:profile.uid,request,command,
      feed:()=>eventFeed(t,url,session.cookie),join:()=>request('/api/presence',idle)};
  }
  const owner=actor(boot,ownerUrl,ownerUrl,(path,body)=>call(ownerUrl,path,{cookie:boot.cookie,body}));
  async function add(profileName,kind='player') {
    const invite=result(await owner.request('/api/admin/invites',{kind}));
    const session=await call(publicUrl,'/api/session',{body:{invite:invite.code,profileName},origin:publicOrigin});
    return actor(session,publicUrl,publicOrigin,(path,body)=>call(publicUrl,path,{
      cookie:session.cookie,body,origin:publicOrigin,
    }));
  }
  return {owner,add,app,state};
}

test('recognized chat commands are private and use the authenticated administrator role',async t=>{
  const {owner,add}=await fixture(t);
  const player=await add('Test Player');
  await owner.feed();
  const events=await player.feed();
  result(await owner.join());
  result(await player.join());
  for (const [text,command] of [
    ['/tp "Host Profile"','tp'],['/vanish','vanish'],['/creative','creative'],['/time stop','time'],['/weather snow','weather'],
  ]) assert.deepEqual(result(await player.command(text)),{command});
  const afterPlayer=result(await player.request('/api/session',{}));
  assert.equal(afterPlayer.spectator,false);
  assert.equal(afterPlayer.gameMode.mode,'game');
  assert.equal(afterPlayer.time.frozen,false);
  assert.equal(afterPlayer.weather,'clear');
  assert.deepEqual(afterPlayer.position,{x:8.5,y:1,z:8.5});

  assert.equal(result(await owner.command('/time stop')).command,'time');
  assert.equal(result(await owner.command('/time 3')).command,'time');
  assert.deepEqual(result(await player.request('/api/session',{})).time,{tick:tickFromTime('03:00'),frozen:true});
  for (const text of ['/time 24','/time']) {
    assert.equal(result(await owner.command(text)).command,'time');
    assert.deepEqual(result(await player.request('/api/session',{})).time,{tick:tickFromTime('12:00'),frozen:true});
  }
  assert.equal(result(await owner.command('/time go')).command,'time');
  assert.equal(result(await player.request('/api/session',{})).time.frozen,false);

  for (const [text,mode] of [['/weather','rain'],['/weather','cloudy'],['/weather snow','snow'],['/weather clear','clear']]) {
    assert.equal(result(await owner.command(text)).command,'weather');
    assert.deepEqual(result(await player.request('/api/weather')),{mode,dynamic:false,nextChangeAt:null});
  }

  assert.equal(result(await owner.command('/creative "Test Player"')).command,'creative');
  assert.equal(result(await player.request('/api/session',{})).gameMode.mode,'creative');
  assert.equal(result(await owner.command('/creative "Test Player"')).command,'creative');
  assert.equal(result(await player.request('/api/session',{})).gameMode.mode,'game');
  assert.equal(result(await owner.command('/creative')).command,'creative');
  assert.equal(result(await owner.request('/api/session',{})).gameMode.mode,'creative');

  result(await player.command('Visible chat message'));
  await events.next('chat',entry=>entry.text==='Visible chat message');
  const allChat=events.received.flatMap(({event,body})=>event==='chat'?[body]:event==='chat-history'?body.entries:[]);
  assert.deepEqual(allChat.flatMap(({text})=>text?[text]:[]),['Visible chat message']);
});

test('chat teleport resolves exact nicknames and profile names and handles one or two targets',async t=>{
  const {owner,add,app}=await fixture(t);
  const source=await add('First Profile');
  const target=await add('Second Profile');
  const sourceStart={x:3.5,y:1,z:4.5},targetPosition={x:11.5,y:1,z:10.5};
  app.game.teleport(source.uid,sourceStart);
  app.game.teleport(target.uid,targetPosition);
  const ownerEvents=await owner.feed();
  const sourceEvents=await source.feed();
  await target.feed();
  for (const person of [owner,source,target]) result(await person.join());
  result(await target.request('/api/profile',{nickname:'Blue Moon'}));

  function near(moved) {
    assert.equal(moved.y,targetPosition.y);
    const distance=Math.hypot(moved.x-targetPosition.x,moved.z-targetPosition.z);
    assert.ok(distance>.6 && distance<3.5,'safe distinct position close to target');
  }
  assert.equal(result(await owner.command('/tp blue moon')).command,'tp');
  const self=await ownerEvents.next('admin-teleport');
  assert.deepEqual(result(await owner.request('/api/session',{})).position,self.position);
  near(self.position);
  assert.deepEqual(result(await source.request('/api/session',{})).position,sourceStart);

  assert.equal(result(await owner.command('/tp "First Profile" "Second Profile"')).command,'tp');
  const moved=await sourceEvents.next('admin-teleport');
  assert.deepEqual(result(await source.request('/api/session',{})).position,moved.position);
  near(moved.position);
  assert.deepEqual(result(await target.request('/api/session',{})).position,targetPosition);
});

test('spectator presence and movement reach administrators only and combat cannot identify a ghost',async t=>{
  const {owner,add}=await fixture(t);
  const player=await add('Test Player');
  const moderator=await add('Test Moderator','admin');
  const plain=await player.feed();
  const admin=await moderator.feed();
  await owner.feed();
  for (const person of [owner,player,moderator]) result(await person.join());
  const original=await plain.next('presence',r=>r.players.some(p=>p.nickname==='Host Profile') && r.players.length===2);
  const avatarId=original.players.find(p=>p.nickname==='Host Profile').id;
  assert.equal(result(await player.request('/api/spectator',{enabled:true,pose:idle}),403).error,'admin_required');

  assert.equal(result(await owner.command('/vanish')).command,'vanish');
  await plain.next('presence',r=>r.players.length===1 && r.players[0].nickname==='Test Moderator');
  const hiddenAt=plain.received.length;
  const ghost=await admin.next('presence',r=>r.players.some(p=>p.id===avatarId && p.spectator));
  assert.equal(ghost.players.find(p=>p.id===avatarId).uid,owner.uid);
  assert.equal(result(await owner.request('/api/session',{})).spectator,true);
  const position={x:8.8,y:1,z:8.5};
  result(await owner.request('/api/position',{...position,pose:{...idle,motion:'fly'}}));
  await admin.next('presence-motion',r=>r.players.some(p=>p.id===avatarId&&p.position.x===position.x&&p.spectator));
  const absent=result(await player.request('/api/combat',{target:'unknown-avatar'}),404);
  assert.deepEqual(result(await player.request('/api/combat',{target:avatarId}),404),absent);
  result(await owner.command('/weather rain'));
  await plain.next('weather',r=>r.mode==='rain');
  const timersAndChat=plain.received.slice(hiddenAt);
  assert.ok(timersAndChat.every(({body})=>!JSON.stringify(body).includes(avatarId)));
  assert.ok(timersAndChat.every(({body})=>!JSON.stringify(body).includes('Host Profile')));

  result(await owner.command('/vanish'));
  await plain.next('presence',r=>r.players.some(p=>p.id===avatarId&&!p.spectator));
  assert.equal(result(await owner.request('/api/session',{})).spectator,false);
  result(await owner.command('/vanish "Test Player"'));
  assert.equal(result(await player.request('/api/session',{})).spectator,true);
  await admin.next('presence',r=>r.players.some(p=>p.uid===player.uid&&p.spectator));
  result(await owner.command('/vanish "Test Player"'));
  assert.equal(result(await player.request('/api/session',{})).spectator,false);
});

test('administrator role changes affect the existing session and clear only the acting inventory',async t=>{
  const {owner,add,state}=await fixture(t);
  const player=await add('Test Player');
  const moderator=await add('Test Moderator','admin');
  const role='/api/admin/profiles/role',clear='/api/admin/inventory/clear';
  const carried={key:'legacy:1:0',cell:'legacy:1:0',count:11};
  const offhand={key:'legacy:1:0',cell:'legacy:1:0',count:3};
  const armor={key:'creative:310:0',count:1};
  const inventory={slots:Array(36).fill(null),selected:2,equipment:[armor,null,null,null],offhand};
  inventory.slots[2]=carried;
  const store=openStore(state);
  try {
    for (const uid of [player.uid,moderator.uid]) store.putState('inventory',uid,'slots',3,inventory);
  } finally {store.close();}

  assert.equal(result(await player.request(role,{uid:player.uid,role:'admin'}),403).error,'admin_required');
  assert.equal(result(await moderator.request(role,{uid:player.uid,role:'admin'}),403).error,'owner_required');
  assert.equal(result(await owner.request(role,{uid:owner.uid,role:'player'}),403).error,'owner_role_protected');
  assert.equal(result(await player.request(clear,{}),403).error,'admin_required');
  assert.deepEqual(result(await player.request('/api/session',{})).inventory,inventory);
  const events=await player.feed();
  assert.deepEqual(result(await owner.request(role,{uid:player.uid,role:'admin'})),{uid:player.uid,role:'admin',changed:true});
  await events.next('profile-access',r=>r.uid===player.uid&&r.role==='admin');
  assert.equal(result(await player.request('/api/session',{})).access.role,'admin');
  const cleared=result(await player.request(clear,{})).inventory;
  assert.deepEqual(cleared,{slots:Array(36).fill(null),selected:2,equipment:Array(4).fill(null),offhand:null});
  assert.deepEqual(result(await player.request('/api/session',{})).inventory,cleared);
  assert.deepEqual(result(await moderator.request('/api/session',{})).inventory,inventory);
  assert.deepEqual(result(await owner.request(role,{uid:player.uid,role:'player'})),{uid:player.uid,role:'player',changed:true});
  await events.next('profile-access',r=>r.uid===player.uid&&r.role==='player');
  assert.equal(result(await player.request(clear,{}),403).error,'admin_required');
});
