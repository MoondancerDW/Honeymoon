import assert from 'node:assert/strict';
import test from 'node:test';
import {connectionFailure,createConnectionReport} from './connection-report.mjs';

test('connection reports retain onset, avoid duplicates, and deliver on recovery',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const uid='connection-report-test';
  const scope=`honeymoon-connection-report:${uid}`;
  const storage = new Map();
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{
    setItem:(key,value)=>storage.set(key,value), getItem:key=>storage.get(key)??null, removeItem:key=>storage.delete(key),
  }});
  t.after(()=>{ delete globalThis.sessionStorage; });
  const timestamp=Date.now();
  let elapsed=1000;
  const batches=[];
  const report=createConnectionReport({clock:()=>timestamp+elapsed,monotonic:()=>elapsed,
    send:async ({events})=>{
      batches.push(events);
      if (batches.length===1) throw new TypeError('offline');
      return {status:204};
    }});
  report.enable(uid);
  report.fail('ping',{why:'timeout'});
  report.fail('ping',{why:'timeout'});
  t.mock.timers.tick(100);
  await Promise.resolve();
  assert.equal(batches[0].length,1);
  assert.match(sessionStorage.getItem(scope), /ping_failed/);

  elapsed+=5000;
  report.recover('ping');
  report.fail('storage',{why:'position_pending'});
  t.mock.timers.tick(100);
  await Promise.resolve();
  assert.deepEqual(batches[1],[
    {kind:'ping_failed',why:'timeout',at:timestamp+1000},
    {kind:'ping_recovered',durationMs:5000,at:timestamp+6000},
    {kind:'storage_failed',why:'position_pending',at:timestamp+6000},
  ]);
  assert.equal(sessionStorage.getItem(scope),null);
  assert.deepEqual(connectionFailure({status:502}),{why:'http',status:502});
  assert.deepEqual(connectionFailure(new DOMException('Deadline','TimeoutError')),{why:'timeout'});
});
