import {hasHatchRung, westCellarLadder} from './west-cellar.mjs';

import {connectedTubeMesh, tubeCore} from './redpower-tubes.mjs';
import {wirePanels, wireSelection} from './redpower-wires.mjs';
import {shapedLampCollision} from './redpower-lamps.mjs';
import {staticEmission} from './block-light-properties.mjs';
import {voxelCollisionBoxes, voxelKey} from './voxel-chisel.mjs';

export const ATLAS_GRID = 64;
export const TILE_SIZE = 16;
export const FACES = Object.freeze([
  [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1],
]);

export const tiles = Object.freeze({
  terrain: 0, redPowerWorld: 256, redPowerMachine: 512, redPowerLighting: 768,
  cloud: 1024, flowers: 1280, cotton: 1536, redPowerWire: 1792,
  redPowerControl: 2048, redPowerLogic: 2304, armchair: 2560,
  bookcase: 2816, furniture: 3072, water: 3200, lava: 3201, chest: 3202,
  unknown: 3203, white: 3204, sign: 3205,
});

const AIR = Object.freeze([]);
const CUBE = [0, 0, 0, 1, 1, 1];
const DEFAULT = { mode: 'opaque', solid: true, emissive: false };
const solidTile = new Map();
const keyOf = cell => typeof cell === 'string' ? cell : cell?.key ?? 'air';
const legacyKey = /^legacy:(\d+):(\d+)$/;
const coverKey = /^cover:(\d+):(\d+):/;
const parsedKeys = new Map();
function unpack(cell) {
  const key = keyOf(cell);
  if (!parsedKeys.has(key)) {
    const match = legacyKey.exec(key) ?? coverKey.exec(key);
    parsedKeys.set(key, match ? [Number(match[1]), Number(match[2])] : [0, 0]);
  }
  return parsedKeys.get(key);
}

function box(bounds, faceTiles, options = DEFAULT) {
  const [x0, y0, z0, x1, y1, z1] = bounds;
  const faces = typeof faceTiles === 'number' ? Array(6).fill(faceTiles) : faceTiles;
  return { x0, y0, z0, x1, y1, z1, faces, ...DEFAULT, ...options };
}

function uniform(tile, options) {
  if (options) return [box(CUBE, tile, options)];
  if (!solidTile.has(tile)) solidTile.set(tile, [box(CUBE, tile)]);
  return solidTile.get(tile);
}

function topSides(side, top, bottom = top) {
  return [side, side, bottom, top, side, side];
}

const planks = [4, 198, 214, 199];
const wool = [64, 210, 194, 178, 162, 146, 130, 114, 225, 209, 193, 177, 161, 145, 129, 113];
const stoneSlab = [topSides(5, 6), topSides(192, 176, 208), 4, 16, 7, 54, 224];
const stoneBrick = [54, 100, 101, 213];
const cobble = 16;
const WARM_GRASS = 0x79c05a;
const WARM_LEAVES = 0x59ae30;
const GLASS = { mode: 'cutout' };
const GROUND_DECOR = { solid: false };
const LIGHT = { emissive: true };
const STAIRS = { 53: 4, 67: 16, 108: 7, 109: 54, 114: 224, 128: stoneSlab[1],
  134: 198, 135: 214, 136: 199, 4039: wool[4] };
const TERRAIN = {
  1: 1, 3: 2, 4: 16, 7: 17, 12: 18, 13: 19, 14: 32, 15: 33, 16: 34,
  19: 48, 21: 160, 22: 144, 41: 23, 42: 22, 45: 7, 48: 36, 49: 37,
  52: 65, 56: 50, 57: 24, 73: 51, 74: 51, 80: 66, 82: 72, 87: 103,
  103: 136, 110: topSides(77, 78, 2), 112: 224, 121: 175, 129: 171,
  133: 25, 1527: 164,
};
const plants = { 6: 15, 30: 11, 31: 39, 32: 55, 37: 13, 38: 12, 39: 29, 40: 28,
  51: 31, 59: 88, 83: 73, 104: 111, 105: 111, 115: 226, 141: 200, 142: 200 };
const fruitTiles = {3989: 3267, 4031: 3286, 3983: 3289, 3977: 3292, 4084: 3295};
const cropStorageTiles = {3823:3604, 3827:3605, 3829:3606, 3835:3607, 3838:3608, 3941:3609,
  3961:3610, 3976:3611, 4023:3612, 4025:3613, 4033:3614, 4073:3615, 4077:3616};
const wildCropTiles = {3902:3633, 3927:3634, 3930:3635, 3933:3636, 3942:3637, 4030:3638, 4068:3639, 4089:3640};

function cross(tile, height = 1, tint, inset = 0.1) {
  return [box([inset, 0, inset, 1 - inset, height, 1 - inset], tile, {
    kind: 'cross', mode: 'cutout', solid: false, tint, uv: 'box',
  })];
}

function faceMaterial(faceTiles, face, tile) {
  const faces = typeof faceTiles === 'number' ? Array(6).fill(faceTiles) : [...faceTiles];
  faces[face] = tile;
  return faces;
}

function rotateBounds(bounds, quarterTurns) {
  const [x0, y0, z0, x1, y1, z1] = bounds;
  switch (quarterTurns & 3) {
    case 1: return [z0, y0, 1 - x1, z1, y1, 1 - x0];
    case 2: return [1 - x1, y0, 1 - z1, 1 - x0, y1, 1 - z0];
    case 3: return [1 - z1, y0, x0, 1 - z0, y1, x1];
    default: return bounds;
  }
}

function rotateFaces(faceTiles, quarterTurns) {
  if (typeof faceTiles === 'number') return faceTiles;
  const result = [...faceTiles];
  const perimeter = [0, 5, 1, 4];
  for (let i = 0; i < 4; i++) result[perimeter[(i + quarterTurns) & 3]] = faceTiles[perimeter[i]];
  return result;
}

function turnedBox(bounds, faceTiles, quarterTurns, options) {
  return box(rotateBounds(bounds, quarterTurns), rotateFaces(faceTiles, quarterTurns), options);
}

function wallPlate(meta, width, y0, y1, depth, tile, options = GROUND_DECOR) {
  const turn = { 2: 0, 3: 2, 4: 1, 5: 3 }[meta] ?? 0;
  const halfGap = (1 - width) / 2;
  return turnedBox([halfGap, y0, 1 - depth, 1 - halfGap, y1, 1], tile, turn, options);
}

function torch(tile, meta, emissive) {
  const options = {mode:'cutout', solid:false, emissive, uv:'box'};
  if (meta === 5 || meta === 0) return [box([0.4375, 0, 0.4375, 0.5625, 0.625, 0.5625], tile, options)];
  return [wallPlate(({1:5, 2:4, 3:3, 4:2})[meta], 0.125, 0.25, 0.875, 0.1875, tile, options)];
}

function log(meta) {
  const bark = [20, 116, 117, 153][meta & 3];
  const end = (meta & 3) === 3 ? 153 : 21;
  const axis = meta & 12;
  if (axis === 12) return bark;
  if (axis === 4) return [end, end, bark, bark, bark, bark];
  if (axis === 8) return [bark, bark, bark, bark, end, end];
  return topSides(bark, end);
}

function sandstone(meta) {
  return topSides([192, 229, 230][meta] ?? 192, 176, 208);
}

