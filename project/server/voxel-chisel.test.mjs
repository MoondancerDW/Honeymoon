import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import * as geometry from '../world/geometry.mjs';
import {decodeVoxels, voxelBrush, voxelIndex, voxelKey, voxelMaterialAt} from '../world/voxel-chisel.mjs';
import {createHoneymoonServer} from './index.mjs';
import {chiselVoxelAtHit} from '../world/chisel-surface.mjs';

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

test('copies flowing liquids off their real surface and keeps editable static eighths', async t => {
  const base = fixture();
  const read = base.getCell;
  base.getCell = (x, y, z) => {
    if (y === 1 && z === 10 && (x === 7 || x === 9)) {
      return {key:x === 7 ? 'legacy:8:4' : 'legacy:10:4', object:null};
    }
    return read(x, y, z);
  };
  const app = createHoneymoonServer({base, geometry, state:':memory:'});
  t.after(() => app.close());
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api/`;
  async function post(path, body, cookie) {
    const response = await fetch(url + path,{method:'POST',headers:{'Content-Type':'application/json',
      ...(cookie && {Cookie:cookie})},body:JSON.stringify(body)});
    return {status:response.status, body:await response.json(), cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  const a = (await post('session', {})).cookie, b = (await post('session', {})).cookie;
  let revision = 0;
  for (const [sourceX, sourceKey, material, localX] of [[7,'legacy:8:4','legacy:9:0',2], [9,'legacy:10:4','legacy:11:0',4]]) {
    const source = {x:sourceX,y:1,z:10};
    const height = geometry.shapeFor(sourceKey)[0].y1;
    const hit = {x:sourceX + .5,y:source.y + height,z:10.5};
    const voxel = chiselVoxelAtHit(source, hit, [0,1,0], undefined, sourceKey);
    const sample = command('copy_voxel', `copy-flow-${sourceX}`, source, 0, {voxel, hit});
    assert.equal((await post('action', {...sample,requestId:`wrong-surface-${sourceX}`,hit:{...hit,y:2}}, a)).status,403);
    const copied = await post('action', sample, a);
    assert.equal(copied.status,200,JSON.stringify(copied));
    assert.equal(copied.body.material,material);
    const placed = await post('action', command('place_voxel', `place-flow-${sourceX}`, cube, revision, {
      material, against:{...cube,y:0}, hit:{x:8 + (localX + .5) / 8,y:1,z:10.3125}, voxel:voxelIndex(localX,0,2),
    }),a);
    assert.equal(placed.status,200,JSON.stringify(placed));
    assert.equal(voxelMaterialAt(placed.body.changes[0].voxels,voxelIndex(localX,0,2)),material);
    assert.deepEqual(geometry.collisionFor({key:voxelKey,voxels:placed.body.changes[0].voxels}),[]);
    revision = placed.body.worldRevision;
  }
  const remove = command('remove_voxel','remove-water-eighth',cube,revision,
    {voxel:voxelIndex(2,0,2), hit:{x:8.3125,y:1.125,z:10.3125}});
  const removed = await post('action',remove,b);
  assert.equal(removed.status,200,JSON.stringify(removed));
  assert.deepEqual(removed.body.changes[0].voxels.materials,['legacy:11:0']);
});

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
    app = createHoneymoonServer({base, geometry, state, clock:() => now,allowRemoval:false});
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
  old.exec('ALTER TABLE edits DROP COLUMN fluid; ALTER TABLE edits DROP COLUMN voxels; PRAGMA user_version=4');
  old.close();
  await restart();
  const upgraded = new DatabaseSync(state,{readOnly:true});
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version,10);
  upgraded.close();

  const parentRevision = ordinary.body.worldRevision;
  const carve = command('remove_voxel','carve-parent-block',cube,parentRevision,{voxel:target,hit:top});
  assert.equal((await edit(a,{...carve,x:10,expectedRevision:0,requestId:'protect-original'})).body.error,'voxel_not_owned');
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
  const filled = await edit(b,fill);
  assert.equal(filled.status,200,JSON.stringify(filled.body));
  assert.equal(voxelMaterialAt(filled.body.changes[0].voxels,target),planks);
  assert.deepEqual(filled.body.effects[0].voxelMaterial,planks);
  const copied = await edit(b,command('copy_voxel','copy-sculpt-material',cube,filled.body.worldRevision,{voxel:target,hit:top}));
  assert.equal(copied.body.material,planks);

  await restart();
  const snapshot = await request('world',undefined,a);
  assert.deepEqual(snapshot.body.overrides.find(cell => cell.x === cube.x && cell.z === cube.z),filled.body.changes[0]);
  const updated = {...carve,expectedRevision:filled.body.worldRevision,requestId:'owned-after-restart'};
  assert.equal((await edit(a,updated)).status,200);

  const putSmall = command('place_voxel','place-small-piece',small,0,{
    material:planks,against:{...small,y:0},voxel:smallTarget,hit:smallBottom,
  });
  const resumed = await request('session',{},b);
  assert.equal(resumed.status,200);
  assert.equal(resumed.body.access.role,'player');
  now += 100;
  const firstPosition = await request('position',{x:9.5,y:1,z:9.3125},b);
  assert.equal(firstPosition.status,200);
  now += 250;
  assert.equal((await request('position',{x:9.5,y:1,z:10.3125},b)).status,200);
  assert.equal((await edit(a,{...putSmall,requestId:'avoid-occupying-player'})).body.error,'occupied');
  await request('respawn',{},b);
  const smallPlaced = await edit(a,putSmall);
  assert.equal(smallPlaced.status,200,JSON.stringify(smallPlaced.body));
  const lastRemoved = await edit(a,command('remove_voxel','remove-last-piece',small,smallPlaced.body.worldRevision,{
    voxel:smallTarget,hit:{...smallBottom,y:1.125},
  }));
  assert.equal(lastRemoved.status,200,JSON.stringify(lastRemoved.body));
  assert.deepEqual(lastRemoved.body.changes,[{...small,cell:null,object:null,revision:lastRemoved.body.worldRevision}]);

  const quarter = await edit(a,{...putSmall,size:2,requestId:'place-quarter-detail',expectedRevision:lastRemoved.body.worldRevision});
  assert.equal(quarter.status,200,JSON.stringify(quarter.body));
  const quarterState = quarter.body.changes[0].voxels;
  const {indices} = voxelBrush(smallTarget,2);
  assert.deepEqual(quarterState.quarters,[indices[0]]);
  assert.deepEqual(indices.map(index => voxelMaterialAt(quarterState,index)),Array(8).fill(planks));
  await restart();
  const erased = await edit(b,command('remove_voxel','remove-quarter-detail',small,quarter.body.worldRevision,{
    voxel:voxelIndex(2,1,2),hit:{...smallBottom,y:1.25},size:2,
  }));
  assert.equal(erased.status,200,JSON.stringify(erased.body));
  assert.equal(erased.body.changes[0].cell,null);

  await restart(fixture('level-reimported',true));
  assert.equal((await request('world',undefined,a)).body.overrides.some(cell => cell.x === cube.x && cell.z === cube.z),false);
  assert.equal(app.game.conflicts.find(cell => cell.x === cube.x && cell.z === cube.z)?.reason,'original_cell_changed');
});
