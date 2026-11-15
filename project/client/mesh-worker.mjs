import * as geometry from '/world/geometry.mjs';
import {decodeIndices} from './world-data.mjs';
import {CHISEL_FANTASY, chiselFantasyQuarters, glassTexture, paneTexture} from '/world/connected-textures.mjs';
import {coverShade, FACE_SHADE} from './lighting.mjs';
import {extractedModel, isJammyConnectableSeat} from '/world/extracted-models.mjs';
import {crossSpriteCorners} from '/world/cross-sprites.mjs';
import {isOpaqueFullVoxels, voxelFaces} from '/world/voxel-chisel.mjs';
import {buildSectionVisibility, isOcclusionBlock, markOcclusionBlock} from './section-visibility.mjs';

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
let atlasRows = ATLAS_GRID;
let carpentryModel = false;
const cache = new Map();
const MAX_CACHED_SHAPES = 4096;

function layer() {
  return {positions: [], colors: [], lightLevels: [], uvs: [], indices: []};
}

function quad(out, corners, tile, uv, light, tint = 0xffffff, shade = 1, padding = .25 / TILE_SIZE) {
  const start = out.positions.length / 3;
  if (tile >= ATLAS_GRID * atlasRows) tile = geometry.tiles.unknown;
  const u0 = (tile % ATLAS_GRID) / ATLAS_GRID;
  const v0 = 1 - Math.floor(tile / ATLAS_GRID) / atlasRows;
  const scale = 1 - 2 * padding;
  const r = Math.round((tint >> 16 & 255) * shade);
  const g = Math.round((tint >> 8 & 255) * shade);
  const b = Math.round((tint & 255) * shade);
  for (let i = 0; i < 4; i++) {
    out.positions.push(...corners[i]);
    out.colors.push(r, g, b);
    out.lightLevels.push(light);
    if (tile === null) out.uvs.push(uv[i][0],1-uv[i][1]);
    else out.uvs.push(u0 + (padding + scale * uv[i][0]) / ATLAS_GRID, v0 - (padding + scale * uv[i][1]) / atlasRows);
  }
  out.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
}

function modelQuad(out, {positions, uv, emissive, tint = 0xffffff}, origin, light, vScale = 1) {
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
    out.uvs.push(uv[i * 2], 1 - uv[i * 2 + 1] * vScale);
    out.colors.push(...color);
    out.lightLevels.push(emissive ? 256 : light);
  }
  out.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
}

const FULL_UV = [[0, 1], [1, 1], [1, 0], [0, 0]];
const FIRE_UV = [0,.5].map(offset => FULL_UV.map(([u,v]) => [offset + (u === 0 ? .25 : 15.75) / 32,v === 0 ? .25 / 16 : 15.75 / 16]));

// Each face uses tangent axes whose cross product points outward.
const AXES = [[2, 1], [1, 2], [0, 2], [2, 0], [1, 0], [0, 1]];
const UV_AXES = [[2, 1], [2, 1], [0, 2], [0, 2], [0, 1], [0, 1]];

