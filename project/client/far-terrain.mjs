import * as THREE from '/vendor/three/three.module.js';
import {farVisibilityMask} from './far-tile-format.mjs';

const PACK_CHUNKS = 4;
const PACK_BLOCKS = PACK_CHUNKS * 16;
const FAR_RADIUS = 24;
const MAX_FETCH = 2;
const MAX_PENDING_UPLOADS = 6;
const RETAIN_MARGIN = 1;
const keyOf = (x,z) => `${x}.${z}`;
const packAt = chunk => Math.floor(chunk / PACK_CHUNKS);
const corners = new Float32Array([0,0,0, 1,0,0, 1,1,0, 0,1,0]);
const triangles = new Uint16Array([0,1,2, 0,2,3]);

export function supportsFarTerrain({lod}) {
  return lod?.version === 1 && lod.tileChunks === PACK_CHUNKS && lod.maxDistance === FAR_RADIUS &&
    /^[0-9a-f]{64}$/.test(lod.contentHash ?? '');
}

// Filter every input tile in isolation so distant windows and leaves cannot
// pull black from transparent texels or colors from neighboring atlas tiles.
function farAtlas(image, rows) {
  const columns = 64, block = 4;
  const width = columns * block, height = rows * block;
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d',{willReadFrequently:true});
  context.drawImage(image,0,0);
  const input = context.getImageData(0,0,image.width,image.height).data;
  const bytes = new Uint8Array(width * height * 4);
  const averages = new Uint8Array(columns * rows * 4);
  for (let z=0; z<rows; z++) for (let x=0; x<columns; x++) {
    const tile = x+z*columns;
    const r = new Uint32Array(16), g = new Uint32Array(16), b = new Uint32Array(16), a = new Uint16Array(16);
    let red=0, green=0, blue=0, alpha=0;
    for (let py=0; py<16; py++) for (let px=0; px<16; px++) {
      const offset = ((z * 16 + py) * image.width + x * 16 + px) * 4;
      const at = (px >> 2) + (py >> 2)*4;
      const weight = input[offset+3];
      r[at] += input[offset]*weight; g[at] += input[offset+1]*weight; b[at] += input[offset+2]*weight; a[at] += weight;
    }
    for (let index=0; index<16; index++) {
      red+=r[index]; green+=g[index]; blue+=b[index]; alpha+=a[index];
    }
    const average = [red/Math.max(1,alpha),green/Math.max(1,alpha),blue/Math.max(1,alpha),alpha/256];
    const averageAt = (x+(rows-1-z)*columns)*4;
    averages.set(average,averageAt);
    for (let index=0; index<16; index++) {
      const denominator = a[index] + 2040;
      const offset = (x*4+(index&3)+(height-1-(z*4+(index>>2)))*width)*4;
      bytes[offset] = (r[index]+average[0]*2040)/denominator;
      bytes[offset+1] = (g[index]+average[1]*2040)/denominator;
      bytes[offset+2] = (b[index]+average[2]*2040)/denominator;
      bytes[offset+3] = a[index]/16;
    }
  }
  const atlas = new THREE.DataTexture(bytes,width,height);
  const average = new THREE.DataTexture(averages,columns,rows);
  atlas.magFilter = atlas.minFilter = THREE.LinearFilter;
  for (const texture of [atlas,average]) {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
  }
  return {atlas,average};
}

function farMaterial(textures, lightmap, rows, water) {
  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    atlas:{value:textures.atlas}, average:{value:textures.average}, lightmap:{value:lightmap},
    rows:{value:rows}, visibilityMask:{value:65535},
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
      uniform sampler2D lightmap;
      varying vec2 localUv;
      varying float tile;
      varying vec3 tint;
      #include <fog_pars_vertex>
      vec3 srgbToLinear(vec3 encoded) {
        return mix(encoded / 12.92, pow((encoded + .055) / 1.055, vec3(2.4)), step(vec3(.04045), encoded));
      }
      void main() {
        float chunk = floor(faceSurface.y / 8.0);
        if (mod(floor(visibilityMask / exp2(chunk)), 2.0) < .5) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }
        float face = mod(faceSurface.y, 8.0);
        vec2 extent = faceSize * position.xy;
        vec3 point = faceOrigin;
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
        #include <fog_vertex>
      }`,
    fragmentShader:`
      uniform sampler2D atlas;
      uniform sampler2D average;
      uniform float rows;
      varying vec2 localUv;
      varying float tile;
      varying vec3 tint;
      #include <fog_pars_fragment>
      void main() {
        vec2 uv = mix(vec2(.125), vec2(.875), fract(localUv));
        vec2 cell = vec2(mod(tile,64.0),floor(tile / 64.0));
        vec2 atlasUv = vec2((mod(tile, 64.0) + uv.x) / 64.0, 1.0 - (floor(tile / 64.0) + uv.y) / rows);
        vec2 meanUv = vec2((cell.x + .5) / 64.0, 1.0 - (cell.y + .5) / rows);
        float detail = 1.0 - smoothstep(.18, .53, max(length(dFdx(localUv)),length(dFdy(localUv))));
        vec4 color = mix(texture2D(average,meanUv),texture2D(atlas,atlasUv),detail);
        gl_FragColor = vec4(color.rgb * tint, ${water ? 'color.a' : '1.0'});
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

function meshFor(layer, material, region) {
  const {count,offset,span,surface,color,light,minY,maxY} = layer;
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
    material.uniformsNeedUpdate = true;
  };
  return mesh;
}

