import {createReadStream} from 'node:fs';
import {lstat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createInterface} from 'node:readline';

const dayMs=86_400_000;
const recentLimit=180;
const incidentLimit=1000;
const outputIncidentLimit=300;
const matchToleranceMs=1500;
const episodeJoinMs=2500;
const playerPattern=/^[a-f0-9]{20}$/;
const logName=/^(player-)?(\d{4}-\d{2}-\d{2})(?:\.previous)?\.jsonl$/;
const overlaps=(start,end,rowStart,rowEnd)=>rowStart<=end && rowEnd>=start;

function eventInterval(event) {
  const {at,kind,state}=event;
  const duration=event.durationMs??event.rttMs??0;
  if (!Number.isSafeInteger(at) || !Number.isFinite(duration)) return;
  if (state==='spike' || state==='lost' || state==='offline') {
    return [at,at+(kind==='ping'?duration:0)];
  }
  if (duration>0 && (state==='recovered' || state==='online')) return [at-duration,at];
}

function traceInterval(trace) {
  const {startedAt,durationMs,error,status}=trace;
  if (!Number.isSafeInteger(startedAt) || !Number.isFinite(durationMs) || error==='cancelled') return;
  if (error || status>=500 || durationMs>=500) return [startedAt,startedAt+durationMs];
}

function newPlayer(player) {
  return {player,samples:0,lastSeenAt:0,ping:{probes:0,successes:0,spikes:0,losses:0,maxMs:0},
    sse:{losses:0,reconnects:0},browserOffline:0, totalRtt:0};
}

function observePlayer(summary,event) {
  if (event.kind==='ping') {
    const ping=summary.ping;
    ping.probes++;
    if (event.state==='spike') ping.spikes++;
    if (event.state==='lost') ping.losses++;
    if (Number.isFinite(event.rttMs) && event.state!=='lost') {
      ping.successes++;
      ping.maxMs=Math.max(ping.maxMs,event.rttMs);
      summary.totalRtt+=event.rttMs;
    }
  } else if (event.kind==='sse') {
    if (event.state==='lost') summary.sse.losses++;
    if (event.state==='recovered') summary.sse.reconnects++;
  } else if (event.kind==='browser' && event.state==='offline') summary.browserOffline++;
}

function makeIncidents(points,from,to) {
  const byPlayer=new Map();
  for (const point of points.sort((a,b)=>a.start-b.start)) {
    const episodes=byPlayer.get(point.player)??[];
    if (!byPlayer.has(point.player)) byPlayer.set(point.player,episodes);
    const previous=episodes.at(-1);
    const episode=previous && point.start<=previous.end+episodeJoinMs ? previous : {
      player:point.player,start:Math.max(from,point.start),end:0,
      devices:new Set(),kinds:new Set(),events:[],maxRttMs:0,maxFrameGapMs:0,
      clientRequests:[],count:0,
    };
    if (previous!==episode) episodes.push(episode);
    episode.end=Math.min(to,Math.max(episode.end,point.end));
    episode.devices.add(point.device);
    episode.kinds.add(point.kind);
    episode.maxRttMs=Math.max(episode.maxRttMs,point.event?.rttMs??0);
    episode.maxFrameGapMs=Math.max(episode.maxFrameGapMs,point.frameGapMs??0);
    episode.count++;
    if (point.event && episode.events.length<32) episode.events.push(point.event);
    if (point.trace && episode.clientRequests.length<24) episode.clientRequests.push(point.trace);
  }
  return [...byPlayer.values()].flat().sort((a,b)=>a.start-b.start);
}

