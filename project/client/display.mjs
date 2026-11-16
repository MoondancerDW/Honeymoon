import * as THREE from '/vendor/three/three.module.js';
import {chunkKey, sectionKey, json} from './world-data.mjs';
import {celestialAngle, sunlightAt, writeLightmap} from './lighting.mjs';
import {CHISEL_FANTASY} from '../world/connected-textures.mjs';
import {itemFrameModel} from '../world/item-frames.mjs';
import {isRideableMinecart, minecartQuads, minecartRotation, minecartTilt} from '../world/minecarts.mjs';
import {boatHeading,isRideableBoat} from '../world/boats.mjs';
import {boatModel} from '../world/boat-model.mjs';
import {RemotePlayers} from './remote-players.mjs';
import {createPonyAvatar, createPonyFacing} from './pony-avatar.mjs';
import {cameraClearance} from './movement.mjs';
import {clockTick} from '../world/world-time.mjs';
import {SectionVisibility} from './section-visibility.mjs';
import {FarTerrain, supportsFarTerrain, VISTA_FOG_END} from './far-terrain.mjs';
import {FIRE_FRAMES, FIRE_SIZE, FIRE_STEP_MS, fireSpriteSheet} from '../world/fire-animation.mjs';
import {addTerrainFilter, terrainFilter} from './terrain-filter.mjs';
import {ViewBobbing} from './view-bobbing.mjs';
import {PonyShadows} from './pony-shadows.mjs';
import {BlockDebris} from './block-debris.mjs';
import {DroppedItemView} from './dropped-items.mjs';
import {HeldLights} from './held-light.mjs';
import {groundSurface} from './audio.mjs';
import {Rain} from './rain.mjs';
import {isWeather} from '../world/weather.mjs';

const boxEdges = [0,1, 0,2, 0,4, 1,3, 1,5, 2,3, 2,6, 3,7, 4,5, 4,6, 5,7, 6,7];
const boxTriangles = [0,2,1, 1,2,3, 4,5,6, 5,7,6, 0,4,2, 4,6,2,
  1,3,5, 3,7,5, 0,1,4, 1,5,4, 2,6,3, 3,6,7];
const perspectives = ['first', 'back', 'front'];

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

function drawModelPreview(object, {x, y, z, surfaces}) {
  const vertices = [0, 1, 2, 0, 2, 3];
  let position = object.geometry.attributes.position;
  const count = surfaces.length * vertices.length;
  if (position.count < count) {
    const previous = object.geometry;
    object.geometry = new THREE.BufferGeometry();
    position = new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage);
    object.geometry.setAttribute('position', position);
    previous.dispose();
  }
  let vertex = 0;
  for (const {positions} of surfaces) {
    for (const corner of vertices) {
      const index = corner * 3;
      position.setXYZ(vertex++, positions[index], positions[index + 1], positions[index + 2]);
    }
  }
  position.needsUpdate = true;
  object.geometry.setDrawRange(0, vertex);
  object.position.set(x, y, z);
  object.updateMatrixWorld();
}

function quadGeometry(quads, light, shade) {
  const geometry = new THREE.BufferGeometry();
  const vertices = quads.length * 4;
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(quads.flatMap(quad => quad.positions), 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(quads.flatMap(quad =>
    quad.uv.map((value, index) => index & 1 ? 1 - value : value)), 2));
  geometry.setAttribute('legacyLightLevel', new THREE.BufferAttribute(new Uint16Array(vertices).fill(light), 1));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(3 * vertices).fill(shade), 3, true));
  geometry.setIndex(quads.flatMap((_, i) => [0, 1, 2, 0, 2, 3].map(vertex => 4 * i + vertex)));
  return geometry;
}

