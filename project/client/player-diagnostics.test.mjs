import assert from 'node:assert/strict';
import test from 'node:test';
import {createPlayerDiagnostics} from './player-diagnostics.mjs';

function mockBrowser(t) {
  t.mock.timers.enable({apis:['setInterval']});
  const storage=new Map();
  const listeners=new Map();
  const navigator={onLine:true};
  const original=new Map();
  for (const [name,value] of Object.entries({
    document:{hidden:false,hasFocus:()=>true},navigator,
    addEventListener:(event,listener)=>listeners.set(event,listener),
    removeEventListener:(event,listener)=>{if (listeners.get(event)===listener) listeners.delete(event);},
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
  return {storage,listeners,navigator};
}

test('diagnostics records an attempted movement stall, recovery, and request traces only during the study',async t=>{
  const {storage}=mockBrowser(t);
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

test('diagnostics aligns ping samples and records spikes, timeouts, stream breaks and network recovery',async t=>{
  const {listeners,navigator}=mockBrowser(t);
  const timestamp=Date.now(), batches=[];
  let elapsed=0, clockSkew=-1200;
  const diagnostics=createPlayerDiagnostics({clock:()=>timestamp+elapsed+clockSkew,monotonic:()=>elapsed,
    send:async body=>{batches.push(body);return {status:204};}});
  diagnostics.enable({until:timestamp+60_000,serverAt:timestamp},'test-account');
  diagnostics.stream(true);
  function successfulPing(started,rtt) {
    elapsed=started+rtt;
    diagnostics.ping({started,status:204,reachable:true,serverAt:timestamp+started+rtt/2});
  }
  successfulPing(20,40);
  successfulPing(1300,44);
  successfulPing(2600,42);
  successfulPing(3900,148);
  elapsed=4200;
  diagnostics.stream(false,'closed');
  diagnostics.stream(false,'closed');
  elapsed=6100;
  diagnostics.ping({started:4100,error:new DOMException('deadline exceeded','TimeoutError'),reachable:false});
  navigator.onLine=false;
  listeners.get('offline')();
  elapsed=6300;
  diagnostics.ping({started:6200,error:new TypeError('fetch failed'),reachable:false});
  navigator.onLine=true;
  elapsed=7100;
  listeners.get('online')();
  successfulPing(7200,38);
  elapsed=7400;
  diagnostics.stream(true);
  clockSkew=10_000;
  elapsed=7800;
  // Keep the current incident even when a reload occurs ahead of the next regular sample.
  listeners.get('pagehide')();
  await Promise.resolve();
  const {samples:[sample]}=batches[0];
  assert.equal(sample.at,timestamp+7800);
  assert.equal(sample.clockOffsetMs,-10_000);
  assert.deepEqual(sample.network.map(event=>[event.kind,event.state,event.at-timestamp]),[
    ['sse','open',0],['ping','ok',20],['ping','ok',1300],['ping','ok',2600],['ping','spike',3900],
    ['sse','lost',4200],['ping','lost',4100],['browser','offline',6100],['ping','lost',6200],
    ['browser','online',7100],['ping','recovered',7200],['sse','recovered',7400],
  ]);
  assert.deepEqual(sample.network[4],{kind:'ping',state:'spike',at:timestamp+3900,status:204,rttMs:148,baselineMs:42});
  assert.equal(sample.network[6].error,'timeout');
  assert.equal(sample.network[8].error,'offline');
  assert.equal(sample.network[9].durationMs,1000);
  assert.equal(sample.network[10].missed,2);
  assert.equal(sample.network[10].durationMs,3138);
  assert.equal(sample.network[11].durationMs,3200);
});
