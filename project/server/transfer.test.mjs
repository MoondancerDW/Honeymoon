import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {once} from 'node:events';
import {cp,mkdir,mkdtemp,readFile,realpath,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {crc32,deflateSync} from 'node:zlib';
import {acquireInstance} from '../portable/single-instance.mjs';
import * as geometry from '../world/geometry.mjs';
import {backupState} from './backup.mjs';
import {createHoneymoonServer} from './index.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const run=promisify(execFile);
const origin='https://game.example.test';
const ownerKey='synthetic-transfer-owner-key';
const launcher=join(project,'portable','Transfer-Honeymoon.mjs');
const databaseName='honeymoon.sqlite';

async function layout(directory,spawn=[8.5,1,8.5]) {
  const world=join(directory,'generated','world');
  await mkdir(join(world,'chunks'),{recursive:true});
  await mkdir(join(directory,'server'));
  await cp(join(project,'world'),join(directory,'world'),{recursive:true});
  await cp(join(project,'portable','single-instance.mjs'),join(directory,'single-instance.mjs'));
  for (const module of ['backup','base','full-detail','log-ground','snow-cleanup','solo-assets']) {
    await cp(join(project,'server',module+'.mjs'),join(directory,'server',module+'.mjs'));
  }
  const bounds={minX:0,minY:0,minZ:0,maxX:15,maxY:15,maxZ:15};
  await writeFile(join(world,'world.json'),JSON.stringify({schemaVersion:1,bounds,spawn,
    palette:['air','legacy:1:0'],chunks:[[0,0]]}));
  const floor=Buffer.alloc(8192);
  for (let index=0;index<256;index++) floor.writeUInt16LE(1,index*2);
  await writeFile(join(world,'chunks','0.0.json'),JSON.stringify({
    x:0,z:0,sections:[{y:0,indices:floor.toString('base64')}],objects:[],entities:[],
  }));
}

async function start(directory) {
  const app=createHoneymoonServer({geometry,secure:true,inviteRequired:true,ownerOnPrimary:false,
    allowedOrigin:origin,publicOrigin:origin,npcAdminKey:ownerKey,initialMode:'creative',
    generated:join(directory,'generated'),state:join(directory,'state',databaseName)});
  app.server.listen(0,'127.0.0.1');
  app.ownerServer.listen(0,'127.0.0.1');
  await Promise.all([once(app.server,'listening'),once(app.ownerServer,'listening')]);
  const address=listener=>'http://127.0.0.1:'+listener.address().port;
  return {public:address(app.server),owner:address(app.ownerServer),close:()=>app.close()};
}

async function call(url,path,{body,cookie,expected=200,host=url}={}) {
  const response=await fetch(url+path,{method:body===undefined?'GET':'POST',
    headers:{...(cookie&&{Cookie:cookie}),...(body!==undefined&&{'Content-Type':'application/json',Origin:host})},
    body:body===undefined?undefined:JSON.stringify(body)});
  const json=await response.json();
  assert.equal(response.status,expected,JSON.stringify(json));
  return {json,cookie:response.headers.getSetCookie()[0]?.split(';')[0]};
}

function skinPng() {
  function chunk(type,data) {
    const result=Buffer.alloc(12+data.length);
    result.writeUInt32BE(data.length);
    result.write(type,4);
    result.set(data,8);
    result.writeUInt32BE(crc32(result.subarray(4,-4)),result.length-4);
    return result;
  }
  const header=Buffer.alloc(13);
  header.writeUInt32BE(64);
  header.writeUInt32BE(32,4);
  header.set([8,6],8);
  const rgba=Buffer.alloc(32*(1+64*4));
  rgba.set([75,149,226,255],1);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),
    chunk('IDAT',deflateSync(rgba)),chunk('IEND',Buffer.alloc(0))]);
}

const transfer=(operation,directory,snapshot)=>run(process.execPath,[launcher,operation,directory,snapshot],{timeout:20_000});

