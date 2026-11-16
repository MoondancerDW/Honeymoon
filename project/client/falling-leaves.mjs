import * as THREE from '/vendor/three/three.module.js';
import {ATLAS_GRID,shapeFor} from '../world/geometry.mjs';
import {biomeLeaf,leafBlock} from './foliage-mesh.mjs';

const capacity = 20;
const keyOf = cell => typeof cell === 'string' ? cell : cell?.key;
const corners = [[-1,0],[0,-1],[1,0],[0,1]];
const uvCorners = [[.26,.74],[.74,.74],[.74,.26],[.26,.26]];

export class FallingLeaves {
  constructor(scene, world, material, rows, climate) {
    this.world = world;
    this.rows = rows;
    this.climate = climate;
    this.particles = [];
    this.nextSpawn = 0;
    this.cameraForward = new THREE.Vector3();
    const geometry = new THREE.BufferGeometry();
    const dynamic = (name,array,count,normalized) => {
      const attribute = new THREE.BufferAttribute(array,count,normalized).setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name,attribute);
      return attribute;
    };
    this.positions = dynamic('position',new Float32Array(capacity*12),3);
    this.uv = dynamic('uv',new Float32Array(capacity*8),2);
    this.colors = dynamic('color',new Uint8Array(capacity*12),3,true);
    this.light = dynamic('legacyLightLevel',new Uint16Array(capacity*4),1);
    const indices = [];
    for (let index=0;index<capacity*4;index+=4) indices.push(index,index+1,index+2,index,index+2,index+3);
    geometry.setIndex(indices);
    this.mesh = new THREE.Mesh(geometry,material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  spawn(now,camera) {
    const {x,y,z} = camera.position;
    camera.getWorldDirection(this.cameraForward);
    for (let attempt=0;attempt<10;attempt++) {
      const px = Math.floor(x + this.cameraForward.x*4 + (Math.random()-.5)*19);
      const pz = Math.floor(z + this.cameraForward.z*4 + (Math.random()-.5)*19);
      if (!this.world.hasChunk(px,pz)) continue;
      const py = Math.floor(y + 1 + Math.random()*5);
      const key = keyOf(this.world.cellAt(px,py,pz));
      if (!leafBlock(key) || this.world.cellAt(px,py-1,pz)) continue;
      const shape = shapeFor(key)[0];
      const tint = (biomeLeaf(key) ? this.climate.tintAt(px,pz).leaves : shape.tint) ?? 0x689c45;
      this.particles.push({x:px+.16+Math.random()*.68, y:py-.08, z:pz+.16+Math.random()*.68,
        born:now, duration:3+Math.random()*2, drift:Math.random()*6.28, size:.073+Math.random()*.045,
        tile:shape.faces[0], color:[(tint>>16)&255,(tint>>8)&255,tint&255]});
      return;
    }
  }

  update(now,camera,wind) {
    if (now >= this.nextSpawn && this.particles.length < capacity) {
      this.nextSpawn = now + 320 + Math.random()*190;
      this.spawn(now,camera);
    }
    const {x:eyeX,y:eyeY,z:eyeZ} = camera.position;
    let count = 0;
    this.particles = this.particles.filter(leaf => {
      const age = (now - leaf.born) / 1000;
      if (age > leaf.duration) return false;
      const phase = age * 2.4 + leaf.drift;
      const x = leaf.x + Math.sin(phase)*.28 + age*.25*wind.x;
      const y = leaf.y - age*.42;
      const z = leaf.z + Math.cos(phase)*.21 + age*.25*wind.z;
      if ((x-eyeX)**2 + (y-eyeY)**2 + (z-eyeZ)**2 > 28**2) return false;
      const block = this.world.cellAt(Math.floor(x),Math.floor(y),Math.floor(z));
      if (block && !leafBlock(keyOf(block))) return false;
      const intensity = this.world.lightAt(Math.floor(x),Math.floor(y),Math.floor(z));
      const yaw = leaf.drift + age*.78, tilt = Math.sin(phase)*1.1;
      const dx = Math.cos(yaw), dz = Math.sin(yaw), roll = Math.sin(tilt), up = Math.cos(tilt);
      const size = leaf.size*Math.min(1,age*6,(leaf.duration-age)*6);
      const tileU = leaf.tile % ATLAS_GRID, tileV = Math.floor(leaf.tile/ATLAS_GRID);
      for (let corner=0;corner<4;corner++) {
        const [u,v] = corners[corner], [s,t] = uvCorners[corner];
        const index = count*4+corner;
        this.positions.setXYZ(index,x+size*(u*dx-v*dz*roll),y+size*v*up*.7,z+size*(u*dz+v*dx*roll));
        this.uv.setXY(index,(tileU+s)/ATLAS_GRID,1-(tileV+t)/this.rows);
        this.colors.array.set(leaf.color,index*3);
        this.light.setX(index,intensity);
      }
      count++;
      return true;
    });
    this.mesh.visible = count > 0;
    if (count) {
      this.mesh.geometry.setDrawRange(0,count*6);
      this.positions.needsUpdate = this.uv.needsUpdate = this.colors.needsUpdate = this.light.needsUpdate = true;
    }
    return count;
  }
}
