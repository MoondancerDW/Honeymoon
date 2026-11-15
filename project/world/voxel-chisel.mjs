import {chiselMaterialShape} from './geometry.mjs';

export const voxelKey = 'voxel:chisel';
export const VOXEL_SIZE = 8;
export const VOXEL_COUNT = VOXEL_SIZE ** 3;
export const VOXEL_MATERIAL_LIMIT = VOXEL_COUNT;

const axes = ['x', 'y', 'z'];
const strides = [1, 64, 8];
const empty = Object.freeze([]);
const fullSolid = Object.freeze([Object.freeze({x0:0, y0:0, z0:0, x1:1, y1:1, z1:1, solid:true, mode:'opaque'})]);
const decodedStates = new WeakMap();
const collisionStates = new WeakMap();
const selectionStates = new WeakMap();
const fluidKinds = ['water', 'lava'];
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

export function voxelBrush(index, size) {
  if (!isIndex(index) || (size !== 1 && size !== 2)) throw new RangeError('Invalid chisel brush');
  const low = voxelCoordinate(index).map(value => value - value % size);
  const high = low.map(value => value + size);
  const indices = [];
  for (let y = low[1]; y < high[1]; y++) {
    for (let z = low[2]; z < high[2]; z++) {
      for (let x = low[0]; x < high[0]; x++) indices.push(voxelIndex(x, y, z));
    }
  }
  return {indices, box:voxelBounds(low, high)};
}

export function voxelRemovalBrush(voxels, index, size) {
  const brush = voxelBrush(index, size);
  return size === 2 && voxels && !voxels.quarters?.includes(brush.indices[0]) ? voxelBrush(index, 1) : brush;
}

function voxelState(samples, materials) {
  const shapes = materials.map(chiselMaterialShape);
  const count = samples.reduce((n, value) => n + Number(value !== 0), 0);
  const allSolid = shapes.every(shape => shape.solid);
  const anySolid = shapes.some(shape => shape.solid);
  const fullFluid = count === VOXEL_COUNT && shapes[0].fluid && shapes.every(shape => shape.fluid === shapes[0].fluid)
    ? shapes[0].fluid : null;
  const opaque = allSolid && shapes.every(shape => shape.mode === 'opaque');
  return {samples, count, shapes, allSolid, anySolid, opaque, fullFluid};
}

function decoded(voxels) {
  if (!voxels || typeof voxels !== 'object') return null;
  if (decodedStates.has(voxels)) return decodedStates.get(voxels);
  const {materials, data} = voxels;
  if (!Array.isArray(materials) || !materials.length || materials.length > VOXEL_MATERIAL_LIMIT ||
      materials.some(material => !isChiselMaterial(material)) || new Set(materials).size !== materials.length ||
      typeof data !== 'string') return null;
  const wide = materials.length > 255;
  if (!(wide ? /^[A-Za-z0-9+/]{1366}==$/ : /^[A-Za-z0-9+/]{683}=$/).test(data)) return null;
  const bytes = atob(data);
  if (btoa(bytes) !== data) return null;
  const samples = wide ? new Uint16Array(VOXEL_COUNT) : Uint8Array.from(bytes, char => char.charCodeAt(0));
  if (wide) for (let i = 0; i < VOXEL_COUNT; i++) samples[i] = bytes.charCodeAt(i * 2) | bytes.charCodeAt(i * 2 + 1) << 8;
  if (samples.length !== VOXEL_COUNT || samples.some(value => value > materials.length)) return null;
  const state = voxelState(samples, materials);
  decodedStates.set(voxels, state);
  return state;
}

// Callers treat a decoded snapshot as immutable. Edits copy the typed array.
export const decodeVoxels = voxels => decoded(voxels)?.samples ?? null;
export const isFullVoxels = voxels => decoded(voxels)?.count === VOXEL_COUNT;
export const isSolidFullVoxels = voxels => isFullVoxels(voxels) && decoded(voxels).allSolid;
export const isOpaqueFullVoxels = voxels => isFullVoxels(voxels) && decoded(voxels).opaque;
export const fullVoxelFluid = voxels => decoded(voxels)?.fullFluid ?? null;

