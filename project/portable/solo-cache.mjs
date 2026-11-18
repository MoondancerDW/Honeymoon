import {createHash, randomUUID} from 'node:crypto';
import {constants, createReadStream, createWriteStream} from 'node:fs';
import {appendFile, copyFile, link, lstat, mkdir, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {setTimeout as sleep} from 'node:timers/promises';

const hexHash=/^[a-f0-9]{64}$/;
const families=new Set(['world','full-world','core-world','textures','models','sounds','weather','creative','lod','vista','npcs']);
const pathnameSegment=/^[\p{L}\p{N} ._()-]+$/u;
const reservedName=/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const maxManifestSize=16*1024*1024;
const maxFileSize=1024*1024*1024;
const concurrency=2;
const unsupportedLink=['EPERM','EACCES','ENOTSUP','ENOSYS','EXDEV'];

export function isSoloAssetPath(path) {
  if (typeof path!=='string' || path.length>1000) return false;
  const segments=path.split('/');
  return segments.length>=2 && families.has(segments[0]) && segments.every(part=>
    part.length<=255 && pathnameSegment.test(part) && !/[. ]$/.test(part) && !reservedName.test(part));
}

export function validateSoloManifest(value) {
  const {schema,version,files,initial,build}=value??{};
  if (schema!==1 || typeof version!=='string' || !hexHash.test(version) || !files || typeof files!=='object' || Array.isArray(files) ||
      !Array.isArray(initial) || !initial.length || build!==undefined && (!Number.isSafeInteger(build) || build<1)) {
    throw new Error('Invalid solo download manifest');
  }
  const seen=new Set();
  const checked=Object.create(null);
  let bytes=0;
  for (const [path,record] of Object.entries(files)) {
    const name=path.normalize('NFC').toLowerCase();
    if (!isSoloAssetPath(path) || seen.has(name) || !record || typeof record.sha256!=='string' || !hexHash.test(record.sha256) ||
        !Number.isSafeInteger(record.size) || record.size<0 || record.size>maxFileSize) {
      throw new Error('Invalid solo download asset');
    }
    seen.add(name);
    bytes+=record.size;
    checked[path]={sha256:record.sha256,size:record.size};
    if (!Number.isSafeInteger(bytes)) throw new Error('Invalid solo download size');
  }
  for (const path of seen) {
    for (let end=path.indexOf('/');end!==-1;end=path.indexOf('/',end+1)) {
      if (seen.has(path.slice(0,end))) throw new Error('Conflicting solo download asset paths');
    }
  }
  if (!initial.every(path=>typeof path==='string' && Object.hasOwn(checked,path))) {
    throw new Error('Invalid solo bootstrap assets');
  }
  return {schema,version,...(build!==undefined&&{build}),files:checked,initial:[...new Set(initial)]};
}

function downloadOrigin(input) {
  const parsed=new URL(input);
  const loopback=['127.0.0.1','localhost','[::1]'].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.pathname!=='/' || parsed.search || parsed.hash ||
      parsed.protocol!=='https:' && !(parsed.protocol==='http:' && loopback)) {
    throw new Error('Solo downloads require an HTTPS origin');
  }
  return parsed.origin;
}

async function safeDirectories(root,path) {
  let directory=root;
  for (const segment of path.split('/')) {
    directory=join(directory,segment);
    try { await mkdir(directory); }
    catch (error) { if (error.code!=='EEXIST') throw error; }
    if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid local solo cache directory');
  }
  return directory;
}

async function atomicText(path,value) {
  const temp=path+'.'+randomUUID()+'.part';
  try {
    await writeFile(temp,JSON.stringify(value)+'\n',{flag:'wx'});
    await rename(temp,path);
  } finally { await rm(temp,{force:true}); }
}

async function readLocalJSON(path) {
  try {
    const file=await lstat(path);
    if (!file.isFile() || file.size>maxManifestSize) return null;
    return JSON.parse(await readFile(path,'utf8'));
  } catch { return null; }
}

