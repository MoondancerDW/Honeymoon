import * as THREE from '/vendor/three/three.module.js';
import {createPonyAvatar} from './pony-avatar.mjs';
import {equipmentTextureReady} from './pony-armor.mjs';

const previews = new WeakMap();

function createPreview(canvas) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({canvas,antialias:true});
  } catch { return null; }
  renderer.setSize(canvas.width,canvas.height,false);
  renderer.setClearColor(0x070b10);
  const scene = new THREE.Scene();
  const aspect = canvas.width/canvas.height;
  const camera = new THREE.OrthographicCamera(-aspect*1.13,aspect*1.13,1.13,-1.13,.01,10);
  camera.position.set(2.1,1.55,-3.6);
  camera.lookAt(0,.91,0);
  const avatar = createPonyAvatar(()=>true);
  scene.add(avatar.object);
  return {renderer,scene,avatar,camera,lastSkin:undefined};
}

export function renderInventoryPreview(canvas,equipment,skin,ponyType,size) {
  if (!previews.has(canvas)) previews.set(canvas,createPreview(canvas));
  const preview = previews.get(canvas);
  if (!preview) return;
  const {renderer,scene,avatar,camera} = preview;
  function draw() {
    if (canvas.hidden || !canvas.closest('dialog')?.open) return;
    avatar.animate({time:0,dt:1/60,speed:0,motion:'idle',stance:'stand',
      yawOffset:.16,pitch:-.06,position:avatar.object.position,equipment});
    renderer.render(scene,camera);
  }
  draw();
  if (preview.lastSkin !== skin || preview.lastPonyType !== ponyType || preview.lastSize !== size) {
    preview.lastSkin = skin;
    preview.lastPonyType = ponyType;
    preview.lastSize = size;
    void avatar.setSkin(skin,ponyType,size).then(draw);
  }
  if (equipment?.some(Boolean)) void equipmentTextureReady().then(draw);
}