function sharedIncidents(incidents,from,to) {
  const boundaries=new Map();
  for (const [index,incident] of incidents.entries()) {
    const start=Math.max(from,incident.start-matchToleranceMs);
    const end=Math.min(to,incident.end+matchToleranceMs);
    for (const [at,adding] of [[start,true],[end+1,false]]) {
      const changes=boundaries.get(at)??[];
      if (!boundaries.has(at)) boundaries.set(at,changes);
      changes.push({index,adding});
    }
  }
  const times=[...boundaries.keys()].sort((a,b)=>a-b), active=new Set(), groups=[];
  for (const [index,at] of times.entries()) {
    for (const {index:id,adding} of boundaries.get(at)) {
      if (adding) active.add(id);
      else active.delete(id);
    }
    if (active.size<2 || index===times.length-1) continue;
    const players=[...new Set([...active].map(id=>incidents[id].player))].sort();
    if (players.length<2) continue;
    const previous=groups.at(-1);
    if (previous && previous.end+1===at && previous.players.join(',')===players.join(',')) {
      previous.end=times[index+1]-1;
      for (const id of active) previous.incidents.add(id);
    } else groups.push({start:at,end:times[index+1]-1,players,incidents:new Set(active)});
  }
  return groups.map(group=>({...group,incidents:[...group.incidents].map(index=>incidents[index].id)}));
}

async function* logRows(directory,from,to,{studyFileLimit,fileLimit}) {
  let files;
  try { files=await readdir(directory,{withFileTypes:true}); }
  catch (error) { if (error.code==='ENOENT') return; throw error; }
  for (const entry of files.sort((a,b)=>a.name.localeCompare(b.name))) {
    const match=logName.exec(entry.name);
    if (!entry.isFile() || !match) continue;
    // Filenames are local dates, while observations use epoch UTC.
    const date=Date.parse(match[2]+'T00:00:00Z');
    if (!Number.isFinite(date) || date<from-2*dayMs || date>to+dayMs) continue;
    const path=join(directory,entry.name), file=await lstat(path).catch(error=>{
      if (error.code!=='ENOENT') throw error;
    });
    if (!file?.isFile() || !file.size) continue;
    const stream=createReadStream(path,{encoding:'utf8',end:Math.min(file.size,match[1]?studyFileLimit:fileLimit)-1});
    const lines=createInterface({input:stream,crlfDelay:Infinity});
    try {
      for await (const line of lines) {
        if (!line || line.length>64*1024) continue;
        let row;
        try { row=JSON.parse(line); } catch { continue; }
        const time=Date.parse(row?.timestamp);
        if (time>=from && time<=to) yield {time,row};
      }
    } finally { lines.close(); stream.destroy(); }
  }
}

function evidenceFor(incident,probes,resources,streams) {
  const {start,end,devices}=incident;
  const probeRows=probes.filter(probe=>probe.at>=start-10_000 && probe.at<=end+10_000);
  const windows=resources.filter(row=>overlaps(start,end,row.at-(row.windowMs??30_000),row.at));
  const closed=streams.filter(row=>row.event==='player_study_sse_close' && devices.has(row.device) &&
    row.at>=start-matchToleranceMs && row.at<=end+matchToleranceMs);
  return {
    nearbyServerProbes:probeRows.length,
    originFailures:probeRows.filter(row=>row.local?.ok===false).length,
    publicFailuresWithOriginUp:probeRows.filter(row=>row.local?.ok===true && row.public?.ok===false).length,
    publicFailuresWithInternetUp:probeRows.filter(row=>row.local?.ok===true && row.internet?.ok===true && row.public?.ok===false).length,
    remoteFailuresWithOriginUp:probeRows.filter(row=>row.local?.ok===true && row.internet?.ok===false && row.public?.ok===false).length,
    internetFailures:probeRows.filter(row=>row.internet?.ok===false).length,
    dnsFailures:probeRows.filter(row=>row.dns?.error).length,
    largestServerLoopDelayMs:Math.max(0,...windows.map(row=>row.eventLoopDelayMs?.max??0)),
    recentServerErrors:windows.reduce((total,row)=>total+(row.requests?.serverErrors??0),0),
    serverSocketErrors:windows.reduce((total,row)=>total+Object.values(row.requests?.socketErrors??{}).reduce((n,count)=>n+count,0),0),
    serverStreamCloses:closed.slice(-12),
    clientErrorsWithServerSuccess:incident.clientRequests.filter(trace=>trace.error && trace.server?.status<400).length,
    clientErrorsWithoutRetainedServerReceipt:incident.clientRequests.filter(trace=>trace.error && !trace.server).length,
    abortedServerRequests:incident.clientRequests.filter(trace=>trace.server?.aborted).length,
  };
}

