import * as THREE from '/vendor/three/three.module.js';
import {DEFAULT_DETAILED_LOD_DISTANCE,lodDistance,supportedLodVersion,validateDetailedLodDistance} from './far-tile-format.mjs';
import {terrainFilterShader} from './terrain-filter.mjs';
import {VISTA_BLOCKS,supportedVistaVersion} from './vista-format.mjs';

const PACK_CHUNKS = 4;
const PACK_BLOCKS = PACK_CHUNKS * 16;
const VISTA_CHUNKS = VISTA_BLOCKS / 16;
const VISTA_RADIUS = 126;
const VISTA_COARSE_AFTER = 54;
export const VISTA_FOG_END = 1840;
const MAX_FETCH = 2;
const MAX_PENDING_UPLOADS = 6;
const RETAIN_MARGIN = 1;
const VISTA_MASK_SIDE=80;
const VISTA_FADE_MS=260;
const paletteModes=new Set([0,1,2]);
const keyOf = (x,z,outer = false) => `${x}.${z}${outer ? '.outer' : ''}`;
const vistaKey = (x,z) => `vista:${x}.${z}`;
const packAt = chunk => Math.floor(chunk / PACK_CHUNKS);
const corners = new Float32Array([0,0,0, 1,0,0, 1,1,0, 0,1,0]);
const triangles = new Uint16Array([0,1,2, 0,2,3]);
const edges = [[-1,0],[1,0],[0,-1],[0,1]];
const distanceSquared = (x,z) => x * x + z * z;

export function supportsFarTerrain({lod}) {
  return supportedLodVersion(lod?.version) && lod.tileChunks === PACK_CHUNKS && lod.maxDistance === lodDistance(lod.version) &&
    /^[0-9a-f]{64}$/.test(lod.contentHash ?? '');
}

