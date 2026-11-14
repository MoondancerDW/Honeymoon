import * as THREE from '/vendor/three/three.module.js';
import {chunkKey, sectionKey, json} from './world-data.mjs';
import {celestialAngle, sunlightAt, writeLightmap} from './lighting.mjs';
import {CHISEL_FANTASY} from '../world/connected-textures.mjs';

const boxEdges = [0,1, 0,2, 0,4, 1,3, 1,5, 2,3, 2,6, 3,7, 4,5, 4,6, 5,7, 6,7];
const boxTriangles = [0,2,1, 1,2,3, 4,5,6, 5,7,6, 0,4,2, 4,6,2,
  1,3,5, 3,7,5, 0,1,4, 1,5,4, 2,6,3, 3,6,7];

function partGeometry(pointsPerBox) {
  const geometry = new THREE.BufferGeometry();
  // A hollow cover has four bars. Other individual pieces use fewer boxes.
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * pointsPerBox * 3), 3)
    .setUsage(THREE.DynamicDrawUsage));
  geometry.setDrawRange(0, 0);
  return geometry;
}

function drawPart(object, {x, y, z, boxes}, vertices, padding = 0) {
  const position = object.geometry.attributes.position;
  let vertex = 0;
  for (const box of boxes) {
    for (const corner of vertices) {
      position.setXYZ(vertex++, corner & 1 ? box.x1 + padding : box.x0 - padding,
        corner & 2 ? box.y1 + padding : box.y0 - padding,
        corner & 4 ? box.z1 + padding : box.z0 - padding);
    }
  }
  position.needsUpdate = true;
  object.geometry.setDrawRange(0, vertex);
  object.position.set(x, y, z);
  object.updateMatrixWorld();
}