function stairs(id, meta, neighbors) {
  const inverted = Boolean(meta & 4);
  const faceTiles = STAIRS[id];
  const orientation = meta & 3;
  const direction = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]][orientation];
  const back = direction.map(value => -value);
  const frontNeighbor = neighbors?.(...direction);
  const backNeighbor = neighbors?.(...back);
  const qualifies = other => {
    const [neighborId, neighborMeta] = unpack(other);
    return STAIRS[neighborId] !== undefined && (neighborMeta & 4) === (meta & 4)
      && Boolean(neighborMeta & 2) !== Boolean(orientation & 2);
  };
  const highY = inverted ? 0 : 0.5;
  const baseY = inverted ? 0.5 : 0;
  const result = [box([0, baseY, 0, 1, baseY + 0.5, 1], faceTiles)];
  const highIn = (facing, x, z) => [x >= 0.5, x < 0.5, z >= 0.5, z < 0.5][facing];
  const cornerFacing = (neighbor, sign) => {
    if (!qualifies(neighbor)) return null;
    const facing = unpack(neighbor)[1] & 3;
    const side = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]][facing];
    const [sideId, sideMeta] = unpack(neighbors?.(...side.map(value => value * sign)));
    return STAIRS[sideId] !== undefined && sideMeta === meta ? null : facing;
  };
  const outer = cornerFacing(frontNeighbor, -1);
  const inner = outer === null ? cornerFacing(backNeighbor, 1) : null;
  if (outer === null && inner === null) {
    const top = [
      [0.5, highY, 0, 1, highY + 0.5, 1],
      [0, highY, 0, 0.5, highY + 0.5, 1],
      [0, highY, 0.5, 1, highY + 0.5, 1],
      [0, highY, 0, 1, highY + 0.5, 0.5],
    ][orientation];
    result.push(box(top, faceTiles));
    return result;
  }
  for (const x of [0, 0.5]) {
    for (const z of [0, 0.5]) {
      const near = highIn(orientation, x, z);
      if ((near && (outer === null || highIn(outer, x, z))) || (inner !== null && highIn(inner, x, z))) {
        result.push(box([x, highY, z, x + 0.5, highY + 0.5, z + 0.5], faceTiles));
      }
    }
  }
  return result;
}

function door(id, meta, neighbors) {
  const upper = Boolean(meta & 8);
  const peer = unpack(neighbors?.(0, upper ? -1 : 1, 0));
  const lowerMeta = upper && peer[0] === id ? peer[1] : meta;
  const upperMeta = upper ? meta : peer[0] === id ? peer[1] : 0;
  const closed = lowerMeta & 3;
  const open = Boolean(lowerMeta & 4);
  const hinge = Boolean(upperMeta & 1);
  const edge = open ? (closed + (hinge ? 3 : 1)) & 3 : closed;
  const tile = id === 71 ? 98 : 97;
  const mirrorFaces = [false, false, false, false, false, false];
  const mirrored = open ? [4, 1, 5, 0][closed] : [1, 5, 0, 4][closed];
  mirrorFaces[mirrored] = true;
  if (!open && hinge) {
    for (const face of [0, 1, 4, 5]) mirrorFaces[face] = !mirrorFaces[face];
  }
  const faces = [tile, tile, tile, tile, tile, tile];
  if (upper) for (const face of [0, 1, 4, 5]) faces[face] -= 16;
  return [box(rotateBounds([0, 0, 0, 0.1875, 1, 1], -edge), faces, { mode: 'cutout', mirrorFaces })];
}

function fence(id, meta, neighbors, pane = false) {
  const paneTile = id === 102 ? 49 : 85;
  const wall = id === 139;
  const tile = pane ? paneTile : id === 113 ? 224 : wall ? (meta ? 36 : 16) : 4;
  const options = pane && id === 102 ? GLASS : pane ? { mode: 'cutout' } : DEFAULT;
  const links = fenceLinks(id, neighbors, pane);
  if (pane) {
    const arms = links.some(Boolean) ? links : [true, true, true, true];
    const result = [];
    if (arms[0] || arms[1]) result.push(box([arms[0] ? 0 : 0.4375, 0, 0.4375, arms[1] ? 1 : 0.5625, 1, 0.5625], tile, options));
    if (arms[2] || arms[3]) result.push(box([0.4375, 0, arms[2] ? 0 : 0.4375, 0.5625, 1, arms[3] ? 1 : 0.5625], tile, options));
    return result;
  }
  const [x0, x1, z0, z1] = links;
  const width = wall ? 0.25 : 0.125;
  const result = [box([0.5 - width, 0, 0.5 - width, 0.5 + width, 1, 0.5 + width], tile)];
  for (const [bottom, top] of wall ? [[0, 0.8125]] : [[0.375, 0.5625], [0.75, 0.9375]]) {
    if (x0 || x1) result.push(box([x0 ? 0 : 0.5 - width, bottom, 0.5 - width / 2, x1 ? 1 : 0.5 + width, top, 0.5 + width / 2], tile));
    if (z0 || z1) result.push(box([0.5 - width / 2, bottom, z0 ? 0 : 0.5 - width, 0.5 + width / 2, top, z1 ? 1 : 0.5 + width], tile));
  }
  return result;
}

function fenceLinks(id, neighbors, pane) {
  return [0, 1, 4, 5].map(face => {
    const [near] = unpack(neighbors?.(...FACES[face]));
    return near === id || (pane && [20, 101, 102].includes(near)) || [1, 2, 3, 4, 5, 7, 12, 17, 24, 35, 45, 48, 98, 107, 112, 125].includes(near);
  });
}

function vine(meta) {
  const result = [];
  for (const [bit, face] of [[1, 2], [2, 5], [4, 3], [8, 4]]) {
    if (meta & bit) result.push(wallPlate(face, 1, 0, 1, 0.0078125, 143, {
      mode: 'cutout', solid: false, tint: WARM_LEAVES,
    }));
  }
  return result.length ? result : [box([0, 0.9921875, 0, 1, 1, 1], 143, {
    mode: 'cutout', solid: false, tint: WARM_LEAVES,
  })];
}

const covers = [
  16, 1, 4, sandstone(0), 36, 7, 37, 49, 2, 72, topSides(35, 4), 103, log(0), log(1), log(2), 104,
  stoneSlab[0], 22, 23, 24, 144, 66, topSides(118, 102), 54, 100, 101, 224, 213, 198, 214, 199, sandstone(1),
  ...wool,
  ...[16, 17, 18, 19, 20].map(index => tiles.redPowerWorld + index),
  topSides(tiles.redPowerWorld + 50, tiles.redPowerWorld + 51),
  ...[80, 81, 82, 21, 22].map(index => tiles.redPowerWorld + index),
];
covers[64] = sandstone(2);
covers[65] = log(3);
for (const index of [66, 67, 68]) covers[index] = tiles.redPowerWorld + index + 17;

const plateAxes = [1, 1, 2, 2, 0, 0];
const cornerSides = [
  [0, 0, 0], [0, 0, 1], [1, 0, 0], [1, 0, 1],
  [0, 1, 0], [0, 1, 1], [1, 1, 0], [1, 1, 1],
];
const edgeSides = [
  [-1, 0, 0], [-1, 0, 1], [0, 0, -1], [1, 0, -1],
  [0, -1, 0], [0, -1, 1], [1, -1, 0], [1, -1, 1],
  [-1, 1, 0], [-1, 1, 1], [0, 1, -1], [1, 1, -1],
];
const plateThickness = [1, 2, 4, 1, 2, 4, 3, 5, 6, 7, 3, 5, 6, 7];
const partThickness = [1, 2, 4, 3, 5, 6, 7];
const hollowShapes = new Set([3, 4, 5, 10, 11, 12, 13]);
const coverCache = new WeakMap();

