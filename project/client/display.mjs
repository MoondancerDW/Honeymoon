import * as THREE from '/vendor/three/three.module.js';
import {chunkKey, sectionKey, json} from './world-data.mjs';

export class Display {
  constructor(container, world) {
    this.world = world;
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#86acfa');
    this.scene.fog = new THREE.Fog('#95aad5', 70, 175);
    this.sky = createSky();
    this.scene.add(this.sky);
    this.visualEntities = new THREE.Group();
    this.visualEntities.visible = false;
    this.scene.add(this.visualEntities);
    this.camera = new THREE.PerspectiveCamera(70, 1, .06, 850);
    this.renderer = new THREE.WebGLRenderer({antialias: true, powerPreference: 'high-performance'});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.65));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.append(this.renderer.domElement);
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.groups = new Map();
    this.pending = new Map();
    this.versions = new Map();
    this.ready = [];
    this.active = new Map();
    this.workers = Array.from({length: Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1))}, () => {
      const worker = new Worker('/mesh-worker.mjs', {type: 'module'});
      worker.onmessage = ({data}) => {
        this.active.delete(worker);
        this.ready.push(data);
      };
      worker.onerror = event => {
        this.active.delete(worker);
        this.onError?.(new Error(event.message));
      };
      worker.postMessage({type: 'init', palette: world.palette, compositions: world.manifest.compositions || {}});
      return worker;
    });
    this.meshTimes = [];
    this.visibleEdits = new Map();
    this.frameTimes = [];
    this.rings = new Map();
    this.ringData = new Map();
    this.requestedDistance = 4;
    this.lastFrame = performance.now();
    this.outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.006, 1.006, 1.006)),
      new THREE.LineBasicMaterial({color: '#ffeab6', depthTest: false, transparent: true, opacity: .8})
    );
    this.outline.visible = false;
    this.outline.renderOrder = 3;
    this.scene.add(this.outline);
  }

  async loadTextures() {
    const loader = new THREE.TextureLoader();
    const [map, atlas] = await Promise.all([
      loader.loadAsync('/generated/textures/atlas.png'),
      json('/generated/textures/atlas.json').catch(() => null),
    ]);
    this.connectedTextures = atlas?.connectedTextures === true;
    map.colorSpace = THREE.SRGBColorSpace;
    map.magFilter = THREE.NearestFilter;
    map.minFilter = THREE.NearestFilter;
    map.generateMipmaps = false;
    this.materials = {
      opaque: new THREE.MeshBasicMaterial({map, vertexColors: true}),
      cutout: new THREE.MeshBasicMaterial({map, vertexColors: true, alphaTest: .47, side: THREE.DoubleSide}),
      blend: new THREE.MeshBasicMaterial({map, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide}),
    };
    try {
      this.paint = await loader.loadAsync('/generated/textures/paintings.png');
      this.paint.colorSpace = THREE.SRGBColorSpace;
      this.paint.magFilter = this.paint.minFilter = THREE.NearestFilter;
    } catch {
      this.paint = null;
    }
  }

  resize() {
    const {clientWidth: width, clientHeight: height} = this.container;
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  schedule(cx, cy, cz, edit = false) {
    const id = sectionKey(cx, cy, cz);
    const chunk = this.world.chunks.get(chunkKey(cx, cz));
    const hasData = chunk?.sections.has(cy);
    if (!hasData && !edit && !this.groups.has(id)) return;
    const version = (this.versions.get(id) || 0) + 1;
    this.versions.set(id, version);
    this.pending.set(id, {id, cx, cy, cz, version, type: 'precise', edit, visualOnly: chunk?.visualOnly});
  }

  addChunk(chunk) {
    const levels = new Set(chunk.sections.keys());
    for (const change of this.world.overrides.values()) {
      if (Math.floor(change.x / 16) === chunk.x && Math.floor(change.z / 16) === chunk.z) levels.add(Math.floor(change.y / 16));
    }
    for (const cy of levels) {
      this.schedule(chunk.x, cy, chunk.z, !chunk.sections.has(cy));
      for (const [dx, dz] of [[-1,0], [1,0], [0,-1], [0,1]]) this.schedule(chunk.x + dx, cy, chunk.z + dz);
    }
    for (const entity of chunk.entities) this.addEntity(entity, chunk.visualOnly);
  }

  remesh(x, y, z, revision) {
    const cx = Math.floor(x / 16), cy = Math.floor(y / 16), cz = Math.floor(z / 16);
    this.schedule(cx, cy, cz, true);
    const id = sectionKey(cx, cy, cz);
    const job = this.pending.get(id);
    if (job && revision) {
      const previous = this.visibleEdits.get(id);
      this.visibleEdits.set(id, {revision, received: previous?.revision === revision ? previous.received : performance.now()});
    }
    for (const [dx, dy, dz] of [[-1,0,0],[1,0,0],[0,-1,0],[0,1,0],[0,0,-1],[0,0,1]]) {
      const xx = Math.floor((x + dx) / 16), yy = Math.floor((y + dy) / 16), zz = Math.floor((z + dz) / 16);
      if (xx !== cx || yy !== cy || zz !== cz) this.schedule(xx, yy, zz, true);
    }
  }

  async setDistance(distance) {
    this.requestedDistance = distance;
    this.visualEntities.visible = distance > 4;
    for (const [id, group] of this.groups) {
      if (id.startsWith('lod:')) group.visible = Number(id.split(':')[1]) <= distance;
      else if (group.userData.visualOnly) group.visible = distance > 4;
    }
    for (const [id] of this.pending) {
      if (id.startsWith('lod:') && Number(id.split(':')[1]) > distance) this.pending.delete(id);
    }
    this.scene.fog.near = distance === 4 ? 60 : distance * 8;
    this.scene.fog.far = Math.max(115, distance * 22);
    for (const radius of [8, 16, 32]) {
      if (radius > distance || this.requestedDistance < radius) break;
      if (!this.rings.has(radius)) {
        const promise = json('/generated/world/terrain-' + radius + '.json').then(ring => {
          const chunks = new Map(ring.chunks.map(chunk => [chunkKey(chunk.x, chunk.z), chunk]));
          const data = {chunks, step: ring.step, palette: ring.palette};
          this.ringData.set(radius, data);
          return data;
        });
        this.rings.set(radius, promise);
        promise.catch(() => this.rings.delete(radius));
      }
      const {chunks, step} = await this.rings.get(radius);
      if (this.requestedDistance < radius) break;
      const batches = new Set([...chunks.values()].map(chunk => chunkKey(Math.floor(chunk.x / 4), Math.floor(chunk.z / 4))));
      for (const batch of batches) {
        const [gx, gz] = batch.split(',').map(Number);
        const id = 'lod:' + radius + ':' + batch;
        if (this.groups.has(id) || this.pending.has(id) || [...this.active.values()].includes(id)) continue;
        this.versions.set(id, 1);
        this.pending.set(id, {id, type: 'coarse', version: 1, radius, stride: step, cx: gx * 4, cy: 0, cz: gz * 4});
      }
    }
  }

  addEntity(entity, visualOnly) {
    if (!this.paint || entity.type !== 'Painting') return;
    const art = paintings[entity.data.Motive];
    const dir = entity.data.Dir ?? entity.data.Direction;
    if (!art || !Number.isInteger(dir) || !Array.isArray(entity.position)) return;
    const [u, v, w, h] = art;
    const tex = this.paint.clone();
    tex.repeat.set(w / 256, h / 256);
    tex.offset.set(u / 256, 1 - (v + h) / 256);
    tex.needsUpdate = true;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w / 16, h / 16),
      new THREE.MeshBasicMaterial({map: tex, side: THREE.DoubleSide}));
    mesh.position.set(...entity.position);
    mesh.rotation.y = [0, Math.PI / 2, Math.PI, -Math.PI / 2][dir & 3];
    (visualOnly ? this.visualEntities : this.scene).add(mesh);
  }

  signMesh(sign) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#21190e';
    ctx.font = 'bold 23px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    sign.lines.forEach((line, index) => ctx.fillText(line.replace(/§./g, ''), 128, 20 + 29 * index, 250));
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(sign.width, sign.height),
      new THREE.MeshBasicMaterial({map, transparent: true, depthWrite: false}));
    mesh.position.set(sign.x, sign.y, sign.z);
    mesh.rotation.y = sign.rotation;
    mesh.renderOrder = 1;
    return mesh;
  }

  accept(result) {
    if (result.error) { this.onError?.(new Error(result.error)); return; }
    if (this.versions.get(result.id) !== result.version) return;
    const lod = result.id.startsWith('lod:');
    const coords = lod ? result.id.split(':')[2].split(',').map(Number) : result.id.split(',').map(Number);
    const previous = this.groups.get(result.id);
    if (previous) {
      this.scene.remove(previous);
      for (const mesh of previous.children) {
        mesh.geometry.dispose();
        if (mesh.userData.sign) {
          mesh.material.map.dispose();
          mesh.material.dispose();
        }
      }
    }
    const group = new THREE.Group();
    if (lod) {
      group.position.set(coords[0] * 64, 0, coords[1] * 64);
      group.visible = Number(result.id.split(':')[1]) <= this.requestedDistance;
    } else {
      group.position.set(...coords.map(value => value * 16));
      group.userData.visualOnly = this.world.chunks.get(chunkKey(coords[0], coords[2]))?.visualOnly === true;
      if (group.userData.visualOnly) group.visible = this.requestedDistance > 4;
    }
    for (const [mode, data] of Object.entries(result.layers)) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
      geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3, true));
      geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
      geometry.computeBoundingSphere();
      group.add(new THREE.Mesh(geometry, this.materials[mode]));
    }
    for (const sign of result.signs) {
      const mesh = this.signMesh(sign);
      mesh.userData.sign = true;
      group.add(mesh);
    }
    this.scene.add(group);
    this.groups.set(result.id, group);
    const edit = this.visibleEdits.get(result.id);
    if (edit) {
      this.lastEditRender = {revision: edit.revision, ms: performance.now() - edit.received};
      this.visibleEdits.delete(result.id);
    }
    this.meshTimes.push(result.elapsed);
    if (this.meshTimes.length > 2500) this.meshTimes.shift();
  }

  dispatch() {
    if (!this.pending.size) return;
    const direction = this.camera.getWorldDirection(new THREE.Vector3());
    const eye = this.camera.position;
    function score(job) {
      const scale = job.type === 'precise' ? 8 : 32;
      const x = job.cx * 16 + scale - eye.x;
      const y = job.type === 'precise' ? job.cy * 16 + 8 - eye.y : 0;
      const z = job.cz * 16 + scale - eye.z;
      const distance = Math.hypot(x, y, z);
      const visible = x * direction.x + y * direction.y + z * direction.z > 0;
      return distance * (visible ? .8 : 1.2) + (job.type === 'coarse' ? 260 : job.visualOnly ? 100 : 0) - (job.edit ? 500 : 0);
    }
    for (const worker of this.workers) {
      if (this.active.has(worker) || !this.pending.size || this.ready.length > 5) continue;
      let job, priority = Infinity;
      for (const candidate of this.pending.values()) {
        const next = score(candidate);
        if (next < priority) { job = candidate; priority = next; }
      }
      this.pending.delete(job.id);
      this.active.set(worker, job.id);
      if (job.type === 'precise') {
        const halo = this.world.halo(job.cx, job.cy, job.cz);
        worker.postMessage({id: job.id, type: job.type, version: job.version, palette: this.world.palette,
          connectedTextures: this.connectedTextures, ...halo},
          [halo.indices.buffer, halo.light.buffer]);
      } else {
        const chunks = [];
        for (let dz = -1; dz < 5; dz++) {
          for (let dx = -1; dx < 5; dx++) {
            const key = chunkKey(job.cx + dx, job.cz + dz);
            for (const [radius, ring] of this.ringData) {
              const chunk = ring.chunks.get(key);
              if (chunk && (radius <= this.requestedDistance || radius === job.radius)) {
                chunks.push({chunk, palette: ring.palette});
                break;
              }
            }
          }
        }
        worker.postMessage({id: job.id, type: job.type, version: job.version,
          chunks, stride: job.stride, origin: [job.cx * 16, 0, job.cz * 16]});
      }
    }
  }

  render(now, selection) {
    this.frameTimes.push(now - this.lastFrame);
    if (this.frameTimes.length > 10000) this.frameTimes.shift();
    this.lastFrame = now;
    if (this.materials) {
      const start = performance.now();
      while (this.ready.length && performance.now() - start < 4) this.accept(this.ready.shift());
      this.dispatch();
    }
    this.outline.visible = Boolean(selection);
    if (selection) this.outline.position.set(selection.x + .5, selection.y + .5, selection.z + .5);
    this.sky.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }

  statistics() {
    const {render, memory} = this.renderer.info;
    let preciseBytes = 0, coarseBytes = 0, preciseTriangles = 0, coarseTriangles = 0;
    for (const [id, group] of this.groups) {
      if (!group.visible) continue;
      const coarse = id.startsWith('lod:');
      for (const mesh of group.children) {
        const data = mesh.geometry;
        const bytes = Object.values(data.attributes).reduce((size, attr) => size + attr.array.byteLength, data.index?.array.byteLength || 0);
        const triangles = (data.index?.count || data.attributes.position.count) / 3;
        if (coarse) { coarseBytes += bytes; coarseTriangles += triangles; }
        else { preciseBytes += bytes; preciseTriangles += triangles; }
      }
    }
    return {calls: render.calls, triangles: render.triangles, geometries: memory.geometries, textures: memory.textures,
      preciseBytes, coarseBytes, preciseTriangles, coarseTriangles,
      pending: this.pending.size + this.active.size + this.ready.length,
      loaded: this.groups.size, lastEditRender: this.lastEditRender, meshTimes: this.meshTimes.slice(), frameTimes: this.frameTimes.slice()};
  }
}

