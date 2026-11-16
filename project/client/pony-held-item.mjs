import * as THREE from '/vendor/three/three.module.js';
import {ATLAS_GRID, tiles} from '../world/geometry.mjs';
import {heldLightLevel} from '../world/held-light.mjs';
import {blockItemAppearance} from '../world/item-appearance.mjs';
const itemDepth = 1 / 16;
const itemContours = new WeakMap();

function itemContour(map, uv) {
  let cache = itemContours.get(map);
  if (!cache) itemContours.set(map,cache = new Map());
  const key = uv.join(',');
  if (cache.has(key)) return cache.get(key);
  const image = map.image;
  const width = image?.naturalWidth ?? image?.width, height = image?.naturalHeight ?? image?.height;
  if (!width || !height) return null;
  const x = Math.floor(uv[0] * width), y = Math.floor(uv[1] * height);
  const w = Math.ceil(uv[2] * width) - x, h = Math.ceil(uv[3] * height) - y;
  if (w <= 0 || h <= 0 || w > 128 || h > 128) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', {willReadFrequently:true});
  ctx.drawImage(image,x,y,w,h,0,0,w,h);
  const {data} = ctx.getImageData(0,0,w,h);
  const contour = {w,h,pixels:data};
  cache.set(key,contour);
  return contour;
}

function addItemSprite(quads, map, uv, tint) {
  const [u0,v0,u1,v1] = uv;
  const depth = itemDepth * .5;
  for (const z of [-depth,depth]) {
    quads.push({points:[[-.5,-.5,z],[.5,-.5,z],[.5,.5,z],[-.5,.5,z]],
      uv:[[u0,v1],[u1,v1],[u1,v0],[u0,v0]],shade:1,tint});
  }
  const contour = itemContour(map,uv);
  if (!contour) return;
  const {w,h,pixels} = contour;
  const opaque = (x,y) => x >= 0 && x < w && y >= 0 && y < h && pixels[(y * w + x) * 4 + 3] > 64;
  let handleX = .25, handleY = .25, handleDistance = Infinity;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!opaque(x,y)) continue;
    const left = x / w - .5, right = (x + 1) / w - .5;
    const bottom = .5 - (y + 1) / h, top = .5 - y / h;
    const u = u0 + (u1 - u0) * (x + .5) / w, v = v0 + (v1 - v0) * (y + .5) / h;
    const addEdge = (a,b,shade) => quads.push({points:[[...a,-depth],[...b,-depth],[...b,depth],[...a,depth]],
      uv:[[u,v],[u,v],[u,v],[u,v]],shade,tint});
    const distance = (x + .5)**2 + (h-y-.5)**2;
    if (distance < handleDistance) {
      handleDistance = distance;
      handleX = -(left + right) * .5;
      handleY = -(bottom + top) * .5;
    }
    if (!opaque(x-1,y)) addEdge([left,bottom],[left,top],.76);
    if (!opaque(x+1,y)) addEdge([right,top],[right,bottom],.76);
    if (!opaque(x,y-1)) addEdge([left,top],[right,top],.9);
    if (!opaque(x,y+1)) addEdge([right,bottom],[left,bottom],.64);
  }
  return [handleX,handleY];
}

function isTool(key) {
  const id = Number(key.split(':', 1)[0]);
  return id >= 256 && id <= 258 || id >= 267 && id <= 279 || id >= 283 && id <= 286 ||
    id >= 290 && id <= 294 || id >= 9281 && id <= 9292 || id >= 11520 && id <= 11539 ||
    id >= 15256 && id <= 15261 || id >= 27960 && id <= 27962 || id >= 27979 && id <= 27982 ||
    id >= 28003 && id <= 28006 || [261,346,359,398,8067,9039,9046,9150,11555,26980,27996,28008].includes(id);
}

function tileUV(tile, rows) {
  const x = tile % ATLAS_GRID, y = Math.floor(tile / ATLAS_GRID);
  return [(x + .005) / ATLAS_GRID, (y + .005) / rows, (x + .995) / ATLAS_GRID, (y + .995) / rows];
}

function appearance(held, assets) {
  const quads = [];
  let map = assets.terrain;
  let pose = 'block';
  let handle;
  if (held.kind === 'item') {
    const sprite = assets.itemSprite(held.key);
    map = sprite?.map ?? map;
    pose = isTool(held.key) ? 'tool' : 'sprite';
    handle = addItemSprite(quads,map,sprite?.uv ?? tileUV(tiles.unknown, assets.rows));
  } else {
    const item = blockItemAppearance(held,assets.models,assets.rows);
    map = assets.modelTexture?.(item.family) ?? map;
    if (item.sprite) {
      const face = item.quads[0];
      pose = 'sprite';
      addItemSprite(quads,map,[...face.uv[3],...face.uv[1]],face.tint);
    } else if (item.quads.length) {
      const bounds = [0,1,2].map(axis=>{
        const coordinates = item.quads.flatMap(face=>face.points.map(point=>point[axis]));
        return [Math.min(...coordinates),Math.max(...coordinates)];
      });
      const center = bounds.map(([low,high])=>(low+high)*.5);
      const size = Math.max(1,...bounds.map(([low,high])=>high-low));
      for (const face of item.quads) quads.push({...face,
        points:face.points.map(point=>point.map((value,axis)=>(value-center[axis])/size))});
    }
  }
  if (!quads.length) {
    map = assets.terrain;
    addItemSprite(quads,map,tileUV(tiles.unknown,assets.rows));
  }
  return {map, quads, pose, handle};
}

function meshGeometry(quads) {
  const positions = [], colors = [], uvs = [], indices = [];
  for (const {points, uv, shade, tint = 0xffffff} of quads) {
    const color = new THREE.Color(tint).multiplyScalar(shade);
    const start = positions.length / 3;
    for (const point of points) {
      positions.push(...point);
      colors.push(color.r, color.g, color.b);
    }
    for (const [u,v] of uv) uvs.push(u,1-v);
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
  let luminous = false, pose = 'block', handle = [.25,.25];

  function show(held, assets, magic) {
    const nextKey = held && `${held.kind}:${held.key}:${held.part ? JSON.stringify(held.part) : ''}`;
    object.visible = Boolean(held && assets?.terrain);
    glow.visible = object.visible && magic !== null;
    if (!object.visible) return;
    if (key !== nextKey || currentAssets !== assets) {
      const next = appearance(held, assets);
      pose = next.pose;
      handle = next.handle ?? [.25,.25];
      mesh.geometry.dispose();
      mesh.geometry = glow.geometry = meshGeometry(next.quads);
      material.map = halo.map = next.map;
      halo.alphaTest = .2;
      material.needsUpdate = halo.needsUpdate = true;
      luminous = heldLightLevel(held) > 0;
      key = nextKey;
      currentAssets = assets;
    }
    if (glow.visible) halo.color.setHex(magic);
  }

  return {object, show, get pose() {return pose;},
    grip(inHoof) {
      if (inHoof && pose === 'tool') mesh.position.set(...handle,0);
      else mesh.position.set(0,0,0);
    },
    setLight(color) { material.color.setHex(luminous ? 0xffffff : color); }, dispose() {
    object.removeFromParent();
    mesh.geometry.dispose();
    material.dispose();
    halo.dispose();
  }};
}
