import http from 'node:http';
import https from 'node:https';
import {isIPv4} from 'node:net';

const intervalMs = 10_000;
const timeoutMs = 4_000;
const internetCheck = new URL('https://www.cloudflare.com/robots.txt');

function isPublicIPv4(address) {
  if (!isIPv4(address)) return false;
  const [a,b]=address.split('.').map(Number);
  return a>0 && a<224 && ![10,127].includes(a) && !(a===100 && b>=64 && b<=127) &&
    !(a===169 && b===254) && !(a===172 && b>=16 && b<=31) && !(a===192 && b===168);
}

function failureCode(error) {
  if (error.name==='TimeoutError' || error.code==='ABORT_ERR') return 'timeout';
  return error.cause?.code ?? error.code ?? 'request_failed';
}

function routeAgent(address) {
  return new https.Agent({keepAlive:true,maxSockets:1,lookup(_host,options,done) {
    if (options.all) done(null,[{address,family:4}]);
    else done(null,address,4);
  }});
}

function requestTiming(url, agent, shutdown, status) {
  const transport=url.protocol==='https:' ? https : http;
  const signal=AbortSignal.any([shutdown,AbortSignal.timeout(timeoutMs)]);
  return new Promise(resolve=>{
    const started=performance.now();
    const elapsed=()=>Math.round(performance.now()-started);
    let connectMs,tlsMs;
    const request=transport.request(url,{method:'HEAD',agent,signal},response=>{
      response.once('error',fail);
      response.once('end',()=>finish({status:response.statusCode,ok:response.statusCode===status}));
      response.resume();
    });
    const finish=result=>resolve({ms:elapsed(),reused:request.reusedSocket,
      ...(connectMs!==undefined&&{connectMs}),...(tlsMs!==undefined&&{tlsMs}),...result});
    const fail=error=>finish({ok:false,error:failureCode(error)});
    request.once('error',fail);
    request.once('socket',socket=>{
      if (request.reusedSocket) return;
      const connected=()=>{connectMs=elapsed();};
      const secured=()=>{tlsMs=elapsed();};
      socket.once('connect',connected);
      if (url.protocol==='https:') socket.once('secureConnect',secured);
      request.once('close',()=>{
        socket.off('connect',connected);
        socket.off('secureConnect',secured);
      });
    });
    request.end();
  });
}

async function publicAddress(hostname, signal) {
  const at=Date.now(), started=performance.now();
  const url=new URL('https://dns.google/resolve');
  url.search=new URLSearchParams({name:hostname,type:'A',edns_client_subnet:'0.0.0.0/0'});
  const elapsed=()=>Math.round(performance.now()-started);
  try {
    const response=await fetch(url,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)])});
    if (!response.ok) return {at,ms:elapsed(),error:`http_${response.status}`};
    const answer=await response.json();
    const record=answer.Answer?.find(row=>row.type===1 && isPublicIPv4(row.data));
    if (answer.Status!==0 || !record) return {at,ms:elapsed(),error:'no_public_address'};
    const refreshMs=Math.min(300_000,Math.max(60_000,(Number(record.TTL)||60)*1000));
    return {at,ms:elapsed(),address:record.data,refreshMs};
  } catch (error) {
    return {at,ms:elapsed(),error:failureCode(error)};
  }
}

// The public request leaves this host through the Internet and uses the Funnel's public DNS answer.
// It measures the server's route to ingress; individual players can use different routes.
export function startNetworkProbe({port,publicOrigin,record}) {
  const shutdown=new AbortController();
  const localUrl=new URL(`http://127.0.0.1:${port}/api/ping`);
  const localAgent=new http.Agent({keepAlive:true,maxSockets:1});
  const internetAgent=new https.Agent({keepAlive:true,maxSockets:1});
  let publicAgent, address, hostname, nextDns=0, timer;

  async function measurePublic() {
    const origin=typeof publicOrigin==='function' ? publicOrigin() : publicOrigin;
    if (!origin) return {};
    const url=new URL('/api/ping',origin);
    if (url.protocol!=='https:') return {};
    if (hostname!==url.hostname) {
      publicAgent?.destroy();
      publicAgent=address=undefined;
      hostname=url.hostname;
      nextDns=0;
    }
    let dns;
    if (Date.now()>=nextDns) {
      const result=await publicAddress(hostname,shutdown.signal);
      dns={at:result.at,ms:result.ms,...(result.error&&{error:result.error})};
      nextDns=Date.now()+(result.refreshMs??30_000);
      if (result.address && result.address!==address && !shutdown.signal.aborted) {
        publicAgent?.destroy();
        publicAgent=routeAgent(result.address);
        address=result.address;
      }
    }
    const measurement=publicAgent ? await requestTiming(url,publicAgent,shutdown.signal,204) : {ok:false,error:'no_public_address'};
    return {public:measurement,...(dns&&{dns})};
  }

  function schedule(delay) {
    const due=performance.now()+delay;
    timer=setTimeout(()=>void sample(due),delay);
    timer.unref();
  }

  async function sample(due) {
    const at=Date.now(), start=performance.now();
    try {
      const publicPath=measurePublic().catch(error=>({public:{ok:false,error:failureCode(error)}}));
      const [local,internet,ingress]=await Promise.all([
        requestTiming(localUrl,localAgent,shutdown.signal,204),
        requestTiming(internetCheck,internetAgent,shutdown.signal,200),
        publicPath,
      ]);
      if (!shutdown.signal.aborted) record({at,local,internet,...ingress,scheduleDelayMs:Math.round(Math.max(0,start-due))});
    } catch (error) {
      if (!shutdown.signal.aborted) console.warn('Honeymoon network probe:',failureCode(error));
    } finally {
      if (!shutdown.signal.aborted) schedule(Math.max(0,intervalMs-(performance.now()-start)));
    }
  }

  schedule(2_000);
  return {close() {
    clearTimeout(timer);
    shutdown.abort();
    localAgent.destroy();
    internetAgent.destroy();
    publicAgent?.destroy();
  }};
}
