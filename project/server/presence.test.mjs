import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { createHoneymoonServer } from './index.mjs';
import { profileChanges, savedSkinSize, savedSkinTraits } from './presence-profile.mjs';
import { createPresence, readPose } from './presence.mjs';

const work = fileURLToPath(new URL('../work/', import.meta.url));
const signature = Buffer.from('89504e470d0a1a0a', 'hex');
const point = {x:8.5, y:1, z:8.5};

function chunk(type, data) {
  const bytes = Buffer.alloc(12 + data.length);
  bytes.writeUInt32BE(data.length, 0);
  bytes.write(type, 4);
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}

function skin(width = 64, height = 32, { text, pixels, trailingBytes } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const imageData = deflateSync(pixels ?? Buffer.alloc((1 + width * 4) * height));
  return Buffer.concat([signature, chunk('IHDR', header), ...(text ? [chunk('tEXt', Buffer.from(text))] : []),
    chunk('IDAT', trailingBytes ? Buffer.concat([imageData, trailingBytes]) : imageData), chunk('IEND', Buffer.alloc(0))]);
}

function markedSkin(red,green,blue,alpha = 255) {
  const pixels = Buffer.alloc((1 + 64 * 4) * 32);
  pixels.set([red,green,blue,alpha],13);
  return skin(64,32,{pixels});
}

test('server reads the exact size marker for new and previously saved skin pixels', async () => {
  for (const [rgba,size] of [[[255,190,83],'small'],[[206,50,84],'large'],[[42,60,120],'tall'],[[255,190,83,254],'normal']]) {
    const png = markedSkin(...rgba);
    const uploaded = await profileChanges({skin:png.toString('base64')});
    assert.equal(uploaded.skin.size,size);
    assert.equal(savedSkinSize(uploaded.skin.png),size);
  }
  const header = Buffer.from(skin().subarray(16,29));
  header[8] = 2;
  header[9] = 3;
  const pixels = Buffer.alloc(17 * 32);
  pixels[1] = 1; // Palette index 1 at the fourth 2-bit pixel.
  const indexed = Buffer.concat([signature, chunk('IHDR',header),
    chunk('PLTE',Buffer.from([0,0,0,255,190,83])), chunk('IDAT',deflateSync(pixels)), chunk('IEND',Buffer.alloc(0))]);
  assert.equal((await profileChanges({skin:indexed.toString('base64')})).skin.size,'small');
  assert.equal(savedSkinSize(indexed),'small');
});

test('server uses the opaque renderer species marker for new and saved skins', async () => {
  for (const [rgba,ponyType] of [
    [[136,202,240,255],'pegasus'],[[254,249,252,255],'alicorn'],[[40,43,41,255],'alicorn'],
    [[209,159,228,255],'unicorn'],[[136,202,240,254],'earth'],[[0,0,0,0],'earth'],
  ]) {
    const pixels=Buffer.alloc((1+64*4)*32);
    pixels.set(rgba,1);
    const png=skin(64,32,{pixels});
    const uploaded=(await profileChanges({skin:png.toString('base64')})).skin;
    assert.equal(uploaded.ponyType,ponyType);
    assert.deepEqual(savedSkinTraits(uploaded.png),{size:'normal',ponyType});
  }
  const header=Buffer.from(skin().subarray(16,29));
  header[12]=1;
  const passes=[[8,4],[8,4],[16,4],[16,8],[32,8],[32,16],[64,16]];
  const lengths=passes.map(([width,rows])=>(1+width*4)*rows);
  const interlaced=Buffer.alloc(lengths.reduce((total,length)=>total+length,0));
  interlaced.set([136,202,240,255],1);
  interlaced.set([255,190,83,255],lengths.slice(0,5).reduce((total,length)=>total+length,0)+5);
  const png=Buffer.concat([signature,chunk('IHDR',header),chunk('IDAT',deflateSync(interlaced)),chunk('IEND',Buffer.alloc(0))]);
  assert.deepEqual(savedSkinTraits(png),{size:'small',ponyType:'pegasus'});
});