export async function reviewNetworkDiagnostics(directory,{now=Date.now(),hours=6,studyFileLimit=32*1024*1024,
  fileLimit=8*1024*1024}={}) {
  const from=now-hours*3_600_000, probes=[], resources=[], streams=[], points=[];
  const playerTotals=new Map(), seenSamples=new Set();
  let discardedPoints=0;
  function addPoint(range,record) {
    if (!range || !overlaps(from,now,...range)) return;
    // Keep the most recent observations even when older offline uploads arrive later.
    points.push({start:range[0],end:range[1],...record});
    if (points.length>2*incidentLimit) {
      points.sort((a,b)=>a.start-b.start);
      points.splice(0,incidentLimit);
      discardedPoints+=incidentLimit;
    }
  }
  for await (const {time,row} of logRows(directory,from,now,{studyFileLimit,fileLimit})) {
    const {event,player,device}=row;
    if (event==='server_network_probe') probes.push({...row,at:Number.isSafeInteger(row.at)?row.at:time});
    if (event==='sample' || event==='shutdown') resources.push({...row,at:time});
    if (event==='player_study_sse_open' || event==='player_study_sse_close') streams.push({...row,at:time});
    if (event!=='player_study_client' || !playerPattern.test(player??'')) continue;
    const summary=playerTotals.get(player)??newPlayer(player);
    if (!playerTotals.has(player)) playerTotals.set(player,summary);
    for (const sample of row.samples??[]) {
      if (!overlaps(from,now,sample.at,sample.at)) continue;
      const sampleId=`${player}:${sample.page}:${sample.at}`;
      if (seenSamples.has(sampleId)) continue;
      if (seenSamples.size>=65_536) seenSamples.delete(seenSamples.values().next().value);
      seenSamples.add(sampleId);
      summary.samples++;
      summary.lastSeenAt=Math.max(summary.lastSeenAt,sample.at);
      const base={player,device,frameGapMs:sample.visible?sample.frameGapMs:0};
      for (const measurement of sample.network??[]) {
        if (!overlaps(from,now,measurement.at,measurement.at)) continue;
        observePlayer(summary,measurement);
        addPoint(eventInterval(measurement),{...base,kind:measurement.kind,event:measurement});
      }
      for (const trace of sample.requests??[]) addPoint(traceInterval(trace),{...base,kind:trace.kind,trace});
    }
  }
  const all=makeIncidents(points,from,now), selected=all.slice(-outputIncidentLimit);
  const players=[...playerTotals.values()].sort((a,b)=>a.player.localeCompare(b.player)).map(({totalRtt,...row})=>({
    ...row,ping:{...row.ping,averageMs:row.ping.successes?Math.round(totalRtt/row.ping.successes):null},
  }));
  const incidents=selected.map((incident,id)=>{
    const evidence=evidenceFor(incident,probes,resources,streams);
    return {...incident,id,devices:[...incident.devices],kinds:[...incident.kinds],evidence};
  });
  const missedLogEntries=resources.reduce((total,row)=>total+(row.missedLogEntries??0),0);
  const archivesRotated=resources.reduce((total,row)=>total+(row.archivesRotated??0),0);
  return {generatedAt:now,from,matchToleranceMs,players,limits:{dailyDetailedBytes:studyFileLimit,missedLogEntries,archivesRotated,
    observationsTruncated:missedLogEntries>0||archivesRotated>0||discardedPoints>0||all.length>selected.length},
    incidents,sharedIncidents:sharedIncidents(incidents,from,now),
    server:{probes:probes.sort((a,b)=>a.at-b.at).slice(-recentLimit),
      resources:resources.sort((a,b)=>a.at-b.at).slice(-recentLimit),
      streams:streams.sort((a,b)=>a.at-b.at).slice(-recentLimit)}};
}
