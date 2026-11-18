import {createHmac,randomBytes} from 'node:crypto';
import {appendFile,lstat,mkdir,readdir,realpath,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {RequestError} from './errors.mjs';
import {diagnosticTracePattern} from './player-diagnostics.mjs';

const sampleIntervalMs = 30_000;
const retentionDays = 30;
const dayMs = 86_400_000;
const dayName = /^(?:player-)?(\d{4}-\d{2}-\d{2})\.jsonl$/;
const fileLimit = 8*1024*1024;
const playerEventLimit = 6*1024*1024;
const studyFileLimit = 16*1024*1024;
const pendingLimit = 1024;
const latencyBounds = [1,2,4,8,16,24,32,48,64,96,128,192,256,384,512,768,1024,2048,4096,8192,16000];
const maxReportedEvents = 16;
const futureSkewMs = 5*60_000;
const reportKinds = new Set(['ping_failed','ping_recovered','sse_error','sse_open','movement_failed','movement_recovered',
  'storage_failed','storage_recovered']);
const reportReasons = new Set(['timeout','network','http','offline','closed','position_pending']);
const reportFields = new Set(['kind','at','why','status','durationMs']);
const socketErrorCodes = new Set(['ECONNRESET','EPIPE','ETIMEDOUT','ERR_HTTP_REQUEST_TIMEOUT',
  'HPE_HEADER_OVERFLOW','HPE_CHUNK_EXTENSIONS_OVERFLOW','HPE_INVALID_METHOD','HPE_INVALID_URL',
  'HPE_INVALID_VERSION','HPE_INVALID_HEADER_TOKEN','HPE_INVALID_CONTENT_LENGTH','HPE_UNEXPECTED_CONTENT_LENGTH',
  'HPE_INVALID_TRANSFER_ENCODING','HPE_INVALID_CHUNK_SIZE','HPE_INVALID_EOF_STATE']);
const kinds = new Map([
  ['/api/action','actions'], ['/api/position','movement'], ['/api/teleport','teleports'],
  ['/api/presence','presence'], ['/api/seat','actions'],
  ['/api/chat','chat'], ['/api/npcs/action','npcActions'], ['/api/craft','crafting'],
  ['/api/session','access'], ['/api/access','access'], ['/api/access/owner','access'],
  ['/api/world','world'], ['/api/events','streams'], ['/api/ping','ping'],
  ['/api/connection-report','connectionReports'],
  ['/api/player-diagnostics','playerDiagnostics'],
]);
const studyKinds=new Set(['movement','actions','gameAssets','presence','teleports','ping','world']);
const studyReceiptLimit=2048;
const comparablePath = path => process.platform==='win32' ? path.toLowerCase() : path;

function requestKind(path) {
  return kinds.get(path) ?? (path.startsWith('/api/admin/') ? 'administration' :
    path.startsWith('/api/') ? 'otherApi' :
    path.startsWith('/generated/') || path.startsWith('/skins/') ? 'gameAssets' : 'static');
}

function trafficWindow() {
  return {started:0,completed:0,clientErrors:0,serverErrors:0,aborted:0,byKind:{},
    errorsByKind:{},abortedByKind:{},slowByKind:{},streamHandshakes:{opened:0,rejected:0,aborted:0},socketErrors:{},
    latency:new Uint32Array(latencyBounds.length+1)};
}

export function connectionReport(body, now=Date.now()) {
  const {events}=body;
  if (Object.keys(body).length!==1 || !Array.isArray(events) || !events.length || events.length>maxReportedEvents) {
    throw new RequestError(400,'invalid_connection_report');
  }
  for (const event of events) {
    if (!event||typeof event!=='object'||Array.isArray(event)||Object.keys(event).some(key=>!reportFields.has(key))||
        !reportKinds.has(event.kind)||!Number.isSafeInteger(event.at)||event.at<now-dayMs||event.at>now+futureSkewMs||
        (event.why!==undefined&&!reportReasons.has(event.why))||
        (event.status!==undefined&&(!Number.isInteger(event.status)||event.status<100||event.status>599))||
        (event.durationMs!==undefined&&(!Number.isInteger(event.durationMs)||event.durationMs<0||event.durationMs>dayMs))) {
      throw new RequestError(400,'invalid_connection_report');
    }
  }
  return events;
}

function percentile(counts,total) {
  if (!total) return null;
  const rank=Math.ceil(total*.95);
  let sum=0;
  for (let i=0;i<counts.length;i++) {
    sum+=counts[i];
    if (sum>=rank) return latencyBounds[i] ?? null;
  }
  return null;
}

export function createLoadLog({directory,onlineStreams=()=>0,now=Date.now,monotonic=()=>performance.now(),
  timeZone,intervalMs=sampleIntervalMs,cpuUsage=process.cpuUsage,memoryUsage=process.memoryUsage,studyUntil,
  onError=error=>console.error('Honeymoon load log:',error)}) {
  directory=resolve(directory);
  const format=new Intl.DateTimeFormat('en-GB',{timeZone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,timeZoneName:'longOffset'});
  const players=new Set();
  const loopDelay=monitorEventLoopDelay({resolution:20});
  const deviceHashKey=randomBytes(32);
  const liveStreams=new WeakMap();
  const reportCounts=new Map();
  const studyReportCounts=new Map();
  const studyTraffic=new Map();
  const studyReceipts=new Map();
  let traffic=trafficWindow(), pending=[], lost=0;
  let initialized=false, activeFiles=new Map(), lastPrunedDay;
  let sampleTimer, flushTimer, writing, closed;
  let previousClock, previousCpu;
  let reportWindow=0, reports=0;
  let studying=false;

  const deviceTag=id=>createHmac('sha256',deviceHashKey).update(id).digest('hex').slice(0,16);

  async function prune(day) {
    if (comparablePath(await realpath(directory))!==comparablePath(directory)) return;
    const cutoff=new Date(Date.parse(day+'T00:00:00Z')-(retentionDays-1)*dayMs).toISOString().slice(0,10);
    for (const entry of await readdir(directory,{withFileTypes:true})) {
      const date=dayName.exec(entry.name)?.[1];
      if (entry.isFile()&&date&&date<cutoff) {
        await unlink(join(directory,entry.name)).catch(onError);
      }
    }
  }

  async function writeBatch(records) {
    if (!initialized) {
      await mkdir(directory,{recursive:true,mode:0o700});
      initialized=true;
    }
    const files=new Map();
    for (const record of records) {
      const fileName=(record.study?'player-':'')+record.day+'.jsonl';
      if (!files.has(fileName)) files.set(fileName,[]);
      files.get(fileName).push(record);
    }
    for (const [fileName,entries] of files) {
      const day=entries[0].day;
      if (!lastPrunedDay||day>lastPrunedDay) {
        await prune(day).catch(onError);
        lastPrunedDay=day;
      }
      const file=join(directory,fileName);
      if (!activeFiles.has(file)) {
        const info=await lstat(file).catch(error=>{
          if (error.code!=='ENOENT') throw error;
        });
        if (info&&!info.isFile()) throw new Error('Load log path is not an ordinary file');
        if (activeFiles.size>=4) activeFiles.delete(activeFiles.keys().next().value);
        activeFiles.set(file,info?.size??0);
      }
      const activeBytes=activeFiles.get(file);
      const lines=[];
      let written=0;
      for (const entry of entries) {
        const size=Buffer.byteLength(entry.line);
        const limit=entry.study?studyFileLimit:entry.playerEvent?playerEventLimit:fileLimit;
        if (activeBytes+written+size>limit) {
          lost++;
          continue;
        }
        lines.push(entry.line);
        written+=size;
      }
      if (!written) continue;
      await appendFile(file,lines.join(''),{encoding:'utf8',flush:true,mode:0o600});
      activeFiles.set(file,activeBytes+written);
    }
  }

  function schedule() {
    if (!pending.length||flushTimer||writing||closed) return;
    flushTimer=setTimeout(()=>{
      flushTimer=undefined;
      void drain();
    },500);
    flushTimer.unref();
  }

  function drain() {
    if (writing||!pending.length) return writing;
    const batch=pending;
    pending=[];
    writing=writeBatch(batch).catch(error=>{
      lost+=batch.length;
      activeFiles.clear();
      onError(error);
    }).finally(()=>{
      writing=undefined;
      schedule();
    });
    return writing;
  }

  function record(event,fields={},playerEvent=false,study=false) {
    if (pending.length>=pendingLimit) {
      lost++;
      if (playerEvent) return;
      pending.shift();
    }
    const parts=Object.fromEntries(format.formatToParts(now()).map(({type,value})=>[type,value]));
    const day=`${parts.year}-${parts.month}-${parts.day}`;
    const offset=parts.timeZoneName.slice(3)||'+00:00';
    const timestamp=`${day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${offset}`;
    const line=JSON.stringify({timestamp,event,onlinePlayers:players.size,...fields})+'\n';
    pending.push({day,line,playerEvent,study});
    schedule();
  }

  function sample(event='sample') {
    if (previousClock===undefined||closed) return;
    const clock=monotonic();
    const usage=cpuUsage();
    const elapsed=Math.max(1,clock-previousClock);
    const microseconds=Math.max(0,usage.user+usage.system-previousCpu.user-previousCpu.system);
    previousClock=clock;
    previousCpu=usage;
    const {rss,heapUsed,heapTotal}=memoryUsage();
    const {latency,...requests}=traffic;
    const eventLoopDelayMs=loopDelay.count ? {
      p95:Math.round(loopDelay.percentile(95)/1e5)/10,max:Math.round(loopDelay.max/1e5)/10,
    } : null;
    loopDelay.reset();
    const missedLogEntries=lost;
    traffic=trafficWindow();
    lost=0;
    record(event,{windowMs:Math.round(elapsed),cpuPercent:Math.round(microseconds/elapsed)/10,
      rssBytes:rss,heapUsedBytes:heapUsed,heapTotalBytes:heapTotal,openStreams:onlineStreams(),
      eventLoopDelayMs,requests:{...requests,p95MsUpperBound:percentile(latency,requests.completed)},
      ...(missedLogEntries&&{missedLogEntries})});
    for (const [device,requests] of studyTraffic) {
      record('player_study_requests',{device,windowMs:Math.round(elapsed),requests, eventLoopDelayMs},true,true);
    }
    studyTraffic.clear();
    if (studying && now()>=studyUntil) {
      studying=false;
      studyReceipts.clear();
      record('player_study_expired',{until:studyUntil},true,true);
    }
  }

  function recordStudyRequest(path,response,deviceId,trace) {
    if (previousClock===undefined || closed) return;
    const kind=requestKind(path);
    if (!studyKinds.has(kind)) return;
    const device=deviceTag(deviceId), started=monotonic();
    function counts() {
      if (!studyTraffic.has(device)) {
        if (studyTraffic.size>=32) studyTraffic.delete(studyTraffic.keys().next().value);
        studyTraffic.set(device,{});
      }
      const requests=studyTraffic.get(device);
      return requests[kind]??={started:0,completed:0,aborted:0,maxMs:0,statuses:{}};
    }
    counts().started++;
    let receipt;
    if (typeof trace==='string' && diagnosticTracePattern.test(trace)) {
      if (studyReceipts.size>=studyReceiptLimit) studyReceipts.delete(studyReceipts.keys().next().value);
      receipt={kind,receivedAt:now()};
      studyReceipts.set(device+':'+trace,receipt);
    }
    function finish(aborted) {
      if (closed) return;
      const tally=counts(), durationMs=Math.round(monotonic()-started);
      tally.maxMs=Math.max(tally.maxMs,durationMs);
      if (aborted) tally.aborted++;
      else {
        tally.completed++;
        const status=response.statusCode;
        tally.statuses[status]=(tally.statuses[status]??0)+1;
      }
      if (receipt) Object.assign(receipt,{finishedAt:now(),durationMs,aborted,...(!aborted&&{status:response.statusCode})});
    }
    response.once('finish',()=>finish(false));
    response.once('close',()=>{if (!response.writableFinished) finish(true);});
  }

  return {
    start() {
      if (previousClock!==undefined||closed) return;
      previousClock=monotonic();
      previousCpu=cpuUsage();
      loopDelay.enable();
      record('startup');
      studying=Number.isSafeInteger(studyUntil) && now()<studyUntil;
      if (studying) record('player_study_started',{until:studyUntil},true,true);
      if (intervalMs>0) {
        sampleTimer=setInterval(sample,intervalMs);
        sampleTimer.unref();
      }
    },
    player(player,online) {
      if (previousClock===undefined||closed||players.has(player)===online) return;
      if (online) players.add(player);
      else players.delete(player);
      record(online?'player_join':'player_leave',{},true);
    },
    request(path,response) {
      if (previousClock===undefined||closed) return;
      const kind=requestKind(path);
      const handshake=kind==='streams';
      traffic.started++;
      traffic.byKind[kind]=(traffic.byKind[kind]??0)+1;
      const started=monotonic();
      response.once('finish',()=>{
        if (liveStreams.has(response)) return;
        const status=response.statusCode;
        traffic.completed++;
        if (handshake) traffic.streamHandshakes.rejected++;
        if (status>=400 && status<=599) {
          if (status>=500) traffic.serverErrors++;
          else traffic.clientErrors++;
          const errors=traffic.errorsByKind[kind]??={};
          errors[status]=(errors[status]??0)+1;
        }
        const elapsed=monotonic()-started;
        if (elapsed>=500) {
          const slow=traffic.slowByKind[kind]??={count:0,maxMs:0};
          slow.count++;
          slow.maxMs=Math.max(slow.maxMs,Math.round(elapsed));
        }
        const index=latencyBounds.findIndex(bound=>elapsed<=bound);
        traffic.latency[index<0?latencyBounds.length:index]++;
      });
      response.once('close',()=>{
        if (liveStreams.has(response)||response.writableFinished) return;
        if (handshake) traffic.streamHandshakes.aborted++;
        traffic.aborted++;
        traffic.abortedByKind[kind]=(traffic.abortedByKind[kind]??0)+1;
      });
    },
    openStream(response,deviceId,presence,study) {
      if (previousClock===undefined||closed) return;
      const streamId=randomBytes(8).toString('hex');
      const device=deviceTag(deviceId);
      const opened=monotonic();
      const row={streamId,device,presence};
      const stream={reason:null};
      liveStreams.set(response,stream);
      traffic.streamHandshakes.opened++;
      record('sse_open',row,true);
      if (study) record('player_study_sse_open',{...row,page:study.page},true,true);
      response.once('close',()=>{
        const reason=stream.reason??(response.writableFinished?'finished':'transport_closed');
        const at=monotonic();
        const fields={...row,durationMs:Math.round(at-opened),reason,
          ...(stream.heartbeatAt!==undefined&&{lastHeartbeatAgoMs:Math.round(at-stream.heartbeatAt)})};
        record('sse_close',fields,true);
        if (study && now()<study.until) record('player_study_sse_close',{...fields,page:study.page},true,true);
      });
      return streamId;
    },
    heartbeat(response) {
      const stream=liveStreams.get(response);
      if (stream&&!response.destroyed&&!response.writableEnded) stream.heartbeatAt=monotonic();
    },
    endStream(response,reason) {
      const stream=liveStreams.get(response);
      if (stream) stream.reason??=reason;
    },
    socketError(code) {
      if (previousClock===undefined||closed) return;
      const kind=socketErrorCodes.has(code)?code:'other';
      traffic.socketErrors[kind]=(traffic.socketErrors[kind]??0)+1;
    },
    clientReport(deviceId,events,study=false) {
      if (previousClock===undefined||closed) return;
      const minute=Math.floor(monotonic()/60_000);
      if (minute!==reportWindow) {
        reportWindow=minute;
        reportCounts.clear();
        studyReportCounts.clear();
        reports=0;
      }
      const count=reportCounts.get(deviceId)??0;
      if (count>=4||reports>=128) throw new RequestError(429,'connection_report_limit');
      reportCounts.set(deviceId,count+1);
      reports++;
      const fields={device:deviceTag(deviceId),events};
      record('client_connection',fields,true);
      if (study) record('player_study_connection',fields,true,true);
    },
    studyRequest:recordStudyRequest,
    studyHeartbeat(deviceId,streamId,page,at) {
      record('player_study_sse_heartbeat',{device:deviceTag(deviceId),streamId,page:page||null,at},true,true);
    },
    studyClientReport(deviceId,samples) {
      if (previousClock===undefined || closed) return;
      const minute=Math.floor(monotonic()/60_000);
      if (minute!==reportWindow) {
        reportWindow=minute;
        reportCounts.clear();
        studyReportCounts.clear();
        reports=0;
      }
      const count=studyReportCounts.get(deviceId)??0;
      if (count>=12 || studyReportCounts.size>=32 && !studyReportCounts.has(deviceId)) throw new RequestError(429,'player_diagnostics_limit');
      studyReportCounts.set(deviceId,count+1);
      const device=deviceTag(deviceId);
      const linked=samples.map(sample=>({...sample,requests:sample.requests.map(trace=>{
        const receipt=studyReceipts.get(device+':'+trace.id);
        return {...trace,server:receipt??null};
      })}));
      record('player_study_client',{device,samples:linked},true,true);
    },
    sample,
    close() {
      if (closed) return closed;
      clearInterval(sampleTimer);
      sample('shutdown');
      loopDelay.disable();
      clearTimeout(flushTimer);
      flushTimer=undefined;
      closed=(async()=>{
        while (writing||pending.length) await drain();
      })();
      return closed;
    },
  };
}
