import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import * as geometry from '../world/geometry.mjs';
import {createHoneymoonServer} from './index.mjs';
import {normalizeLegacyPlayerName} from './legacy-player.mjs';
import {openStore} from './store.mjs';

const fixtures=fileURLToPath(new URL('../work/',import.meta.url));
const external='https://game.example.test';
const secret='owner-local-test-secret';
const config={geometry,secure:true,inviteRequired:true,ownerOnPrimary:false,allowedOrigin:external,publicOrigin:external,
  npcAdminKey:secret,initialMode:'creative'};

function startAssets() {
  mkdirSync(fixtures,{recursive:true});
  const generated=mkdtempSync(join(fixtures,'access-test-'));
  mkdirSync(join(generated,'world','chunks'),{recursive:true});
  const palette=['air','legacy:1:0'];
  const bounds={minX:0,minY:0,minZ:0,maxX:15,maxY:15,maxZ:15};
  const sections=Buffer.alloc(8192);
  for (let index=0;index<256;index++) sections.writeUInt16LE(1,index*2);
  writeFileSync(join(generated,'world','world.json'),JSON.stringify({schemaVersion:1,bounds,palette,chunks:[[0,0]],spawn:[8.5,1,8.5]}));
  writeFileSync(join(generated,'world','chunks','0.0.json'),JSON.stringify({x:0,z:0,sections:[{y:0,indices:sections.toString('base64')}],
    objects:[],entities:[]}));
  return generated;
}

function fixture(t,generated=startAssets()) {
  const state=join(generated,'game.sqlite');
  let app;
  async function close() {
    if (!app) return;
    await app.close();
    app=null;
  }
  t.after(async()=>{
    await close();
    rmSync(generated,{recursive:true,force:true});
  });
  async function start(options={}) {
    await close();
    app=createHoneymoonServer({...config,generated,state,...options});
    app.server.listen(0,'127.0.0.1');
    app.ownerServer.listen(0,'127.0.0.1');
    await Promise.all([once(app.server,'listening'),once(app.ownerServer,'listening')]);
    const host=listener=>`http://127.0.0.1:${listener.address().port}`;
    return {public:host(app.server),owner:host(app.ownerServer)};
  }
  return {state,start,close};
}

async function request(url,path,{body,cookie,origin,headers={}}={}) {
  const response=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{
    ...(body!==undefined&&{'Content-Type':'application/json',Origin:origin??(url.includes('.test')?external:url)}),
    ...(cookie&&{Cookie:cookie}),...headers,
  },body:body===undefined?undefined:JSON.stringify(body)});
  const json=await response.json();
  return {status:response.status,json,cookie:response.headers.getSetCookie()[0]?.split(';')[0],
    flags:response.headers.getSetCookie()[0],headers:response.headers};
}
const code=(reply,expected=200)=>{assert.equal(reply.status,expected,JSON.stringify(reply.json));return reply.json;};
const legacy=token=>`honeymoon_guest=${token}`;

const legacyStack=(size,slot,stack)=>Array.from({length:size},(_,index)=>index===slot?stack:null);
function stageLegacy(store,uid,nickname,stack,{selected=7,ender=null}={}) {
  const inventory={slots:legacyStack(36,selected,stack),selected,equipment:Array(4).fill(null)};
  store.putState('legacy-player',normalizeLegacyPlayerName(nickname),'import',1,
    {uid,nickname,inventory,enderItems:legacyStack(27,12,ender)});
  return inventory;
}

