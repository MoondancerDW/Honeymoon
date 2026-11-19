import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {test} from 'node:test';
import * as THREE from 'three';

const hooks=registerHooks({
  resolve(specifier,context,nextResolve) {
    return nextResolve(specifier==='/vendor/three/three.module.js' ? 'three' : specifier,context);
  },
});
const {NpcView}=await import('./npc-models.mjs');
hooks.deregister();

test('visible NPCs update their world matrices in the manually updated world scene',()=>{
  const scene=new THREE.Scene();
  scene.matrixWorldAutoUpdate=false;
  const camera=new THREE.PerspectiveCamera();
  camera.position.set(100,65,-80);
  const view=new NpcView(scene,camera,()=>null);
  const id='test-npc';
  view.replace([{id,position:{x:102,y:64,z:-80},showName:false}]);
  const row=view.entries.get(id);
  const model=new THREE.Group();
  const mesh=new THREE.Mesh();
  model.add(mesh);
  row.object.add(model);
  row.actor={height:1.5,width:1,depth:1,animate:({time})=>{mesh.position.y=time;},setLight() {}};

  view.update(1000,.05);
  assert.equal(row.object.visible,true);
  assert.deepEqual(row.object.matrixWorld.elements.slice(12,15),[102,64,-80]);
  assert.deepEqual(mesh.matrixWorld.elements.slice(12,15),[102,65,-80]);

  view.motion([{id,position:{x:103,y:64,z:-80}}]);
  view.update(2000,.05);
  assert.ok(row.object.position.x>102 && row.object.position.x<103);
  assert.deepEqual(mesh.matrixWorld.elements.slice(12,15),[row.object.position.x,66,-80]);
});
