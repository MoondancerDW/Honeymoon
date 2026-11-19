import * as geometry from '/world/geometry.mjs';
import {decodeIndices} from './world-data.mjs';
import {CHISEL_FANTASY, chiselFantasyQuarters, glassTexture, paneTexture} from '/world/connected-textures.mjs';
import {contactShade, FACE_SHADE, averageLight} from './lighting.mjs';
import {extractedModel, isJammyConnectableSeat} from '/world/extracted-models.mjs';
import {crossSpriteCorners} from '/world/cross-sprites.mjs';
import {isOpaqueFullVoxels, voxelFaces} from '/world/voxel-chisel.mjs';
import {clipLiquidFace, liquidCavity, liquidKind} from '/world/logged-fluid.mjs';
import {FAKE_WATER,fluidState,fluidSurface} from '/world/fluid-state.mjs';
import {buildSectionVisibility, isOcclusionBlock, markOcclusionBlock} from './section-visibility.mjs';
import {appendFoliage,leafBlock} from './foliage-mesh.mjs';
import {isTreeLog, joinsLogEnds, logAxis, roundedLogSurfaces} from './rounded-logs.mjs';
import {blockFaceVertices,boxFaceFragments,canClipBoxFace} from '/world/block-faces.mjs';

const {shapeFor, ATLAS_GRID, TILE_SIZE, FACES} = geometry;
const SIDE = 18;
const STRIDE = [1, SIDE * SIDE, SIDE];
const waterKey = key => key === FAKE_WATER || key?.startsWith('legacy:8:') || key?.startsWith('legacy:9:');
const usesNeighborLight = key => /^legacy:(44|53|67|108|109|113|114|126|128|134|135|136|156|4039):/.test(key ?? '');
const MAX = ['x1', 'y1', 'z1'];
const MIN = ['x0', 'y0', 'z0'];
let cells = [];
let compositions = {};
let models = {};
let atlasRows = ATLAS_GRID;
let carpentryModel = false;
const cache = new Map();
const uniqueModels = new WeakMap();
const MAX_CACHED_SHAPES = 4096;

function layer() {
  return {positions: [], colors: [], lightLevels: [], uvs: [], indices: []};
}