test('an imported UID and original inventory can be claimed only once across aliases',async t=>{
  const {state,start,close}=fixture(t);
  const ownerUid='10000000-0000-3000-8000-000000000001';
  const playerUid='10000000-0000-3000-8000-000000000002';
  const untouchedUid='10000000-0000-3000-8000-000000000003';
  const emerald={key:'creative:388:0',count:99,nbt:{display:{Name:'Saved emeralds'}}};
  const book={key:'creative:387:0',count:1,nbt:{title:'Saved pages',pages:['Original text']}};
  const map={key:'creative:358:660',count:1,nbt:{custom:'unchanged'},legacyNbt:{modField:5}};
  const seeded=openStore(state);
  const hostInventory=stageLegacy(seeded,ownerUid,'Saved Owner',book);
  const profileInventory=stageLegacy(seeded,playerUid,'Saved Guest',emerald,{ender:map});
  const aliasInventory=stageLegacy(seeded,playerUid,'Alt Guest',book,{selected:3,ender:map});
  const shortInventory=stageLegacy(seeded,untouchedUid,'S',book);
  seeded.close();

  let urls=await start();
  const owner=await request(urls.owner,'/api/access/owner',{body:{key:secret,profileName:'  saved owner  '}});
  assert.equal(code(owner).access.uid,ownerUid);
  assert.equal(owner.json.access.role,'admin');
  assert.deepEqual(owner.json.inventory,hostInventory);
  const host=(path,body)=>request(urls.owner,path,{body,cookie:owner.cookie});
  const redeem=(invite,profileName,cookie)=>request(urls.public,'/api/session',{origin:external,body:{invite,profileName},cookie});
  const invalid=await redeem('invalid','Saved Guest');
  assert.equal(code(invalid,400).error,'invalid_invite');
  assert.equal(code(await request(urls.public,'/api/admin/uids'),401).error,'session_required');
  const first=code(await host('/api/admin/invites',{kind:'player'}));
  const second=code(await host('/api/admin/invites',{kind:'player'}));
  const [canonical,alias]=await Promise.all([redeem(first.code,'Ｓaved Guest'),redeem(second.code,'Alt Guest')]);
  code(canonical);
  code(alias);
  const claimed=canonical.json.access.uid===playerUid?canonical:alias;
  const blank=claimed===canonical?alias:canonical;
  assert.equal(claimed.json.access.role,'player');
  assert.equal(claimed.json.access.uid,playerUid);
  assert.deepEqual(claimed.json.inventory,claimed===canonical?profileInventory:aliasInventory);
  assert.notEqual(blank.json.access.uid,playerUid);
  assert.ok(blank.json.inventory.slots.every(stack=>stack===null));
  assert.equal(code(await request(urls.public,'/api/admin/uids',{cookie:claimed.cookie}),403).error,'admin_required');
  const byUid=async uid=>code(await host('/api/admin/uids')).rows.find(row=>row.uid===uid);
  const row=await byUid(playerUid);
  assert.equal(row.source,'original');
  assert.equal(row.claimed,true);
  assert.ok(row.names.includes('Saved Guest')&&row.names.includes('Alt Guest'));
  assert.deepEqual(await byUid(untouchedUid),{uid:untouchedUid,names:['S'],source:'original',claimed:false});
  assert.equal((await byUid(blank.json.access.uid)).source,'profile');
  const shortInvite=code(await host('/api/admin/invites',{kind:'player'}));
  assert.equal(code(await redeem(shortInvite.code,'X'),400).error,'invalid_profile_name');
  const short=await redeem(shortInvite.code,'S');
  assert.equal(code(short).access.uid,untouchedUid);
  assert.equal(short.json.access.profileName,'S');
  assert.deepEqual(short.json.inventory,shortInventory);
  assert.notEqual(short.json.profile.nickname,'S');
  const shortNickname=await request(urls.public,'/api/profile',{body:{nickname:'S'},origin:external,cookie:short.cookie});
  assert.equal(code(shortNickname,400).error,'invalid_nickname');

  await close();
  const saved=openStore(state);
  assert.equal(saved.getState('legacy-player',playerUid,'claim').value.uid,playerUid);
  assert.deepEqual(saved.getState('container',playerUid,'ender').value,
    {revision:1,items:[{id:358,Damage:660,Count:1,Slot:12,tag:map.nbt,modField:5}]});
  saved.close();
  urls=await start();
  const device=code(await host('/api/admin/invites',{kind:'device',profileUid:playerUid}));
  const restored=code(await redeem(device.code));
  assert.equal(restored.access.uid,playerUid);
  assert.deepEqual(restored.inventory,claimed.json.inventory);
  assert.deepEqual(await byUid(playerUid),row);
});

