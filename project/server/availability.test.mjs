import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {createHoneymoonServer} from './index.mjs';
import * as geometry from '../world/geometry.mjs';

const bounds={minX:0,minY:0,minZ:0,maxX:15,maxY:15,maxZ:15};
const base={
  hash:'availability-fixture',
  manifest:{bounds,spawn:[8.5,1,8.5]},
  catalog:new Set(['air','legacy:1:0']),
  inBounds:(x,y,z)=>[x,y,z].every(value=>value>=0&&value<16),
  getCell:(_x,y)=>({key:y===0?'legacy:1:0':'air',object:null}),
};

async function fixture(t,inviteRequired=false) {
  const app=createHoneymoonServer({base,geometry,state:':memory:',inviteRequired});
  t.after(()=>app.close());
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  return `http://127.0.0.1:${app.server.address().port}`;
}

test('public ping answers directly without a session or cacheable body',async t=>{
  const origin=await fixture(t,true);
  const secured=await fetch(origin+'/api/world');
  assert.equal(secured.status,401);
  for (const method of ['GET','HEAD']) {
    const ping=await fetch(origin+'/api/ping',{method});
    assert.equal(ping.status,204);
    assert.equal(ping.headers.get('Cache-Control'),'no-store');
    assert.equal(await ping.text(),'');
  }
});

test('one profile cannot occupy every live stream slot',async t=>{
  const origin=await fixture(t);
  async function session() {
    const response=await fetch(origin+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(response.status,200);
    return response.headers.getSetCookie()[0].split(';')[0];
  }
  const connect=Cookie=>fetch(origin+'/api/events',{headers:{Cookie}});
  const player=await session();
  const other=await session();
  const streams=[];
  try {
    for (let slot=0;slot<3;slot++) {
      const response=await connect(player);
      streams.push(response);
      assert.equal(response.status,200);
    }
    const limited=await connect(player);
    assert.equal(limited.status,429);
    assert.equal((await limited.json()).error,'profile_stream_limit');
    const unaffected=await connect(other);
    streams.push(unaffected);
    assert.equal(unaffected.status,200);
  } finally {
    await Promise.all(streams.map(response=>response.body.cancel()));
  }
});