function quad(out, corners, tile, uv, light, tint = 0xffffff, shade = 1, padding = .25 / TILE_SIZE, shadow, wind = 0, foliageSlot = 0) {
  const start = out.positions.length / 3;
  if (wind && out.windMarks) {
    if (wind < 0) out.windMarks.push(start,-wind,start+1,-wind,start+2,-wind,start+3,-wind);
    else out.windMarks.push(start+2,wind,start+3,wind);
  }
  if (foliageSlot && out.foliageMarks) out.foliageMarks.push(start,foliageSlot);
  if (tile >= ATLAS_GRID * atlasRows) tile = geometry.tiles.unknown;
  const u0 = (tile % ATLAS_GRID) / ATLAS_GRID;
  const v0 = 1 - Math.floor(tile / ATLAS_GRID) / atlasRows;
  const scale = 1 - 2 * padding;
  const r = Math.round((tint >> 16 & 255) * shade);
  const g = Math.round((tint >> 8 & 255) * shade);
  const b = Math.round((tint & 255) * shade);
  const perCorner = Array.isArray(light);
  for (let i = 0; i < 4; i++) {
    out.positions.push(...corners[i]);
    if (shadow) out.colors.push(Math.round(r * shadow[i]), Math.round(g * shadow[i]), Math.round(b * shadow[i]));
    else out.colors.push(r, g, b);
    out.lightLevels.push(perCorner ? light[i] : light);
    if (tile === null) out.uvs.push(uv[i][0],1-uv[i][1]);
    else out.uvs.push(u0 + (padding + scale * uv[i][0]) / ATLAS_GRID, v0 - (padding + scale * uv[i][1]) / atlasRows);
  }
  if (shadow && shadow[0] + shadow[2] > shadow[1] + shadow[3]) {
    out.indices.push(start, start + 1, start + 3, start + 1, start + 2, start + 3);
  } else out.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
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

function uniqueModelFaces(surfaces) {
  const cached=uniqueModels.get(surfaces);
  if (cached) return cached;
  const seen=new Set();
  const result=surfaces.filter(surface=>{
    if (surface.mode!=='opaque') return true;
    const vertices=Array.from({length:4},(_,i)=>surface.positions.slice(i*3,i*3+3)
      .map(value=>Math.round(value*1e6)).join(','));
    const key=vertices.map((_,i)=>vertices.slice(i).concat(vertices.slice(0,i)).join(':')).sort()[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  uniqueModels.set(surfaces,result);
  return result;
}

const FULL_UV = [[0, 1], [1, 1], [1, 0], [0, 0]];
const FIRE_UV = [0,.5].map(offset => FULL_UV.map(([u,v]) => [offset + (u === 0 ? .25 : 15.75) / 32,v === 0 ? .25 / 16 : 15.75 / 16]));

function torchQuads(out, box, [x,y,z], packed) {
  // The legacy model uses the whole cutout for its sides and two 2px caps.
  // The mount slopes the plane from the attachment face toward the flame.
  const [dx,dz] = box.torchMount;
  function point(u, v, h) {
    const lean = .1 + .4 * (1 - h);
    return [x + u + dx * lean, y + box.y0 + h, z + v + dz * lean];
  }
  const left = 7 / 16, right = 9 / 16, cap = 10 / 16;
  const tile = box.faces[0], light = box.emissive ? 256 : packed;
  const top = [[left,left], [left,right], [right,right], [right,left]];
  quad(out, top.map(([u,v]) => point(u,v,cap)), tile,
    top.map(([u,v]) => [u, v - 1 / 16]), light);
  quad(out, top.toReversed().map(([u,v]) => point(u,v,0)), tile,
    top.toReversed().map(([u,v]) => [u, v + 6 / 16]), light);
  for (const [[u0,v0], [u1,v1]] of [
    [[left,0], [left,1]], [[right,1], [right,0]], [[0,right], [1,right]], [[1,left], [0,left]],
  ]) {
    quad(out, [point(u0,v0,0), point(u1,v1,0), point(u1,v1,1), point(u0,v0,1)], tile, FULL_UV, light);
  }
}

// Each face uses tangent axes whose cross product points outward.
const AXES = [[2, 1], [1, 2], [0, 2], [2, 0], [1, 0], [0, 1]];
const FACE_OFFSETS = FACES.map((normal, face) => normal[face >> 1] * STRIDE[face >> 1]);
const NOT_A_LOG = -2;

function interpolateFace([a, b, c, d], u, v) {
  return (a + (b - a) * u) * (1 - v) + (d + (c - d) * u) * v;
}

function faceQuad(out, box, face, origin, brightness, tile = box.faces[face], shade = 1, quarter = -1, shadow,
  tint = box.tintFaces?.[face] ?? box.tint, wind = 0, fragment=box) {
  if (!Number.isInteger(tile) || tile < 0) return;
  const [uAxis, vAxis] = AXES[face];
  const {points,uv} = blockFaceVertices(box,face,quarter,fragment);
  const corners = points.map(([x,y,z])=>[x+origin[0],y+origin[1],z+origin[2]]);
  let vertexShade = shadow;
  let vertexLight = brightness;
  const croppedFace = !box.angle &&
    (fragment[MIN[uAxis]] !== 0 || fragment[MAX[uAxis]] !== 1 || fragment[MIN[vAxis]] !== 0 || fragment[MAX[vAxis]] !== 1);
  if ((quarter >= 0 || croppedFace) && (shadow || Array.isArray(brightness))) {
    const sample = (levels, point) => {
      const u = point[uAxis] - origin[uAxis], v = point[vAxis] - origin[vAxis];
      return interpolateFace(levels, u, v);
    };
    if (shadow) vertexShade = corners.map(point => sample(shadow, point));
    if (Array.isArray(brightness)) {
      const sky = brightness.map(value => value >> 4), block = brightness.map(value => value & 15);
      vertexLight = corners.map(point => Math.round(sample(sky,point)) << 4 | Math.round(sample(block,point)));
    }
  }
  quad(out,corners,tile,uv,vertexLight,tint,shade,box.redPowerAxes ? 0 : undefined,vertexShade,wind);
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

function precise({indices, light, objects, microblocks, sculpted, logged, connectedTextures, chiselConnectedTextures,
  palette = cells, compositions: definitions = compositions, collectVisibility = false, foliage, biomeTints}) {
  const layers = {opaque: layer(), cutout: layer(), blend: layer()};
  if (foliage) layers.cutout.windMarks = [];
  const indexedObjects = new Map(objects);
  const editedParts = new Map(microblocks);
  const voxelCells = new Map(sculpted);
  const loggedCells = logged?.length ? new Map(logged) : null;
  const liquidVolumes = new Map();
  const hasSculptures = voxelCells.size > 0;
  const rendered = new Map();
  const logPalette = new Uint8Array(palette.length);
  const signs = [];
  const occlusionCells = collectVisibility ? new Uint8Array(16 ** 3) : null;
  let opaqueCells = 0;
  let roundedLogs = 0;
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
  function logAt(at, knownShape) {
    const index = indices[at];
    if (!index) return NOT_A_LOG;
    logPalette[index] ||= isTreeLog(palette[index]) ? 2 : 1;
    if (logPalette[index] === 1 || editedParts.has(at) || hasSculptures && voxelCells.has(at)) return NOT_A_LOG;
    const block = knownShape ?? shape(at);
    if (block?.boxes.length !== 1 || block.full?.mode !== 'opaque' || !block.full.solid) return NOT_A_LOG;
    return block.logAxis ??= logAxis(block.full.faces);
  }
  function roundsHere(at, axis) {
    return axis >= 0 && FACE_OFFSETS.every((offset, face) => {
      const neighborAxis = logAt(at + offset);
      return neighborAxis === NOT_A_LOG || joinsLogEnds(axis, neighborAxis, face);
    });
  }
  function opaqueVoxels(at) {
    return hasSculptures && isOpaqueFullVoxels(voxelCells.get(at));
  }
  function fullNeighborFace(at, axis, face, block = shape(at)) {
    if (opaqueVoxels(at)) return true;
    if (block?.full?.mode !== 'opaque') return false;
    const adjacentLog = logAt(at, block);
    // Only one cell of neighboring terrain is available. Keep the face behind
    // a potentially beveled log so a corner still has a surface to look onto.
    return adjacentLog < 0 || axis !== NOT_A_LOG && !joinsLogEnds(axis, adjacentLog, face);
  }
  const offsetCell = at => (dx, dy, dz) => cell(at + dx + dz * SIDE + dy * SIDE * SIDE);
  function openVolume(at) {
    if (!liquidVolumes.has(at)) liquidVolumes.set(at, liquidCavity(cell(at), offsetCell(at), models));
    return liquidVolumes.get(at);
  }
  function liquidObstacles(at, kind) {
    const block = shape(at);
    const neighboringLiquid = liquidKind(palette[indices[at]]);
    if (neighboringLiquid === kind || neighboringLiquid === 'lava' && kind === 'water') return block?.boxes ?? [];
    const boxes = block?.model?.collision ?? block?.boxes ?? [];
    const solid = boxes.filter(box => box.mode === 'opaque' && box.solid !== false && !box.kind && box.angle === undefined);
    if (isOpaqueFullVoxels(voxelCells.get(at))) solid.push({x0:0, y0:0, z0:0, x1:1, y1:1, z1:1});
    const nearby = loggedCells?.get(at);
    return nearby === kind || nearby === 'lava' && kind === 'water' ? [...solid, ...openVolume(at)] : solid;
  }
  const shadowCells = new Uint8Array(indices.length);
  function castsContactShade(at) {
    if (!indices[at]) return 0;
    if (!shadowCells[at]) {
      const block = shape(at);
      const solid = block?.boxes.length === 1 && isOcclusionBlock(block.full) ||
        hasSculptures && isOpaqueFullVoxels(voxelCells.get(at));
      if (solid) shadowCells[at] = 255;
      else {
        let volume = 0;
        for (const box of block?.boxes ?? []) {
          if (box.solid && box.mode === 'opaque' && !box.kind) {
            volume += (box.x1-box.x0)*(box.y1-box.y0)*(box.z1-box.z0);
          }
        }
        shadowCells[at] = 1 + Math.round(200*Math.sqrt(Math.min(1,volume)));
      }
    }
    return (shadowCells[at]-1)/254;
  }
  function faceLighting(adjacent, face, center) {
    const [uAxis, vAxis] = AXES[face];
    const u = STRIDE[uAxis], v = STRIDE[vAxis];
    const u0 = castsContactShade(adjacent - u), u1 = castsContactShade(adjacent + u);
    const v0 = castsContactShade(adjacent - v), v1 = castsContactShade(adjacent + v);
    const a = castsContactShade(adjacent - u - v), b = castsContactShade(adjacent + u - v);
    const c = castsContactShade(adjacent + u + v), d = castsContactShade(adjacent - u + v);
    const left = u0 === 1 ? center : light[adjacent - u], right = u1 === 1 ? center : light[adjacent + u];
    const bottom = v0 === 1 ? center : light[adjacent - v], top = v1 === 1 ? center : light[adjacent + v];
    const bottomLeft = a === 1 || u0 === 1 && v0 === 1 ? center : light[adjacent - u - v];
    const bottomRight = b === 1 || u1 === 1 && v0 === 1 ? center : light[adjacent + u - v];
    const topRight = c === 1 || u1 === 1 && v1 === 1 ? center : light[adjacent + u + v];
    const topLeft = d === 1 || u0 === 1 && v1 === 1 ? center : light[adjacent - u + v];
    const uniform = left === center && right === center && bottom === center && top === center &&
      bottomLeft === center && bottomRight === center && topRight === center && topLeft === center;
    const shadow = u0 || u1 || v0 || v1 || a || b || c || d
      ? [contactShade(u0,v0,a), contactShade(u1,v0,b), contactShade(u1,v1,c), contactShade(u0,v1,d)] : undefined;
    if (uniform) return shadow ? {shadow} : null;
    return {shadow, levels:[
      averageLight(center,left,bottom,bottomLeft), averageLight(center,right,bottom,bottomRight),
      averageLight(center,right,top,topRight), averageLight(center,left,top,topLeft),
    ]};
  }
  function emitRoundedLog(box, axis, at, origin) {
    const samples = FACE_OFFSETS.map((offset, face) => {
      const adjacent = at + offset;
      const [dx, dy, dz] = FACES[face];
      const brightness = box.emissive ? 256 : usesNeighborLight(palette[indices[adjacent]]) ?
        neighborLight(light, adjacent, origin[0] + 1 + dx, origin[1] + 1 + dy, origin[2] + 1 + dz) : light[adjacent];
      const smooth = box.emissive ? null : faceLighting(adjacent, face, brightness);
      const {uv} = blockFaceVertices(box, face);
      return {
        covered: shape(adjacent)?.full?.mode === 'opaque' || opaqueVoxels(adjacent),
        textureU: uv.map(point => point[0]),
        textureV: uv.map(point => point[1]),
        brightness,
        shadow: smooth?.shadow,
        sky: smooth?.levels?.map(value => value >> 4),
        block: smooth?.levels?.map(value => value & 15),
      };
    });
    function lighting(face, point) {
      const sample = samples[face];
      const [uAxis, vAxis] = AXES[face];
      const u = point[uAxis], v = point[vAxis];
      const packed = sample.sky ?
        Math.round(interpolateFace(sample.sky, u, v)) << 4 | Math.round(interpolateFace(sample.block, u, v)) :
        sample.brightness;
      return [packed, sample.shadow ? interpolateFace(sample.shadow, u, v) : 1];
    }
    for (const {face, bevel, points} of roundedLogSurfaces[axis]) {
      if (bevel === undefined && samples[face].covered) continue;
      const [uAxis, vAxis] = AXES[face];
      const {textureU, textureV} = samples[face];
      const uv = points.map(point => [
        interpolateFace(textureU, point[uAxis], point[vAxis]),
        interpolateFace(textureV, point[uAxis], point[vAxis]),
      ]);
      const colors = points.map(point => {
        const [packed, shadow] = lighting(face, point);
        if (bevel === undefined || box.emissive) return [packed, shadow];
        const [otherPacked, otherShadow] = lighting(bevel, point);
        return [averageLight(packed, packed, otherPacked, otherPacked), (shadow + otherShadow) * .5];
      });
      const shade = box.emissive ? 1 : bevel === undefined ? FACE_SHADE[face] : (FACE_SHADE[face] + FACE_SHADE[bevel]) * .5;
      quad(layers.opaque, points.map(point => point.map((coordinate, i) => coordinate + origin[i])),
        box.faces[face], uv, colors.map(color => color[0]), box.tintFaces?.[face] ?? box.tint, shade,
        undefined, colors.map(color => color[1]));
    }
  }
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const at = (x + 1) + (z + 1) * SIDE + (y + 1) * SIDE * SIDE;
        if (!indices[at]) continue;
        const origin = [x, y, z];
        const loggedKind = loggedCells?.get(at);
        if (loggedKind) {
          const volume = openVolume(at);
          const lava = loggedKind === 'lava';
          const out = lava ? layers.opaque : layers.water ??= layer();
          const tile = lava ? geometry.tiles.lava : geometry.tiles.water;
          for (let face = 0; face < 6; face++) {
            const axis = face >> 1;
            const edge = face & 1 ? MAX[axis] : MIN[axis];
            const boundary = volume.filter(box => box[edge] === (face & 1));
            if (!boundary.length) continue;
            const adjacent = at + FACES[face][axis] * STRIDE[axis];
            const obstacles = liquidObstacles(adjacent, loggedKind);
            for (const box of boundary) {
              for (const piece of clipLiquidFace(box, face, obstacles)) {
                faceQuad(out, piece, face, origin, lava ? 256 : light[at], tile, lava ? 1 : FACE_SHADE[face]);
              }
            }
          }
        }
        const voxels = hasSculptures && voxelCells.get(at);
        if (voxels) {
          const next = face => at + FACES[face][face >> 1] * STRIDE[face >> 1];
          const faces = voxelFaces(voxels, face => cell(next(face)), face => fullNeighborFace(next(face), NOT_A_LOG, face));
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
        const treeAxis = logAt(at, blockShape);
        if (roundsHere(at, treeAxis)) {
          emitRoundedLog(blockShape.full, treeAxis, at, origin);
          roundedLogs++;
          continue;
        }
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
          for (const surface of uniqueModelFaces(model.surfaces)) {
            const mode = `${model.family}:${surface.mode ?? 'cutout'}`;
            modelQuad(layers[mode] ??= layer(), surface, origin, shade);
          }
          continue;
        }
        const blockKey = palette[indices[at]];
        const isGrass=blockKey.startsWith('legacy:2:');
        const isTallGrass=blockKey.startsWith('legacy:31:');
        const isLeaf=leafBlock(blockKey);
        const isVine=blockKey.startsWith('legacy:106:');
        const biomeIndex=(z*16+x)*2;
        const leafSpecies=blockKey.startsWith('legacy:18:') ? Number(blockKey.slice(10))&3 : -1;
        const leafTint=leafSpecies===0 || leafSpecies===3 || isVine ? biomeTints?.[biomeIndex+1] : undefined;
        const ctm = connectedTextures && (blockKey.startsWith('legacy:20:') || blockKey.startsWith('legacy:102:'));
        const chisel = chiselConnectedTextures && blockKey === CHISEL_FANTASY;
        const glass = ctm && blockKey.startsWith('legacy:20:');
        const water = waterKey(blockKey);
        const neighborLit = usesNeighborLight(blockKey);
        const neighbors = ctm || chisel ? (dx, dy, dz) => cell(at + dx + dz * SIDE + dy * SIDE * SIDE) : null;
        if (indexedObjects.has(at)) {
          const sign = geometry.signFor?.(cell(at));
          if (sign) signs.push({...sign, x: x + sign.x, y: y + sign.y, z: z + sign.z});
        }
        for (let boxIndex=0; boxIndex<boxes.length; boxIndex++) {
          let box=boxes[boxIndex];
          const fluid = !box.solid && liquidKind(blockKey);
          if (fluid && boxes.length === 1) {
            function corner(sx,sz) {
              const sideX=sx*STRIDE[0], sideZ=sz*STRIDE[2];
              let sum=0, mass=0;
              for (const offset of [0,sideX,sideZ,sideX+sideZ]) {
                const other = fluidState(palette[indices[at+offset]]);
                if (other?.kind !== fluid) continue;
                const height=fluidSurface(other,fluidState(palette[indices[at+offset+STRIDE[1]]]));
                if (height === 1) return 1;
                const weight = height >= .8 ? 5 : 1;
                sum+=height*weight;
                mass+=weight;
              }
              return mass ? sum/mass : box.y1;
            }
            box={...box,liquidSurface:[corner(-1,-1),corner(1,-1),corner(-1,1),corner(1,1)]};
          }
          const pane = box.mode === 'pane';
          if (box.mode === 'fire') {
            const fire = layers.fire ??= layer();
            for (const [index,corners] of crossSpriteCorners(box,origin).entries()) {
              quad(fire,corners,null,FIRE_UV[index],256);
            }
            continue;
          }
          const out = pane ? layers.pane ??= layer() : water ? layers.water ??= layer() : layers[box.mode] || layers.opaque;
          if (box.torchMount) {
            torchQuads(out, box, origin, light[at]);
            continue;
          }
          if (box.kind === 'rail' || box.kind === 'strip') {
            const corners = box.corners.map(([dx, dy, dz]) => [x + dx, y + dy, z + dz]);
            quad(out, corners, box.faces[0], box.uv, light[at]);
            quad(out, corners.toReversed(), box.faces[0], box.uv.toReversed(), light[at]);
            continue;
          }
          if (box.kind === 'cross') {
            const wind = blockKey.startsWith('legacy:30:') || box.emissive ? 0 : isTallGrass ? 185 : 120;
            const tint=isTallGrass ? biomeTints?.[biomeIndex] ?? box.tint : box.tint;
            for (const corners of crossSpriteCorners(box, origin)) {
              quad(out, corners, box.faces[0], FULL_UV, box.emissive ? 256 : light[at], tint,
                1,undefined,undefined,wind);
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
            if (fluid && (onEdge || f === 3) && liquidKind(palette[indices[adjacent]]) === fluid) continue;
            const neighbor=onEdge?shape(adjacent):null;
            if (onEdge) {
              if (fullNeighborFace(adjacent, treeAxis, f, neighbor) ||
                  (neighbor?.full && box.mode !== 'opaque' && indices[adjacent] === indices[at])) continue;
            }
            const neighborBoxes=neighbor?.boxes.length && neighbor.full?.mode!=='opaque'?neighbor.boxes:undefined;
            const clip=!chisel && canClipBoxFace(box) && (boxes.length>1 || neighborBoxes);
            if (!clip && boxes.length>1 && boxes.some(other=>coversFace(other,box,f))) continue;
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
            // Covers sample the same light map as other blocks. Multiplying by
            // the adjacent cell again blackens recessed faces next to solids.
            const shade = box.emissive ? 1 : box.redPowerLocalShade?.[f] ?? FACE_SHADE[f];
            const litCover = box.material !== undefined && brightness > 0;
            const smooth = box.mode === 'opaque' && !box.emissive && (litCover || box.solid && !box.angle)
              ? faceLighting(onEdge ? adjacent : at, f, brightness) : null;
            if (chisel) {
              const tiles = chiselFantasyQuarters(f, neighbors);
              for (let quarter = 0; quarter < tiles.length; quarter++) {
                faceQuad(out, box, f, origin, smooth?.levels ?? brightness, tiles[quarter], shade, quarter, smooth?.shadow);
              }
              continue;
            }
            let tile = box.faces[f];
            if (glass) tile = glassTexture(f, neighbors, Number(blockKey.slice(10))) ?? tile;
            if (onEdge && loggedCells?.has(adjacent)) {
              const kind = liquidKind(blockKey);
              if (kind) {
                for (const piece of clipLiquidFace(box, f, liquidObstacles(adjacent, kind))) {
                  faceQuad(out, piece, f, origin, brightness, tile, shade);
                }
                continue;
              }
            }
            const tint=isGrass && box.tintFaces?.[f] ? biomeTints?.[biomeIndex] ?? box.tintFaces[f] :
              leafTint ?? box.tintFaces?.[f] ?? box.tint;
            const wind=isLeaf ? -24 : isVine ? 36 : 0;
            if (clip) {
              for (const fragment of boxFaceFragments(box,boxIndex,boxes,f,neighborBoxes)) {
                faceQuad(out,box,f,origin,smooth?.levels ?? brightness,tile,shade,-1,smooth?.shadow,tint,wind,fragment);
              }
            } else {
              faceQuad(out,box,f,origin,smooth?.levels ?? brightness,tile,shade,-1,smooth?.shadow,tint,wind);
            }
          }
        }
      }
    }
  }
  const visibility = occlusionCells ? buildSectionVisibility(occlusionCells, opaqueCells) : null;
  const ornament=foliage && {...layer(),windMarks:[],foliageMarks:[]};
  const foliageQuads=ornament ? appendFoliage({indices,palette,light,origin:foliage,biomeTints,
    emit:(corners,tile,packed,tint,shade,wind,slot,uv=FULL_UV)=>quad(ornament,corners,tile,uv,
      packed,tint,shade,undefined,undefined,wind,slot)}) : 0;
  if (foliageQuads) layers.foliage=ornament;
  return {layers,signs,visibility,foliageQuads,roundedLogs};
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
        if (!representatives.has(key)) {
          representatives.set(key, shapeFor(key.replace(/^full-cover-material:/, 'cover-material:'))[0] ?? null);
        }
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
    const {layers, signs, visibility, foliageQuads = 0, roundedLogs = 0} =
      data.type === 'precise' ? precise(data) : coarse(data);
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
      if (out.windMarks?.length) {
        out.wind = new Uint8Array(out.positions.length/3);
        for (let i=0;i<out.windMarks.length;i+=2) out.wind[out.windMarks[i]] = out.windMarks[i+1];
        out.bounds.radius += .23;
        transfers.push(out.wind.buffer);
      }
      delete out.windMarks;
      if (out.foliageMarks?.length) {
        out.foliageSlots=new Uint8Array(out.positions.length/3);
        for (let i=0;i<out.foliageMarks.length;i+=2) {
          const start=out.foliageMarks[i];
          out.foliageSlots.fill(out.foliageMarks[i+1],start,start+4);
        }
        transfers.push(out.foliageSlots.buffer);
      }
      delete out.foliageMarks;
      if (mode!=='foliage') fitsSection &&= out.bounds.fitsSection;
      transfers.push(out.positions.buffer, out.uvs.buffer, out.colors.buffer, out.lightLevels.buffer, out.indices.buffer);
    }
    if (visibility) {
      transfers.push(visibility.links.buffer);
      if (visibility.cells) transfers.push(visibility.cells.buffer);
    }
    self.postMessage({id: data.id, version: data.version, layers, signs, visibility, fitsSection, foliageQuads, roundedLogs,
      visibilityClassified: data.collectVisibility === true,
      elapsed: performance.now() - start}, transfers);
  } catch (error) {
    self.postMessage({id: data.id, version: data.version, reduced:data.reduced,error: error.stack || String(error)});
  }
};

function boundingSphere(positions, end = positions.length) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < end; i++) {
    const axis = i % 3;
    min[axis] = Math.min(min[axis], positions[i]);
    max[axis] = Math.max(max[axis], positions[i]);
  }
  const center = min.map((value, axis) => (value + max[axis]) / 2);
  const radius = Math.hypot(...max.map((value, axis) => value - center[axis]));
  return {center, radius, fitsSection:min.every((value, axis) => value >= 0 && max[axis] <= 16)};
}
