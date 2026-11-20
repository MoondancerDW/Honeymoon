import {connectionFailure} from './connection-report.mjs';

const storageKey='honeymoon-startup-diagnostics:v1';
const lifetimeMs=24*60*60*1000;
const limit=32;
const deadlines={world:15000,sse:6000,position:4000};
const token=()=>Array.from(crypto.getRandomValues(new Uint8Array(8)),byte=>byte.toString(16).padStart(2,'0')).join('');
const storedInBrowser=()=>globalThis.localStorage;
const stages=new Set(['document','bootstrap','authorization','world','sse','position']);

function browserRoute() {
  const {hostname,port}=globalThis.location??{};
  if (['localhost','127.0.0.1','[::1]'].includes(hostname)) return 'local';
  return port==='8443' ? 'compare' : 'primary';
}

function startupFailure(error) {
  if (error?.why) return error;
  if (error instanceof SyntaxError) return {why:'bad_response'};
  const details=connectionFailure(error);
  return error?.name==='Error' && details.why==='network' ? {why:'client_error'} : details;
}

export function createStartupDiagnostics({early, clock=Date.now, monotonic=()=>performance.now(),
  storage=storedInBrowser, send=body=>fetch('/api/connection-report',{
    method:'POST',headers:{'Content-Type':'application/json'},keepalive:true,
    body:JSON.stringify(body),signal:AbortSignal.timeout(4000),
  }),route=browserRoute(),build=Number(globalThis.document?.querySelector('meta[name="honeymoon-build"]')?.content),
}={}) {
  const attempt=early?.attempt ?? token();
  const pending=new Map(), completed=new Set();
  let sequence=1, memory=[], storageUnavailable=false, enabled=false, sending=false, timer, clockOffset=0, retryAfter=0;

  function queue() {
    let stored;
    try { if (!storageUnavailable) stored=JSON.parse(storage()?.getItem(storageKey)); }
    catch { /* restricted browser storage */ }
    const now=clock();
    const events=new Map();
    for (const event of [...(Array.isArray(stored)?stored.slice(-limit):[]),...memory]) {
      if (event?.kind==='startup_phase' && stages.has(event.phase) && typeof event.id==='string' &&
          Number.isSafeInteger(event.at) && event.at>=now-lifetimeMs+60_000 && event.at<=now+60_000) events.set(event.id,event);
    }
    return [...events.values()].slice(-limit);
  }

  function persist(events) {
    memory=events;
    try {
      const target=storage();
      if (!target) return;
      if (events.length) target.setItem(storageKey,JSON.stringify(events));
      else target.removeItem(storageKey);
      memory=[];
    } catch { storageUnavailable=true; }
  }

  function schedule() {
    if (!enabled || sending || timer!==undefined || !queue().length) return;
    timer=setTimeout(()=>{
      timer=undefined;
      void flush();
    },Math.max(1800,retryAfter-monotonic()));
  }

  async function flush() {
    const batch=queue().slice(0,16);
    if (!batch.length) return;
    sending=true;
    try {
      const {status}=await send({events:batch.map(event=>({...event,at:event.at+clockOffset}))});
      if (status===204 || status===400 || status===413) {
        const sent=new Set(batch.map(({id})=>id));
        persist(queue().filter(event=>!sent.has(event.id)));
        retryAfter=0;
      } else if ([401,403,404,501].includes(status)) enabled=false;
      else retryAfter=monotonic()+(status===429 ? 30_000 : 5000);
    } catch { retryAfter=monotonic()+5000; }
    finally {
      sending=false;
      schedule();
    }
  }

  function record(phase,outcome,started,details={}) {
    const durationMs=Math.max(0,Math.min(lifetimeMs,Math.round(monotonic()-started)));
    const event={kind:'startup_phase',id:`${attempt}.${++sequence}`,phase,outcome,at:clock(),durationMs,route,
      ...(Number.isSafeInteger(build) && build>0 && build<100_000 && {build}),
      ...(details.why && {why:details.why}),
      ...(Number.isInteger(details.status) && details.status>=100 && details.status<=599 && {status:details.status})};
    persist([...queue(),event].slice(-limit));
    schedule();
  }

  function begin(phase,started=monotonic()) {
    if (!stages.has(phase) || completed.has(phase) || pending.has(phase)) return;
    const stage={started,failed:false};
    if (Object.hasOwn(deadlines,phase)) stage.timer=setTimeout(()=>fail(phase,{why:'timeout'}),deadlines[phase]);
    pending.set(phase,stage);
  }

  function complete(phase) {
    const stage=pending.get(phase);
    if (!stage) return;
    clearTimeout(stage.timer);
    pending.delete(phase);
    completed.add(phase);
    if (phase==='bootstrap') early?.stop?.();
    record(phase,'ok',stage.started);
  }

  function fail(phase,error) {
    const stage=pending.get(phase);
    if (!stage || stage.failed) return;
    clearTimeout(stage.timer);
    stage.failed=true;
    if (phase==='authorization') pending.delete(phase);
    const reason=startupFailure(error);
    record(phase,reason.why==='input_required'?'waiting':'failed',stage.started,reason);
  }

  if (early) begin('bootstrap',early.started);
  return {
    begin,complete,fail,
    failPending(error) { for (const phase of pending.keys()) fail(phase,error); },
    enable(serverAt) {
      if (enabled) return;
      if (Number.isSafeInteger(serverAt)) clockOffset=serverAt-clock();
      enabled=true;
      schedule();
    },
  };
}

export const startupDiagnostics=createStartupDiagnostics({early:globalThis.honeymoonStartupPage});
