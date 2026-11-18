import test from 'node:test';
import assert from 'node:assert/strict';
import {createMovementSync} from './movement-sync.mjs';
import {createMovementChannel} from '../server/movement-channel.mjs';

test('SSE advances movement while HTTP waits, then position-state recovers a missed confirmation', async ()=>{
  let time=10, position={x:0,y:65,z:0};
  let loseReplies=true, loseEvents=false;
  const statuses=[], commits=[], corrected=[], requests=[];
  const metrics={requests:0,errors:0,corrections:0};
  const channel=createMovementChannel(()=>({position,stance:'stand',seat:null}));
  const sync=createMovementSync({
    now:()=>time,
    post(path,input,signal) {
      requests.push({path,input,signal});
      if (path==='position-state') {
        return Promise.resolve({ok:true,body:{movement:channel.open('pony','device',input.page,input.start)}});
      }
      const movement=channel.receive('pony','device',input,packet=>{
        const {x,y,z}=packet;
        position={x,y,z};
        return {
          commit:{effects:[{type:'step'}]},
          deliver(state) { if (!loseEvents) queueMicrotask(()=>sync.received(state)); },
        };
      });
      if (loseReplies) return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
      return Promise.resolve({ok:true,status:200,body:{movement}});
    },
    pose:()=>undefined, correct:state=>corrected.push(state), commit:result=>commits.push(result),
    reopen:()=>statuses.push('reopen'),report:{fail:()=>statuses.push('failure'),recover:()=>statuses.push('ack')},metrics,
  });
  const tick=()=>new Promise(resolve=>setImmediate(resolve));
  sync.reset(position,'stand');
  await sync.pump();
  sync.record({x:.2,y:65,z:0},'stand');
  sync.pump();
  await tick();
  assert.equal(sync.queued.length,0);
  assert.equal(sync.inspect().ackSource,'sse');
  assert.equal(requests.at(-1).signal.aborted,true);

  time+=160;
  loseEvents=true;
  sync.record({x:.4,y:65,z:0},'stand');
  sync.pump();
  assert.equal(sync.queued.length,1);
  const oldState=channel.state('pony','device',sync.page);
  time+=1500;
  assert.equal(sync.canPredict(time),true);
  time+=410;
  assert.equal(sync.canPredict(time),false);
  assert.ok(requests.at(-1).signal.aborted===false);
  sync.pump();
  await tick();
  assert.equal(sync.queued.length,0);
  assert.equal(sync.inspect().ackSource,'state');
  assert.deepEqual(commits.map(commit=>commit.through),[1,2]);
  assert.equal(metrics.requests,2);
  assert.equal(metrics.errors,0);

  // Teleport resets the epoch and leaves late acknowledgements from before it inert.
  position={x:40,y:65,z:0};
  channel.invalidate('pony');
  sync.reset(position,'stand');
  await sync.pump();
  sync.received(oldState);
  assert.deepEqual(sync.inspect().pos,[40,65,0]);
  assert.deepEqual(corrected,[]);
  assert.equal(statuses.includes('reopen'),false);
});

test('ordered server acceptance drains a bounded gap and makes duplicate delivery passive', ()=>{
  let position={x:0,y:0,z:0};
  const applied=[];
  const channel=createMovementChannel(()=>({position,stance:'stand'}));
  const page=crypto.randomUUID();
  const begin=channel.open('pony','device',page,true);
  const send=(first,device='device',epoch=begin.epoch)=>channel.receive('pony',device,{page,epoch,first,
    trail:[[first*.1,0,0]],x:first*.1},packet=>{
    position={...position,x:packet.x};
    applied.push(packet.first);
    return {};
  });
  assert.equal(send(2).accepted,0);
  assert.equal(send(1).accepted,2);
  assert.equal(send(2).accepted,2);
  assert.equal(send(200).accepted,2);
  assert.deepEqual(applied,[1,2]);
  assert.throws(()=>send(3,'another-device'),{code:'movement_page_replaced'});
  const restarted=channel.restart('pony','device',page,begin.epoch);
  assert.equal(restarted.previousMovement.accepted,2);
  assert.equal(restarted.movement.accepted,0);
  assert.deepEqual(channel.restart('pony','device',page,begin.epoch),restarted);
  assert.throws(()=>send(3),{code:'movement_reset'});
  assert.deepEqual(applied,[1,2]);
});

