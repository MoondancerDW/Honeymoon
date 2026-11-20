import assert from 'node:assert/strict';
import {once} from 'node:events';
import {request as httpRequest} from 'node:http';
import {mkdtempSync,mkdirSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {crc32,deflateSync} from 'node:zlib';
import * as geometry from '../world/geometry.mjs';
import {offhandSlot} from '../world/item-stack.mjs';
import {createAccess} from './access.mjs';
import {createHoneymoonServer} from './index.mjs';
import {normalizeLegacyPlayerName} from './legacy-player.mjs';
import {openStore} from './store.mjs';

const fixtures=fileURLToPath(new URL('../work/',import.meta.url));
const external='https://game.example.test';
const secret='owner-local-test-secret';
const config={geometry,secure:true,inviteRequired:true,ownerOnPrimary:false,allowedOrigin:external,publicOrigin:external,
  npcAdminKey:secret,initialMode:'creative'};

function startAssets({ceiling}={}) {
  mkdirSync(fixtures,{recursive:true});
  const generated=mkdtempSync(join(fixtures,'access-test-'));
  mkdirSync(join(generated,'world','chunks'),{recursive:true});
  const palette=['air','legacy:1:0'];
  const bounds={minX:0,minY:0,minZ:0,maxX:15,maxY:15,maxZ:15};
  const sections=Buffer.alloc(8192);
  for (let index=0;index<256;index++) sections.writeUInt16LE(1,index*2);
  if (ceiling) sections.writeUInt16LE(1,2*(ceiling.x+16*ceiling.z+256*ceiling.y));
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

test('only the owner can change administrator roles and signed-in devices use the current role after reopening',t=>{
  const {state}=fixture(t);
  let store=openStore(state);
  try {
    let access=createAccess(store,{ownerKey:secret,inviteRequired:true});
    const {credential:owner}=access.bootstrap({key:secret,profileName:'Local owner'});
    const invite=access.issue(owner.uid,{kind:'player'});
    const {credential:guest,token}=access.signIn({invite:invite.code,profileName:'Guest player'});
    assert.throws(()=>access.setRole(guest.uid,guest.uid,'admin'),{code:'admin_required'});
    assert.throws(()=>access.setRole(owner.uid,owner.uid,'player'),{code:'owner_role_protected'});
    assert.throws(()=>access.setRole(owner.uid,guest.uid,'owner'),{code:'invalid_profile_role'});
    assert.deepEqual(access.setRole(owner.uid,guest.uid,'admin'),{uid:guest.uid,role:'admin',changed:true});
    assert.deepEqual(access.setRole(owner.uid,guest.uid,'admin'),{uid:guest.uid,role:'admin',changed:false});
    assert.equal(access.authenticate(token).role,'admin');
    assert.throws(()=>access.setRole(guest.uid,guest.uid,'player'),{code:'owner_required'});
    store.close();
    store=openStore(state);
    access=createAccess(store,{ownerKey:secret,inviteRequired:true});
    const active=access.authenticate(token);
    assert.equal(active.role,'admin');
    assert.deepEqual(access.setRole(owner.uid,active.uid,'player'),{uid:active.uid,role:'player',changed:true});
    assert.throws(()=>access.listUids(active.uid),{code:'admin_required'});
    assert.equal(access.authenticate(token).role,'player');
  } finally {store.close();}
});

test('the private comparison ingress accepts same-origin sessions and rejects cross-origin writes',async t=>{
  const comparisonOrigin=external+':8443';
  const urls=await fixture(t).start({comparisonOrigin});
  const owner=await request(urls.owner,'/api/access/owner',{body:{key:secret,profileName:'Local owner'}});
  code(owner);
  const invite=code(await request(urls.owner,'/api/admin/invites',{body:{kind:'player'},cookie:owner.cookie}));
  const body={invite:invite.code,profileName:'Private route guest'};
  async function compare(origin) {
    const payload=JSON.stringify(body);
    const response=await new Promise((resolve,reject)=>{
      const outgoing=httpRequest(urls.public+'/api/session',{method:'POST',headers:{
        Host:new URL(comparisonOrigin).host, Origin:origin, 'Content-Type':'application/json',
        'Content-Length':Buffer.byteLength(payload),
      }},resolve);
      outgoing.once('error',reject);
      outgoing.end(payload);
    });
    let text='';
    for await (const part of response.setEncoding('utf8')) text+=part;
    const flags=response.headers['set-cookie']?.[0];
    return {status:response.statusCode,json:JSON.parse(text),flags,cookie:flags?.split(';')[0]};
  }
  assert.equal(code(await compare(external),403).error,'origin_denied');
  assert.equal(code(await request(urls.public,'/api/session',{origin:comparisonOrigin,body}),403).error,'origin_denied');
  const guest=await compare(comparisonOrigin);
  assert.equal(code(guest).access.role,'player');
  assert.match(guest.flags,/; Secure/);
  assert.equal(code(await request(urls.public,'/api/session',{origin:external,body:{},cookie:guest.cookie})).access.uid,
    guest.json.access.uid);
});

const legacyStack=(size,slot,stack)=>Array.from({length:size},(_,index)=>index===slot?stack:null);
function stageLegacy(store,uid,nickname,stack,{selected=7,ender=null}={}) {
  const inventory={slots:legacyStack(36,selected,stack),selected,equipment:Array(4).fill(null)};
  store.putState('legacy-player',normalizeLegacyPlayerName(nickname),'import',1,
    {uid,nickname,inventory,enderItems:legacyStack(27,12,ender)});
  return {...inventory,offhand:null};
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
  const join=(body,cookie,headers)=>request(urls.public,'/api/session',{body,cookie,origin:external,headers});
  const initial=code(await admin('/api/admin/invites',{kind:'player',label:'Alice'}));
  assert.equal(initial.invite.status,'active');
  assert.equal(initial.invite.usedBy,undefined);
  assert.equal(new URL(initial.url).hash,`#invite=${initial.code}`);
  assert.equal(code(await join({invite:initial.code}),409).error,'profile_name_required');
  const input={invite:initial.code,profileName:'Amy Person'};
  const concurrent=await Promise.all([
    join(input,undefined,{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0'}),
    join(input,undefined,{'sec-ch-ua':'"Chromium";v="145", "Google Chrome";v="145"',
      'sec-ch-ua-mobile':'?1','sec-ch-ua-platform':'"Android"'}),
  ]);
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
    const second=await join({invite:pair.code},undefined,{'user-agent':
      'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'});
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
    const used=audit.invites.find(row=>row.id===initial.invite.id);
    assert.equal(used.status,'used');
    const device=winner===concurrent[0] ? {browser:'Firefox',deviceType:'desktop'} : {browser:'Google Chrome',deviceType:'mobile'};
    assert.deepEqual(used.usedBy,{uid:player.uid,profileName:'Amy Person',...device});
    assert.deepEqual(audit.invites.find(row=>row.id===pair.invite.id).usedBy,
      {uid:player.uid,profileName:'Amy Person',browser:'Safari',deviceType:'tablet'});
    assert.ok(!JSON.stringify(audit).includes(initial.code));
    assert.ok(!JSON.stringify(audit).includes('Mozilla/5.0'));
  } finally { await viewer.body.cancel(); }
});

test('used invitations from schema 10 only show information the old save actually recorded',async t=>{
  const {state,start,close}=fixture(t);
  let urls=await start();
  const owner=await request(urls.owner,'/api/access/owner',{body:{key:secret,profileName:'Host Owner'}});
  const uid=code(owner).access.uid;
  const issue=body=>request(urls.owner,'/api/admin/invites',{body,cookie:owner.cookie});
  const general=code(await issue({kind:'player'})).invite;
  const device=code(await issue({kind:'device',profileUid:uid})).invite;
  await close();
  const old=new DatabaseSync(state);
  old.exec(`UPDATE access_invites SET used_at=created_at;
    ALTER TABLE access_invites DROP COLUMN used_by;
    ALTER TABLE access_invites DROP COLUMN used_browser;
    ALTER TABLE access_invites DROP COLUMN used_device_type;
    PRAGMA user_version=10;`);
  old.close();

  urls=await start();
  const {invites}=code(await request(urls.owner,'/api/admin/access',{cookie:owner.cookie}));
  const unknown=invites.find(row=>row.id===general.id);
  const known=invites.find(row=>row.id===device.id);
  assert.equal(unknown.status,'used');
  assert.equal(unknown.usedBy,undefined);
  assert.deepEqual(known.usedBy,{uid,profileName:'Host Owner',browser:null,deviceType:null});
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

function unicornSkin(size='small') {
  const sizeMarkers={small:[0xff,0xbe,0x53],large:[0xce,0x32,0x54],tall:[0x2a,0x3c,0x78]};
  const ihdr=Buffer.from([0,0,0,64,0,0,0,32,8,6,0,0,0]);
  const pixels=Buffer.alloc(32*(1+64*4));
  pixels.set([0xd1,0x9f,0xe4,255],1);
  pixels.set([...sizeMarkers[size],255],13);
  function chunk(type,data=Buffer.alloc(0)) {
    const result=Buffer.alloc(data.length+12);
    result.writeUInt32BE(data.length);
    result.write(type,4);
    data.copy(result,8);
    result.writeUInt32BE(crc32(result.subarray(4,-4)),result.length-4);
    return result;
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),
    chunk('IDAT',deflateSync(pixels)),chunk('IEND')]).toString('base64');
}

test('administrators set persistent races for themselves and other players until a skin is submitted',async t=>{
  const {start}=fixture(t);
  let urls=await start({initialMode:'game'});
  const owner=await request(urls.owner,'/api/access/owner',{body:{key:secret,profileName:'Host Owner'}});
  const hostUid=code(owner).access.uid;
  const host=(path,body)=>request(urls.owner,path,{body,cookie:owner.cookie});
  const invitation=code(await host('/api/admin/invites',{kind:'player'}));
  const guest=await request(urls.public,'/api/session',{body:{invite:invitation.code,profileName:'Cloud Watcher'},origin:external});
  const guestUid=code(guest).access.uid;
  const player=(path,body)=>request(urls.public,path,{body,cookie:guest.cookie,origin:external});
  const race='/api/admin/profiles/race';
  const skin=unicornSkin();
  const native=code(await player('/api/profile',{skin}));
  assert.deepEqual([native.ponyType,native.size,native.raceOverride,native.raceRevision],['unicorn','small',null,1]);
  assert.equal(native.gameMode.maxHealth,6);
  assert.equal(code(await player(race,{uid:guestUid,ponyType:'alicorn'}),403).error,'admin_required');
  assert.equal(code(await host(race,{uid:guestUid,ponyType:'unknown'}),400).error,'invalid_pony_type');
  assert.equal(code(await host(race,{uid:'10000000-0000-4000-8000-000000000010',ponyType:'earth'}),404).error,'player_missing');

  const hostEvents=await eventReader(t,urls.owner,owner.cookie);
  const guestEvents=await eventReader(t,urls.public,guest.cookie);
  assert.equal((await hostEvents('profile-race')).uid,hostUid);
  assert.equal((await guestEvents('profile-race')).raceRevision,1);
  code(await player('/api/presence',{yaw:0,pitch:0,motion:'idle'}));
  const pegasus=code(await host(race,{uid:guestUid,ponyType:'pegasus'}));
  assert.deepEqual((await guestEvents('profile-race')),pegasus);
  assert.deepEqual([pegasus.ponyType,pegasus.size,pegasus.raceOverride,pegasus.raceRevision],['pegasus','small','pegasus',2]);
  assert.equal(pegasus.flightAllowed,true);
  assert.equal(pegasus.gameMode.maxHealth,4);
  let avatar;
  do {
    const {players}=await hostEvents('presence');
    avatar=players.find(profile=>profile.id===native.id && profile.ponyType==='pegasus');
  } while (!avatar);
  assert.equal(Object.hasOwn(avatar,'raceOverride'),false);
  assert.equal(Object.hasOwn(avatar,'raceRevision'),false);

  assert.equal(code(await player('/api/flight',{enabled:true,sequence:1})).flight,true);
  const earth=code(await host(race,{uid:guestUid,ponyType:'earth'}));
  assert.deepEqual(await guestEvents('profile-race'),earth);
  assert.equal(earth.flight,false);
  assert.equal(earth.gameMode.maxHealth,8);
  assert.equal(code(await player('/api/flight',{enabled:true,sequence:2}),409).error,'flight_unavailable');
  const self=code(await host(race,{uid:hostUid,ponyType:'alicorn'}));
  assert.deepEqual(await hostEvents('profile-race'),self);
  assert.equal(self.ponyType,'alicorn');
  assert.equal(self.gameMode.maxHealth,12);

  urls=await start({initialMode:'game'});
  assert.equal(code(await host('/api/session',{})).profile.ponyType,'alicorn');
  const rejoined=code(await player('/api/session',{}));
  assert.deepEqual([rejoined.profile.ponyType,rejoined.profile.size,rejoined.profile.raceOverride,rejoined.profile.raceRevision],
    ['earth','small','earth',3]);
  const reconnect=await eventReader(t,urls.public,guest.cookie);
  assert.equal((await reconnect('profile-race')).raceRevision,3);
  const adminRow=code(await host('/api/admin/access')).profiles.find(row=>row.uid===guestUid);
  assert.deepEqual([adminRow.ponyType,adminRow.raceOverride],['earth','earth']);
  const renamed=code(await player('/api/profile',{nickname:'New Nickname'}));
  assert.deepEqual([renamed.raceOverride,renamed.raceRevision],['earth',3]);
  const uploaded=code(await player('/api/profile',{skin}));
  assert.deepEqual([uploaded.ponyType,uploaded.size,uploaded.raceOverride,uploaded.raceRevision],['unicorn','small',null,4]);
  assert.equal(uploaded.gameMode.maxHealth,6);
  assert.equal((await reconnect('profile-race')).raceRevision,4);
  assert.equal(code(await host(race,{uid:guestUid,ponyType:'earth'})).raceRevision,5);
  const automatic=code(await host(race,{uid:guestUid,ponyType:null}));
  assert.deepEqual([automatic.ponyType,automatic.raceOverride,automatic.raceRevision],['unicorn',null,6]);
  assert.equal(code(await host(race,{uid:guestUid,ponyType:'alicorn'})).raceRevision,7);
  const cleared=code(await player('/api/profile',{skin:null}));
  assert.deepEqual([cleared.ponyType,cleared.size,cleared.raceOverride,cleared.raceRevision],['earth','normal',null,8]);
  assert.equal(cleared.gameMode.maxHealth,12);
  const large=code(await player('/api/profile',{skin:unicornSkin('large')}));
  assert.deepEqual([large.ponyType,large.size,large.gameMode.maxHealth],['unicorn','large',13]);
  const largePegasus=code(await host(race,{uid:guestUid,ponyType:'pegasus'}));
  assert.deepEqual([largePegasus.size,largePegasus.gameMode.maxHealth],['large',11]);
  const tall=code(await player('/api/profile',{skin:unicornSkin('tall')}));
  assert.deepEqual([tall.ponyType,tall.size,tall.gameMode.maxHealth],['unicorn','tall',10]);
});

test('losing the offhand ability drops its stack once for both overrides and skin changes',async t=>{
  const {state,start}=fixture(t);
  const urls=await start();
  const owner=await request(urls.owner,'/api/access/owner',{body:{key:secret,profileName:'Host Owner'}});
  const host=(path,body)=>request(urls.owner,path,{body,cookie:owner.cookie});
  const invite=code(await host('/api/admin/invites',{kind:'player'}));
  const guest=await request(urls.public,'/api/session',{body:{invite:invite.code,profileName:'Cloud Watcher'},origin:external});
  const uid=code(guest).access.uid;
  const player=(path,body)=>request(urls.public,path,{body,cookie:guest.cookie,origin:external});
  const race=async ponyType=>code(await host('/api/admin/profiles/race',{uid,ponyType}));
  const world=async()=>code(await player('/api/world'));
  const book={key:'creative:387:0',count:1,nbt:{title:'Saved pages',author:'Cloud Watcher',pages:['Original text'],
    display:{Name:'Keepsake',Lore:['A letter from home']}}};
  const publicText={title:book.nbt.title,author:book.nbt.author,display:book.nbt.display};
  const store=openStore(state);
  try {
    store.putState('inventory',uid,'slots',3,{...guest.json.inventory,offhand:book});
  } finally { store.close(); }

  await race('alicorn');
  await race('unicorn');
  assert.deepEqual((await world()).inventory.offhand,book);
  await eventReader(t,urls.public,guest.cookie);
  code(await player('/api/presence',{yaw:Math.PI/2,pitch:0,motion:'idle'}));
  await race('earth');
  await race('earth');
  const afterOverride=await world();
  assert.equal(afterOverride.inventory.offhand,null);
  assert.equal(afterOverride.droppedItems.length,1);
  assert.ok(afterOverride.droppedItems[0].position[0]<8.5,'stack is thrown forward in the current heading');
  assert.deepEqual(afterOverride.droppedItems[0].item.nbt,publicText);

  const picked=code(await player('/api/action',{requestId:'offhand-book-pickup',type:'pickup_item'}));
  assert.equal(picked.pickedItem,afterOverride.droppedItems[0].key);
  assert.deepEqual(picked.inventory.slots[0],book);
  await race('alicorn');
  code(await player('/api/action',{requestId:'offhand-book-move',type:'inventory_move',from:0,to:offhandSlot}));
  assert.equal(code(await player('/api/profile',{skin:null})).ponyType,'earth');
  const afterSkin=await world();
  assert.equal(afterSkin.inventory.offhand,null);
  assert.equal(afterSkin.inventory.slots[0],null);
  assert.equal(afterSkin.droppedItems.length,1);
  assert.notEqual(afterSkin.droppedItems[0].key,picked.pickedItem);
  assert.deepEqual(afterSkin.droppedItems[0].item.nbt,publicText);
});

test('administrators update pony size without changing race and both settings follow the selected profile',async t=>{
  const {start,close,state}=fixture(t);
  let urls=await start({initialMode:'game'});
  const owner=await request(urls.owner,'/api/access/owner',{body:{key:secret,profileName:'Host Owner'}});
  const hostUid=code(owner).access.uid;
  const host=(path,body)=>request(urls.owner,path,{body,cookie:owner.cookie});
  const invite=code(await host('/api/admin/invites',{kind:'player'}));
  const guest=await request(urls.public,'/api/session',{body:{invite:invite.code,profileName:'Visitor'},origin:external});
  const guestUid=code(guest).access.uid;
  const player=(path,body)=>request(urls.public,path,{body,cookie:guest.cookie,origin:external});
  const race='/api/admin/profiles/race',size='/api/admin/profiles/size';
  const skin=unicornSkin();
  code(await player('/api/profile',{skin}));
  // Read the pre-size database representation of a race override.
  await close();
  const db=new DatabaseSync(state);
  db.prepare('UPDATE module_state SET value=? WHERE module=? AND owner=? AND key=?')
    .run(JSON.stringify('pegasus'),'pony-abilities',guestUid,'race-override');
  db.close();
  urls=await start({initialMode:'game'});
  const hostEvents=await eventReader(t,urls.owner,owner.cookie);
  const guestEvents=await eventReader(t,urls.public,guest.cookie);
  assert.equal((await hostEvents('profile-race')).uid,hostUid);
  const initial=await guestEvents('profile-race');
  assert.deepEqual([initial.ponyType,initial.size,initial.raceOverride,initial.sizeOverride],['pegasus','small','pegasus',null]);
  assert.equal(code(await player(size,{uid:guestUid,size:'large'}),403).error,'admin_required');
  assert.equal(code(await host(size,{uid:guestUid,size:'huge'}),400).error,'invalid_pony_size');
  assert.equal(code(await host(size,{uid:'10000000-0000-4000-8000-000000000010',size:'small'}),404).error,'player_missing');
  code(await player('/api/presence',{yaw:0,pitch:0,motion:'idle'}));
  const page=crypto.randomUUID();
  const {movement}=code(await player('/api/position-state',{page,start:true}));
  const {x,y,z}=movement.position;
  const waiting={page,epoch:movement.epoch,first:2,from:[x+.1,y,z],trail:[[x+.2,y,z]],x:x+.2,y,z,requestId:'before-size-2'};
  assert.equal(code(await player('/api/position',waiting)).movement.accepted,0);

  const assigned=code(await host(size,{uid:guestUid,size:'large'}));
  assert.deepEqual(assigned.position,movement.position);
  const stale=code(await player('/api/position',{...waiting,first:1,from:[x,y,z],trail:[[x+.1,y,z]],x:x+.1,
    requestId:'before-size-1'}),409);
  assert.equal(stale.error,'movement_reset');
  assert.notEqual(stale.movement.epoch,movement.epoch);
  assert.equal(stale.movement.accepted,0);
  assert.deepEqual(stale.movement.position,movement.position);
  assert.deepEqual(await guestEvents('profile-race'),assigned);
  assert.deepEqual([assigned.size,assigned.sizeOverride,assigned.ponyType,assigned.raceRevision,assigned.gameMode.maxHealth],
    ['large','large','pegasus',2,11]);
  let avatar;
  do {
    const {players}=await hostEvents('presence');
    avatar=players.find(profile=>profile.id===code(guest).profile.id && profile.size==='large');
  } while (!avatar);
  assert.equal(avatar.ponyType,'pegasus');
  assert.equal(Object.hasOwn(avatar,'sizeOverride'),false);

  const own=code(await host(size,{uid:hostUid,size:'small'}));
  assert.deepEqual(await hostEvents('profile-race'),own);
  assert.deepEqual([own.size,own.sizeOverride,own.ponyType,own.gameMode.maxHealth],['small','small','earth',8]);
  const switched=code(await host(race,{uid:guestUid,ponyType:'alicorn'}));
  assert.deepEqual(await guestEvents('profile-race'),switched);
  assert.deepEqual([switched.size,switched.sizeOverride,switched.gameMode.maxHealth],['large','large',15]);

  urls=await start({initialMode:'game'});
  const rejoined=code(await player('/api/session',{}));
  assert.equal(rejoined.profile.sizeOverride,'large');
  assert.equal(code(await host('/api/session',{})).profile.size,'small');
  const listed=code(await host('/api/admin/access')).profiles.find(profile=>profile.uid===guestUid);
  assert.deepEqual([listed.size,listed.sizeOverride],['large','large']);
  const automatic=code(await host(size,{uid:guestUid,size:null}));
  assert.deepEqual([automatic.size,automatic.sizeOverride,automatic.raceOverride,automatic.gameMode.maxHealth],
    ['small',null,'alicorn',8]);
  const tall=code(await host(size,{uid:guestUid,size:'tall'}));
  assert.deepEqual([tall.size,tall.gameMode.maxHealth],['tall',12]);
  const uploaded=code(await player('/api/profile',{skin}));
  assert.deepEqual([uploaded.size,uploaded.sizeOverride,uploaded.ponyType,uploaded.raceOverride],['small',null,'unicorn',null]);
});

test('changing the size of an offline player resolves their previous saved position before growing',async t=>{
  const {start,close,state}=fixture(t,startAssets({ceiling:{x:4,y:2,z:4}}));
  let urls=await start({initialMode:'game'});
  const owner=await request(urls.owner,'/api/access/owner',{body:{key:secret,profileName:'Host Owner'}});
  const host=(path,body)=>request(urls.owner,path,{body,cookie:owner.cookie});
  const invite=code(await host('/api/admin/invites',{kind:'player'}));
  const guest=await request(urls.public,'/api/session',{body:{invite:invite.code,profileName:'Visitor'},origin:external});
  const initial=code(guest),uid=initial.access.uid;
  const player=(path,body)=>request(urls.public,path,{body,cookie:guest.cookie,origin:external});
  code(await player('/api/profile',{skin:unicornSkin()}));
  await close();

  const originalPosition={x:4.5,y:1,z:4.5};
  const db=new DatabaseSync(state);
  db.prepare('UPDATE module_state SET value=? WHERE module=? AND owner=? AND key=?')
    .run(JSON.stringify({world:initial.contentHash,position:originalPosition,stance:'stand'}),'movement',uid,'pos');
  db.close();
  urls=await start({initialMode:'game'});
  const changed=code(await host('/api/admin/profiles/size',{uid,size:'large'}));
  assert.notDeepEqual(changed.position,originalPosition);
  assert.notDeepEqual(changed.position,initial.position);
  assert.ok(Math.hypot(changed.position.x-originalPosition.x,changed.position.y-originalPosition.y,
    changed.position.z-originalPosition.z)<=2);
  const saved=new DatabaseSync(state,{readOnly:true});
  const {value}=saved.prepare('SELECT value FROM module_state WHERE module=? AND owner=? AND key=?')
    .get('movement',uid,'pos');
  saved.close();
  assert.deepEqual(JSON.parse(value).position,changed.position);
  const returned=code(await player('/api/session',{}));
  assert.deepEqual(returned.position,changed.position);
  assert.equal(returned.profile.size,'large');
});

test('night vision settings follow the target profile, with a personal switch and safe initialization',async t=>{
  const {start}=fixture(t);
  let urls=await start();
  const owner=await request(urls.owner,'/api/access/owner',{body:{key:secret,profileName:'Host Owner'}});
  const ownerUid=code(owner).access.uid;
  const host=(path,body)=>request(urls.owner,path,{body,cookie:owner.cookie});
  const invitation=code(await host('/api/admin/invites',{kind:'player'}));
  const guest=await request(urls.public,'/api/session',{body:{invite:invitation.code,profileName:'Target Player'},origin:external});
  const uid=code(guest).access.uid;
  const player=(path,body)=>request(urls.public,path,{body,cookie:guest.cookie,origin:external});
  const personal='/api/night-vision',admin='/api/admin/profiles/night-vision';
  assert.equal(guest.json.nightVision,null);
  assert.equal(code(await request(urls.public,personal,{origin:external,body:{enabled:true}}),401).error,'session_required');
  assert.equal(code(await player(admin,{uid:ownerUid,enabled:true}),403).error,'admin_required');
  assert.equal(code(await host(admin,{uid:'10000000-0000-4000-8000-000000000010',enabled:true}),404).error,'player_missing');
  assert.equal(code(await player(personal,{enabled:'true'}),400).error,'invalid_night_vision');
  assert.equal(code(await player(personal,{enabled:false,initialize:1}),400).error,'invalid_night_vision');

  const events=await eventReader(t,urls.public,guest.cookie);
  const ownerEvents=await eventReader(t,urls.owner,owner.cookie);
  const on=code(await host(admin,{uid,enabled:true}));
  assert.deepEqual(on,{uid,enabled:true,revision:1});
  assert.deepEqual(await events('profile-night-vision'),on);
  assert.deepEqual(code(await player(personal,{enabled:false,initialize:true})),on);
  assert.equal(code(await host('/api/session',{})).nightVision,null);
  const rows=code(await host('/api/admin/access')).profiles;
  assert.equal(rows.find(row=>row.uid===uid).nightVision,true);
  assert.equal(rows.find(row=>row.uid===ownerUid).nightVision,null);
  const off=code(await player(personal,{uid:ownerUid,enabled:false}));
  assert.deepEqual(off,{uid,enabled:false,revision:2});
  assert.deepEqual(await events('profile-night-vision'),off);
  const initialized=code(await host(personal,{enabled:false,initialize:true}));
  assert.deepEqual(initialized,{uid:ownerUid,enabled:false,revision:1});
  assert.deepEqual(await ownerEvents('profile-night-vision'),initialized);

  urls=await start();
  const rejoined=code(await player('/api/session',{}));
  assert.deepEqual(rejoined.nightVision,{enabled:false,revision:2});
  const reconnect=await eventReader(t,urls.public,guest.cookie);
  assert.deepEqual(await reconnect('profile-night-vision'),off);
  const enabled=code(await host(admin,{uid,enabled:true}));
  assert.deepEqual(await reconnect('profile-night-vision'),{uid,enabled:true,revision:3});
  assert.equal(enabled.revision,3);
});

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
  assert.equal(flight.teleport.flight,false);
  assert.deepEqual(await hostEvent('admin-teleport'),flight.teleport);
  code(await host('/api/modes',{mode:'creative',target:hostUid}));
  const hover=code(await host(teleport,{target:adminUid,direction:'to'}));
  assert.equal(hover.teleport.flight,true);
  assert.deepEqual(await hostEvent('admin-teleport'),hover.teleport);

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
  const events=await eventReader(t,url,'');
  assert.equal((await events('profile-race')).ponyType,'earth');
  const uid=session.access.uid;
  assert.equal(code(await local('/api/admin/access')).profiles.find(profile=>profile.uid===uid).raceOverride,null);
  assert.equal(code(await local('/api/admin/profiles/race',{uid,ponyType:'unicorn'})).ponyType,'unicorn');
  assert.equal((await events('profile-race')).raceOverride,'unicorn');
  assert.equal(code(await local('/api/admin/profiles/size',{uid,size:'large'})).size,'large');
  assert.equal((await events('profile-race')).sizeOverride,'large');
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
