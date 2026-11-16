import * as THREE from '/vendor/three/three.module.js';
import {RainCover} from './rain-cover.mjs';

const capacity = 680, reach = 17;

export class Rain {
  constructor(scene,world,climate) {
    this.climate = climate;
    this.cover = new RainCover(world);
    this.particles = Array.from({length:capacity},()=>({}));
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,0,0,1,0,0,-1,1,0,1,1,0],3));
    geometry.setIndex([0,1,2,2,1,3]);
    const instanceAttribute = (name,size) => {
      const attribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity*size),size)
        .setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name,attribute);
      return attribute;
    };
    this.starts = instanceAttribute('streakStart',3);
    this.ends = instanceAttribute('streakEnd',3);
    this.details = instanceAttribute('streakDetails',3);
    this.material = new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,forceSinglePass:true,
      uniforms:{brightness:{value:1}},
      vertexShader:`
        attribute vec3 streakStart;
        attribute vec3 streakEnd;
        attribute vec3 streakDetails;
        varying vec3 precipitation;
        varying vec2 texturePoint;
        void main() {
          precipitation = streakDetails;
          texturePoint = position.xy;
          vec3 middle = (streakStart+streakEnd)*.5;
          vec3 toCamera = cameraPosition-middle;
          vec3 edge = cross(streakEnd-streakStart,toCamera);
          float size = length(edge);
          vec3 across = size > .00001 ? edge/size : vec3(1.0,0.0,0.0);
          vec3 point = mix(streakStart,streakEnd,position.y) + across*position.x*streakDetails.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(point,1.0);
        }`,
      fragmentShader:`
        varying vec3 precipitation;
        varying vec2 texturePoint;
        uniform float brightness;
        void main() {
          bool snow = precipitation.z > .5;
          float coverage = snow
            ? 1.0-smoothstep(.25,1.0,length(vec2(texturePoint.x,texturePoint.y*2.0-1.0)))
            : (1.0-smoothstep(.30,1.0,abs(texturePoint.x))) * (1.0-.82*texturePoint.y);
          vec3 color = snow ? vec3(.79,.85,.92) : vec3(.61,.74,.86);
          gl_FragColor = vec4(color,precipitation.x*coverage*brightness);
          #include <colorspace_fragment>
        }`});
    this.mesh = new THREE.Mesh(geometry,this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
    const bolt=new THREE.BufferGeometry();
    bolt.setAttribute('position',new THREE.BufferAttribute(new Float32Array(3*24),3));
    this.lightning=new THREE.LineSegments(bolt,new THREE.LineBasicMaterial({color:0xcbdcfb,transparent:true,depthWrite:false}));
    this.lightning.frustumCulled=false;
    this.lightning.visible=false;
    scene.add(this.lightning);
  }

  visible(enabled) {
    this.mesh.visible=enabled;
    if (!enabled) {
      this.last=undefined;
      this.lightning.visible=false;
      this.listenerAt=undefined;
      this.visibleSnow=0;
    }
  }

  invalidate(x,z) {
    this.cover.invalidate(x,z);
    this.listenerAt=undefined;
  }

  flash(strike,camera) {
    this.lightning.visible=Boolean(strike?.flash);
    if (!this.lightning.visible) return;
    if (strike.id!==this.strikeId) {
      this.strikeId=strike.id;
      const x=camera.x+Math.cos(strike.angle)*46;
      const z=camera.z+Math.sin(strike.angle)*46;
      const ground=this.cover.heightAt(x,z);
      const bottom=Number.isFinite(ground) ? ground : camera.y-18;
      const data=this.lightning.geometry.attributes.position;
      let ax=x, az=z, ay=Math.max(camera.y+52,bottom+48);
      const step=(ay-bottom)/10;
      for (let i=0;i<10;i++) {
        const bx=x+4*Math.sin(i*9.9+strike.angle), bz=z+3*Math.cos(i*13.6+strike.angle), by=ay-step;
        data.setXYZ(2*i,ax,ay,az);
        data.setXYZ(2*i+1,bx,by,bz);
        ax=bx; ay=by; az=bz;
      }
      data.setXYZ(20,data.getX(5),data.getY(5),data.getZ(5));
      data.setXYZ(21,data.getX(5)+8,data.getY(5)-11,data.getZ(5)-5);
      data.setXYZ(22,data.getX(11),data.getY(11),data.getZ(11));
      data.setXYZ(23,data.getX(11)-5,data.getY(11)-9,data.getZ(11)+6);
      data.needsUpdate=true;
    }
    this.lightning.material.opacity=strike.flash*.92;
  }

  step(now,camera,direction,brightness,wind,strength,listener,strike,budget=capacity,globalSnow=false) {
    const dt = Math.min(.045,(now-(this.last ?? now))/1000);
    this.last = now;
    this.material.uniforms.brightness.value=brightness;
    this.cover.beginFrame();
    if (now>=(this.listenerAt ?? 0)) {
      this.listenerAt=now+120;
      this.listenerCover=this.cover.listener(listener);
      this.listenerSheltered=this.listenerCover.sheltered;
    }
    const count=Math.round(budget*strength);
    let shown = 0, snowy = 0;
    for (let i=0;i<count;i++) {
      const particle = this.particles[i];
      const resetAtSide = !Number.isFinite(particle.x) || Math.abs(particle.x-camera.x)>reach+4 ||
        Math.abs(particle.z-camera.z)>reach+4 || particle.y>camera.y+20;
      const reset = resetAtSide || particle.y<camera.y-10;
      if (reset) {
        particle.x=camera.x+(Math.random()-.5)*reach*2;
        particle.z=camera.z+(Math.random()-.5)*reach*2;
        particle.y=camera.y+5+Math.random()*11-(dt && !resetAtSide ? 0 : Math.random()*19);
        particle.speed=12+Math.random()*8;
        particle.depth=.65+Math.random()*.7;
        particle.phase=Math.random()*6.283;
      }
      const snow=globalSnow || this.climate.snowAt(particle.x,particle.y,particle.z);
      const wx=snow ? .36+wind.x*.48+.22*Math.sin(now*.0015+particle.phase) : (.35+wind.x*4.4)*particle.depth;
      const wz=snow ? .16+wind.z*.48+.12*Math.cos(now*.0013+particle.phase) : .26+wind.z*3.6;
      particle.x+=wx*dt;
      particle.z+=wz*dt;
      particle.y-=particle.speed*(snow ? .09 : 1)*dt;
      const rx=particle.x-camera.x, ry=particle.y-camera.y, rz=particle.z-camera.z;
      const distance=Math.hypot(rx,ry,rz);
      if (distance<1.26 || direction.x*rx+direction.y*ry+direction.z*rz<distance*.34) continue;
      const length = snow ? .050+particle.depth*.043 : .46+particle.depth*.27;
      const dx=-wx*(snow ? .012 : .047), dz=-wz*(snow ? .012 : .047);
      const width = snow ? length*.49 : Math.min(.045,.012+distance*.00155);
      const fraction = this.cover.fraction(particle.x,particle.y,particle.z,dx,length,dz,width);
      if (fraction<.06) continue;
      const opacity = Math.min(snow ? .81 : .74,(distance-1.26)*.22) * Math.max(.24,1-distance / 34);
      this.starts.setXYZ(shown,particle.x,particle.y,particle.z);
      this.ends.setXYZ(shown,particle.x+dx*fraction,particle.y+length*fraction,particle.z+dz*fraction);
      this.details.setXYZ(shown++,opacity,width,Number(snow));
      snowy+=Number(snow);
    }
    this.mesh.geometry.instanceCount=shown;
    for (const [attribute,components] of [[this.starts,3],[this.ends,3],[this.details,3]]) {
      attribute.clearUpdateRanges();
      if (shown) attribute.addUpdateRange(0,shown*components);
      attribute.needsUpdate=true;
    }
    this.mesh.visible=true;
    this.visibleSnow=snowy;
    this.flash(strike,camera);
    return shown;
  }
}