test('after a 40-second outage the client discards expired paths and resumes at the server position', async ()=>{
  let time=100, online=true;
  const position={x:0,y:65,z:0};
  const metrics={requests:0,errors:0,corrections:0};
  const channel=createMovementChannel(()=>({position,stance:'stand',seat:null}));
  const rejected=[];
  const sync=createMovementSync({
    now:()=>time,
    post(path,input) {
      if (path==='position') {
        rejected.push(input);
        return Promise.reject(new Error('offline'));
      }
      if (!online) return Promise.reject(new Error('offline'));
      const state=input.restart
        ? channel.restart('pony','device',input.page,input.restart)
        : {movement:channel.open('pony','device',input.page,input.start)};
      return Promise.resolve({ok:true,body:state});
    },
    pose:()=>undefined, correct:state=>assert.deepEqual(state.position,position),
    commit:()=>{}, reopen:()=>{}, report:{fail:()=>{},recover:()=>{}},metrics,
  });
  sync.reset(position,'stand');
  await sync.pump();
  online=false;
  sync.record({x:.1,y:65,z:0},'stand');
  await sync.pump();
  time+=2100;
  assert.equal(sync.canPredict(time),false);
  await new Promise(resolve=>{ sync.pump(); setImmediate(resolve); });
  online=true;
  time+=37900;
  await new Promise(resolve=>{ sync.pump(); setImmediate(resolve); });
  assert.equal(sync.canPredict(time),true);
  assert.equal(sync.inspect().status,'ready');
  assert.equal(sync.queued.length,0);
  assert.equal(rejected.length,1);
  assert.equal(metrics.corrections,1);
  assert.throws(()=>channel.receive('pony','device',rejected[0],()=>{}),{code:'movement_reset'});
});

test('the first movement after eight idle seconds starts a packet without resetting', async ()=>{
  let time=10;
  const position={x:0,y:65,z:0};
  const requests=[];
  const metrics={requests:0,errors:0,corrections:0};
  const channel=createMovementChannel(()=>({position,stance:'stand'}));
  const sync=createMovementSync({
    now:()=>time,
    async post(path,input) {
      requests.push({path,input});
      const movement=path==='position-state'
        ? channel.open('pony','device',input.page,input.start)
        : channel.receive('pony','device',input,()=>{ position.x=input.x; return {}; });
      return {ok:true,body:{movement}};
    },
    pose:()=>undefined, correct:()=>assert.fail('idle client was corrected'),commit:()=>{},reopen:()=>{},
    report:{fail:()=>{},recover:()=>{}},metrics,
  });
  sync.reset(position,'stand');
  await sync.pump();
  time+=8000;
  sync.record({x:.2,y:65,z:0},'stand');
  await sync.pump();
  assert.deepEqual(requests.map(r=>r.path),['position-state','position']);
  assert.equal(sync.inspect().ackSource,'http');
  assert.equal(sync.queued.length,0);
  assert.equal(position.x,.2);
});

test('a plain HTTP browser can bind a page and send movement without randomUUID', async t=>{
  const getRandomValues=crypto.getRandomValues.bind(crypto);
  t.mock.getter(globalThis,'crypto',()=>({getRandomValues}));
  const position={x:0,y:65,z:0};
  const channel=createMovementChannel(()=>({position,stance:'stand'}));
  let packet;
  const sync=createMovementSync({
    async post(path,input) {
      if (path==='position-state') {
        return {ok:true,body:{movement:channel.open('pony','device',input.page,input.start)}};
      }
      packet=input;
      const movement=channel.receive('pony','device',input,()=>{ position.x=input.x; return {}; });
      return {ok:true,body:{movement}};
    },
    pose:()=>undefined,correct:()=>{},commit:()=>{},reopen:()=>{},
    report:{fail:()=>{},recover:()=>{}},metrics:{requests:0,errors:0,corrections:0},
  });
  assert.match(sync.page,/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  sync.reset(position,'stand');
  await sync.pump();
  sync.record({x:.2,y:65,z:0},'stand');
  await sync.pump();
  assert.match(packet.requestId,/^[0-9a-f]{32}$/);
  assert.equal(position.x,.2);
  assert.equal(sync.queued.length,0);
});