function farMaterial(textures, lightmap, rows, {water=false,outer=false,rail=false,vista=false,micro=false,antialias=false} = {}) {
  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    atlas:{value:textures.source}, terrainMid:{value:textures.mid}, terrainAverage:{value:textures.average},
    terrainWater:{value:textures.water},
    lightmap:{value:lightmap}, terrainRows:{value:rows}, visibilityMask:{value:65535}, heightScale:{value:1},
    coordinateScale:{value:1},
    vistaMask:{value:null}, vistaMaskOrigin:{value:new THREE.Vector2()},
    vistaCoverage:{value:1},
    paletteMode:{value:1},
    seamMasks:{value:new THREE.Vector4()},
  };
  return new THREE.ShaderMaterial({uniforms, fog:true, transparent:water, depthWrite:!water,
    alphaToCoverage:antialias && !water, polygonOffset:micro, polygonOffsetUnits:-1,
    side:water || rail ? THREE.DoubleSide : THREE.FrontSide,
    vertexShader:`
      attribute vec3 faceOrigin;
      attribute vec2 faceSize;
      attribute vec2 faceSurface;
      attribute vec3 faceColor;
      attribute float faceLight;
      uniform float visibilityMask;
      uniform vec4 seamMasks;
      uniform float heightScale;
      uniform float coordinateScale;
      uniform sampler2D lightmap;
      varying vec2 localUv;
      varying float tile;
      varying float cutout;
      varying vec3 tint;
      varying vec2 surfaceXZ;
      #include <fog_pars_vertex>
      vec3 srgbToLinear(vec3 encoded) {
        return mix(encoded / 12.92, pow((encoded + .055) / 1.055, vec3(2.4)), step(vec3(.04045), encoded));
      }
      void main() {
        float flags = mod(faceSurface.y,256.0);
        float chunk = floor(mod(flags,128.0) / 8.0);
        float face = mod(faceSurface.y, 8.0);
        float mask = flags < 128.0 ? visibilityMask :
          face < .5 ? seamMasks.x : face < 1.5 ? seamMasks.y : face < 4.5 ? seamMasks.z : seamMasks.w;
        if (mod(floor(mask / exp2(chunk)), 2.0) < .5) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }
        vec2 extent = faceSize * position.xy / coordinateScale;
        vec3 point = faceOrigin / vec3(coordinateScale,heightScale,coordinateScale);
        ${rail ? `
        // Follow the source rail quad's corner order for bends and grades.
        float direction = faceSize.x;
        float x = position.x, z = position.y;
        if (direction == 1.0 || direction == 2.0 || direction == 3.0 || direction == 7.0) {
          point.xz += vec2(1.0-x,1.0-z);
        } else if (direction == 8.0) {
          point.xz += vec2(z,1.0-x);
        } else if (direction == 9.0) {
          point.xz += vec2(x,z);
        } else {
          point.xz += vec2(1.0-z,x);
        }
        point.y += .0625;
        if (direction == 2.0 || direction == 4.0) point.y += 1.0-x;
        if (direction == 3.0 || direction == 5.0) point.y += x;
        localUv = vec2(1.0-z,1.0-x);
        ` : `if (face < .5) point.zy += extent;
        else if (face < 1.5) point.yz += extent;
        else if (face < 2.5) point.xz += extent;
        else if (face < 3.5) point.zx += extent;
        else if (face < 4.5) point.yx += extent;
        else point.xy += extent;
        if (face < 1.5) localUv = vec2(face < .5 ? point.z : -point.z, -point.y);
        else if (face < 3.5) localUv = point.xz;
        else localUv = vec2(face < 4.5 ? -point.x : point.x, -point.y);`}
        tile = faceSurface.x;
        cutout = step(256.0,faceSurface.y);
        surfaceXZ = (modelMatrix * vec4(point,1.0)).xz;
        vec2 lightUv = vec2((mod(faceLight, 16.0) + .5) / 16.0, (floor(faceLight / 16.0) + .5) / 17.0);
        tint = srgbToLinear(faceColor * texture2D(lightmap, lightUv).rgb);
        vec4 mvPosition = modelViewMatrix * vec4(point, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #ifdef USE_FOG
          vFogDepth = length(mvPosition.xyz);
        #endif
      }`,
    fragmentShader:`
      ${water ? 'uniform sampler2D terrainWater;' : terrainFilterShader}
      uniform sampler2D atlas;
      varying vec2 localUv;
      varying float tile;
      varying float cutout;
      varying vec3 tint;
      varying vec2 surfaceXZ;
      uniform float paletteMode;
      ${vista ? 'uniform sampler2D vistaMask; uniform vec2 vistaMaskOrigin; uniform float vistaCoverage;' : ''}
      #include <fog_pars_fragment>
      void main() {
        ${vista ? `
          vec2 maskUv = (floor(surfaceXZ / 16.0) - vistaMaskOrigin + .5) / ${VISTA_MASK_SIDE}.0;
          if (all(greaterThan(maskUv,vec2(0.0))) && all(lessThan(maskUv,vec2(1.0))) &&
              texture2D(vistaMask,maskUv).r > .5) discard;
          float dither=fract(52.9829189*fract(dot(floor(gl_FragCoord.xy),vec2(.06711056,.00583715))));
          if (dither>=vistaCoverage) discard;
        ` : ''}
        float coverage = 1.0;
        ${water ? 'vec4 color = texture2D(terrainWater,vec2(localUv.x,-localUv.y));' : `
        float tileIndex = floor(tile + .5);
        vec2 cell = vec2(mod(tileIndex,64.0),terrainRows - 1.0 - floor(tileIndex / 64.0));
          vec2 within = ${rail ? 'clamp(localUv,vec2(.03125),vec2(.96875))' : 'vec2(fract(localUv.x),1.0 - fract(localUv.y))'};
          float footprint = terrainFootprint(localUv);
          ${vista ? `
          vec2 meanUv = (cell + .5) / vec2(64.0,terrainRows);
          vec4 color = texture2D(terrainAverage,meanUv);
          if (vFogDepth < 240.0) {
            vec4 close = terrainSample(atlas,cell,within,footprint);
            float detail = close.a * (1.0 - smoothstep(130.0,240.0,vFogDepth));
            color.rgb = mix(color.rgb,close.rgb,detail);
          }
          ` : `
          // As block patterns shrink toward a pixel, prefilter before the
          // detail begins to flicker. This also covers rails and glass.
          float blur = ${outer ? '.24+.42*smoothstep(180.0,384.0,vFogDepth)' : '.42*smoothstep(90.0,312.0,vFogDepth)'};
          footprint = max(footprint,blur);
          vec4 color = terrainSample(atlas,cell,within,footprint);
          if (${rail ? 'true' : 'cutout>.5 || tileIndex==49.0 || tileIndex>=3328.0 && tileIndex<3388.0'}) {
            ${antialias ? `
              float edge = max(.025,.45*fwidth(color.a));
              float nearCoverage = smoothstep(.47-edge,.47+edge,color.a);
              coverage = mix(nearCoverage,color.a,smoothstep(.08,.42,footprint));
              if (coverage<.035) discard;
            ` : 'if (color.a<.47) discard;'}
          }
          `}
        `}
        vec3 terrainColor=color.rgb * tint;
        // Filtering averages the little bright highlights toward darker
        // texels. Keep the midtones closer to the nearby block material.
        if (paletteMode > .5) {
          float distanceWeight=smoothstep(70.0,380.0,vFogDepth);
          float luminance=dot(terrainColor,vec3(.2126,.7152,.0722));
          float vegetation=terrainColor.g>terrainColor.r*1.25 && terrainColor.g>terrainColor.b*1.18 ? 1.0 : 0.0;
          terrainColor=mix(terrainColor,terrainColor*(1.0+.14*vegetation),distanceWeight);
          if (paletteMode > 1.5) {
            terrainColor=mix(terrainColor,vec3(luminance),.14*distanceWeight);
            terrainColor=mix(terrainColor,terrainColor*1.14,.5*distanceWeight);
          }
        }
        gl_FragColor = vec4(terrainColor, ${water ? 'color.a' : 'coverage'});
        #include <colorspace_fragment>
        #ifdef USE_FOG
          float farFog = smoothstep(fogNear,fogFar,vFogDepth);
          float haze = .16 * smoothstep(fogNear*.46,fogNear,vFogDepth);
          gl_FragColor.rgb = mix(gl_FragColor.rgb,fogColor,haze+(1.0-haze)*farFog);
        #endif
      }`,
  });
}