export function encodeVoxels(samples, materials) {
  if (!(samples instanceof Uint8Array || samples instanceof Uint16Array) || samples.length !== VOXEL_COUNT || !Array.isArray(materials) ||
      materials.length > VOXEL_MATERIAL_LIMIT + 1 ||
      materials.some(material => !isChiselMaterial(material)) || new Set(materials).size !== materials.length ||
      samples.some(value => value > materials.length)) throw new RangeError('Invalid chisel volume');
  const used = [...new Set(samples)].filter(Boolean).map(index => materials[index - 1]).sort();
  if (!used.length) return null;
  if (used.length > VOXEL_MATERIAL_LIMIT) throw new RangeError('Too many chisel materials');
  const remap = [0, ...materials.map(material => used.indexOf(material) + 1)];
  const packed = (used.length > 255 ? Uint16Array : Uint8Array).from(samples, value => remap[value]);
  let bytes = packed;
  if (packed instanceof Uint16Array) {
    bytes = new Uint8Array(VOXEL_COUNT * 2);
    for (let i = 0; i < VOXEL_COUNT; i++) {
      bytes[i * 2] = packed[i] & 255;
      bytes[i * 2 + 1] = packed[i] >> 8;
    }
  }
  const result = {materials:used, data:btoa(String.fromCharCode(...bytes))};
  decodedStates.set(result, voxelState(packed, used));
  return result;
}

export function filledVoxels(material) {
  return encodeVoxels(new Uint8Array(VOXEL_COUNT).fill(1), [material]);
}

export function voxelMaterialAt(voxels, index) {
  if (!isIndex(index)) return null;
  return voxels?.materials?.[(decodeVoxels(voxels)?.[index] ?? 0) - 1] ?? null;
}

export function voxelFluidAt(voxels, x, y, z) {
  const state = decoded(voxels);
  if (!state || !isCoordinate(x) || !isCoordinate(y) || !isCoordinate(z)) return null;
  return state.shapes[state.samples[voxelIndex(x, y, z)] - 1]?.fluid ?? null;
}

export function writeVoxel(voxels, index, material) {
  return writeVoxelBrush(voxels, voxelBrush(index, 1), material);
}

export function writeVoxelBrush(voxels, brush, material) {
  if (material !== null && !isChiselMaterial(material)) throw new RangeError('Invalid chisel edit');
  const input = voxels ? decodeVoxels(voxels) : null;
  if (voxels && !input) throw new RangeError('Invalid chisel volume');
  if (brush.indices.every(index => (voxels?.materials?.[(input?.[index] ?? 0) - 1] ?? null) === material)) return voxels ?? null;
  const materials = voxels ? voxels.materials.slice() : [];
  let value = 0;
  if (material !== null) {
    value = materials.indexOf(material) + 1;
    if (!value) value = materials.push(material);
  }
  const samples = value > 255 && input instanceof Uint8Array ? Uint16Array.from(input) :
    input?.slice() ?? new Uint8Array(VOXEL_COUNT);
  for (const index of brush.indices) samples[index] = value;
  const result = encodeVoxels(samples, materials);
  if (!result) return null;
  // One quarter placement occupies eight samples. A precise cut separates that group.
  const changedGroups = new Set(brush.indices.map(index => voxelBrush(index, 2).indices[0]));
  const quarters = (voxels?.quarters ?? []).filter(index => !changedGroups.has(index));
  if (material !== null && brush.indices.length === 8) quarters.push(brush.indices[0]);
  if (quarters.length) result.quarters = quarters.sort((a, b) => a - b);
  return result;
}