test('closed-install transfer restores a browser device, pending invite, owner, skin, inventory, edits and logs',async t=>{
  const temp=await realpath(tmpdir());
  const root=await mkdtemp(join(temp,'honeymoon-transfer-test-'));
  const source=join(root,'original install'),destination=join(root,'destination install'),snapshot=join(root,'snapshot');
  let app, lease;
  t.after(async()=>{
    await app?.close();
    await lease?.close();
    const path=await realpath(root);
    if (dirname(path)===temp) await rm(path,{recursive:true,force:true});
  });
  await Promise.all([layout(source),layout(destination)]);
  app=await start(source);

  const owner=await call(app.owner,'/api/access/owner',{body:{key:ownerKey,profileName:'Test Owner'}});
  const active=await call(app.owner,'/api/admin/invites',{cookie:owner.cookie,body:{kind:'player'}});
  const guest=await call(app.public,'/api/session',{host:origin,body:{invite:active.json.code,profileName:'Test Guest'}});
  const player=guest.json.access;
  const pending=await call(app.owner,'/api/admin/invites',{
    cookie:owner.cookie,body:{kind:'device',profileUid:player.uid,ttlHours:2},
  });
  const skin=skinPng();
  const profile=await call(app.public,'/api/profile',{cookie:guest.cookie,host:origin,
    body:{nickname:'Transferred Pony',skin:skin.toString('base64')}});
  const action=(body)=>call(app.public,'/api/action',{cookie:guest.cookie,host:origin,body});
  await action({type:'inventory_give',requestId:'transfer-inventory',key:'legacy:1:0',slot:4,count:12});
  const placed=await action({type:'place',requestId:'transfer-placement',x:10,y:1,z:8,
    cell:'legacy:1:0',creative:true,expectedRevision:0,against:{x:10,y:0,z:8},hit:{x:10.5,y:1,z:8.5}});
  await call(app.owner,'/api/weather',{cookie:owner.cookie,body:{mode:'rain'}});

  const state=join(source,'state');
  await writeFile(join(state,'npc-admin.key'),ownerKey+'\n');
  lease=await acquireInstance(source);
  assert.equal(lease.primary,true);
  lease.publish({mode:'local',url:app.owner+'/'});
  await assert.rejects(transfer('export',source,snapshot),/Close the Lilium Moonlight server/);
  await app.close();
  app=null;
  await lease.close();
  lease=null;
  await backupState(join(state,databaseName),join(state,'backups','history.sqlite'));
  const logs={
    'chat-logs/2025-01-01.log':'Synthetic chat row\n',
    'load-logs/2025-01-01.jsonl':'{"test":true}\n',
  };
  for (const [file,value] of Object.entries(logs)) {
    await mkdir(dirname(join(state,file)),{recursive:true});
    await writeFile(join(state,file),value);
  }
  await transfer('export',source,snapshot);
  const manifest=JSON.parse(await readFile(join(snapshot,'snapshot.json'),'utf8'));
  assert.ok(manifest.files['backups/history.sqlite']);
  const affectedLog='chat-logs/2025-01-01.log';
  await writeFile(join(snapshot,affectedLog),'Tampered snapshot file\n');
  await assert.rejects(transfer('import',destination,snapshot),/Snapshot file failed verification/);
  await assert.rejects(stat(join(destination,'state')),{code:'ENOENT'});
  await writeFile(join(snapshot,affectedLog),logs[affectedLog]);
  await transfer('import',destination,snapshot);
  assert.equal(await readFile(join(destination,'state','npc-admin.key'),'utf8'),ownerKey+'\n');
  for (const [file,value] of Object.entries(logs)) {
    assert.equal(await readFile(join(destination,'state',file),'utf8'),value);
  }
  const wrongWorld=join(root,'wrong-map');
  await layout(wrongWorld,[7.5,1,8.5]);
  await assert.rejects(transfer('import',wrongWorld,snapshot),/different generated world/);
  await assert.rejects(transfer('import',destination,snapshot),/Destination already exists/);

  app=await start(destination);
  const resumed=await call(app.public,'/api/session',{cookie:guest.cookie,host:origin,body:{}});
  assert.equal(resumed.cookie,undefined);
  assert.deepEqual(resumed.json.access,player);
  assert.equal(resumed.json.profile.nickname,'Transferred Pony');
  assert.equal(resumed.json.profile.skin,profile.json.skin);
  assert.equal(resumed.json.inventory.slots[4].count,12);
  const uploaded=await fetch(app.public+profile.json.skin,{headers:{Cookie:guest.cookie}});
  assert.equal(uploaded.status,200);
  assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()),skin);
  const world=await call(app.public,'/api/world',{cookie:guest.cookie});
  assert.ok(world.json.overrides.some(change=>change.x===10&&change.y===1&&change.z===8&&
    change.cell==='legacy:1:0'&&change.revision===placed.json.worldRevision));
  assert.equal((await call(app.public,'/api/weather',{cookie:guest.cookie})).json.mode,'rain');
  const restored=await call(app.owner,'/api/access',{cookie:owner.cookie});
  assert.equal(restored.json.uid,owner.json.access.uid);
  assert.equal(restored.json.owner,true);
  assert.equal(restored.json.role,'admin');
  const listing=await call(app.owner,'/api/admin/access',{cookie:owner.cookie});
  assert.equal(listing.json.invites.find(item=>item.id===pending.json.invite.id).status,'active');
  const adopted=await call(app.public,'/api/session',{host:origin,body:{invite:pending.json.code}});
  assert.equal(adopted.json.access.uid,player.uid);
  assert.notEqual(adopted.json.access.deviceId,player.deviceId);
  assert.equal((await call(app.public,'/api/session',{host:origin,expected:409,
    body:{invite:pending.json.code}})).json.error,'invite_used');
});
