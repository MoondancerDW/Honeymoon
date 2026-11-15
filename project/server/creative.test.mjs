import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createHoneymoonServer} from './index.mjs';
import * as geometry from '../world/geometry.mjs';
import {creativeMicroblock} from '../world/creative-items.mjs';
import {guidedMicroblock} from '../world/microblocks.mjs';

const fixture = fileURLToPath(new URL('../work/', import.meta.url));

test('creative places registered off-map states with normal ownership, and builds real doors and beds', async t => {
  mkdirSync(fixture, {recursive:true});
  const generated = mkdtempSync(join(fixture, 'creative-test-'));
  mkdirSync(join(generated, 'creative'));
  const entries = ['4:0','64:0','26:0','4094:0','63:0','68:0'].map((id, index) => ({key:`legacy:${id}`, placeable:index !== 3}));
  const lamp = {key:'creative:768:53', blockKey:'legacy:768:0', kind:'shaped-lamp', damage:53};
  const cover = {key:'creative:750:0', blockKey:'legacy:750:0', kind:'microblock', damage:0, coverData:65536};
  entries.push(lamp, cover);
  writeFileSync(join(generated, 'creative', 'catalog.json'), JSON.stringify({schemaVersion:1, entries}));
  const base = {manifest:{spawn:[8.5,1,8.5], bounds:{minX:0,maxX:15,minY:0,maxY:15,minZ:0,maxZ:15},
    compositions:{}, palette:['air','legacy:1:0']}, hash:'creative-a', catalog:new Set(['air','legacy:1:0']),
    getCell:(x,y,z) => x === 9 && y === 1 && z === 6 ? {key:'legacy:63:0', object:null} :
      {key:y === 0 ? 'legacy:1:0' : 'air', object:null},
    inBounds:(...point) => point.every(n => n >= 0 && n < 16)};
  const state = join(generated, 'test.sqlite');
  let app;
  let url;
  const launch = async () => {
    app = createHoneymoonServer({base, state, geometry, generated});
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    url = `http://127.0.0.1:${app.server.address().port}`;
  };
  await launch();
  t.after(() => app.close());
  const post = (path, data, cookie) => fetch(url + '/api/' + path, {method:'POST',
    headers:{'Content-Type':'application/json', ...(cookie && {Cookie:cookie})}, body:JSON.stringify(data)});
  async function guest() {
    const response = await post('session', {});
    assert.equal((await response.json()).creative, true);
    return response.headers.get('set-cookie').split(';')[0];
  }
  const a = await guest(), b = await guest();
  const response = await fetch(url + '/generated/creative/catalog.json');
  assert.deepEqual((await response.json()).entries, entries);
  let seq = 0;
  async function command(cookie, type, point, fields) {
    const [x,y,z] = point;
    const response = await post('action', {type,x,y,z,expectedRevision:0, requestId:`creative-${++seq}`, ...fields}, cookie);
    return {status:response.status, body:await response.json()};
  }
  const place = (x,z,cell, fields) => command(a, 'place', [x,1,z], {cell, creative:true, against:{x,y:0,z},
    hit:{x:x+.5,y:1,z:z+.5}, ...fields});
  assert.equal((await place(6,7,'legacy:4094:0')).status, 400);
  const cube = await place(6,7,'legacy:4:0');
  assert.equal(cube.status, 200, JSON.stringify(cube));
  const revision = cube.body.worldRevision;
  const foreign = await command(b,'remove',[6,1,7],{expectedRevision:revision});
  assert.equal(foreign.status,200,JSON.stringify(foreign));
  const door = await place(7,8,'legacy:64:0');
  assert.deepEqual(door.body.changes?.map(change => change.cell), ['legacy:64:0','legacy:64:8'], JSON.stringify(door));
  const open = await command(a,'interact',[7,1,8],{expectedRevision:door.body.worldRevision});
  assert.equal(open.body.changes?.[0].cell,'legacy:64:4',JSON.stringify(open));
  const remove = await command(b,'remove',[7,2,8],{expectedRevision:open.body.worldRevision});
  assert.deepEqual(remove.body.changes?.map(change => change.cell),[null,null], JSON.stringify(remove));
  const bed = await place(10,8,'legacy:26:0');
  assert.deepEqual(bed.body.changes?.map(change => [change.z, change.cell]), [[8,'legacy:26:0'],[9,'legacy:26:8']], JSON.stringify(bed));
  const placedLamp = await place(8,10,lamp.blockKey, {creativeItem:lamp.key});
  assert.deepEqual(placedLamp.body.changes?.[0].object.data, {style:1,color:5,ps:2,rot:0}, JSON.stringify(placedLamp));
  const part = creativeMicroblock(cover);
  const hit = {x:8.5,y:1,z:6.5};
  const proposal = guidedMicroblock({x:8,y:0,z:6,hit,offset:[0,1,0]}, part, part.pattern, 0);
  proposal.part.slot = 29;
  const placedCover = await command(a,'place_part',[proposal.x,proposal.y,proposal.z],
    {against:proposal.against, hit, part:proposal.part, orientation:0,creativeItem:cover.key});
  assert.deepEqual(placedCover.body.changes?.[0].parts,[proposal.part],JSON.stringify(placedCover));
  const standing = await place(8,7,'legacy:63:0',{yaw:Math.PI / 2});
  assert.equal(standing.body.changes?.[0].cell,'legacy:63:12',JSON.stringify(standing));
  assert.equal(standing.body.changes?.[0].object.type,'Sign');
  const lines = ['Понивилль','К замку →','',''];
  const first = {lines, expectedRevision:standing.body.worldRevision};
  const invalid = await command(a,'edit_sign',[8,1,7],{...first, lines:['one']});
  assert.equal(invalid.body.error,'invalid_sign_text');
  const write = await command(a,'edit_sign',[8,1,7],first);
  const written = write.body.changes?.[0];
  assert.deepEqual(geometry.signFor({...written, key:written?.cell})?.lines,lines,JSON.stringify(write));
  const stale = await command(b,'edit_sign',[8,1,7],first);
  assert.equal(stale.body.error,'stale_cell');
  const rewrite = await command(b,'edit_sign',[8,1,7],{lines:['Тихая улица','','',''], expectedRevision:write.body.worldRevision});
  assert.equal(rewrite.status,200,JSON.stringify(rewrite));
  assert.equal((await command(a,'edit_sign',[9,1,6],{lines})).body.error,'protected_cell');
  const support = await place(9,7,'legacy:4:0');
  assert.equal(support.status,200,JSON.stringify(support));
  const wall = await command(a,'place',[9,1,8],{cell:'legacy:68:0', creative:true,
    against:{x:9,y:1,z:7}, hit:{x:9.125,y:1.5,z:8}});
  assert.equal(wall.body.changes?.[0].cell,'legacy:68:3',JSON.stringify(wall));
  assert.equal(wall.body.changes?.[0].object.type,'Sign');
  await app.close();
  base.hash = 'creative-b';
  await launch();
  const world = await fetch(url + '/api/world',{headers:{Cookie:a}}).then(r=>r.json());
  assert.equal(world.overrides.find(change => change.x === 6 && change.z === 7)?.cell, null);
  assert.equal(world.overrides.find(change => change.x === 10 && change.z === 9)?.cell, 'legacy:26:8');
  assert.equal(world.overrides.find(change => change.x === 8 && change.z === 10)?.object.data.style, 1);
  assert.equal(world.overrides.find(change => change.x === 8 && change.z === 7)?.object.data.Text1,'Тихая улица');
  assert.equal(world.overrides.find(change => change.x === 9 && change.z === 8)?.cell,'legacy:68:3');
});
