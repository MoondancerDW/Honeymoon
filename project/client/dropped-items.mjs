import * as THREE from '/vendor/three/three.module.js';
import {createPonyHeldItem} from './pony-held-item.mjs';
import {chunkKey, droppedItemPosition} from './world-data.mjs';

function appearance({key, cell, part}) {
  if (part) return {kind:'block', key, part};
  if (key.startsWith('creative:768:')) return {kind:'block', key};
  if (cell) return {kind:'block', key:cell};
  if (key.startsWith('creative:')) return {kind:'item', key:key.slice('creative:'.length)};
  return {kind:'block', key};
}

export class DroppedItemView {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.meshes = new Map();
    this.bounds = new THREE.Box3();
  }

  update(now, camera, assets, light, chunkVisible) {
    if (!assets || !this.world.droppedItems.size && !this.meshes.size) return;
    const visible = new Set();
    for (const [key, tracked] of this.world.droppedItems) {
      const [x,y,z] = droppedItemPosition(tracked,now);
      const cx = Math.floor(x) >> 4, cz = Math.floor(z) >> 4;
      if ((x - camera.x) ** 2 + (y - camera.y) ** 2 + (z - camera.z) ** 2 > 40 ** 2 ||
          !this.world.chunks.has(chunkKey(cx,cz)) || !chunkVisible(cx,cz)) continue;
      visible.add(key);
      let mesh = this.meshes.get(key);
      if (!mesh) {
        mesh = createPonyHeldItem();
        mesh.object.scale.setScalar(.26);
        mesh.phase = (Number.parseInt(key.slice(0,6),16) % 1024) / 1024 * Math.PI * 2;
        mesh.tumble = mesh.phase;
        mesh.updated = now;
        mesh.show(appearance(tracked.target.item),assets,null);
        const model = mesh.object.children.find(child => child.isMesh && child.visible);
        model.geometry.computeBoundingBox();
        const {min,max} = model.geometry.boundingBox;
        const flat = max.z - min.z < .15;
        mesh.restAngle = flat ? -Math.PI / 2 : 0;
        mesh.object.rotation.set(mesh.restAngle,mesh.phase,0,'YXZ');
        mesh.object.updateMatrixWorld(true);
        this.bounds.setFromObject(model,true);
        mesh.floorOffset = -this.bounds.min.y + .001;
        this.scene.add(mesh.object);
        this.meshes.set(key,mesh);
      }
      const {resting} = tracked.target;
      const dt = Math.min(80,now - mesh.updated);
      mesh.updated = now;
      if (!resting) mesh.tumble = (mesh.tumble + dt * .009) % (Math.PI * 2);
      mesh.object.position.set(x,y + (resting ? mesh.floorOffset : Math.max(.09,mesh.floorOffset)),z);
      mesh.object.rotation.set(resting ? mesh.restAngle : mesh.tumble,mesh.phase,0,'YXZ');
      mesh.setLight(light(x,y,z));
      mesh.object.updateMatrixWorld(true);
    }
    for (const [key, mesh] of this.meshes) {
      if (visible.has(key)) continue;
      mesh.dispose();
      this.meshes.delete(key);
    }
  }
}