export class Display {
  constructor(container, world, dayTick = 6000) {
    this.world = world;
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = false;
    this.scene.background = new THREE.Color('#86acfa');
    this.scene.fog = new THREE.Fog('#95aad5', 70, 175);
    this.sky = createSky();
    this.scene.add(this.sky);
    this.dayStarted = Date.now();
    this.firstDayTick = dayTick;
    this.cycleTime = null;
    this.lightBytes = new Uint8Array(16 * 17 * 4);
    this.lightmap = new THREE.DataTexture(this.lightBytes, 16, 17, THREE.RGBAFormat);
    this.lightmap.magFilter = this.lightmap.minFilter = THREE.NearestFilter;
    this.dayHorizon = new THREE.Color('#95aad5');
    this.dayZenith = new THREE.Color('#84abfc');
    this.nightHorizon = new THREE.Color('#10182b');
    this.nightZenith = new THREE.Color('#05091a');
    this.updateSky(dayTick);
    this.visualEntities = new THREE.Group();
    this.visualEntities.visible = false;
    this.scene.add(this.visualEntities);
    this.paintingLights = new Map();
    this.camera = new THREE.PerspectiveCamera(70, 1, .06, 850);
    this.renderer = new THREE.WebGLRenderer({antialias: true, powerPreference: 'high-performance'});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.65));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.uploadScene = new THREE.Scene();
    this.uploadScene.fog = this.scene.fog;
    this.uploads = [];
    this.nextBackgroundUpload = 0;
    this.lastBackgroundUpload = 0;
    this.viewDirection = new THREE.Vector3();
    this.lastViewDirection = new THREE.Vector3();
    this.expectedChunks = new Set([...world.manifest.chunks, ...(world.manifest.visualChunks ?? [])]
      .map(([x, z]) => chunkKey(x, z)));
    this.installedVersions = new Map();
    container.append(this.renderer.domElement);
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.groups = new Map();
    this.pending = new Map();
    this.versions = new Map();
    this.ready = [];
    this.active = new Map();
    this.workerFailure = null;
    this.workers = Array.from({length: Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1))}, () => {
      const worker = new Worker('/mesh-worker.mjs', {type: 'module'});
      worker.onmessage = ({data}) => {
        this.active.delete(worker);
        this.ready.push(data);
      };
      worker.onerror = event => {
        this.active.delete(worker);
        this.fail(new Error(event.message));
      };
      worker.postMessage({type: 'init', palette: world.palette, compositions: world.manifest.compositions || {}, models: world.models});
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
    this.partOutline = new THREE.LineSegments(partGeometry(boxEdges.length), this.outline.material);
    this.partOutline.renderOrder = 3;
    this.partPreview = new THREE.Mesh(partGeometry(boxTriangles.length), new THREE.MeshBasicMaterial({
      color: '#79f0ba', transparent: true, opacity: .32, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.partPreview.renderOrder = 2;
    for (const object of [this.partOutline, this.partPreview]) {
      object.frustumCulled = false;
      object.visible = false;
      this.scene.add(object);
    }
  }

  async loadTextures() {
    const loader = new THREE.TextureLoader();
    const materialsFor = (map, alphaTest = .47) => {
      map.colorSpace = THREE.SRGBColorSpace;
      map.magFilter = map.minFilter = THREE.NearestFilter;
      map.generateMipmaps = false;
      const layers = {
        opaque: new THREE.MeshBasicMaterial({map, vertexColors: true}),
        cutout: new THREE.MeshBasicMaterial({map, vertexColors: true, alphaTest, side: THREE.DoubleSide}),
        blend: new THREE.MeshBasicMaterial({map, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide}),
      };
      for (const material of Object.values(layers)) this.useLightmap(material);
      return layers;
    };
    const [map, atlas] = await Promise.all([
      loader.loadAsync('/generated/textures/atlas.png'),
      json('/generated/textures/atlas.json').catch(() => null),
    ]);
    this.connectedTextures = atlas?.connectedTextures === true;
    this.chiselConnectedTextures = atlas?.chiselConnectedTextures === true;
    const additional = await Promise.all(Object.keys(this.world.models || {}).map(async family => {
      const texture = await loader.loadAsync(`/generated/models/${family}.png`);
      return Object.entries(materialsFor(texture, 26 / 255)).map(([mode, material]) => [`${family}:${mode}`, material]);
    }));
    this.materials = {...materialsFor(map), ...Object.fromEntries(additional.flat())};
    if (this.world.models?.redpower) {
      const glow = new THREE.MeshBasicMaterial({vertexColors:true, transparent:true, opacity:.3,
        blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide});
      this.useLightmap(glow);
      this.materials['redpower:glow'] = glow;
    }
    try {
      this.paint = await loader.loadAsync('/generated/textures/paintings.png');
      this.paint.colorSpace = THREE.SRGBColorSpace;
      this.paint.magFilter = this.paint.minFilter = THREE.NearestFilter;
    } catch {
      this.paint = null;
    }
  }

  async prepareGraphics() {
    const warmup = new THREE.Scene();
    warmup.fog = this.scene.fog;
    const camera = new THREE.PerspectiveCamera(70, 1, .06, 850);
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(12).fill(255), 3, true));
    geometry.setAttribute('legacyLightLevel', new THREE.BufferAttribute(new Uint16Array(4).fill(240), 1));
    const line = this.outline.clone();
    line.visible = true;
    line.position.z = -2;
    warmup.add(line, this.sky.clone());
    const preview = new THREE.Mesh(geometry, this.partPreview.material);
    preview.position.z = -2;
    warmup.add(preview);
    const textures = new Set([this.lightmap, this.paint]);
    for (const material of Object.values(this.materials)) {
      textures.add(material.map);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.z = -2;
      warmup.add(mesh);
    }
    const sign = this.signMesh({x:0, y:0, z:-2, rotation:0, width:1, height:1, lines:['']});
    warmup.add(sign);
    // Keep a reference to each program variant until this renderer is gone.
    this.shaderSamples = [sign.material];
    if (this.paint) {
      const material = this.paintingMaterial(this.paint);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.z = -2;
      warmup.add(mesh);
      this.shaderSamples.push(material);
    }
    try {
      await this.renderer.compileAsync(warmup, camera);
      for (const texture of textures) if (texture) this.renderer.initTexture(texture);
      // Complete Three's first-use reflection on the same framebuffer as play.
      this.renderer.setScissor(0, 0, 1, 1);
      this.renderer.setScissorTest(true);
      this.renderer.render(warmup, camera);
    } finally {
      this.renderer.setScissorTest(false);
      geometry.dispose();
      sign.geometry.dispose();
      sign.material.map.dispose();
    }
  }

  get pendingWork() {
    return this.pending.size + this.active.size + this.ready.length + this.uploads.length;
  }

  fail(error) {
    this.workerFailure ??= error;
    this.onError?.(error);
  }

  async whenReady(chunks) {
    this.startupChunks = chunks && new Set(chunks.map(([cx, cz]) => chunkKey(cx, cz)));
    const waiting = () => {
      if (!chunks) return this.pendingWork > 0;
      return chunks.some(([cx, cz]) => {
        const chunk = this.world.chunks.get(chunkKey(cx, cz));
        return !chunk || [...chunk.sections.keys()].some(cy => {
          const id = sectionKey(cx, cy, cz);
          return this.installedVersions.get(id) !== this.versions.get(id);
        });
      });
    };
    while (!this.workerFailure && waiting()) {
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    this.startupChunks = null;
    if (this.workerFailure) throw this.workerFailure;
  }

  useLightmap(material) {
    material.onBeforeCompile = shader => {
      shader.uniforms.honeymoonLightmap = {value:this.lightmap};
      shader.vertexShader = `uniform sampler2D honeymoonLightmap;
        attribute float legacyLightLevel;
        vec3 lightSrgbToLinear(vec3 encoded) {
          return mix(encoded / 12.92, pow((encoded + .055) / 1.055, vec3(2.4)), step(vec3(.04045), encoded));
        }
        ${shader.vertexShader}`.replace('#include <color_vertex>', `#include <color_vertex>
          float blockLight = mod(legacyLightLevel, 16.0);
          float skyLight = floor(legacyLightLevel / 16.0);
          vec3 illumination = texture2D(honeymoonLightmap, vec2((blockLight + .5) / 16.0, (skyLight + .5) / 17.0)).rgb;
          vColor.rgb = lightSrgbToLinear(vColor.rgb * illumination);`);
    };
  }

  updateSky(tick) {
    const sun = sunlightAt(tick);
    const angle = Math.PI * 2 * celestialAngle(tick);
    const sky = Math.max(0, Math.min(1, 2 * Math.cos(angle) + .5));
    if (this.lastSun !== sun) {
      writeLightmap(this.lightBytes, sun);
      this.lightmap.needsUpdate = true;
      this.lastSun = sun;
    }
    const {zenith, horizon} = this.sky.material.uniforms;
    zenith.value.copy(this.nightZenith).lerp(this.dayZenith, sky);
    horizon.value.copy(this.nightHorizon).lerp(this.dayHorizon, sky);
    this.scene.fog.color.copy(horizon.value);
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
    this.remeshLighting(this.world.updateLighting(chunk));
    const levels = new Set(chunk.sections.keys());
    const fantasy = this.chiselConnectedTextures ? this.world.indices.get(CHISEL_FANTASY) : undefined;
    for (const change of this.world.overrides.values()) {
      if (Math.floor(change.x / 16) !== chunk.x || Math.floor(change.z / 16) !== chunk.z) continue;
      levels.add(Math.floor(change.y / 16));
      if (fantasy !== undefined && change.index === fantasy) this.remeshAdjacentSections(change.x, change.y, change.z);
    }
    for (const cy of levels) {
      this.schedule(chunk.x, cy, chunk.z, !chunk.sections.has(cy));
      for (const [dx, dz] of [[-1,0], [1,0], [0,-1], [0,1]]) this.schedule(chunk.x + dx, cy, chunk.z + dz);
      const indices = chunk.sections.get(cy)?.indices;
      if (!indices || fantasy === undefined) continue;
      for (let index = indices.indexOf(fantasy); index >= 0; index = indices.indexOf(fantasy, index + 1)) {
        this.remeshAdjacentSections(chunk.x * 16 + (index & 15), cy * 16 + (index >> 8), chunk.z * 16 + (index >> 4 & 15));
      }
    }
    for (const entity of chunk.entities) this.addEntity(entity, chunk.visualOnly);
  }

  remeshLighting(sections) {
    for (const section of sections) {
      this.schedule(...section.split(',').map(Number));
      for (const {mesh, position} of this.paintingLights.get(section) ?? []) {
        const light = mesh.geometry.attributes.legacyLightLevel;
        light.array.fill(this.world.lightAt(...position));
        light.needsUpdate = true;
      }
    }
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
    this.remeshAdjacentSections(x, y, z, true);
  }

  remeshAdjacentSections(x, y, z, edit = false) {
    const cx = x >> 4, cy = y >> 4, cz = z >> 4;
    for (let zz = (z - 1) >> 4; zz <= (z + 1) >> 4; zz++) {
      for (let yy = (y - 1) >> 4; yy <= (y + 1) >> 4; yy++) {
        for (let xx = (x - 1) >> 4; xx <= (x + 1) >> 4; xx++) {
          const axes = Number(xx !== cx) + Number(yy !== cy) + Number(zz !== cz);
          if (axes === 1 || (axes > 1 && this.chiselConnectedTextures)) this.schedule(xx, yy, zz, edit);
        }
      }
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
    for (const {radius} of this.world.manifest.terrain ?? []) {
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

  paintingMaterial(map) {
    const material = new THREE.MeshBasicMaterial({map, vertexColors:true, side:THREE.DoubleSide});
    this.useLightmap(material);
    return material;
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
    const material = this.paintingMaterial(tex);
    const geometry = new THREE.PlaneGeometry(w / 16, h / 16);
    const position = entity.position.map(Math.floor);
    const block = this.world.lightAt(...position);
    geometry.setAttribute('legacyLightLevel', new THREE.BufferAttribute(new Uint16Array(4).fill(block), 1));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(12).fill(255), 3, true));
    const mesh = new THREE.Mesh(geometry, material);
    const id = sectionKey(...position.map(value => value >> 4));
    if (!this.paintingLights.has(id)) this.paintingLights.set(id, []);
    this.paintingLights.get(id).push({mesh, position});
    mesh.position.set(...entity.position);
    mesh.rotation.y = [0, Math.PI / 2, Math.PI, -Math.PI / 2][dir & 3];
    this.uploads.push({meshes:[mesh], object:mesh, parent:visualOnly ? this.visualEntities : this.scene});
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
    if (result.error) { this.fail(new Error(result.error)); return; }
    if (this.versions.get(result.id) !== result.version) return;
    const lod = result.id.startsWith('lod:');
    const coords = lod ? result.id.split(':')[2].split(',').map(Number) : result.id.split(',').map(Number);
    const group = new THREE.Group();
    if (lod) {
      group.position.set(coords[0] * 64, 0, coords[1] * 64);
    } else {
      group.position.set(...coords.map(value => value * 16));
      group.userData.visualOnly = this.world.chunks.get(chunkKey(coords[0], coords[2]))?.visualOnly === true;
    }
    for (const [mode, data] of Object.entries(result.layers)) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
      geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3, true));
      geometry.setAttribute('legacyLightLevel', new THREE.BufferAttribute(data.lightLevels, 1));
      geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
      const {center, radius} = data.bounds;
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(...center), radius);
      group.add(new THREE.Mesh(geometry, this.materials[mode]));
    }
    for (const sign of result.signs) {
      const mesh = this.signMesh(sign);
      mesh.userData.sign = true;
      group.add(mesh);
    }
    this.uploads.push({meshes:group.children.slice(), object:group, parent:this.scene,
      result:{id:result.id, version:result.version, elapsed:result.elapsed}});
  }

  discardGroup(group) {
    group.removeFromParent();
    for (const mesh of group.children) {
      mesh.geometry.dispose();
      if (mesh.userData.sign) {
        mesh.material.map.dispose();
        mesh.material.dispose();
      }
    }
  }

  install({object, parent, result}) {
    parent.add(object);
    object.traverse(node => {
      node.updateMatrix();
      node.matrixAutoUpdate = false;
    });
    object.updateMatrixWorld(true);
    if (!result) return;
    const {id, elapsed} = result;
    const previous = this.groups.get(id);
    if (previous) this.discardGroup(previous);
    object.visible = id.startsWith('lod:') ? Number(id.split(':')[1]) <= this.requestedDistance
      : !object.userData.visualOnly || this.requestedDistance > 4;
    this.groups.set(id, object);
    this.installedVersions.set(id, result.version);
    const edit = this.visibleEdits.get(id);
    if (edit) {
      this.lastEditRender = {revision: edit.revision, ms: performance.now() - edit.received};
      this.visibleEdits.delete(id);
    }
    this.meshTimes.push(elapsed);
    if (this.meshTimes.length > 2500) this.meshTimes.shift();
  }

  upload(deadline, byteLimit = 1.5 * 1024 ** 2) {
    if (!this.uploads.length) return;
    const finished = [];
    const staged = [];
    let bytes = 0, count = 0;
    try {
      while (this.uploads.length && count < 30 && performance.now() < deadline) {
        const job = this.uploads[0];
        if (job.result && this.versions.get(job.result.id) !== job.result.version) {
          this.discardGroup(job.object);
          this.uploads.shift();
          continue;
        }
        const mesh = job.meshes[0];
        if (!mesh) { finished.push(this.uploads.shift()); continue; }
        const data = mesh.geometry;
        const size = Object.values(data.attributes).reduce((sum, attr) => sum + attr.array.byteLength, data.index?.array.byteLength || 0);
        if (count && bytes + size > byteLimit) break;
        const staging = new THREE.Mesh(data, mesh.material);
        staging.frustumCulled = false;
        staged.push({data, ...data.drawRange});
        data.setDrawRange(0, 0);
        this.uploadScene.add(staging);
        if (mesh.userData.sign || !job.result) this.renderer.initTexture(mesh.material.map);
        job.meshes.shift();
        bytes += size;
        count++;
        if (!job.meshes.length) finished.push(this.uploads.shift());
      }
      if (count) {
        // A zero-length draw initializes both vertex and index buffers, with the
        // same shader/VAO as the live mesh, before a camera turn can encounter it.
        this.renderer.autoClear = false;
        this.renderer.setScissor(0, 0, 1, 1);
        this.renderer.setScissorTest(true);
        this.renderer.render(this.uploadScene, this.camera);
      }
    } catch (error) {
      this.fail(error);
      return;
    } finally {
      this.renderer.autoClear = true;
      this.renderer.setScissorTest(false);
      this.uploadScene.clear();
      for (const {data, start, count} of staged) data.setDrawRange(start, count);
    }
    for (const job of finished) this.install(job);
  }

  neighborsLoaded({cx, cz}) {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const key = chunkKey(cx + dx, cz + dz);
      if (this.expectedChunks.has(key) && !this.world.chunks.has(key)) return false;
    }
    return true;
  }

  async waitForStreamSlot(near) {
    const budget = near ? 40 : 16;
    while (!this.workerFailure) {
      let ready = this.active.size + this.ready.length + this.uploads.length;
      for (const job of this.pending.values()) {
        if (job.type !== 'precise' || this.neighborsLoaded(job)) ready++;
        if (ready >= budget) break;
      }
      // A queue waiting for neighbor data can only progress if fetching resumes.
      if (ready < budget && (ready === 0 || near || performance.now() >= this.nextBackgroundUpload)) break;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    if (this.workerFailure) throw this.workerFailure;
  }

  dispatch(deadline, workerLimit = this.workers.length) {
    if (!this.pending.size) return;
    const direction = this.camera.getWorldDirection(new THREE.Vector3());
    const eye = this.camera.position;
    const score = job => {
      const scale = job.type === 'precise' ? 8 : 32;
      const x = job.cx * 16 + scale - eye.x;
      const y = job.type === 'precise' ? job.cy * 16 + 8 - eye.y : 0;
      const z = job.cz * 16 + scale - eye.z;
      const distance = Math.hypot(x, y, z);
      const visible = x * direction.x + y * direction.y + z * direction.z > 0;
      const startup = this.startupChunks?.has(chunkKey(job.cx, job.cz)) && job.type === 'precise';
      return distance * (visible ? .8 : 1.2) + (job.type === 'coarse' ? 260 : job.visualOnly ? 100 : 0) - (job.edit || startup ? 500 : 0);
    };
    for (const worker of this.workers) {
      if (this.active.size >= workerLimit || performance.now() >= deadline || this.ready.length > 5 || this.uploads.length > 32) break;
      if (this.active.has(worker) || !this.pending.size) continue;
      let job, priority = Infinity;
      for (const candidate of this.pending.values()) {
        const next = score(candidate);
        if (next < priority && (candidate.type !== 'precise' || this.neighborsLoaded(candidate))) {
          job = candidate;
          priority = next;
        }
      }
      if (!job) return;
      this.pending.delete(job.id);
      this.active.set(worker, job.id);
      if (job.type === 'precise') {
        const halo = this.world.halo(job.cx, job.cy, job.cz);
        worker.postMessage({id: job.id, type: job.type, version: job.version, palette: this.world.palette,
          connectedTextures: this.connectedTextures, chiselConnectedTextures: this.chiselConnectedTextures, ...halo},
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

  render(now, selection, playing = false, placement = null) {
    if (now >= (this.nextSkyUpdate ?? 0)) {
      this.updateSky(this.cycleTime ?? this.firstDayTick + Math.max(0, Date.now() - this.dayStarted) / 50);
      this.nextSkyUpdate = now + 200;
    }
    const interval = now - this.lastFrame;
    this.frameTimes.push(interval);
    if (this.frameTimes.length > 10000) this.frameTimes.shift();
    this.lastFrame = now;
    this.camera.getWorldDirection(this.viewDirection);
    const turning = playing && this.lastViewDirection.dot(this.viewDirection) < .82;
    if (turning) this.nextBackgroundUpload = now + 80;
    this.lastViewDirection.copy(this.viewDirection);
    if (playing && interval > 36) this.nextBackgroundUpload = Math.max(this.nextBackgroundUpload, now + 44);
    const edit = this.visibleEdits.size > 0;
    const stream = !playing || edit || now >= this.nextBackgroundUpload || !turning && now - this.lastBackgroundUpload >= 140;
    if (this.materials && !this.workerFailure && stream) {
      const deadline = performance.now() + (playing ? 2 : 4);
      while (this.ready.length && this.uploads.length < 32 && performance.now() < deadline) {
        this.accept(this.ready.shift());
        if (playing) break;
      }
      this.upload(deadline, (playing ? .55 : 1.5) * 1024 ** 2);
      this.dispatch(deadline, playing ? 2 : this.workers.length);
      this.lastBackgroundUpload = now;
    }
    const detail = selection?.voxel !== undefined ? `voxel:${selection.voxel}` : selection?.partSlot;
    this.partOutline.visible = detail !== undefined;
    this.outline.visible = Boolean(selection) && detail === undefined;
    if (this.partOutline.visible) {
      const key = `${selection.x},${selection.y},${selection.z},${detail},${this.world.revisionAt(selection.x, selection.y, selection.z)}`;
      if (key !== this.partOutlineKey) {
        drawPart(this.partOutline, selection, boxEdges, .002);
        this.partOutlineKey = key;
      }
    } else if (selection) {
      this.outline.position.set(selection.x + .5, selection.y + .5, selection.z + .5);
      this.outline.updateMatrixWorld();
    }
    this.partPreview.visible = Boolean(placement);
    if (placement && this.drawnPlacement !== placement) {
      drawPart(this.partPreview, placement, boxTriangles);
      this.drawnPlacement = placement;
    }
    if (placement && this.previewBlocked !== placement.blocked) {
      this.partPreview.material.color.set(placement.blocked ? '#ed7779' : '#79f0ba');
      this.previewBlocked = placement.blocked;
    }
    this.sky.position.copy(this.camera.position);
    this.sky.updateMatrixWorld();
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
      pending: this.pendingWork,
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