export const coverPartTypes = Object.freeze([
  Object.freeze({first: 0, end: 6, shapes: plateThickness.length}),
  Object.freeze({first: 6, end: 14, shapes: partThickness.length}),
  Object.freeze({first: 14, end: 26, shapes: partThickness.length}),
  Object.freeze({first: 26, end: 29, shapes: 3}),
]);

export const isCoverMaterial = material => Number.isInteger(material) && covers[material] !== undefined;

export function coverBoxes(parts, frame = false) {
  const cached = coverCache.get(parts);
  if (cached?.frame === frame) return cached.boxes;
  const faceRange = [...CUBE];
  const result = [];
  const owned = (part, bounds) => {
    if ([0, 1, 2].some(axis => bounds[axis] >= bounds[axis + 3])) return;
    const material = covers[part.material];
    result.push(box(bounds, material ?? tiles.unknown, {
      material: part.material,
      partSlot: part.slot,
      mode: part.material === 7 ? 'cutout' : 'opaque',
      ...(material === undefined ? { approximation: 'Unidentified RedPower cover material' } : {}),
    }));
  };
  for (const part of parts.filter(part => part.slot < 6).sort((a, b) => a.slot - b.slot)) {
    const { slot } = part;
    const shape = frame && [1, 4].includes(part.shape) ? part.shape - 1 : part.shape;
    const thickness = (plateThickness[shape] ?? 8) / 8;
    const axis = plateAxes[slot];
    const high = Boolean(slot & 1);
    const bounds = [...faceRange];
    bounds[axis] = high ? 1 - thickness : 0;
    bounds[axis + 3] = high ? 1 : thickness;
    faceRange[axis + (high ? 3 : 0)] = high ? 1 - thickness : thickness;
    if (!hollowShapes.has(shape)) {
      owned(part, bounds);
      continue;
    }
    const [outer, inner] = axis === 1 ? [0, 2] : axis === 2 ? [0, 1] : [2, 1];
    for (const [split, low, high, clampOther] of [
      [outer, 0, 0.25, false], [outer, 0.75, 1, false],
      [inner, 0, 0.25, true], [inner, 0.75, 1, true],
    ]) {
      const border = [...bounds];
      border[split] = Math.max(low, border[split]);
      border[split + 3] = Math.min(high, border[split + 3]);
      if (clampOther) {
        border[outer] = Math.max(0.25, border[outer]);
        border[outer + 3] = Math.min(0.75, border[outer + 3]);
      }
      owned(part, border);
    }
  }

  const corners = parts.filter(part => part.slot >= 6 && part.slot < 14);
  for (const part of corners) {
    const thickness = (partThickness[part.shape] ?? 8) / 8;
    const bounds = [...faceRange];
    for (const [axis, side] of cornerSides[part.slot - 6].entries()) {
      if (side) bounds[axis] = Math.max(bounds[axis], 1 - thickness);
      else bounds[axis + 3] = Math.min(bounds[axis + 3], thickness);
    }
    owned(part, bounds);
  }
  for (const part of parts.filter(part => part.slot >= 14 && part.slot < 26)) {
    const thickness = (partThickness[part.shape] ?? 8) / 8;
    const bounds = [...faceRange];
    const sides = edgeSides[part.slot - 14];
    const along = sides.indexOf(-1);
    for (const [axis, side] of sides.entries()) {
      if (side === 1) bounds[axis] = Math.max(bounds[axis], 1 - thickness);
      if (side === 0) bounds[axis + 3] = Math.min(bounds[axis + 3], thickness);
    }
    for (const corner of corners) {
      const cornerSide = cornerSides[corner.slot - 6];
      if (sides.some((side, axis) => side !== -1 && side !== cornerSide[axis])) continue;
      const trim = (partThickness[corner.shape] ?? 8) / 8;
      if (cornerSide[along]) bounds[along + 3] = Math.min(bounds[along + 3], 1 - trim);
      else bounds[along] = Math.max(bounds[along], trim);
    }
    owned(part, bounds);
  }

  const columns = parts.filter(part => part.slot >= 26 && part.slot <= 28);
  const radius = column => [0.125, 0.25, 0.375][column.shape] ?? 0.5;
  const widest = columns.reduce((largest, part) => !largest || radius(part) > radius(largest) ? part : largest, null);
  const centerRadius = widest && radius(widest);
  if (columns.length > 1) owned(widest, [0.5 - centerRadius, 0.5 - centerRadius, 0.5 - centerRadius,
    0.5 + centerRadius, 0.5 + centerRadius, 0.5 + centerRadius]);
  for (const part of columns) {
    const axis = [1, 2, 0][part.slot - 26];
    const half = radius(part);
    const bounds = [0.5 - half, 0.5 - half, 0.5 - half, 0.5 + half, 0.5 + half, 0.5 + half];
    bounds[axis] = faceRange[axis];
    bounds[axis + 3] = faceRange[axis + 3];
    if (columns.length === 1) owned(part, bounds);
    else {
      const near = [...bounds];
      near[axis + 3] = Math.min(near[axis + 3], 0.5 - centerRadius);
      bounds[axis] = Math.max(bounds[axis], 0.5 + centerRadius);
      owned(part, near);
      owned(part, bounds);
    }
  }
  coverCache.set(parts, { frame, boxes: result });
  return result;
}


function frame(parts) {
  const covered = new Set(parts.map(part => part.slot));
  const stickyMask = parts.reduce((mask, part) => [1, 4].includes(part.shape) ? mask | (1 << part.slot) : mask, 0);
  const result = [];
  const shell = [2, 3, 4, 5, 0, 1];
  for (const [slot, face] of shell.entries()) {
    const axis = plateAxes[slot];
    const high = Boolean(slot & 1);
    const bounds = [...CUBE];
    bounds[axis] = high ? 0.9375 : 0;
    bounds[axis + 3] = high ? 1 : 0.0625;
    const tile = tiles.redPowerMachine + (covered.has(slot) ? (stickyMask & (1 << slot) ? 4 : 2) : 1);
    const faces = Array(6).fill(-1);
    faces[face] = tile;
    faces[face ^ 1] = tiles.redPowerMachine + 1;
    result.push(box(bounds, faces, { mode: 'cutout', solid: false }));
  }
  return result;
}

function connectedCore(neighbors, faceTile, radius, mode = 'opaque') {
  const bounds = [0.5 - radius, 0.5 - radius, 0.5 - radius, 0.5 + radius, 0.5 + radius, 0.5 + radius];
  const options = { mode, approximation: 'RedPower wire connection geometry' };
  const result = [box(bounds, faceTile, options)];
  const connected = face => {
    const [id, meta] = unpack(neighbors?.(...FACES[face]));
    return id === 750 && meta !== 0 && meta !== 8 || [69, 75, 76, 93, 94, 753, 760, 761, 762, 763, 764].includes(id);
  };
  for (const face of [0, 1, 2, 3, 4, 5]) {
    if (!connected(face)) continue;
    const arm = [...bounds];
    const axis = face >> 1;
    if (face & 1) {
      arm[axis] = arm[axis + 3];
      arm[axis + 3] = 1;
    } else {
      arm[axis + 3] = arm[axis];
      arm[axis] = 0;
    }
    result.push(box(arm, faceTile, options));
  }
  return result;
}

