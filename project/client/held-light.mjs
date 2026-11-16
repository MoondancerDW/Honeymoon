import * as THREE from '/vendor/three/three.module.js';
import {fillHeldLight, heldLightOcclusion, HELD_LIGHT_RADIUS, HELD_LIGHT_SIDE, HELD_LIGHT_VOXELS} from '../world/held-light.mjs';

const limit = 4;
const range = 32;
const side = HELD_LIGHT_SIDE;
const radius = HELD_LIGHT_RADIUS;

const fragment = `
  varying vec3 heldWorld;
  varying vec3 unlitTint;
  varying float terrainSky;
  uniform sampler2D honeymoonLightmap;
  uniform highp sampler3D heldLightVolume;
  uniform int heldLightCount;
  uniform vec4 heldSources[${limit}];
  uniform vec3 heldCells[${limit}];
  uniform vec3 heldLightMin;
  uniform vec3 heldLightMax;
  vec3 heldLinear(vec3 color) {
    return mix(color / 12.92, pow((color + .055) / 1.055, vec3(2.4)), step(vec3(.04045), color));
  }
  float heldLevelAt(vec3 samplePoint) {
    float result = 0.0;
    for (int i = 0; i < ${limit}; ++i) {
      vec4 source = heldSources[i];
      if (source.w <= 0.0) continue;
      vec3 offset = abs(samplePoint - heldCells[i]);
      if (offset.x + offset.y + offset.z >= source.w + 1.0) continue;
      vec3 uvw = ((samplePoint - heldCells[i]).xzy + ${side / 2}) / ${side}.0;
      uvw.z = (uvw.z + float(i)) / ${limit}.0;
      float grid = texture(heldLightVolume, uvw).r * 15.0;
      float openLevel = source.w - offset.x - offset.y - offset.z;
      float distance = length(samplePoint - source.xyz);
      float occlusion = max(0.0, openLevel - grid);
      // Use a radial falloff in open air. The voxel volume removes light
      // along blocked paths while retaining light that can go around a wall.
      result = max(result, min(grid * 2.0, source.w - distance - occlusion));
    }
    return result;
  }
`;

export class HeldLights {
  constructor(world) {
    this.world = world;
    this.opacityAt = (x,y,z) => {
      const {minY=0,maxY=255}=world.manifest.bounds ?? {};
      const chunk = world.chunks.get(`${x >> 4},${z >> 4}`);
      if (!chunk || chunk.visualOnly || y < minY || y > maxY) return 15;
      const cell = world.lightCell(x,y,z,false,chunk);
      if (!cell.parts && cell.key?.startsWith('cover:')) {
        cell.parts = (chunk.compositions ?? world.manifest.compositions)?.[cell.key]?.parts;
      }
      return heldLightOcclusion(cell);
    };
    this.bytes = new Uint8Array(limit * HELD_LIGHT_VOXELS);
    this.scratch = new Uint16Array(HELD_LIGHT_VOXELS);
    const texture = new THREE.Data3DTexture(this.bytes,side,side,side * limit);
    texture.format = THREE.RedFormat;
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    this.slots = Array.from({length:limit}, (_,index) => ({owner:null,
      source:new THREE.Vector4(0,0,0,0), cell:new THREE.Vector3(),
      values:this.bytes.subarray(index * HELD_LIGHT_VOXELS, (index + 1) * HELD_LIGHT_VOXELS)}));
    this.uniforms = {heldLightVolume:{value:texture}, heldLightCount:{value:0},
      heldLightMin:{value:new THREE.Vector3()}, heldLightMax:{value:new THREE.Vector3()},
      heldCells:{value:this.slots.map(slot => slot.cell)}, heldSources:{value:this.slots.map(slot => slot.source)}};
    this.probe = new THREE.Vector3();
    this.rebuilds = 0;
    this.rebuildMs = 0;
  }