async function hasExpectedSize(path,size) {
  try {
    const file=await lstat(path);
    return file.isFile() && file.size===size;
  } catch (error) {
    if (error.code==='ENOENT' || error.code==='ENOTDIR') return false;
    throw error;
  }
}

async function matchingFile(path,asset) {
  try {
    if (!await hasExpectedSize(path,asset.size)) return false;
    const hash=createHash('sha256');
    for await (const data of createReadStream(path)) hash.update(data);
    return hash.digest('hex')===asset.sha256;
  } catch (error) {
    if (error.code==='ENOENT') return false;
    throw error;
  }
}

function immutableManifest(left,right) {
  const a=Object.keys(left.files), b=Object.keys(right.files);
  return a.length===b.length && a.every(path=>left.files[path].sha256===right.files[path]?.sha256 &&
    left.files[path].size===right.files[path].size);
}

export async function createSoloCache({cacheDirectory,origin,fetch:request=globalThis.fetch,seedDirectory,requiredFiles,validateReady}={}) {
  const host=downloadOrigin(origin);
  await mkdir(resolve(cacheDirectory),{recursive:true});
  const root=await realpath(resolve(cacheDirectory));
  const releases=await safeDirectories(root,'versions');
  const objects=await safeDirectories(root,'objects');
  const pointer=join(root,'active.json');

  async function get(path,signal) {
    for (let attempt=0; ; attempt++) {
      const response=await request(host+path,{method:'GET',credentials:'omit',redirect:'error',signal});
      if (response.ok) return response;
      await response.body?.cancel();
      if (attempt<5 && (response.status===429 || response.status===503)) {
        const seconds=Number(response.headers.get('Retry-After'));
        const delay=Number.isFinite(seconds) && seconds>0 ? Math.min(10,seconds)*1000 : Math.min(5000,600*2**attempt);
        await sleep(delay,undefined,{signal});
        continue;
      }
      throw new Error(`Solo download returned HTTP ${response.status}`);
    }
  }

  async function remoteManifest(signal=AbortSignal.timeout(5000)) {
    const response=await get('/solo-download/manifest.json',signal);
    const chunks=[];
    let length=0;
    for await (const chunk of response.body??[]) {
      length+=chunk.length;
      if (length>maxManifestSize) throw new Error('Solo manifest exceeds the download limit');
      chunks.push(chunk);
    }
    return validateSoloManifest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }

  async function localManifest(version) {
    if (typeof version!=='string' || !hexHash.test(version)) return null;
    const directory=join(releases,version);
    try {
      if (!(await lstat(directory)).isDirectory()) return null;
      const result=validateSoloManifest(await readLocalJSON(join(directory,'manifest.json')));
      return result.version===version ? result : null;
    } catch { return null; }
  }

  const previous=await localManifest((await readLocalJSON(pointer))?.version);
  let remote, remoteError;
  try { remote=await remoteManifest(); }
  catch (error) { remoteError=error; }

  async function mount(manifest) {
    const release=await safeDirectories(releases,manifest.version);
    const directory=await safeDirectories(release,'generated');
    const marker=join(release,'manifest.json');
    const previousManifest=await localManifest(manifest.version);
    if (previousManifest && !immutableManifest(previousManifest,manifest)) throw new Error('Solo version was reused for different assets');
    await atomicText(marker,manifest);

    const controller=new AbortController();
    const readyLog=join(release,'ready.txt');
    const recorded=new Set();
    const verified=new Set();
    try {
      const log=await lstat(readyLog);
      if (!log.isFile() || log.size>maxManifestSize) throw new Error('Invalid solo cache ledger');
      for (const line of (await readFile(readyLog,'utf8')).split('\n')) {
        const removed=line.startsWith('!');
        const path=removed ? line.slice(1) : line;
        if (!Object.hasOwn(manifest.files,path)) continue;
        if (removed) recorded.delete(path);
        else recorded.add(path);
      }
    } catch (error) { if (error.code!=='ENOENT') throw error; }
    const claimed=[...recorded];
    const missing=[];
    let checkIndex=0;
    async function reconcileLedger() {
      while (checkIndex<claimed.length) {
        const path=claimed[checkIndex++];
        if (!await hasExpectedSize(join(directory,path),manifest.files[path].size)) {
          recorded.delete(path);
          missing.push('!'+path+'\n');
        }
      }
    }
    await Promise.all([reconcileLedger(),reconcileLedger()]);
    if (missing.length) await appendFile(readyLog,missing.join(''));
    let readyBytes=0;
    for (const path of recorded) readyBytes+=manifest.files[path].size;
    const paths=Object.keys(manifest.files);
    const totalBytes=paths.reduce((sum,path)=>sum+manifest.files[path].size,0);
    const previousDirectory=previous && previous.version!==manifest.version ? join(releases,previous.version,'generated') : null;
    const jobs=new Map();
    let active=0, bulk, lastError;

    function describeUpdate({version,build}) {
      return {version,build,newVersion:version!==manifest.version,newBuild:build!==undefined&&build>(manifest.build??0)};
    }

    let update=remote ? describeUpdate(remote) : null;

    async function mark(path,asset) {
      if (!recorded.has(path)) {
        await appendFile(readyLog,path+'\n');
        recorded.add(path);
        readyBytes+=asset.size;
      }
      verified.add(path);
    }

    async function remember(source,target) {
      const temp=target+'.'+randomUUID()+'.part';
      try {
        await link(source,temp);
        await rename(temp,target);
      } catch (error) {
        // The active version is already usable on filesystems without hardlinks.
        if (!unsupportedLink.includes(error.code)) throw error;
      } finally { await rm(temp,{force:true}); }
    }

    async function prepare(path) {
      controller.signal.throwIfAborted();
      const asset=manifest.files[path];
      await safeDirectories(directory,path.slice(0,path.lastIndexOf('/')));
      const target=join(directory,path);
      const object=join(objects,asset.sha256);
      if (await matchingFile(target,asset)) {
        try { await link(target,object); }
        catch (error) {
          if (error.code!=='EEXIST' && !unsupportedLink.includes(error.code)) throw error;
        }
        await mark(path,asset);
        return;
      }
      if (recorded.delete(path)) {
        readyBytes-=asset.size;
        await appendFile(readyLog,'!'+path+'\n');
      }
      const temp=target+'.'+randomUUID()+'.part';
      try {
        const assetSources=[{source:object,cached:true}];
        if (previousDirectory && previous.files[path]?.sha256===asset.sha256) assetSources.push({source:join(previousDirectory,path),cached:true});
        if (seedDirectory) assetSources.push({source:join(resolve(seedDirectory),path),cached:false});
        let reused;
        for (const {source,cached} of assetSources) {
          if (!await matchingFile(source,asset)) continue;
          let linked=false;
          if (cached) {
            try { await link(source,temp); linked=true; }
            catch (error) { if (!unsupportedLink.includes(error.code)) throw error; }
          }
          if (!linked) {
            await copyFile(source,temp,constants.COPYFILE_EXCL);
            if (!await matchingFile(temp,asset)) throw new Error(`Local solo resource changed: ${path}`);
          }
          reused=source;
          break;
        }
        if (!reused) {
          const urlPath=path.split('/').map(encodeURIComponent).join('/');
          const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(180_000)]);
          const response=await get(`/solo-download/files/${manifest.version}/${urlPath}`,signal);
          const hash=createHash('sha256');
          let received=0;
          await pipeline(response.body??[],async function* (input) {
            for await (const block of input) {
              received+=block.length;
              if (received>asset.size) throw new Error(`Incorrect solo asset length: ${path}`);
              hash.update(block);
              yield block;
            }
          },createWriteStream(temp,{flags:'wx'}),{signal});
          if (received!==asset.size || hash.digest('hex')!==asset.sha256) throw new Error(`Solo asset checksum failed: ${path}`);
        }
        controller.signal.throwIfAborted();
        await rename(temp,target);
        if (reused!==object) await remember(target,object);
        await mark(path,asset);
      } finally { await rm(temp,{force:true}); }
    }

    function pump() {
      if (controller.signal.aborted) return;
      while (active<concurrency) {
        let next;
        for (const job of jobs.values()) if (!job.running && (!next || job.priority>next.priority)) next=job;
        if (!next) return;
        const job=next;
        job.running=true;
        active++;
        const finish=()=>{
          jobs.delete(job.path);
          active--;
          pump();
        };
        void prepare(job.path).then(()=>{
          finish();
          job.resolve();
        },error=>{
          lastError=String(error.message??error).slice(0,240);
          finish();
          job.reject(error);
        });
      }
    }

    function enqueue(path,priority) {
      if (!Object.hasOwn(manifest.files,path)) return Promise.reject(new Error('Unknown solo download asset'));
      if (controller.signal.aborted) return Promise.reject(controller.signal.reason);
      if (verified.has(path)) return Promise.resolve();
      const queued=jobs.get(path);
      if (queued) {
        queued.priority=Math.max(queued.priority,priority);
        return queued.promise;
      }
      const task=Promise.withResolvers();
      jobs.set(path,{path,priority,...task});
      pump();
      return task.promise;
    }

    function ensure(wanted,{priority=0}={}) {
      const list=Array.isArray(wanted) ? wanted : [wanted];
      return Promise.all(list.map(path=>enqueue(path,priority)));
    }

    function status() {
      return {version:manifest.version,build:manifest.build,totalFiles:paths.length,totalBytes,
        readyFiles:recorded.size,readyBytes,active,queued:jobs.size-active,background:Boolean(bulk&&!bulk.cancelled),
        complete:recorded.size===paths.length,lastError,update};
    }

    function downloadAll() {
      if (bulk) return bulk.promise;
      const task={cancelled:false};
      bulk=task;
      lastError=undefined;
      let next=0;
      const worker=async()=>{
        while (!task.cancelled && next<paths.length) await enqueue(paths[next++],-100);
      };
      task.promise=Promise.allSettled([worker(),worker()]).then(results=>{
        const failure=results.find(result=>result.status==='rejected');
        if (failure && !task.cancelled) throw failure.reason;
      }).finally(()=>{bulk=undefined;}).then(status);
      return task.promise;
    }

    function cancelDownloadAll() {
      if (bulk) bulk.cancelled=true;
    }

    async function close() {
      cancelDownloadAll();
      controller.abort();
      const pending=[...jobs.values()];
      for (const job of pending) {
        if (job.running) continue;
        jobs.delete(job.path);
        job.reject(controller.signal.reason);
      }
      await Promise.allSettled(pending.map(job=>job.promise));
    }

    try {
      const saved=await requiredFiles?.(manifest)??[];
      if (!Array.isArray(saved)) throw new Error('Invalid local solo bootstrap file list');
      await ensure([...new Set([...manifest.initial,...saved])],{priority:100});
      await validateReady?.({directory,manifest,has:path=>verified.has(path)});
    }
    catch (error) { await close(); throw error; }
    return {manifest,directory,has:path=>verified.has(path),ensure,status,downloadAll,cancelDownloadAll,close,
      async checkForUpdate() {
        try {
          update=describeUpdate(await remoteManifest(AbortSignal.any([controller.signal,AbortSignal.timeout(5000)])));
          return update;
        } catch { return null; }
      }};
  }

  if (remote) {
    let cache;
    try {
      cache=await mount(remote);
      await atomicText(pointer,{version:remote.version});
      return cache;
    } catch (error) {
      await cache?.close();
      remoteError=error;
    }
  }
  if (previous) return mount(previous);
  throw new Error('Одиночная игра: не удалось подготовить стартовый район', {cause:remoteError});
}
