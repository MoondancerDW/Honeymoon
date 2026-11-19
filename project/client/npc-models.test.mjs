import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {test} from 'node:test';
import * as THREE from 'three';
import {isNpcEditorWand,NPC_EDITOR_WAND_KEY} from '../world/npc-editor-wand.mjs';

const hooks=registerHooks({
  resolve(specifier,context,nextResolve) {
    return nextResolve(specifier==='/vendor/three/three.module.js' ? 'three' : specifier,context);
  },
});
const {NpcView}=await import('./npc-models.mjs');
hooks.deregister();

test('only the selected NPC wand reveals explicitly hidden names and the source attack mode is preserved',()=>{
  const view=new NpcView(new THREE.Scene(),new THREE.PerspectiveCamera(),()=>null);
  const hidden={showName:false};
  const combat={showName:false,showNameWhenAttacking:true};
  assert.equal(view.nameVisible({showName:true}),true);
  assert.equal(view.nameVisible(hidden),false);
  assert.equal(view.nameVisible({...combat,animation:'idle'}),false);
  assert.equal(view.nameVisible({...combat,animation:'attack'}),true);
  view.setRevealHiddenNames(isNpcEditorWand({key:NPC_EDITOR_WAND_KEY}));
  assert.equal(view.nameVisible(hidden),true);
  view.setRevealHiddenNames(isNpcEditorWand({key:'creative:26981:0'}));
  assert.equal(view.nameVisible(hidden),false);
});

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

test('NPC body spin continues between motion updates and stops on a new fixed pose',()=>{
  const camera=new THREE.PerspectiveCamera();
  camera.position.set(0,65,4);
  const view=new NpcView(new THREE.Scene(),camera,()=>null);
  const npc={id:'turning',position:{x:0,y:64,z:0},showName:false,yaw:Math.PI/2,spinSpeed:-90};
  view.replace([npc],1000);
  const row=view.entries.get(npc.id);
  let headYaw;
  row.actor={height:1.5,width:1,depth:1,animate:p=>{headYaw=p.headYaw;},setLight() {}};
  const angleEquals=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-4,`${actual} != ${expected}`);
  view.update(1000,1);
  angleEquals(row.object.rotation.y,Math.PI/2);

  view.motion([{id:npc.id,yaw:npc.yaw,spinSpeed:npc.spinSpeed,headYaw:.3}],1250);
  view.update(1500,1);
  angleEquals(row.object.rotation.y,Math.PI/4);
  angleEquals(headYaw,.3);

  view.motion([{id:npc.id,yaw:0,spinSpeed:null,headYaw:0}],2000);
  view.update(2000,1);
  view.update(3000,1);
  angleEquals(row.object.rotation.y,0);
  angleEquals(headYaw,0);
  assert.deepEqual(row.object.position.toArray(),[0,64,0]);
});
