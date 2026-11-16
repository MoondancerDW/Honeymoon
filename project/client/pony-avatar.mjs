import * as THREE from '/vendor/three/three.module.js';
import {ponyModels} from '../world/pony-model-data.mjs';
import {defaultPonyPixels, ponySkinHeight, readPonySkin} from '../world/pony-skins.mjs';
import {createPonyHeldItem, magicMaterial} from './pony-held-item.mjs';
import {createPonyArmor} from './pony-armor.mjs';
import {heldLightLevel} from '../world/held-light.mjs';

const LEG_NAMES = ['frontRight', 'frontLeft', 'hindRight', 'hindLeft'];
const TAU = Math.PI * 2;
const seatedLegAngles = [-.4, -.4, 4.712 - TAU, 4.712 - TAU];
const flightLegYaw = [.2, -.2, -.2, .2];
const proneHeights = {
  small: {head:.23, neck:.3, leg:.11, tail:.19},
  normal: {head:.36, neck:.46, leg:.16, tail:.27},
  large: {head:.48, neck:.59, leg:.21, tail:.34},
  tall: {head:.48, neck:.59, leg:.21, tail:.34},
};
const headTurnLimit = 75 * Math.PI / 180;
const geometryCache = new Map();
const imageLoader = new THREE.ImageLoader();
const defaultPixels = defaultPonyPixels();
const defaultSkin = readPonySkin(defaultPixels, 64, 32);
const defaultTexture = setupTexture(new THREE.DataTexture(defaultPixels, 64, 32));

// Container transforms from Mine Little Pony's normal, foal, large and tall render paths.
const renderScales = {
  normal: {
    female: [[0.2475, 0, 0.9, 0.9, 0.9], [0.25, 0.002, 0.78, 1, 0.78],
      [0.3, 0, 0.8, 0.8, 0.8], [0.25, -0.1, 0.92, 0.92, 0.92], [0.3, 0, 0.8, 0.8, 0.8]],
    male: [[0.2025, 0, 0.9, 0.9, 0.9], [0.25, 0.0005, 0.845, 1.1, 0.845],
      [0.22, 0, 0.85, 0.85, 0.85], [0.23, 0, 0.85, 0.85, 0.85], [0.22, 0, 0.85, 0.85, 0.85]],
  },
  small: [[0.7, 0, 0.8, 0.8, 0.8], [0.7, 0, 0.8, 0.8, 0.8],
    [0.76, -0.04, 0.6, 0.6, 0.6], [0.76, -0.04, 0.6, 0.6, 0.6], [0.89, 0, 0.6, 0.41, 0.6]],
  large: [[0.04, 0, 1, 1, 1], [-0.1, -0.05, 1.05, 1.3, 1.05],
    [0, -0.04, 1.05, 1.05, 1.05], [0, 0.08, 1, 1, 1], [0, 0, 1.1, 1.05, 1.05]],
  tall: [[-0.15, 0.01, 1, 1, 1], [-0.1, -0.015, 0.9, 1.1, 0.9],
    [-0.1, 0, 1, 1, 1], [-0.1, 0, 1, 1, 1], [-0.25, 0.03, 1, 1.18, 1]],
};

