import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {mkdtemp,mkdir,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {connect} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {test} from 'node:test';
import {createHoneymoonServer} from './index.mjs';
import {createLoadLog} from './load-log.mjs';
import {loadPlayerDiagnostics} from './player-diagnostics.mjs';
import * as geometry from '../world/geometry.mjs';

async function directory(t) {
  const parent=resolve(tmpdir());
  const path=await mkdtemp(join(parent,'honeymoon-load-log-'));
  assert.equal(dirname(path),parent);
  t.after(()=>rm(path,{recursive:true,force:true}));
  return path;
}

function rows(value) {
  return value.trim().split('\n').map(line=>JSON.parse(line));
}

test('load samples follow local midnight, retain 30 days, and summarize requests without personal data',async t=>{
  const path=await directory(t);
  const stale='2026-10-17.jsonl', retained='2026-10-19.jsonl', foreign='notes.txt';
  for (const name of [stale,retained,foreign]) await writeFile(join(path,name),'leave this unless the dated log expired');
  let now=Date.parse('2026-11-16T21:59:59.700Z'), ms=100;
  let cpu={user:2_000_000,system:100_000};
  const errors=[];
  const log=createLoadLog({directory:path,timeZone:'Europe/Sofia',now:()=>now,monotonic:()=>ms,intervalMs:0,
    cpuUsage:()=>cpu,memoryUsage:()=>({rss:900,heapUsed:200,heapTotal:400}),onlineStreams:()=>2,
    onError:error=>errors.push(error)});
  log.start();
  log.start();
  log.player('private-first-uid',true);
  log.player('private-first-uid',true);
  log.player('private-second-uid',true);
  log.player('unknown-uid',false);
  function request(path,status,elapsed) {
    const response=new EventEmitter();
    response.statusCode=status;
    log.request(path,response);
    ms+=elapsed;
    if (status) {
      response.writableFinished=true;
      response.emit('finish');
    }
    response.emit('close');
  }
  request('/api/action',200,520);
  request('/api/position',429,7);
  request('/generated/world/private-location.json',0,10);
  log.request('/api/events',new EventEmitter());
  now+=30_000;
  ms=30_100;
  cpu={user:4_000_000,system:1_100_000};
  log.sample();
  log.player('private-second-uid',false);
  await log.close();
  await log.close();
  assert.deepEqual(errors,[]);
  assert.deepEqual((await readdir(path)).sort(),[retained,'2026-11-16.jsonl','2026-11-17.jsonl',foreign]);
  const first=await readFile(join(path,'2026-11-16.jsonl'),'utf8');
  const second=await readFile(join(path,'2026-11-17.jsonl'),'utf8');
  assert.doesNotMatch(first+second,/private-|unknown-uid/);
  assert.deepEqual(rows(first).map(row=>[row.event,row.onlinePlayers]),[['startup',0],['player_join',1],['player_join',2]]);
  assert.equal(rows(first)[0].timestamp,'2026-11-16T23:59:59.700+02:00');
  const [sample,leave,shutdown]=rows(second);
  assert.equal(sample.timestamp,'2026-11-17T00:00:29.700+02:00');
  assert.deepEqual([sample.event,sample.onlinePlayers,sample.windowMs,sample.cpuPercent,sample.rssBytes,
    sample.heapUsedBytes,sample.heapTotalBytes,sample.openStreams],['sample',2,30000,10,900,200,400,2]);
  assert.deepEqual(sample.requests,{started:4,completed:2,clientErrors:1,serverErrors:0,aborted:1,
    byKind:{actions:1,movement:1,gameAssets:1,streams:1},p95MsUpperBound:768,
    errorsByKind:{movement:{429:1}},abortedByKind:{gameAssets:1},slowByKind:{actions:{count:1,maxMs:520}},
    streamHandshakes:{opened:0,rejected:0,aborted:0},socketErrors:{}});
  assert.deepEqual([leave.event,leave.onlinePlayers,shutdown.event,shutdown.onlinePlayers],['player_leave',1,'shutdown',1]);
  assert.equal(shutdown.requests.started,0);
});

test('the HTTP server drains the private load journal after player activity',async t=>{
  const path=await directory(t);
  const state=join(path,'state','honeymoon.sqlite');
  const logs=join(dirname(state),'load-logs');
  await mkdir(logs,{recursive:true});
  await writeFile(join(logs,'probe.jsonl'),'private-path-content');
  const bounds={minX:0,maxX:15,minY:0,maxY:15,minZ:0,maxZ:15};
  const stone='legacy:1:0';
  const base={hash:'load-log-fixture',manifest:{bounds,spawn:[8.5,1,8.5]},catalog:new Set([stone]),
    inBounds:(x,y,z)=>[x,y,z].every(value=>value>=0&&value<16),
    getCell:(x,y)=>({key:y===0?stone:'air',object:null})};
  const app=createHoneymoonServer({base,geometry,state,generated:join(path,'generated')});
  let closed=false;
  t.after(()=>closed||app.close());
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  const address='http://127.0.0.1:'+app.server.address().port;
  let cookie;
  const request=(url,method='GET',body,headers)=>fetch(address+url,{method,headers:{
    ...(cookie&&{Cookie:cookie}),...(body&&{'Content-Type':'application/json'}),...headers,
  },body:body&&JSON.stringify(body)});
  const report={events:[{kind:'ping_failed',at:Date.now(),why:'timeout',durationMs:3510}]};
  assert.equal((await request('/api/connection-report','POST',report)).status,401);
  const rejectedStream=await request('/api/events');
  assert.equal(rejectedStream.status,401);
  await rejectedStream.json();

  const parserSocket=connect(app.server.address().port,'127.0.0.1');
  parserSocket.write('INVALID-METHOD-PRIVATE / HTTP/1.1\r\n\r\n');
  let parserResponse='';
  for await (const chunk of parserSocket) parserResponse+=chunk;
  assert.match(parserResponse,/^HTTP\/1\.1 400 /);

  const session=await request('/api/session','POST',{deviceName:'test-private-device'});
  assert.equal(session.status,200);
  cookie=session.headers.get('set-cookie').split(';')[0];
  const {access}=await session.json();
  let transportClosed;
  const cancellation=new Promise(resolve=>{ transportClosed=resolve; });
  app.server.on('request',(req,response)=>{
    if (req.url==='/api/events?presence=1') response.once('close',transportClosed);
  });
  const stream=await request('/api/events?presence=1');
  assert.equal(stream.status,200);
  const joinResult=await request('/api/presence','POST',{yaw:0,pitch:0});
  assert.equal(joinResult.status,200);
  await joinResult.json();
  assert.equal((await request('/api/connection-report','POST',report,{Origin:'https://invalid.example'})).status,403);
  const malformed={events:[{...report.events[0],url:'private-url'}]};
  assert.equal((await request('/api/connection-report','POST',malformed)).status,400);
  for (let i=0;i<4;i++) {
    assert.equal((await request('/api/connection-report','POST',report)).status,204);
  }
  assert.equal((await request('/api/connection-report','POST',report)).status,429);
  const leaveResult=await request('/api/presence','DELETE');
  assert.equal(leaveResult.status,200);
  await leaveResult.json();
  const notPublic=await request('/state/load-logs/probe.jsonl');
  assert.equal(notPublic.status,404);
  await notPublic.json();
  await stream.body.cancel();
  await cancellation;
  const openAtShutdown=await request('/api/events');
  assert.equal(openAtShutdown.status,200);
  await app.close();
  closed=true;
  const dailyFiles=(await readdir(logs)).filter(name=>/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
  const contents=await Promise.all(dailyFiles.map(name=>readFile(join(logs,name),'utf8')));
  const raw=contents.join('');
  for (const value of [cookie,access.uid,access.deviceId,'test-private-device','probe.jsonl','private-url','INVALID-METHOD-PRIVATE']) {
    assert.ok(!raw.includes(value));
  }
  const entries=rows(raw);
  assert.deepEqual(entries.map(row=>[row.event,row.onlinePlayers]),
    [['startup',0],['sse_open',0],['player_join',1],...Array(4).fill(['client_connection',1]),
      ['player_leave',0],['sse_close',0],['sse_open',0],['sse_close',0],['shutdown',0]]);
  const opened=entries.filter(row=>row.event==='sse_open');
  const streamCloses=entries.filter(row=>row.event==='sse_close');
  assert.deepEqual(streamCloses.map(row=>row.reason),['transport_closed','server_shutdown']);
  assert.deepEqual(streamCloses.map(row=>row.streamId),opened.map(row=>row.streamId));
  assert.ok(streamCloses.every(row=>Number.isInteger(row.durationMs)&&row.durationMs>=0));
  assert.notEqual(opened[0].streamId,opened[1].streamId);
  const received=entries.find(row=>row.event==='client_connection');
  assert.match(received.device,/^[a-f0-9]{16}$/);
  assert.equal(received.device,opened[0].device);
  assert.deepEqual(received.events,report.events);
  const {requests}=entries.at(-1);
  assert.deepEqual(requests.byKind,{access:1,streams:3,presence:2,static:1,connectionReports:8});
  assert.deepEqual(requests.streamHandshakes,{opened:2,rejected:1,aborted:0});
  assert.deepEqual(requests.errorsByKind,{streams:{401:1},static:{404:1},connectionReports:{400:1,401:1,403:1,429:1}});
  assert.deepEqual(requests.socketErrors,{HPE_INVALID_METHOD:1});
});

test('player diagnostics grants only the configured UID and joins client traces with private server receipts',async t=>{
  const path=await directory(t);
  const state=join(path,'honeymoon.sqlite');
  const bounds={minX:0,maxX:15,minY:0,maxY:15,minZ:0,maxZ:15};
  const stone='legacy:1:0';
  const base={hash:'player-diagnostics-fixture',manifest:{bounds,spawn:[8.5,1,8.5]},catalog:new Set([stone]),
    inBounds:(x,y,z)=>[x,y,z].every(value=>value>=0&&value<16),
    getCell:(x,y)=>({key:y===0?stone:'air',object:null})};
  async function launch() {
    const app=createHoneymoonServer({base,geometry,state,generated:join(path,'generated')});
    let closing;
    const stop=()=>closing??=app.close();
    t.after(stop);
    app.server.listen(0,'127.0.0.1');
    await once(app.server,'listening');
    const address='http://127.0.0.1:'+app.server.address().port;
    const request=(url,method='GET',body,headers)=>fetch(address+url,{method,headers:{
      ...(body&&{'Content-Type':'application/json'}),...headers,
    },body:body&&JSON.stringify(body)});
    return {stop,request};
  }
  const initial=await launch();
  const enrolled=await initial.request('/api/session','POST',{});
  const cookie=enrolled.headers.get('set-cookie').split(';')[0];
  const {access:{uid,deviceId}}=await enrolled.json();
  await initial.stop();

  const expiry=Date.now()+3_600_000;
  await writeFile(join(path,'player-diagnostics.json'),JSON.stringify({uid,until:new Date(expiry).toISOString()}));
  assert.equal(loadPlayerDiagnostics(state,{now:()=>expiry}).active(uid),false);
  const {stop,request}=await launch();
  const role=await request('/api/session','POST',{},{Cookie:cookie});
  assert.equal((await role.json()).playerDiagnostics.until,expiry);
  const stranger=await request('/api/session','POST',{});
  const strangerCookie=stranger.headers.get('set-cookie').split(';')[0];
  assert.equal((await stranger.json()).playerDiagnostics,undefined);
  const page='0123456789abcdef', trace=page+'.1';
  const body={samples:[{at:Date.now(),page,reasons:{queue_full:1300},requests:[
    {id:trace,kind:'ping',startedAt:Date.now(),durationMs:150,status:204},
    {id:page+'.2',kind:'movement',startedAt:Date.now(),durationMs:3_000,error:'timeout'},
  ]}]};
  assert.equal((await request('/api/player-diagnostics','POST',body,{Cookie:strangerCookie})).status,403);
  assert.equal((await request('/api/ping','GET',undefined,{Cookie:cookie,'X-Honeymoon-Trace':trace})).status,204);
  assert.equal((await request('/api/player-diagnostics','POST',{samples:[{...body.samples[0],ip:'192.0.2.1'}]},
    {Cookie:cookie})).status,400);
  assert.equal((await request('/api/player-diagnostics','POST',body,{Cookie:cookie})).status,204);
  const stream=await request('/api/events?presence=1&diag='+page,'GET',undefined,{Cookie:cookie});
  const reader=stream.body.getReader();
  const first=new TextDecoder().decode((await reader.read()).value);
  assert.match(first,/event: diagnostics-heartbeat/);
  await reader.cancel();
  await stop();

  const logs=join(path,'load-logs');
  const filenames=(await readdir(logs)).filter(name=>name.startsWith('player-'));
  assert.equal(filenames.length,1);
  const text=await readFile(join(logs,filenames[0]),'utf8');
  assert.ok(![uid,deviceId,cookie,strangerCookie,'192.0.2.1'].some(secret=>text.includes(secret)));
  const entries=rows(text);
  const client=entries.find(row=>row.event==='player_study_client');
  assert.equal(client.samples[0].requests[0].server.status,204);
  assert.equal(client.samples[0].requests[1].server,null);
  const opened=entries.find(row=>row.event==='player_study_sse_open');
  const heartbeat=entries.find(row=>row.event==='player_study_sse_heartbeat');
  assert.equal(opened.device,client.device);
  assert.equal(opened.page,page);
  assert.equal(heartbeat.streamId,opened.streamId);
  assert.equal(entries.find(row=>row.event==='player_study_requests').requests.ping.completed,1);
});
