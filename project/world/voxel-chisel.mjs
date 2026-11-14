import {chiselMaterialShape} from './geometry.mjs';

export const voxelKey = 'voxel:chisel';
export const VOXEL_SIZE = 8;
export const VOXEL_COUNT = VOXEL_SIZE ** 3;
export const VOXEL_MATERIAL_LIMIT = 16;

const axes = ['x', 'y', 'z'];
const strides = [1, 64, 8];
const empty = Object.freeze([]);
const decodedStates = new WeakMap();
const collisionStates = new WeakMap();
const gridTolerance = 1e-6;

export const isChiselMaterial = key => Boolean(chiselMaterialShape(key));
const isCoordinate = value => Number.isInteger(value) && value >= 0 && value < VOXEL_SIZE;
const isIndex = index => Number.isInteger(index) && index >= 0 && index < VOXEL_COUNT;
export const voxelIndex = (x, y, z) => x + z * strides[2] + y * strides[1];
export const voxelCoordinate = index => [index & 7, index >> 6, (index >> 3) & 7];

function voxelBounds(low, high) {
  return {x0:low[0] / 8, y0:low[1] / 8, z0:low[2] / 8,
    x1:high[0] / 8, y1:high[1] / 8, z1:high[2] / 8};
}

export function voxelBox(index) {
  if (!isIndex(index)) return null;
  const low = voxelCoordinate(index);
  return voxelBounds(low, low.map(value => value + 1));
}

function decoded(voxels) {
  if (!voxels || typeof voxels !== 'object') return null;
  if (decodedStates.has(voxels)) return decodedStates.get(voxels);
  const {materials, data} = voxels;
  if (!Array.isArray(materials) || !materials.length || materials.length > VOXEL_MATERIAL_LIMIT ||
      materials.some(material => !isChiselMaterial(material)) || new Set(materials).size !== materials.length ||
      typeof data !== 'string' || !/^[A-Za-z0-9+/]{683}=$/.test(data)) return null;
  const bytes = atob(data);
  if (btoa(bytes) !== data) return null;
  const samples = Uint8Array.from(bytes, char => char.charCodeAt(0));
  if (samples.length !== VOXEL_COUNT || samples.some(value => value > materials.length)) return null;
  const state = {samples, count: samples.reduce((n, value) => n + Number(value !== 0), 0)};
  decodedStates.set(voxels, state);
  return state;
}

// Callers treat a decoded snapshot as immutable. Edits copy the typed array.
export const decodeVoxels = voxels => decoded(voxels)?.samples ?? null;
export const isFullVoxels = voxels => decoded(voxels)?.count === VOXEL_COUNT;

export function encodeVoxels(samples, materials) {
  if (!(samples instanceof Uint8Array) || samples.length !== VOXEL_COUNT || !Array.isArray(materials) ||
      materials.length > VOXEL_MATERIAL_LIMIT + 1 ||
      materials.some(material => !isChiselMaterial(material)) || new Set(materials).size !== materials.length ||
      samples.some(value => value > materials.length)) throw new RangeError('Invalid chisel volume');
  const used = [...new Set(samples)].filter(Boolean).map(index => materials[index - 1]).sort();
  if (!used.length) return null;
  if (used.length > VOXEL_MATERIAL_LIMIT) throw new RangeError('Too many chisel materials');
  const remap = [0, ...materials.map(material => used.indexOf(material) + 1)];
  const packed = samples.map(value => remap[value]);
  const result = {materials:used, data:btoa(String.fromCharCode(...packed))};
  decodedStates.set(result, {samples:packed, count: packed.reduce((n, value) => n + Number(value !== 0), 0)});
  return result;
}

export function filledVoxels(material) {
  return encodeVoxels(new Uint8Array(VOXEL_COUNT).fill(1), [material]);
}

export function voxelMaterialAt(voxels, index) {
  if (!isIndex(index)) return null;
  return voxels?.materials?.[(decodeVoxels(voxels)?.[index] ?? 0) - 1] ?? null;
}

export function writeVoxel(voxels, index, material) {
  if (!isIndex(index) || material !== null && !isChiselMaterial(material)) throw new RangeError('Invalid chisel edit');
  const input = voxels ? decodeVoxels(voxels) : null;
  if (voxels && !input) throw new RangeError('Invalid chisel volume');
  if ((voxels?.materials?.[(input?.[index] ?? 0) - 1] ?? null) === material) return voxels ?? null;
  const samples = input?.slice() ?? new Uint8Array(VOXEL_COUNT);
  const materials = voxels ? voxels.materials.slice() : [];
  let value = 0;
  if (material !== null) {
    value = materials.indexOf(material) + 1;
    if (!value) value = materials.push(material);
  }
  samples[index] = value;
  return encodeVoxels(samples, materials);
}

