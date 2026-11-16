import * as THREE from '/vendor/three/three.module.js';
import {lodDistance,supportedLodVersion} from './far-tile-format.mjs';
import {terrainFilterShader} from './terrain-filter.mjs';

const PACK_CHUNKS = 4;
const PACK_BLOCKS = PACK_CHUNKS * 16;
const INNER_RADIUS = 20;
const MAX_FETCH = 2;
const MAX_PENDING_UPLOADS = 6;
const RETAIN_MARGIN = 1;
const keyOf = (x,z,outer = false) => `${x}.${z}${outer ? '.outer' : ''}`;
const packAt = chunk => Math.floor(chunk / PACK_CHUNKS);
const corners = new Float32Array([0,0,0, 1,0,0, 1,1,0, 0,1,0]);
const triangles = new Uint16Array([0,1,2, 0,2,3]);
const edges = [[-1,0],[1,0],[0,-1],[0,1]];
const distanceSquared = (x,z) => x * x + z * z;

export function supportsFarTerrain({lod}) {
  return supportedLodVersion(lod?.version) && lod.tileChunks === PACK_CHUNKS && lod.maxDistance === lodDistance(lod.version) &&
    /^[0-9a-f]{64}$/.test(lod.contentHash ?? '');
}

function farMaterial(textures, lightmap, rows, {water = false, outer = false} = {}) {
  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    atlas:{value:textures.source}, terrainMid:{value:textures.mid}, terrainAverage:{value:textures.average},
    terrainWater:{value:textures.water},
    lightmap:{value:lightmap}, terrainRows:{value:rows}, visibilityMask:{value:65535}, heightScale:{value:1},
    seamMasks:{value:new THREE.Vector4()},
  };
  return new THREE.ShaderMaterial({uniforms, fog:true, transparent:water, depthWrite:!water,
    side:water ? THREE.DoubleSide : THREE.FrontSide,
    vertexShader:`
      attribute vec3 faceOrigin;
      attribute vec2 faceSize;
      attribute vec2 faceSurface;
      attribute vec3 faceColor;
      attribute float faceLight;
      uniform float visibilityMask;
      uniform vec4 seamMasks;
      uniform float heightScale;
      uniform sampler2D lightmap;
      varying vec2 localUv;
      varying float tile;
      varying vec3 tint;
      #include <fog_pars_vertex>
      vec3 srgbToLinear(vec3 encoded) {
        return mix(encoded / 12.92, pow((encoded + .055) / 1.055, vec3(2.4)), step(vec3(.04045), encoded));
      }
      void main() {
        float chunk = floor(mod(faceSurface.y,128.0) / 8.0);
        float face = mod(faceSurface.y, 8.0);
        float mask = faceSurface.y < 128.0 ? visibilityMask :
          face < .5 ? seamMasks.x : face < 1.5 ? seamMasks.y : face < 4.5 ? seamMasks.z : seamMasks.w;
        if (mod(floor(mask / exp2(chunk)), 2.0) < .5) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }
        vec2 extent = faceSize * position.xy;
        vec3 point = faceOrigin;
        point.y /= heightScale;
        if (face < .5) point.zy += extent;
        else if (face < 1.5) point.yz += extent;
        else if (face < 2.5) point.xz += extent;
        else if (face < 3.5) point.zx += extent;
        else if (face < 4.5) point.yx += extent;
        else point.xy += extent;
        if (face < 1.5) localUv = vec2(face < .5 ? point.z : -point.z, -point.y);
        else if (face < 3.5) localUv = point.xz;
        else localUv = vec2(face < 4.5 ? -point.x : point.x, -point.y);
        tile = faceSurface.x;
        vec2 lightUv = vec2((mod(faceLight, 16.0) + .5) / 16.0, (floor(faceLight / 16.0) + .5) / 17.0);
        tint = srgbToLinear(faceColor * texture2D(lightmap, lightUv).rgb);
        vec4 mvPosition = modelViewMatrix * vec4(point, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #ifdef USE_FOG
          vFogDepth = length(mvPosition.xyz);
        #endif
      }`,
    fragmentShader:`
      ${water ? 'uniform sampler2D terrainWater;' : outer ?
        'uniform sampler2D terrainAverage; uniform float terrainRows;' : terrainFilterShader}
      uniform sampler2D atlas;
      varying vec2 localUv;
      varying float tile;
      varying vec3 tint;
      #include <fog_pars_fragment>
      void main() {
        ${water ? 'vec4 color = texture2D(terrainWater,vec2(localUv.x,-localUv.y));' : `
        float tileIndex = floor(tile + .5);
        vec2 cell = vec2(mod(tileIndex,64.0),terrainRows - 1.0 - floor(tileIndex / 64.0));
        ${outer ? 'vec4 color = texture2D(terrainAverage,(cell + .5) / vec2(64.0,terrainRows));' : `
          vec2 within = vec2(fract(localUv.x),1.0 - fract(localUv.y));
          vec4 color = terrainSample(atlas,cell,within,terrainFootprint(localUv));`}`}
        gl_FragColor = vec4(color.rgb * tint, ${water ? 'color.a' : '1.0'});
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

function meshFor(layer, material, region) {
  const {count,offset,span,surface,color,light,minY,maxY,heightScale = 1} = layer;
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(corners,3));
  geometry.setAttribute('faceOrigin',new THREE.InstancedBufferAttribute(offset,3));
  geometry.setAttribute('faceSize',new THREE.InstancedBufferAttribute(span,2));
  geometry.setAttribute('faceSurface',new THREE.InstancedBufferAttribute(surface,2));
  geometry.setAttribute('faceLight',new THREE.InstancedBufferAttribute(light,1));
  geometry.setAttribute('faceColor',new THREE.InstancedBufferAttribute(color,3,true));
  geometry.setIndex(new THREE.BufferAttribute(triangles,1));
  geometry.instanceCount = count;
  const center = new THREE.Vector3(32,(minY+maxY)/2,32);
  geometry.boundingSphere = new THREE.Sphere(center,Math.hypot(32,32,(maxY-minY)/2));
  const mesh = new THREE.Mesh(geometry,material);
  mesh.onBeforeRender = () => {
    material.uniforms.visibilityMask.value = region.mask;
    material.uniforms.heightScale.value = heightScale;
    material.uniforms.seamMasks.value.copy(region.seams);
    material.uniformsNeedUpdate = true;
  };
  return mesh;
}

export class FarTerrain {
  constructor(display, textures) {
    this.display = display;
    const {lod,bounds} = display.world.manifest;
    this.lod = lod;
    this.bounds = {minX:Math.floor(bounds.minX / PACK_BLOCKS),maxX:Math.floor(bounds.maxX / PACK_BLOCKS),
      minZ:Math.floor(bounds.minZ / PACK_BLOCKS),maxZ:Math.floor(bounds.maxZ / PACK_BLOCKS)};
    const material = options => farMaterial(textures,display.lightmap,display.atlasRows,options);
    this.materials = {inner:material(),water:material({water:true}),outer:material({outer:true})};
    this.packs = new Map();
    this.pending = new Map();
    this.failed = new Map();
    this.targets = new Map();
    this.decoded = [];
    this.active = false;
    this.errors = 0;
    this.ticket = 0;
    this.radius = 24;
    this.innerRadius = 24;
  }

  warmup() {
    const layer = {count:1,offset:new Uint16Array(3),span:new Uint16Array([1,1]),
      surface:new Uint16Array([0,5]),color:new Uint8Array([255,255,255]),light:new Uint16Array([240]),minY:0,maxY:1};
    return Object.values(this.materials).map(material => meshFor(layer,material,{mask:65535,seams:new THREE.Vector4()}));
  }

  setDistance(distance) {
    this.setActive(distance === 24 || distance === 32 && this.lod.maxDistance === 32);
    if (!this.active) return;
    const innerRadius = this.lod.maxDistance === 32 ? INNER_RADIUS : distance;
    if (this.radius === distance && this.innerRadius === innerRadius) return;
    const {cx,cz} = this;
    this.radius = distance;
    this.innerRadius = innerRadius;
    this.cx = this.cz = undefined;
    if (cx !== undefined) this.move(cx,cz);
  }

  get coverageRadius() {
    // Guard rings keep the circular horizon covered while the camera is
    // between chunk centers. They are hidden by the last part of the fog.
    return this.radius + (this.radius === 32 ? 2 : 0);
  }

  setActive(active) {
    if (this.active === active) return;
    this.active = active;
    if (active) {
      this.worker = new Worker('/far-tile-worker.mjs',{type:'module'});
      this.worker.onmessage = ({data}) => this.receive(data);
      this.worker.onerror = event => {
        console.error(event.message);
        this.errors++;
        this.setActive(false);
      };
    } else {
      this.worker.terminate();
      this.worker = null;
      this.pending.clear();
      this.decoded.length = 0;
      this.targets.clear();
      this.failed.clear();
      for (const key of this.packs.keys()) this.evict(key);
      this.display.uploads = this.display.uploads.filter(job => !job.far);
      this.cx = this.cz = undefined;
    }
  }

  move(cx, cz) {
    if (!this.active || this.cx === cx && this.cz === cz) return;
    this.cx = cx;
    this.cz = cz;
    this.targets.clear();
    const {minX,maxX,minZ,maxZ} = this.bounds;
    const radius = this.coverageRadius, {innerRadius} = this;
    const radius2 = radius ** 2, innerRadius2 = innerRadius ** 2;
    for (let rz = Math.max(minZ,packAt(cz-radius)); rz <= Math.min(maxZ,packAt(cz+radius)); rz++) {
      for (let rx = Math.max(minX,packAt(cx-radius)); rx <= Math.min(maxX,packAt(cx+radius)); rx++) {
        const x0 = rx * PACK_CHUNKS - cx, z0 = rz * PACK_CHUNKS - cz;
        const x1 = x0 + PACK_CHUNKS - 1, z1 = z0 + PACK_CHUNKS - 1;
        const nearest = distanceSquared(Math.max(x0,-x1,0),Math.max(z0,-z1,0));
        if (nearest <= innerRadius2) this.targets.set(keyOf(rx,rz),{rx,rz,outer:false});
        if (radius > innerRadius && nearest <= radius2 &&
            distanceSquared(Math.max(Math.abs(x0),Math.abs(x1)),Math.max(Math.abs(z0),Math.abs(z1))) > innerRadius2) {
          this.targets.set(keyOf(rx,rz,true),{rx,rz,outer:true});
        }
      }
    }
    for (const [id,{key}] of this.pending) {
      if (!this.targets.has(key)) {
        this.worker.postMessage({id});
        this.pending.delete(id);
      }
    }
    for (const [key,region] of this.packs) {
      if (this.targets.has(key)) continue;
      const excess = Math.hypot(region.rx * PACK_CHUNKS + 1.5 - cx, region.rz * PACK_CHUNKS + 1.5 - cz);
      const limit = region.outer ? radius : innerRadius;
      if (!region.installed || excess > limit + PACK_CHUNKS + RETAIN_MARGIN) this.evict(key);
    }
    const lookup = this.visibilityLookup();
    for (const region of this.packs.values()) this.updateMask(region,lookup);
    for (const key of this.failed.keys()) if (!this.targets.has(key)) this.failed.delete(key);
  }

  receive({id,tile,error}) {
    const job = this.pending.get(id);
    if (!job) return;
    this.pending.delete(id);
    if (!this.targets.has(job.key)) return;
    if (error) {
      this.errors++;
      this.failed.set(job.key,performance.now() + 2000);
      return;
    }
    this.failed.delete(job.key);
    this.decoded.push({...job,tile});
  }

  visibilityLookup() {
    const cached = new Map();
    const {cx,cz} = this, radius = this.coverageRadius;
    const rowSize = radius * 2 + 1;
    return (x,z) => {
      const dx = x - cx, dz = z - cz;
      const distance = distanceSquared(dx,dz);
      // Null marks the edge of the active circle. No cap is needed there.
      if (distance > radius ** 2) return null;
      const index = (dz + radius) * rowSize + dx + radius;
      if (!cached.has(index)) cached.set(index,this.visibleRegion(x,z,distance));
      return cached.get(index);
    };
  }

  updateMask(region,lookup) {
    const seam = [0,0,0,0];
    let mask = 0;
    for (let i=0; i<region.counts.length; i++) {
      if (!region.counts[i]) continue;
      const x = region.rx * PACK_CHUNKS + (i & 3), z = region.rz * PACK_CHUNKS + (i >> 2);
      if (lookup(x,z) !== region) continue;
      const bit = 1 << i;
      mask |= bit;
      if (this.lod.version < 3) continue;
      for (const [side,[dx,dz]] of edges.entries()) {
        const next = lookup(x+dx,z+dz);
        if (next !== null && next?.outer !== region.outer) seam[side] |= bit;
      }
    }
    region.mask = mask;
    region.seams.set(...seam);
    region.group.visible = mask !== 0;
    if (region.transition) region.transition.visible = seam.some(Boolean);
  }

  chunkChanged(x,z) {
    this.refreshAround(packAt(x),packAt(z));
  }

  refreshAround(rx,rz) {
    const lookup = this.visibilityLookup();
    for (const [dx,dz] of [[0,0],...edges]) for (const outer of [false,true]) {
      const region = this.packs.get(keyOf(rx+dx,rz+dz,outer));
      if (region?.installed) this.updateMask(region,lookup);
    }
  }

  regionAt(x,z,distance = distanceSquared(x-this.cx,z-this.cz)) {
    if (!(distance <= this.coverageRadius ** 2)) return;
    const rx = packAt(x), rz = packAt(z);
    const index = x - rx * PACK_CHUNKS + 4 * (z - rz * PACK_CHUNKS);
    const outer = distance > this.innerRadius ** 2;
    const preferred = this.packs.get(keyOf(rx,rz,outer));
    if (preferred?.installed) return preferred.counts[index] ? preferred : undefined;
    const backup = this.radius > this.innerRadius && this.packs.get(keyOf(rx,rz,!outer));
    if (backup?.installed && backup.counts[index]) return backup;
  }

  visibleRegion(x,z,distance) {
    if (!this.display.exactChunks.has(`${x},${z}`)) return this.regionAt(x,z,distance);
  }

  hasChunk(x,z) {
    return Boolean(this.regionAt(x,z));
  }

  add({key,rx,rz,outer,tile}) {
    if (this.packs.has(key) || !this.targets.has(key)) return;
    const group = new THREE.Group();
    group.position.set(rx * PACK_BLOCKS,0,rz * PACK_BLOCKS);
    const region = {key,rx,rz,outer,group,counts:tile.counts,bytes:tile.bytes,triangles:tile.triangles,
      mask:65535,seams:new THREE.Vector4(),installed:false};
    for (const [index,layer] of tile.layers.entries()) {
      if (!layer.count) continue;
      const material = this.materials[index === 1 ? 'water' : outer ? 'outer' : 'inner'];
      const mesh = meshFor(layer,material,region);
      if (index === 2) region.transition = mesh;
      group.add(mesh);
    }
    this.packs.set(key,region);
    group.visible = false;
    this.display.uploads.push({meshes:group.children.slice(),object:group,parent:this.display.scene,far:region});
  }

  evict(key) {
    const region = this.packs.get(key);
    this.packs.delete(key);
    this.display.discardGroup(region.group);
    if (!region.installed) this.display.uploads = this.display.uploads.filter(job => job.far !== region);
  }

  isQueued(region) {
    return this.active && this.targets.has(region.key) && this.packs.get(region.key) === region;
  }

  install(region) {
    region.installed = true;
    for (let i=0; i<region.counts.length; i++) {
      if (region.counts[i]) this.display.updateChunkVisibility(region.rx * 4 + (i & 3),region.rz * 4 + (i >> 2));
    }
    this.refreshAround(region.rx,region.rz);
  }

  step(now, stream) {
    if (!this.active || this.cx === undefined) return;
    const uploads = this.display.uploads.filter(job => job.far).length;
    if (stream && uploads < MAX_PENDING_UPLOADS && this.decoded.length) this.add(this.decoded.shift());
    const busy = [...this.pending.values(),...this.decoded].map(({key}) => key);
    if (this.pending.size >= MAX_FETCH || uploads + busy.length >= MAX_PENDING_UPLOADS || now < (this.nextRequest ?? 0)) return;
    const direction = this.display.viewDirection;
    let closest, score = Infinity;
    for (const [key,region] of this.targets) {
      if (this.packs.has(key) || busy.includes(key) || (this.failed.get(key) ?? 0) > now) continue;
      const x = region.rx * PACK_CHUNKS + 1.5 - this.cx, z = region.rz * PACK_CHUNKS + 1.5 - this.cz;
      const distance = Math.hypot(x,z);
      const priority = distance - 5 * (x * direction.x + z * direction.z) / Math.max(5,distance);
      if (priority < score) { closest = {key,...region}; score = priority; }
    }
    if (!closest) { this.nextRequest = now + 100; return; }
    this.nextRequest = now + 25;
    const id = ++this.ticket;
    this.pending.set(id,closest);
    this.worker.postMessage({id,url:`/generated/lod/${this.lod.contentHash}/${closest.key}.bin`});
  }

  stats() {
    let packs = 0, outerPacks = 0, chunks = 0, bytes = 0, triangles = 0, missing = this.targets.size;
    for (const region of this.packs.values()) {
      if (!region.installed) continue;
      packs++;
      if (region.outer) outerPacks++;
      bytes += region.bytes;
      triangles += region.triangles;
      if (this.targets.has(region.key)) missing--;
      if (region.group.visible) for (let i=0; i<16; i++) if (region.mask & (1 << i)) chunks++;
    }
    const pending = this.pending.size + this.decoded.length + this.display.uploads.filter(job => job.far).length;
    return {active:this.active,radius:this.active ? this.radius : 0,innerRadius:this.innerRadius,
      coverageRadius:this.coverageRadius,packs,outerPacks,chunks,pending,
      ready:this.active && this.targets.size > 0 && !missing,bytes,triangles,missing,errors:this.errors};
  }
}