function faceQuad(out, box, face, origin, brightness, tile = box.faces[face], shade = 1, quarter = -1) {
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
      let local = point;
      const localFace = box.redPowerFaces?.[face] ?? face;
      const localAxis = localFace >> 1;
      if (box.redPowerAxes) {
        local = [];
        for (const [i, component] of box.redPowerAxes.entries()) {
          // RenderContext.setSideUV insets each cropped face, preserving the
          // atlas texel at the edge of a narrow RedPower trace.
          const inset = point[i] - (box.redPowerOffset?.[i] ?? 0) + (point[i] === box[MIN[i]] ? .001 : -.001);
          local[Math.abs(component) - 1] = component > 0 ? inset : 1 - inset;
        }
      }
      horizontal = local[localAxis === 2 ? 0 : 2];
      if (localFace === 1 || localFace === 2 || localFace === 4) horizontal = 1 - horizontal;
      vertical = 1 - local[localAxis === 1 ? 0 : 1];
      const flags = box.redPowerUv[face];
      if (flags & 1) horizontal = 1 - horizontal;
      if (flags & 2) vertical = 1 - vertical;
      uv.push(flags & 4 ? [vertical, horizontal] : [horizontal, vertical]);
    } else {
      const textureY = axis === 1 ? vertical : 1 - vertical;
      let u = horizontal, v = textureY;
      if (box.paneCrosswiseUV) [u, v] = [v, 1 - u];
      if (face === 3 && box.bedFacing !== undefined) {
        [u, v] = [[v, u], [1 - u, v], [1 - v, 1 - u], [u, 1 - v]][box.bedFacing];
      }
      uv.push([u, v]);
      if (quarter >= 0) {
        // Subdivide a full cube face in texture order, preserving the vertex winding.
        const quarterU = ((quarter & 1) + horizontal) / 2;
        const quarterV = ((quarter >> 1) + textureY) / 2;
        point[textureU] = face === 1 || face === 4 ? 1 - quarterU : quarterU;
        point[textureV] = axis === 1 ? quarterV : 1 - quarterV;
      }
    }
    if (box.angle) {
      const [x, y, z] = [point[0] - .5, point[1], point[2] - .5];
      const sin = Math.sin(box.angle), cos = Math.cos(box.angle);
      corners.push([origin[0] + .5 + x * cos + z * sin, origin[1] + y, origin[2] + .5 + z * cos - x * sin]);
    } else {
      corners.push(point.map((value, i) => value + origin[i]));
    }
  }
  quad(out, corners, tile, uv, brightness, box.tintFaces?.[face] ?? box.tint, shade,
    box.redPowerAxes ? 0 : undefined);
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

function makeShape(key, at, cell, neighbors, edited) {
  // Stairs and connected shapes can read neighboring cells. Include their face neighbors.
  const connected = geometry.shapeDependsOnNeighbors(key) ||
    models.jammy?.models[key] && isJammyConnectableSeat(models.jammy, key);
  const cacheable = !connected && !cell?.object && !edited && !key.startsWith('cover:');
  if (cacheable && cache.has(key)) return cache.get(key);
  const adjacent = (dx, dy, dz) => neighbors(at + dx + dz * SIDE + dy * SIDE * SIDE);
  const model = extractedModel(models, cell || key, adjacent);
  const atlasModel = model || key.startsWith('legacy:1526:') && !carpentryModel ? null : geometry.sourceAtlasModel(key);
  const boxes = model || atlasModel ? [] : geometry.standingSignMesh(key) ??
    geometry.redPowerTubeMesh(cell || key, adjacent) ?? geometry.redPowerWireMesh(cell || key, adjacent) ??
    geometry.chestMesh(cell || key, adjacent) ??
    geometry.bedMesh(key) ??
    (cell?.voxels && cell.parts ? geometry.coverBoxes(cell.parts) : shapeFor(cell || key, adjacent));
  const shape = {boxes, model, atlasModel, full: boxes.find(fullCube)};
  if (cacheable) {
    if (cache.size >= MAX_CACHED_SHAPES) cache.delete(cache.keys().next().value);
    cache.set(key, shape);
  }
  return shape;
}

