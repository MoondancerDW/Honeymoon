import * as THREE from '/vendor/three/three.module.js';
import {ponyModels} from '../world/pony-model-data.mjs';
import {defaultPonyPixels, ponySkinHeight, readPonySkin} from '../world/pony-skins.mjs';

const LEG_NAMES = ['frontRight', 'frontLeft', 'hindRight', 'hindLeft'];
const TAU = Math.PI * 2;
const seatedLegAngles = [-.4, -.4, 4.712 - TAU, 4.712 - TAU];
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
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = false;
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
  return {skin: readPonySkin(data, width, skinHeight), texture: setupTexture(new THREE.CanvasTexture(canvas))};
}

function groupParts(parts, names) {
  const prefixes = new Set(names);
  return Object.keys(parts).filter(name => prefixes.has(name.split('.')[0]) || prefixes.has(name));
}

// Bake the native parts sharing a pivot into one geometry. A standard pony needs
// only head, neck, body, hips, four legs and tail draw calls.
function geometryFor(model, names, position, rotation = [0, 0, 0], hornScale = 1) {
  const key = JSON.stringify([model, names, position, rotation, hornScale]);
  if (geometryCache.has(key)) return geometryCache.get(key);
  const parts = ponyModels[model];
  const positions = [], colors = [], uvs = [], indices = [], seen = new Set();
  const vertex = new THREE.Vector3(), normal = new THREE.Vector3();
  const edgeA = new THREE.Vector3(), edgeB = new THREE.Vector3();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const euler = new THREE.Euler(0, 0, 0, 'ZYX');
  for (const name of names) {
    const [[x, y, z, rx, ry, rz], quads] = parts[name];
    euler.set(rx - rotation[0], ry - rotation[1], rz - rotation[2], 'ZYX');
    for (let i = 0; i < quads.length; i += 20) {
      const face = quads.slice(i, i + 20);
      const faceKey = [x, y, z, rx, ry, rz, ...face].join(',');
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
      for (let j = 0; j < 20; j += 5) {
        vertex.fromArray(face, j).applyEuler(euler);
        vertex.add(a.set(x - position[0], y - position[1], z - position[2]));
        if (name === 'headpiece.2') vertex.y *= hornScale;
        positions.push(vertex.x / 16, vertex.y / 16, vertex.z / 16);
        colors.push(shade, shade, shade);
        uvs.push(face[j + 3], face[j + 4]);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  geometryCache.set(key, geometry);
  return geometry;
}

function renderGroup(parent, [y, z, sx, sy, sz]) {
  const group = new THREE.Group();
  group.position.set(0, y, z);
  group.scale.set(sx, sy, sz);
  parent.add(group);
  return group;
}

function buildRig(visual, material, skin) {
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
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(pose[0] / 16, pose[1] / 16, pose[2] / 16);
    mesh.rotation.order = 'ZYX';
    if (rotation) mesh.rotation.set(...rotation);
    parent.add(mesh);
    meshes++;
    return mesh;
  }

  const headNames = ['head', 'helmet', 'mane', skin.male ? 'muzzleMale' : 'muzzleFemale',
    'headpiece.0', 'headpiece.1'];
  if (hasHorn) headNames.push('headpiece.2');
  if (skin.mane === 1) headNames.push('mohawk');
  if (skin.mane === 2 || skin.mane === 4) headNames.push('maneLeft');
  if (skin.mane === 3 || skin.mane === 4) headNames.push('maneRight');
  const hornScale = skin.size === 'large' ? 1.05 : skin.size === 'tall' ? 1.2 : 1;
  const head = attach(headGroup, groupParts(parts, headNames), pivot, undefined, hornScale);
  const neck = attach(neckGroup, groupParts(parts, ['neck']));
  const body = attach(bodyGroup, groupParts(parts, ['body']));
  const hips = ['hipRight', 'hipLeft'].map(name => attach(bodyGroup, groupParts(parts, [name])));
  const legs = LEG_NAMES.map(name => attach(legGroup, groupParts(parts, [name]), parts[name][0]));
  const tailCount = 21 - skin.tail * 5;
  const tail = tailCount > 1
    ? attach(tailGroup, groupParts(parts, ['tail']).filter(name => Number(name.split('.')[1]) < tailCount),
      parts['tail.0'][0]) : null;
  const foldedWings = [], openWings = [];
  if (hasWings && skin.size !== 'small') {
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
  const headVertices = head.geometry.attributes.position;
  let headTop = 0;
  for (let i = 0; i < headVertices.count; i++) {
    const y = -headVertices.getY(i), z = headVertices.getZ(i);
    const angle = THREE.MathUtils.clamp(Math.atan2(z, y), -0.5, 0.5);
    headTop = Math.max(headTop, y * Math.cos(angle) + z * Math.sin(angle));
  }
  const labelHeight = visual.position.y - headGroup.position.y + headGroup.scale.y * headTop + 0.19;
  const fore = legs.slice(0, 2).map(leg => leg.position.clone());
  const hind = legs.slice(2).map(leg => leg.position.clone());
  return {head, neck, body, hips, legs, tail, foldedWings, openWings, meshes, labelHeight, fore, hind,
    tailPivot:tail?.position.clone(), wingPivots:foldedWings.map(wing => wing.position.clone()),
    headScale:headGroup.scale.y, sitHeight:skin.size === 'small' ? .5 : .2};
}

export function createPonyAvatar() {
  const object = new THREE.Group(), visual = new THREE.Group();
  visual.scale.set(-1, -1, 1);
  object.add(visual);
  const material = new THREE.MeshBasicMaterial({
    map: defaultTexture, vertexColors: true, alphaTest: 0.1, side: THREE.DoubleSide,
  });
  let skin = defaultSkin, texture = defaultTexture;
  let rig = buildRig(visual, material, skin);
  let skinUrl = null, skinReady = true, pending, revision = 0, disposed = false;
  let time = 0, phase = 0, tailPhase = 0, run = 0, flight = 0, airborne = 0, paddling = 0, sitting = 0, motion = 'idle';

  function applySkin(next, nextTexture) {
    const changed = Object.keys(next).some(key => next[key] !== skin[key]);
    if (texture !== defaultTexture) texture.dispose();
    skin = next;
    texture = nextTexture;
    material.map = texture;
    if (changed) {
      visual.clear();
      rig = buildRig(visual, material, skin);
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

  function animate({time: now = time, dt = 1 / 60, speed = 0, yawOffset = 0, pitch = 0,
    motion: nextMotion = 'idle'} = {}) {
    time = now;
    motion = nextMotion === 'air' ? 'jump' : nextMotion;
    const elapsed = THREE.MathUtils.clamp(dt, 0, 0.1);
    const fade = 1 - Math.exp(-elapsed * 14);
    const groundSpeed = motion === 'walk' ? THREE.MathUtils.clamp(speed / 4.3, 0, 1) : 0;
    run += (groundSpeed - run) * fade;
    flight += (Number(motion === 'fly') - flight) * fade;
    airborne += (Number(motion === 'jump') - airborne) * fade;
    paddling += (Number(motion === 'swim') - paddling) * fade;
    sitting += (Number(motion === 'sit') - sitting) * fade;
    if (run > 0.001) {
      const advancement = elapsed * (3 + 8 * run);
      phase = (phase + advancement) % TAU;
      tailPhase = (tailPhase + advancement * (0.8 / 0.6662)) % TAU;
    }
    rig.head.rotation.set(-THREE.MathUtils.clamp(pitch, -0.5, 0.5),
      -THREE.MathUtils.clamp(yawOffset, -1.35, 1.35), 0);

    const gait = Math.PI * Math.pow(run, 16);
    const fore = Math.sin(0.45 * flight), hind = -fore;
    rig.legs[0].rotation.set(0.45 * run * Math.cos(phase + Math.PI + gait * 0.5)
      + fore + 0.48 * airborne + 0.36 * paddling * Math.sin(time * 8), 0.2 * flight, 0);
    rig.legs[1].rotation.set(0.45 * run * Math.cos(phase + gait)
      + fore + 0.41 * airborne - 0.36 * paddling * Math.sin(time * 8), -0.2 * flight, 0);
    rig.legs[2].rotation.set(0.45 * run * Math.cos(phase + gait * 0.2)
      + hind - 0.34 * airborne - 0.3 * paddling * Math.sin(time * 8), -0.2 * flight, 0);
    rig.legs[3].rotation.set(0.45 * run * Math.cos(phase + Math.PI - gait * 0.4)
      + hind - 0.28 * airborne + 0.3 * paddling * Math.sin(time * 8), 0.2 * flight, 0);
    rig.hips[0].rotation.x = Math.cos(phase + gait * 0.2) * 0.03 * run + flight * 0.04;
    rig.hips[1].rotation.x = Math.cos(phase + Math.PI - gait * 0.4) * 0.03 * run + flight * 0.04;
    if (rig.tail) {
      rig.tail.rotation.x = 0.5 * run + 0.05 * Math.sin(time * 20 * 0.067) + 0.35 * flight;
      rig.tail.rotation.z = Math.cos(tailPhase) * 0.2 * run;
    }
    // Mine Little Pony's ponySit() lowers the body and head, folds and spreads the hocks,
    // and repositions the shoulders, wings and tail in the original 1/16-block model space.
    const part = sitting / 16;
    const height = rig.sitHeight;
    rig.head.position.set(0, (3.5 + height) * part, 1.2 * part);
    rig.neck.position.set(0, (2.5 + height) * part, .8 * part);
    rig.body.position.set(0, (4 + height) * part, 3 * part);
    rig.body.rotation.x = -.4 * sitting;
    for (let i = 0; i < rig.legs.length; i++) {
      const leg = rig.legs[i];
      leg.rotation.x += (seatedLegAngles[i] - leg.rotation.x) * sitting;
      if (i < 2) {
        leg.position.copy(rig.fore[i]);
        leg.position.y += (2 + height) * part;
      } else {
        const side = i === 2 ? 1 : -1;
        leg.rotation.y += (.5 * side - leg.rotation.y) * sitting;
        leg.position.copy(rig.hind[i - 2]);
        leg.position.x += 2 * side * part;
        leg.position.y += (13 + height) * part;
        leg.position.z += 5 * part;
      }
    }
    for (const hip of rig.hips) hip.position.y = (8 + height) * part;
    if (rig.tail) {
      rig.tail.position.copy(rig.tailPivot);
      rig.tail.position.x -= 3.5 * part;
      rig.tail.position.y += (11.2 + height) * part;
      rig.tail.position.z += part;
      rig.tail.rotation.x += (-.5 - rig.tail.rotation.x) * sitting;
      rig.tail.rotation.z += (-1.1 - rig.tail.rotation.z) * sitting;
    }
    const flap = Math.sin(time * 20 * 0.536);
    for (let i = 0; i < rig.openWings.length; i++) {
      const extended = motion === 'fly';
      const folded = rig.foldedWings[i];
      folded.visible = !extended;
      folded.position.copy(rig.wingPivots[i]);
      folded.position.y += (1.75 + height) * part;
      folded.position.z -= 2.5 * part;
      folded.rotation.x = (1.1 - 1.571) * sitting;
      rig.openWings[i].visible = extended;
      rig.openWings[i].rotation.z = (i === 0 ? -1 : 1) * (5.112 + flap);
    }
  }

  function inspect() {
    return {skinReady, ponyType: skin.ponyType, advanced: skin.advanced, size: skin.size, phase,
      meshCount: rig.meshes, motion, legAngles: rig.legs.map(leg => leg.rotation.x),
      wingsExtended: rig.openWings.some(wing => wing.visible),
      wingAngles: rig.openWings.map(wing => wing.rotation.z)};
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    revision++;
    if (texture !== defaultTexture) texture.dispose();
    material.dispose();
    visual.clear();
    object.removeFromParent();
  }
  return {object, get labelHeight() {
    return rig.labelHeight - rig.head.position.y * rig.headScale;
  }, setSkin, animate, inspect, dispose};
}