const jacketMask = [16, 32, 1, 2, 4, 8];
const jacketRotation = [4, 5, 0, 1, 2, 3];
const jacketBounds = [.25, .25, .25, .75, .75, .75];

function jacketShape(meta, data, neighbors) {
  const material = covers[data.post] ?? cobble;
  const sides = typeof material === 'number' ? Array(6).fill(material) : material;
  const end = tiles.redPowerWire + (meta === 1 ? (data.pwr ? 6 : 5) : meta === 3 ? 7 : 10);
  const linked = FACES.map((offset, face) => {
    if (data.cons & jacketMask[face]) return true;
    const neighbor = neighbors?.(...offset);
    const [id, neighborMeta] = unpack(neighbor);
    const adjacent = neighbor?.object?.data ?? neighbor?.object ?? neighbor?.data;
    if (id === 750 && neighborMeta === meta) {
      return Boolean(adjacent?.cons & (64 | jacketMask[face ^ 1]));
    }
    return meta === 1 && id === 768 && adjacent?.rot === jacketRotation[face ^ 1];
  });

  const ends = linked.flatMap((connects, face) => connects ? [face] : []);
  if (!ends.length) return [box(jacketBounds, sides.map((tile, face) => (face >> 1) === 1 ? end : tile))];
  if (ends.length === 2 && (ends[0] ^ 1) === ends[1]) {
    const axis = ends[0] >> 1;
    const bounds = [...jacketBounds];
    bounds[axis] = 0;
    bounds[axis + 3] = 1;
    return [box(bounds, sides.map((tile, face) => (face >> 1) === axis ? end : tile))];
  }
  const core = box(jacketBounds, sides.map((tile, face) => linked[face] ? -1
    : ends.length === 1 && face === (ends[0] ^ 1) ? end : tile));
  const arms = ends.map(face => {
    const axis = face >> 1;
    const arm = [...jacketBounds];
    if (face & 1) {
      arm[axis] = arm[axis + 3];
      arm[axis + 3] = 1;
    } else {
      arm[axis + 3] = arm[axis];
      arm[axis] = 0;
    }
    return box(arm, sides.map((tile, side) => side === face ? end : side === (face ^ 1) ? -1 : tile));
  });
  return [core, ...arms];
}

// RenderBufferChest uses machine1.png and rotates its texture faces by the tile's stored side.
const bufferFaces = [
  [88, 88, 87, 89, 88, 88], [88, 88, 89, 87, 88, 88],
  [88, 88, 88, 88, 87, 89], [88, 88, 88, 88, 89, 87],
  [87, 89, 88, 88, 88, 88], [89, 87, 88, 88, 88, 88],
];
const bufferUvFlags = [
  [0, 0, 0, 0, 0, 0], [3, 3, 3, 3, 3, 3],
  [5, 6, 6, 5, 0, 0], [6, 5, 5, 6, 0, 0],
  [0, 0, 0, 0, 6, 5], [0, 0, 3, 3, 5, 6],
];

const APPROX_FURNITURE = 'Simplified Jammy Furniture model';
const APPROX_BIBLIO = 'Simplified BiblioCraft model';
const armchairPieces = [
  [-8, 19, -8, 16, 3, 16], [-8, 5, 6, 16, 14, 2],
  [6, 13, -8, 2, 6, 14], [6, 11, -8, 3, 3, 14],
  [-8, 13, -8, 2, 6, 14], [-9, 11, -8, 3, 3, 14],
  [6, 22, 6, 2, 2, 2], [-8, 22, 6, 2, 2, 2],
  [-8, 22, -8, 2, 2, 2], [6, 22, -8, 2, 2, 2],
  [-6, 16, -7.5, 12, 3, 14],
];
function armchair(meta) {
  const options = { uv: 'box', mirrorU: true };
  return armchairPieces.map(([x, y, z, width, height, depth], piece) => {
    const firstTile = tiles.armchair + (meta >> 2) * 64 + (piece > 9 ? 7 : Math.min(piece, 6)) * 6;
    const faces = Array.from({ length: 6 }, (_, face) => firstTile + face);
    return turnedBox([(8 - x - width) / 16, (24 - y - height) / 16, (8 + z) / 16,
      (8 - x) / 16, (24 - y) / 16, (8 + z + depth) / 16], faces, -(meta & 3), options);
  });
}

function sofa(id, meta) {
  const fabric = tiles.armchair + (meta >> 2) * 64 + 1;
  const turn = -(meta & 3);
  const options = { uv: 'box', approximation: APPROX_FURNITURE };
  const result = [
    turnedBox([0, 0.125, 0, 1, 0.3125, 1], fabric, turn, options),
    turnedBox([0, 0.3125, 0.8125, 1, 0.9375, 1], fabric, turn, options),
    turnedBox([0.0625, 0.3125, 0.0625, 0.9375, 0.46875, 0.8125], fabric, turn, options),
  ];
  if (id === 214 || id === 217) result.push(turnedBox([0, 0.3125, 0, 0.1875, 0.6875, 0.8125], fabric, turn, options));
  if (id === 215 || id === 217) result.push(turnedBox([0.8125, 0.3125, 0, 1, 0.6875, 0.8125], fabric, turn, options));
  for (const x of [0, 0.875]) for (const z of [0, 0.875]) {
    result.push(turnedBox([x, 0, z, x + 0.125, 0.125, z + 0.125], planks[1], turn, options));
  }
  return result;
}

function shelf(id, meta, data) {
  const wood = planks[meta & 3];
  const base = tiles.bookcase + (meta & 3) * 16;
  const baseDirection = data?.bookcaseAngle ?? data?.genericShelfAngle ?? data?.potionshelfAngle ?? data?.caseAngle ?? data?.rackAngle ?? 3;
  const turn = (3 - baseDirection) & 3;
  const bookcase = id === 2250;
  const options = bookcase ? { uv: 'box' } : { uv: 'box', approximation: APPROX_BIBLIO };
  const depth = id === 2253 ? 0.125 : 0.5;
  const range = id === 2252 || id === 2254 ? [0.125, 0.75] : [0, 1];
  const faces = (piece, fallback) => bookcase ? Array.from({ length: 6 }, (_, face) => base + piece * 6 + face) : fallback;
  const result = [
    turnedBox([0.03125, range[0] + 0.03125, 0, 0.96875, range[1] - 0.03125, 0.03125], faces(0, wood), turn, options),
    turnedBox([0.03125, range[0], 0, 0.96875, range[0] + 0.03125, depth], faces(1, wood), turn, options),
    turnedBox([0.03125, range[1] - 0.03125, 0, 0.96875, range[1], depth], faces(1, wood), turn, options),
    turnedBox([0, range[0], 0, 0.03125, range[1], depth], faces(1, wood), turn, options),
    turnedBox([0.96875, range[0], 0, 1, range[1], depth], faces(1, wood), turn, options),
  ];
  if (bookcase) result.push(turnedBox([0.03125, 0.5, 0.03125, 0.96875, 0.53125, depth], faces(1, wood), turn, options));
  if (id === 2255) result.push(turnedBox([0.03125, 0.0625, 0.46875, 0.96875, 0.9375, 0.5], 49, turn, GLASS));
  if (!bookcase) return result;
  for (const [y, count] of [[0.03125, data?.filledBottomSlots], [0.53125, data?.filledTopSlots]]) {
    for (let i = 0; i < Math.min(8, count ?? 0); i++) {
      const x = 0.0625 + i * 0.109375;
      result.push(turnedBox([x, y, 0.07, x + 0.095, y + 0.40625, 0.4375], base + 12 + i % 4, turn, options));
    }
  }
  return result;
}