function meshFor(layer, material, region, extent = PACK_BLOCKS) {
  const {count,offset,span,surface,color,light,minY,maxY,heightScale = 1,coordinateScale = 1} = layer;
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(corners,3));
  geometry.setAttribute('faceOrigin',new THREE.InstancedBufferAttribute(offset,3));
  geometry.setAttribute('faceSize',new THREE.InstancedBufferAttribute(span,2));
  geometry.setAttribute('faceSurface',new THREE.InstancedBufferAttribute(surface,2));
  geometry.setAttribute('faceLight',new THREE.InstancedBufferAttribute(light,1));
  geometry.setAttribute('faceColor',new THREE.InstancedBufferAttribute(color,3,true));
  geometry.setIndex(new THREE.BufferAttribute(triangles,1));
  geometry.instanceCount = count;
  const center = new THREE.Vector3(extent/2,(minY+maxY)/2,extent/2);
  geometry.boundingSphere = new THREE.Sphere(center,Math.hypot(extent/2,extent/2,(maxY-minY)/2));
  const mesh = new THREE.Mesh(geometry,material);
  mesh.onBeforeRender = () => {
    material.uniforms.visibilityMask.value = region.mask;
    material.uniforms.heightScale.value = heightScale;
    material.uniforms.coordinateScale.value = coordinateScale;
    material.uniforms.seamMasks.value.copy(region.seams);
    material.uniforms.vistaCoverage.value=region.vistaCoverage ?? 1;
    material.uniformsNeedUpdate = true;
  };
  return mesh;
}