function createSky() {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      zenith: {value: new THREE.Color('#84abfc')},
      horizon: {value: new THREE.Color('#95aad5')},
    },
    vertexShader: /* glsl */ `
      varying vec3 skyDirection;
      void main() {
        skyDirection = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 zenith;
      uniform vec3 horizon;
      varying vec3 skyDirection;
      void main() {
        float height = normalize(skyDirection).y;
        float mixAmount = 1.0 - exp(-max(height, 0.0) * 8.0);
        gl_FragColor = vec4(mix(horizon, zenith, mixAmount), 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(660, 24, 12), material);
  mesh.renderOrder = -10;
  return mesh;
}

const paintings = {
  Kebab:[0,0,16,16], Aztec:[16,0,16,16], Alban:[32,0,16,16], Aztec2:[48,0,16,16],
  Bomb:[64,0,16,16], Plant:[80,0,16,16], Wasteland:[96,0,16,16], Pool:[0,32,32,16],
  Courbet:[32,32,32,16], Sea:[64,32,32,16], Sunset:[96,32,32,16], Creebet:[128,32,32,16],
  Wanderer:[0,64,16,32], Graham:[16,64,16,32], Match:[0,128,32,32], Bust:[32,128,32,32],
  Stage:[64,128,32,32], Void:[96,128,32,32], SkullAndRoses:[128,128,32,32],
  Wither:[160,128,32,32], Fighters:[0,96,64,32], Pointer:[0,192,64,64],
  Pigscene:[64,192,64,64], BurningSkull:[128,192,64,64], Skeleton:[192,64,64,48], DonkeyKong:[192,112,64,48]
};
