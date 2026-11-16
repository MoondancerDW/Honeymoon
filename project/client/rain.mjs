import * as THREE from '/vendor/three/three.module.js';
import {RainCover} from './rain-cover.mjs';

const rainDrops = 224, snowFlakes = 344, reach = 15;

export class Rain {
  constructor(scene,world,climate) {
    this.climate = climate;
    this.cover = new RainCover(world);
    this.particles = Array.from({length:snowFlakes},()=>({}));
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,0,0,1,0,0,-1,1,0,1,1,0],3));
    geometry.setIndex([0,1,2,2,1,3]);
    const instanceAttribute = (name,size) => {
      const attribute = new THREE.InstancedBufferAttribute(new Float32Array(snowFlakes*size),size)
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
  }

  visible(enabled) {
    this.mesh.visible=enabled;
    if (!enabled) this.last=undefined;
  }

  invalidate(x,z) { this.cover.invalidate(x,z); }

  step(now,camera,brightness) {
    const dt = Math.min(.045,(now-(this.last ?? now))/1000);
    this.last = now;
    this.material.uniforms.brightness.value=brightness;
    const gust = Math.sin(now*.00096)*1.45+Math.sin(now*.0021+.6)*.65;
    this.cover.beginFrame();
    this.listenerSheltered = camera.y<=this.cover.heightAt(camera.x,camera.z);
    const nearSnow = camera.y > 135 && [0,-12,12].some(dx=>[0,-12,12]
      .some(dz=>this.climate.snowAt(camera.x+dx,camera.y+17,camera.z+dz)));
    const count = nearSnow ? snowFlakes : rainDrops;
    let shown = 0, snowy = 0;
    for (let i=0;i<count;i++) {
      const particle = this.particles[i];
      const reset = !Number.isFinite(particle.x) || Math.abs(particle.x-camera.x)>reach+4 ||
        Math.abs(particle.z-camera.z)>reach+4 || particle.y < camera.y-10 || particle.y>camera.y+20;
      if (reset) {
        const spread = i<rainDrops ? reach : reach*.78;
        particle.x=camera.x+(Math.random()-.5)*spread*2;
        particle.z=camera.z+(Math.random()-.5)*spread*2;
        particle.y=camera.y+5+Math.random()*11-(dt && i<rainDrops ? 0 : Math.random()*17);
        particle.speed=10+Math.random()*8;
        particle.depth=.65+Math.random()*.7;
        particle.phase=Math.random()*6.283;
      }
      const snow=this.climate.snowAt(particle.x,particle.y,particle.z);
      if (i>=rainDrops && !snow) { particle.x=NaN; continue; }
      const wind=snow ? .36+gust*.13+.22*Math.sin(now*.0015+particle.phase) : (2.25+gust)*particle.depth;
      const drift=snow ? .16+.12*Math.cos(now*.0013+particle.phase) : .9+gust*.4;
      particle.x+=wind*dt;
      particle.z+=drift*dt;
      particle.y-=particle.speed*(snow ? .095 : 1)*dt;
      const distance = Math.hypot(particle.x-camera.x,particle.y-camera.y,particle.z-camera.z);
      if (distance<1.45) continue;
      const length = snow ? .038+particle.depth*.035 : .37+particle.depth*.24;
      const dx=-wind*(snow ? .012 : .043), dz=-drift*(snow ? .012 : .043);
      const width = snow ? length*.49 : Math.min(.038,.009+distance*.0014);
      const fraction = this.cover.fraction(particle.x,particle.y,particle.z,dx,length,dz,width);
      if (fraction<.06) continue;
      const opacity = Math.min(snow ? .65 : .54,(distance-1.45)*.16) * Math.max(.18,1-distance / 30);
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
    return shown;
  }
}