test('owner bootstrap must use the isolated listener and can claim an exact saved version-8 UID',async t=>{
  const {state,start,close}=fixture(t);
  const old=openStore(state);
  const {id,token}=old.createPlayer();
  old.updateProfile(id,{nickname:'Saved Owner'},null);
  old.putState('inventory',id,'slots',2,{slots:[{key:'legacy:1:0',cell:'legacy:1:0',count:19}],selected:0,equipment:[]});
  stageLegacy(old,'10000000-0000-3000-8000-000000000004','Saved Owner',{key:'creative:388:0',count:64});
  old.close();
  const raw=new DatabaseSync(state);
  raw.exec('DROP TABLE access_devices; DROP TABLE access_invites; ALTER TABLE players DROP COLUMN access_role; ALTER TABLE players DROP COLUMN profile_name; PRAGMA user_version=8');
  raw.close();

  let urls=await start();
  let reply=await request(urls.public,'/api/session',{body:{},origin:external,cookie:legacy(token)});
  assert.equal(code(reply,401).error,'invite_required');
  assert.equal(code(await request(urls.public,'/api/access')).ownerBootstrap,false);
  assert.equal(code(await request(urls.public,'/generated/world/world.json'),401).error,'session_required');
  assert.equal(code(await request(urls.public,'/api/world',{cookie:legacy(token)}),401).error,'session_required');
  const forged={host:new URL(urls.public).host,'x-forwarded-for':'127.0.0.1','x-forwarded-host':'localhost','x-forwarded-proto':'http'};
  assert.equal(code(await request(urls.public,'/api/access/owner',{body:{key:secret},origin:external,headers:forged}),403).error,'owner_only');
  assert.equal(code(await request(urls.owner,'/api/access/owner',{body:{key:secret},origin:'http://evil.example'}),403).error,'origin_denied');
  assert.equal(code(await request(urls.owner,'/api/access/owner',{body:{key:'bogus'}}),403).error,'owner_key');
  reply=await request(urls.owner,'/api/access/owner',{body:{key:secret},cookie:legacy(token)});
  const claimed=code(reply);
  assert.equal(claimed.access.uid,id);
  assert.equal(claimed.access.role,'admin');
  assert.equal(claimed.access.profileName,'Saved Owner');
  assert.equal(claimed.access.owner,true);
  assert.equal(claimed.inventory.slots[0].count,19);
  assert.match(reply.flags,/HttpOnly/);
  assert.doesNotMatch(reply.flags,/; Secure/);
  const prior=reply.cookie;
  await close();

  urls=await start();
  assert.equal(code(await request(urls.owner,'/api/access',{cookie:prior})).uid,id);
  const recovered=code(await request(urls.owner,'/api/access/owner',{body:{key:secret}}));
  assert.equal(recovered.access.uid,id);
  assert.equal(recovered.inventory.slots[0].count,19);
});

