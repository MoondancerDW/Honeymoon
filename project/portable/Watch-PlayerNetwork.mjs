import {execFile} from 'node:child_process';
import {appendFile, mkdir} from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import {isIPv4} from 'node:net';
import {cpus, freemem, totalmem} from 'node:os';
import {dirname, resolve} from 'node:path';
import {parseArgs, promisify} from 'node:util';

const run = promisify(execFile);
const {values} = parseArgs({options:{
  local:{type:'string',default:'http://127.0.0.1:4173'}, site:{type:'string'}, relay:{type:'string'},
  gateway:{type:'string'}, output:{type:'string'}, until:{type:'string'}, interval:{type:'string',default:'30000'},
}});
const site = new URL(values.site);
const local = new URL(values.local);
const until = Date.parse(values.until);
const interval = Number(values.interval);
if (site.protocol !== 'https:' || local.protocol !== 'http:' || local.hostname !== '127.0.0.1' ||
    !isIPv4(values.relay) || (values.gateway && !isIPv4(values.gateway)) || !values.output ||
    !Number.isFinite(until) || until <= Date.now() || !Number.isInteger(interval) || interval < 5000) {
  throw new Error('Use --site HTTPS_ORIGIN --relay IPV4 [--gateway IPV4] --output FILE --until ISO_TIMESTAMP');
}

const log = resolve(values.output);
const localAgent = new http.Agent({keepAlive:true,maxSockets:1});
const publicAgent = new https.Agent({keepAlive:true,maxSockets:1,lookup(_host, options, callback) {
  if (options.all) callback(null,[{address:values.relay,family:4}]);
  else callback(null,values.relay,4);
}});
const probeTimeout = 4000;

function probe(origin, agent) {
  return new Promise(done=>{
    const start = performance.now();
    const transport = origin.protocol === 'https:' ? https : http;
    const finish = (fields)=>done({ms:Math.round(performance.now()-start),...fields});
    const request = transport.get(new URL('/api/ping',origin),{agent,signal:AbortSignal.timeout(probeTimeout)},response=>{
      response.resume();
      response.once('end',()=>finish({status:response.statusCode,reused:request.reusedSocket}));
      response.once('error',error=>finish({error:error.code??'read_failed'}));
    });
    request.once('error',error=>finish({error:error.code==='ABORT_ERR'?'timeout':error.code??'request_failed'}));
  });
}

async function ping(ip) {
  try {
    const {stdout}=await run('ping.exe',['-n','1','-w','1000',ip],{windowsHide:true,timeout:3000});
    const reply = /[=<]\s*(\d+)[^\r\n\d]*TTL\s*=/i.exec(stdout);
    return reply ? {ms:Number(reply[1])} : {error:'no_reply'};
  } catch (error) {
    return {error:error.killed?'timeout':'no_reply'};
  }
}

function cpuTimes() {
  let total=0,idle=0;
  for (const cpu of cpus()) {
    idle+=cpu.times.idle;
    total+=Object.values(cpu.times).reduce((sum,value)=>sum+value,0);
  }
  return {total,idle};
}

await mkdir(dirname(log),{recursive:true});
async function write(record) {
  await appendFile(log,JSON.stringify({timestamp:new Date().toISOString(),...record})+'\n');
}
await write({event:'start',until:new Date(until).toISOString(),intervalMs:interval,relay:values.relay});
let previous=cpuTimes();
try {
  while (Date.now()<until) {
    const started=Date.now();
    const times=cpuTimes();
    const elapsed=times.total-previous.total;
    const cpuPercent=elapsed ? Math.round(1000*(1-(times.idle-previous.idle)/elapsed))/10 : null;
    previous=times;
    const [localResponse,publicResponse,route,external]=await Promise.all([
      probe(local,localAgent),probe(site,publicAgent), values.gateway ? ping(values.gateway) : null,ping('1.1.1.1'),
    ]);
    await write({event:'sample',startedAt:new Date(started).toISOString(),tookMs:Date.now()-started,
      local:localResponse,public:publicResponse,gateway:route,external,cpuPercent,
      ramUsedPercent:Math.round(1000*(1-freemem()/totalmem()))/10});
    const remaining=Math.min(until,started+interval)-Date.now();
    if (remaining>0) await new Promise(done=>setTimeout(done,remaining));
  }
  await write({event:'end'});
} finally {
  localAgent.destroy();
  publicAgent.destroy();
}
