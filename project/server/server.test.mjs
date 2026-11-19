import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadBase } from './base.mjs';
import { backupState } from './backup.mjs';
import { createHoneymoonServer } from './index.mjs';

const work = fileURLToPath(new URL('../work/', import.meta.url));
const stateFile = 'test.sqlite';
const fullBlock = { x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 };
const switchBox = { x0: 0.375, y0: 0, z0: 0.375, x1: 0.625, y1: 0.3, z1: 0.625 };
const geometry = {
  shapeFor: ({ key }) => key === 'air' ? [] : key === 'game:switch' ? [switchBox] : [fullBlock],
  collisionFor: ({ key }) => key === 'air' || key === 'game:switch' ? [] : [fullBlock],
};

function makeWorkspace() {
  mkdirSync(work, { recursive: true });
  return mkdtempSync(join(work, 'server-test-'));
}

function writeFixture(directory, { hash = 'original', reorder = false, block = 'legacy:1:0', buildCell = 'air', chunkPalettes = false } = {}) {
  const palette = reorder ? ['air', 'legacy:4:0', 'legacy:1:0'] : ['air', 'legacy:1:0', 'legacy:4:0'];
  palette.push('legacy:219:0');
  const manifest = {
    schemaVersion: 1, importVersion: 1, contentHash: hash,
    bounds: { minX: 0, maxX: 15, minY: 0, maxY: 15, minZ: 0, maxZ: 15 },
    spawn: [8.5, 1, 8.5], palette, chunks: [[0, 0]], compositions: {}, ...(chunkPalettes && {chunkPalettes}),
  };
  const section = Buffer.alloc(8192);
  for (let index = 0; index < 256; index++) section.writeUInt16LE(palette.indexOf('legacy:1:0'), index * 2);
  const index = 8 + 16 * 10 + 256;
  section.writeUInt16LE(palette.indexOf(block), index * 2);
  section.writeUInt16LE(palette.indexOf(buildCell), (index + 1) * 2);
  const objects = [{
    key: 'tile:8:1:10', position: [8, 1, 10], type: 'Sign',
    data: { Text1: 'visible', privateField: 'secret' },
  }];
  mkdirSync(join(directory, 'chunks'), { recursive: true });
  writeFileSync(join(directory, 'world.json'), JSON.stringify(manifest));
  writeFileSync(join(directory, 'chunks', '0.0.json'), JSON.stringify({
    x: 0, z: 0, sections: [{ y: 0, indices: section.toString('base64') }], objects, entities: [],
    ...(chunkPalettes && {palette, compositions:{}}),
  }));
  return loadBase(directory);
}

async function start(base, state, options = {}) {
  const app = createHoneymoonServer({ base, state, geometry, ...options });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  return { ...app, url: `http://127.0.0.1:${app.server.address().port}` };
}