test('invite consumption is atomic and device credentials retain name, UID and access policy after restart',async t=>{
  const {start,close}=fixture(t);
  let urls=await start();
  const owner=await request(urls.owner,'/api/access/owner',{body:{key:secret,profileName:'Host Owner'}});
  const ownerUid=code(owner).access.uid;
  const admin=(path,body,cookie=owner.cookie)=>request(urls.owner,path,{body,cookie});
  const join=(body,cookie)=>request(urls.public,'/api/session',{body,cookie,origin:external});
  const initial=code(await admin('/api/admin/invites',{kind:'player',label:'Alice'}));
  assert.equal(initial.invite.status,'active');
  assert.equal(new URL(initial.url).hash,`#invite=${initial.code}`);
  assert.equal(code(await join({invite:initial.code}),409).error,'profile_name_required');
  const concurrent=await Promise.all([join({invite:initial.code,profileName:'Amy Person'}),join({invite:initial.code,profileName:'Amy Person'})]);
  const winner=concurrent.find(reply=>reply.status===200), loser=concurrent.find(reply=>reply.status===409);
  assert.ok(winner&&loser,JSON.stringify(concurrent.map(reply=>reply.status)));
  assert.equal(loser.json.error,'invite_used');
  assert.match(winner.flags,/; Secure/);
  const player=winner.json.access;
  assert.equal(player.profileName,'Amy Person');
  assert.equal(code(await request(urls.public,'/api/profile',{body:{nickname:'New Nick'},cookie:winner.cookie,origin:external})).nickname,'New Nick');
  assert.equal(code(await request(urls.public,'/api/admin/access',{cookie:winner.cookie}),403).error,'admin_required');
  assert.equal(code(await request(urls.public,'/api/weather',{body:{mode:'rain'},cookie:winner.cookie,origin:external}),403).error,'admin_required');
  assert.equal(code(await request(urls.public,'/api/modes',{body:{mode:'game'},cookie:winner.cookie,origin:external}),403).error,'admin_required');
  assert.equal(code(await admin('/api/weather',{mode:'rain'})).mode,'rain');
  assert.equal(code(await admin('/api/time',{tick:18000,frozen:true})).tick,18000);
  const selection=code(await admin('/api/modes',{mode:'game',target:player.uid}));
  const offline=selection.players.find(row=>row.uid===player.uid);
  assert.equal(offline.mode,'game');
  assert.equal(offline.online,false);
  assert.equal(code(await request(urls.public,'/api/action',{body:{type:'place'},origin:external}),401).error,'session_required');
  assert.equal(code(await request(urls.public,'/api/action',{body:{type:'place'},cookie:winner.cookie,origin:'https://wrong.example'}),403).error,'origin_denied');
  const manifest=await request(urls.public,'/generated/world/world.json',{cookie:winner.cookie});
  assert.equal(manifest.status,200);
  assert.match(manifest.headers.get('cache-control'),/private/);
  assert.match(manifest.headers.get('vary'),/Cookie/);
  const version=manifest.json.chunkCacheVersion;
  assert.match(version,/^[0-9a-f]{64}$/);
  const chunkPath=`/generated/world/chunks/${version}/0.0.json`;
  assert.equal(code(await request(urls.public,chunkPath),401).error,'session_required');
  const cachedChunk=await request(urls.public,chunkPath,{cookie:winner.cookie});
  const legacyChunk=await request(urls.public,'/generated/world/chunks/0.0.json',{cookie:winner.cookie});
  assert.deepEqual(code(cachedChunk),code(legacyChunk));
  assert.equal(cachedChunk.headers.get('cache-control'),'private, max-age=2592000, immutable');
  assert.equal(cachedChunk.headers.get('vary'),'Cookie, Accept-Encoding');
  assert.match(legacyChunk.headers.get('cache-control'),/no-cache/);
  const obsoleteVersion=version[0]==='0' ? '1'.repeat(64) : '0'.repeat(64);
  assert.equal(code(await request(urls.public,chunkPath.replace(version,obsoleteVersion),{cookie:winner.cookie}),404).error,
    'chunk_version_changed');

  const viewer=await fetch(urls.public+'/api/events?presence=1',{headers:{Cookie:winner.cookie}});
  assert.equal(viewer.status,200);
  try {
    const pair=code(await admin('/api/admin/invites',{kind:'device',profileUid:player.uid,label:'Phone'}));
    const second=await join({invite:pair.code});
    assert.equal(code(second).access.uid,player.uid);
    assert.equal(second.json.access.activeElsewhere,true);
    const denied=await fetch(urls.public+'/api/events?presence=1',{headers:{Cookie:second.cookie}});
    assert.equal(denied.status,409);
    assert.equal((await denied.json()).error,'profile_active_elsewhere');
    code(await admin('/api/admin/devices/revoke',{id:player.deviceId}));
    assert.equal(code(await request(urls.public,'/api/world',{cookie:winner.cookie}),401).error,'session_required');
    assert.equal(code(await request(urls.public,chunkPath,{cookie:winner.cookie}),401).error,'session_required');
    const connected=await fetch(urls.public+'/api/events?presence=1',{headers:{Cookie:second.cookie}});
    assert.equal(connected.status,200);
    await connected.body.cancel();
    const delegates=code(await admin('/api/admin/invites',{kind:'admin',label:'Moderator'}));
    const delegated=await join({invite:delegates.code,profileName:'Moderator Account'});
    assert.equal(code(delegated).access.role,'admin');
    const moderator=(path,body)=>request(urls.public,path,{body,cookie:delegated.cookie,origin:external});
    assert.equal(code(await moderator('/api/admin/invites',{kind:'device',profileUid:ownerUid}),403).error,'owner_required');
    assert.equal(code(await moderator('/api/admin/devices/revoke',{id:owner.json.access.deviceId}),403).error,'owner_required');
    assert.equal(code(await moderator('/api/admin/invites',{kind:'admin'}),403).error,'owner_required');
    const ordinary=code(await moderator('/api/admin/invites',{kind:'player'}));
    assert.equal(ordinary.invite.status,'active');
    await close();
    urls=await start();
    const persisted=code(await join({},second.cookie));
    assert.equal(persisted.access.profileName,player.profileName);
    assert.equal(persisted.access.uid,player.uid);
    assert.equal(persisted.profile.nickname,'New Nick');
    assert.equal(persisted.gameMode.mode,'game');
    assert.equal(code(await request(urls.public,'/api/access',{cookie:delegated.cookie})).role,'admin');
    const audit=code(await admin('/api/admin/access'));
    assert.ok(audit.profiles.some(row=>row.uid===player.uid&&row.nickname==='New Nick'));
    assert.ok(audit.invites.some(row=>row.id===initial.invite.id&&row.status==='used'));
    assert.ok(!JSON.stringify(audit).includes(initial.code));
  } finally { await viewer.body.cancel(); }
});