function inwardVoxel(cell, hit, face, voxels) {
  if (!Array.isArray(face) || face.length !== 3 || face.some(value => ![-1,0,1].includes(value)) ||
      face.filter(Boolean).length !== 1) return null;
  const normalAxis = face.findIndex(Boolean);
  const samples = decodeVoxels(voxels);
  if (voxels && !samples) return null;
  const options = [];
  for (const [axis, key] of axes.entries()) {
    const grid = (hit?.[key] - cell?.[key]) * 8;
    if (!Number.isFinite(grid) || grid < -gridTolerance || grid > 8 + gridTolerance) return null;
    const plane = Math.round(grid);
    const onPlane = Math.abs(grid - plane) <= gridTolerance;
    if (axis === normalAxis) {
      const inside = plane - Number(face[axis] > 0);
      if (!onPlane || !isCoordinate(inside)) return null;
      options.push([inside]);
    } else {
      options.push((onPlane ? [plane, plane - 1] : [Math.floor(grid)]).filter(isCoordinate));
    }
  }
  for (const x of options[0]) for (const y of options[1]) for (const z of options[2]) {
    const index = voxelIndex(x, y, z);
    if (!samples) return [x, y, z];
    const coordinate = [x, y, z];
    const adjacent = coordinate[normalAxis] + face[normalAxis];
    if (samples[index] && (!isCoordinate(adjacent) || !samples[index + face[normalAxis] * strides[normalAxis]])) {
      return coordinate;
    }
  }
  return null;
}

export function voxelAtHit(cell, hit, face, inward = true, voxels) {
  const coordinate = inwardVoxel(cell, hit, face, voxels);
  if (!coordinate) return null;
  const local = inward ? coordinate : coordinate.map((value, axis) => value + face[axis]);
  return local.every(isCoordinate) ? voxelIndex(...local) : null;
}

export function voxelPlacementAtHit(cell, hit, face, voxels) {
  const coordinate = inwardVoxel(cell, hit, face, voxels);
  if (!coordinate) return null;
  const adjacent = coordinate.map((value, axis) => value + face[axis]);
  const delta = adjacent.map(value => Math.floor(value / 8));
  const local = adjacent.map((value, axis) => value - delta[axis] * 8);
  return {x:cell.x + delta[0], y:cell.y + delta[1], z:cell.z + delta[2], voxel:voxelIndex(...local)};
}

export function voxelCollisionBoxes(voxels) {
  const state = decoded(voxels);
  if (!state?.count) return empty;
  if (collisionStates.has(voxels)) return collisionStates.get(voxels);
  const result = [];
  if (state.count === VOXEL_COUNT) {
    result.push({...voxelBounds([0, 0, 0], [8, 8, 8]), solid:true, mode:'opaque'});
  } else {
    const mask = state.samples.slice();
    for (let y = 0; y < 8; y++) for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) {
      if (!mask[voxelIndex(x, y, z)]) continue;
      let x1 = x + 1, y1 = y + 1, z1 = z + 1;
      while (x1 < 8 && mask[voxelIndex(x1, y, z)]) x1++;
      const row = (yy, zz) => {
        for (let xx = x; xx < x1; xx++) if (!mask[voxelIndex(xx, yy, zz)]) return false;
        return true;
      };
      while (z1 < 8 && row(y, z1)) z1++;
      const plane = yy => {
        for (let zz = z; zz < z1; zz++) if (!row(yy, zz)) return false;
        return true;
      };
      while (y1 < 8 && plane(y1)) y1++;
      for (let yy = y; yy < y1; yy++) for (let zz = z; zz < z1; zz++) {
        mask.fill(0, voxelIndex(x, yy, zz), voxelIndex(x1, yy, zz));
      }
      result.push({...voxelBounds([x, y, z], [x1, y1, z1]), solid:true, mode:'opaque'});
    }
  }
  collisionStates.set(voxels, result);
  return result;
}

export function voxelFaces(voxels, neighbor, opaqueFullNeighbor) {
  const samples = decodeVoxels(voxels);
  if (!samples) return empty;
  const result = [];
  const materials = voxels.materials.map(chiselMaterialShape);
  const mask = new Uint8Array(64);
  for (let face = 0; face < 6; face++) {
    const axis = face >> 1, positive = face & 1;
    const side = positive ? 1 : -1;
    const uAxis = (axis + 1) % 3, vAxis = (axis + 2) % 3;
    const [normal, uStride, vStride] = [strides[axis], strides[uAxis], strides[vAxis]];
    const adjacentCell = neighbor?.(face);
    const adjacent = adjacentCell?.key === voxelKey ? decodeVoxels(adjacentCell.voxels) : null;
    const coversBoundary = !adjacent && Boolean(opaqueFullNeighbor?.(face) ??
      isChiselMaterial(typeof adjacentCell === 'string' ? adjacentCell : adjacentCell?.key));
    for (let slice = 0; slice < 8; slice++) {
      const boundary = slice === (positive ? 7 : 0);
      if (boundary && coversBoundary) continue;
      const plane = slice * normal;
      const neighborPlane = (positive ? 0 : 7) * normal;
      for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
        const offset = u * uStride + v * vStride;
        const hidden = boundary ? adjacent?.[neighborPlane + offset] : samples[plane + offset + side * normal];
        mask[u + 8 * v] = hidden ? 0 : samples[plane + offset];
      }
      for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
        const material = mask[u + 8 * v];
        if (!material) continue;
        let u1 = u + 1, v1 = v + 1;
        while (u1 < 8 && mask[u1 + 8 * v] === material) u1++;
        const row = vv => {
          for (let check = u; check < u1; check++) if (mask[check + 8 * vv] !== material) return false;
          return true;
        };
        while (v1 < 8 && row(v1)) v1++;
        for (let vv = v; vv < v1; vv++) mask.fill(0, u + 8 * vv, u1 + 8 * vv);
        const low = [0, 0, 0], high = [0, 0, 0];
        low[axis] = high[axis] = slice + positive;
        low[uAxis] = u;
        high[uAxis] = u1;
        low[vAxis] = v;
        high[vAxis] = v1;
        result.push({face, box:{...materials[material - 1], ...voxelBounds(low, high)}});
      }
    }
  }
  return result;
}
