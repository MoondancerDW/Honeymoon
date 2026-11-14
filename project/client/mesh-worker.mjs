import * as geometry from '/world/geometry.mjs';
import {decodeIndices} from './world-data.mjs';
import {glassTexture, paneTexture} from '/world/connected-textures.mjs';
import {coverShade, FACE_SHADE} from './lighting.mjs';
import {extractedModel} from '/world/extracted-models.mjs';

const {shapeFor, ATLAS_GRID, TILE_SIZE, FACES} = geometry;
const SIDE = 18;
const STRIDE = [1, SIDE * SIDE, SIDE];
const waterKey = key => key?.startsWith('legacy:8:') || key?.startsWith('legacy:9:');
const usesNeighborLight = key => /^legacy:(44|53|67|108|109|113|114|126|128|134|135|136|156|4039):/.test(key ?? '');
const MAX = ['x1', 'y1', 'z1'];
const MIN = ['x0', 'y0', 'z0'];
let cells = [];
let compositions = {};
let models = {};
const cache = new Map();

function layer() {
  return {positions: [], colors: [], lightLevels: [], uvs: [], indices: []};
}

function quad(out, corners, tile, uv, light, tint = 0xffffff, shade = 1) {
  const start = out.positions.length / 3;
  const u0 = (tile % ATLAS_GRID) / ATLAS_GRID;
  const v0 = 1 - Math.floor(tile / ATLAS_GRID) / ATLAS_GRID;
  const padding = .25 / TILE_SIZE;
  const scale = 1 - 2 * padding;
  const r = Math.round((tint >> 16 & 255) * shade);
  const g = Math.round((tint >> 8 & 255) * shade);
  const b = Math.round((tint & 255) * shade);
  for (let i = 0; i < 4; i++) {
    out.positions.push(...corners[i]);
    out.colors.push(r, g, b);
    out.lightLevels.push(light);
    out.uvs.push(u0 + (padding + scale * uv[i][0]) / ATLAS_GRID, v0 - (padding + scale * uv[i][1]) / ATLAS_GRID);
  }
  out.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
}

function modelQuad(out, {positions, uv, emissive, tint = 0xffffff}, origin, light) {
  const start = out.positions.length / 3;
  const ax = positions[3] - positions[0], ay = positions[4] - positions[1], az = positions[5] - positions[2];
  const bx = positions[6] - positions[0], by = positions[7] - positions[1], bz = positions[8] - positions[2];
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const norm = Math.hypot(nx, ny, nz);
  if (norm < 1e-9) return;
  const shade = (Math.abs(nx) * FACE_SHADE[0] + Math.abs(nz) * FACE_SHADE[4]
    + Math.abs(ny) * FACE_SHADE[ny < 0 ? 2 : 3]) / (Math.abs(nx) + Math.abs(ny) + Math.abs(nz));
  const color = [tint >> 16 & 255, tint >> 8 & 255, tint & 255].map(channel => Math.round(channel * (emissive ? 1 : shade)));
  for (let i = 0; i < 4; i++) {
    out.positions.push(positions[i * 3] + origin[0], positions[i * 3 + 1] + origin[1], positions[i * 3 + 2] + origin[2]);
    out.uvs.push(uv[i * 2], 1 - uv[i * 2 + 1]);
    out.colors.push(...color);
    out.lightLevels.push(emissive ? 256 : light);
  }
  out.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
}

const FULL_UV = [[0, 1], [1, 1], [1, 0], [0, 0]];

// Each face uses tangent axes whose cross product points outward.
const AXES = [[2, 1], [1, 2], [0, 2], [2, 0], [1, 0], [0, 1]];
const UV_AXES = [[2, 1], [2, 1], [0, 2], [0, 2], [0, 1], [0, 1]];

function faceQuad(out, box, face, origin, brightness, tile = box.faces[face], shade = 1) {
  if (!Number.isInteger(tile) || tile < 0) return;
  const axis = face >> 1;
  const outward = face & 1;
  const [uAxis, vAxis] = AXES[face];
  const [textureU, textureV] = UV_AXES[face];
  const corners = [];
  const uv = [];
  for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
    const point = [0, 0, 0];
    point[axis] = box[outward ? MAX[axis] : MIN[axis]];
    point[uAxis] = box[u ? MAX[uAxis] : MIN[uAxis]];
    point[vAxis] = box[v ? MAX[vAxis] : MIN[vAxis]];
    let horizontal = point[textureU];
    let vertical = point[textureV];
    if (box.uv === 'box') {
      horizontal = (horizontal - box[MIN[textureU]]) / (box[MAX[textureU]] - box[MIN[textureU]]);
      vertical = (vertical - box[MIN[textureV]]) / (box[MAX[textureV]] - box[MIN[textureV]]);
    }
    if ((face === 1 || face === 4) !== Boolean(box.mirrorFaces?.[face] ?? box.mirrorU)) horizontal = 1 - horizontal;
    if (box.redPowerUv) {
      // RedPower takes the top and bottom U axis from Z.
      if (axis === 1) horizontal = outward ? point[2] : 1 - point[2];
      vertical = 1 - point[axis === 1 ? 0 : 1];
      const flags = box.redPowerUv[face];
      if (flags & 1) horizontal = 1 - horizontal;
      if (flags & 2) vertical = 1 - vertical;
      uv.push(flags & 4 ? [vertical, horizontal] : [horizontal, vertical]);
    } else {
      uv.push([horizontal, axis === 1 ? vertical : 1 - vertical]);
    }
    corners.push(point.map((value, i) => value + origin[i]));
  }
  quad(out, corners, tile, uv, brightness, box.tintFaces?.[face] ?? box.tint, shade);
}