function furniture(id, meta) {
  const base = tiles.furniture;
  const turn = -(meta & 3);
  const options = { uv: 'box', approximation: APPROX_FURNITURE };
  const object = (bounds, tile, style = options) => turnedBox(bounds, tile, turn, style);
  if (id === 219 || id === 220) {
    const style = { ...options, solid: false };
    const bulb = { ...style, emissive: id === 219 };
    if (meta < 4 || meta > 11) return [
      object([0.375, 0.875, 0.375, 0.625, 1, 0.625], base + 0, style),
      object([0.40625, 0.6875, 0.40625, 0.59375, 0.875, 0.59375], base + 1, bulb),
    ];
    if (meta < 8) return [
      object([0.375, 0.4375, 0.875, 0.625, 0.6875, 1], base + 2, style),
      object([0.34375, 0.34375, 0.625, 0.65625, 0.75, 0.875], base + 2, style),
      object([0.390625, 0.390625, 0.609375, 0.609375, 0.703125, 0.625], base + 3, bulb),
    ];
    return [
      object([0.34375, 0, 0.34375, 0.65625, 0.0625, 0.65625], base + 4, style),
      object([0.46875, 0.0625, 0.46875, 0.53125, 0.625, 0.53125], base + 4, style),
      object([0.28125, 0.5, 0.28125, 0.71875, 0.78125, 0.71875], base + 5, bulb),
    ];
  }
  if (id === 200 && meta >= 12 || id === 203 && meta >= 8) return [
    object([0, 0.125, 0.875, 1, 0.9375, 1], base + 6, { ...options, solid: false }),
  ];
  if (id === 203 && meta < 4 || id === 205 && meta < 4) return [
    object([0.0625, 0.4375, 0.0625, 0.9375, 0.5625, 0.9375], base + 10),
    object([0.0625, 0.5625, 0.8125, 0.9375, 1, 0.9375], base + 10),
    ...[0.0625, 0.8125].flatMap(x => [0.0625, 0.8125].map(z =>
      object([x, 0, z, x + 0.125, 0.4375, z + 0.125], base + 10))),
  ];
  if (id === 200) return [object([0.1875, 0, 0.1875, 0.8125, 1, 0.8125], base + 7 + (meta >> 2))];
  if (id === 201 && meta < 8) {
    const firstTile = 3210 + (meta >> 2) * 12;
    const faces = part => Array.from({length: 6}, (_, face) => firstTile + part * 6 + face);
    const cabinet = {...options, mirrorU: true};
    return [
      object(CUBE, faces(0), cabinet),
      object([0.5625, 0.375, -0.0625, 0.625, 0.5625, 0], faces(1), {...cabinet, solid: false}),
    ];
  }
  if (id === 201) return [object([0, 0, 0.0625, 1, 0.9375, 0.9375], base + 11 + (meta >> 2))];
  if (id === 203) return [object([0.1875, 0, 0.21875, 0.8125, 0.40625, 0.78125], base + 15)];
  if (id === 205) return [object([0, 0, 0.0625, 1, 0.9375, 0.9375], base + 16 + (meta >> 2))];
  if (id === 207) return [object([0.09375, 0, 0.125, 0.90625, 0.875, 0.9375], base + 20 + (meta >> 2))];
  if ([209, 211].includes(id)) return [object([0.1875, 0.15625, 0.4375, 0.8125, 0.8125, 1], base + 24)];
  return [object([0.1875, 0, 0.1875, 0.8125, 0.75, 0.8125], base + 25)];
}

function signGeometry(meta, wall) {
  if (wall) return [wallPlate(meta, 1, 0.28125, 0.78125, 0.125, tiles.sign, { solid: false, uv: 'box' })];
  return [box([.25, 0, .25, .75, 1, .75], tiles.sign, GROUND_DECOR)];
}

// axh: 24 × 12 × 2 board and 2 × 14 × 2 post, at the sign renderer's 2/3 scale.
export function standingSignMesh(cell) {
  const [id, meta] = unpack(cell);
  if (id !== 63) return null;
  const options = {solid: false, uv: 'box', angle: -meta * Math.PI / 8};
  return [box([0, 7 / 12, 11 / 24, 1, 13 / 12, 13 / 24], [3303, 3304, 3305, 3306, 3307, 3308], options),
    box([11 / 24, 0, 11 / 24, 13 / 24, 7 / 12, 13 / 24], [3309, 3310, 3311, 3312, 3313, 3314], options)];
}

export function signFor(cell) {
  const [id, meta] = unpack(cell);
  if (id !== 63 && id !== 68) return null;
  const data = cell?.object?.data ?? cell?.object ?? cell?.data;
  const lines = [1, 2, 3, 4].map(line => String(data?.['Text' + line] ?? ''));
  if (id === 63) {
    const rotation = -(meta / 8) * Math.PI;
    return {
      lines, x: 0.5 + Math.sin(rotation) * (0.07 * 2 / 3), y: 0.85,
      z: 0.5 + Math.cos(rotation) * (0.07 * 2 / 3), width: 0.9375, height: 0.49, rotation,
    };
  }
  const rotation = ({ 2: 2, 3: 0, 4: 3, 5: 1 }[meta] ?? 0) * Math.PI / 2;
  return {
    lines, x: 0.5 + Math.sin(rotation) * -0.374, y: 0.525, z: 0.5 + Math.cos(rotation) * -0.374,
    width: 0.9375, height: 0.43, rotation,
  };
}

export function redPowerTubeMesh(cell, neighbors) {
  const [id, meta] = unpack(cell);
  if (id !== 750 || meta !== 8) return null;
  return [...coverBoxes(Array.isArray(cell?.parts) ? cell.parts : AIR, false), ...connectedTubeMesh(cell, neighbors)];
}

export function redPowerWireMesh(cell, neighbors) {
  const [id, meta] = unpack(cell);
  if (id !== 750 || !wireMetadata.has(meta)) return null;
  const data = cell?.object?.data ?? cell?.data;
  if (!Number.isInteger(data?.cons)) return null;
  const parts = coverBoxes(Array.isArray(cell?.parts) ? cell.parts : AIR, false);
  const result = [...parts, ...wirePanels(cell, meta, neighbors)];
  return meta !== 2 && (data?.cons & 64) ? [...result, ...jacketShape(meta, data, neighbors)] : result;
}

