import {positionBatch,positionSendInterval} from './position-packet.mjs';
import {connectionFailure} from './connection-report.mjs';

const maxInFlight=4;
const maxPredictedSteps=256;
const predictionMs=1850;
const predictionBlocks=52;
const movementInterval=130;
const recoveryMs=1900;
const expirationMs=6500;
const pointTuple = ({x,y,z}) => [x,y,z];
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));

function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
}

export function createMovementSync({now=()=>performance.now(),post,pose,correct,commit,reopen,report,metrics,onAck}) {
  const token=randomId();
  const page=[token.slice(0,8),token.slice(8,12),token.slice(12,16),token.slice(16,20),token.slice(20)].join('-');
  const queued=[];
  const samples=new WeakMap();
  const sent=new Map();
  const active=new Map();
  const acks={sse:0,http:0,state:0};
  let confirmed, epoch, accepted=0, submitted=0, actionEpoch=0, start=true;
  let probe, nextProbe=0, failures=0, nextSend=0, dispatched=-Infinity, lastProgress=0;
  let status='binding', ackSource, lastCommit=0;

  function clearPending(now) {
    queued.length=0;
    sent.clear();
    for (const attempt of active.values()) attempt.controller.abort();
    actionEpoch++;
    accepted=submitted=0;
    nextSend=nextProbe=lastProgress=now;
    dispatched=-Infinity;
    lastCommit=0;
  }

  function reset(position, stance) {
    clearPending(now());
    confirmed=[...pointTuple(position),stance];
    epoch=undefined;
    status='binding';
  }

  function adopt(state) {
    const position=[...pointTuple(state.position),state.stance];
    const displaced=confirmed && confirmed.some((coord,index)=>coord!==position[index]);
    if (displaced || queued.length) {
      metrics.corrections++;
      correct(state);
    }
    clearPending(now());
    epoch=state.epoch;
    accepted=submitted=lastCommit=state.accepted;
    confirmed=position;
    status='ready';
  }

  function accept(state, source) {
    if (!state || state.epoch!==epoch || state.accepted<=accepted || state.accepted>submitted) return false;
    const count=state.accepted-accepted;
    for (const event of state.commits ?? []) {
      if (event.through>lastCommit && event.through<=state.accepted) commit(event);
    }
    lastCommit=state.accepted;
    confirmed=[...pointTuple(state.position),state.stance];
    queued.splice(0,count);
    accepted=state.accepted;
    let lastPose;
    for (const [first,entry] of sent) {
      if (entry.last>accepted) continue;
      if (entry.payload.pose) lastPose=entry.payload.pose;
      active.get(entry)?.controller.abort();
      sent.delete(first);
    }
    ackSource=source;
    acks[source]++;
    lastProgress=now();
    failures=0;
    report.recover('movement');
    onAck?.(lastPose,state);
    return true;
  }

  function dispatch(entry) {
    if (active.size>=maxInFlight || active.has(entry)) return;
    const generation=actionEpoch;
    metrics.requests++;
    entry.attempted=now();
    const controller=new AbortController();
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(3000)]);
    const completed=post('position',entry.payload,signal).then(({ok,status,body})=>{
      if (generation!==actionEpoch) return;
      if (status===409 && body.movement && body.movement.epoch!==epoch) {
        adopt(body.movement);
      } else if (!ok) {
        metrics.errors++;
        report.fail('movement',{why:'http',status});
        if (body.error==='movement_page_replaced') nextProbe=now();
      } else if (body.movement?.epoch!==epoch) {
        nextProbe=now();
      } else {
        accept(body.movement,'http');
      }
    }).catch(error=>{
      if (generation===actionEpoch && entry.last>accepted) {
        metrics.errors++;
        report.fail('movement',connectionFailure(error));
      }
    }).finally(()=>{
      active.delete(entry);
    });
    active.set(entry,{controller,completed});
    return completed;
  }

  function reconcile(time) {
    if (probe || time<nextProbe) return probe;
    const generation=actionEpoch;
    const restart=epoch && sent.size && time-lastProgress>=expirationMs ? epoch : undefined;
    nextProbe=time+recoveryMs;
    probe=post('position-state',{page,start,restart},AbortSignal.timeout(2300)).then(({ok,body})=>{
      if (generation!==actionEpoch) return;
      if (body?.error==='movement_page_replaced') {
        status='replaced';
        return;
      }
      if (!ok || !body.movement) throw new Error('Position check failed');
      start=false;
      failures=0;
      if (body.previousMovement) accept(body.previousMovement,'state');
      if (body.movement.epoch!==epoch) adopt(body.movement);
      else if (!accept(body.movement,'state')) {
        const entry=sent.values().next().value;
        if (entry && now()-entry.attempted>=recoveryMs) dispatch(entry);
      }
    }).catch(()=>{
      if (generation!==actionEpoch) return;
      failures++;
      nextProbe=now()+Math.min(5000,400*2**failures);
      if (failures===2 && epoch && queued.length) reopen();
    }).finally(()=>{probe=undefined;});
    return probe;
  }

  function pump(limit) {
    const time=now();
    if (!confirmed || status==='replaced') return;
    if (!epoch) return reconcile(time);
    if (!queued.length) return;
    const stalledFor=sent.size ? time-lastProgress : 0;
    if (stalledFor>=recoveryMs) reconcile(time);
    if (stalledFor>=expirationMs) return;
    if (sent.size>=maxInFlight || active.size>=maxInFlight || time<nextSend) return;
    const offset=submitted-accepted, end=limit ? queued.indexOf(limit)+1 : queued.length;
    if (offset>=end) return;
    const from=offset ? queued[offset-1] : confirmed;
    const flying=samples.get(queued[offset]).flying;
    const selected=[];
    for (let i=offset;i<end && samples.get(queued[i]).flying===flying;i++) selected.push(queued[i]);
    const avatarPose=pose(flying);
    const batch=positionBatch(from,selected,limit,flying);
    const readyAt=dispatched+positionSendInterval(from,batch.trail,movementInterval,flying);
    if (time<readyAt) {
      nextSend=readyAt;
      return;
    }
    if (!sent.size) lastProgress=time;
    dispatched=time;
    nextSend=time+movementInterval;
    const first=submitted+1, last=submitted+=batch.trail.length;
    const [x,y,z]=batch.target;
    const requestId=randomId();
    const entry={last,payload:{page,epoch,first,requestId,from,trail:batch.trail,x,y,z,pose:avatarPose}};
    sent.set(first,entry);
    return dispatch(entry);
  }

  return {
    page,queued,reset,pump,
    canPredict(time) {
      if (status!=='ready' || !epoch || queued.length>=maxPredictedSteps) return false;
      if (!queued.length) return true;
      const step=queued.at(-1);
      return time-samples.get(queued[0]).at<predictionMs &&
        Math.hypot(step[0]-confirmed[0],step[1]-confirmed[1],step[2]-confirmed[2])<predictionBlocks;
    },
    record(position, stance, flying=false) {
      const step=[...pointTuple(position),stance];
      const previous=queued.at(-1)??confirmed;
      if (previous && step.some((coord,index)=>coord!==previous[index])) {
        samples.set(step,{at:now(),flying});
        queued.push(step);
      }
    },
    received(state) {
      if (!epoch || !state) return;
      if (state.epoch===epoch) accept(state,'sse');
      else if (status==='ready') reconcile(now());
    },
    inFlight:()=>Promise.allSettled([...active.values()].map(entry=>entry.completed)),
    busy:()=>active.size>0,
    inspect:()=>({pending:sent.size,active:active.size,status,ackSource,acks:{...acks},pos:confirmed?.slice(0,3),
      queueAgeMs:queued.length ? Math.round(now()-samples.get(queued[0]).at) : 0}),
    async flush() {
      const last=queued.at(-1);
      if (status==='binding') await pump();
      const generation=actionEpoch, deadline=now()+4400;
      while (last && queued.includes(last) && actionEpoch===generation && now()<deadline) {
        pump(last);
        await pause(30);
      }
      return status==='ready' && actionEpoch===generation && !(last && queued.includes(last));
    },
  };
}