export class FarTerrain {
  constructor(display, textures) {
    this.display = display;
    const {lod,bounds,vista,fullWorldPlayable} = display.world.manifest;
    this.lod = lod;
    this.fullWorldPlayable=Boolean(fullWorldPlayable);
    this.definedPacks=Array.isArray(lod.regions) ? new Set(lod.regions.map(([x,z])=>keyOf(x,z))) : null;
    this.bounds = {minX:Math.floor(bounds.minX / PACK_BLOCKS),maxX:Math.floor(bounds.maxX / PACK_BLOCKS),
      minZ:Math.floor(bounds.minZ / PACK_BLOCKS),maxZ:Math.floor(bounds.maxZ / PACK_BLOCKS)};
    const antialias = Boolean(display.renderer.getContext().getContextAttributes()?.antialias);
    const material = options => farMaterial(textures,display.lightmap,display.atlasRows,{antialias,...options});
    this.materials = {inner:material(),water:material({water:true}),outer:material({outer:true}),rail:material({rail:true}),
      micro:material({micro:true}),outerMicro:material({outer:true,micro:true})};
    if (supportedVistaVersion(vista?.version) && /^[0-9a-f]{64}$/.test(vista.hash) && Array.isArray(vista.regions)) {
      this.vista = {...vista,packs:new Set(vista.regions.map(([x,z]) => vistaKey(x,z)))};
      const {uniforms} = this.materials.vista = material({vista:true});
      this.coveragePixels=new Uint8Array(VISTA_MASK_SIDE**2);
      this.coverageTexture=new THREE.DataTexture(this.coveragePixels,VISTA_MASK_SIDE,VISTA_MASK_SIDE,THREE.RedFormat);
      this.coverageTexture.minFilter=this.coverageTexture.magFilter=THREE.NearestFilter;
      this.coverageTexture.needsUpdate=true;
      uniforms.vistaMask.value=this.coverageTexture;
    }
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
    this.detailedDistance = DEFAULT_DETAILED_LOD_DISTANCE;
  }

  warmup() {
    const layer = {count:1,offset:new Uint16Array(3),span:new Uint16Array([1,1]),
      surface:new Uint16Array([0,5]),color:new Uint8Array([255,255,255]),light:new Uint16Array([240]),minY:0,maxY:1};
    return Object.values(this.materials).map(material => meshFor(layer,material,{mask:65535,seams:new THREE.Vector4()}));
  }

  setPaletteMode(mode) {
    if (!paletteModes.has(mode)) throw new RangeError('Unknown distant palette');
    for (const material of Object.values(this.materials)) material.uniforms.paletteMode.value=mode;
  }

  updateVistaCoverage() {
    if (!this.coverageDirty || !this.coverageTexture || this.cx===undefined) return;
    this.coverageDirty=false;
    const minX=this.cx-VISTA_MASK_SIDE/2, minZ=this.cz-VISTA_MASK_SIDE/2;
    this.materials.vista.uniforms.vistaMaskOrigin.value.set(minX,minZ);
    const exact=this.display.exactChunks;
    for (let z=0;z<VISTA_MASK_SIDE;z++) for (let x=0;x<VISTA_MASK_SIDE;x++) {
      const xx=minX+x,zz=minZ+z;
      this.coveragePixels[x+z*VISTA_MASK_SIDE]=!this.altitude && (exact.has(`${xx},${zz}`) || this.regionAt(xx,zz)) ? 255 : 0;
    }
    this.coverageTexture.needsUpdate=true;
  }

  setDistance(distance) {
    this.groundDistance=distance;
    this.setActive(this.altitude || distance === 24 || distance === 32 && this.lod.maxDistance === 32);
    if (!this.active) return;
    const innerRadius = this.lod.maxDistance === 32 ? Math.min(distance,this.detailedDistance) : distance;
    if (this.radius === distance && this.innerRadius === innerRadius) return;
    const {cx,cz} = this;
    this.radius = distance;
    this.innerRadius = innerRadius;
    this.cx = this.cz = undefined;
    if (cx !== undefined) this.move(cx,cz);
  }

  setAltitude(enabled) {
    if (enabled===Boolean(this.altitude)) return;
    this.altitude=enabled;
    const {cx,cz}=this;
    this.setDistance(this.groundDistance ?? 8);
    if (!this.active) return;
    this.cx=this.cz=undefined;
    this.coverageDirty=true;
    if (cx!==undefined) this.move(cx,cz);
    for (const region of this.packs.values()) {
      if (!region.vista || !region.installed) continue;
      region.vistaCoverage=1;
      region.vistaFadeAt=undefined;
      this.display.altitudeOverview?.setRefinement(region.rx,region.rz,Number(enabled));
    }
  }