function specialShape(id, meta, cell, neighbors) {
  const data = cell?.object?.data ?? cell?.object ?? cell?.data;
  if (id === 750) {
    const parts = Array.isArray(cell?.parts) ? cell.parts : AIR;
    let components = coverBoxes(parts, false);
    if (meta === 0) return Array.isArray(cell?.parts) ? components : uniform(planks[1]);
    if (meta === 8) return [...components, tubeCore];
    if (wireMetadata.has(meta) && Number.isInteger(data?.cons)) {
      const panels = wireSelection(cell, meta);
      // The original ray trace uses multipart bounds; only rendering extends a post to its neighbors.
      const result = [...components, ...panels];
      return data?.cons & 64 ? [...result, wirePostCollision] : result;
    }
    const tile = tiles.redPowerWire + (meta === 5 ? 112 : 1);
    return [...components, ...connectedCore(neighbors, tile, 0.0625, 'cutout')];
  }
  if (id === 765) {
    const parts = Array.isArray(cell?.parts) ? cell.parts : AIR;
    return [...coverBoxes(parts, true), ...frame(parts)];
  }
  if (id === 751 && meta === 2) {
    const rotation = Number.isInteger(data?.rot) && data.rot >= 0 && data.rot < bufferFaces.length ? data.rot : 0;
    const faces = bufferFaces[rotation].map(tile => tiles.redPowerMachine + tile);
    return [box(CUBE, faces, { redPowerUv: bufferUvFlags[rotation] })];
  }
  if ([756, 757, 758, 759].includes(id)) {
    const on = id === 756 || id === 758;
    const options = on ? LIGHT : DEFAULT;
    const tile = tiles.redPowerLighting + (on ? 32 : 16) + meta;
    return uniform(tile, options);
  }
  if (id === 768) {
    const color = data?.color ?? data?.Color ?? meta;
    const flags = data?.ps ?? 0;
    const on = Boolean(flags & 1) !== Boolean(flags & 2);
    return [box([0.1875, 0.125, 0.1875, 0.8125, 0.875, 0.8125],
      tiles.redPowerLighting + (on ? 32 : 16) + (color & 15), {
        emissive: on, approximation: 'Simplified RedPower shaped lamp',
      })];
  }
  if (id === 753) return [box([0, 0, 0, 1, 0.125, 1], tiles.redPowerLogic + meta, {
    approximation: 'Simplified RedPower logic board',
  })];
  if ([760, 761, 762, 763, 764, 767].includes(id)) {
    const controller = id <= 762;
    return [box([0, 0, 0, 1, id === 764 ? 0.25 : 1, 1],
      (controller ? tiles.redPowerControl : tiles.redPowerMachine) + 16 + meta,
      { approximation: 'Simplified RedPower machine or control component' })];
  }
  if (id === 3246) {
    const height = meta > 1 ? 0.5 : 1;
    const tile = tiles.cloud + 36 + (meta >= 1 && meta <= 4 ? meta - 1 : 0);
    return [box([0, 0, 0, 1, height, 1], tile)];
  }
  if (id === 4000) return cross(tiles.flowers + 16 + (meta > 13 ? 0 : meta));
  if (id === 4053) {
    const bottom = meta & 8 ? 0.5 : 0;
    return [box([0, bottom, 0, 1, bottom + 0.5, 1], wool[2])];
  }
  if (id === 4067) return [box([0, 0, 0, 1, 0.125, 1], wool[meta])];
  if (cropStorageTiles[id] !== undefined) return uniform(cropStorageTiles[id]);
  if (id === 3999) return uniform(3617 + meta);
  if (wildCropTiles[id] !== undefined) return cross(wildCropTiles[id], 1, undefined, .05);
  if (id === 3968 || fruitTiles[id] !== undefined) {
    const stage = meta >= 7 && meta <= 8 ? 2 : meta >= 4 && meta <= 6 ? 1 : 0;
    // HarvestCraft cinnamon is solid. The hanging fruit use the original crossed squares.
    return id === 3968 ? uniform(3264 + stage) : cross(fruitTiles[id] + stage, 1, undefined, 0.05);
  }
  if (id === 2779 && meta === 7) return uniform(3298);
  if (id === 2835 && meta === 13) return uniform(3299);
  if (id === 2804 && meta === 12) return uniform(topSides(3300, 3301, 3302));
  if (id === 162 && meta === 1) return uniform(3653);
  if (id === 701 && meta === 1) return uniform(topSides(3654, 3655));
  if (id === 3943) return meta < 4 ? uniform(topSides(3645 + meta, 3641 + meta, 3649 + meta)) : uniform(3641);
  if (id === 241) return cross(tiles.redPowerWorld + 0);
  if (id === 242) return uniform(tiles.redPowerWorld + 32 + meta);
  if (id === 243) return uniform(tiles.redPowerWorld + 49, { tint: WARM_LEAVES });
  if (id === 244) return uniform(tiles.redPowerWorld + 16 + meta);
  if (id === 245) return uniform(topSides(tiles.redPowerWorld + 50, tiles.redPowerWorld + 51));
  if (id === 213) return armchair(meta);
  if (id >= 214 && id <= 217) return sofa(id, meta);
  if (id >= 200 && id <= 220) return furniture(id, meta);
  if ([2250, 2252, 2253, 2254, 2255].includes(id)) return shelf(id, meta, data);
  if ([2240, 2248].includes(id)) {
    const options = { approximation: APPROX_BIBLIO };
    const angle = (3 - (data?.deskAngle ?? 3)) & 3;
    const wood = planks[meta & 3];
    return [
      turnedBox([0, 0.6875, 0.0625, 1, 0.875, 0.9375], wood, angle, options),
      ...[0.0625, 0.8125].map(x => turnedBox([x, 0, 0.125, x + 0.125, 0.6875, 0.875], wood, angle, options)),
    ];
  }
  if (id === 2249) return [
    box([0.125, 0, 0.125, 0.875, 0.0625, 0.875], 6, { approximation: APPROX_BIBLIO }),
    box([0.4375, 0.0625, 0.4375, 0.5625, 1, 0.5625], 4, { approximation: APPROX_BIBLIO }),
    box([0.1875, 0.875, 0.4375, 0.8125, 1, 0.5625], 4, { approximation: APPROX_BIBLIO }),
  ];
  return null;
}

