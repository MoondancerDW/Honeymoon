import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {mkdtemp,mkdir,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {test} from 'node:test';
import {createHoneymoonServer} from './index.mjs';
import {createLoadLog} from './load-log.mjs';
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
  request('/api/action',200,3);
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
    byKind:{actions:1,movement:1,gameAssets:1,streams:1},p95MsUpperBound:8});
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
  const request=(url,method='GET',body)=>fetch(address+url,{method,headers:{
    ...(cookie&&{Cookie:cookie}),...(body&&{'Content-Type':'application/json'}),
  },body:body&&JSON.stringify(body)});
  const session=await request('/api/session','POST',{deviceName:'test-private-device'});
  assert.equal(session.status,200);
  cookie=session.headers.get('set-cookie').split(';')[0];
  const {playerId}=await session.json();
  const stream=await request('/api/events?presence=1');
  assert.equal(stream.status,200);
  const joinResult=await request('/api/presence','POST',{yaw:0,pitch:0});
  assert.equal(joinResult.status,200);
  await joinResult.json();
  const leaveResult=await request('/api/presence','DELETE');
  assert.equal(leaveResult.status,200);
  await leaveResult.json();
  const notPublic=await request('/state/load-logs/probe.jsonl');
  assert.equal(notPublic.status,404);
  await notPublic.json();
  await stream.body.cancel();
  await app.close();
  closed=true;
  const dailyFiles=(await readdir(logs)).filter(name=>/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
  const contents=await Promise.all(dailyFiles.map(name=>readFile(join(logs,name),'utf8')));
  const raw=contents.join('');
  for (const value of [cookie,playerId,'test-private-device','probe.jsonl']) assert.ok(!raw.includes(value));
  const entries=rows(raw);
  assert.deepEqual(entries.map(row=>[row.event,row.onlinePlayers]),
    [['startup',0],['player_join',1],['player_leave',0],['shutdown',0]]);
  assert.deepEqual(entries.at(-1).requests.byKind,{access:1,streams:1,presence:2,static:1});
});
