import assert from 'node:assert/strict';
import test from 'node:test';
import {createPlayerDiagnostics} from './player-diagnostics.mjs';

test('diagnostics records an attempted movement stall, recovery, and request traces only during the study',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const storage=new Map();
  const original=new Map();
  for (const [name,value] of Object.entries({
    document:{hidden:false,hasFocus:()=>true},navigator:{onLine:true},addEventListener:()=>{},
    sessionStorage:{setItem:(key,value)=>storage.set(key,value),getItem:key=>storage.get(key)??null,removeItem:key=>storage.delete(key)},
  })) {
    original.set(name,Object.getOwnPropertyDescriptor(globalThis,name));
    Object.defineProperty(globalThis,name,{configurable:true,value});
  }
  t.after(()=>{
    for (const [name,descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis,name,descriptor);
      else delete globalThis[name];
    }
  });
  const timestamp=Date.now(), batches=[];
  let elapsed=0;
  const diagnostics=createPlayerDiagnostics({clock:()=>timestamp+elapsed,monotonic:()=>elapsed,
    send:async body=>{batches.push(body);return {status:204};}});
  assert.equal(diagnostics.request('position'),undefined);
  diagnostics.enable({until:timestamp+20_000,serverAt:timestamp},'test-account',()=>({queued:0}));
  const page=diagnostics.page();
  const request=diagnostics.request('position','f'.repeat(32));
  elapsed=210;
  request.headers({status:200});
  request.finish();
  diagnostics.frame(500,true,'queue_full',128,{x:1,y:0,z:0});
  diagnostics.frame(1500,true,'queue_full',128,{x:1,y:0,z:0});
  elapsed=2200;
  diagnostics.frame(2200,true,undefined,0,{x:2,y:0,z:0});
  elapsed=10_000;
  t.mock.timers.tick(10_000);
  await Promise.resolve();
  const {samples:[sample]}=batches[0];
  assert.equal(sample.at,timestamp+10_000);
  assert.equal(sample.maxQueued,128);
  assert.equal(sample.longFrames,2);
  assert.deepEqual(sample.requests,[{id:page+'.1',kind:'movement',group:'f'.repeat(12),startedAt:timestamp,
    status:200,headersMs:210,durationMs:210}]);
  assert.deepEqual(sample.stalls.map(({kind,reason,durationMs,outcome})=>[kind,reason,durationMs,outcome]),[
    ['start','queue_full',undefined,undefined],['end','queue_full',1700,'moved'],
  ]);
  elapsed=20_000;
  assert.equal(diagnostics.request('ping'),undefined);
  assert.equal(storage.size,0);
});
