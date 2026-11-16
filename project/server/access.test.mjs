import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import * as geometry from '../world/geometry.mjs';
import {createHoneymoonServer} from './index.mjs';
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

test('owner bootstrap must use the isolated listener and can claim an exact saved version-8 UID',async t=>{
  const {state,start,close}=fixture(t);
  const old=openStore(state);
  const {id,token}=old.createPlayer();
  old.updateProfile(id,{nickname:'Saved Owner'},null);
  old.putState('inventory',id,'slots',2,{slots:[{key:'legacy:1:0',cell:'legacy:1:0',count:19}],selected:0,equipment:[]});
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
