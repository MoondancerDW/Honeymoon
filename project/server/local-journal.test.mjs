import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {createHoneymoonServer} from './index.mjs';
import * as geometry from '../world/geometry.mjs';

test('solo keeps one local profile and records browser and server diagnostics',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'honeymoon-solo-'));
  const base={hash:'solo-test',manifest:{spawn:[3.5,1,3.5],
    bounds:{minX:0,maxX:15,minY:0,maxY:15,minZ:0,maxZ:15}},
    catalog:new Set(['air','legacy:1:0']),inBounds:(...p)=>p.every(v=>v>=0&&v<=15),
    getCell:(_x,y)=>({key:y===0?'legacy:1:0':'air'})};
  const app=createHoneymoonServer({base,geometry,generated:dir,state:join(dir,'honeymoon.sqlite'),singlePlayer:true});
  let closed=false;
  t.after(async()=>{if (!closed) await app.close();});
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  const url=`http://127.0.0.1:${app.server.address().port}`;
  const post=(path,body,origin=url)=>fetch(url+path,{method:'POST',
    headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});
  const first=await post('/api/session',{}).then(r=>r.json());
  const again=await post('/api/session',{}).then(r=>r.json());
  assert.equal(first.access.singlePlayer,true);
  assert.equal(first.access.uid,again.access.uid);
  assert.equal((await post('/api/local-diagnostics',{kind:'webgl-lost'},'http://other.test')).status,403);
  const detail={kind:'worker-error',position:[3.5,1,3.5],lastChunk:[0,0,false],message:'fixture'};
  assert.equal((await post('/api/local-diagnostics',detail)).status,200);
  const journal=await fetch(url+'/api/local-diagnostics');
  assert.match(journal.headers.get('content-disposition'),/attachment/);
  const [start,event]=await journal.json();
  assert.equal(start.kind,'server-start');
  assert.equal(event.kind,detail.kind);
  assert.deepEqual(event.lastChunk,detail.lastChunk);
  await app.close();
  closed=true;
});
