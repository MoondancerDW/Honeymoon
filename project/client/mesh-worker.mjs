import * as geometry from '/world/geometry.mjs';
import {decodeIndices} from './world-data.mjs';

const {shapeFor, ATLAS_GRID, TILE_SIZE, FACES} = geometry;
const SIDE = 18;
const STRIDE = [1, SIDE * SIDE, SIDE];
const NORMAL_SHADE = [.76, .76, .54, 1, .85, .85];
const MAX = ['x1', 'y1', 'z1'];
const MIN = ['x0', 'y0', 'z0'];
let cells = [];
let compositions = {};
const cache = new Map();

function layer() {
  return {positions: [], colors: [], uvs: [], indices: []};
}

function quad(out, corners, tile, uv, light, tint = 0xffffff) {
  const start = out.positions.length / 3;
  const u0 = (tile % ATLAS_GRID) / ATLAS_GRID;
  const v0 = 1 - Math.floor(tile / ATLAS_GRID) / ATLAS_GRID;
  const padding = .25 / TILE_SIZE;
  const scale = 1 - 2 * padding;
  const linear = value => value < .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  const r = Math.round(255 * light * linear(((tint >> 16) & 255) / 255));
  const g = Math.round(255 * light * linear(((tint >> 8) & 255) / 255));
  const b = Math.round(255 * light * linear((tint & 255) / 255));
  for (let i = 0; i < 4; i++) {
    out.positions.push(...corners[i]);
    out.colors.push(r, g, b);
    out.uvs.push(u0 + (padding + scale * uv[i][0]) / ATLAS_GRID, v0 - (padding + scale * uv[i][1]) / ATLAS_GRID);
  }
  out.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
}

const FULL_UV = [[0, 1], [1, 1], [1, 0], [0, 0]];

// Each face uses tangent axes whose cross product points outward.
const AXES = [[2, 1], [1, 2], [0, 2], [2, 0], [1, 0], [0, 1]];
const UV_AXES = [[2, 1], [2, 1], [0, 2], [0, 2], [0, 1], [0, 1]];

function faceQuad(out, box, face, origin, brightness, tile = box.faces[face]) {
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
    if ((face === 1 || face === 4) !== Boolean(box.mirrorU)) horizontal = 1 - horizontal;
    uv.push([horizontal, axis === 1 ? vertical : 1 - vertical]);
    corners.push(point.map((value, i) => value + origin[i]));
  }
  quad(out, corners, tile, uv, brightness, box.tintFaces?.[face] ?? box.tint);
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

function makeShape(index, at, cell, neighbors) {
  const key = cells[index];
  // Stairs and connected shapes can read neighboring cells. Include their face neighbors.
  const connected = geometry.shapeDependsOnNeighbors(key);
  if (!connected && !cell?.object && cache.has(index)) return cache.get(index);
  const boxes = shapeFor(cell || key, (dx, dy, dz) => neighbors(at + dx + dz * SIDE + dy * SIDE * SIDE));
  const shape = {boxes, full: boxes.find(fullCube)};
  if (!connected && !cell?.object) cache.set(index, shape);
  return shape;
}

function precise({indices, light, objects}) {
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
        const {boxes} = shape(at);
        const origin = [x, y, z];
        if (indexedObjects.has(at)) {
          const sign = geometry.signFor?.(cell(at));
          if (sign) signs.push({...sign, x: x + sign.x, y: y + sign.y, z: z + sign.z});
        }
        for (const box of boxes) {
          const out = layers[box.mode] || layers.opaque;
          if (box.kind === 'cross') {
            const shade = .38 + .62 * light[at] / 15;
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
            if (onEdge) {
              const neighbor = shape(adjacent)?.full;
              if (neighbor?.mode === 'opaque' ||
                  (neighbor && box.mode !== 'opaque' && indices[adjacent] === indices[at])) continue;
            }
            if (boxes.length > 1 && boxes.some(other => coversFace(other, box, f))) continue;
            const value = Math.max(light[at] || 0, light[adjacent] || 0);
            const brightness = box.emissive ? 1 : NORMAL_SHADE[f] * (.32 + .68 * (value / 15) ** 1.2);
            faceQuad(out, box, f, origin, brightness);
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
      faceQuad(layers.opaque, box, f, [localX, y, localZ], NORMAL_SHADE[f] * .91, shape.faces[f]);
    }
  }
  return {layers, signs: []};
}

self.onmessage = ({data}) => {
  if (data.type === 'init') {
    cells = data.palette;
    compositions = data.compositions;
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
      out.indices = out.positions.length / 3 <= 65535 ? new Uint16Array(out.indices) : new Uint32Array(out.indices);
      transfers.push(out.positions.buffer, out.uvs.buffer, out.colors.buffer, out.indices.buffer);
    }
    self.postMessage({id: data.id, version: data.version, layers, signs, elapsed: performance.now() - start}, transfers);
  } catch (error) {
    self.postMessage({id: data.id, version: data.version, error: error.stack || String(error)});
  }
};