  setDetailedLodDistance(distance) {
    validateDetailedLodDistance(distance);
    if (this.lod.maxDistance !== 32) throw new RangeError('Detailed LOD settings require two terrain tiers');
    this.detailedDistance = distance;
    if (this.active) this.setDistance(this.radius);
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
    this.coverageDirty=true;
    this.targets.clear();
    const {minX,maxX,minZ,maxZ} = this.bounds;
    const radius = this.coverageRadius, {innerRadius} = this;
    const radius2 = radius ** 2, innerRadius2 = innerRadius ** 2;
    if (!this.altitude) for (let rz = Math.max(minZ,packAt(cz-radius)); rz <= Math.min(maxZ,packAt(cz+radius)); rz++) {
      for (let rx = Math.max(minX,packAt(cx-radius)); rx <= Math.min(maxX,packAt(cx+radius)); rx++) {
        if (this.definedPacks && !this.definedPacks.has(keyOf(rx,rz))) continue;
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
    if (this.vista && (this.altitude || this.radius===32 || this.fullWorldPlayable)) {
      const vistaRange=this.altitude ? (this.display.lowDevice ? 48 : 70) : this.radius===32?VISTA_RADIUS:54;
      for (let rz=Math.floor((cz-vistaRange)/VISTA_CHUNKS); rz<=Math.floor((cz+vistaRange)/VISTA_CHUNKS); rz++) {
        for (let rx=Math.floor((cx-vistaRange)/VISTA_CHUNKS); rx<=Math.floor((cx+vistaRange)/VISTA_CHUNKS); rx++) {
          const key = vistaKey(rx,rz);
          if (!this.vista.packs.has(key)) continue;
          const dx = Math.max(rx*VISTA_CHUNKS-cx,cx-(rx+1)*VISTA_CHUNKS+1,0);
          const dz = Math.max(rz*VISTA_CHUNKS-cz,cz-(rz+1)*VISTA_CHUNKS+1,0);
          const distance = distanceSquared(dx,dz);
          if (distance <= vistaRange**2) this.targets.set(key,{rx,rz,vista:true,coarse:distance > (this.altitude ? 39 : VISTA_COARSE_AFTER)**2});
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
      if (region.vista || this.altitude) { this.evict(key); continue; }
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
    if (region.vista) return;
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
    this.coverageDirty=true;
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
    if (this.altitude || !(distance <= this.coverageRadius ** 2)) return;
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

  add({key,rx,rz,outer,vista,coarse,tile}) {
    const previous = this.packs.get(key);
    if (!this.targets.has(key) || previous && (!previous.coarse || coarse)) return;
    const group = new THREE.Group();
    const extent = vista ? VISTA_BLOCKS : PACK_BLOCKS;
    group.position.set(rx * extent,0,rz * extent);
    const region = {key,rx,rz,outer,vista,coarse,previous,group,counts:tile.counts,bytes:tile.bytes,triangles:tile.triangles,
      mask:65535,seams:new THREE.Vector4(),installed:false};
    for (const [index,layer] of tile.layers.entries()) {
      if (!layer.count) continue;
      const material = this.materials[vista ? 'vista' : index === 1 ? 'water' : index === 3 ? 'rail' :
        index === 4 ? (outer ? 'outerMicro' : 'micro') : outer ? 'outer' : 'inner'];
      const mesh = meshFor(layer,material,region,extent);
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
    if (region.vista) this.display.altitudeOverview?.setRefinement(region.rx,region.rz,0);
    else this.coverageDirty=true;
    if (region.previous) this.display.discardGroup(region.previous.group);
    this.display.discardGroup(region.group);
    if (!region.installed) this.display.uploads = this.display.uploads.filter(job => job.far !== region);
  }

  isQueued(region) {
    return this.active && this.targets.has(region.key) && this.packs.get(region.key) === region;
  }

  install(region) {
    region.installed = true;
    if (region.vista) {
      if (region.previous) {
        region.vistaCoverage=region.previous.vistaCoverage;
        region.vistaFadeAt=region.previous.vistaFadeAt;
        this.display.discardGroup(region.previous.group);
      } else if (this.altitude) {
        region.vistaCoverage=0;
        region.vistaFadeAt=performance.now();
      }
      region.previous = null;
      region.group.visible = true;
      if (this.altitude) this.display.altitudeOverview?.setRefinement(region.rx,region.rz,region.vistaCoverage ?? 1);
      return;
    }
    this.coverageDirty=true;
    for (let i=0; i<region.counts.length; i++) {
      if (region.counts[i]) this.display.updateChunkVisibility(region.rx * 4 + (i & 3),region.rz * 4 + (i >> 2));
    }
    this.refreshAround(region.rx,region.rz);
  }

  step(now, stream) {
    if (!this.active || this.cx === undefined) return;
    if (this.altitude) for (const current of this.packs.values()) {
      const region=current.previous ?? current;
      if (region.vistaFadeAt===undefined) continue;
      const alpha=Math.max(0,Math.min(1,(now-region.vistaFadeAt)/VISTA_FADE_MS));
      region.vistaCoverage=alpha;
      this.display.altitudeOverview?.setRefinement(region.rx,region.rz,alpha);
      if (alpha===1) region.vistaFadeAt=undefined;
    }
    this.updateVistaCoverage();
    const uploads = this.display.uploads.filter(job => job.far).length;
    if (stream && uploads < MAX_PENDING_UPLOADS && this.decoded.length) this.add(this.decoded.shift());
    const busy = [...this.pending.values(),...this.decoded].map(({key}) => key);
    const network = this.display.terrainNetwork;
    const constrained = network?.constrained(now);
    if (constrained && (network.urgent || now - (this.lastRequest ?? -Infinity) < 500)) return;
    const maxFetch = constrained || network?.urgent ? 1 : MAX_FETCH;
    if (this.pending.size >= maxFetch || uploads + busy.length >= MAX_PENDING_UPLOADS || now < (this.nextRequest ?? 0)) return;
    const direction = this.display.viewDirection;
    let closest, score = Infinity;
    for (const [key,region] of this.targets) {
      const loaded = this.packs.get(key);
      if (loaded && (!loaded.coarse || region.coarse) || busy.includes(key) || (this.failed.get(key) ?? 0) > now) continue;
      const stride = region.vista ? VISTA_CHUNKS : PACK_CHUNKS, half = (stride-1)/2;
      const x = region.rx * stride + half - this.cx, z = region.rz * stride + half - this.cz;
      const distance = Math.hypot(x,z);
      const facing = (x * direction.x + z * direction.z) / Math.max(5,distance);
      const priority = region.vista ? 12 + distance / 5 - 8*facing : distance - 5*facing;
      if (priority < score) { closest = {key,...region}; score = priority; }
    }
    if (!closest) { this.nextRequest = now + 100; return; }
    this.lastRequest = now;
    this.nextRequest = now + 25;
    const id = ++this.ticket;
    this.pending.set(id,closest);
    this.worker.postMessage({id,vista:closest.vista,coarse:closest.coarse,url:closest.vista
      ? `/generated/vista/${this.vista.hash}/${closest.rx}.${closest.rz}.bin`
      : `/generated/lod/${this.lod.contentHash}/${closest.key}.bin`});
  }

  stats() {
    let packs = 0, outerPacks = 0, chunks = 0, bytes = 0, triangles = 0, missing = this.targets.size;
    let vistaPacks = 0, vistaCoarsePacks = 0, vistaBytes = 0, vistaTriangles = 0;
    for (const current of this.packs.values()) {
      const region = current.previous ?? current;
      if (!region.installed) continue;
      if (region.vista) {
        vistaPacks++;
        if (region.coarse) vistaCoarsePacks++;
        vistaBytes += region.bytes;
        vistaTriangles += region.triangles;
        if (this.targets.has(region.key)) missing--;
        continue;
      }
      packs++;
      if (region.outer) outerPacks++;
      bytes += region.bytes;
      triangles += region.triangles;
      if (this.targets.has(region.key)) missing--;
      if (region.group.visible) for (let i=0; i<16; i++) if (region.mask & (1 << i)) chunks++;
    }
    const pending = this.pending.size + this.decoded.length + this.display.uploads.filter(job => job.far).length;
    return {active:this.active,radius:this.active ? this.radius : 0,innerRadius:this.innerRadius,detailedDistance:this.detailedDistance,
      coverageRadius:this.coverageRadius,packs,outerPacks,chunks,pending,
      ready:this.active && this.targets.size > 0 && !missing,bytes,triangles,missing,
      vistaPacks,vistaCoarsePacks,vistaBytes,vistaTriangles,errors:this.errors};
  }
}