test('skins accept supported layouts and discard private PNG metadata with bounded decompression', async () => {
  for (const [width, height] of [[64,32], [64,64], [128,64], [256,128], [512,256]]) {
    const encoded = skin(width, height, {text:'Author\0Not part of the skin'});
    const result = await profileChanges({skin:encoded.toString('base64')});
    assert.deepEqual(result.skin.png, skin(width, height));
  }
  const wrongSize = skin(16, 16).toString('base64');
  await assert.rejects(profileChanges({skin:wrongSize}), {code:'invalid_skin_size'});
  const badCRC = skin();
  badCRC[badCRC.length - 1] ^= 1;
  await assert.rejects(profileChanges({skin:badCRC.toString('base64')}), {code:'invalid_skin'});
  const zipBomb = skin(64, 32, {pixels:Buffer.alloc(400 * 1024)}).toString('base64');
  await assert.rejects(profileChanges({skin:zipBomb}), {code:'invalid_skin'});
  await assert.rejects(profileChanges({skin:'data:image/svg+xml;base64,ABC='}), {code:'invalid_skin'});
  const badFilter = skin(64, 32, {pixels:Buffer.alloc((1 + 64 * 4) * 32, 6)}).toString('base64');
  await assert.rejects(profileChanges({skin:badFilter}), {code:'invalid_skin'});
  const trailingData = skin(64, 32, {trailingBytes:Buffer.from('unused')}).toString('base64');
  await assert.rejects(profileChanges({skin:trailingData}), {code:'invalid_skin'});
  await assert.rejects(profileChanges({nickname:' _- '}), {code:'invalid_nickname'});
  assert.equal((await profileChanges({nickname:'  Искра\u0301  '})).nickname, 'Искра\u0301');
});

test('a legacy editor can append text after IEND without sharing it', async () => {
  const png = skin(256, 128);
  const text = chunk('tEXt', Buffer.from('Author\0Private'));
  text[text.length - 1] ^= 1;
  const result = await profileChanges({skin:Buffer.concat([png, text]).toString('base64')});
  assert.deepEqual(result.skin.png, png);
  await assert.rejects(profileChanges({skin:Buffer.concat([png, png]).toString('base64')}), {code:'invalid_skin'});
  await assert.rejects(profileChanges({skin:Buffer.concat([png, text.subarray(0, -1)]).toString('base64')}), {code:'invalid_skin'});
});

test('presence batches updates and drops expired connections while preserving a short reconnect', () => {
  let time = 0;
  const messages = [];
  const server = createPresence({store:{getProfile:()=>undefined}, now:()=>time,
    send:(listener, name, data)=>messages.push({listener, name, data})});
  const a = {player:'a', response:'a'};
  const b = {player:'b', response:'b'};
  for (const stream of [a, b]) server.connect(stream, server.prepare(stream.player));
  server.join('a', point, readPose({yaw:0, pitch:0, motion:'idle', seq:1}));
  server.join('b', point, readPose({yaw:0, pitch:0, motion:'idle', seq:1}));
  server.flush();
  assert.equal(messages.at(-1).data.players.length, 1);
  messages.length = 0;
  const emote = {id:'dance',started:Date.now()};
  const held = {kind:'block',key:'cover-material:2',part:{slot:29,sourceSlot:0,shape:0,material:2,bounds:[[0,1,0,8,2,8]]}};
  server.update('b', {...point, z:9}, readPose({yaw:.25, pitch:0, motion:'walk', seq:3,emote,held}));
  server.update('b', {...point, z:9.5}, readPose({yaw:.5, pitch:0, motion:'idle', seq:2,emote:null}));
  server.flush();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].listener, 'a');
  assert.equal(messages[0].name, 'presence-motion');
  const changed = messages[0].data.players[0];
  assert.equal(changed.position.z, 9.5);
  assert.equal(changed.yaw,.25);
  assert.equal(changed.motion,'walk');
  assert.deepEqual(changed.emote,emote);
  assert.deepEqual(changed.held,held);
  assert.throws(()=>readPose({yaw:0,pitch:0,held:{...held,key:'cover-material:1'}}),{code:'invalid_pose'});
  server.disconnect(b);
  time = 1500;
  server.flush();
  assert.equal(messages.length, 1);
  server.connect(b, server.prepare(b.player));
  server.disconnect(b);
  time = 3501;
  server.flush();
  assert.deepEqual(messages.at(-1), {listener:'a', name:'presence', data:{players:[]}});
});

