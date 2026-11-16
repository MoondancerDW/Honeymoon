import {appendFile,lstat,mkdir,readdir,realpath,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';

const sampleIntervalMs = 30_000;
const retentionDays = 30;
const dayMs = 86_400_000;
const dayName = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const fileLimit = 8*1024*1024;
const playerEventLimit = 6*1024*1024;
const pendingLimit = 1024;
const latencyBounds = [1,2,4,8,16,24,32,48,64,96,128,192,256,384,512,768,1024,2048,4096,8192,16000];
const kinds = new Map([
  ['/api/action','actions'], ['/api/position','movement'], ['/api/teleport','teleports'],
  ['/api/presence','presence'], ['/api/seat','actions'],
  ['/api/chat','chat'], ['/api/npcs/action','npcActions'], ['/api/craft','crafting'],
  ['/api/session','access'], ['/api/access','access'], ['/api/access/owner','access'],
  ['/api/world','world'], ['/api/events','streams'], ['/api/ping','ping'],
]);
const comparablePath = path => process.platform==='win32' ? path.toLowerCase() : path;

function requestKind(path) {
  return kinds.get(path) ?? (path.startsWith('/api/admin/') ? 'administration' :
    path.startsWith('/api/') ? 'otherApi' :
    path.startsWith('/generated/') || path.startsWith('/skins/') ? 'gameAssets' : 'static');
}

function trafficWindow() {
  return {started:0,completed:0,clientErrors:0,serverErrors:0,aborted:0,byKind:{},
    latency:new Uint32Array(latencyBounds.length+1)};
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
  timeZone,intervalMs=sampleIntervalMs,cpuUsage=process.cpuUsage,memoryUsage=process.memoryUsage,
  onError=error=>console.error('Honeymoon load log:',error)}) {
  directory=resolve(directory);
  const format=new Intl.DateTimeFormat('en-GB',{timeZone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,timeZoneName:'longOffset'});
  const players=new Set();
  let traffic=trafficWindow(), pending=[], lost=0;
  let initialized=false, activeFile, activeBytes=0, lastPrunedDay;
  let sampleTimer, flushTimer, writing, closed;
  let previousClock, previousCpu;

  async function prune(day) {
    if (comparablePath(await realpath(directory))!==comparablePath(directory)) return;
    const cutoff=new Date(Date.parse(day+'T00:00:00Z')-(retentionDays-1)*dayMs).toISOString().slice(0,10);
    for (const entry of await readdir(directory,{withFileTypes:true})) {
      if (entry.isFile()&&dayName.test(entry.name)&&entry.name.slice(0,10)<cutoff) {
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
      if (!files.has(record.day)) files.set(record.day,[]);
      files.get(record.day).push(record);
    }
    for (const [day,entries] of files) {
      if (!lastPrunedDay||day>lastPrunedDay) {
        await prune(day).catch(onError);
        lastPrunedDay=day;
      }
      const file=join(directory,day+'.jsonl');
      if (activeFile!==file) {
        const info=await lstat(file).catch(error=>{
          if (error.code!=='ENOENT') throw error;
        });
        if (info&&!info.isFile()) throw new Error('Load log path is not an ordinary file');
        activeFile=file;
        activeBytes=info?.size??0;
      }
      const lines=[];
      let written=0;
      for (const entry of entries) {
        const size=Buffer.byteLength(entry.line);
        const limit=entry.playerEvent ? playerEventLimit : fileLimit;
        if (activeBytes+written+size>limit) {
          lost++;
          continue;
        }
        lines.push(entry.line);
        written+=size;
      }
      if (!written) continue;
      await appendFile(file,lines.join(''),{encoding:'utf8',flush:true,mode:0o600});
      activeBytes+=written;
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
      activeFile=undefined;
      onError(error);
    }).finally(()=>{
      writing=undefined;
      schedule();
    });
    return writing;
  }

  function record(event,fields={},playerEvent=false) {
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
    pending.push({day,line,playerEvent});
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
    const missedLogEntries=lost;
    traffic=trafficWindow();
    lost=0;
    record(event,{windowMs:Math.round(elapsed),cpuPercent:Math.round(microseconds/elapsed)/10,
      rssBytes:rss,heapUsedBytes:heapUsed,heapTotalBytes:heapTotal,openStreams:onlineStreams(),
      requests:{...requests,p95MsUpperBound:percentile(latency,requests.completed)},
      ...(missedLogEntries&&{missedLogEntries})});
  }

  return {
    start() {
      if (previousClock!==undefined||closed) return;
      previousClock=monotonic();
      previousCpu=cpuUsage();
      record('startup');
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
      traffic.started++;
      traffic.byKind[kind]=(traffic.byKind[kind]??0)+1;
      if (kind==='streams') return;
      const started=monotonic();
      response.once('finish',()=>{
        traffic.completed++;
        if (response.statusCode>=500) traffic.serverErrors++;
        else if (response.statusCode>=400) traffic.clientErrors++;
        const elapsed=monotonic()-started;
        const index=latencyBounds.findIndex(bound=>elapsed<=bound);
        traffic.latency[index<0?latencyBounds.length:index]++;
      });
      response.once('close',()=>{ if (!response.writableFinished) traffic.aborted++; });
    },
    sample,
    close() {
      if (closed) return closed;
      clearInterval(sampleTimer);
      sample('shutdown');
      clearTimeout(flushTimer);
      flushTimer=undefined;
      closed=(async()=>{
        while (writing||pending.length) await drain();
      })();
      return closed;
    },
  };
}