function precise({indices, light, objects, microblocks, sculpted, connectedTextures, chiselConnectedTextures,
  palette = cells, compositions: definitions = compositions, collectVisibility = false}) {
  const layers = {opaque: layer(), cutout: layer(), blend: layer()};
  const indexedObjects = new Map(objects);
  const editedParts = new Map(microblocks);
  const voxelCells = new Map(sculpted);
  const hasSculptures = voxelCells.size > 0;
  const rendered = new Map();
  const signs = [];
  const occlusionCells = collectVisibility ? new Uint8Array(16 ** 3) : null;
  let opaqueCells = 0;
  function cell(at) {
    const key = palette[indices[at]];
    if (!key || key === 'air') return null;
    const object = indexedObjects.get(at);
    const composition = definitions[key];
    const voxels = hasSculptures && voxelCells.get(at);
    const parts = editedParts.get(at);
    if (parts) return {key, ...composition, object, parts, voxels};
    if (voxels) return {key, voxels};
    return object || composition ? {key, ...composition, object} : key;
  }
  function shape(at) {
    if (!indices[at] || hasSculptures && voxelCells.has(at) && !editedParts.has(at)) return null;
    if (!rendered.has(at)) rendered.set(at, makeShape(palette[indices[at]], at, cell(at), cell, editedParts.has(at)));
    return rendered.get(at);
  }
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const at = (x + 1) + (z + 1) * SIDE + (y + 1) * SIDE * SIDE;
        if (!indices[at]) continue;
        const origin = [x, y, z];
        const voxels = hasSculptures && voxelCells.get(at);
        if (voxels) {
          const next = face => at + FACES[face][face >> 1] * STRIDE[face >> 1];
          const faces = voxelFaces(voxels, face => cell(next(face)), face => shape(next(face))?.full?.mode === 'opaque');
          for (const {box, face} of faces) {
            const axis = face >> 1;
            const boundary = face & 1 ? box[MAX[axis]] === 1 : box[MIN[axis]] === 0;
            const packed = light[boundary ? next(face) : at];
            const out = box.fluid === 'water' ? layers.water ??= layer() : layers[box.mode] ?? layers.opaque;
            faceQuad(out, box, face, origin, box.emissive ? 256 : packed,
              box.faces[face], box.emissive ? 1 : FACE_SHADE[face]);
          }
          if (!editedParts.get(at)?.length) continue;
        }
        const blockShape = shape(at);
        const {boxes, model, atlasModel} = blockShape;
        if (occlusionCells && !voxels && !editedParts.has(at)) {
          blockShape.occludes ??= boxes.length === 1 && isOcclusionBlock(blockShape.full);
          if (blockShape.occludes) {
            markOcclusionBlock(occlusionCells, x, y, z);
            opaqueCells++;
          }
        }
        if (atlasModel) {
          for (const surface of atlasModel) modelQuad(layers.cutout, surface, origin, light[at], ATLAS_GRID / atlasRows);
          continue;
        }
        if (model) {
          const shade = light[at];
          for (const surface of model.surfaces) {
            const mode = `${model.family}:${surface.mode ?? 'cutout'}`;
            modelQuad(layers[mode] ??= layer(), surface, origin, shade);
          }
          continue;
        }
        const blockKey = palette[indices[at]];
        const ctm = connectedTextures && (blockKey.startsWith('legacy:20:') || blockKey.startsWith('legacy:102:'));
        const chisel = chiselConnectedTextures && blockKey === CHISEL_FANTASY;
        const glass = ctm && blockKey.startsWith('legacy:20:');
        const water = waterKey(blockKey);
        const cover = blockKey === 'legacy:750:0' || blockKey.startsWith('cover:750:0:');
        const neighborLit = usesNeighborLight(blockKey);
        const neighbors = ctm || chisel ? (dx, dy, dz) => cell(at + dx + dz * SIDE + dy * SIDE * SIDE) : null;
        if (indexedObjects.has(at)) {
          const sign = geometry.signFor?.(cell(at));
          if (sign) signs.push({...sign, x: x + sign.x, y: y + sign.y, z: z + sign.z});
        }
        for (const box of boxes) {
          const pane = box.mode === 'pane';
          if (box.mode === 'fire') {
            const fire = layers.fire ??= layer();
            for (const [index,corners] of crossSpriteCorners(box,origin).entries()) {
              quad(fire,corners,null,FIRE_UV[index],256);
            }
            continue;
          }
          const out = pane ? layers.pane ??= layer() : water ? layers.water ??= layer() : layers[box.mode] || layers.opaque;
          if (box.kind === 'rail') {
            const corners = box.corners.map(([dx, dy, dz]) => [x + dx, y + dy, z + dz]);
            quad(out, corners, box.faces[0], box.uv, light[at]);
            quad(out, corners.toReversed(), box.faces[0], box.uv.toReversed(), light[at]);
            continue;
          }
          if (box.kind === 'cross') {
            for (const corners of crossSpriteCorners(box, origin)) {
              quad(out, corners, box.faces[0], FULL_UV, box.emissive ? 256 : light[at], box.tint);
            }
            continue;
          }
          for (let f = 0; f < 6; f++) {
            if (box.faces[f] === -1) continue;
            const axis = f >> 1;
            const adjacent = at + FACES[f][axis] * STRIDE[axis];
            if (pane) {
              const tile = ctm && box.paneBody ? paneTexture(f, neighbors) : box.faces[f];
              faceQuad(out, box, f, origin, light[at], tile);
              continue;
            }
            const onEdge = box.angle === undefined && !box.redPowerOffset && (f & 1 ? box[MAX[axis]] === 1 : box[MIN[axis]] === 0);
            if (water && (onEdge || f === 3) && waterKey(palette[indices[adjacent]])) continue;
            if (onEdge) {
              const neighbor = shape(adjacent)?.full;
              if (neighbor?.mode === 'opaque' || hasSculptures && isOpaqueFullVoxels(voxelCells.get(adjacent)) ||
                  (neighbor && box.mode !== 'opaque' && indices[adjacent] === indices[at])) continue;
            }
            if (boxes.length > 1 && boxes.some(other => coversFace(other, box, f))) continue;
            let packed = light[onEdge ? adjacent : at];
            if (onEdge && usesNeighborLight(palette[indices[adjacent]])) {
              const [dx, dy, dz] = FACES[f];
              packed = neighborLight(light, adjacent, x + 1 + dx, y + 1 + dy, z + 1 + dz);
            } else if (!onEdge && neighborLit) {
              packed = neighborLight(light, at, x + 1, y + 1, z + 1);
            }
            const lightOffset = box.chestLightOffset;
            const brightness = box.emissive ? 256 : box.redPowerLocalShade || box.chestLightOffset
              ? light[at + (lightOffset ? lightOffset[0] + lightOffset[2] * SIDE : 0)] : packed;
            const shade = box.emissive ? 1 : box.redPowerLocalShade?.[f] ?? FACE_SHADE[f] * (cover ? coverShade(light[adjacent]) : 1);
            if (chisel) {
              const tiles = chiselFantasyQuarters(f, neighbors);
              for (let quarter = 0; quarter < tiles.length; quarter++) {
                faceQuad(out, box, f, origin, brightness, tiles[quarter], shade, quarter);
              }
              continue;
            }
            let tile = box.faces[f];
            if (glass) tile = glassTexture(f, neighbors, Number(blockKey.slice(10))) ?? tile;
            faceQuad(out, box, f, origin, brightness, tile, shade);
          }
        }
      }
    }
  }
  const visibility = occlusionCells ? buildSectionVisibility(occlusionCells, opaqueCells) : null;
  return {layers, signs, visibility};
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
        if (!key || key === 'legacy:750:0' || key.startsWith('cover-material:')) continue;
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
  if (data.paletteAppend) for (const key of data.paletteAppend) cells.push(key);
  atlasRows = data.atlasRows ?? ATLAS_GRID;
  carpentryModel = data.carpentryModel === true;
  const start = performance.now();
  try {
    const {layers, signs, visibility} = data.type === 'precise' ? precise(data) : coarse(data);
    const transfers = [];
    let fitsSection = !signs.length;
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
      out.bounds = boundingSphere(out.positions);
      fitsSection &&= out.bounds.fitsSection;
      transfers.push(out.positions.buffer, out.uvs.buffer, out.colors.buffer, out.lightLevels.buffer, out.indices.buffer);
    }
    if (visibility) {
      transfers.push(visibility.links.buffer);
      if (visibility.cells) transfers.push(visibility.cells.buffer);
    }
    self.postMessage({id: data.id, version: data.version, layers, signs, visibility, fitsSection,
      visibilityClassified: data.collectVisibility === true,
      elapsed: performance.now() - start}, transfers);
  } catch (error) {
    self.postMessage({id: data.id, version: data.version, error: error.stack || String(error)});
  }
};

function boundingSphere(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const axis = i % 3;
    min[axis] = Math.min(min[axis], positions[i]);
    max[axis] = Math.max(max[axis], positions[i]);
  }
  const center = min.map((value, axis) => (value + max[axis]) / 2);
  const radius = Math.hypot(...max.map((value, axis) => value - center[axis]));
  return {center, radius, fitsSection:min.every((value, axis) => value >= 0 && max[axis] <= 16)};
}