const air = {key:'air', object:null};
const base = {
  hash:'presence-test',
  manifest:{spawn:[point.x, point.y, point.z], bounds:{minX:0, maxX:31, minY:0, maxY:31, minZ:0, maxZ:31}, compositions:{}},
  inBounds:(x, y, z)=>[x,y,z].every(value=>value >= 0 && value < 32),
  catalog:new Set(['air']),
  getCell:()=>air,
};
const geometry = {shapeFor:()=>[], collisionFor:()=>[]};

test('avatar eye offsets keep a bounded local camera and remain optional for older clients', () => {
  assert.equal(readPose({yaw:0,pitch:0}).eye,undefined);
  assert.deepEqual(readPose({yaw:0,pitch:-1.5,eye:[.12,1.31,-.29]}).eye,[.12,1.31,-.29]);
  for (const eye of [[1,1,0],[0,3,0],[0,-1,0],[0,1,NaN],[0,1],[0,1,0,0]]) {
    assert.throws(() => readPose({yaw:0,pitch:0,eye}),{code:'invalid_pose'});
  }
});

async function eventFeed(url, cookie, signal, social = false) {
  const response = await fetch(url + '/api/events?since=0&presence=1' + (social ? '&social=1' : ''), {headers:{Cookie:cookie}, signal});
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  return {
    async next(name, accepts = () => true) {
      while (true) {
        while (!buffered.includes('\n\n')) {
          const {value,done} = await reader.read();
          if (done) throw new Error('Unexpected end of events.');
          buffered += decoder.decode(value, {stream:true});
        }
        const end = buffered.indexOf('\n\n');
        const frame = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (frame.includes('event: ' + name + '\n')) {
          const data = JSON.parse(/^data: (.+)$/m.exec(frame)[1]);
          if (accepts(data)) return {revision:/^id: (.+)$/m.exec(frame)?.[1], data};
        }
      }
    },
    close:()=>reader.cancel(),
  };
}