function fullCube(box) {
  return box.kind !== 'cross' && MIN.every((axis, i) => box[axis] === 0 && box[MAX[i]] === 1);
}

function coversFace(other, box, face) {
  if (other === box || other.kind === 'cross' || other.mode !== 'opaque') return false;
  const axis = face >> 1;
  const boundary = face & 1 ? box[MAX[axis]] : box[MIN[axis]];
  if (face & 1 ? other[MIN[axis]] > boundary || other[MAX[axis]] <= boundary
    : other[MAX[axis]] < boundary || other[MIN[axis]] >= boundary) return false;
  return AXES[face].every(i => other[MIN[i]] <= box[MIN[i]] && other[MAX[i]] >= box[MAX[i]]);
}

function neighborLight(light, at, x, y, z) {
  let sky = light[at] >> 4, block = light[at] & 15;
  const samples = [y < SIDE - 1 ? at + STRIDE[1] : at, x > 0 ? at - 1 : at,
    x < SIDE - 1 ? at + 1 : at, z > 0 ? at - SIDE : at, z < SIDE - 1 ? at + SIDE : at];
  for (const sample of samples) {
    sky = Math.max(sky, light[sample] >> 4);
    block = Math.max(block, light[sample] & 15);
  }
  return sky << 4 | block;
}

function makeShape(index, at, cell, neighbors) {
  const key = cells[index];
  // Stairs and connected shapes can read neighboring cells. Include their face neighbors.
  const connected = geometry.shapeDependsOnNeighbors(key);
  if (!connected && !cell?.object && cache.has(index)) return cache.get(index);
  const model = extractedModel(models, cell || key);
  const boxes = model ? [] : shapeFor(cell || key, (dx, dy, dz) => neighbors(at + dx + dz * SIDE + dy * SIDE * SIDE));
  const shape = {boxes, model, full: boxes.find(fullCube)};
  if (!connected && !cell?.object) cache.set(index, shape);
  return shape;
}

function precise({indices, light, objects, connectedTextures}) {
  const layers = {opaque: layer(), cutout: layer(), blend: layer()};
  const indexedObjects = new Map(objects);
  const rendered = new Map();
  const signs = [];
  function cell(at) {
    const key = cells[indices[at]];
    if (!key || key === 'air') return null;
    const object = indexedObjects.get(at);
    const composition = compositions[key];
    return object || composition ? {key, ...composition, object} : key;
  }
  function shape(at) {
    if (!indices[at]) return null;
    if (!rendered.has(at)) rendered.set(at, makeShape(indices[at], at, cell(at), cell));
    return rendered.get(at);
  }
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const at = (x + 1) + (z + 1) * SIDE + (y + 1) * SIDE * SIDE;
        if (!indices[at]) continue;
        const {boxes, model} = shape(at);
        const origin = [x, y, z];
        if (model) {
          const shade = light[at];
          for (const surface of model.surfaces) {
            const mode = `${model.family}:${surface.mode ?? 'cutout'}`;
            modelQuad(layers[mode] ??= layer(), surface, origin, shade);
          }
          continue;
        }
        const blockKey = cells[indices[at]];
        const ctm = connectedTextures && (blockKey.startsWith('legacy:20:') || blockKey.startsWith('legacy:102:'));
        const glass = ctm && blockKey.startsWith('legacy:20:');
        const water = waterKey(blockKey);
        const cover = blockKey.startsWith('cover:750:0:');
        const neighborLit = usesNeighborLight(blockKey);
        const neighbors = ctm ? (dx, dy, dz) => cell(at + dx + dz * SIDE + dy * SIDE * SIDE) : null;
        if (indexedObjects.has(at)) {
          const sign = geometry.signFor?.(cell(at));
          if (sign) signs.push({...sign, x: x + sign.x, y: y + sign.y, z: z + sign.z});
        }
        for (const box of boxes) {
          const out = layers[box.mode] || layers.opaque;
          if (box.kind === 'cross') {
            const shade = light[at];
            const a = x + box.x0, b = x + box.x1, c = y + box.y0, d = y + box.y1;
            const e = z + box.z0, f = z + box.z1;
            quad(out, [[a,c,e],[b,c,f],[b,d,f],[a,d,e]], box.faces[0], FULL_UV, shade, box.tint);
            quad(out, [[a,c,f],[b,c,e],[b,d,e],[a,d,f]], box.faces[0], FULL_UV, shade, box.tint);
            continue;
          }
          for (let f = 0; f < 6; f++) {
            const axis = f >> 1;
            const adjacent = at + FACES[f][axis] * STRIDE[axis];
            const onEdge = f & 1 ? box[MAX[axis]] === 1 : box[MIN[axis]] === 0;
            if (water && (onEdge || f === 3) && waterKey(cells[indices[adjacent]])) continue;
            if (onEdge) {
              const neighbor = shape(adjacent)?.full;
              if (neighbor?.mode === 'opaque' ||
                  (neighbor && box.mode !== 'opaque' && indices[adjacent] === indices[at])) continue;
            }
            if (boxes.length > 1 && boxes.some(other => coversFace(other, box, f))) continue;
            let packed = light[onEdge ? adjacent : at];
            if (onEdge && usesNeighborLight(cells[indices[adjacent]])) {
              const [dx, dy, dz] = FACES[f];
              packed = neighborLight(light, adjacent, x + 1 + dx, y + 1 + dy, z + 1 + dz);
            } else if (!onEdge && neighborLit) {
              packed = neighborLight(light, at, x + 1, y + 1, z + 1);
            }
            const brightness = box.emissive ? 256 : packed;
            const shade = box.emissive ? 1 : FACE_SHADE[f] * (cover ? coverShade(light[adjacent]) : 1);
            let tile = box.faces[f];
            if (glass) tile = glassTexture(f, neighbors, Number(blockKey.slice(10))) ?? tile;
            else if (ctm && axis !== 1) {
              const alongX = box.x1 - box.x0 > box.z1 - box.z0;
              if (axis === (alongX ? 2 : 0)) tile = paneTexture(f, neighbors) ?? tile;
            }
            faceQuad(out, box, f, origin, brightness, tile, shade);
          }
        }
      }
    }
  }
  return {layers, signs};
}