test('invitations can expire and revoke without consuming a profile',async t=>{
  const {start}=fixture(t);
  let now=10_000;
  const urls=await start({clock:()=>now});
  const owner=await request(urls.owner,'/api/access/owner',{body:{key:secret,profileName:'Host Owner'}});
  const issue=body=>request(urls.owner,'/api/admin/invites',{cookie:owner.cookie,body});
  const retired=code(await issue({kind:'player',ttlHours:1}));
  const cancelled=code(await issue({kind:'player'}));
  code(await request(urls.owner,'/api/admin/invites/revoke',{cookie:owner.cookie,body:{id:cancelled.invite.id}}));
  now+=3_600_001;
  const redeem=invite=>request(urls.public,'/api/session',{origin:external,body:{invite,profileName:'Never Created'}});
  assert.equal(code(await redeem(retired.code),409).error,'invite_expired');
  assert.equal(code(await redeem(cancelled.code),409).error,'invite_revoked');
  const profiles=code(await request(urls.owner,'/api/admin/access',{cookie:owner.cookie})).profiles;
  assert.equal(profiles.length,1);
});

async function eventReader(t,url,cookie,query='presence=1') {
  const response=await fetch(url+'/api/events?'+query,{headers:{Cookie:cookie},signal:AbortSignal.timeout(8000)});
  assert.equal(response.status,200);
  const reader=response.body.getReader();
  t.after(()=>reader.cancel().catch(()=>{}));
  const decoder=new TextDecoder();
  let buffer='';
  return async event=>{
    for (;;) {
      const end=buffer.indexOf('\n\n');
      if (end!==-1) {
        const packet=buffer.slice(0,end).split('\n');
        buffer=buffer.slice(end+2);
        if (packet.includes('event: '+event)) return JSON.parse(packet.find(line=>line.startsWith('data: ')).slice(6));
      } else {
        const part=await reader.read();
        assert.ok(!part.done,`stream closed before ${event}`);
        buffer+=decoder.decode(part.value,{stream:true});
      }
    }
  };
}

test('an administrator can override a natural weather front and all clients reload the same schedule',async t=>{
  const {start}=fixture(t);
  let now=100_000;
  let urls=await start({clock:()=>now});
  const owner=await request(urls.owner,'/api/access/owner',{body:{key:secret,profileName:'Host Owner'}});
  const host=(path,body)=>request(urls.owner,path,{body,cookie:owner.cookie});
  const invitation=code(await host('/api/admin/invites',{kind:'player'}));
  const guest=await request(urls.public,'/api/session',{body:{invite:invitation.code,profileName:'Cloud Watcher'},origin:external});
  code(guest);
  const observer=(path,body)=>request(urls.public,path,{body,cookie:guest.cookie,origin:external});
  const events=await eventReader(t,urls.public,guest.cookie,'social=1');
  assert.deepEqual(await events('weather'),{mode:'clear',dynamic:false,nextChangeAt:null});
  assert.equal(code(await observer('/api/weather',{dynamic:true}),403).error,'admin_required');
  assert.equal(code(await observer('/api/weather',{mode:'snow'}),403).error,'admin_required');
  assert.equal(code(await observer('/api/time',{frozen:true}),403).error,'admin_required');
  code(await host('/api/time',{tick:22500,frozen:true}));

  const enabled=code(await host('/api/weather',{dynamic:true}));
  assert.deepEqual(await events('weather'),enabled);
  assert.ok(enabled.nextChangeAt>=now+15*60_000 && enabled.nextChangeAt<=now+35*60_000);
  now=enabled.nextChangeAt;
  const clouds=await events('weather');
  assert.equal(clouds.mode,'cloudy');
  assert.ok(clouds.nextChangeAt>=now+2*60_000 && clouds.nextChangeAt<=now+5*60_000);
  now+=30_000;
  const manual=code(await host('/api/weather',{mode:'snow'}));
  assert.deepEqual(await events('weather'),manual);
  assert.equal(manual.mode,'snow');
  assert.equal(manual.dynamic,true);
  assert.ok(manual.nextChangeAt>=now+5*60_000 && manual.nextChangeAt<=now+12*60_000);
  assert.deepEqual(code(await observer('/api/weather')),manual);

  urls=await start({clock:()=>now});
  const reopened=code(await observer('/api/session',{}));
  assert.equal(reopened.weather,'snow');
  assert.deepEqual(reopened.weatherSettings,manual);
  assert.deepEqual(reopened.time,{tick:22500,frozen:true});
  const reconnected=await eventReader(t,urls.public,guest.cookie,'social=1');
  assert.deepEqual(await reconnected('weather'),manual);
  const disabled=code(await host('/api/weather',{dynamic:false}));
  assert.deepEqual(disabled,{mode:'snow',dynamic:false,nextChangeAt:null});
  assert.deepEqual(await reconnected('weather'),disabled);
});

