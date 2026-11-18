import {createReadStream} from 'node:fs';
import {readdir, rename, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {parseArgs} from 'node:util';

async function* rows(file) {
  const stream=createReadStream(file,'utf8');
  const lines=createInterface({input:stream,crlfDelay:Infinity});
  for await (const line of lines) {
    if (!line) continue;
    try { yield JSON.parse(line); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
}

function freeze(sample) {
  if (!sample.visible) return null;
  if (sample.inputMs>=1000 && sample.reasons?.queue_full>=1000) return 'movement_queue_full';
  if ((sample.frameGapMs??0)>=500 || (sample.sinceFrameMs??0)>=1000 || (sample.timerLateMs??0)>=2000) {
    return 'client_frames_delayed';
  }
  if (sample.inputMs>=1500 && sample.reasons?.stationary>=1500) return 'no_displacement_with_input';
  return null;
}

const date = value=>new Date(value).toISOString();
const unavailable = response=>response?.error || response?.status!==204;
const extend = (incident,start,end)=>{incident.start=Math.min(incident.start,start);incident.end=Math.max(incident.end,end);};

export async function reviewPlayerNetwork({playerLogs,hostLog,output}) {
  const checks=[];
  let since=-Infinity, until, updated=0;
  for await (const row of rows(hostLog)) {
    if (row.event==='start') {
      since=Math.max(since,Date.parse(row.studyStartedAt??row.timestamp));
      until=row.until;
    }
    if (row.event==='sample') {
      const at=Date.parse(row.startedAt??row.timestamp);
      if (Number.isFinite(at)) checks.push({...row,at});
      updated=Math.max(updated,at);
    }
  }
  checks.sort((a,b)=>a.at-b.at);
  const files=(await readdir(playerLogs)).filter(name=>/^player-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
  const sessions=new Map(), openIncidents=new Map(), incidents=[];
  const serverRequests=[], transitions=[];
  let sampleCount=0, pingFailures=0, streamErrors=0, streamCloses=0, requestFailures=0, lastSample=null;
  for (const name of files) for await (const row of rows(join(playerLogs,name))) {
    if (Date.parse(row.timestamp)<since) continue;
    if (row.event==='player_study_requests') { serverRequests.push(row); continue; }
    if (row.event==='player_study_sse_close') streamCloses++;
    if (row.event==='player_study_connection') for (const item of row.events??[]) {
      if (item.kind==='ping_failed') pingFailures++;
      if (item.kind==='sse_error') streamErrors++;
    }
    if (row.event!=='player_study_client') continue;
    for (const sample of row.samples??[]) {
      if (sample.at<since) continue;
      sampleCount++;
      lastSample=Math.max(lastSample??sample.at,sample.at);
      for (const change of sample.stalls??[]) {
        transitions.push({...change,at:date(change.at),device:row.device,page:sample.page});
        if (transitions.length>500) transitions.shift();
      }
      const key=row.device+':'+sample.page;
      const session=sessions.get(key)??{device:row.device,page:sample.page,start:sample.at,end:sample.at,samples:0};
      extend(session,sample.at,sample.at);
      session.samples++;
      sessions.set(key,session);
      const failed=(sample.requests??[]).filter(request=>request.error || request.status>=400);
      requestFailures+=failed.length;
      const reason=freeze(sample);
      const open=openIncidents.get(key);
      if (!reason) { openIncidents.delete(key); continue; }
      const start=sample.at-(sample.spanMs??10_000);
      const incident=open && open.reason===reason && start<=open.end+5000 ? open : {
        device:row.device,page:sample.page,reason,start,end:sample.at,samples:0,heldInputMs:0,blockedMs:0,
        frameGapMs:0,maxQueue:0,longestWaitForPositionMs:0,failedRequests:[],requestFailures:0,
      };
      if (incident!==open) {
        openIncidents.set(key,incident);
        incidents.push(incident);
      }
      extend(incident,start,sample.at);
      incident.samples++;
      incident.heldInputMs+=sample.inputMs??0;
      incident.blockedMs+=sample.reasons?.[reason==='movement_queue_full'?'queue_full':'stationary']??0;
      incident.frameGapMs=Math.max(incident.frameGapMs,sample.frameGapMs??0,sample.sinceFrameMs??0);
      incident.maxQueue=Math.max(incident.maxQueue,sample.maxQueued??0);
      incident.longestWaitForPositionMs=Math.max(incident.longestWaitForPositionMs,sample.positionAckAgoMs??0);
      incident.requestFailures+=failed.length;
      incident.failedRequests.push(...failed.slice(0,Math.max(0,18-incident.failedRequests.length)));
    }
  }
  const review=incidents.slice(-300).map(incident=>{
    const {start,end}=incident;
    const host=checks.filter(row=>row.at>=start-35_000 && row.at<=end+35_000);
    const application=serverRequests.filter(row=>row.device===incident.device && Date.parse(row.timestamp)>=start &&
      Date.parse(row.timestamp)-(row.windowMs??30_000)<=end);
    const evidence={
      clientDelay:incident.frameGapMs>=500,
      noRecordedServerArrival:incident.failedRequests.filter(trace=>trace.error && trace.server===null).length,
      clientErrorAfterServerFinished:incident.failedRequests.filter(trace=>trace.error && trace.server?.status>=200 &&
        trace.server.status<300).length,
      serverAborted:incident.failedRequests.filter(trace=>trace.server?.aborted).length,
      serverRejected:incident.failedRequests.filter(trace=>trace.server?.status>=400).length,
    };
    return {...incident,start:date(start),end:date(end),observationWindowMs:end-start,
      evidence,
      hostChecks:host.length,originFailures:host.filter(row=>unavailable(row.local)).length,
      relayFailuresWithOriginUp:host.filter(row=>!unavailable(row.local) && unavailable(row.public)).length,
      gatewayMisses:host.filter(row=>row.gateway?.error).length,publicInternetMisses:host.filter(row=>row.external?.error).length,
      appWindows:application.map(row=>({timestamp:row.timestamp,requests:row.requests,eventLoopDelayMs:row.eventLoopDelayMs})).slice(-8)};
  });
  const data={updatedAt:date(Date.now()),startsAt:Number.isFinite(since)?date(since):null,until,
    host:{samples:checks.length,lastAt:updated?date(updated):null,originFailures:checks.filter(row=>unavailable(row.local)).length,
      relayFailuresWithOriginUp:checks.filter(row=>!unavailable(row.local) && unavailable(row.public)).length},
    player:{sessions:[...sessions.values()].slice(-50).map(session=>({...session,start:date(session.start),end:date(session.end)})),
      sampleCount,lastSample:lastSample===null?null:date(lastSample),pingFailures,streamErrors,streamCloses,requestFailures},
    incidentCount:incidents.length,incidents:review,recentStallTransitions:transitions};
  const temporary=output+'.'+process.pid+'.tmp';
  await writeFile(temporary,JSON.stringify(data,null,2)+'\n');
  await rename(temporary,output);
  return data;
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase()===resolve(process.argv[1]).toLowerCase()) {
  const {values}=parseArgs({options:{'player-logs':{type:'string'},'host-log':{type:'string'},
    output:{type:'string'},until:{type:'string'}}});
  const deadline=values.until ? Date.parse(values.until) : 0;
  if (!values['player-logs'] || !values['host-log'] || !values.output || !Number.isFinite(deadline)) {
    throw new Error('Use --player-logs DIRECTORY --host-log FILE --output FILE [--until ISO_TIMESTAMP]');
  }
  do {
    try {
      const report=await reviewPlayerNetwork({playerLogs:values['player-logs'],hostLog:values['host-log'],output:values.output});
      console.log(JSON.stringify({hostSamples:report.host.samples,playerSamples:report.player.sampleCount,incidents:report.incidentCount}));
    } catch (error) {
      if (Date.now()>=deadline) throw error;
      console.error(error.message);
    }
    const remaining=deadline-Date.now();
    if (remaining<=0) break;
    await delay(Math.min(remaining,30*60_000));
  } while (true);
}
