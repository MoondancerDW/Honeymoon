import * as THREE from '/vendor/three/three.module.js';
import {collisionFor} from '../world/geometry.mjs';
import {chunkKey} from './world-data.mjs';

const drops = 224, reach = 16;

export class Rain {
  constructor(scene,world) {
    this.world = world;
    this.columns = new Map();
    this.particles = Array.from({length:drops},()=>({}));
    const geometry = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array(drops*6),3).setUsage(THREE.DynamicDrawUsage);
    this.colors = new THREE.BufferAttribute(new Float32Array(drops*2),1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position',this.positions);
    geometry.setAttribute('rainOpacity',this.colors);
    this.material = new THREE.ShaderMaterial({transparent:true,depthWrite:false,
      uniforms:{brightness:{value:1}},
      vertexShader:`attribute float rainOpacity;
        varying float opacity;
        void main() {
          opacity = rainOpacity;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
        }`,
      fragmentShader:`varying float opacity;
        uniform float brightness;
        void main() {
          gl_FragColor = vec4(vec3(.52,.66,.76),opacity * brightness);
          #include <colorspace_fragment>
        }`});
    this.mesh = new THREE.LineSegments(geometry,this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  coverHeight(x,z,now) {
    const key = `${x},${z}`;
    const saved = this.columns.get(key);
    if (saved && saved.expires > now) return saved.height;
    if (!this.columnBudget) return saved?.height ?? Infinity;
    const chunk = this.world.chunks.get(chunkKey(x>>4,z>>4));
    if (!chunk || chunk.visualOnly) return Infinity;
    this.columnBudget--;
    let y = -1;
    for (const cy of chunk.sections.keys()) y = Math.max(y,cy * 16 + 15);
    for (const edit of this.world.editsInChunk(x>>4,z>>4)) {
      if (edit.x === x && edit.z === z && edit.cell) y = Math.max(y,edit.y);
    }
    let height = -Infinity;
    for (;y>=0;y--) {
      const cell = this.world.cellAt(x,y,z);
      if (!cell) continue;
      const neighbors = (dx,dy,dz)=>this.world.cellAt(x+dx,y+dy,z+dz);
      const top = collisionFor(cell,neighbors).filter(box=>box.x0 <= .5 && box.x1 >= .5 &&
        box.z0 <= .5 && box.z1 >= .5).reduce((value,box)=>Math.max(value,Math.min(1,box.y1)),0);
      if (top) { height=y+top; break; }
    }
    if (this.columns.size >= 2200 && !saved) this.columns.delete(this.columns.keys().next().value);
    this.columns.set(key,{height,expires:now+1250+Math.random()*500});
    return height;
  }

  visible(enabled) {
    this.mesh.visible=enabled;
    if (!enabled) this.last=undefined;
  }

  invalidate(x,z) {
    this.columns.delete(`${x},${z}`);
  }

  step(now,camera,brightness) {
    const dt = Math.min(.045,(now-(this.last ?? now))/1000);
    this.last = now;
    this.material.uniforms.brightness.value=brightness;
    const gust = Math.sin(now*.00096)*1.45+Math.sin(now*.0021+.6)*.65;
    this.columnBudget = 24;
    let count = 0;
    for (const particle of this.particles) {
      const reset = !Number.isFinite(particle.x) || Math.abs(particle.x-camera.x)>reach+4 ||
        Math.abs(particle.z-camera.z)>reach+4 || particle.y < camera.y-10 || particle.y>camera.y+20;
      if (reset) {
        particle.x=camera.x+(Math.random()-.5)*reach*2;
        particle.z=camera.z+(Math.random()-.5)*reach*2;
        particle.y=camera.y+6+Math.random()*10-(dt ? 0 : Math.random()*18);
        particle.speed=10+Math.random()*8;
        particle.depth=.65+Math.random()*.7;
      }
      const wind=(2.25+gust)*particle.depth;
      particle.x+=wind*dt;
      particle.z+=(.9+gust*.4)*dt;
      particle.y-=particle.speed*dt;
      const cover = this.coverHeight(Math.floor(particle.x),Math.floor(particle.z),now);
      if (particle.y<=cover) continue;
      const distance = Math.hypot(particle.x-camera.x,particle.y-camera.y,particle.z-camera.z);
      if (distance<1.65) continue;
      const opacity = Math.min(.34,(distance-1.65)*.085) * Math.max(.12,1-distance / 27);
      const length = .26+particle.depth*.24;
      this.positions.setXYZ(count,particle.x,particle.y,particle.z);
      this.colors.setX(count++,opacity);
      this.positions.setXYZ(count,particle.x-wind*.038,particle.y+length,particle.z-(.9+gust*.4)*.038);
      this.colors.setX(count++,opacity*.14);
    }
    this.mesh.geometry.setDrawRange(0,count);
    this.positions.needsUpdate = this.colors.needsUpdate = true;
    this.mesh.visible=true;
    return count/2;
  }
}