export class FarTerrain {
  constructor(display, map) {
    this.display = display;
    const {lod,bounds} = display.world.manifest;
    this.lod = lod;
    this.bounds = {minX:Math.floor(bounds.minX / PACK_BLOCKS),maxX:Math.floor(bounds.maxX / PACK_BLOCKS),
      minZ:Math.floor(bounds.minZ / PACK_BLOCKS),maxZ:Math.floor(bounds.maxZ / PACK_BLOCKS)};
    this.textures = farAtlas(map.image,display.atlasRows);
    this.materials = [farMaterial(this.textures,display.lightmap,display.atlasRows,false),
      farMaterial(this.textures,display.lightmap,display.atlasRows,true)];
    this.packs = new Map();
    this.pending = new Map();
    this.failed = new Map();
    this.targets = new Map();
    this.decoded = [];
    this.active = false;
    this.errors = 0;
    this.ticket = 0;
  }

  warmup() {
    const layer = {count:1,offset:new Uint16Array(3),span:new Uint16Array([1,1]),
      surface:new Uint16Array([0,5]),color:new Uint8Array([255,255,255]),light:new Uint16Array([240]),minY:0,maxY:1};
    return this.materials.map(material => meshFor(layer,material,{mask:65535}));
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
    for (let rz = Math.max(minZ,packAt(cz-FAR_RADIUS)); rz <= Math.min(maxZ,packAt(cz+FAR_RADIUS)); rz++) {
      for (let rx = Math.max(minX,packAt(cx-FAR_RADIUS)); rx <= Math.min(maxX,packAt(cx+FAR_RADIUS)); rx++) {
        const x = Math.max(rx * PACK_CHUNKS - cx, cx - (rx * PACK_CHUNKS + 3), 0);
        const z = Math.max(rz * PACK_CHUNKS - cz, cz - (rz * PACK_CHUNKS + 3), 0);
        if (Math.hypot(x,z) <= FAR_RADIUS) this.targets.set(keyOf(rx,rz),{rx,rz});
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
      if (!region.installed || excess > FAR_RADIUS + PACK_CHUNKS + RETAIN_MARGIN) this.evict(key);
      else region.group.visible = false;
    }
    for (const [key,region] of this.packs) if (this.targets.has(key)) this.updateMask(region);
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

  updateMask(region) {
    region.mask = farVisibilityMask(region.rx,region.rz,(x,z) =>
      this.display.exactChunks.has(`${x},${z}`) || Math.hypot(x-this.cx,z-this.cz) > FAR_RADIUS,region.counts);
    region.group.visible = this.targets.has(region.key) && region.mask !== 0;
  }

  chunkChanged(x,z) {
    const region = this.packs.get(keyOf(packAt(x),packAt(z)));
    if (region) this.updateMask(region);
  }

  hasChunk(x,z) {
    const rx = packAt(x), rz = packAt(z);
    const region = this.packs.get(keyOf(rx,rz));
    return region?.installed && this.targets.has(region.key) && Math.hypot(x-this.cx,z-this.cz) <= FAR_RADIUS &&
      region.counts[x - rx * PACK_CHUNKS + 4 * (z - rz * PACK_CHUNKS)] > 0;
  }

  add({key,rx,rz,tile}) {
    if (this.packs.has(key) || !this.targets.has(key)) return;
    const group = new THREE.Group();
    group.position.set(rx * PACK_BLOCKS,0,rz * PACK_BLOCKS);
    const region = {key,rx,rz,group,counts:tile.counts,bytes:tile.bytes,triangles:tile.triangles,mask:65535,installed:false};
    for (const [index,layer] of tile.layers.entries()) if (layer.count) group.add(meshFor(layer,this.materials[index],region));
    this.packs.set(key,region);
    this.updateMask(region);
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
    this.updateMask(region);
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
    let packs = 0, chunks = 0, bytes = 0, triangles = 0, missing = this.targets.size;
    for (const region of this.packs.values()) {
      if (!region.installed) continue;
      packs++;
      bytes += region.bytes;
      triangles += region.triangles;
      if (this.targets.has(region.key)) missing--;
      if (region.group.visible) for (let i=0; i<16; i++) if (region.mask & (1 << i)) chunks++;
    }
    const pending = this.pending.size + this.decoded.length + this.display.uploads.filter(job => job.far).length;
    return {active:this.active,radius:this.active ? FAR_RADIUS : 0,packs,chunks,pending,
      ready:this.active && this.targets.size > 0 && !missing,bytes,triangles,missing,errors:this.errors};
  }
}