test('administrators teleport online players privately and bans persist without replacing profiles',async t=>{
  const {state,start,close}=fixture(t);
  let urls=await start();
  const owner=await request(urls.owner,'/api/access/owner',{body:{key:secret,profileName:'Host Owner'}});
  const hostUid=code(owner).access.uid;
  const host=(path,body)=>request(urls.owner,path,{body,cookie:owner.cookie});
  const redeem=(invite,profileName)=>request(urls.public,'/api/session',{origin:external,body:{invite,profileName}});
  const guest=await redeem(code(await host('/api/admin/invites',{kind:'player'})).code,'Guest Save');
  const guestUid=code(guest).access.uid;
  const visitor=(path,body)=>request(urls.public,path,{body,cookie:guest.cookie,origin:external});
  const admin=await redeem(code(await host('/api/admin/invites',{kind:'admin'})).code,'Moderator');
  const adminUid=code(admin).access.uid;
  const moderator=(path,body)=>request(urls.public,path,{body,cookie:admin.cookie,origin:external});
  const second=await redeem(code(await host('/api/admin/invites',{kind:'device',profileUid:guestUid})).code);
  code(second);
  const reservation=code(await host('/api/admin/invites',{kind:'device',profileUid:guestUid}));

  const teleport='/api/admin/teleport',ban='/api/admin/profiles/ban',unban='/api/admin/profiles/unban';
  assert.equal(code(await host(teleport,{target:guestUid,direction:'bring'}),409).error,'not_online');
  assert.equal(code(await visitor(teleport,{target:hostUid,direction:'to'}),403).error,'admin_required');
  for (const [path,body] of [
    ['/api/teleport',{x:7.5,y:8,z:7.5}], ['/api/teleport',{warpId:'warp-1'}], ['/api/warps',undefined],
    ['/api/warps',{title:'Test warp'}], ['/api/warps/remove',{id:'warp-1'}],
  ]) assert.equal(code(await visitor(path,body),403).error,'admin_required');
  assert.equal(code(await visitor(ban,{uid:hostUid}),403).error,'admin_required');
  assert.equal(code(await moderator(teleport,{target:hostUid,direction:'bring'}),403).error,'owner_required');
  assert.equal(code(await moderator(ban,{uid:hostUid}),403).error,'owner_protected');
  assert.equal(code(await moderator(ban,{uid:adminUid}),400).error,'admin_target_self');

  const hostEvent=await eventReader(t,urls.owner,owner.cookie);
  const visitorEvent=await eventReader(t,urls.public,guest.cookie);
  const secondEvent=await eventReader(t,urls.public,second.cookie,'social=1');
  for (const actor of [host,visitor]) code(await actor('/api/presence',{yaw:0,pitch:0,motion:'idle'}));
  const initial=code(await visitor('/api/session',{})).position;
  const movedHost=code(await host(teleport,{target:guestUid,direction:'to'}));
  assert.equal(movedHost.uid,hostUid);
  assert.deepEqual(await hostEvent('admin-teleport'),movedHost.teleport);
  assert.deepEqual(code(await host('/api/session',{})).position,movedHost.teleport.position);
  const place=movedHost.teleport.position;
  assert.ok(Math.abs(place.x-initial.x)>0.6 && Math.hypot(place.x-initial.x,place.z-initial.z)<3.5);
  assert.equal(place.y,initial.y);
  const movedVisitor=code(await host(teleport,{target:guestUid,direction:'bring'}));
  assert.equal(movedVisitor.uid,guestUid);
  assert.deepEqual(await visitorEvent('admin-teleport'),movedVisitor.teleport);
  assert.notEqual(movedVisitor.teleport.teleportId,movedHost.teleport.teleportId);
  assert.deepEqual(code(await visitor('/api/session',{})).position,movedVisitor.teleport.position);
  assert.notDeepEqual(movedVisitor.teleport.position,place);
  const stale=[initial.x,initial.y,initial.z,'stand'];
  const oldTrail=code(await visitor('/api/position',{...initial,requestId:'before-admin-teleport',from:stale,trail:[stale]}),409);
  assert.equal(oldTrail.error,'movement_blocked');
  assert.deepEqual(oldTrail.position,movedVisitor.teleport.position);
  assert.deepEqual(code(await visitor('/api/respawn',{})).position,initial);

  code(await host('/api/modes',{mode:'game',target:hostUid}));
  await eventReader(t,urls.public,admin.cookie);
  code(await moderator('/api/presence',{yaw:0,pitch:0,motion:'idle'}));
  code(await moderator('/api/teleport',{x:7.5,y:8,z:7.5}));
  const flight=code(await host(teleport,{target:adminUid,direction:'to'}));
  assert.equal(flight.teleport.position.y,8);
  assert.equal(flight.teleport.flight,true);
  assert.deepEqual(await hostEvent('admin-teleport'),flight.teleport);

  const reason='Rule violation';
  const blocked=code(await moderator(ban,{uid:guestUid,reason}));
  assert.deepEqual(await visitorEvent('access-revoked'),{banned:true,reason});
  assert.deepEqual(await secondEvent('access-revoked'),{banned:true,reason});
  assert.deepEqual(code(await visitor('/api/session',{}),403),{error:'profile_banned',reason});
  assert.equal(code(await visitor('/generated/world/world.json'),403).error,'profile_banned');
  assert.equal(code(await visitor('/api/presence',{yaw:0,pitch:0}),403).error,'profile_banned');
  assert.equal(code(await redeem(reservation.code),403).error,'profile_banned');
  assert.equal(code(await host(teleport,{target:guestUid,direction:'bring'}),409).error,'not_online');
  const listed=()=>host('/api/admin/access').then(code).then(({profiles})=>profiles.find(profile=>profile.uid===guestUid));
  assert.deepEqual((await listed()).ban,blocked.ban);
  assert.equal((await listed()).online,false);

  await close();
  const save=openStore(state);
  save.putState('inventory',guestUid,'slots',2,{slots:[{key:'legacy:1:0',cell:'legacy:1:0',count:19}],selected:0,equipment:[]});
  save.close();
  urls=await start();
  assert.deepEqual((await listed()).ban,blocked.ban);
  assert.equal(code(await visitor('/api/world'),403).error,'profile_banned');
  assert.equal(code(await host(unban,{uid:guestUid})).ban,null);
  const restored=code(await visitor('/api/session',{}));
  assert.equal(restored.access.uid,guestUid);
  assert.equal(restored.inventory.slots[0].count,19);
  assert.equal(code(await redeem(reservation.code)).access.uid,guestUid);
  assert.equal((await listed()).ban,null);
});

