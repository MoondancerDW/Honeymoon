import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {access, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {createSoloCache, validateSoloManifest} from './solo-cache.mjs';

const origin='http://127.0.0.1:47821';
const starter='world/world.json';
const spawn='full-world/0.0.bin';
const nearby='full-world/1.0.bin';
const hill='full-world/2.0.bin';
const distant='full-world/3.0.bin';
const signature=data=>createHash('sha256').update(data).digest('hex');
const set=(build,assets)=>({assets,manifest:{schema:1,version:signature('version'+build),build,initial:[starter,spawn],
  files:Object.fromEntries(Object.entries(assets).map(([path,text])=>[path,{sha256:signature(text),size:Buffer.byteLength(text)}]))}});

async function fixture(t) {
  const cacheDirectory=await mkdtemp(join(tmpdir(),'honeymoon-solo-'));
  const requests=[];
  const caches=[];
  t.after(async()=>{
    await Promise.all(caches.map(cache=>cache.close()));
    await rm(cacheDirectory,{force:true,recursive:true});
  });
  const current={remote:set(4,{[starter]:'starter',[spawn]:'spawn',[nearby]:'nearby',[hill]:'hill',[distant]:'distant'}),
    handler:(_path,text)=>new Response(text),offline:false};
  const fetch=async(raw,options)=>{
    const url=new URL(raw);
    assert.equal(url.origin,origin);
    assert.equal(options.method,'GET');
    assert.equal(options.credentials,'omit');
    assert.equal(options.redirect,'error');
    assert.equal(url.search,'');
    requests.push(url.pathname);
    if (current.offline) throw new Error('offline');
    if (url.pathname==='/solo-download/manifest.json') return Response.json(current.remote.manifest);
    const [,version,path]=/^\/solo-download\/files\/([a-f0-9]{64})\/(.+)$/.exec(url.pathname)??[];
    assert.equal(version,current.remote.manifest.version);
    const text=current.remote.assets[path];
    assert.ok(text!==undefined);
    return current.handler(path,text,options.signal);
  };
  return {cacheDirectory,requests,current,fileRequests:()=>requests.filter(path=>path.includes('/files/')),
    async open(options={}) {
      const cache=await createSoloCache({cacheDirectory,origin,fetch,...options});
      caches.push(cache);
      return cache;
    }};
}

test('downloads only bootstrap files, caches game data and launches offline with zero file requests',async t=>{
  const f=await fixture(t);
  const cache=await f.open();
  assert.ok(cache.has(spawn));
  assert.ok(!cache.has(nearby));
  assert.equal(f.fileRequests().length,2);
  await cache.ensure(nearby);
  assert.equal(await readFile(join(cache.directory,nearby),'utf8'),'nearby');
  assert.equal(cache.status().readyFiles,3);
  await cache.close();

  f.requests.length=0;
  f.current.offline=true;
  const reopened=await f.open();
  assert.ok(reopened.has(spawn));
  assert.equal(reopened.status().readyFiles,3);
  await reopened.ensure(nearby);
  assert.ok(reopened.has(nearby));
  assert.deepEqual(f.requests,['/solo-download/manifest.json']);
  assert.equal(await reopened.checkForUpdate(),null);
});

test('reconciles missing or truncated assets before claiming a complete offline map',async t=>{
  const f=await fixture(t);
  const installed=await f.open();
  assert.equal((await installed.downloadAll()).complete,true);
  await installed.close();
  await rm(join(installed.directory,nearby));
  await writeFile(join(installed.directory,hill),'shorter no longer matches');

  f.requests.length=0;
  f.current.offline=true;
  const reopened=await f.open();
  const {complete,readyFiles,readyBytes}=reopened.status();
  assert.equal(complete,false);
  assert.equal(readyFiles,3);
  assert.equal(readyBytes,Buffer.byteLength('starterspawndistant'));
  assert.equal(f.fileRequests().length,0);
  await reopened.ensure(nearby);
  assert.equal(reopened.status().readyFiles,4);
  assert.equal(await readFile(join(reopened.directory,nearby),'utf8'),'nearby');
  assert.equal(f.fileRequests().length,0);
});

test('prepares an updated bootstrap list for an unchanged asset version',async t=>{
  const f=await fixture(t);
  const first=await f.open();
  await first.close();
  f.current.remote.manifest.initial.push(nearby);
  f.requests.length=0;
  const reopened=await f.open();
  assert.equal(reopened.manifest.version,first.manifest.version);
  assert.ok(reopened.has(nearby));
  assert.equal(f.fileRequests().length,1);
});

test('keeps the last playable version when structurally invalid assets pass file checksums',async t=>{
  const f=await fixture(t);
  const good=await f.open();
  const version=good.manifest.version;
  await good.close();
  f.current.remote=set(5,{[starter]:'wrong schema',[spawn]:'spawn'});
  const fallback=await f.open({async validateReady({directory}) {
    if ((await readFile(join(directory,starter),'utf8'))==='wrong schema') throw new Error('unsupported map');
  }});
  assert.equal(fallback.manifest.version,version);
  assert.equal(fallback.status().update.newVersion,true);
  assert.equal(JSON.parse(await readFile(join(f.cacheDirectory,'active.json'),'utf8')).version,version);
});

test('pins each session, verifies updates, reuses unchanged files and falls back when new saved regions fail',async t=>{
  const f=await fixture(t);
  const requiredFiles=manifest=>{
    assert.ok(Object.hasOwn(manifest.files,nearby));
    return [nearby];
  };
  const old=await f.open({requiredFiles});
  assert.equal(old.manifest.build,4);
  assert.ok(old.has(nearby));
  f.current.remote=set(5,{[starter]:'starter',[spawn]:'spawn',[nearby]:'different nearby'});
  assert.deepEqual(await old.checkForUpdate(),{version:f.current.remote.manifest.version,build:5,newVersion:true,newBuild:true});
  assert.equal(old.status().update.newVersion,true);
  assert.equal(old.manifest.build,4);
  await old.close();

  f.requests.length=0;
  f.current.handler=(path,text)=>path===nearby?new Response('missing',{status:404}):new Response(text);
  const fallback=await f.open({requiredFiles});
  assert.equal(fallback.manifest.build,4);
  assert.equal(await readFile(join(fallback.directory,nearby),'utf8'),'nearby');
  assert.deepEqual(f.fileRequests(),[`/solo-download/files/${f.current.remote.manifest.version}/${nearby}`]);
  await fallback.close();

  f.requests.length=0;
  f.current.handler=(_path,text)=>new Response(text);
  const updated=await f.open({requiredFiles});
  assert.equal(updated.manifest.build,5);
  assert.notEqual(updated.directory,old.directory);
  assert.equal(await readFile(join(updated.directory,nearby),'utf8'),'different nearby');
  assert.equal(await readFile(join(old.directory,nearby),'utf8'),'nearby');
  assert.equal(f.fileRequests().length,1);
});

test('a wrong checksum cannot publish a file, and a damaged cached asset is repaired on use',async t=>{
  const f=await fixture(t);
  const one=await f.open();
  await one.ensure(nearby);
  await one.close();
  await writeFile(join(one.directory,nearby),'damage');

  f.current.handler=(path,text)=>new Response(path===distant?'corrupt':text);
  const two=await f.open();
  await assert.rejects(two.ensure(distant),/checksum failed/);
  await assert.rejects(access(join(two.directory,distant)),{code:'ENOENT'});
  assert.ok(!two.has(distant));
  f.current.handler=(_path,text)=>new Response(text);
  await two.ensure(distant);
  await two.ensure(nearby);
  assert.equal(await readFile(join(two.directory,nearby),'utf8'),'nearby');
  assert.equal(two.status().readyFiles,4);
});

test('reuses a downloaded object skipped by an intermediate version even if renamed',async t=>{
  const f=await fixture(t);
  const one=await f.open();
  await one.ensure(nearby);
  await one.close();
  f.current.remote=set(5,{[starter]:'starter',[spawn]:'spawn'});
  const two=await f.open();
  await two.close();
  f.requests.length=0;
  f.current.remote=set(6,{[starter]:'starter',[spawn]:'spawn',[hill]:'nearby'});
  const three=await f.open();
  await three.ensure(hill);
  assert.equal(await readFile(join(three.directory,hill),'utf8'),'nearby');
  assert.equal(f.fileRequests().length,0);
});

test('limits concurrent requests, gives foreground work priority, deduplicates and stops background downloads',async t=>{
  const f=await fixture(t);
  const cache=await f.open();
  const active=new Map();
  const started=[];
  f.current.handler=(path,text,signal)=>{
    const pending=Promise.withResolvers();
    signal.addEventListener('abort',()=>pending.reject(signal.reason),{once:true});
    active.set(path,()=>pending.resolve(new Response(text)));
    started.push(path);
    return pending.promise;
  };
  const all=cache.downloadAll();
  await waitFor(()=>active.has(nearby)&&active.has(hill));
  const requested=cache.ensure(distant,{priority:100});
  const duplicate=cache.ensure(distant,{priority:200});
  assert.equal(cache.status().active,2);
  assert.equal(cache.status().queued,1);
  cache.cancelDownloadAll();
  active.get(nearby)();
  await waitFor(()=>active.has(distant));
  active.get(hill)();
  active.get(distant)();
  await Promise.all([requested,duplicate,all]);
  assert.deepEqual([...started].sort(),[nearby,hill,distant].sort());
  assert.equal(started.at(-1),distant);
  assert.equal(started.filter(path=>path===distant).length,1);
  assert.equal(cache.status().readyFiles,5);
});

async function waitFor(predicate) {
  for (let attempt=0;attempt<200;attempt++) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error('Fixture did not schedule the expected request');
}

test('rejects unsafe paths, ambiguous case and insecure origins',async t=>{
  const f=await fixture(t);
  for (const path of ['../secret','world/../../secret','world/AUX.json','world/a.','state/honeymoon.db','world\\file.json','world/%2e%2e/file']) {
    const malformed=set(4,{[starter]:'starter',[spawn]:'spawn',[path]:'escape'}).manifest;
    assert.throws(()=>validateSoloManifest(malformed),/Invalid solo download asset/);
  }
  assert.throws(()=>validateSoloManifest(set(4,{[starter]:'starter',[spawn]:'spawn','models/A.png':'a','models/a.png':'b'}).manifest),/Invalid solo download asset/);
  await assert.rejects(f.open({origin:'http://example.org'}),/require an HTTPS origin/);
  await assert.rejects(f.open({origin:'https://example.org/secret?cookie=1'}),/require an HTTPS origin/);
});