export class Display {
  constructor(container, world, dayTick = 6000) {
    this.world = world;
    this.sectionVisibility = new SectionVisibility();
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = false;
    this.scene.background = new THREE.Color('#86acfa');
    this.scene.fog = new THREE.Fog('#95aad5', 70, 175);
    this.sky = createSky();
    this.scene.add(this.sky);
    this.worldTime = {tick:dayTick, frozen:false, received:performance.now()};
    this.cycleTime = null;
    this.lightBytes = new Uint8Array(16 * 17 * 4);
    this.lightmap = new THREE.DataTexture(this.lightBytes, 16, 17, THREE.RGBAFormat);
    this.lightmap.magFilter = this.lightmap.minFilter = THREE.NearestFilter;
    this.heldLights = new HeldLights(world);
    this.dayHorizon = new THREE.Color('#95aad5');
    this.dayZenith = new THREE.Color('#84abfc');
    this.nightHorizon = new THREE.Color('#0c1326');
    this.nightZenith = new THREE.Color('#040716');
    this.cloudyHorizon = new THREE.Color('#69727d');
    this.cloudyNight = new THREE.Color('#070a10');
    this.weather = 'clear';
    this.nightVision = false;
    this.updateSky(dayTick);
    this.visualEntities = new THREE.Group();
    this.visualEntities.visible = false;
    this.scene.add(this.visualEntities);
    this.entityLights = new Map();
    this.importedVehicles = new Map();
    this.importedFrames = new Map();
    this.editedFrames = new Map();
    this.dispenserItems = [];
    this.frameChunksDirty = true;
    this.movingVehicles = new Map();
    this.chunkEntities = new Map();
    this.exactChunks = new Set();
    this.preciseLevels = new Map();
    this.completedChunks = new Set();
    this.camera = new THREE.PerspectiveCamera(70, 1, .06, 850);
    this.viewBob = new ViewBobbing();
    this.perspective = 0;
    this.cameraDistance = .1;
    this.localSkin = null;
    const ponyAirAt = (x,y,z) => this.world.hasChunk(x,z) && !this.world.cellAt(x,y,z);
    this.ponyAirAt = ponyAirAt;
    this.players = new RemotePlayers(this.scene,this.camera,() => this.heldItemAssets(),ponyAirAt,
      (feet,body,motion,fall,now) => this.groundDust(feet,body,motion,fall,now));
    this.ponyShadows = new PonyShadows(this.scene, this.world);
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
    this.nextSectionVersion = 0;
    this.ready = [];
    this.active = new Map();
    this.workerCatalogs = new Map();
    this.workerFailure = null;
    const workers = Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
    this.workers = Array.from({length: workers}, () => {
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
      this.workerCatalogs.set(worker, world.palette.length);
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
    this.atlasRows = atlas?.rows ?? 64;
    this.carpentryModel = atlas?.carpentryModel === true;
    const additional = await Promise.all(Object.keys(this.world.models || {}).map(async family => {
      const texture = await loader.loadAsync(`/generated/models/${family}.png`);
      return Object.entries(materialsFor(texture, 26 / 255)).map(([mode, material]) => [`${family}:${mode}`, material]);
    }));
    this.materials = {...materialsFor(map), ...Object.fromEntries(additional.flat())};
    const textures = terrainFilter(map,this.atlasRows);
    this.useLightmap(this.materials.opaque,textures);
    this.useLightmap(this.materials.blend,textures);
    this.materials.water = this.materials.blend.clone();
    this.useLightmap(this.materials.water,textures,true);
    if (supportsFarTerrain(this.world.manifest)) this.farTerrain = new FarTerrain(this,textures);
    this.fireTexture = new THREE.DataTexture(fireSpriteSheet(),FIRE_SIZE*2,FIRE_SIZE*FIRE_FRAMES);
    this.fireTexture.colorSpace = THREE.SRGBColorSpace;
    this.fireTexture.repeat.y = 1 / FIRE_FRAMES;
    this.fireTexture.needsUpdate = true;
    this.materials.fire = new THREE.MeshBasicMaterial({map:this.fireTexture, alphaTest:.1, side:THREE.DoubleSide});
    this.materials.pane = new THREE.MeshBasicMaterial({map, vertexColors: true, alphaTest: .47});
    this.useLightmap(this.materials.pane);
    this.minecartMaterial = new THREE.MeshBasicMaterial({color:'#aeb3bc',vertexColors:true});
    this.useLightmap(this.minecartMaterial);
    const boatMap = this.world.boatTexture ? await loader.loadAsync('/generated/textures/boat.png').catch(() => null) : null;
    if (boatMap) {
      boatMap.colorSpace = THREE.SRGBColorSpace;
      boatMap.magFilter = boatMap.minFilter = THREE.NearestFilter;
      boatMap.generateMipmaps = false;
      this.materials.boat = new THREE.MeshBasicMaterial({map:boatMap,vertexColors:true});
      this.useLightmap(this.materials.boat);
    }
    this.boatQuads = boatModel(boatMap ? undefined : this.atlasRows);
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
    const farMeshes = this.farTerrain?.warmup() ?? [];
    for (const mesh of farMeshes) {
      mesh.position.z = -2;
      warmup.add(mesh);
    }
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
      // Some graphics drivers never finish the parallel-compile query under load.
      // Rendering the warmup still forces the first-use programs to finish safely.
      let wait;
      try {
        await Promise.race([this.renderer.compileAsync(warmup, camera),
          new Promise(resolve => { wait = setTimeout(resolve, 2500); })]);
      } finally { clearTimeout(wait); }
      for (const texture of textures) if (texture) this.renderer.initTexture(texture);
      // Complete Three's first-use reflection on the same framebuffer as play.
      this.renderer.setScissor(0, 0, 1, 1);
      this.renderer.setScissorTest(true);
      this.renderer.render(warmup, camera);
    } finally {
      this.renderer.setScissorTest(false);
      geometry.dispose();
      for (const mesh of farMeshes) mesh.geometry.dispose();
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
    try {
      while (!this.workerFailure && (chunks ? !this.chunksReady(chunks) : this.pendingWork > 0)) {
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      if (this.workerFailure) throw this.workerFailure;
    } finally { this.startupChunks = null; }
  }

  chunksReady(chunks) {
    return chunks.every(([cx, cz]) => {
      const chunk = this.world.chunks.get(chunkKey(cx, cz));
      return chunk && [...chunk.sections.keys()].every(cy => {
        const id = sectionKey(cx, cy, cz);
        return this.installedVersions.has(id) && this.installedVersions.get(id) === this.versions.get(id);
      });
    });
  }

  useLightmap(material, textures = null, water = false) {
    if (textures) material.customProgramCacheKey = () => water ? 'filteredWater' : 'filteredTerrain';
    material.onBeforeCompile = shader => {
      if (textures) addTerrainFilter(shader,textures,this.atlasRows,water);
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
      this.heldLights.attach(shader);
    };
  }

  updateSky(tick) {
    const sun = sunlightAt(tick);
    const angle = Math.PI * 2 * celestialAngle(tick);
    const sky = Math.max(0, Math.min(1, 2 * Math.cos(angle) + .5));
    const overcast = this.weather !== 'clear';
    const skyStrength = overcast ? Math.min(sun,.025 + .975 * sky) : sun;
    if (this.lastSun !== skyStrength) {
      writeLightmap(this.lightBytes,skyStrength,{skyLoss:overcast ? 3 : 0,darkFloor:true,nightVision:this.nightVision});
      this.lightmap.needsUpdate = true;
      this.lastSun = skyStrength;
    }
    const {zenith, horizon, sunDirection, cloudOffset, night, cloudy} = this.sky.material.uniforms;
    zenith.value.copy(this.nightZenith).lerp(this.dayZenith, sky);
    horizon.value.copy(overcast ? this.cloudyNight : this.nightHorizon)
      .lerp(overcast ? this.cloudyHorizon : this.dayHorizon,sky);
    sunDirection.value.set(-Math.sin(angle), Math.cos(angle) * .96, Math.cos(angle) * -.28);
    cloudOffset.value.set(Math.sin(angle) * 1.3, (1 - Math.cos(angle)) * .6);
    night.value = 1 - sky;
    cloudy.value = Number(overcast);
    this.scene.fog.color.copy(horizon.value);
  }

  setWeather(mode) {
    if (!isWeather(mode) || mode === this.weather) return;
    this.weather = mode;
    this.lastSun = undefined;
    this.nextSkyUpdate = 0;
    if (mode !== 'rain') this.rain?.visible(false);
    this.visibleRain = 0;
  }

  setNightVision(enabled) {
    if (enabled === this.nightVision) return;
    this.nightVision = enabled;
    this.lastSun = undefined;
    this.nextSkyUpdate = 0;
  }

  setWorldTime(time) {
    this.worldTime = {...time, received:performance.now()};
    this.nextSkyUpdate = 0;
  }

  dayTick(now) {
    return this.cycleTime ?? clockTick(this.worldTime, now - this.worldTime.received);
  }

  cyclePerspective() {
    this.perspective = (this.perspective + 1) % perspectives.length;
    return perspectives[this.perspective];
  }

  perspectiveView() {
    return {mode:perspectives[this.perspective], distance:this.cameraDistance,
      position:this.camera.position.toArray()};
  }

  updateCamera(position,{yaw,pitch},eyeHeight,stanceHeight) {
    const avatar = this.localAvatar;
    const eyes = avatar && !this.spectating ? avatar.eyesWorldPosition() : null;
    const stanceEye = stanceHeight && eyes ? Math.max(.08,Math.min(stanceHeight-.035,eyes.y-avatar.object.position.y)) : undefined;
    const eyeY = position.y + (stanceEye ?? eyeHeight);
    const front = this.perspective === 2;
    this.camera.rotation.set(front ? -pitch : pitch, yaw + (front ? Math.PI : 0), 0, 'YXZ');
    this.camera.position.set(position.x, eyeY, position.z);
    if (this.perspective === 0) {
      this.cameraDistance = 0;
      if (eyes) {
        const target = eyes;
        target.x += position.x - avatar.object.position.x;
        target.y = stanceEye === undefined ? target.y + position.y - avatar.object.position.y : eyeY;
        target.z += position.z - avatar.object.position.z;
        const origin = [position.x,target.y,position.z];
        const delta = new THREE.Vector3(target.x - origin[0],0,target.z - origin[2]);
        const distance = delta.length();
        delta.normalize();
        const clearance = cameraClearance(this.world,origin,delta.toArray(),distance);
        this.camera.position.set(origin[0] + delta.x * clearance,target.y,origin[2] + delta.z * clearance);
      }
      this.actionEye = this.camera.position.toArray().map((value,index) => value - position[['x','y','z'][index]]);
      if (stanceEye === undefined) {
        const bob = this.viewBob.sample();
        this.camera.rotateX(bob.pitch);
        this.camera.rotateZ(bob.roll);
        this.camera.translateX(bob.x);
        this.camera.translateY(bob.y);
      }
    } else {
      this.actionEye = stanceEye === undefined ? undefined : [0,stanceEye,0];
      const sign = front ? -1 : 1;
      const direction = [sign * Math.sin(yaw) * Math.cos(pitch), -sign * Math.sin(pitch),
        sign * Math.cos(yaw) * Math.cos(pitch)];
      this.cameraDistance = cameraClearance(this.world, [position.x, eyeY, position.z], direction);
      this.camera.position.set(position.x + direction[0] * this.cameraDistance,
        eyeY + direction[1] * this.cameraDistance, position.z + direction[2] * this.cameraDistance);
    }
    this.camera.updateMatrixWorld();
    if (this.localAvatar) this.localAvatar.object.visible = !this.spectating &&
      (this.perspective === 0 || this.cameraDistance > .36);
  }

  eyeOffset() {
    return this.actionEye?.slice();
  }

  sightOrigin(position, eyeHeight) {
    return this.actionEye ?
      this.actionEye.map((value,index) => value + position[['x','y','z'][index]]) : [position.x,position.y + eyeHeight,position.z];
  }

  setLocalSkin(skin) {
    this.localSkin = skin;
    this.localAvatar?.setSkin(skin);
  }

  heldItemAssets() {
    if (!this.materials) return undefined;
    return this.ponyItemAssets ??= {
      terrain:this.materials.opaque.map, rows:this.atlasRows,
      itemSprite:key => {
        const items = this.world.models?.biblio?.items;
        const entry = items?.[key] ?? items?.[`${key.split(':', 1)[0]}:0`];
        const map = this.materials['biblio:cutout']?.map;
        return entry?.uv && map ? {uv:entry.uv, map} : null;
      },
    };
  }

  updateLocalAvatar(now, dt, position, pose, speed, seat, spectator) {
    this.localPonyFacing ??= createPonyFacing();
    const facing = this.localPonyFacing(position, pose.yaw, dt, seat?.yaw);
    if (!this.localAvatar) {
      this.localAvatar = createPonyAvatar(this.ponyAirAt);
      this.scene.add(this.localAvatar.object);
      this.localAvatar.setSkin(this.localSkin);
    }
    const firstPerson = this.perspective === 0;
    const {object} = this.localAvatar;
    this.spectating = spectator;
    this.localAvatar.setFirstPerson(firstPerson && !spectator);
    if (spectator) {
      return;
    }
    object.position.set(position.x, position.y, position.z);
    object.rotation.y = facing.bodyYaw;
    this.localAvatar.animate({time:now / 1000, dt, speed, pitch:pose.pitch, motion:pose.motion, stance:pose.stance, boost:pose.boost,
      yawOffset:facing.yawOffset, strideDirection:facing.strideDirection, position, swing:pose.swing, held:pose.held,
      itemAssets:this.heldItemAssets()});
    object.updateMatrixWorld(true);
  }

  inspectLocalAvatar() {
    if (!this.localAvatar) return null;
    const {object} = this.localAvatar;
    return {...this.localAvatar.inspect(), skin:this.localSkin, visible:object.visible,
      yaw:object.rotation.y, position:object.position.toArray()};
  }

  resize() {
    const {clientWidth: width, clientHeight: height} = this.container;
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  schedule(cx, cy, cz, edit = false) {
    if (cy < 0 || cy >= 16) return;
    const id = sectionKey(cx, cy, cz);
    const chunk = this.world.chunks.get(chunkKey(cx, cz));
    if (!chunk) return;
    const hasData = chunk?.sections.has(cy);
    if (!hasData && !edit && !this.groups.has(id)) return;
    const version = ++this.nextSectionVersion;
    if (edit) this.sectionVisibility.invalidate(id);
    this.versions.set(id, version);
    this.pending.set(id, {id, cx, cy, cz, version, type: 'precise', edit, visualOnly: chunk?.visualOnly});
  }

  addChunk(chunk) {
    this.heldLights.invalidate(chunk.x * 16 + 8,chunk.z * 16 + 8,8);
    this.frameChunksDirty = true;
    this.remeshLighting(this.world.updateLighting(chunk));
    const levels = new Set(chunk.sections.keys());
    const localFantasy = chunk.palette?.indexOf(CHISEL_FANTASY);
    const fantasy = this.chiselConnectedTextures ? (localFantasy ?? this.world.indices.get(CHISEL_FANTASY)) : undefined;
    for (const change of this.world.editsInChunk(chunk.x, chunk.z)) {
      levels.add(Math.floor(change.y / 16));
      if (this.chiselConnectedTextures && this.world.palette[change.index] === CHISEL_FANTASY) {
        this.remeshAdjacentSections(change.x, change.y, change.z);
      }
    }
    this.preciseLevels.set(chunkKey(chunk.x,chunk.z),levels);
    for (const cy of levels) {
      this.schedule(chunk.x, cy, chunk.z, !chunk.sections.has(cy));
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (dx || dz) this.schedule(chunk.x + dx, cy, chunk.z + dz);
      }
      const indices = chunk.sections.get(cy)?.indices;
      if (!indices || fantasy === undefined || fantasy < 0) continue;
      for (let index = indices.indexOf(fantasy); index >= 0; index = indices.indexOf(fantasy, index + 1)) {
        this.remeshAdjacentSections(chunk.x * 16 + (index & 15), cy * 16 + (index >> 8), chunk.z * 16 + (index >> 4 & 15));
      }
    }
    if (chunk.entities.length) {
      const group = new THREE.Group();
      for (const entity of chunk.entities) {
        const object = this.makeEntity(entity);
        if (!object) continue;
        if (isRideableMinecart(entity) || isRideableBoat(entity)) {
          object.userData.vehicleKey = entity.key;
          object.visible = !this.world.minecarts.has(entity.key) && !this.world.boats.has(entity.key);
          this.importedVehicles.set(entity.key,object);
        } else if (entity.type === 'ItemFrame') {
          object.userData.frameKey = entity.key;
          object.visible = !this.world.frames?.has(entity.key);
          this.importedFrames.set(entity.key,object);
        }
        group.add(object);
      }
      if (group.children.length) {
        const meshes = [];
        group.traverse(node => { if (node.isMesh) meshes.push(node); });
        this.chunkEntities.set(chunkKey(chunk.x, chunk.z), group);
        group.visible = this.isPreciseVisible(chunk.x,chunk.z);
        this.uploads.push({meshes, object:group, parent:chunk.visualOnly ? this.visualEntities : this.scene});
      }
    }
    this.updateChunkVisibility(chunk.x,chunk.z);
  }

  removeChunks(chunks) {
    this.frameChunksDirty = true;
    const removedEntities = new Set();
    for (const {x, z} of chunks) {
      this.heldLights.invalidate(x * 16 + 8,z * 16 + 8,8);
      const key = chunkKey(x, z);
      this.preciseLevels.delete(key);
      this.completedChunks.delete(key);
      this.exactChunks.delete(key);
      this.farTerrain?.chunkChanged(x,z);
      const entities = this.chunkEntities.get(key);
      if (entities) {
        removedEntities.add(entities);
        this.chunkEntities.delete(key);
        for (const object of entities.children) {
          this.importedVehicles.delete(object.userData.vehicleKey);
          this.importedFrames.delete(object.userData.frameKey);
        }
        this.discardGroup(entities);
      }
      for (let y = 0; y < 16; y++) {
        const id = sectionKey(x, y, z);
        this.sectionVisibility.invalidate(id);
        const group = this.groups.get(id);
        if (group) this.discardGroup(group);
        this.groups.delete(id);
        this.pending.delete(id);
        this.versions.delete(id);
        this.installedVersions.delete(id);
        this.visibleEdits.delete(id);
      }
    }
    this.uploads = this.uploads.filter(job => !removedEntities.has(job.object));
    // Rebuild rendered borders left behind by the eviction. Old in-flight
    // section results can't match the monotonic version of a reloaded chunk.
    const adjacent = new Set();
    for (const {x, z} of chunks) {
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        adjacent.add(chunkKey(x + dx, z + dz));
      }
    }
    for (const key of adjacent) {
      const chunk = this.world.chunks.get(key);
      if (!chunk) continue;
      for (const y of chunk.sections.keys()) this.schedule(chunk.x, y, chunk.z);
    }
  }

  streamAround(x, z, radius) {
    this.streamArea = {x, z, radius};
    if (this.farTerrain?.active) {
      this.farTerrain.move(x,z);
      for (const chunk of this.world.chunks.values()) this.updateChunkVisibility(chunk.x,chunk.z);
    }
  }

  get detailedDistance() {
    return this.requestedDistance === 24 || this.requestedDistance === 32 ? 4 : Math.min(this.requestedDistance,8);
  }

  isPreciseVisible(x,z) {
    if (!this.farTerrain?.active || !this.streamArea) return !this.world.chunks.get(chunkKey(x,z))?.visualOnly || this.requestedDistance > 4;
    if (!this.farTerrain.hasChunk(x,z)) return true;
    return this.exactChunks.has(chunkKey(x,z));
  }

  updateChunkVisibility(x,z) {
    const key = chunkKey(x,z);
    const levels = this.preciseLevels.get(key);
    if (!levels) return;
    let changed = false;
    if (this.farTerrain?.active && this.streamArea) {
      if (!this.completedChunks.has(key) && [...levels].every(y => this.installedVersions.has(sectionKey(x,y,z)))) {
        this.completedChunks.add(key);
      }
      const exact = Math.max(Math.abs(x-this.streamArea.x),Math.abs(z-this.streamArea.z)) <= this.detailedDistance &&
        this.completedChunks.has(key);
      if (exact !== this.exactChunks.has(key)) {
        if (exact) this.exactChunks.add(key);
        else this.exactChunks.delete(key);
        changed = true;
      }
    }
    const visible = this.isPreciseVisible(x,z);
    for (let y = 0; y < 16; y++) {
      const group = this.groups.get(sectionKey(x,y,z));
      if (!group) continue;
      group.userData.preciseVisible = visible;
      group.visible = visible;
      if (this.sectionVisibility.enabled) this.sectionVisibility.dirty = true;
    }
    const entities = this.chunkEntities.get(key);
    if (entities) entities.visible = visible;
    if (changed) this.farTerrain?.chunkChanged(x,z);
  }

  remeshLighting(sections) {
    for (const section of sections) {
      this.schedule(...section.split(',').map(Number));
      for (const {mesh, position} of this.entityLights.get(section)?.values() ?? []) {
        const light = mesh.geometry.attributes.legacyLightLevel;
        light.array.fill(this.world.lightAt(...position));
        light.needsUpdate = true;
      }
    }
  }

  remesh(x, y, z, revision) {
    this.rain?.invalidate(x,z);
    this.heldLights.invalidate(x,z);
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
          if (xx !== cx || yy !== cy || zz !== cz) this.schedule(xx, yy, zz, edit);
        }
      }
    }
  }

  get detailedLodDistance() {
    return this.farTerrain?.detailedDistance;
  }

  async setDetailedLodDistance(distance) {
    if (!this.farTerrain) throw new RangeError('Detailed LOD settings require distant terrain');
    this.farTerrain.setDetailedLodDistance(distance);
    if (this.requestedDistance !== 32) await this.setDistance(32);
    return this.detailedLodDistance;
  }

  async setDistance(distance) {
    if ((distance === 24 || distance === 32) && !(this.farTerrain?.lod.maxDistance >= distance)) return;
    this.requestedDistance = distance;
    this.farTerrain?.setDistance(distance);
    this.exactChunks.clear();
    if (this.farTerrain?.active && this.streamArea) this.farTerrain.move(this.streamArea.x,this.streamArea.z);
    this.visualEntities.visible = distance > 4;
    for (const [id, group] of this.groups) {
      if (id.startsWith('lod:')) group.visible = Number(id.split(':')[1]) <= distance;
    }
    for (const chunk of this.world.chunks.values()) this.updateChunkVisibility(chunk.x,chunk.z);
    for (const [id] of this.pending) {
      if (id.startsWith('lod:') && Number(id.split(':')[1]) > distance) this.pending.delete(id);
    }
    if (this.world.manifest.chunkPalettes) {
      const layered = distance >= 24 && this.farTerrain?.lod.maxDistance === 32;
      const vista = distance === 32 && this.farTerrain?.vista;
      this.scene.fog.near = vista ? 500 : distance === 32 ? 448 : distance === 4 ? 56 : layered ? 128 : distance * 14;
      this.scene.fog.far = vista ? VISTA_FOG_END : distance * 16;
      this.camera.far = vista ? VISTA_FOG_END + 280 : 850;
      this.camera.updateProjectionMatrix();
    } else {
      this.scene.fog.near = distance === 4 ? 60 : distance * 8;
      this.scene.fog.far = Math.max(115, distance * 22);
    }
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

  setOcclusion(enabled) {
    const visibility = this.sectionVisibility;
    if (!visibility.setEnabled(enabled) || !enabled) return;
    for (const chunk of this.world.chunks.values()) {
      const levels = this.preciseLevels.get(chunkKey(chunk.x,chunk.z)) ?? chunk.sections.keys();
      for (const y of levels) {
        const id = sectionKey(chunk.x,y,chunk.z);
        if (!this.pending.has(id)) this.schedule(chunk.x,y,chunk.z);
      }
    }
  }

  updateOcclusion(now) {
    const visibility = this.sectionVisibility;
    if (!visibility.update(this.camera.position,this.streamArea?.radius ?? this.detailedDistance + 1,now)) return;
    visibility.culled = 0;
    visibility.total = 0;
    for (const [id,group] of this.groups) {
      if (id.startsWith('lod:')) continue;
      const {preciseVisible,fitForOcclusion,sectionCoords,visualOnly} = group.userData;
      const visible = preciseVisible ?? (!visualOnly || this.requestedDistance > 4);
      const seen = !visibility.enabled || !fitForOcclusion || visibility.visible(...sectionCoords);
      group.visible = visible && seen;
      if (!visible) continue;
      visibility.total++;
      if (!seen) visibility.culled++;
    }
  }

  paintingMaterial(map) {
    const material = new THREE.MeshBasicMaterial({map, vertexColors:true, side:THREE.DoubleSide});
    this.useLightmap(material);
    return material;
  }

  makeEntity(entity) {
    if (entity.type === 'ItemFrame') return this.makeItemFrame(entity);
    if (isRideableMinecart(entity)) return this.makeMinecart(entity);
    if (isRideableBoat(entity)) return this.makeBoat(entity);
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
    mesh.userData.painting = true;
    this.trackEntityLight(mesh, position);
    mesh.position.set(...entity.position);
    mesh.rotation.y = [0, Math.PI / 2, Math.PI, -Math.PI / 2][dir & 3];
    return mesh;
  }

  makeMinecart(entity) {
    if (!this.minecartTexture) {
      const url = '/generated/textures/minecart.png';
      this.minecartTexture = fetch(url).then(response => response.ok ? response.blob() : null).then(async blob => {
        if (!blob) return;
        const bitmap = await createImageBitmap(blob,{imageOrientation:'flipY'});
        const map = new THREE.Texture(bitmap);
        map.colorSpace = THREE.SRGBColorSpace;
        map.magFilter = map.minFilter = THREE.NearestFilter;
        map.generateMipmaps = false;
        map.wrapS = THREE.RepeatWrapping;
        map.needsUpdate = true;
        this.minecartMaterial.map = map;
        this.minecartMaterial.color.set('white');
        this.minecartMaterial.needsUpdate = true;
      }).catch(() => {});
    }
    const position = entity.position.map(Math.floor);
    const light = this.world.lightAt(...position);
    const mesh = new THREE.Mesh(quadGeometry(minecartQuads,light,255),this.minecartMaterial);
    mesh.position.set(...entity.position);
    mesh.rotation.set(0,minecartRotation(entity),minecartTilt(entity),'YXZ');
    this.trackEntityLight(mesh,position);
    return mesh;
  }

  makeBoat(entity) {
    const position = entity.position.map(Math.floor);
    const geometry = quadGeometry(this.boatQuads,this.world.lightAt(...position),255);
    const mesh = new THREE.Mesh(geometry,this.materials.boat ?? this.materials.opaque);
    mesh.position.set(...entity.position);
    mesh.rotation.y = boatHeading(entity);
    this.trackEntityLight(mesh,position);
    return mesh;
  }

  updateVehicles() {
    const {minecarts,boats} = this.world;
    for (const [key,mesh] of this.importedVehicles) mesh.visible = !minecarts.has(key) && !boats.has(key);
    const visible = new Set();
    for (const {entity} of [...minecarts.values(),...boats.values()]) {
      const [x,y,z] = entity.position.map(Math.floor);
      if (!this.world.chunks.has(chunkKey(x >> 4,z >> 4)) || !this.isPreciseVisible(x >> 4,z >> 4)) continue;
      visible.add(entity.key);
      let mesh = this.movingVehicles.get(entity.key);
      if (!mesh) {
        mesh = this.makeEntity(entity);
        this.movingVehicles.set(entity.key,mesh);
        this.scene.add(mesh);
      }
      const previous = this.entityLights.get(mesh.userData.lightSection)?.get(mesh)?.position;
      if (!previous || previous[0] !== x || previous[1] !== y || previous[2] !== z) {
        const lights = this.entityLights.get(mesh.userData.lightSection);
        lights?.delete(mesh);
        if (lights?.size === 0) this.entityLights.delete(mesh.userData.lightSection);
        this.trackEntityLight(mesh,[x,y,z]);
        const light = mesh.geometry.getAttribute('legacyLightLevel');
        light.array.fill(this.world.lightAt(x,y,z));
        light.needsUpdate = true;
      }
      mesh.position.set(...entity.position);
      if (isRideableBoat(entity)) mesh.rotation.y = boatHeading(entity);
      else mesh.rotation.set(0,minecartRotation(entity),minecartTilt(entity),'YXZ');
      mesh.updateMatrixWorld();
    }
    for (const [key,mesh] of this.movingVehicles) {
      if (visible.has(key)) continue;
      this.discardGroup(mesh);
      this.movingVehicles.delete(key);
    }
  }

  makeItemFrame(entity) {
    const model = itemFrameModel(entity,this.world.models.biblio?.items,this.atlasRows);
    if (!model) return;
    const group = new THREE.Group();
    group.position.set(...model.center);
    group.rotation.set(model.rotationX,model.rotationY,0,'YXZ');
    const position = entity.position.map(Math.floor);
    const light = this.world.lightAt(...position);
    const material = model.terrainItem ? this.materials.cutout : this.materials['biblio:cutout'];
    for (const [quads, surface, shade] of [[model.frame,this.materials.opaque,216],[model.item,material,255]]) {
      if (!quads?.length || !surface) continue;
      const mesh = new THREE.Mesh(quadGeometry(quads,light,shade),surface);
      group.add(mesh);
      this.trackEntityLight(mesh, position);
    }
    if (group.children.length) return group;
  }

  updateFrames() {
    const frames = this.world.frames;
    if (!frames || frames === this.frameSnapshot && !this.frameChunksDirty) return;
    this.frameSnapshot = frames;
    this.frameChunksDirty = false;
    for (const [key,original] of this.importedFrames) original.visible = !frames.has(key);
    for (const [key,group] of this.editedFrames) {
      const frame = frames.get(key);
      if (frame?.revision === group.userData.frameRevision && this.world.hasChunk(frame.position[0],frame.position[2])) continue;
      this.discardGroup(group);
      this.editedFrames.delete(key);
    }
    for (const [key,frame] of frames) {
      if (this.editedFrames.has(key) || !this.world.hasChunk(frame.position[0],frame.position[2])) continue;
      const group = this.makeItemFrame(frame);
      if (!group) continue;
      group.userData.frameRevision = frame.revision;
      this.editedFrames.set(key,group);
      this.scene.add(group);
      group.updateMatrixWorld(true);
    }
  }

  breakBlock(effect) {
    this.blockDebris ??= new BlockDebris(this.scene,this.world);
    this.blockDebris.add(effect,this.materials?.cutout,this.atlasRows,performance.now());
  }

  groundDust(feet,body,motion,fall,now) {
    const {x,y,z} = this.camera.position;
    if (Math.hypot(feet.x-x,feet.y-y,feet.z-z)>24) return;
    const contact = groundSurface(this.world,feet,body);
    if (!contact) return;
    this.blockDebris ??= new BlockDebris(this.scene,this.world);
    this.blockDebris.ground(feet,contact,motion,fall,this.materials?.cutout,this.atlasRows,now);
  }

  dispense({position,direction,stack}) {
    if (!this.world.hasChunk(position[0],position[2]) || this.dispenserItems.length >= 48) return;
    const model = itemFrameModel({data:{TileX:0,TileY:0,TileZ:0,MountSide:3,Item:stack}},
      this.world.models.biblio?.items,this.atlasRows);
    const material = model?.terrainItem ? this.materials.cutout : this.materials['biblio:cutout'];
    if (!model?.item.length || !material) return;
    const mesh = new THREE.Mesh(quadGeometry(model.item,this.world.lightAt(...position),255),material);
    const start = position.map((value,index) => value + .5 + .55 * direction[index]);
    const speed = stack.id === 262 ? 5 : 2.1;
    const velocity = direction.map((value,index) => value * speed + (index === 1 ? 1.25 : 0));
    mesh.position.set(...start);
    mesh.rotation.y = Math.atan2(direction[0],direction[2]);
    this.scene.add(mesh);
    mesh.updateMatrixWorld();
    this.dispenserItems.push({mesh,start,velocity,time:performance.now()});
  }

  updateDispensers(now) {
    if (!this.dispenserItems.length) return;
    this.dispenserItems = this.dispenserItems.filter(({mesh,start,velocity,time}) => {
      const elapsed = (now - time) / 1000;
      if (elapsed > .75) {
        this.discardGroup(mesh);
        return false;
      }
      mesh.position.set(start[0] + velocity[0] * elapsed,
        start[1] + velocity[1] * elapsed - 2 * elapsed ** 2,start[2] + velocity[2] * elapsed);
      mesh.rotation.y += .1;
      mesh.updateMatrixWorld();
      return true;
    });
  }

  trackEntityLight(mesh, position) {
    const id = sectionKey(...position.map(value => value >> 4));
    if (!this.entityLights.has(id)) this.entityLights.set(id, new Map());
    this.entityLights.get(id).set(mesh, {mesh, position});
    mesh.userData.lightSection = id;
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
      group.userData.sectionCoords = coords;
      group.userData.fitForOcclusion = result.fitsSection === true;
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
      result:{id:result.id, version:result.version, elapsed:result.elapsed,
        visibility:result.visibility, visibilityClassified:result.visibilityClassified}});
  }

  discardGroup(group) {
    group.removeFromParent();
    group.traverse(mesh => {
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      if (mesh.userData.sign || mesh.userData.painting) {
        mesh.material.map.dispose();
        mesh.material.dispose();
      }
      if (mesh.userData.lightSection) {
        const lights = this.entityLights.get(mesh.userData.lightSection);
        lights?.delete(mesh);
        if (lights?.size === 0) this.entityLights.delete(mesh.userData.lightSection);
      }
    });
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
    if (!id.startsWith('lod:')) {
      if (result.visibilityClassified) this.sectionVisibility.install(id,result.visibility);
      if (this.sectionVisibility.enabled) this.sectionVisibility.dirty = true;
      const [x,,z] = id.split(',').map(Number);
      this.updateChunkVisibility(x,z);
    }
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
        if (job.result && this.versions.get(job.result.id) !== job.result.version || job.far && !this.farTerrain.isQueued(job.far)) {
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
        if (job.far) staging.onBeforeRender = mesh.onBeforeRender;
        staged.push({data, ...data.drawRange});
        data.setDrawRange(0, 0);
        this.uploadScene.add(staging);
        const map = mesh.material.map;
        if (map && (mesh.userData.sign || !job.result && !job.far)) this.renderer.initTexture(map);
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
    for (const job of finished) {
      this.install(job);
      if (job.far) this.farTerrain.install(job.far);
    }
  }

  neighborsLoaded({cx, cz}) {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const key = chunkKey(cx + dx, cz + dz);
      const area = this.streamArea;
      if (area && Math.max(Math.abs(cx + dx - area.x), Math.abs(cz + dz - area.z)) > area.radius) continue;
      if (this.expectedChunks.has(key) && !this.world.chunks.has(key)) return false;
    }
    return true;
  }

  streamSettled() {
    return !this.workerFailure && this.pendingWork === 0;
  }

  async waitForStreamSlot(near) {
    const budget = near ? 40 : 16;
    while (!this.workerFailure) {
      const queued = this.active.size + this.ready.length + this.uploads.length;
      if (this.streamArea) {
        // Keep the nearby window fed as workers build the already available
        // sections. Restrict actual upload backlog, independent of camera turns.
        if (queued < budget) break;
      } else {
        let ready = queued;
        for (const job of this.pending.values()) {
          if (job.type !== 'precise' || this.neighborsLoaded(job)) ready++;
          if (ready >= budget) break;
        }
        // A queue waiting for neighbor data can only progress if fetching resumes.
        if (ready < budget && (ready === 0 || near || performance.now() >= this.nextBackgroundUpload)) break;
      }
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
        const known = this.workerCatalogs.get(worker);
        let paletteAppend;
        if (!halo.palette && this.world.palette.length > known) {
          paletteAppend = this.world.palette.slice(known);
          this.workerCatalogs.set(worker, this.world.palette.length);
        }
        worker.postMessage({id: job.id, type: job.type, version: job.version, paletteAppend,
          collectVisibility:this.sectionVisibility.enabled,
          atlasRows: this.atlasRows, connectedTextures: this.connectedTextures,
          chiselConnectedTextures: this.chiselConnectedTextures, carpentryModel: this.carpentryModel, ...halo},
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
          atlasRows: this.atlasRows, chunks, stride: job.stride, origin: [job.cx * 16, 0, job.cz * 16]});
      }
    }
  }

  render(now, selection, playing = false, placement = null, foreground = true) {
    this.updateFrames();
    this.updateDispensers(now);
    this.blockDebris?.update(now,this.camera);
    if (now >= (this.nextSkyUpdate ?? 0)) {
      this.updateSky(this.dayTick(now));
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
    this.farTerrain?.step(now,stream);
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
    if (this.perspective === 2) {
      selection = null;
      placement = null;
    }
    const detail = selection?.voxel !== undefined ? `voxel:${selection.voxel}:${selection.chiselSize ?? 1}` : selection?.partSlot;
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
      if (placement.surfaces) drawModelPreview(this.partPreview, placement);
      else drawPart(this.partPreview, placement, boxTriangles);
      this.drawnPlacement = placement;
    }
    if (placement && this.previewBlocked !== placement.blocked) {
      this.partPreview.material.color.set(placement.blocked ? '#ed7779' : '#79f0ba');
      this.previewBlocked = placement.blocked;
    }
    // Inactive tabs keep receiving player and world updates while limiting GPU work.
    if (foreground || now >= (this.nextIdleRender ?? 0)) {
      if (this.fireTexture) this.fireTexture.offset.y = (Math.floor(now / FIRE_STEP_MS) % FIRE_FRAMES) / FIRE_FRAMES;
      this.sky.position.copy(this.camera.position);
      this.sky.updateMatrixWorld();
      this.sky.material.uniforms.windTime.value = now * .001;
      const ponies = [...this.players.entries.values()];
      if (this.localAvatar) ponies.push({object:this.localAvatar.object, avatar:this.localAvatar});
      this.heldLights.update(ponies, this.camera.position, this.spectating ? null : this.localAvatar);
      if (this.weather === 'rain') {
        this.rain ??= new Rain(this.scene,this.world);
        const {x,y,z}=this.camera.position;
        const bx=Math.floor(x), by=Math.floor(y), bz=Math.floor(z);
        const packed=this.world.lightAt(bx,by,bz);
        const nearby=this.heldLights.levelAt(bx,by,bz);
        const offset=4*((packed&240)|Math.max(packed&15,nearby));
        const brightness=Math.max(.07,.2+this.lastSun*.58,this.lightBytes[offset]/255);
        this.visibleRain=this.rain.step(now,this.camera.position,brightness);
      }
      for (const {object,avatar} of ponies) {
        if (!object.visible && avatar !== this.localAvatar) continue;
        const {x,y,z} = object.position;
        const xx = Math.floor(x), yy = Math.floor(y + .85), zz = Math.floor(z);
        const packed = this.world.lightAt(xx,yy,zz);
        const offset = 4 * ((packed & 240) | Math.max(packed & 15,this.heldLights.levelAt(xx,yy,zz)));
        avatar.setLight(this.lightBytes[offset] << 16 | this.lightBytes[offset + 1] << 8 | this.lightBytes[offset + 2]);
      }
      this.ponyShadows.update(ponies.map(pony => pony.object), this.camera.position);
      this.droppedItemView ??= new DroppedItemView(this.scene,this.world);
      this.droppedItemView.update(now,this.camera.position,this.heldItemAssets(),(x,y,z) => {
        const offset = 4 * this.world.lightAt(Math.floor(x),Math.floor(y),Math.floor(z));
        return this.lightBytes[offset] << 16 | this.lightBytes[offset + 1] << 8 | this.lightBytes[offset + 2];
      },(x,z) => this.isPreciseVisible(x,z));
      this.updateOcclusion(now);
      this.renderer.render(this.scene, this.camera);
      this.nextIdleRender = now + 100;
    }
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
      occlusion:this.sectionVisibility.statistics(), heldLights:this.heldLights.statistics(),
      preciseBytes, coarseBytes, preciseTriangles, coarseTriangles, farTerrain:this.farTerrain?.stats(),
      pending: this.pendingWork, weather:this.weather, nightVision:this.nightVision, rainDrops:this.visibleRain ?? 0,
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
      sunDirection: {value: new THREE.Vector3(0, 1, 0)},
      cloudOffset: {value: new THREE.Vector2()},
      night: {value: 0},
      cloudy: {value: 0},
      windTime: {value: 0},
      sunColor: {value: new THREE.Color('#fff7cf')},
      moonColor: {value: new THREE.Color('#dce8f9')},
    },
    vertexShader: /* glsl */ `
      varying vec3 skyDirection;
      void main() {
        skyDirection = position;
        vec4 projected = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = projected.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 zenith;
      uniform vec3 horizon;
      uniform vec3 sunDirection;
      uniform vec2 cloudOffset;
      uniform vec3 sunColor;
      uniform vec3 moonColor;
      uniform float night;
      uniform float cloudy;
      uniform float windTime;
      varying vec3 skyDirection;
      float hash(vec2 cell) {
        return fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 cell = floor(p), f = fract(p);
        vec2 blend = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(cell), hash(cell + vec2(1, 0)), blend.x),
          mix(hash(cell + vec2(0, 1)), hash(cell + vec2(1, 1)), blend.x), blend.y);
      }
      float clouds(vec2 p) {
        return .57 * noise(p) + .28 * noise(p * 2.03 + 11.7) + .15 * noise(p * 4.11 + 23.4);
      }
      float disk(float distanceToCenter, float radius) {
        float edge = max(fwidth(distanceToCenter), .0003);
        return 1.0 - smoothstep(radius - edge, radius + edge, distanceToCenter);
      }
      void main() {
        vec3 ray = normalize(skyDirection);
        float mixAmount = 1.0 - exp(-max(ray.y, 0.0) * 8.0);
        vec3 skyColor = mix(horizon, zenith, mixAmount);
        if (cloudy > .5) {
          vec2 p = ray.xz / (max(ray.y,0.0) + .24);
          float upper = clouds(p*1.9 + vec2(windTime*.023,windTime*.008));
          float lower = clouds(p*3.1 + vec2(8.7+windTime*.052,3.7+windTime*.019));
          float shoulders = smoothstep(.34,.70,upper);
          float distinct = smoothstep(.41,.53,lower);
          vec3 darkCloud = vec3(.12,.145,.175);
          vec3 highCloud = mix(vec3(.20,.235,.27),vec3(.33,.365,.39),shoulders);
          vec3 deck = mix(highCloud,darkCloud + vec3(.08)*smoothstep(.48,.72,lower),distinct);
          float light = mix(.022,1.0,1.0-night);
          skyColor = mix(horizon,deck*light,smoothstep(-.01,.17,ray.y));
          gl_FragColor = vec4(skyColor,1.0);
          #include <colorspace_fragment>
          return;
        }
        if (night > .01 && ray.y > 0.0) {
          vec2 uv = vec2(atan(ray.z, ray.x) * (128.0 / 6.2831853), asin(ray.y) * 24.0);
          vec2 cell = floor(uv);
          cell.x = mod(cell.x, 128.0);
          float seed = hash(cell);
          vec2 center = .24 + .52 * vec2(seed, hash(cell + 17.0));
          vec2 delta = (fract(uv) - center) * vec2(1.18 * max(length(ray.xz), .45), 1.0);
          float polarFade = smoothstep(.08, .36, length(ray.xz));
          float star = 1.0 - smoothstep(.025, .046 + .026 * seed, length(delta));
          skyColor += moonColor * night * smoothstep(0.0, .17, ray.y) * polarFade * step(.82, seed) * star * seed;
        }
        float horizonMask = smoothstep(-.02, .015, ray.y);
        float sun = length(ray - sunDirection);
        float moon = length(ray + sunDirection);
        skyColor = mix(skyColor, sunColor, horizonMask * (.18 * exp(-34.0 * sun) + .8 * disk(sun, .032)));
        skyColor = mix(skyColor, moonColor, horizonMask * (.11 * exp(-38.0 * moon) + .87 * disk(moon, .026)));
        if (sunDirection.y > 0.0 && ray.y > .06) {
          vec2 p = ray.xz / (ray.y + .27) * 3.2 + cloudOffset + vec2(7.8, 5.1);
          float field = clouds(p * vec2(.8, 1.15));
          float alpha = smoothstep(.53, .67, field) * smoothstep(.06, .24, ray.y) * smoothstep(0.0, .2, sunDirection.y);
          float diffuse = min(1.0, smoothstep(.54, .76, field) + .18 * exp(-4.0 * sun));
          vec3 cloudColor = mix(vec3(.66, .73, .82), vec3(.99, .96, .91), diffuse);
          skyColor = mix(skyColor, cloudColor, min(.88, alpha));
        }
        gl_FragColor = vec4(skyColor, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(660, 24, 12), material);
  mesh.renderOrder = 1000;
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
