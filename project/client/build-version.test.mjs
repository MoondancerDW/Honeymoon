import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {checkBuild} from './build-version.mjs';
import {readBuildNumber} from '../server/build-version.mjs';
import {createHoneymoonServer} from '../server/index.mjs';
import * as geometry from '../world/geometry.mjs';

test('the browser compares the build already loaded in its page with a fresh server response', async () => {
  const banner = {hidden:true};
  const request = build => async (path, options) => {
    assert.equal(path, '/api/build');
    assert.equal(options.cache, 'no-store');
    return Response.json({build});
  };
  await checkBuild(1, banner, request(1));
  assert.equal(banner.hidden, true);
  await checkBuild(1, banner, request(2));
  assert.equal(banner.hidden, false);
  await checkBuild(1, banner, async () => { throw new Error('offline'); });
  await checkBuild(1, banner, request(null));
  assert.equal(banner.hidden, false);
  await checkBuild(1, banner, request(1));
  assert.equal(banner.hidden, true);
});

test('a secure server exposes the deployed build before authentication, without caching', async t => {
  const bounds = {minX:0,maxX:15,minY:0,maxY:15,minZ:0,maxZ:15};
  const base = {
    hash:'build-version-fixture',
    manifest:{bounds,spawn:[8.5,1,8.5]},
    catalog:new Set(['legacy:1:0']),
    inBounds:(x,y,z) => [x,y,z].every(n => n >= 0 && n < 16),
    getCell:(x,y) => ({key:y === 0 ? 'legacy:1:0' : 'air',object:null}),
  };
  const app = createHoneymoonServer({base,geometry,state:':memory:',secure:true});
  t.after(() => app.close());
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  const page = await (await fetch(origin)).text();
  const build = readBuildNumber();
  assert.ok(build > 0);
  assert.ok(page.includes('<meta name="honeymoon-build" content="' + build + '">'));
  const response = await fetch(origin + '/api/build');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {build});
});
