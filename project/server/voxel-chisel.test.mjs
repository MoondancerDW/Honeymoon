import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import * as geometry from '../world/geometry.mjs';
import {decodeVoxels, voxelIndex, voxelKey, voxelMaterialAt} from '../world/voxel-chisel.mjs';
import {createHoneymoonServer} from './index.mjs';

const stone = 'legacy:1:0', planks = 'legacy:5:0';
const bounds = {minX:0,maxX:15,minY:0,maxY:15,minZ:0,maxZ:15};
const spawn = [8.3125,1,8.3125];
const cube = {x:8,y:1,z:10};
const small = {x:9,y:1,z:10};
const top = {x:8.3125,y:2,z:10.3125};
const target = voxelIndex(2,7,2);
const smallTarget = voxelIndex(2,0,2);
const smallBottom = {x:9.3125,y:1,z:10.3125};

function fixture(hash = 'chisel-v1', fillEdits = false) {
  return {
    manifest: {bounds, spawn, compositions:{}}, hash,
    catalog: new Set([stone, planks, 'legacy:20:0']),
    inBounds: (x,y,z) => [x,y,z].every(value => value >= 0 && value < 16),
    getCell(x, y, z) {
      const solid = y === 0 || y === 1 && (x === 10 && z === 10 || fillEdits && x === 8 && z === 10);
      return {key: solid ? stone : 'air', object:null};
    },
  };
}

function command(type, requestId, cell, expectedRevision, extra) {
  return {type, requestId, ...cell, expectedRevision, ...extra};
}

test('voxel edits preserve ownership, material, revision and exact hit through save migration and reload', async t => {
  const work = fileURLToPath(new URL('../work/', import.meta.url));
  mkdirSync(work, {recursive:true});
  const directory = mkdtempSync(join(work, 'test-voxel-chisel-'));
  const state = join(directory, 'world.sqlite');
  let app, url;
  let now = 0;
  t.after(async () => {
    await app?.close();
    rmSync(directory, {recursive:true,force:true});
  });
  async function restart(base = fixture()) {
    await app?.close();
    app = createHoneymoonServer({base, geometry, state, clock:() => now});
    app.server.listen(0,'127.0.0.1');
    await once(app.server,'listening');
    url = `http://127.0.0.1:${app.server.address().port}/api/`;
  }
  async function request(path, payload, cookie) {
    const response = await fetch(url + path, {method:payload === undefined ? 'GET' : 'POST',
      headers:{'Content-Type':'application/json', ...(cookie && {Cookie:cookie})},
      body:payload === undefined ? undefined : JSON.stringify(payload)});
    return {status:response.status, body:await response.json(), cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  const edit = (cookie, data) => request('action', data, cookie);
  await restart();
  const a = (await request('session', {})).cookie;
  const b = (await request('session', {})).cookie;
  const ordinary = await edit(a, command('place','place-parent-block',cube,0, {
    cell:stone, against:{...cube,y:0}, hit:{...top,y:1},
  }));
  assert.equal(ordinary.status,200);

  await app.close();
  app = null;
  const old = new DatabaseSync(state);
  old.exec('ALTER TABLE edits DROP COLUMN voxels; PRAGMA user_version=4');
  old.close();
  await restart();
  const upgraded = new DatabaseSync(state,{readOnly:true});
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version,6);
  upgraded.close();

  const parentRevision = ordinary.body.worldRevision;
  const carve = command('remove_voxel','carve-parent-block',cube,parentRevision,{voxel:target,hit:top});
  assert.equal((await edit(a,{...carve,x:10,expectedRevision:0,requestId:'protect-original'})).body.error,'voxel_not_owned');
  assert.equal((await edit(b,carve)).body.error,'voxel_not_owned');
  assert.equal((await edit(a,{...carve,voxel:target+1,requestId:'protect-hidden-subcell'})).body.error,'outside_reach');
  const carved = await edit(a,carve);
  assert.equal(carved.status,200,JSON.stringify(carved.body));
  assert.deepEqual(await edit(a,carve),carved);
  const first = carved.body.changes[0];
  assert.equal(first.cell,voxelKey);
  assert.equal(voxelMaterialAt(first.voxels,target),null);
  assert.equal(decodeVoxels(first.voxels).filter(Boolean).length,511);
  assert.equal((await edit(a,command('remove','protect-whole-sculpture',cube,first.revision))).body.error,'voxel_required');
  const stale = await edit(a,{...carve,requestId:'catch-stale-carve'});
  assert.equal(stale.body.error,'stale_cell');
  assert.deepEqual(stale.body.current,first);

  const fill = command('place_voxel','fill-carved-cube',cube,first.revision,{
    material:planks,against:cube,voxel:target,hit:{x:top.x,y:1.98,z:10.375},
  });
  assert.equal((await edit(a,{...fill,requestId:'reject-wrong-placement',voxel:target-1})).body.error,'outside_reach');
  assert.equal((await edit(b,fill)).body.error,'voxel_not_owned');
  const filled = await edit(a,fill);
  assert.equal(filled.status,200,JSON.stringify(filled.body));
  assert.equal(voxelMaterialAt(filled.body.changes[0].voxels,target),planks);
  assert.deepEqual(filled.body.effects[0].voxelMaterial,planks);
  const copied = await edit(b,command('copy_voxel','copy-sculpt-material',cube,filled.body.worldRevision,{voxel:target,hit:top}));
  assert.equal(copied.body.material,planks);

  await restart();
  const snapshot = await request('world',undefined,a);
  assert.deepEqual(snapshot.body.overrides.find(cell => cell.x === cube.x && cell.z === cube.z),filled.body.changes[0]);
  const updated = {...carve,expectedRevision:filled.body.worldRevision,requestId:'owned-after-restart'};
  assert.equal((await edit(b,updated)).body.error,'voxel_not_owned');
  assert.equal((await edit(a,updated)).status,200);

  const putSmall = command('place_voxel','place-small-piece',small,0,{
    material:planks,against:{...small,y:0},voxel:smallTarget,hit:smallBottom,
  });
  const firstPosition = await request('position',{x:9.3125,y:1,z:9.3125},b);
  assert.equal(firstPosition.status,200);
  now += 250;
  assert.equal((await request('position',{x:9.3125,y:1,z:10.3125},b)).status,200);
  assert.equal((await edit(a,{...putSmall,requestId:'avoid-occupying-player'})).body.error,'occupied');
  await request('respawn',{},b);
  const smallPlaced = await edit(a,putSmall);
  assert.equal(smallPlaced.status,200,JSON.stringify(smallPlaced.body));
  const lastRemoved = await edit(a,command('remove_voxel','remove-last-piece',small,smallPlaced.body.worldRevision,{
    voxel:smallTarget,hit:{...smallBottom,y:1.125},
  }));
  assert.equal(lastRemoved.status,200,JSON.stringify(lastRemoved.body));
  assert.deepEqual(lastRemoved.body.changes,[{...small,cell:null,object:null,revision:lastRemoved.body.worldRevision}]);

  await restart(fixture('level-reimported',true));
  assert.equal((await request('world',undefined,a)).body.overrides.some(cell => cell.x === cube.x && cell.z === cube.z),false);
  assert.equal(app.game.conflicts.find(cell => cell.x === cube.x && cell.z === cube.z)?.reason,'original_cell_changed');
});