function inwardVoxel(cell, hit, face, voxels) {
  if (!Array.isArray(face) || face.length !== 3 || face.some(value => ![-1,0,1].includes(value)) ||
      face.filter(Boolean).length !== 1) return null;
  const normalAxis = face.findIndex(Boolean);
  const state = decoded(voxels);
  if (voxels && !state) return null;
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
    if (!state) return [x, y, z];
    const value = state.samples[index];
    if (!value) continue;
    const coordinate = [x, y, z];
    const adjacent = coordinate[normalAxis] + face[normalAxis];
    const next = isCoordinate(adjacent) && state.samples[index + face[normalAxis] * strides[normalAxis]];
    if (!next || state.shapes[value - 1].solid && state.shapes[next - 1].fluid) return coordinate;
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

export function voxelSelectionBoxes(voxels) {
  const state = decoded(voxels);
  if (!state?.count) return empty;
  if (state.allSolid && state.count === VOXEL_COUNT) return fullSolid;
  if (!selectionStates.has(voxels)) {
    const kinds = state.shapes.map(shape => shape.solid ? 1 : shape.fluid === 'water' ? 2 : shape.fluid === 'lava' ? 3 : 4);
    const mask = Uint8Array.from(state.samples, value => kinds[value - 1] ?? 0);
    selectionStates.set(voxels, mergeVoxelBoxes(mask));
  }
  return selectionStates.get(voxels);
}

export function voxelCollisionBoxes(voxels) {
  const state = decoded(voxels);
  if (!state?.count || !state.anySolid) return empty;
  if (state.allSolid) return voxelSelectionBoxes(voxels);
  if (collisionStates.has(voxels)) return collisionStates.get(voxels);
  const solid = state.shapes.map(shape => Number(shape.solid));
  const result = mergeVoxelBoxes(Uint8Array.from(state.samples, value => solid[value - 1] ?? 0));
  collisionStates.set(voxels, result);
  return result;
}

function mergeVoxelBoxes(mask) {
  const result = [];
  for (let y = 0; y < 8; y++) for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) {
    const kind = mask[voxelIndex(x, y, z)];
    if (!kind) continue;
    let x1 = x + 1, y1 = y + 1, z1 = z + 1;
    while (x1 < 8 && mask[voxelIndex(x1, y, z)] === kind) x1++;
    const row = (yy, zz) => {
      for (let xx = x; xx < x1; xx++) if (mask[voxelIndex(xx, yy, zz)] !== kind) return false;
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
    const fluid = fluidKinds[kind - 2];
    result.push({...voxelBounds([x, y, z], [x1, y1, z1]), solid:kind === 1,
      mode:fluid === 'water' ? 'blend' : 'opaque', ...(fluid && {fluid})});
  }
  return result;
}

export function voxelFaces(voxels, neighbor, opaqueFullNeighbor) {
  const samples = decodeVoxels(voxels);
  if (!samples) return empty;
  const result = [];
  const materials = decoded(voxels).shapes;
  const mask = new Uint16Array(64);
  for (let face = 0; face < 6; face++) {
    const axis = face >> 1, positive = face & 1;
    const side = positive ? 1 : -1;
    const uAxis = (axis + 1) % 3, vAxis = (axis + 2) % 3;
    const [normal, uStride, vStride] = [strides[axis], strides[uAxis], strides[vAxis]];
    const adjacentCell = neighbor?.(face);
    const adjacentVoxels = adjacentCell?.voxels;
    const adjacentState = decoded(adjacentVoxels);
    const adjacent = adjacentState?.samples;
    const adjacentOpaque = !adjacent && opaqueFullNeighbor?.(face);
    const adjacentMaterial = adjacent || adjacentOpaque !== undefined ? null :
      chiselMaterialShape(typeof adjacentCell === 'string' ? adjacentCell : adjacentCell?.key);
    const coversBoundary = !adjacent && Boolean(adjacentOpaque ?? (adjacentMaterial?.solid && adjacentMaterial.mode === 'opaque'));
    for (let slice = 0; slice < 8; slice++) {
      const boundary = slice === (positive ? 7 : 0);
      if (boundary && coversBoundary) continue;
      const plane = slice * normal;
      const neighborPlane = (positive ? 0 : 7) * normal;
      for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
        const offset = u * uStride + v * vStride;
        const value = samples[plane + offset];
        if (!value) {
          mask[u + 8 * v] = 0;
          continue;
        }
        const next = boundary ? adjacent?.[neighborPlane + offset] : samples[plane + offset + side * normal];
        const current = materials[value - 1];
        const nextShape = next && (boundary ? adjacentState.shapes : materials)[next - 1];
        const covered = nextShape && (nextShape === current || (current.fluid && current.fluid === nextShape.fluid) ||
          nextShape.solid && nextShape.mode === 'opaque');
        mask[u + 8 * v] = covered ? 0 : value;
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