test('independent cookies share profiles and only confirmed movement, and retain skins after restart', {timeout:20000}, async t => {
  mkdirSync(work, {recursive:true});
  const directory = mkdtempSync(join(work, 'presence-test-'));
  const state = join(directory, 'state.sqlite');
  let app, url;
  t.after(async () => {
    await app?.close();
    const target = resolveTestPath(directory);
    if (target) rmSync(target, {recursive:true, force:true});
  });
  async function start() {
    app = createHoneymoonServer({base, geometry, state});
    app.server.listen(0,'127.0.0.1');
    await once(app.server,'listening');
    url = `http://127.0.0.1:${app.server.address().port}`;
  }
  async function post(path, body, cookie, origin = url) {
    const result = await fetch(url + '/api/' + path, {method:'POST', headers:{
      'Content-Type':'application/json', Origin:origin, ...(cookie && {Cookie:cookie}),
    }, body:JSON.stringify(body)});
    return {status:result.status, data:await result.json(), cookie:result.headers.get('Set-Cookie')?.split(';')[0]};
  }
  await start();
  const a = await post('session', {});
  const b = await post('session', {});
  assert.notEqual(a.data.profile.id, a.data.playerId);
  assert.notEqual(a.data.profile.id, b.data.profile.id);
  assert.equal((await post('profile',{nickname:'Ветер'}, undefined)).status,401);
  assert.equal((await post('profile',{nickname:'Ветер'}, b.cookie,'https://example.test')).status,403);
  const pixels = Buffer.alloc((1+64*4)*32);
  pixels.set([136,202,240,255],1);
  pixels.set([255,190,83,255],13);
  const chosenSkin = skin(64,32,{pixels});
  const chosen = await post('profile',{nickname:' Лунный Ветер ',skin:chosenSkin.toString('base64')}, b.cookie);
  assert.equal(chosen.status,200);
  assert.equal(chosen.data.nickname,'Лунный Ветер');
  assert.equal(chosen.data.nicknameChosen,true);
  assert.equal(chosen.data.size,'small');
  assert.equal(chosen.data.ponyType,'pegasus');
  const withoutMovement=({position,seat,stance,...profile})=>profile;
  const ownFields=({flight,flightAllowed,jumpCharge,magicCooldownMs,...profile})=>withoutMovement(profile);
  const avatarFields=({raceOverride,sizeOverride,raceRevision,...profile})=>ownFields(profile);
  assert.deepEqual([chosen.data.raceOverride,chosen.data.raceRevision],[null,1]);
  assert.deepEqual(chosen.data.position,point);
  assert.equal(chosen.data.stance,'stand');
  assert.equal((await post('session',{},a.cookie)).data.profile.nicknameChosen,false);
  assert.match(chosen.data.skin, /^\/skins\/[a-f0-9]{64}\.png$/);
  const image = await fetch(url + chosen.data.skin);
  assert.equal(image.status,200);
  assert.equal(image.headers.get('Content-Type'),'image/png');
  assert.match(image.headers.get('Cache-Control'),/immutable/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()),chosenSkin);
  const options = {yaw:0, pitch:0, motion:'idle'};
  const signal = AbortSignal.timeout(12000);
  const [observer, observed] = await Promise.all([eventFeed(url,a.cookie,signal,true), eventFeed(url,b.cookie,signal)]);
  assert.equal((await observer.next('ready')).revision, '0');
  assert.deepEqual(await observer.next('presence'), {data:{players:[], selfOnline:false}, revision:undefined});
  const joined = await post('presence',{...options,x:25,y:25,z:25},b.cookie);
  assert.equal(joined.status,200);
  const entered = await observer.next('presence');
  assert.deepEqual(entered, {revision:undefined,data:{players:[{...avatarFields(chosen.data),position:point,...options,stance:'stand'}],selfOnline:false}});
  assert.equal((await post('position',{...point,x:100,pose:{...options,motion:'fly'}},b.cookie)).status,409);
  assert.equal((await post('position',{...point,z:8.75,pose:{...options,motion:'walk'}},b.cookie)).status,200);
  const moved = await observer.next('presence-motion');
  assert.deepEqual(moved, {revision:undefined,data:{players:[{id:chosen.data.id,position:{...point,z:8.75},...options,motion:'walk',stance:'stand'}]}});
  const renamed = await post('profile',{nickname:'Другой ник'}, b.cookie);
  assert.equal(renamed.status,200);
  assert.deepEqual(renamed.data, {...withoutMovement(chosen.data),nickname:'Другой ник'});
  const rename = (await observer.next('chat', entry => entry.kind === 'rename')).data;
  assert.deepEqual(rename, {id:rename.id,kind:'rename',nickname:'Лунный Ветер',newNickname:'Другой ник',channel:'global'});
  assert.equal((await post('profile',{nickname:'Другой ник'}, b.cookie)).status,200);
  assert.equal((await observer.next('presence')).data.players[0].nickname,'Другой ник');
  await observed.close();
  assert.deepEqual((await observer.next('presence')).data.players, []);
  await observer.close();
  await app.close();
  app = undefined;
  await start();
  const reloaded = await post('session',{},b.cookie);
  assert.deepEqual(reloaded.data.profile,ownFields(renamed.data));
  const history = await eventFeed(url,a.cookie,signal,true);
  assert.deepEqual((await history.next('chat-history')).data.entries.filter(entry => entry.kind === 'rename'), [rename]);
  await history.close();
  const skinChanged = await post('profile',{skin:skin(64,64).toString('base64')},b.cookie);
  assert.equal(skinChanged.data.nickname,renamed.data.nickname);
  assert.notEqual(skinChanged.data.skin,chosen.data.skin);
  assert.equal(skinChanged.data.ponyType,'earth');
  assert.equal((await post('profile',{skin:null},b.cookie)).data.skin,null);
  assert.equal((await post('profile',{skin:chosenSkin.toString('base64')},b.cookie)).data.skin,chosen.data.skin);
  assert.equal((await post('profile',{skin:null},b.cookie)).data.skin,null);
  assert.equal((await fetch(url + chosen.data.skin)).status,404);
});