test('the single-player owner can use coordinate travel and manage warps without an online account',async t=>{
  const {start}=fixture(t);
  const {public:url}=await start({singlePlayer:true,secure:false,inviteRequired:false,ownerOnPrimary:true,
    allowedOrigin:undefined,publicOrigin:undefined});
  const local=(path,body)=>request(url,path,{body});
  const session=code(await local('/api/session',{}));
  assert.equal(session.access.role,'admin');
  assert.equal(session.access.singlePlayer,true);
  await eventReader(t,url,'');
  code(await local('/api/presence',{yaw:0,pitch:0,motion:'idle'}));
  const target={x:7.5,y:8,z:7.5};
  assert.deepEqual(code(await local('/api/teleport',target)).position,target);
  const {warps:[warp]}=code(await local('/api/warps',{title:'Local warp'}));
  assert.deepEqual(code(await local('/api/warps')).warps,[warp]);
  assert.deepEqual(code(await local('/api/respawn',{})).position,session.position);
  assert.deepEqual(code(await local('/api/teleport',{warpId:warp.id})).position,target);
  assert.deepEqual(code(await local('/api/warps/remove',{id:warp.id})).warps,[]);
});

test('altitude music is announced to an invited session and streams only with access',async t=>{
  const generated=startAssets();
  const altitudeMusic=join(generated,'local-track.mp3');
  writeFileSync(altitudeMusic,'audio');
  const {start}=fixture(t,generated);
  const urls=await start({altitudeMusic});
  const track='/api/altitude-music';
  assert.equal(code(await request(urls.public,track),401).error,'session_required');
  const owner=await request(urls.owner,'/api/access/owner',{body:{key:secret,profileName:'Host Owner'}});
  const invite=code(await request(urls.owner,'/api/admin/invites',{body:{kind:'player'},cookie:owner.cookie}));
  const player=await request(urls.public,'/api/session',{body:{invite:invite.code,profileName:'Music Player'},origin:external});
  assert.equal(code(player).altitudeMusic,track);
  const read=await fetch(urls.public+track,{headers:{Cookie:player.cookie,Range:'bytes=1-3'}});
  assert.equal(read.status,206);
  assert.equal(read.headers.get('content-type'),'audio/mpeg');
  assert.equal(read.headers.get('cache-control'),'private, no-store');
  assert.equal(await read.text(),'udi');
  assert.equal(code(await request(urls.public,track,{cookie:player.cookie,headers:{Origin:'https://elsewhere.test'}}),403).error,'origin_denied');
  unlinkSync(altitudeMusic);
  assert.equal(code(await request(urls.public,'/api/session',{body:{},cookie:player.cookie,origin:external})).altitudeMusic,undefined);
  assert.equal(code(await request(urls.public,track,{cookie:player.cookie}),404).error,'not_found');
});

