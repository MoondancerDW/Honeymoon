import assert from 'node:assert/strict';
import test from 'node:test';
import {terrainCacheLimits} from './terrain-cache.mjs';
import {planTerrainPreload} from './terrain-preload-plan.mjs';
import {createTerrainPreload} from './terrain-preload.mjs';

const MiB=1024*1024;
const lodHash='a'.repeat(64), vistaHash='b'.repeat(64);
const manifest={lod:{contentHash:lodHash,maxDistance:32,regions:[[-1,0],[0,0]]},
  vista:{hash:vistaHash,regions:[[0,0]]}};
const available={primitive:{hash:lodHash,bytes:144494752,count:2},
  simplified:{hash:lodHash,bytes:230186256,count:2},
  vista:{hash:vistaHash,bytes:48303360,count:1},altitude:{bytes:2918485,count:4}};

function plan(settings={}, layers=available, world=manifest, limits=terrainCacheLimits(settings)) {
  return planTerrainPreload({manifest:world,build:35,...settings}, layers, limits);
}

test('profiles fit the published layers selected for full preloading',()=>{
  for (const [mobile,lowDevice,total] of [[false,false,2660],[false,true,646],[true,false,1124],[true,true,434]]) {
    const settings={mobile,lowDevice};
    const limits=terrainCacheLimits(settings);
    const {layers,skipped,unavailable}=plan(settings);
    assert.deepEqual(layers.map(entry=>entry.layer),lowDevice?['altitude','vista']:['altitude','primitive','vista','simplified']);
    assert.equal(limits.simplified.preserveOnQuota,!lowDevice);
    assert.equal(limits.primitive.preserveOnQuota,!lowDevice);
    assert.deepEqual(skipped,[]);
    assert.deepEqual(unavailable,[]);
    assert.equal(Object.values(limits).reduce((sum,entry)=>sum+entry.maxBytes,64*MiB),total*MiB);
  }
});

test('mobile low graphics reports no panorama on an LOD-only map',()=>{
  const preload=createTerrainPreload({manifest:{lod:manifest.lod},build:35,mobile:true,backgroundBusy:()=>false});
  preload.setMode(true,'configured');
  assert.deepEqual(preload.status(),{phase:'unavailable',blocked:true});
  preload.request();
  assert.equal(preload.status().phase,'unavailable');
  preload.setMode(false,'configured');
  assert.equal(preload.status().phase,'idle');
});

test('low graphics preloads its panorama even if the unused LOD layers outgrow their limits',()=>{
  const layers={...available,primitive:{...available.primitive,bytes:300*MiB},simplified:{...available.simplified,bytes:400*MiB}};
  const result=plan({mobile:true,lowDevice:true},layers);
  assert.deepEqual(result.layers.map(entry=>entry.layer),['altitude','vista']);
  assert.deepEqual(result.skipped,[]);
  assert.deepEqual(result.unavailable,[]);
});

test('mobile panorama consent does not start a normal download and canceled workers cannot change its state',t=>{
  const previousWorker=Object.getOwnPropertyDescriptor(globalThis,'Worker');
  const workers=[];
  globalThis.Worker=class {
    constructor() {workers.push(this);}
    postMessage(data) {if (data.type==='start') this.job=data;}
    terminate() {this.terminated=true;}
    report(phase) {this.onmessage({data:{phase}});}
  };
  const preload=createTerrainPreload({manifest,build:35,mobile:true,backgroundBusy:()=>false});
  t.after(()=>{
    preload.setMode(true,'storage');
    if (previousWorker) Object.defineProperty(globalThis,'Worker',previousWorker);
    else delete globalThis.Worker;
  });
  preload.setMode(true,'configured');
  assert.equal(preload.status().phase,'idle');
  preload.request();
  const [low]=workers;
  assert.equal(low.job.lowDevice,true);
  preload.setMode(false,'configured');
  assert.equal(low.terminated,true);
  low.report('storage');
  assert.equal(preload.status().phase,'idle');
  assert.equal(workers.length,1);
  preload.request();
  const normal=workers.at(-1);
  assert.equal(normal.job.lowDevice,false);
  preload.setMode(true,'configured');
  const newLow=workers.at(-1);
  normal.report('quota');
  assert.equal(preload.status().phase,'starting');
  assert.equal(newLow.terminated,undefined);
  newLow.report('ready');
  preload.setMode(false,'configured');
  assert.equal(workers.at(-1).job.lowDevice,false);
  workers.at(-1).report('ready');
});

test('preloading skips only layers that exceed their byte or entry limit',()=>{
  const layers={...available,primitive:{...available.primitive,bytes:192*MiB+1},
    vista:{...available.vista,bytes:64*MiB}};
  const limits=terrainCacheLimits();
  limits.simplified.maxEntries=1;
  const result=plan({},layers,manifest,limits);
  assert.deepEqual(result.layers.map(entry=>entry.layer),['altitude','vista']);
  assert.deepEqual(result.skipped,['primitive','simplified']);
  assert.deepEqual(result.unavailable,[]);
});

test('unknown, outdated and duplicate entries are unavailable, without being called oversize',()=>{
  const world={...manifest,lod:{...manifest.lod,regions:[[0,0],[0,0]]}};
  const layers={...available,vista:{...available.vista,hash:'c'.repeat(64)},altitude:undefined};
  const result=plan({},layers,world);
  assert.deepEqual(result.layers,[]);
  assert.deepEqual(result.skipped,[]);
  assert.deepEqual(result.unavailable,['altitude','primitive','vista','simplified']);
});
