import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createConnectionStatus} from './connection-status.mjs';

function setup(t,{pingStatus=204}={}) {
  const document = {addEventListener() {}};
  const fields = new Map();
  const recovery = [], failures = [];
  let time=0, staleStreams=0;
  for (const [key,value] of Object.entries({document,addEventListener() {}})) {
    const before = Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{configurable:true,value});
    t.after(() => {
      if (before) Object.defineProperty(globalThis,key,before);
      else delete globalThis[key];
    });
  }
  t.mock.timers.enable({apis:['setTimeout']});
  t.mock.method(globalThis,'fetch',async () => new Response(null,{status:pingStatus}));
  const status = createConnectionStatus({
    element(id) {
      if (!fields.has(id)) fields.set(id,{hidden:true,textContent:'',addEventListener() {}});
      return fields.get(id);
    },
    active:()=>true,onRecover() {},onLatency() {},onRecovery:state=>recovery.push(state),
    onStreamStale:()=>staleStreams++,
    report:{fail:(channel,detail)=>failures.push({channel,...detail}),recover() {}},
    now:()=>time,
  });
  return {status,recovery,failures,staleStreams:()=>staleStreams,
    message:()=>fields.get('connection-message').textContent,
    advance(to,waiting=false,terrain=false) {
      time=to;
      status.movementWaiting(waiting,terrain);
    }};
}

test('one failed ping leaves an active event stream usable without a reconnect warning', async t => {
  const {status,advance,message,recovery,failures}=setup(t,{pingStatus:503});
  status.stream(true);
  assert.equal(await status.check(),false);
  advance(1000);
  assert.equal(status.canMove(),true);
  assert.equal(message(),'');
  assert.deepEqual(recovery,[]);
  assert.deepEqual(failures,[{channel:'ping',why:'http',status:503}]);
});

test('fresh position confirmations cover a lost event stream until they stop, then allow recovery', async t => {
  const {status,advance,message,recovery}=setup(t);
  status.stream(true);
  status.positionConfirmed();
  status.stream(false,'network');
  await status.check();
  advance(3400);
  assert.equal(status.canMove(),true);
  assert.equal(message(),'');
  status.positionConfirmed();
  advance(6800);
  assert.equal(status.canMove(),true);
  advance(6900);
  assert.equal(status.canMove(),false);
  assert.deepEqual(recovery,[true]);
  assert.equal(message(),'');
  advance(7500);
  assert.match(message(),/Восстанавливаем соединение/);
  status.positionConfirmed();
  assert.equal(status.canMove(),true);
  assert.deepEqual(recovery,[true,false]);
  assert.equal(message(),'');
});

test('heartbeats keep an idle stream usable and a silently expired stream requests one reopen', t => {
  const {status,advance,staleStreams,failures}=setup(t);
  status.stream(true);
  advance(15_000);
  status.streamActivity();
  advance(30_000);
  status.streamActivity();
  advance(62_999);
  assert.equal(status.streamReady(),true);
  advance(63_000);
  assert.equal(status.streamReady(),false);
  advance(65_000);
  assert.equal(staleStreams(),1);
  assert.deepEqual(failures,[{channel:'sse',why:'timeout'}]);
});

test('missing movement confirmations pause background work independently of the terrain notice', t => {
  const {status,advance,message,recovery}=setup(t);
  status.stream(true);
  advance(1900,true);
  assert.deepEqual(recovery,[true]);
  assert.equal(message(),'');
  advance(2500,true,true);
  assert.match(message(),/Загружаем ближайший участок/);
  advance(2600,true);
  assert.match(message(),/Восстанавливаем связь/);
  advance(2650);
  assert.deepEqual(recovery,[true,false]);
  assert.equal(message(),'');
});
