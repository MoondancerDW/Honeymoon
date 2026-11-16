import * as THREE from '/vendor/three/three.module.js';
import {ATLAS_GRID,collisionFor,shapeFor} from '../world/geometry.mjs';

const limit = 24;
const corners = [[-1,-1],[1,-1],[1,1],[-1,1]];
const fallback = {x0:0,y0:0,z0:0,x1:1,y1:1,z1:1};

function debrisMaterial(key, material) {
  const shapes = shapeFor(material === undefined ? key : `cover-material:${material}`);
  const face = shapes.find(shape => shape.faces.some(tile => tile >= 0));
  if (!face) return null;
  const tile = [4,5,0,1,3,2].map(index => face.faces[index]).find(value => value >= 0);
  return {shapes, tile, tint:face.tint ?? face.tintFaces?.[3] ?? 0xffffff};
}

export class BlockDebris {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.bursts = [];
    this.right = new THREE.Vector3();
    this.up = new THREE.Vector3();
  }

  add({position,cell,material,voxelMaterial,boxes}, surface, rows, time) {
    if (!surface || !cell || !this.world.hasChunk(position[0],position[2])) return;
    const appearance = debrisMaterial(voxelMaterial ?? cell,material);
    if (!appearance) return;
    const volumes = boxes?.length ? boxes : material === undefined && !voxelMaterial ? appearance.shapes : [fallback];
    const light = this.world.lightAt(...position);
    const particles = [];
    const floorCell = this.world.cellAt(position[0],position[1] - 1,position[2]);
    const supports = floorCell ? collisionFor(floorCell) : [];
    for (const box of volumes.slice(0,4)) {
      const sizes = [box.x1-box.x0,box.y1-box.y0,box.z1-box.z0];
      if (sizes.some(size => size <= 0)) continue;
      const counts = sizes.map(size => Math.ceil(size * 4));
      for (let y=0; y<counts[1]; y++) for (let z=0; z<counts[2]; z++) for (let x=0; x<counts[0]; x++) {
        const local = [box.x0,box.y0,box.z0].map((edge,axis) => edge + ([x,y,z][axis] + .5) * sizes[axis] / counts[axis]);
        const [px,py,pz] = local.map((value,axis) => value + position[axis]);
        const floor = supports.filter(s => local[0] >= s.x0 && local[0] <= s.x1 && local[2] >= s.z0 && local[2] <= s.z1)
          .reduce((height,s) => Math.max(height,position[1] - 1 + s.y1),-Infinity);
        const velocity = local.map(value => (value - .5) * 2.3 + (Math.random() - .5) * .7);
        const half = .025 + Math.random() * .043;
        particles.push({x:px,y:py,z:pz,velocity,half,floor});
      }
    }
    this.addBurst(particles,appearance,surface,rows,light,time,.72);
  }

  ground(feet, contact, motion, fall, surface, rows, time) {
    if (!surface) return;
    const appearance = debrisMaterial(typeof contact.cell === 'string' ? contact.cell : contact.cell.key,contact.material);
    if (!appearance) return;
    const particles = [];
    if (fall) {
      const count = Math.min(28,Math.round(8 + fall));
      for (let i=0; i<count; i++) {
        const dx = (Math.random()-.5)*.46, dz = (Math.random()-.5)*.46;
        particles.push({x:feet.x+dx,y:contact.height+.03,z:feet.z+dz,
          velocity:[dx*5,.7+Math.random()*1.45,dz*5],half:.021+Math.random()*.024,floor:contact.height});
      }
    } else {
      const speed = Math.hypot(...motion);
      if (speed < .1) return;
      const alongX = motion[0] / speed, alongZ = motion[1] / speed;
      for (let i=0; i<4; i++) {
        const side = (i % 2 ? .24 : -.24) + (Math.random()-.5)*.14;
        const forward = i < 2 ? .43 : -.11;
        const backwards = 1.35 + speed * .25 + Math.random() * .6;
        const sideways = (Math.random()-.5)*.85;
        particles.push({x:feet.x+alongX*forward-alongZ*side,y:contact.height+.065,
          z:feet.z+alongZ*forward+alongX*side,
          velocity:[-alongX*backwards-alongZ*sideways,.95+Math.random()*.7,-alongZ*backwards+alongX*sideways],
          half:.03+Math.random()*.026,floor:contact.height});
      }
    }
    const light = this.world.lightAt(contact.position[0],contact.position[1]+1,contact.position[2]);
    this.addBurst(particles,appearance,surface,rows,light,time,fall ? .62 : .43);
  }

  addBurst(particles,{tile,tint},surface,rows,light,time,lifetime) {
    if (!particles.length) return;
    const uvs = [], indices = [];
    for (let i=0; i<particles.length; i++) {
      const offset = i * 4;
      const u = tile % ATLAS_GRID + (Math.floor(Math.random() * 13) + .05) / 16;
      const v = Math.floor(tile / ATLAS_GRID) + (Math.floor(Math.random() * 13) + .05) / 16;
      const right = (u + .24) / ATLAS_GRID, top = 1 - v / rows;
      const left = u / ATLAS_GRID, bottom = 1 - (v + .24) / rows;
      uvs.push(left,bottom,right,bottom,right,top,left,top);
      indices.push(offset,offset+1,offset+2,offset,offset+2,offset+3);
    }
    const vertices = particles.length * 4;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(vertices*3),3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
    geometry.setAttribute('legacyLightLevel',new THREE.BufferAttribute(new Uint16Array(vertices).fill(light),1));
    const colors = new Uint8Array(vertices*3);
    for (let i=0; i<colors.length; i+=3) {
      colors[i] = ((tint >> 16) & 255) * .84;
      colors[i+1] = ((tint >> 8) & 255) * .84;
      colors[i+2] = (tint & 255) * .84;
    }
    geometry.setAttribute('color',new THREE.BufferAttribute(colors,3,true));
    geometry.setIndex(indices);
    const mesh = new THREE.Mesh(geometry,surface);
    mesh.frustumCulled = false;
    if (this.bursts.length === limit) this.remove(this.bursts.shift());
    this.scene.add(mesh);
    this.bursts.push({mesh,particles,time,lifetime,previous:time});
  }

  remove({mesh}) {
    mesh.removeFromParent();
    mesh.geometry.dispose();
  }

  update(now, camera) {
    if (!this.bursts.length) return;
    this.right.set(1,0,0).applyQuaternion(camera.quaternion);
    this.up.set(0,1,0).applyQuaternion(camera.quaternion);
    this.bursts = this.bursts.filter(burst => {
      const elapsed = (now - burst.time) / 1000;
      if (elapsed >= burst.lifetime) {
        this.remove(burst);
        return false;
      }
      const dt = Math.min(.05,(now - burst.previous) / 1000);
      burst.previous = now;
      const positions = burst.mesh.geometry.attributes.position;
      const scale = Math.min(1,(burst.lifetime - elapsed) * 5);
      let vertex = 0;
      for (const particle of burst.particles) {
        const {velocity,half,floor} = particle;
        velocity[1] -= 8 * dt;
        if (particle.y + velocity[1] * dt < floor) {
          particle.y = floor;
          velocity[1] = 0;
          velocity[0] *= .85;
          velocity[2] *= .85;
        }
        particle.x += velocity[0] * dt;
        particle.y += velocity[1] * dt;
        particle.z += velocity[2] * dt;
        for (const [u,v] of corners) {
          const a = u * half * scale, b = v * half * scale;
          positions.setXYZ(vertex++,particle.x + this.right.x*a + this.up.x*b,
            particle.y + this.right.y*a + this.up.y*b,particle.z + this.right.z*a + this.up.z*b);
        }
      }
      positions.needsUpdate = true;
      return true;
    });
  }
}