function coarse({chunks, origin, stride}) {
  const layers = {opaque: layer()};
  const representatives = new Map();
  const lookup = new Map();
  const blocks = [];
  for (const {chunk, palette} of chunks) {
    for (const level of chunk.levels) {
      const indices = decodeIndices(level.indices);
      for (let i = 0; i < indices.length; i++) {
        if (!indices[i]) continue;
        const key = palette[indices[i]];
        if (!representatives.has(key)) representatives.set(key, shapeFor(key)[0] || null);
        const shape = representatives.get(key);
        if (!shape || shape.faces.every(tile => tile < 0)) continue;
        const x = chunk.x * 16 + (i & 3) * stride;
        const y = level.y * 16 + (i >> 4) * stride;
        const z = chunk.z * 16 + ((i >> 2) & 3) * stride;
        lookup.set(x + ',' + y + ',' + z, shape);
        blocks.push([x, y, z, shape]);
      }
    }
  }
  const box = {x0: 0, y0: 0, z0: 0, x1: stride, y1: stride, z1: stride, uv: 'box'};
  for (const [x, y, z, shape] of blocks) {
    const localX = x - origin[0], localZ = z - origin[2];
    if (localX < 0 || localX >= 64 || localZ < 0 || localZ >= 64) continue;
    box.tint = shape.tint;
    for (let f = 0; f < 6; f++) {
      const [dx, dy, dz] = FACES[f];
      if (lookup.has((x + dx * stride) + ',' + (y + dy * stride) + ',' + (z + dz * stride))) continue;
      faceQuad(layers.opaque, box, f, [localX, y, localZ], 240, shape.faces[f], FACE_SHADE[f]);
    }
  }
  return {layers, signs: []};
}

self.onmessage = ({data}) => {
  if (data.type === 'init') {
    cells = data.palette;
    compositions = data.compositions;
    models = data.models || {};
    return;
  }
  if (data.palette) cells = data.palette;
  const start = performance.now();
  try {
    const {layers, signs} = data.type === 'precise' ? precise(data) : coarse(data);
    const transfers = [];
    for (const [mode, out] of Object.entries(layers)) {
      if (!out.indices.length) {
        delete layers[mode];
        continue;
      }
      out.positions = new Float32Array(out.positions);
      out.uvs = new Float32Array(out.uvs);
      out.colors = new Uint8Array(out.colors);
      out.lightLevels = new Uint16Array(out.lightLevels);
      out.indices = out.positions.length / 3 <= 65535 ? new Uint16Array(out.indices) : new Uint32Array(out.indices);
      transfers.push(out.positions.buffer, out.uvs.buffer, out.colors.buffer, out.lightLevels.buffer, out.indices.buffer);
    }
    self.postMessage({id: data.id, version: data.version, layers, signs, elapsed: performance.now() - start}, transfers);
  } catch (error) {
    self.postMessage({id: data.id, version: data.version, error: error.stack || String(error)});
  }
};
