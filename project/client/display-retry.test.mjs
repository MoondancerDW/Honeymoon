import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {test} from 'node:test';
import * as THREE from 'three';

const hooks=registerHooks({
  resolve(specifier,context,nextResolve) {
    return nextResolve(specifier==='/vendor/three/three.module.js' ? 'three' : specifier,context);
  },
});
const {Display}=await import('./display.mjs');
hooks.deregister();

function display() {
  return Object.assign(Object.create(Display.prototype),{
    pending:new Map(),active:new Map(),ready:[],uploads:[],versions:new Map(),installedVersions:new Map(),
    workerCatalogs:new Map(),failedWorkers:new Set(),workers:[],workerFailure:null,
    groups:new Map(),preciseLevels:new Map(),nextSectionVersion:50,
    renderer:{getContext:()=>({isContextLost:()=>false})},
    world:{manifest:{bounds:{minY:0,maxY:511}},chunks:new Map()},
  });
}

test('graphics retry preserves installed and queued sections while recovering lost work',()=>{
  const view=display();
  const levels=[1,2,3,4,5,6,7,8];
  const id=y=>'0,'+y+',0';
  view.world.chunks.set('0,0',{sections:new Map(levels.map(y=>[y,true]))});
  for (const y of levels) view.versions.set(id(y),y);
  view.installedVersions.set(id(1),1);
  const goodMesh={name:'resident'};
  view.groups.set(id(1),goodMesh);
  view.ready.push({id:id(2),version:2},{id:id(3),version:1});
  view.uploads.push({result:{id:id(4),version:4}});
  view.pending.set(id(5),{id:id(5),version:5});
  const crashed={terminate(){this.stopped=true;}}, healthy={};
  view.workers.push(crashed,healthy);
  const lost={id:id(6),version:6,startedAt:performance.now()};
  view.active.set(crashed,lost);
  view.active.set(healthy,{id:id(7),version:7,startedAt:performance.now()});
  view.failedWorkers.add(crashed);
  view.workerCatalogs.set(crashed,1);
  view.workerFailure=new Error('crash');
  const restarted={};
  view.createMeshWorker=()=>restarted;

  view.retryGraphics([[0,0]],{position:{y:64}});

  assert.deepEqual(view.workers,[restarted,healthy]);
  assert.equal(crashed.stopped,true);
  assert.equal(view.workerCatalogs.has(crashed),false);
  assert.equal(view.workerFailure,null);
  assert.equal(view.pending.get(id(6)),lost);
  assert.deepEqual([...view.pending.keys()],[id(5),id(6),id(3),id(8)]);
  assert.equal(view.versions.get(id(3)),51);
  assert.equal(view.groups.get(id(1)),goodMesh);
  assert.equal(view.active.has(healthy),true);
  assert.equal(view.ready.length,2);
  assert.equal(view.uploads.length,1);
  assert.equal(view.chunksReady([[0,0]],{y:64}),false);
  for (const [key,version] of view.versions) view.installedVersions.set(key,version);
  assert.equal(view.chunksReady([[0,0]],{y:64}),true);
});

test('a startup section can mesh before its neighbors without duplicating in-flight work',()=>{
  const view=display();
  view.camera=new THREE.PerspectiveCamera();
  view.neighborsLoaded=()=>false;
  view.startupChunks=new Set(['0,0']);
  view.workers=[{},{}];
  const messages=[];
  view.dispatchMesh=(_worker,job)=>messages.push(job);
  const precise={id:'0,4,0',type:'precise',cx:0,cy:4,cz:0,version:1};
  view.pending.set(precise.id,precise);

  view.dispatch(Infinity);
  assert.deepEqual(messages,[precise]);
  view.pending.set(precise.id,{...precise,version:2});
  view.dispatch(Infinity);
  assert.deepEqual(messages,[precise]);
  assert.equal(view.pending.get(precise.id).version,2);
  view.active.delete(view.workers[0]);
  view.dispatch(Infinity);
  assert.deepEqual(messages.map(job=>job.version),[1,2]);
});

test('graphics upload failure retains all staged meshes for retry',()=>{
  const view=display();
  const geometries=Array.from({length:3},()=>new THREE.PlaneGeometry());
  const meshes=geometries.map(geometry=>new THREE.Mesh(geometry));
  view.uploadScene=new THREE.Scene();
  Object.assign(view.renderer,{
    setScissor(){},
    setScissorTest(){},
    render(){throw new Error('temporary renderer failure');},
  });
  const first={meshes:[meshes[0]]};
  const second={meshes:meshes.slice(1)};
  view.uploads.push(first,second);
  view.upload(Infinity,Infinity);

  assert.match(view.workerFailure.message,/temporary/);
  assert.deepEqual(view.uploads,[first,second]);
  assert.deepEqual(first.meshes,[meshes[0]]);
  assert.deepEqual(second.meshes,meshes.slice(1));
  assert.equal(view.uploadScene.children.length,0);
  assert.ok(geometries.every(geometry=>geometry.drawRange.count===Infinity));
});