test('teleport validates body and playable chunks, and local chat uses confirmed three-dimensional distance', {timeout:12000}, async t => {
  const solid = {key:'legacy:1:0', object:null};
  const key = 'presence-test-owner-key';
  const app = createHoneymoonServer({state:':memory:', npcAdminKey:key, base:{
    ...base,
    getCell: (x,y,z) => x === 13 && y === 1 && z === 8 ? solid : air,
    hasPlayableChunk:(x,z) => !(x === 1 && z === 1),
  }, geometry:{
    ...geometry,
    collisionFor: ({key}) => key === solid.key ? [{x0:0, y0:0, z0:0, x1:1, y1:1, z1:1}] : [],
  }});
  t.after(() => app.close());
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const signal = AbortSignal.timeout(9000);
  async function post(method, body, cookie, forwarded = '192.0.2.1') {
    const response = await fetch(`${url}/api/${method}`, {method:'POST', headers:{
      'Content-Type':'application/json', ...(forwarded && {'X-Forwarded-For':forwarded}), ...(cookie && {Cookie:cookie}),
    }, body:JSON.stringify(body), signal});
    return {status:response.status, data:await response.json(), cookie:response.headers.get('Set-Cookie')?.split(';')[0]};
  }
  const owner = await post('access/owner',{key,profileName:'Администратор'},undefined,null);
  assert.equal(owner.status,200);
  async function player(nickname) {
    const {data:{code:invite}} = await post('admin/invites',{kind:'admin'},owner.cookie);
    const {cookie,data} = await post('session',{invite,profileName:nickname});
    assert.equal(data.profile.nickname,nickname);
    const feed = await eventFeed(url,cookie,signal,true);
    assert.equal((await post('presence',{yaw:0,pitch:0},cookie)).status,200);
    await feed.next('presence', event => event.selfOnline);
    return {cookie,feed};
  }
  const sender = await player('Отправитель');
  const near = await player('Восемнадцать');
  const far = await player('Далеко');
  assert.equal((await post('session',{},near.cookie,'203.0.113.2')).data.profile.nickname,'Восемнадцать');
  for (const [target, error] of [
    [{...point,x:'8'}, 'invalid_coordinates'],
    [{...point,x:100}, 'outside_playable_area'],
    [{...point,x:16,z:20}, 'outside_playable_area'],
    [{...point,y:31}, 'outside_playable_area'],
    [{...point,x:13.5}, 'teleport_blocked'],
  ]) assert.equal((await post('teleport',target,sender.cookie)).data.error,error);
  assert.deepEqual((await post('session',{},sender.cookie)).data.position,point);
  const edgePosition = {...point,x:26.5};
  const arrived = await post('teleport',edgePosition,near.cookie);
  assert.equal(arrived.status,200);
  assert.deepEqual(arrived.data.position,edgePosition);
  assert.equal(arrived.data.seat,null);
  assert.equal((await post('teleport',{...edgePosition,y:1.1},far.cookie)).status,200);
  const local = 'Слышно рядом';
  const global = 'Слышно везде';
  assert.equal((await post('chat',{text:local,channel:'local'},sender.cookie)).data.channel,'local');
  assert.equal((await post('chat',{text:global,channel:'global'},sender.cookie)).data.channel,'global');
  const nextMessage = feed => feed.next('chat', entry => entry.kind === 'message');
  assert.equal((await nextMessage(sender.feed)).data.text,local);
  assert.equal((await nextMessage(near.feed)).data.text,local);
  assert.equal((await nextMessage(far.feed)).data.text,global);
  assert.equal((await post('teleport',point,far.cookie)).status,200);
  assert.equal((await post('teleport',{...edgePosition,y:1.1},near.cookie)).status,200);
  await far.feed.close();
  const reconnect = await eventFeed(url,far.cookie,signal,true);
  const {data} = await reconnect.next('chat-history');
  assert.ok(data.entries.some(entry => entry.text === global));
  assert.ok(!data.entries.some(entry => entry.text === local));
  await reconnect.close();
  await near.feed.close();
  const nearReconnect = await eventFeed(url,near.cookie,signal,true);
  assert.ok((await nearReconnect.next('chat-history')).data.entries.some(entry => entry.text === local));
  const placed = await post('warps',{title:'  Площадь  ',x:30,y:10,z:30},sender.cookie);
  assert.equal(placed.status,200);
  const [warp] = placed.data.warps;
  assert.equal(warp.title,'Площадь');
  assert.deepEqual(warp.position,point);
  assert.deepEqual((await nearReconnect.next('warps')).data,placed.data);
  assert.deepEqual((await post('teleport',{warpId:warp.id},near.cookie)).data.position,point);
  assert.equal((await post('warps/remove',{id:warp.id},near.cookie)).status,200);
  assert.equal((await post('teleport',{warpId:warp.id},sender.cookie)).data.error,'warp_missing');
  const remaining = await fetch(`${url}/api/warps`,{headers:{Cookie:sender.cookie},signal}).then(response=>response.json());
  assert.deepEqual(remaining,{revision:2,warps:[]});
  await nearReconnect.close();
  await sender.feed.close();
});

function resolveTestPath(directory) {
  return directory.startsWith(join(work, 'presence-test-')) ? directory : undefined;
}
