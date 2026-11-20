import assert from 'node:assert/strict';
import test from 'node:test';
import {createStartupDiagnostics} from './startup-diagnostics.mjs';

const storageKey='honeymoon-startup-diagnostics:v1';
const earlyAttempt='0000000000000001';
const newAttempt='0000000000000002';

function fixture(t) {
  t.mock.timers.enable({apis:['setTimeout']});
  const data=new Map();
  const storage=()=>({getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)});
  const events=()=>JSON.parse(data.get(storageKey)??'[]');
  let clock=1787356800000, ticks=0;
  const advance=ms=>{ clock+=ms; ticks+=ms; t.mock.timers.tick(ms); };
  const config={clock:()=>clock,monotonic:()=>ticks,storage,route:'compare',build:28};
  return {data,events,advance,config};
}

test('startup events persist before authentication, survive reload, and upload only after access',async t=>{
  const {data,events,advance,config}=fixture(t);
  const oldAt=config.clock();
  const old={kind:'startup_phase',id:`${earlyAttempt}.0`,phase:'document',outcome:'failed',at:oldAt,
    why:'unavailable',route:'compare',durationMs:312};
  data.set(storageKey,JSON.stringify([old]));
  let stopped=0;
  const batches=[];
  const send=async ({events})=>{ batches.push(events); return {status:204}; };
  const previous=createStartupDiagnostics({...config,early:{attempt:earlyAttempt,started:0,stop:()=>stopped++},send});
  advance(150);
  previous.complete('bootstrap');
  previous.begin('authorization');
  advance(10_000);
  previous.fail('authorization',new DOMException('private-message','TimeoutError'));
  assert.equal(batches.length,0);
  assert.equal(stopped,1);
  assert.equal(events().length,3);
  assert.ok(!JSON.stringify(events()).includes('private-message'));

  const retry=createStartupDiagnostics({...config,early:{attempt:newAttempt,started:10_150},send});
  retry.complete('bootstrap');
  retry.begin('authorization');
  advance(40);
  retry.complete('authorization');
  retry.enable(config.clock()+1000);
  advance(1800);
  await Promise.resolve();
  assert.deepEqual(batches[0].map(({phase,outcome,why,durationMs,route})=>[phase,outcome,why,durationMs,route]),[
    ['document','failed','unavailable',312,'compare'],['bootstrap','ok',undefined,150,'compare'],
    ['authorization','failed','timeout',10_000,'compare'],['bootstrap','ok',undefined,0,'compare'],
    ['authorization','ok',undefined,40,'compare'],
  ]);
  assert.equal(batches[0][0].at,oldAt+1000);
  assert.deepEqual(events(),[]);
});

test('only the first pending stream and movement failure is recorded and actual recovery finishes each phase',async t=>{
  const {events,advance,config}=fixture(t);
  const diagnostics=createStartupDiagnostics(config);
  diagnostics.begin('sse');
  diagnostics.begin('position');
  advance(700);
  diagnostics.fail('sse',{why:'closed'});
  diagnostics.fail('sse',{why:'network'});
  advance(3300);
  diagnostics.begin('sse');
  diagnostics.complete('sse');
  advance(800);
  diagnostics.complete('position');
  diagnostics.begin('position');
  assert.deepEqual(events().map(({phase,outcome,why,durationMs})=>[phase,outcome,why,durationMs]),[
    ['sse','failed','closed',700],['position','failed','timeout',4000],
    ['sse','ok',undefined,4000],['position','ok',undefined,4800],
  ]);
});

test('authorization attempts bound the local queue and can report a required prompt separately',t=>{
  const {data,events,config}=fixture(t);
  data.set(storageKey,JSON.stringify([{kind:'startup_phase',id:`${earlyAttempt}.0`,phase:'document',at:1}]));
  const diagnostics=createStartupDiagnostics(config);
  for (let i=0;i<40;i++) {
    diagnostics.begin('authorization');
    diagnostics.fail('authorization',{why:'input_required',status:401});
  }
  const captured=events();
  assert.equal(captured.length,32);
  assert.ok(captured.every(event=>event.phase==='authorization' && event.outcome==='waiting'));
});
