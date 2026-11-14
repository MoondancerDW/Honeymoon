import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { createHoneymoonServer } from './index.mjs';
import { profileChanges } from './presence-profile.mjs';
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

test('skins accept four layouts and discard private PNG metadata with bounded decompression', async () => {
  for (const [width, height] of [[64,32], [64,64], [128,64], [256,128]]) {
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
  server.update('b', {...point, z:9}, readPose({yaw:.25, pitch:0, motion:'walk', seq:3}));
  server.update('b', {...point, z:9.5}, readPose({yaw:.5, pitch:0, motion:'idle', seq:2}));
  server.flush();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].listener, 'a');
  assert.equal(messages[0].name, 'presence-motion');
  const changed = messages[0].data.players[0];
  assert.equal(changed.position.z, 9.5);
  assert.equal(changed.yaw,.25);
  assert.equal(changed.motion,'walk');
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

async function eventFeed(url, cookie, signal) {
  const response = await fetch(url + '/api/events?since=0&presence=1', {headers:{Cookie:cookie}, signal});
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  return {
    async next(name) {
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
          return {revision:/^id: (.+)$/m.exec(frame)?.[1], data:JSON.parse(/^data: (.+)$/m.exec(frame)[1])};
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
  const chosen = await post('profile',{nickname:' Лунный Ветер ',skin:skin().toString('base64')}, b.cookie);
  assert.equal(chosen.status,200);
  assert.equal(chosen.data.nickname,'Лунный Ветер');
  assert.match(chosen.data.skin, /^\/skins\/[a-f0-9]{64}\.png$/);
  const image = await fetch(url + chosen.data.skin);
  assert.equal(image.status,200);
  assert.equal(image.headers.get('Content-Type'),'image/png');
  assert.match(image.headers.get('Cache-Control'),/immutable/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()),skin());
  const options = {yaw:0, pitch:0, motion:'idle'};
  const signal = AbortSignal.timeout(12000);
  const [observer, observed] = await Promise.all([eventFeed(url,a.cookie,signal), eventFeed(url,b.cookie,signal)]);
  assert.equal((await observer.next('ready')).revision, '0');
  assert.deepEqual(await observer.next('presence'), {data:{players:[]}, revision:undefined});
  const joined = await post('presence',{...options,x:25,y:25,z:25},b.cookie);
  assert.equal(joined.status,200);
  const entered = await observer.next('presence');
  assert.deepEqual(entered, {revision:undefined,data:{players:[{...chosen.data,position:point,...options}]}});
  assert.equal((await post('position',{...point,x:100,pose:{...options,motion:'fly'}},b.cookie)).status,409);
  assert.equal((await post('position',{...point,z:8.75,pose:{...options,motion:'walk'}},b.cookie)).status,200);
  const moved = await observer.next('presence-motion');
  assert.deepEqual(moved, {revision:undefined,data:{players:[{id:chosen.data.id,position:{...point,z:8.75},...options,motion:'walk'}]}});
  await observed.close();
  assert.deepEqual((await observer.next('presence')).data.players, []);
  await observer.close();
  await app.close();
  app = undefined;
  await start();
  const reloaded = await post('session',{},b.cookie);
  assert.deepEqual(reloaded.data.profile,chosen.data);
  assert.equal((await post('profile',{skin:null},b.cookie)).data.skin,null);
  assert.equal((await fetch(url + chosen.data.skin)).status,404);
});

function resolveTestPath(directory) {
  return directory.startsWith(join(work, 'presence-test-')) ? directory : undefined;
}
