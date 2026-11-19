import * as THREE from '/vendor/three/three.module.js';

const burstLimit=12;
const lifetime=1.15;
const colors=[0x1c1714,0x312824,0x473832,0x685048,0xd64f19,0xff9032].map(color=>new THREE.Color(color));

export class LavaDeathParticles {
  constructor(scene) {
    this.scene=scene;
    this.bursts=[];
  }

  add(parts,center,now) {
    const point=new THREE.Vector3();
    const particles=[];
    for (const part of parts) {
      const geometry=part.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const {min,max}=geometry.boundingBox;
      for (let i=0;i<6;i++) {
        point.set(
          THREE.MathUtils.lerp(min.x,max.x,Math.random()),
          THREE.MathUtils.lerp(min.y,max.y,Math.random()),
          THREE.MathUtils.lerp(min.z,max.z,Math.random()),
        ).applyMatrix4(part.matrixWorld);
        particles.push({x:point.x,y:point.y,z:point.z,
          vx:(point.x-center.x)*1.8+(Math.random()-.5)*1.4,
          vy:1.05+Math.random()*1.75,
          vz:(point.z-center.z)*1.8+(Math.random()-.5)*1.4});
      }
    }
    if (!particles.length) return;

    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(particles.length*3),3)
      .setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('color',new THREE.Float32BufferAttribute(particles.flatMap((_,index)=>
      colors[index%colors.length].toArray()),3));
    const material=new THREE.PointsMaterial({size:.076,vertexColors:true,transparent:true,
      depthWrite:false,toneMapped:false,fog:false});
    const mesh=new THREE.Points(geometry,material);
    mesh.frustumCulled=false;
    if (this.bursts.length>=burstLimit) this.remove(this.bursts.shift().mesh);
    this.scene.add(mesh);
    mesh.updateMatrixWorld();
    this.bursts.push({mesh,particles,now});
  }

  remove(mesh) {
    mesh.removeFromParent();
    mesh.geometry.dispose();
    mesh.material.dispose();
  }

  update(now) {
    this.bursts=this.bursts.filter(({mesh,particles,now:started})=>{
      const age=(now-started)*.001;
      if (age>=lifetime) {
        this.remove(mesh);
        return false;
      }
      const positions=mesh.geometry.attributes.position;
      for (const [index,{x,y,z,vx,vy,vz}] of particles.entries()) {
        positions.setXYZ(index,x+vx*age,y+vy*age-1.05*age*age,z+vz*age);
      }
      positions.needsUpdate=true;
      mesh.material.opacity=Math.min(1,(lifetime-age)*3);
      return true;
    });
  }

  get count() {
    return this.bursts.reduce((sum,burst)=>sum+burst.particles.length,0);
  }
}