function vanillaShape(id, meta, neighbors) {
  if (id >= 3909 && id <= 3924) return torch(3270 + id - 3909, meta, true);
  if (STAIRS[id] !== undefined) return stairs(id, meta, neighbors);
  if (TERRAIN[id] !== undefined) return uniform(TERRAIN[id]);
  if (plants[id] !== undefined) {
    const tile = id === 31 ? [55, 39, 56][meta] ?? 39 : id === 59 ? 88 + (meta & 7)
      : id === 6 ? [15, 63, 79, 30][meta & 3] : plants[id];
    return cross(tile, id === 30 || id === 51 ? 1 : 0.84, id === 31 ? WARM_GRASS : undefined);
  }
  switch (id) {
    case 2: return [
      box(CUBE, topSides(3, 0, 2), { tintFaces: [null, null, null, WARM_GRASS, null, null] }),
    ];
    case 5: return uniform(planks[meta & 3]);
    case 8:
    case 9: {
      const depth = neighbors && [8, 9].includes(unpack(neighbors(0, 1, 0))[0]) ? 1 : (meta < 8 ? 1 - (meta + 1) / 9 : 1);
      return [box([0, 0, 0, 1, depth, 1], tiles.water, { mode: 'blend', solid: false })];
    }
    case 10:
    case 11: return [box([0, 0, 0, 1, meta < 8 ? 1 - (meta + 1) / 9 : 1, 1], tiles.lava, { solid: false, emissive: true })];
    case 17: return uniform(log(meta));
    // The reference client's Fast trees select the opaque tile next to each leaf tile.
    case 18: return uniform([53, 133, 53, 197][meta & 3], { tint: [WARM_LEAVES, 0x619961, 0x80a755, WARM_LEAVES][meta & 3] });
    case 20: return uniform(49, GLASS);
    case 23:
    case 61:
    case 62: return uniform(faceMaterial(topSides(45, 62), ({ 2: 4, 3: 5, 4: 0, 5: 1 })[meta] ?? 5,
      id === 23 ? 46 : id === 62 ? 61 : 44), id === 62 ? LIGHT : undefined);
    case 24: return uniform(sandstone(meta));
    case 25: return uniform(topSides(74, 75));
    case 26: return [turnedBox([0, 0, 0, 1, 0.5625, 1], topSides(151, meta & 8 ? 135 : 134, 4), meta & 3)];
    case 27:
    case 28:
    case 66: return [box([0, 0.015625, 0, 1, 0.0390625, 1],
      id === 66 ? ((meta & 7) >= 6 ? 112 : 128) : id === 27 ? (meta & 8 ? 163 : 179) : 195,
      { mode: 'cutout', solid: false, rotation: (meta & 1) * Math.PI / 2, approximation: 'Flat rail geometry' })];
    case 29:
    case 33:
    case 34: return uniform(faceMaterial(109, [2, 3, 4, 5, 0, 1][meta & 7] ?? 3, id === 29 ? 106 : 107));
    case 35: return uniform(wool[meta]);
    case 43:
    case 44:
    case 125:
    case 126: {
      const faceTiles = id >= 125 ? planks[meta & 3] : stoneSlab[meta & 7] ?? 6;
      const bottom = meta & 8 ? 0.5 : 0;
      return id === 44 || id === 126 ? [box([0, bottom, 0, 1, bottom + 0.5, 1], faceTiles)] : uniform(faceTiles);
    }
    case 46: return uniform(topSides(8, 9, 10));
    case 47: return uniform(topSides(35, 4));
    case 50:
    case 75:
    case 76: {
      const tile = id === 50 ? 80 : id === 75 ? 115 : 99;
      return torch(tile, meta, id !== 75);
    }
    case 54:
    case 130: return [turnedBox([0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375],
      [tiles.chest + 4, tiles.chest + 4, tiles.chest + 4, tiles.chest + 5, tiles.chest + 4, tiles.chest + 6],
      ({ 2: 2, 3: 0, 4: 3, 5: 1 })[meta] ?? 0, { uv: 'box' })];
    case 55: return [box([0, 0.0125, 0, 1, 0.025, 1], 164, { mode: 'cutout', solid: false })];
    case 58: return uniform(topSides(59, 43, 4));
    case 60: return [box([0, 0, 0, 1, 0.9375, 1], topSides(2, meta > 0 ? 86 : 87))];
    case 63:
    case 68: return signGeometry(meta, id === 68);
    case 64:
    case 71: return door(id, meta, neighbors);
    case 65: return [wallPlate(meta, 1, 0, 1, 0.125, 83, { mode: 'cutout', solid: false, climbable: true })];
    case 69: {
      const side = meta & 7;
      const pressed = Boolean(meta & 8);
      const base = [0.3125, 0, 0.25, 0.6875, 0.1875, 0.75];
      const shaft = pressed ? [0.4375, 0.125, 0.55, 0.5625, 0.38, 0.67] : [0.4375, 0.125, 0.33, 0.5625, 0.5, 0.45];
      if (side === 5 || side === 6) return [turnedBox(base, 16, side & 1, GROUND_DECOR), turnedBox(shaft, 4, side & 1, GROUND_DECOR)];
      if (side === 0 || side === 7) {
        const flip = ([x0, y0, z0, x1, y1, z1]) => [x0, 1 - y1, z0, x1, 1 - y0, z1];
        return [turnedBox(flip(base), 16, side & 1, GROUND_DECOR), turnedBox(flip(shaft), 4, side & 1, GROUND_DECOR)];
      }
      const mount = [5, 4, 3, 2][side - 1];
      return [wallPlate(mount, 0.375, 0.25, 0.75, 0.1875, 16, GROUND_DECOR),
        wallPlate(mount, 0.125, pressed ? 0.29 : 0.48, pressed ? 0.5 : 0.71, 0.375, 4, GROUND_DECOR)];
    }
    case 77:
    case 143: return [wallPlate(({1: 5, 2: 4, 3: 3, 4: 2})[meta & 7], 0.375, 0.375, 0.625,
      meta & 8 ? 0.0625 : 0.125, id === 77 ? 1 : 4, GROUND_DECOR)];
    case 70:
    case 72: return [box([0.0625, 0, 0.0625, 0.9375, meta & 1 ? 0.03125 : 0.0625, 0.9375], id === 70 ? 1 : 4, GROUND_DECOR)];
    case 78: return [box([0, 0, 0, 1, ((meta & 7) + 1) / 8, 1], 66, { solid: meta > 0 })];
    case 79: return uniform(67, { mode: 'blend' });
    case 81: return [box([0.0625, 0, 0.0625, 0.9375, 1, 0.9375], topSides(70, 69, 71))];
    case 84: return uniform(topSides(74, 75));
    case 85:
    case 113:
    case 139: return fence(id, meta, neighbors);
    case 86:
    case 91: return uniform(rotateFaces([118, 118, 102, 102, 118, id === 91 ? 120 : 119], meta & 3), id === 91 ? LIGHT : undefined);
    case 88: return [box([0, 0, 0, 1, 0.875, 1], 104)];
    case 89: return uniform(105, LIGHT);
    case 90: return [box([0, 0, 0.375, 1, 1, 0.625], 14, { mode: 'blend', solid: false, emissive: true })];
    case 92: return [box([0.0625 + (meta & 7) * 0.125, 0, 0.0625, 0.9375, 0.5, 0.9375], topSides(122, 121, 124))];
    case 93:
    case 94: return [box([0, 0, 0, 1, 0.125, 1], topSides(5, id === 94 ? 147 : 131), GROUND_DECOR)];
    case 96: {
      const y = meta & 8 ? 0.8125 : 0;
      return [meta & 4 ? wallPlate([2, 3, 4, 5][meta & 3], 1, 0, 1, 0.1875, 84, GLASS)
        : box([0, y, 0, 1, y + 0.1875, 1], 84, GLASS)];
    }
    case 97: return uniform([1, 16, 54][meta] ?? 1);
    case 98: return uniform(stoneBrick[meta & 3]);
    case 99:
    case 100: return uniform(id === 99 ? 142 : 141);
    case 101:
    case 102: return fence(id, meta, neighbors, true);
    case 106: return vine(meta);
    case 107: {
      const parts = [[0,0.3125,0.375,0.125,1,0.625], [0.875,0.3125,0.375,1,1,0.625]];
      if (meta & 4) {
        const [z0,z1] = meta & 2 ? [0.125,0.5] : [0.5,0.875];
        for (const x of [0.125,0.75]) {
          parts.push([x,0.375,z0,x + 0.125,0.5,z1], [x,0.75,z0,x + 0.125,0.875,z1]);
          const tail = (meta & 2 ? z0 : z1 - 0.125);
          parts.push([x,0.5,tail,x + 0.125,0.75,tail + 0.125]);
        }
      } else {
        parts.push([0.125,0.375,0.4375,0.875,0.5,0.5625], [0.125,0.75,0.4375,0.875,0.875,0.5625]);
        for (const x of [0.375,0.5]) parts.push([x,0.5,0.4375,x + 0.125,0.75,0.5625]);
      }
      return parts.map(bounds => turnedBox(bounds, 4, meta & 1, GROUND_DECOR));
    }
    case 111: return [box([0.0625, 0, 0.0625, 0.9375, 0.015625, 0.9375], 76,
      { mode: 'cutout', solid: false, tint: WARM_LEAVES })];
    case 116: return [box([0, 0, 0, 1, 0.75, 1], topSides(182, 166, 37))];
    case 117: return [
      box([0.0625, 0, 0.0625, 0.9375, 0.125, 0.9375], 157),
      box([0.4375, 0.125, 0.4375, 0.5625, 0.9375, 0.5625], 156, { solid: false }),
    ];
    case 118: return [
      box([0.0625, 0, 0.0625, 0.9375, 0.3125, 0.9375], 154),
      box([0, 0.3125, 0, 1, 1, 0.125], 154), box([0, 0.3125, 0.875, 1, 1, 1], 154),
      box([0, 0.3125, 0.125, 0.125, 1, 0.875], 154), box([0.875, 0.3125, 0.125, 1, 1, 0.875], 154),
    ];
    case 123:
    case 124: return uniform(id === 123 ? 211 : 212, id === 124 ? LIGHT : undefined);
    case 140: return [
      box([0.3125, 0, 0.3125, 0.6875, 0.375, 0.6875], 186),
      ...(meta > 0 ? cross(meta === 2 ? 13 : 12, 0.81).map(part => ({ ...part, y0: 0.375 })) : []),
    ];
    case 145: return [
      turnedBox([0.125, 0, 0, 0.875, 0.25, 1], 215, meta & 1),
      turnedBox([0.25, 0.25, 0.1875, 0.75, 0.625, 0.8125], 215, meta & 1),
      turnedBox([0, 0.625, 0, 1, 1, 1], 215, meta & 1),
    ];
    default: return null;
  }
}