  attach(shader) {
    Object.assign(shader.uniforms,this.uniforms);
    shader.vertexShader = `varying vec3 heldWorld;
      varying vec3 unlitTint;
      varying float terrainSky;
      ${shader.vertexShader}`.replace('vColor.rgb = lightSrgbToLinear', `
        heldWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        unlitTint = vColor.rgb;
        terrainSky = skyLight;
        vColor.rgb = lightSrgbToLinear`);
    shader.fragmentShader = fragment + shader.fragmentShader.replace('#include <color_fragment>', `
      #if defined(USE_COLOR) || defined(USE_COLOR_ALPHA)
        vec3 shade = vColor.rgb;
        if (heldLightCount > 0 && all(greaterThan(heldWorld,heldLightMin)) && all(lessThan(heldWorld,heldLightMax))) {
          vec3 normal = normalize(cross(dFdx(heldWorld), dFdy(heldWorld)));
          float glow = heldLevelAt(heldWorld + normal * .35);
          if (glow > 0.0) {
            float low = floor(glow);
            float v = (min(15.0, terrainSky) + .5) / 17.0;
            vec3 lower = texture2D(honeymoonLightmap,vec2((low + .5) / 16.0, v)).rgb;
            vec3 upper = texture2D(honeymoonLightmap,vec2((low + 1.5) / 16.0, v)).rgb;
            shade = max(shade, heldLinear(unlitTint * mix(lower,upper,fract(glow))));
          }
        }
        diffuseColor.rgb *= shade;
        #ifdef USE_COLOR_ALPHA
          diffuseColor.a *= vColor.a;
        #endif
      #endif
    `);
  }

  invalidate(x,z,padding = 0) {
    for (const slot of this.slots) {
      if (slot.owner && Math.max(Math.abs(x - slot.cell.x),Math.abs(z - slot.cell.z)) < slot.level + padding) {
        slot.dirty = true;
      }
    }
  }

  update(ponies, camera, player) {
    const candidates = [];
    for (const {object,avatar} of ponies) {
      if ((!object.visible && avatar !== player) || object.position.distanceToSquared(camera) > range ** 2) continue;
      const level = avatar.heldLight(this.probe);
      if (!level) continue;
      candidates.push({avatar,level,point:this.probe.clone(), distance:this.probe.distanceToSquared(camera)});
    }
    candidates.sort((a,b) => a.distance - b.distance);
    const wanted = candidates.slice(0,limit);
    for (const slot of this.slots) {
      if (wanted.some(light => light.avatar === slot.owner)) continue;
      slot.owner = null;
      slot.source.w = 0;
    }
    let upload = false;
    let active = 0;
    for (const {avatar,level,point} of wanted) {
      const slot = this.slots.find(entry => entry.owner === avatar) ?? this.slots.find(entry => !entry.owner);
      let x = Math.floor(point.x), y = Math.floor(point.y), z = Math.floor(point.z);
      if ((this.opacityAt(x,y,z) & 15) === 15) {
        const feet = avatar.object.position;
        x = Math.floor(feet.x); y = Math.floor(feet.y + .35); z = Math.floor(feet.z);
        if ((this.opacityAt(x,y,z) & 15) === 15) {
          slot.owner = null;
          slot.source.w = 0;
          continue;
        }
        point.set(feet.x,feet.y + .35,feet.z);
      }
      if (slot.owner !== avatar || slot.level !== level || slot.cell.x !== x + .5 || slot.cell.y !== y + .5 ||
          slot.cell.z !== z + .5 || slot.dirty) {
        if (upload) {
          // At most one rebuild per frame. Safely defer other moving emitters.
          if (slot.owner === avatar && slot.level === level && slot.source.w) active++;
          else slot.source.w = 0;
          continue;
        }
        const start = performance.now();
        fillHeldLight(slot.values,this.scratch,x,y,z,level,this.opacityAt);
        this.rebuildMs += performance.now() - start;
        this.rebuilds++;
        slot.owner = avatar;
        slot.level = level;
        slot.cell.set(x + .5,y + .5,z + .5);
        slot.dirty = false;
        upload = true;
      }
      slot.source.set(point.x,point.y,point.z,level);
      active++;
    }
    this.uniforms.heldLightCount.value = active;
    if (active) {
      const min = this.uniforms.heldLightMin.value.set(Infinity,Infinity,Infinity);
      const max = this.uniforms.heldLightMax.value.set(-Infinity,-Infinity,-Infinity);
      for (const {cell,source} of this.slots) {
        if (!source.w) continue;
        const span = source.w + 2;
        min.min(this.probe.copy(cell).addScalar(-span));
        max.max(this.probe.copy(cell).addScalar(span));
      }
    }
    if (upload) this.uniforms.heldLightVolume.value.needsUpdate = true;
  }

  levelAt(x,y,z) {
    if (!this.uniforms.heldLightCount.value) return 0;
    let result = 0;
    for (const {cell,source,values} of this.slots) {
      if (!source.w) continue;
      const dx = x - Math.floor(cell.x), dy = y - Math.floor(cell.y), dz = z - Math.floor(cell.z);
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) >= radius) continue;
      result = Math.max(result,values[dx + radius + side * (dz + radius + side * (dy + radius))] / 17);
    }
    return result;
  }

  statistics() {
    return {active:this.uniforms.heldLightCount.value, limit, bytes:this.bytes.length, rebuilds:this.rebuilds,
      rebuildMs:this.rebuildMs};
  }
}
