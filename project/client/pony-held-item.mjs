import * as THREE from '/vendor/three/three.module.js';
import {ATLAS_GRID, coverBoxes, creativeIcon, shapeFor, tiles} from '../world/geometry.mjs';
import {heldLamp, heldLightLevel} from '../world/held-light.mjs';

const facePoints = [
  [0,4,7,3], [5,1,2,6], [0,1,5,4], [7,6,2,3], [1,0,3,2], [4,5,6,7],
];
const shades = [.84,.84,.58,1,.91,.91];
const unit = {x0:0,y0:0,z0:0,x1:1,y1:1,z1:1};
const flatItem = [[-.5,-.5,0],[.5,-.5,0],[.5,.5,0],[-.5,.5,0]];

function tileUV(tile, rows) {
  const x = tile % ATLAS_GRID, y = Math.floor(tile / ATLAS_GRID);
  return [(x + .005) / ATLAS_GRID, (y + .005) / rows, (x + .995) / ATLAS_GRID, (y + .995) / rows];
}

function boxPoints({x0,y0,z0,x1,y1,z1}) {
  return [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],
    [x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
}

function appearance(held, assets) {
  const quads = [];
  let map = assets.terrain;
  if (held.kind === 'item') {
    const sprite = assets.itemSprite(held.key);
    map = sprite?.map ?? map;
    quads.push({points:flatItem, uv:sprite?.uv ?? tileUV(tiles.unknown, assets.rows), shade:1});
  } else {
    const lamp = heldLamp(held.key);
    const shape = held.part ? coverBoxes([held.part]) :
      shapeFor(lamp ? {key:'legacy:768:0',object:{data:lamp}} : held.key);
    if (shape[0]?.kind === 'cross') {
      const icon = creativeIcon(held);
      quads.push({points:flatItem, uv:tileUV(icon.tile, assets.rows),
        shade:1, tint:icon.tint});
    } else {
      for (const part of shape.slice(0, 16)) {
        const points = boxPoints(part);
        for (let side = 0; side < 6; side++) {
          const tile = part.faces?.[side];
          if (!Number.isInteger(tile) || tile < 0) continue;
          quads.push({points:facePoints[side].map(i => points[i].map(value => value - .5)),
            uv:tileUV(tile, assets.rows), shade:shades[side], tint:part.tintFaces?.[side] ?? part.tint});
        }
      }
    }
  }
  if (!quads.length) {
    const points = boxPoints(unit);
    for (let side = 0; side < 6; side++) quads.push({points:facePoints[side].map(i => points[i].map(value => value - .5)),
      uv:tileUV(tiles.unknown, assets.rows), shade:shades[side]});
  }
  return {map, quads};
}

function meshGeometry(quads) {
  const positions = [], colors = [], uvs = [], indices = [];
  for (const {points, uv:[u0,v0,u1,v1], shade, tint = 0xffffff} of quads) {
    const color = new THREE.Color(tint).multiplyScalar(shade);
    const start = positions.length / 3;
    for (const point of points) {
      positions.push(...point);
      colors.push(color.r, color.g, color.b);
    }
    uvs.push(u0,1-v1,u1,1-v1,u1,1-v0,u0,1-v0);
    indices.push(start,start+1,start+2,start,start+2,start+3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs,2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors,3));
  geometry.setIndex(indices);
  return geometry;
}

export function magicMaterial(opacity = .38) {
  return new THREE.MeshBasicMaterial({transparent:true, depthWrite:false, side:THREE.DoubleSide,
    opacity, blending:THREE.AdditiveBlending, toneMapped:false});
}

export function createPonyHeldItem() {
  const object = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({alphaTest:.25, alphaToCoverage:true, side:THREE.DoubleSide, vertexColors:true});
  const halo = magicMaterial();
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  const glow = new THREE.Mesh(mesh.geometry, halo);
  glow.renderOrder = 1;
  glow.scale.setScalar(1.13);
  object.add(mesh, glow);
  let key, currentAssets;
  let luminous = false;

  function show(held, assets, magic) {
    const nextKey = held && `${held.kind}:${held.key}`;
    object.visible = Boolean(held && assets?.terrain);
    glow.visible = object.visible && magic !== null;
    if (!object.visible) return;
    if (key !== nextKey || currentAssets !== assets) {
      const {map, quads} = appearance(held, assets);
      mesh.geometry.dispose();
      mesh.geometry = glow.geometry = meshGeometry(quads);
      material.map = halo.map = map;
      halo.alphaTest = .2;
      material.needsUpdate = halo.needsUpdate = true;
      luminous = heldLightLevel(held) > 0;
      key = nextKey;
      currentAssets = assets;
    }
    if (glow.visible) halo.color.setHex(magic);
  }

  return {object, show, setLight(color) { material.color.setHex(luminous ? 0xffffff : color); }, dispose() {
    object.removeFromParent();
    mesh.geometry.dispose();
    material.dispose();
    halo.dispose();
  }};
}
