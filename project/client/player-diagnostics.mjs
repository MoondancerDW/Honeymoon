import {connectionFailure} from './connection-report.mjs';

const interval = 10_000;
const maxSamples = 180;
const maxNetworkEvents = 24;
const pingBaselineWindow = 30_000;
const day = 86_400_000;
const stallThresholdMs = 900;
const kinds = {position:'movement', 'position-state':'movement', action:'actions', ping:'ping', presence:'presence'};
const pageToken = () => crypto.getRandomValues(new Uint32Array(2)).reduce((id,part)=>id+part.toString(16).padStart(8,'0'),'');
const cappedTime = value => Math.floor(Math.max(0, Math.min(day, value)));

export function createPlayerDiagnostics({clock=Date.now,monotonic=()=>performance.now(),send=body=>fetch('/api/player-diagnostics',{
  method:'POST',headers:{'Content-Type':'application/json'},keepalive:true,signal:AbortSignal.timeout(4000),body:JSON.stringify(body),
})}={}) {
  let page, sequence=0, scope, expiry, serverAnchor, monotonicAnchor, clockProbe, lastSample, lastFrame, ackAt, heartbeatAt, streamId, heartbeatTransitMs;
  let timer, sending=false, queue=[], droppedSamples=0, readGame;
  let frames=0, frameGapMs=0, longFrames=0, inputMs=0, maxQueued=0, reasons={};
  let lastX,lastY,lastZ,stall,stalls=[];
  const normal=new Map();
  let unusual=[];
  let network=[], pingLoss, sseLoss, browserLoss, sseReady, browserOnline;
  const pingHistory=[];
  const eventAt=(time=monotonic())=>Math.round(serverAnchor+time-monotonicAnchor);
  const offline=()=>globalThis.navigator?.onLine===false;
  const failureReason=error=>error===undefined ? undefined : error?.name==='AbortError' ? 'cancelled' : connectionFailure(error).why;

  function recordNetwork(event) {
    if (network.length===maxNetworkEvents) {
      const ordinary=network.findIndex(entry=>entry.state==='ok');
      if (ordinary<0 && event.state==='ok') return;
      network.splice(Math.max(0,ordinary),1);
    }
    network.push(event);
  }

  function browserStatus(online) {
    if (!active() || browserOnline===online) return;
    const now=monotonic();
    browserOnline=online;
    recordNetwork({kind:'browser',state:online?'online':'offline',at:eventAt(now),
      ...(online && browserLoss!==undefined && {durationMs:cappedTime(now-browserLoss)})});
    browserLoss=online?undefined:now;
  }

  function flushOnOnline() {
    browserStatus(true);
    void flush();
  }

  function recordOffline() {
    browserStatus(false);
  }

  function flushOnHide() {
    if (network.length || unusual.length || stalls.length) sample();
    else void flush();
  }

  function persist() {
    try {
      if (queue.length) sessionStorage.setItem(scope,JSON.stringify(queue));
      else sessionStorage.removeItem(scope);
    } catch { /* sessionStorage can be unavailable */ }
  }

  function stop() {
    clearInterval(timer);
    timer=undefined;
    removeEventListener('online',flushOnOnline);
    removeEventListener('offline',recordOffline);
    removeEventListener('pagehide',flushOnHide);
    queue=[];
    normal.clear();
    unusual=[];
    network=[];
    persist();
    page=undefined;
  }

  function active(now=monotonic()) {
    if (!page) return false;
    if (now<expiry) return true;
    stop();
    return false;
  }

  async function flush() {
    if (sending || !active() || !queue.length) return;
    const oldest=eventAt()-day;
    while (queue.length && queue[0].at<oldest) queue.shift();
    if (!queue.length) { persist(); return; }
    const samples=queue.slice(0,8);
    while (JSON.stringify({samples}).length>14_000 && samples.length>1) samples.pop();
    sending=true;
    try {
      const {status}=await send({samples});
      if (status===204 || status===400 || status===413) {
        queue=queue.filter(sample=>!samples.includes(sample));
        persist();
      } else if (status===401 || status===403 || status===404) stop();
    } catch { /* the next sample retries while offline */ }
    finally { sending=false; }
  }

  function sample() {
    const now=monotonic();
    if (!active(now)) return;
    const span=now-lastSample;
    const at=eventAt(now);
    const sample={at,page,clockOffsetMs:Math.max(-day,Math.min(day,at-clock())),spanMs:cappedTime(span),
      timerLateMs:cappedTime(span-interval),frames,longFrames,frameGapMs, inputMs,maxQueued,
      visible:!document.hidden,focused:document.hasFocus(),online:navigator.onLine,
      ...(lastFrame!==undefined&&{sinceFrameMs:cappedTime(now-lastFrame)}),
      ...(heartbeatAt!==undefined&&{lastHeartbeatAgoMs:cappedTime(now-heartbeatAt),heartbeatTransitMs,streamId}),
      ...(ackAt!==undefined&&{positionAckAgoMs:cappedTime(now-ackAt)}),
      ...readGame?.(),reasons,requests:[...normal.values(),...unusual],
      ...(stalls.length&&{stalls}),...(network.length&&{network}),droppedSamples};
    lastSample=now;
    frames=frameGapMs=longFrames=inputMs=maxQueued=0;
    reasons={};
    normal.clear();
    unusual=[];
    stalls=[];
    network=[];
    if (queue.length>=maxSamples) {
      queue.splice(1,1);
      droppedSamples++;
    }
    queue.push(sample);
    persist();
    void flush();
  }

  return {
    active,
    enable(config,uid,readState) {
      if (page || !Number.isSafeInteger(config?.until) || !Number.isSafeInteger(config?.serverAt) || config.until<=config.serverAt) return;
      lastSample=monotonicAnchor=monotonic();
      serverAnchor=config.serverAt;
      clockProbe=pingLoss=sseLoss=browserLoss=sseReady=undefined;
      browserOnline=!offline();
      pingHistory.length=0;
      expiry=lastSample+config.until-config.serverAt;
      page=pageToken();
      readGame=readState;
      scope=`honeymoon-player-diagnostics:${uid}:${config.until}`;
      try {
        for (const key of Object.keys(sessionStorage)) {
          if (key.startsWith('honeymoon-player-diagnostics:') && key!==scope) sessionStorage.removeItem(key);
        }
        const stored=JSON.parse(sessionStorage.getItem(scope));
        if (Array.isArray(stored)) queue=stored.slice(-maxSamples);
      } catch { /* continue when storage is unavailable */ }
      timer=setInterval(sample,interval);
      addEventListener('online',flushOnOnline);
      addEventListener('offline',recordOffline);
      addEventListener('pagehide',flushOnHide);
    },
    page:()=>active()?page:undefined,
    positionAck() {
      if (active()) ackAt=monotonic();
    },
    heartbeat({at,streamId:id}) {
      if (!active() || !Number.isSafeInteger(at) || !/^[a-f0-9]{16}$/.test(id)) return;
      heartbeatAt=monotonic();
      heartbeatTransitMs=cappedTime(eventAt(heartbeatAt)-at);
      streamId=id;
    },
    ping({started,status,error,reachable,serverAt}) {
      const now=monotonic();
      if (!active(now)) return;
      const rtt=cappedTime(now-started);
      if (reachable && Number.isSafeInteger(serverAt) && Math.abs(serverAt-eventAt(started))<300_000 &&
          (!clockProbe || now-clockProbe.at>=pingBaselineWindow || rtt<clockProbe.rtt)) {
        // A short RTT bounds the error of assigning the server timestamp to the midpoint.
        monotonicAnchor=started+(now-started)/2;
        serverAnchor=serverAt;
        clockProbe={at:now,rtt};
      }
      const event={kind:'ping',at:eventAt(started), ...(status!==undefined&&{status})};
      if (!reachable) {
        pingLoss??={started,missed:0};
        recordNetwork({...event,state:'lost',durationMs:rtt,missed:++pingLoss.missed,
          error:failureReason(error)??connectionFailure({status}).why});
        return;
      }
      while (pingHistory.length && pingHistory[0].at<now-pingBaselineWindow) pingHistory.shift();
      const ordered=pingHistory.map(entry=>entry.rtt).sort((a,b)=>a-b);
      const baseline=ordered[Math.floor(ordered.length/2)];
      const spike=rtt>=250 || ordered.length>=3 && rtt>=baseline+Math.max(50,baseline*.5);
      if (pingHistory.length===32) pingHistory.shift();
      pingHistory.push({at:now,rtt});
      recordNetwork({...event,state:pingLoss?'recovered':spike?'spike':'ok',rttMs:rtt,
        ...(baseline!==undefined&&{baselineMs:baseline}),
        ...(pingLoss&&{durationMs:cappedTime(now-pingLoss.started),missed:pingLoss.missed})});
      pingLoss=undefined;
    },
    stream(online,reason) {
      const now=monotonic();
      if (!active(now) || sseReady===online) return;
      sseReady=online;
      if (!online) {
        sseLoss=now;
        recordNetwork({kind:'sse',state:'lost',at:eventAt(now),error:reason??'network'});
        return;
      }
      recordNetwork({kind:'sse',state:sseLoss===undefined?'open':'recovered',at:eventAt(now),
        ...(sseLoss!==undefined&&{durationMs:cappedTime(now-sseLoss)})});
      sseLoss=undefined;
    },
    request(path,requestId) {
      const kind=kinds[path];
      if (!kind || !active()) return;
      const start=monotonic();
      const trace={id:`${page}.${++sequence}`,kind,startedAt:eventAt(start)};
      if (typeof requestId==='string' && /^[a-f0-9]{32}$/.test(requestId)) trace.group=requestId.slice(0,12);
      return {
        id:trace.id,
        headers(response) {
          trace.status=response.status;
          trace.headersMs=cappedTime(monotonic()-start);
        },
        finish(error) {
          if (!active()) return;
          trace.durationMs=cappedTime(monotonic()-start);
          if (error) trace.error=failureReason(error);
          if (!error && trace.status>=200 && trace.status<300 && kind==='movement') ackAt=monotonic();
          if (error || trace.status>=400 || trace.durationMs>=500) {
            if (unusual.length===8) unusual.shift();
            unusual.push(trace);
          } else normal.set(kind,trace);
        },
      };
    },
    frame(now,intended,reason,queued,{x,y,z}) {
      const gap=lastFrame===undefined?0:cappedTime(now-lastFrame);
      const moved=lastFrame!==undefined && (Math.abs(x-lastX)+Math.abs(y-lastY)+Math.abs(z-lastZ))>=.0001;
      lastX=x;
      lastY=y;
      lastZ=z;
      lastFrame=now;
      frames++;
      if (!document.hidden) {
        frameGapMs=Math.max(frameGapMs,gap);
        if (gap>=100) longFrames++;
      }
      maxQueued=Math.max(queued,maxQueued);
      const attempting=intended&&!document.hidden;
      if (attempting) {
        const observed=Math.min(100,gap);
        inputMs+=observed;
        if (!reason && !moved) reason='stationary';
        if (reason) reasons[reason]=(reasons[reason]??0)+observed;
      }
      const nextReason=attempting&&!moved ? reason : undefined;
      const record=change=>{
        if (stalls.length===8) stalls.shift();
        stalls.push(change);
      };
      if (stall && stall.reason!==nextReason) {
        if (stall.reported) record({kind:'end',at:eventAt(),reason:stall.reason,
          durationMs:cappedTime(now-stall.started),outcome:moved?'moved':nextReason?'changed':'input_ended'});
        stall=undefined;
      }
      if (!nextReason) return;
      stall??={reason:nextReason,started:now,reported:false};
      if (!stall.reported && now-stall.started>=stallThresholdMs) {
        stall.reported=true;
        record({kind:'start',at:eventAt(stall.started),reason:stall.reason});
      }
    },
  };
}
