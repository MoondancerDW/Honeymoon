import * as THREE from '/vendor/three/three.module.js';
import {collisionFor} from '../world/geometry.mjs';
import {extractedModel} from '../world/extracted-models.mjs';

const spread = 1.05;
const reach = 2.5;
const vertices = 64 * 4 * 4 * 6;

function shadowTexture() {
  const size = 64;
  const bytes = new Uint8Array(size * size * 4).fill(255);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const radius = Math.hypot((x + .5) * 2 / size - 1, (y + .5) * 2 / size - 1);
    const fade = Math.max(0, 1 - radius);
    bytes[4 * (x + y * size) + 3] = Math.round(255 * fade * fade * (3 - 2 * fade));
  }
  const texture = new THREE.DataTexture(bytes, size, size);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export class PonyShadows {
  constructor(scene, world) {
    this.world = world;
    this.geometry = new THREE.BufferGeometry();
    this.position = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.uv = new THREE.BufferAttribute(new Float32Array(vertices * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.color = new THREE.BufferAttribute(new Float32Array(vertices * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.position);
    this.geometry.setAttribute('uv', this.uv);
    this.geometry.setAttribute('color', this.color);
    this.geometry.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({color:0x0a1524, map:shadowTexture(),
      transparent:true, vertexColors:true, depthWrite:false, polygonOffset:true, polygonOffsetFactor:-1, polygonOffsetUnits:-1}));
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  surface(x, z, feet, minX, maxX, minZ, maxZ) {
    for (let y = Math.floor(feet + .08); y >= Math.floor(feet - reach) - 1; y--) {
      const cell = this.world.cellAt(x, y, z);
      if (!cell) continue;
      const neighbors = (dx,dy,dz) => this.world.cellAt(x + dx,y + dy,z + dz);
      const boxes = extractedModel(this.world.models, cell, neighbors)?.collision ?? collisionFor(cell, neighbors);
      let best;
      for (const box of boxes) {
        const top = y + box.y1;
        if (top > feet + .08 || top < feet - reach || top <= (best?.top ?? -Infinity)) continue;
        const left = Math.max(minX, x + box.x0), right = Math.min(maxX, x + box.x1);
        const north = Math.max(minZ, z + box.z0), south = Math.min(maxZ, z + box.z1);
        if (left < right && north < south) best = {top,left,right,north,south};
      }
      if (best) return best;
    }
  }

  update(actors, eye) {
    let vertex = 0;
    for (const actor of actors) {
      const {x,y,z} = actor.position;
      if (!actor.visible || eye.distanceToSquared(actor.position) > 32 ** 2) continue;
      const minX = x - spread, maxX = x + spread, minZ = z - spread, maxZ = z + spread;
      const yaw = actor.rotation.y, cos = Math.cos(yaw), sin = Math.sin(yaw);
      for (let bz = Math.floor(minZ); bz <= Math.floor(maxZ); bz++) for (let bx = Math.floor(minX); bx <= Math.floor(maxX); bx++) {
        if (vertex + 6 > vertices) break;
        const surface = this.surface(bx,bz,y,minX,maxX,minZ,maxZ);
        if (!surface) continue;
        const {top,left,right,north,south} = surface;
        const height = Math.max(0,y - top);
        const alpha = .38 * (1 - height / reach) ** 2;
        const width = .62 + .14 * height, length = .91 + .09 * height;
        for (const [px,pz] of [[left,north],[left,south],[right,south],[left,north],[right,south],[right,north]]) {
          this.position.setXYZ(vertex,px,top + .006,pz);
          const dx = px - x, dz = pz - z;
          this.uv.setXY(vertex,.5 + (dx * cos - dz * sin) / (2 * width), .5 + (dx * sin + dz * cos) / (2 * length));
          this.color.setXYZW(vertex,1,1,1,alpha);
          vertex++;
        }
      }
    }
    this.mesh.visible = vertex > 0;
    this.geometry.setDrawRange(0, vertex);
    if (vertex) for (const attribute of [this.position,this.uv,this.color]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, vertex * attribute.itemSize);
      attribute.needsUpdate = true;
    }
  }
}