function setupTexture(texture) {
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapLinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

async function loadSkin(url) {
  const image = await imageLoader.loadAsync(url);
  const width = image.naturalWidth, height = image.naturalHeight;
  const skinHeight = ponySkinHeight(width, height);
  if (skinHeight === 0) throw new RangeError('Invalid pony skin dimensions');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = skinHeight;
  const context = canvas.getContext('2d', {willReadFrequently: true, colorSpace: 'srgb'});
  context.drawImage(image, 0, 0);
  const {data} = context.getImageData(0, 0, width, skinHeight);
  return {skin: readPonySkin(data, width, height), texture: setupTexture(new THREE.CanvasTexture(canvas))};
}

function groupParts(parts, names) {
  const prefixes = new Set(names);
  return Object.keys(parts).filter(name => prefixes.has(name.split('.')[0]) || prefixes.has(name));
}

const angleBetween = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

export function createPonyFacing() {
  let bodyYaw, previousX, previousZ, strideDirection = 1;
  return ({x, z}, lookYaw, dt, seatYaw, motion) => {
    const dx = x - (previousX ?? x), dz = z - (previousZ ?? z);
    previousX = x;
    previousZ = z;
    const travel = Math.hypot(dx, dz);
    let strafe = 0;
    if (seatYaw !== undefined || bodyYaw === undefined || travel > 1) {
      bodyYaw = seatYaw ?? lookYaw;
      strideDirection = 1;
    } else if (motion === 'fly' || motion === 'swim') {
      bodyYaw += angleBetween(bodyYaw, lookYaw) * (1 - Math.exp(-dt * 22));
      strideDirection = 1;
      if (dt > 0) strafe = (dx * Math.cos(lookYaw) - dz * Math.sin(lookYaw)) / dt;
    } else {
      const ticks = dt * 20;
      if (travel > .001) {
        const travelYaw = Math.atan2(-dx, -dz);
        strideDirection = Math.abs(angleBetween(lookYaw, travelYaw)) > Math.PI / 2 ? -1 : 1;
        const facing = strideDirection < 0 ? travelYaw + Math.PI : travelYaw;
        bodyYaw += angleBetween(bodyYaw, facing) * (1 - .7 ** ticks);
      }
      const turn = angleBetween(bodyYaw, lookYaw);
      const limited = THREE.MathUtils.clamp(turn, -headTurnLimit, headTurnLimit);
      bodyYaw += turn - limited;
      if (Math.abs(limited) > 50 * Math.PI / 180) bodyYaw += limited * (1 - .8 ** ticks);
    }
    return {bodyYaw, yawOffset:angleBetween(bodyYaw, lookYaw), strideDirection, strafe};
  };
}

function depthLayer(name) {
  if (name === 'body.4' || /^hip(?:Left|Right)\.3$|^hipRight\.1[01]$/.test(name)) return 2;
  return Number(name.startsWith('body.') || name.startsWith('maneRight'));
}

// Bake the native parts sharing a pivot into one geometry. A standard pony needs
// only head, neck, body, hips, four legs and tail draw calls.
function geometryFor(model, names, position, rotation = [0, 0, 0], hornScale = 1) {
  const key = JSON.stringify([model, names, position, rotation, hornScale]);
  if (geometryCache.has(key)) return geometryCache.get(key);
  const parts = ponyModels[model];
  const positions = [], colors = [], uvs = [], uvBounds = [], layers = [[], [], []], seen = new Set();
  const straightLeg = names.some(name => /^hind(?:Left|Right)\.joint$/.test(name)) ? [] : null;
  const vertex = new THREE.Vector3(), normal = new THREE.Vector3();
  const edgeA = new THREE.Vector3(), edgeB = new THREE.Vector3();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const euler = new THREE.Euler(0, 0, 0, 'ZYX');
  for (const name of names) {
    const [[x, y, z, rx, ry, rz], quads] = parts[name];
    euler.set(rx - rotation[0], ry - rotation[1], rz - rotation[2], 'ZYX');
    for (let i = 0; i < quads.length; i += 20) {
      const face = quads.slice(i, i + 20);
      // The ear bases are entirely inside the head's top face.
      if (/^headpiece\.[01]$/.test(name) && [1, 6, 11, 16].every(index => face[index] === -5)) continue;
      const corners = [0, 5, 10, 15].map(index => face.slice(index, index + 5).join(',')).sort();
      const faceKey = [x, y, z, rx, ry, rz, ...corners].join(',');
      if (seen.has(faceKey)) continue;
      seen.add(faceKey);
      const base = positions.length / 3;
      normal.fromArray(face);
      a.fromArray(face, 5);
      b.fromArray(face, 10);
      c.fromArray(face, 15);
      edgeA.subVectors(a, normal);
      edgeB.subVectors(b, normal);
      edgeA.cross(edgeB);
      if (edgeA.lengthSq() < 1e-9) {
        edgeA.subVectors(b, normal).cross(edgeB.subVectors(c, normal));
        if (edgeA.lengthSq() < 1e-9) continue;
      }
      edgeA.normalize().applyEuler(euler);
      const shade = 0.82 + 0.12 * Math.abs(edgeA.y) - 0.12 * Math.max(edgeA.y, 0)
        + 0.05 * Math.abs(edgeA.z);
      const u = [face[3], face[8], face[13], face[18]];
      const v = [face[4], face[9], face[14], face[19]];
      const bounds = [Math.min(...u), Math.min(...v), Math.max(...u), Math.max(...v)];
      for (let j = 0; j < 20; j += 5) {
        vertex.fromArray(face, j).applyEuler(euler);
        if (/^headpiece\.[01]$/.test(name) && vertex.y === -5) vertex.y += .035;
        if (name.startsWith('muzzle') && vertex.z === -6) vertex.z += .025;
        if (name === 'maneRight.2') vertex.x += .2;
        vertex.add(a.set(x - position[0], y - position[1], z - position[2]));
        if (name === 'headpiece.2') vertex.y *= hornScale;
        positions.push(vertex.x / 16, vertex.y / 16, vertex.z / 16);
        if (straightLeg) {
          // Align the hock segment to the lower leg and close the offset caps while prone.
          const shift = name.endsWith('.joint') ? 1 : name.endsWith('.0') ? -1 - face[j + 2] :
            name.endsWith('.1') ? 3 - face[j + 2] : 0;
          straightLeg.push(0, 0, shift / 16);
        }
        colors.push(shade, shade, shade);
        uvs.push(face[j + 3], face[j + 4]);
        uvBounds.push(...bounds);
      }
      layers[depthLayer(name)].push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('skinUvBounds', new THREE.Float32BufferAttribute(uvBounds, 4));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  if (straightLeg) {
    geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(straightLeg, 3)];
    geometry.morphTargetsRelative = true;
  }
  geometry.setIndex(layers.flat());
  let start = 0;
  for (let layer = 0; layer < layers.length; layer++) {
    const count = layers[layer].length;
    if (count) geometry.addGroup(start, count, layer);
    start += count;
  }
  geometry.computeBoundingSphere();
  geometryCache.set(key, geometry);
  return geometry;
}

function sampleSkinFaces(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec4 skinUvBounds;\nflat varying vec4 vSkinUvBounds;')
    .replace('#include <uv_vertex>', '#include <uv_vertex>\nvSkinUvBounds = skinUvBounds;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nflat varying vec4 vSkinUvBounds;')
    .replace('#include <map_fragment>', `
      #ifdef USE_MAP
        // The legacy atlas puts unrelated transparent and opaque faces side by side.
        // Stay within the current face at both mip levels used by the sample.
        vec2 sizeAtBase = vec2(textureSize(map, 0));
        vec2 uvDx = dFdx(vMapUv) * sizeAtBase;
        vec2 uvDy = dFdy(vMapUv) * sizeAtBase;
        vec2 span = (vSkinUvBounds.zw - vSkinUvBounds.xy) * sizeAtBase;
        float maxLod = max(0.0, floor(log2(max(1.0, min(span.x, span.y)))) - 1.0);
        float lod = clamp(log2(max(1.0, max(length(uvDx), length(uvDy)))), 0.0, maxLod);
        vec2 mipSize = vec2(textureSize(map, int(ceil(lod))));
        vec2 center = (vSkinUvBounds.xy + vSkinUvBounds.zw) * 0.5;
        vec2 low = min(center, (ceil(vSkinUvBounds.xy * mipSize) + 0.5) / mipSize);
        vec2 high = max(center, (floor(vSkinUvBounds.zw * mipSize) - 0.5) / mipSize);
        diffuseColor *= textureLod(map, clamp(vMapUv, low, high), lod);
      #endif
    `);
}

function renderGroup(parent, [y, z, sx, sy, sz]) {
  const group = new THREE.Group();
  group.position.set(0, y, z);
  group.scale.set(sx, sy, sz);
  parent.add(group);
  return group;
}

function buildRig(visual, materials, skin) {
  const model = skin.advanced ? 'advanced' : 'basic';
  const parts = ponyModels[model];
  const scales = skin.size === 'normal' ? renderScales.normal[skin.male ? 'male' : 'female'] : renderScales[skin.size];
  const [headGroup, neckGroup, bodyGroup, tailGroup, legGroup] = scales.map(scale => renderGroup(visual, scale));
  const hasWings = skin.ponyType === 'pegasus' || skin.ponyType === 'alicorn';
  const hasHorn = skin.ponyType === 'unicorn' || skin.ponyType === 'alicorn';
  const pivot = [0, 0, 0];
  let meshes = 0;
  function attach(parent, names, pose = pivot, rotation, hornScale) {
    const geometry = geometryFor(model, names, pose.slice(0, 3), rotation, hornScale);
    const groups = geometry.groups;
    const mesh = new THREE.Mesh(geometry, groups.length === 1 ? materials[groups[0].materialIndex] : materials);
    mesh.position.set(pose[0] / 16, pose[1] / 16, pose[2] / 16);
    mesh.rotation.order = 'ZYX';
    if (rotation) mesh.rotation.set(...rotation);
    parent.add(mesh);
    meshes++;
    return mesh;
  }

  const headNames = ['head', 'mane.2', skin.male ? 'muzzleMale' : 'muzzleFemale',
    'headpiece.0', 'headpiece.1'];
  const hornScale = skin.size === 'large' ? 1.05 : skin.size === 'tall' ? 1.2 : 1;
  const head = attach(headGroup, groupParts(parts, headNames));
  const eyes = new THREE.Object3D();
  eyes.position.set(0, -2 / 16, -5.8 / 16);
  head.add(eyes);
  const horn = hasHorn ? attach(head, ['headpiece.2'], pivot, undefined, hornScale) : null;
  const maneNames = skin.mane === 1 ? ['mohawk'] : skin.mane === 2 ? ['maneLeft.2'] :
    skin.mane === 3 ? ['maneRight.2'] : skin.mane === 4 ? ['maneLeft.2', 'maneRight.2'] : [];
  const maneParts = groupParts(parts, maneNames);
  const mane = maneParts.length ? attach(head, maneParts) : null;
  const neck = attach(neckGroup, groupParts(parts, ['neck']));
  const body = attach(bodyGroup, groupParts(parts, ['body']));
  const hips = ['hipRight', 'hipLeft'].map(name => attach(bodyGroup, groupParts(parts, [name])));
  const legs = LEG_NAMES.map(name => attach(legGroup, groupParts(parts, [name]), parts[name][0]));
  const tailCount = 21 - skin.tail * 5;
  const tail = tailCount > 1
    ? attach(tailGroup, groupParts(parts, ['tail']).filter(name => Number(name.split('.')[1]) < tailCount),
      parts['tail.0'][0]) : null;
  const foldedWings = [], openWings = [];
  if (hasWings) {
    for (const side of ['Left', 'Right']) {
      const name = 'wing' + side;
      foldedWings.push(attach(bodyGroup, groupParts(parts, [name]), parts[name + '.0'][0]));
      const open = name + 'Open';
      const pose = parts[open + '.0'][0], rotation = [0, 0, pose[5]];
      openWings.push(attach(bodyGroup, groupParts(parts, [open]), pose, rotation));
      openWings.at(-1).visible = false;
    }
  }
  // Ground the rendered hooves for each native body scale.
  visual.position.y = legGroup.position.y + legGroup.scale.y * 1.5;
  let headTop = 0;
  for (const part of [head, mane, horn]) {
    if (!part) continue;
    const vertices = part.geometry.attributes.position;
    for (let i = 0; i < vertices.count; i++) {
      const y = -vertices.getY(i), z = vertices.getZ(i);
      const angle = THREE.MathUtils.clamp(Math.atan2(z, y), -0.5, 0.5);
      headTop = Math.max(headTop, y * Math.cos(angle) + z * Math.sin(angle));
    }
  }
  const labelHeight = visual.position.y - headGroup.position.y + headGroup.scale.y * headTop + 0.19;
  const fore = legs.slice(0, 2).map(leg => {
    leg.position.x *= .98;
    leg.scale.x = .9;
    return leg.position.clone();
  });
  const hind = legs.slice(2).map(leg => leg.position.clone());
  return {head, eyes, mane, horn, neck, body, hips, legs, tail, foldedWings, openWings, meshes, labelHeight, fore, hind,
    tailPivot:tail?.position.clone(), wingPivots:foldedWings.map(wing => wing.position.clone()),
    openWingPivots:openWings.map(wing => wing.position.clone()),
    headScale:headGroup.scale.y, sitHeight:skin.size === 'small' ? .5 : .2};
}

export function createPonyAvatar(isAir) {
  const object = new THREE.Group(), visual = new THREE.Group();
  visual.scale.set(-1, -1, 1);
  object.add(visual);
  // Give the atlas overlay planes stable priority where the original parts share a plane.
  const materials = [0, 1, 2].map(layer => new THREE.MeshBasicMaterial({
    map: defaultTexture, vertexColors:true, alphaTest:.25, alphaToCoverage:true, side:THREE.DoubleSide,
    polygonOffset:layer > 0, polygonOffsetFactor:-layer, polygonOffsetUnits:-2 * layer,
  }));
  for (const material of materials) material.onBeforeCompile = sampleSkinFaces;
  let skin = defaultSkin, texture = defaultTexture;
  let rig = buildRig(visual, materials, skin);
  let armor = createPonyArmor(rig), worn;
  let skinUrl = null, skinReady = true, pending, revision = 0, disposed = false;
  let lightColor = 0xffffff;
  let time = 0, limbSwing = 0, swing = 0, flight = 0, boost = 0, bank = 0, sitting = 0, motion = 'idle';
  let stance = 'stand', crouching = 0, crawling = 0, swimming = 0;
  let swimStroke = 0;
  let leapTop, previousFallDistance = 0, gliding = false;
  let previousSwing, strikeTime = Infinity, activeProp, heldItem, hornGlow, firstPerson = false;
  const eyePosition = new THREE.Vector3();
  const magicPosition = new THREE.Vector3();
  const wingTarget = new THREE.Vector3();
  const viewAim = new THREE.Euler(0,0,0,'YXZ');
  const viewGrip = new THREE.Vector3(), gripOffset = new THREE.Vector3();
  const firstPersonItemAngle = new THREE.Euler(.14,.26,.80,'YXZ');
  const viewRotation = new THREE.Quaternion(), itemRotation = new THREE.Quaternion();
  let heldAssets, strike = 0, strikeTurn = 0;

  function applySkin(next, nextTexture) {
    const changed = Object.keys(next).some(key => next[key] !== skin[key]);
    if (texture !== defaultTexture) texture.dispose();
    skin = next;
    texture = nextTexture;
    for (const material of materials) material.map = texture;
    if (changed) {
      armor.dispose();
      visual.clear();
      rig = buildRig(visual, materials, skin);
      armor = createPonyArmor(rig);
      armor.setLight(lightColor);
      armor.update(worn);
      hornGlow?.material.dispose();
      hornGlow = null;
      rig.head.visible = !firstPerson;
      rig.neck.visible = !firstPerson;
    }
  }

  function setSkin(url) {
    url ||= null;
    if (disposed) return Promise.resolve(false);
    if (url === skinUrl && (pending || skinReady)) return pending ?? Promise.resolve(true);
    skinUrl = url;
    const request = ++revision;
    if (!url) {
      applySkin(defaultSkin, defaultTexture);
      skinReady = true;
      pending = null;
      return Promise.resolve(true);
    }
    skinReady = false;
    pending = loadSkin(url).then(({skin: next, texture: nextTexture}) => {
      if (request !== revision) {
        nextTexture.dispose();
        return false;
      }
      applySkin(next, nextTexture);
      skinReady = true;
      pending = null;
      return true;
    }).catch(() => {
      if (request === revision) {
        applySkin(defaultSkin, defaultTexture);
        pending = null;
        skinUrl = null;
      }
      return false;
    });
    return pending;
  }

  function jumpFlight(position) {
    if (!position || motion !== 'jump') {
      leapTop = undefined;
      previousFallDistance = 0;
      gliding = false;
      return false;
    }
    leapTop = Math.max(position.y, leapTop ?? position.y);
    const fallDistance = leapTop - position.y;
    if (!isAir) return fallDistance >= 2;
    // Mine Little Pony keeps its wings folded where the hoof-level cells are occupied.
    const unchanged = fallDistance === previousFallDistance;
    const span = fallDistance > 0 && !unchanged ? 1.5 : 1;
    const y = Math.floor(position.y - .01);
    for (let dz = -span; dz <= span; dz += span) {
      for (let dx = -span; dx <= span; dx += span) {
        if (!isAir(Math.floor(position.x + dx), y, Math.floor(position.z + dz))) {
          gliding = false;
          return false;
        }
      }
    }
    if (gliding) return true;
    previousFallDistance = fallDistance;
    return gliding = unchanged || fallDistance >= 2;
  }

  function animate({time: now = time, dt = 1 / 60, speed = 0, yawOffset = 0, pitch = 0, strideDirection = 1, strafe = 0,
    motion: nextMotion = 'idle', stance: nextStance = 'stand', boost: flightBoost = false,
    position, groundSeat = false, swing: swingId = 0, held = null, equipment, itemAssets} = {}) {
    time = now;
    motion = nextMotion === 'air' ? 'jump' : nextMotion;
    stance = nextStance;
    viewAim.set(pitch,object.rotation.y + yawOffset,0);
    const elapsed = THREE.MathUtils.clamp(dt, 0, 0.1);
    const fade = 1 - Math.exp(-elapsed * 14);
    // EntityLiving uses four times the horizontal distance per 20 Hz tick for limb swing.
    const groundCreep = motion === 'sit' && groundSeat;
    const targetSwing = motion === 'idle' || (motion === 'sit' && !groundCreep) ? 0 : Math.min(1, speed * .2);
    swing += (targetSwing - swing) * (1 - .6 ** (elapsed * 20));
    limbSwing += strideDirection * swing * elapsed * 20;
    const airborne = stance !== 'crawl' && rig.openWings.length > 0 && jumpFlight(position);
    const flying = motion === 'fly';
    const bankTarget = flying ? THREE.MathUtils.clamp(strafe / 9, -1, 1) * .23 : 0;
    bank += (bankTarget - bank) * (1 - Math.exp(-elapsed * 9));
    visual.rotation.z = firstPerson ? 0 : bank;
    const extended = flying || airborne;
    flight += (Number(extended) - flight) * fade;
    boost += (Number(flying && flightBoost) - boost) * fade;
    sitting += (Number(motion === 'sit' && stance !== 'crawl') - sitting) * fade;
    const immersed = motion === 'swim';
    swimming += (Number(immersed) - swimming) * fade;
    if (immersed) swimStroke = (swimStroke + elapsed * (2.8 + 5 * swing)) % TAU;
    crouching += (Number(stance === 'crouch' && !immersed) - crouching) * fade;
    const crawlTarget = Number(stance === 'crawl' && !immersed);
    crawling += (crawlTarget - crawling) * fade;
    if (Math.abs(crawlTarget - crawling) < .001) crawling = crawlTarget;
    rig.head.rotation.set(-THREE.MathUtils.clamp(pitch, -0.5, 0.5),
      -THREE.MathUtils.clamp(yawOffset, -headTurnLimit, headTurnLimit), 0);
    if (rig.mane && skin.mane === 1) rig.mane.rotation.x = Math.sin(time * .66) * .02 * (1 - boost);
    if (previousSwing !== undefined && previousSwing !== swingId) strikeTime = 0;
    previousSwing = swingId;
    const progress = Math.min(1, strikeTime / .3);
    strikeTime += elapsed;
    const hit = progress < 1 ? Math.sin(progress * Math.PI) : 0;
    strikeTurn = hit * -.4;
    strike = progress < 1 ? Math.sin((1 - (1 - progress) ** 3) * Math.PI) * 1.2 +
      hit * (.7 - rig.head.rotation.x) * .75 : 0;

    const gait = Math.PI * swing ** 16;
    const phase = limbSwing * .6662;
    const cycle = [phase + Math.PI + gait * .5, phase + gait, phase + gait * .2, phase + Math.PI - gait * .4];
    const flyPitch = Math.sin(swing * .35);
    for (let i = 0; i < rig.legs.length; i++) {
      const direction = i < 2 ? -1 : 1;
      const step = Math.cos(cycle[i]) * .45 * swing * (1 - flight);
      const glide = direction * (flyPitch * (flight - boost) + Math.PI / 2 * boost);
      rig.legs[i].rotation.set(step + glide + (i % 2 ? -.18 : .18) * bank, flightLegYaw[i] * flight, 0);
    }
    const hoof = rig.legs[0].rotation;
    const holdingWithMagic = rig.horn && held;
    if (held && !holdingWithMagic) {
      hoof.x = THREE.MathUtils.lerp(hoof.x * .5 - Math.PI / 10, hoof.x, boost);
      hoof.x += Math.sin(time * 1.34) * .05;
      hoof.z = Math.cos(time * 1.8) * .05 + .05;
    }
    const hoofStrike = holdingWithMagic ? .3 : 1;
    hoof.x -= strike * hoofStrike;
    hoof.z += strikeTurn * hoofStrike;
    const hipSwing = swing ** 16 > .5 ? .05 : .03;
    const hipFlight = Math.sin(swing * .05) * (flight - boost) + .2 * boost;
    for (let i = 0; i < rig.hips.length; i++) {
      rig.hips[i].rotation.x = Math.cos(cycle[i + 2]) * hipSwing * swing * (1 - flight) + hipFlight;
    }
    if (rig.tail) {
      const relaxed = .5 * swing + .05 * Math.sin(time * 1.34);
      rig.tail.rotation.x = THREE.MathUtils.lerp(relaxed, Math.PI / 2 + .1 * Math.sin(limbSwing), boost);
      rig.tail.rotation.z = Math.cos(limbSwing * .8) * .2 * swing * (1 - boost);
    }
    // Mine Little Pony's ponySit() lowers the body and head, folds and spreads the hocks,
    // and repositions the shoulders, wings and tail in the original 1/16-block model space.
    const part = sitting / 16;
    const height = rig.sitHeight;
    // The native sneak animation drops the head and shoulders, tips the body
    // forward and bends the front legs without moving the standing root.
    const sneak = crouching / 16;
    rig.head.position.set(0, (3.5 + height) * part + 6 * sneak, 1.2 * part - 2 * sneak);
    rig.neck.position.set(0, (2.5 + height) * part + 5 * sneak, .8 * part - 1.4 * sneak);
    rig.body.position.set(0, (4 + height) * part + 7 * sneak, 3 * part - 4 * sneak);
    rig.body.rotation.set(.4 * (crouching - sitting), 0, 0);
    for (let i = 0; i < rig.legs.length; i++) {
      const leg = rig.legs[i];
      leg.rotation.x += (seatedLegAngles[i] - leg.rotation.x) * sitting;
      if (i < 2) {
        leg.position.copy(rig.fore[i]);
        leg.rotation.x -= .4 * crouching;
        if (groundCreep) leg.rotation.x += Math.cos(cycle[i]) * .38 * swing * sitting;
        leg.position.y += (2 + height) * part + .5 * sneak;
        leg.position.z += boost / 16;
      } else {
        leg.morphTargetInfluences[0] = crawling;
        const side = i === 2 ? 1 : -1;
        leg.rotation.y += (.5 * side - leg.rotation.y) * sitting;
        leg.position.copy(rig.hind[i - 2]);
        leg.position.x += 2 * side * part;
        leg.position.y += (13 + height) * part - sneak;
        leg.position.z += 5 * part - boost / 32;
      }
    }
    for (const hip of rig.hips) {
      hip.position.y = (8 + height) * part + 7 * sneak + (swing * .5 * (flight - boost) + 2.5 * boost) / 16;
      hip.position.z = -4 * sneak - (swing * .5 * (flight - boost) + 2 * boost) / 16;
      hip.rotation.x += .4 * crouching;
    }
    if (rig.tail) {
      rig.tail.position.copy(rig.tailPivot);
      rig.tail.position.x -= 3.5 * part;
      rig.tail.position.y += (11.2 + height) * part + 6 * boost / 16;
      rig.tail.position.z += part + boost / 16 - 4 * sneak;
      rig.tail.rotation.x += (-.5 - rig.tail.rotation.x) * sitting - rig.tail.rotation.x * crouching;
      rig.tail.rotation.z += (-1.1 - rig.tail.rotation.z) * sitting;
    }
    const flap = Math.sin(time * 10.72);
    const sneakWings = stance === 'crouch' && !extended && !immersed;
    for (let i = 0; i < rig.openWings.length; i++) {
      const folded = rig.foldedWings[i];
      folded.visible = !extended && !sneakWings;
      folded.position.copy(rig.wingPivots[i]);
      folded.position.y += (1.75 + height) * part;
      folded.position.z -= 2.5 * part;
      folded.rotation.set((1.1 - 1.571) * sitting,0,0);
      const open = rig.openWings[i];
      open.visible = extended || sneakWings;
      open.position.copy(rig.openWingPivots[i]);
      open.position.y += (3.25 + i) * sneak;
      open.position.z -= 2.5 * sneak;
      open.rotation.z = (i === 0 ? -1 : 1) * THREE.MathUtils.lerp(5.112 + flap, 6, crouching);
    }
    if (crawling > .0001) applyPronePose(phase, motion === 'sit' ? 0 : swing);
    if (swimming > .0001) applySwimPose(pitch);
    activeProp = held;
    heldAssets = itemAssets;
    worn = equipment;
    armor.update(worn);
    updateHeldItem();
  }

  function lowerTo(part, height, mix) {
    // Rig coordinates run downwards and groups have different native scales.
    const y = (visual.position.y - part.parent.position.y - height) / part.parent.scale.y;
    part.position.y = THREE.MathUtils.lerp(part.position.y, y, mix);
  }

  function applySwimPose(pitch) {
    const {lerp,clamp} = THREE.MathUtils;
    const heights = proneHeights[skin.size];
    const power = .25 + swing * .75;
    const bob = Math.sin(swimStroke * 2) * .025 * power;
    const incline = clamp(-pitch * .3,-.22,.22);
    lowerTo(rig.head, heights.head + .09 + bob, swimming);
    lowerTo(rig.neck, heights.neck + .08 + bob, swimming);
    lowerTo(rig.body, rig.body.parent.scale.y * .78 + .09 + bob, swimming);
    rig.body.rotation.x = lerp(rig.body.rotation.x,incline,swimming);
    for (const hip of rig.hips) {
      hip.position.y = lerp(hip.position.y,rig.body.position.y,swimming);
      hip.rotation.x = lerp(hip.rotation.x,incline,swimming);
    }
    for (let i = 0; i < rig.legs.length; i++) {
      const leg = rig.legs[i], foreleg = i < 2;
      const phase = swimStroke + (i % 2) * Math.PI + (foreleg ? 0 : .7);
      const stroke = Math.sin(phase) * power;
      const rest = foreleg ? rig.fore[i] : rig.hind[i - 2];
      lowerTo(leg, heights.leg + .08 + bob + (1 + Math.cos(phase)) * .022, swimming);
      leg.position.z = lerp(leg.position.z,rest.z + .08 * stroke,swimming);
      leg.rotation.x = lerp(leg.rotation.x,(foreleg ? -.95 : 1.17) + .55 * stroke + incline,swimming);
      leg.rotation.y = lerp(leg.rotation.y,(i % 2 ? -1 : 1) * .11,swimming);
    }
    if (rig.tail) {
      lowerTo(rig.tail,heights.tail + .12 + bob,swimming);
      rig.tail.rotation.x = lerp(rig.tail.rotation.x,1.13 + .11 * Math.sin(swimStroke),swimming);
      rig.tail.rotation.z = lerp(rig.tail.rotation.z,.14 * Math.cos(swimStroke),swimming);
    }
    for (let i = 0; i < rig.foldedWings.length; i++) {
      const wing = rig.foldedWings[i];
      wingTarget.copy(rig.wingPivots[i]).applyEuler(rig.body.rotation).add(rig.body.position);
      wing.position.lerp(wingTarget,swimming);
      wing.rotation.x = lerp(wing.rotation.x,incline,swimming);
    }
  }

  function applyPronePose(phase, pace) {
    const {lerp} = THREE.MathUtils;
    const heights = proneHeights[skin.size];
    const rock = Math.sin(phase) * pace;
    const lower = (part,height) => lowerTo(part,height,crawling);
    lower(rig.head, heights.head + .014 * rock);
    lower(rig.neck, heights.neck + .012 * rock);
    rig.head.position.z = lerp(rig.head.position.z, -.04, crawling);
    rig.neck.position.z = lerp(rig.neck.position.z, -.02, crawling);
    rig.body.rotation.x *= 1 - crawling;
    rig.body.rotation.y = .05 * rock * crawling;
    rig.body.rotation.z = .04 * rock * crawling;
    lower(rig.body, rig.body.parent.scale.y * .78 + .043);
    for (const hip of rig.hips) {
      lower(hip, hip.parent.scale.y * .8 + .035);
      hip.position.z = lerp(hip.position.z, -.015, crawling);
      hip.rotation.x *= 1 - crawling;
    }
    for (let i = 0; i < rig.legs.length; i++) {
      const leg = rig.legs[i], front = i < 2;
      const side = i % 2 === 0 ? 1 : -1;
      const stroke = side * rock;
      const angle = front ? -1.48 - .16 * stroke : Math.PI / 2 + .19 * stroke;
      // Keep the lowest edge of the hoof at the ground as its pitch changes.
      const sin = Math.sin(angle), cos = Math.cos(angle);
      const down = Math.max(-.25 * cos,.5 * cos) +
        Math.max((front ? .125 : .0625) * sin,-(front ? .125 : .1875) * sin);
      lower(leg, down * leg.parent.scale.y + .013 + .032 * Math.max(0,stroke));
      if (front) leg.position.x *= 1 - .15 * crawling;
      else leg.position.x -= side * .025 * crawling;
      const depth = front ? .39 + .14 * stroke : rig.hind[i - 2].z - .065 - .072 * stroke;
      leg.position.z = lerp(leg.position.z, depth, crawling);
      leg.rotation.x = lerp(leg.rotation.x, angle, crawling);
      leg.rotation.y = lerp(leg.rotation.y, side * (front ? .055 : -.085), crawling);
      leg.rotation.z *= 1 - crawling;
    }
    if (rig.tail) {
      lower(rig.tail, heights.tail);
      rig.tail.rotation.x = lerp(rig.tail.rotation.x, 1.32, crawling);
      rig.tail.rotation.z = lerp(rig.tail.rotation.z, .09 * rock, crawling);
    }
    for (let i = 0; i < rig.foldedWings.length; i++) {
      const side = i === 0 ? -1 : 1;
      const wing = rig.foldedWings[i];
      wingTarget.copy(rig.wingPivots[i]).applyEuler(rig.body.rotation).add(rig.body.position);
      wing.position.lerp(wingTarget,crawling);
      wing.rotation.x = lerp(wing.rotation.x,rig.body.rotation.x - .09,crawling);
      wing.rotation.y = lerp(wing.rotation.y,rig.body.rotation.y,crawling);
      wing.rotation.z = lerp(wing.rotation.z,rig.body.rotation.z + side * .33,crawling);
    }
  }

  function updateHeldItem() {
    if (!heldItem && activeProp && heldAssets) heldItem = createPonyHeldItem();
    const magic = rig.horn ? skin.glowColor : null;
    heldItem?.show(activeProp, heldAssets, magic);
    if (heldItem?.object.visible) {
      const {object:prop,pose} = heldItem;
      heldItem.setLight(lightColor);
      heldItem.grip(magic === null);
      if (magic === null) {
        if (prop.parent !== rig.legs[0]) rig.legs[0].add(prop);
        if (pose === 'block') {
          prop.position.set(.025,.53,-.18);
          prop.rotation.set(.35,.79,Math.PI);
        } else if (pose === 'tool') {
          prop.position.set(.045,.48,-.21);
          prop.rotation.set(-1.05,.45,Math.PI - .4);
        } else {
          prop.position.set(.047,.51,-.19);
          prop.rotation.set(-.48,.34,Math.PI - .27);
        }
        if (firstPerson) {
          const reach = THREE.MathUtils.smoothstep(viewAim.x,-1.35,-.78) * (1 - crawling);
          const hoof = rig.legs[0];
          hoof.rotation.x = THREE.MathUtils.lerp(hoof.rotation.x,-1.18 + .28 * viewAim.x - .55 * strike,reach);
          viewGrip.set(.365 + .04 * strike,-.355 + .08 * strike,-.64 - .07 * strike).applyEuler(viewAim)
            .add(rig.eyes.getWorldPosition(eyePosition));
          gripOffset.copy(prop.position).multiply(hoof.scale).applyEuler(hoof.rotation);
          hoof.position.lerp(hoof.parent.worldToLocal(viewGrip).sub(gripOffset),reach);
          if (pose === 'tool' && reach > 0) {
            viewRotation.setFromEuler(viewAim).multiply(itemRotation.setFromEuler(firstPersonItemAngle));
            prop.quaternion.slerp(hoof.getWorldQuaternion(itemRotation).invert().multiply(viewRotation),reach);
          }
        }
      } else {
        if (prop.parent !== visual) visual.add(prop);
        if (firstPerson) {
          magicPosition.set(.34 + .09 * strike,-.24 + .04 * Math.sin(time * 3),-.70 - .19 * strike)
            .applyEuler(viewAim).add(rig.eyes.getWorldPosition(eyePosition));
          prop.position.copy(visual.worldToLocal(magicPosition));
        } else {
          prop.position.set(-.48 - .09 * strike, .43 + .04 * Math.sin(time * 3) - .11 * strike, -.76 - .19 * strike);
        }
        const turn = (pose === 'block' ? .55 : .16) + .14 * Math.sin(time * 1.4);
        prop.rotation.set(pose === 'tool' ? -.66 : .05,turn,Math.PI);
      }
      prop.scale.setScalar(pose === 'block' ? .30 : pose === 'tool' ? .50 : .38);
    }
    if (rig.horn && activeProp && !hornGlow) {
      const geometry = rig.horn.geometry;
      geometry.computeBoundingBox();
      const center = geometry.boundingBox.getCenter(new THREE.Vector3());
      hornGlow = new THREE.Mesh(geometry, magicMaterial(.3));
      hornGlow.scale.setScalar(1.30);
      hornGlow.position.copy(center).multiplyScalar(-.30);
      hornGlow.renderOrder = 1;
      rig.horn.add(hornGlow);
    }
    if (hornGlow) {
      hornGlow.visible = Boolean(activeProp);
      hornGlow.material.color.setHex(skin.glowColor);
      hornGlow.material.opacity = .3 + strike * .11;
    }
  }

  function setFirstPerson(active) {
    firstPerson = active;
    rig.head.visible = !active;
    rig.neck.visible = !active;
  }

  function eyesWorldPosition() {
    object.updateMatrixWorld(true);
    return rig.eyes.getWorldPosition(eyePosition);
  }

  function heldLight(target) {
    if (!heldItem?.object.visible) return 0;
    const level = heldLightLevel(activeProp);
    if (level) {
      heldItem.object.getWorldPosition(target);
      target.y += .17;
    }
    return level;
  }

  function inspect() {
    return {skinReady, ponyType: skin.ponyType, advanced: skin.advanced, size: skin.size, phase:limbSwing * .6662 % TAU,
      tail:skin.tail, male:skin.male, mane:skin.mane,
      meshCount: rig.meshes, motion, stance, legAngles: rig.legs.map(leg => leg.rotation.x),
      headYaw:-rig.head.rotation.y, headPitch:-rig.head.rotation.x, flightBoost:boost, flightBank:bank,
      held:activeProp, strike, magicGlow:hornGlow?.visible ? skin.glowColor : null,
      firstPersonHooves:firstPerson ? rig.legs.slice(0, 2).map(hoof => hoof.rotation.x) : null,
      firstPersonBody:firstPerson, eyes:eyesWorldPosition().toArray(),
      wingsExtended: rig.openWings.some(wing => wing.visible),
      wingAngles: rig.openWings.map(wing => wing.rotation.z)};
  }

  function setLight(color) {
    if (lightColor === color) return;
    lightColor = color;
    for (const material of materials) material.color.setHex(color, THREE.SRGBColorSpace);
    armor.setLight(color);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    revision++;
    if (texture !== defaultTexture) texture.dispose();
    for (const material of materials) material.dispose();
    hornGlow?.material.dispose();
    heldItem?.dispose();
    armor.dispose();
    visual.clear();
    object.removeFromParent();
  }
  return {object, get labelHeight() {
    return rig.labelHeight - rig.head.position.y * rig.headScale;
  }, setSkin, setLight, animate, setFirstPerson, eyesWorldPosition, heldLight, inspect, dispose};
}