test('altitude music supports a configured solo track on loopback',async t=>{
  const generated=startAssets();
  const altitudeMusic=join(generated,'local-track.mp3');
  writeFileSync(altitudeMusic,'audio');
  const {start}=fixture(t,generated);
  const {public:url}=await start({altitudeMusic,singlePlayer:true,secure:false,inviteRequired:false,ownerOnPrimary:true,
    allowedOrigin:undefined,publicOrigin:undefined});
  const session=code(await request(url,'/api/session',{body:{}}));
  assert.equal(session.altitudeMusic,'/api/altitude-music');
  const music=await fetch(url+session.altitudeMusic);
  assert.equal(music.headers.get('content-type'),'audio/mpeg');
  assert.equal(await music.text(),'audio');
});

test('flight preferences persist for an invited profile and ignore delayed updates',async t=>{
  const {start}=fixture(t);
  let urls=await start();
  const owner=await request(urls.owner,'/api/access/owner',{body:{key:secret,profileName:'Host Owner'}});
  const invite=code(await request(urls.owner,'/api/admin/invites',{body:{kind:'player'},cookie:owner.cookie}));
  const player=await request(urls.public,'/api/session',{body:{invite:invite.code,profileName:'Flying Player'},origin:external});
  const call=(path,body,cookie=player.cookie)=>request(urls.public,path,{body,cookie,origin:external});
  assert.equal(code(player).flight,false);
  assert.equal(code(await call('/api/flight',{enabled:true,sequence:1},null),401).error,'session_required');
  assert.equal(code(await call('/api/flight',{enabled:true,sequence:1})).flight,true);
  urls=await start();
  assert.equal(code(await call('/api/session',{})).flight,true);
  assert.equal(code(await call('/api/flight',{enabled:false,sequence:3})).flight,false);
  assert.equal(code(await call('/api/flight',{enabled:true,sequence:2})).flight,false);
  assert.equal(code(await call('/api/session',{})).flight,false);
});

test('single-player flight survives closing the game and clears on returning to spawn',async t=>{
  const {start}=fixture(t);
  const options={singlePlayer:true,secure:false,inviteRequired:false,ownerOnPrimary:true,
    allowedOrigin:undefined,publicOrigin:undefined};
  let {public:url}=await start(options);
  const local=(path,body)=>request(url,path,{body});
  assert.equal(code(await local('/api/session',{})).flight,false);
  assert.equal(code(await local('/api/flight',{enabled:true,sequence:1})).flight,true);
  ({public:url}=await start(options));
  assert.equal(code(await local('/api/session',{})).flight,true);
  await eventReader(t,url,'');
  const pose={yaw:0,pitch:0,motion:'idle'};
  code(await local('/api/presence',pose));
  const sitting=code(await local('/api/seat',{...pose,ground:true}));
  assert.equal(sitting.seat.kind,'ground');
  assert.equal(code(await local('/api/flight',{enabled:true,sequence:2}),409).error,'flight_unavailable');
  assert.equal(code(await local('/api/session',{})).flight,false);
  code(await local('/api/seat',{...pose,ground:false}));
  assert.equal(code(await local('/api/flight',{enabled:true,sequence:3})).flight,true);
  code(await local('/api/respawn',{}));
  assert.equal(code(await local('/api/session',{})).flight,false);
});