async function request(app, path, { cookie, payload, headers } = {}) {
  const response = await fetch(`${app.url}${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { ...(cookie && { Cookie: cookie }), ...(payload !== undefined && { 'Content-Type': 'application/json' }), ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

function command(type, requestId, fields = {}) {
  return { type, requestId, x: 8, y: 1, z: 10, expectedRevision: 0, ...fields };
}

test('alpha requires the administrator key for weather, time, and player modes',async t=>{
  const directory=makeWorkspace();
  const base=writeFixture(directory);
  const key='private-test-alpha-administrator';
  const app=await start(base,':memory:',{initialMode:'game',npcAdminKey:key});
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const user=await request(app,'/api/session',{payload:{}});
  const cookie=user.cookie;
  assert.equal(user.data.gameMode.mode,'game');
  assert.equal(user.data.gameMode.health,15);
  assert.equal(user.data.gameMode.maxHealth,15);
  assert.equal((await request(app,'/api/modes',{cookie})).status,403);
  assert.equal((await request(app,'/api/weather',{cookie,payload:{mode:'rain'}})).status,403);
  assert.equal((await request(app,'/api/time',{cookie,payload:{time:'11:30'}})).status,403);
  const stream=await fetch(app.url+'/api/events?presence=1&social=1',{headers:{Cookie:cookie}});
  const reader=stream.body.getReader();
  t.after(()=>reader.cancel().catch(()=>{}));
  assert.equal((await request(app,'/api/presence',{cookie,payload:{yaw:0,pitch:0,motion:'idle'}})).status,200);
  assert.equal((await request(app,'/api/npcs/admin',{cookie,payload:{key}})).status,200);
  assert.equal((await request(app,'/api/weather',{cookie,payload:{mode:'rain'}})).status,200);
  const modes=(await request(app,'/api/modes',{cookie})).data;
  assert.equal(modes.players.length,1);
  assert.equal((await request(app,'/api/modes',{cookie,payload:{target:modes.players[0].id,mode:'creative'}})).status,200);
  const switched=(await request(app,'/api/session',{cookie,payload:{}})).data;
  assert.equal(switched.gameMode.mode,'creative');
  assert.equal(switched.gameMode.admin,true);
  assert.equal((await request(app,'/api/modes',{cookie,payload:{target:modes.players[0].id,mode:null}})).status,200);
});

test('the full city advertises and serves versioned prebuilt terrain without changing detailed chunks', async t => {
  const directory = makeWorkspace();
  t.after(() => rmSync(directory, {recursive:true, force:true}));
  const base = writeFixture(directory, {hash:'c'.repeat(64), chunkPalettes:true});
  const assetHash = 'e'.repeat(64);
  const lod = join(directory, 'lod');
  mkdirSync(lod);
  writeFileSync(join(lod,'manifest.json'), JSON.stringify({schemaVersion:1, contentHash:base.hash,
    assetHash, maxDistance:24, tileChunks:4, regions:[[-1,0]]}));
  const original = Buffer.from('HLOD for an exact binary response');
  writeFileSync(join(lod,'-1.0.bin'), original);
  writeFileSync(join(lod,'-1.0.bin.gz'), gzipSync(original));
  const app = await start(base, ':memory:', {generated:directory});
  t.after(() => app.close());
  const address = `${app.url}/generated/lod/${assetHash}/-1.0.bin`;
  const world = await request(app,'/generated/world/world.json');
  assert.deepEqual(world.data.lod, {version:1, contentHash:assetHash, maxDistance:24, tileChunks:4, regions:[[-1,0]]});
  const plain = await fetch(address,{headers:{'Accept-Encoding':'identity'}});
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('content-encoding'), null);
  assert.match(plain.headers.get('cache-control'), /immutable/);
  assert.deepEqual(Buffer.from(await plain.arrayBuffer()), original);
  const compressed = await fetch(address,{headers:{'Accept-Encoding':'gzip'}});
  assert.equal(compressed.headers.get('content-encoding'), 'gzip');
  assert.deepEqual(Buffer.from(await compressed.arrayBuffer()), original);
  const head = await fetch(address,{method:'HEAD',headers:{'Accept-Encoding':'identity'}});
  assert.equal(Number(head.headers.get('content-length')),original.length);
  assert.equal(await head.text(), '');
  assert.equal((await request(app,`/generated/lod/${base.hash}/-1.0.bin`)).status,404);
  assert.equal((await request(app,`/generated/lod/${assetHash}/1.0.bin`)).status,404);
  assert.equal((await request(app,'/generated/world/chunks/0.0.json')).status,200);
});

async function events(app, cookie) {
  const response = await fetch(`${app.url}/api/events?since=0`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  return {
    async next() {
      while (!buffered.includes('\n\n')) {
        const { value, done } = await reader.read();
        if (done) throw new Error('Event stream closed');
        buffered += decoder.decode(value, { stream: true });
      }
      const end = buffered.indexOf('\n\n');
      const frame = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      return { type: frame.match(/^event: (.+)$/m)?.[1], data: JSON.parse(frame.match(/^data: (.+)$/m)?.[1]) };
    },
    close: () => reader.cancel(),
  };
}

test('two guests edit one cell and receive the same durable changes after conflicts and retry', { timeout: 30000 }, async t => {
  const directory = makeWorkspace();
  const base = writeFixture(join(directory, 'world'));
  const state = join(directory, stateFile);
  let app = await start(base, state, { allowRemoval: true });
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const first = await request(app, '/api/session', { payload: {} });
  const second = await request(app, '/api/session', { payload: {} });
  assert.notEqual(first.data.playerId, second.data.playerId);
  assert.equal((await request(app, '/api/action', { payload: command('remove', 'no-session') })).status, 401);
  assert.equal((await request(app, '/api/session', { payload: {}, headers: { Origin: 'https://example.test' } })).status, 403);
  const [a, b] = await Promise.all([events(app, first.cookie), events(app, second.cookie)]);
  t.after(() => Promise.all([a.close(), b.close()]));
  assert.equal((await a.next()).type, 'ready');
  assert.equal((await b.next()).type, 'ready');

  const copied = await request(app, '/api/action', { cookie: first.cookie, payload: command('copy', 'copy-tile') });
  assert.equal(copied.data.cell, 'legacy:1:0');
  const duplicateRemove = command('remove', 'same-removal');
  const racing = await Promise.all([first.cookie, second.cookie].map(cookie => request(app, '/api/action', { cookie, payload: duplicateRemove })));
  assert.deepEqual(racing.map(response => response.status).sort(), [200, 409]);
  const winner = racing.find(response => response.status === 200).data;
  assert.equal(racing.find(response => response.status === 409).data.error, 'stale_cell');
  assert.equal(winner.changes[0].cell, null);
  assert.equal(winner.worldRevision, 1);
  assert.deepEqual(winner.effects, [{type:'break',sound:'block.break',cell:'legacy:1:0',position:[8,1,10]}]);
  const commits = await Promise.all([a.next(),b.next()]);
  for (const [index,commit] of commits.entries()) {
    const effects = racing[index].status === 200 ? [] : winner.effects;
    assert.deepEqual(commit, {type:'commit',data:{...winner,effects}});
  }
  const replay = await request(app, '/api/action', { cookie: first.cookie, payload: duplicateRemove });
  assert.deepEqual(replay, racing[0]);
  const wrongReplay = await request(app, '/api/action', { cookie: first.cookie, payload: { ...duplicateRemove, y: 2 } });
  assert.equal(wrongReplay.data.error, 'request_id_reused');

  const put = command('place', 'place-copy', { x: 9, cell: copied.data.cell, against: { x: 9, y: 0, z: 10 } });
  const placed = await request(app, '/api/action', { cookie: first.cookie, payload: put });
  assert.equal(placed.status, 200);
  assert.deepEqual(placed.data.changes[0].object.data, { Text1: 'visible' });
  assert.equal(placed.data.changes[0].object.key, 'tile:9:1:10');
  await a.close();
  await b.close();
  await app.close();
  app = await start(base, state);
  const renewed = await request(app, '/api/session', { cookie: first.cookie, payload: {} });
  assert.equal(renewed.data.playerId, first.data.playerId);
  const saved = await request(app, '/api/world', { cookie: first.cookie });
  assert.deepEqual(saved.data.overrides.find(cell => cell.x === 8 && cell.y === 1 && cell.z === 10), winner.changes[0]);
  assert.deepEqual(saved.data.overrides.find(cell => cell.x === 9 && cell.y === 1 && cell.z === 10), placed.data.changes[0]);
  const chunk = await request(app, '/generated/world/chunks/0.0.json');
  assert.deepEqual(chunk.data.objects[0].data, { Text1: 'visible' });

  const chunkUrl = `${app.url}/generated/world/chunks/0.0.json`;
  const identity = await fetch(chunkUrl, { method: 'HEAD', headers: { 'Accept-Encoding': 'gzip;q=0, *;q=1' } });
  const gzip = await fetch(chunkUrl, { method: 'HEAD', headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(identity.headers.get('content-encoding'), null);
  assert.equal(gzip.headers.get('content-encoding'), 'gzip');
  assert.equal(gzip.headers.get('vary'), 'Accept-Encoding');
  assert.ok(Number(gzip.headers.get('content-length')) < Number(identity.headers.get('content-length')));
  assert.equal(await gzip.text(), '');
  const compressed = await fetch(chunkUrl, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.deepEqual(await compressed.json(), chunk.data);

  const backup = join(directory, 'backup.sqlite');
  assert.ok(await backupState(state, backup));
  const savedCopy = new DatabaseSync(backup, { readOnly: true });
  try {
    assert.equal(savedCopy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(savedCopy.prepare('SELECT count(*) AS count FROM edits').get().count, 2);
  } finally {
    savedCopy.close();
  }

  const mine = command('remove', 'breaking-other-first', { x: 9, expectedRevision: placed.data.worldRevision });
  const removed = await request(app, '/api/action', { cookie: second.cookie, payload: mine });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.data.changes[0], { x: 9, y: 1, z: 10, cell: null, object: null, revision: 3 });
  assert.deepEqual(await request(app, '/api/action', { cookie: second.cookie, payload: mine }), removed);
  const newBuild = await request(app, '/api/action', { cookie: second.cookie, payload: {
    ...put, requestId: 'place-second', expectedRevision: removed.data.worldRevision,
  } });
  assert.equal(newBuild.status, 200);
  const replaced = { ...mine, requestId: 'breaking-other', expectedRevision: newBuild.data.worldRevision };
  assert.equal((await request(app, '/api/action', { cookie: first.cookie, payload: replaced })).status, 200);
});

test('the standard server lets players break and build in original-world cells', async t => {
  const directory = makeWorkspace();
  const base = writeFixture(join(directory, 'world'));
  const app = await start(base, ':memory:');
  t.after(async () => {
    await app.close();
    rmSync(directory, {recursive:true,force:true});
  });
  const {cookie} = await request(app,'/api/session',{payload:{}});
  const removed = await request(app,'/api/action',{cookie,payload:command('remove','break-original-build')});
  assert.equal(removed.status,200,JSON.stringify(removed.data));
  assert.equal(removed.data.changes[0].cell,null);
  const placed = await request(app,'/api/action',{cookie,payload:command('place','fill-original-position',{
    expectedRevision:removed.data.worldRevision,cell:'legacy:4:0',against:{x:8,y:0,z:10},
  })});
  assert.equal(placed.status,200,JSON.stringify(placed.data));
  assert.equal(placed.data.changes[0].cell,'legacy:4:0');
});

test('restricting original removal retains placed-block ownership and rejects unattributed edits', async t => {
  const directory = makeWorkspace();
  const base = writeFixture(join(directory, 'world'));
  const state = join(directory, stateFile);
  let app = await start(base, state, {allowRemoval:false});
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { cookie } = await request(app, '/api/session', { payload: {} });
  const action = (type, id, fields) => request(app, '/api/action', { cookie, payload: command(type, id, fields) });
  const original = await action('remove', 'remove-original');
  assert.deepEqual({ status: original.status, data: original.data }, { status: 403, data: { error: 'block_not_owned' } });
  const lamp = { x: 9, against: { x: 9, y: 0, z: 10 }, cell: 'legacy:219:0' };
  const placed = await action('place', 'place-owned-lamp', lamp);
  assert.equal(placed.status, 200);
  const turned = await action('interact', 'switch-owned-lamp', { x: 9, expectedRevision: placed.data.worldRevision });
  assert.equal(turned.data.changes[0].cell, 'legacy:220:0');
  assert.equal((await action('remove', 'remove-owned-lamp', { x: 9, expectedRevision: turned.data.worldRevision })).status, 200);

  const unknown = await action('place', 'place-no-proof', { ...lamp, expectedRevision: turned.data.worldRevision + 1 });
  const proven = await action('place', 'place-proven', { ...lamp, z: 9, against: { x: 9, y: 0, z: 9 } });
  const unconfirmed = await action('place', 'place-failed-proof', { ...lamp, x: 7, z: 10, against: { x: 7, y: 0, z: 10 } });
  const changed = await action('place', 'place-wrong-revision', { ...lamp, x: 8, z: 7, against: { x: 8, y: 0, z: 7 } });
  for (const result of [unknown, proven, unconfirmed, changed]) assert.equal(result.status, 200);
  await app.close();
  const legacy = new DatabaseSync(state);
  legacy.exec('ALTER TABLE edits DROP COLUMN fluid; ALTER TABLE edits DROP COLUMN voxels; ALTER TABLE edits DROP COLUMN micro_parts; ALTER TABLE edits DROP COLUMN placed_by; PRAGMA user_version=2');
  legacy.exec(`DELETE FROM receipts WHERE id='place-no-proof';
    UPDATE receipts SET status=409 WHERE id='place-failed-proof';
    UPDATE receipts SET output=json_set(output, '$.changes[0].revision', 0) WHERE id='place-wrong-revision';`);
  legacy.close();
  app = await start(base, state, {allowRemoval:false});
  for (const [suffix, result] of [['no-receipt', unknown], ['unsuccessful', unconfirmed], ['wrong-revision', changed]]) {
    const { x, y, z, revision: expectedRevision } = result.data.changes[0];
    const denied = await action('remove', 'remove-' + suffix, { x, y, z, expectedRevision });
    assert.deepEqual({ status: denied.status, data: denied.data }, { status: 403, data: { error: 'block_not_owned' } });
  }
  assert.equal((await action('remove', 'remove-proven', { x: 9, z: 9, expectedRevision: proven.data.worldRevision })).status, 200);
});

test('an imported block wins over an owned placement when rebasing the map', async t => {
  for (const removed of [false, true]) await t.test(removed ? 'removed placement' : 'current placement', async t => {
    const directory = makeWorkspace();
    const base = writeFixture(join(directory, 'world'));
    const state = join(directory, stateFile);
    let app = await start(base, state);
    t.after(async () => {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const { cookie } = await request(app, '/api/session', { payload: {} });
    const placed = await request(app, '/api/action', { cookie,
      payload: command('place', 'place-occupied-base', { x: 9, cell: 'legacy:1:0', against: { x: 9, y: 0, z: 10 } }) });
    assert.equal(placed.status, 200);
    if (removed) {
      const payload = command('remove', 'remove-before-rebase', { x: 9, expectedRevision: placed.data.worldRevision });
      assert.equal((await request(app, '/api/action', { cookie, payload })).status, 200);
    }
    await app.close();
    const changed = writeFixture(join(directory, 'world'), { hash: 'build-cell-original', buildCell: 'legacy:4:0' });
    app = await start(changed, state, {allowRemoval:false});
    const snapshot = (await request(app, '/api/world', { cookie })).data;
    assert.equal(snapshot.overrides.some(({ x, y, z }) => x === 9 && y === 1 && z === 10), false);
    const denied = await request(app, '/api/action', { cookie, payload: command('remove', 'remove-rebased', { x: 9 }) });
    assert.equal(denied.data.error, 'block_not_owned');
  });
});

test('switch and zone survive process death after commit, save upgrade and base catalog reorder', { timeout: 30000 }, async t => {
  const directory = makeWorkspace();
  const base = writeFixture(join(directory, 'world'));
  const state = join(directory, stateFile);
  const module = new URL('./index.mjs', import.meta.url).href;
  const loader = new URL('./base.mjs', import.meta.url).href;
  const childSource = `
    import { createHoneymoonServer } from ${JSON.stringify(module)};
    import { loadBase } from ${JSON.stringify(loader)};
    const fullBlock = ${JSON.stringify(fullBlock)};
    const switchBox = ${JSON.stringify(switchBox)};
    const geometry = { shapeFor: ${geometry.shapeFor}, collisionFor: ${geometry.collisionFor} };
    const app = createHoneymoonServer({ base: loadBase(process.argv[1]), state: process.argv[2], geometry,
      afterCommit(request, response, output) { if (output.changes.length === 3) process.kill(process.pid, 'SIGKILL'); },
    });
    app.server.listen(0, '127.0.0.1', () => console.log(app.server.address().port));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource, join(directory, 'world'), state], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let app;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await app?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const [port] = await once(child.stdout, 'data');
  const childApp = { url: `http://127.0.0.1:${String(port).trim()}` };
  const session = await request(childApp, '/api/session', { payload: {} });
  const { cookie } = session;
  const [x, y, z] = session.data.mechanics.switch;
  const flip = command('interact', 'flip-switch', { x, y, z });
  const exit = once(child, 'exit');
  await assert.rejects(async () => {
    const result = await request(childApp, '/api/action', { cookie, payload: flip });
    assert.fail(JSON.stringify(result));
  }, error => {
    if (error.code === 'ERR_ASSERTION') throw error;
    return true;
  });
  await exit;

  let now = 0;
  app = await start(base, state, { clock: () => now, allowRemoval: true });
  const replayed = await request(app, '/api/action', { cookie, payload: flip });
  assert.equal(replayed.status, 200);
  assert.equal(replayed.data.worldRevision, 1);
  assert.equal(replayed.data.changes.length, 3);
  assert.equal(replayed.data.effects[0].open, true);
  assert.equal((await request(app, '/api/world', { cookie })).data.mechanics.doorOpen, true);
  const stale = await request(app, '/api/action', { cookie, payload: { ...flip, requestId: 'stale-switch' } });
  assert.equal(stale.data.error, 'stale_cell');

  const halfway = { x: (8.5 + x + 0.5) / 2, y, z: (8.5 + z + 0.5) / 2 };
  await request(app, '/api/session', { cookie, payload: {} });
  now += 500;
  assert.equal((await request(app, '/api/position', { cookie, payload: halfway })).status, 200);
  now += 500;
  const inZone = { x: x + 0.5, y, z: z + 0.5 };
  assert.equal((await request(app, '/api/position', { cookie, payload: inZone })).data.effects[0].type, 'flag');
  assert.equal((await request(app, '/api/position', { cookie, payload: inZone })).data.effects.length, 0);
  const far = await request(app, '/api/position', { cookie, payload: { x: 1.5, y: 1, z: 1.5 } });
  assert.equal(far.data.error, 'movement_blocked');
  await request(app, '/api/respawn', { cookie, payload: {} });
  const removal = await request(app, '/api/action', { cookie, payload: command('remove', 'before-rebase') });
  assert.equal(removal.data.changes[0].cell, null);
  await app.close();

  const old = new DatabaseSync(state);
  old.exec('ALTER TABLE edits DROP COLUMN fluid; ALTER TABLE edits DROP COLUMN voxels; ALTER TABLE edits DROP COLUMN micro_parts; ALTER TABLE edits DROP COLUMN placed_by; ALTER TABLE edits DROP COLUMN quarantined; ALTER TABLE edits DROP COLUMN original; DROP TABLE rebase_conflicts; PRAGMA user_version=1');
  old.close();
  app = await start(base, state);
  let snapshot = (await request(app, '/api/world', { cookie })).data;
  assert.equal(snapshot.mechanics.visited, true);
  assert.equal(snapshot.mechanics.doorOpen, true);
  assert.equal(snapshot.overrides.find(cell => cell.x === 8 && cell.y === 1 && cell.z === 10).cell, null);
  await app.close();

  const reordered = writeFixture(join(directory, 'world'), { hash: 'reordered', reorder: true });
  app = await start(reordered, state);
  snapshot = (await request(app, '/api/world', { cookie })).data;
  assert.equal(snapshot.overrides.find(cell => cell.x === 8 && cell.y === 1 && cell.z === 10).cell, null);
  await app.close();

  const changedBase = writeFixture(join(directory, 'world'), { hash: 'changed', block: 'legacy:4:0' });
  app = await start(changedBase, state);
  assert.deepEqual(app.game.conflicts.map(conflict => conflict.reason), ['original_cell_changed']);
  const rebased = (await request(app, '/api/world', { cookie })).data;
  assert.equal(rebased.overrides.find(cell => cell.x === 8 && cell.y === 1 && cell.z === 10).cell, null);
});