const simpleCache = new Map();
const neighborDependent = new Set([8, 9, 53, 64, 67, 71, 85, 101, 102, 108, 109, 113, 114, 128, 134,
  135, 136, 139, 750, 4039]);
const dynamic = new Set([...neighborDependent, 751, 765, 768, 2240, 2248, 2250, 2252, 2253, 2254, 2255]);
// Static building materials with no model data or active block behavior.
const chiselMaterialIds = new Set([1, 2, 3, 4, 5, 14, 15, 16, 17, 21, 22, 24, 35, 41, 42, 43,
  45, 48, 49, 56, 57, 80, 82, 87, 98, 110, 112, 121, 129, 133, 162, 242, 244, 245, 701]);
const chiselMaterialShapes = new Map();

export function chiselMaterialShape(key) {
  const match = typeof key === 'string' && key.length <= 24 && legacyKey.exec(key);
  if (!match) return null;
  const id = Number(match[1]), meta = Number(match[2]);
  if (key !== `legacy:${id}:${meta}` || meta > 15 || !chiselMaterialIds.has(id) || staticEmission[id]) return null;
  if (chiselMaterialShapes.has(key)) return chiselMaterialShapes.get(key);
  const [shape, extra] = shapeFor(key);
  const allowed = shape && !extra && shape.solid && shape.mode === 'opaque' && !shape.emissive && !shape.approximation
    && shape.x0 === 0 && shape.y0 === 0 && shape.z0 === 0 && shape.x1 === 1 && shape.y1 === 1 && shape.z1 === 1
    && shape.faces.every(tile => Number.isInteger(tile) && tile >= 0 && tile < ATLAS_GRID ** 2);
  const result = allowed ? shape : null;
  chiselMaterialShapes.set(key, result);
  return result;
}

export function shapeDependsOnNeighbors(cell) {
  const [id, meta] = unpack(cell);
  return neighborDependent.has(id) && (id !== 750 || meta !== 0);
}


export function shapeFor(cell, neighbors) {
  const key = keyOf(cell);
  if (key === voxelKey) return voxelCollisionBoxes(cell.voxels);
  if (key === 'game:switch') return [box([0.375, 0.25, 0.75, 0.625, 0.65, 1], 96, GROUND_DECOR)];
  if (key === 'game:door') return [box([0, 0, 0.40625, 1, 1, 0.59375], 97, GLASS)];
  if (key === 'air') return AIR;
  if (key.startsWith('cover-material:')) {
    return uniform(covers[Number(key.slice(15))] ?? cobble);
  }
  const [id, meta] = unpack(cell);
  if (id === 0) return AIR;
  if (id === 96 && hasHatchRung(cell)) {
    return [...vanillaShape(id, meta, neighbors), ...vanillaShape(65, westCellarLadder, neighbors)];
  }
  const cacheable = !dynamic.has(id);
  if (cacheable && simpleCache.has(key)) return simpleCache.get(key);
  const result = vanillaShape(id, meta, neighbors) ?? specialShape(id, meta, cell, neighbors)
    ?? uniform(tiles.unknown, { approximation: 'Unknown legacy block definition' });
  if (cacheable) simpleCache.set(key, result);
  return result;
}

const frameCollision = [box(CUBE, tiles.redPowerMachine + 1)];
const brewingStandCollision = [box([0, 0, 0, 1, 0.125, 1], 157),
  box([0.4375, 0, 0.4375, 0.5625, 0.875, 0.5625], 156)];
const wireMetadata = new Set([1, 2, 3, 5]);
const wirePostCollision = box(jacketBounds, tiles.redPowerWire + 1);
const solidCache = new WeakMap();
export function collisionFor(cell, neighbors) {
  if (keyOf(cell) === voxelKey) return voxelCollisionBoxes(cell.voxels);
  const [id, meta] = unpack(cell);
  if (id === 765) return frameCollision;
  if (id === 768) return shapedLampCollision;
  if (id === 117) return brewingStandCollision;
  if (id === 92) {
    const [cake] = shapeFor(cell);
    return [{...cake, y1: 7 / 16}];
  }
  if (id === 85 || id === 113) {
    const [west,east,north,south] = fenceLinks(id, neighbors, false);
    return [box([west ? 0 : .375, 0, north ? 0 : .375, east ? 1 : .625, 1.5, south ? 1 : .625], id === 85 ? 4 : 224)];
  }
  if (id === 107) return meta & 4 ? AIR : [turnedBox([0,0,0.375,1,1.5,0.625], 4, meta & 1)];
  if (id === 750 && wireMetadata.has(meta)) {
    const parts = coverBoxes(Array.isArray(cell?.parts) ? cell.parts : AIR, false);
    const data = cell?.object?.data ?? cell?.object ?? cell?.data;
    // RedPower TileWiring exposes covers and the center post as solid parts.
    return data?.cons & 64 ? [...parts, wirePostCollision] : parts;
  }
  const shape = shapeFor(cell, neighbors);
  if (!solidCache.has(shape)) {
    solidCache.set(shape, shape.every(part => part.solid) ? shape : shape.filter(part => part.solid));
  }
  return solidCache.get(shape);
}
