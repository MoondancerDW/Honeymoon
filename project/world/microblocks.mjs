import { coverBoxes, coverPartTypes, isCoverMaterial } from './geometry.mjs';
import { decodeVoxels, voxelIndex } from './voxel-chisel.mjs';

export const microblockKey = 'legacy:750:0';
export const FIRST_FREE_PART_SLOT = 29;
export const PART_SLOT_LIMIT = FIRST_FREE_PART_SLOT + 512;
const minima = ['x0', 'y0', 'z0'];
const maxima = ['x1', 'y1', 'z1'];
const axes = ['x', 'y', 'z'];
const empty = Object.freeze([]);
const keyOf = cell => typeof cell === 'string' ? cell : cell?.key ?? 'air';
const partType = slot => coverPartTypes.find(({first, end}) => slot >= first && slot < end);
const footprints = new WeakMap();
const standalone = new Map();
const placementOptions = new Map();
const placementCacheCapacity = 16;
const orientedPatterns = new WeakMap();
const rotatedPatterns = new WeakMap();

export function isMicroPart(part) {
  if (!Number.isInteger(part?.slot) || !Number.isInteger(part.shape) || !isCoverMaterial(part.material)) return false;
  const free = part.slot >= FIRST_FREE_PART_SLOT && part.slot < PART_SLOT_LIMIT;
  const type = partType(free ? part.sourceSlot : part.slot);
  return Boolean(type && part.shape >= 0 && part.shape < type.shapes && (free ?
    Number.isInteger(part.sourceSlot) && isPartPattern(part.bounds) : part.bounds === undefined));
}

export const publicMicroPart = ({slot, shape, material, sourceSlot, bounds}) =>
  ({slot, shape, material, ...(bounds && {sourceSlot, bounds})});

export function isPartPattern(bounds) {
  return Array.isArray(bounds) && bounds.length > 0 && bounds.length <= 8 && bounds.every(box =>
    Array.isArray(box) && box.length === 6 && box.every(value => Number.isInteger(value) && value >= 0 && value <= 8) &&
    axes.every((_, index) => box[index] < box[index + 3]));
}

export function isMicroblockCell(cell) {
  const key = keyOf(cell);
  return Array.isArray(cell?.parts) && (key === microblockKey || key.startsWith('cover:750:0:'));
}

// All RedPower cover bounds lie on the eighth grid. Compare occupancy by
// logical slot so a new part cannot trim or hide existing geometry.
function footprint(boxes) {
  if (footprints.has(boxes)) return footprints.get(boxes);
  const result = new Map();
  for (const box of boxes) {
    let rows = result.get(box.partSlot);
    if (!rows) result.set(box.partSlot, rows = new Uint8Array(64));
    const low = minima.map(axis => box[axis] * 8);
    const high = maxima.map(axis => box[axis] * 8);
    const xBits = (1 << high[0]) - (1 << low[0]);
    for (let y = low[1]; y < high[1]; y++) for (let z = low[2]; z < high[2]; z++) {
      rows[y * 8 + z] |= xBits;
    }
  }
  footprints.set(boxes, result);
  return result;
}

function standaloneFootprint({slot, shape}) {
  const id = slot * 16 + shape;
  if (!standalone.has(id)) standalone.set(id, footprint(coverBoxes([{slot, shape, material: 0}])).get(slot));
  return standalone.get(id);
}

function matchesFootprint(actual, expected) {
  return actual !== undefined && expected !== undefined && actual.every((row, i) => row === expected[i]);
}

export function partBoxesOverlapVoxels(boxes, voxels) {
  const samples = decodeVoxels(voxels);
  if (!samples) return false;
  for (const box of boxes) {
    for (let y = box.y0 * 8; y < box.y1 * 8; y++) {
      for (let z = box.z0 * 8; z < box.z1 * 8; z++) {
        for (let x = box.x0 * 8; x < box.x1 * 8; x++) {
          if (samples[voxelIndex(x, y, z)]) return true;
        }
      }
    }
  }
  return false;
}

export function partBoxesOverlapBox(boxes, candidate) {
  return boxes.some(box => axes.every(axis => box[axis + '0'] < candidate[axis + '1'] &&
    box[axis + '1'] > candidate[axis + '0']));
}

export function microblockAddition(parts, part, voxels) {
  if (!isMicroPart(part) || parts.some(existing => existing.slot === part.slot)) return null;
  const clean = publicMicroPart(part);
  const current = footprint(coverBoxes(parts));
  const candidate = clean.bounds ? footprint(coverBoxes([clean])).get(clean.slot) : standaloneFootprint(clean);
  if (!candidate || [...current.values()].some(rows => rows.some((row, index) => row & candidate[index]))) return null;
  const next = [...parts, clean].sort((a, b) => a.slot - b.slot);
  const boxes = coverBoxes(next);
  if (voxels && partBoxesOverlapVoxels(boxes, voxels)) return null;
  const combined = footprint(boxes);
  if (!matchesFootprint(combined.get(part.slot), candidate)) return null;
  for (const [slot, rows] of current) if (!matchesFootprint(combined.get(slot), rows)) return null;
  return {parts: next, boxes};
}

export function microblockRemoval(parts, slot, {mayReshape = () => false} = {}) {
  if (!parts.some(part => part.slot === slot)) return null;
  const current = footprint(coverBoxes(parts));
  const next = parts.filter(part => part.slot !== slot);
  const boxes = coverBoxes(next);
  const combined = footprint(boxes);
  let reshaped = false;
  // Legacy copies may contain joined parts whose bounds expand on removal.
  // Keep other owners' and imported parts fixed even in such a composition.
  for (const part of next) {
    const original = current.get(part.slot);
    const remaining = combined.get(part.slot);
    if (original === remaining || matchesFootprint(original, remaining)) continue;
    if (!mayReshape(part.slot)) return null;
    reshaped = true;
  }
  return {parts: next, boxes, reshaped};
}

function boxDistance(box, local) {
  return axes.reduce((distance, _, i) => distance +
    Math.max(box[minima[i]] - local[i], local[i] - box[maxima[i]], 0) ** 2, 0);
}

function availableParts(parts, held) {
  const type = partType(held.slot);
  const choice = `${type.first},${held.shape},${held.material}`;
  const cached = placementOptions.get(parts);
  if (cached) placementOptions.delete(parts);
  if (cached?.choice === choice) {
    placementOptions.set(parts, cached);
    return cached.parts;
  }

  const occupiedSlots = new Set(parts.map(part => part.slot));
  const available = [];
  for (let slot = type.first; slot < type.end; slot++) {
    if (occupiedSlots.has(slot)) continue;
    const part = {slot, shape: held.shape, material: held.material};
    const addition = microblockAddition(parts, part);
    if (!addition) continue;
    available.push({part, boxes: addition.boxes.filter(box => box.partSlot === slot)});
  }
  // Keep only recently aimed compositions, including repeated use of empty cells.
  if (placementOptions.size >= placementCacheCapacity) placementOptions.delete(placementOptions.keys().next().value);
  placementOptions.set(parts, {choice, parts: available});
  return available;
}

export function microblockPattern(boxes) {
  const pattern = boxes.map(box => [box.x0, box.y0, box.z0, box.x1, box.y1, box.z1].map(value => value * 8));
  if (!isPartPattern(pattern)) return null;
  const start = axes.map((_, axis) => Math.min(...pattern.map(box => box[axis])));
  return pattern.map(box => box.map((value, index) => value - start[index % 3]));
}

const rotations = [];
for (const permutation of [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]]) {
  const inversions = permutation.reduce((count, value, index) =>
    count + permutation.slice(index + 1).filter(next => value > next).length, 0);
  for (const sx of [1, -1]) for (const sy of [1, -1]) {
    const signs = [sx, sy, sx * sy * (inversions % 2 ? -1 : 1)];
    rotations.push({permutation, signs});
  }
}

function dimensions(pattern) {
  return axes.map((_, axis) => Math.max(...pattern.map(box => box[axis + 3])));
}

function rotatedPattern(pattern, orientation) {
  const rotation = rotations[orientation];
  if (!rotation) return null;
  let cache = rotatedPatterns.get(pattern);
  if (!cache) rotatedPatterns.set(pattern, cache = []);
  if (cache[orientation]) return cache[orientation];
  const size = dimensions(pattern);
  const {permutation, signs} = rotation;
  const result = pattern.map(box => box.map((_, index) => {
    const axis = index % 3;
    const source = permutation[axis];
    const corner = index < 3 ? 0 : 3;
    return signs[axis] > 0 ? box[source + corner] : size[source] - box[source + 3 - corner];
  })).sort((a, b) => a.join(',').localeCompare(b.join(',')));
  cache[orientation] = result;
  return result;
}

// The thin side faces the hit surface by default. Use the source orientation
// whenever the same outline can face the hit without rotating it.
function orientations(pattern, normalAxis) {
  const cached = orientedPatterns.get(pattern)?.[normalAxis];
  if (cached) return cached;
  const results = new Map();
  for (const [index] of rotations.entries()) {
    const rotated = rotatedPattern(pattern, index);
    const key = JSON.stringify(rotated);
    if (!results.has(key)) results.set(key, {index, depth: dimensions(rotated)[normalAxis]});
  }
  const ordered = [...results.values()].sort((a, b) => a.depth - b.depth || a.index - b.index);
  if (!orientedPatterns.has(pattern)) orientedPatterns.set(pattern, []);
  orientedPatterns.get(pattern)[normalAxis] = ordered;
  return ordered;
}

function snapped(value) {
  const round = Math.round(value);
  return Math.abs(value - round) < 1e-6 ? round : value;
}

export function guidedMicroblock(selection, part, pattern, orientation) {
  const normalAxis = selection.offset.findIndex(Boolean);
  const normal = selection.offset[normalAxis];
  const rotated = rotatedPattern(pattern, orientation);
  if (!rotated || !normal) return null;
  const size = dimensions(rotated);
  const hit = axes.map(axis => snapped(selection.hit[axis] * 8));
  const plane = normal > 0 ? Math.ceil(hit[normalAxis]) : Math.floor(hit[normalAxis]);
  const start = normal > 0 ? plane : plane - size[normalAxis];
  const normalCell = Math.floor((normal > 0 ? plane : plane - 1) / 8);
  if (start < normalCell * 8 || start + size[normalAxis] > (normalCell + 1) * 8) return null;
  const target = axes.map((axis, i) => i === normalAxis ? normalCell : selection[axis]);
  if (axes.some((axis, i) => Math.abs(target[i] - selection[axis]) > 1 ||
      hit[i] < selection[axis] * 8 - 1e-6 || hit[i] > (selection[axis] + 1) * 8 + 1e-6)) return null;
  const shift = hit.map((value, axis) => axis === normalAxis ? start - normalCell * 8 :
    Math.max(0, Math.min(8 - size[axis], Math.floor(value - target[axis] * 8 - (size[axis] - 1) / 2))));
  const bounds = rotated.map(box => box.map((value, index) => value + shift[index % 3]));
  const against = Object.fromEntries(axes.map(axis => [axis, selection[axis]]));
  if (Number.isInteger(selection.partSlot)) against.partSlot = selection.partSlot;
  return {x:target[0], y:target[1], z:target[2], against, orientation,
    part:{slot:part.slot, sourceSlot:part.sourceSlot ?? part.slot, shape:part.shape, material:part.material, bounds}};
}

function guidedPlacement(world, selection, held, rotation) {
  const ordered = orientations(held.pattern, selection.offset.findIndex(Boolean));
  const possibilities = [];
  for (const {index} of ordered) {
    const proposal = guidedMicroblock(selection, held, held.pattern, index);
    if (!proposal) continue;
    const {x, y, z} = proposal;
    const bounds = world.manifest?.bounds;
    if (bounds && (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY ||
        z < bounds.minZ || z > bounds.maxZ)) continue;
    if (world.hasChunk && !world.hasChunk(x, z)) continue;
    const cell = world.cellAt(x, y, z);
    if (keyOf(cell) !== 'air' && !cell?.voxels && !isMicroblockCell(cell)) continue;
    const parts = cell?.parts ?? empty;
    const used = new Set(parts.map(part => part.slot));
    let slot = FIRST_FREE_PART_SLOT;
    while (used.has(slot)) slot++;
    proposal.part.slot = slot;
    const addition = microblockAddition(parts, proposal.part, cell?.voxels);
    const boxes = addition?.boxes.filter(box => box.partSlot === slot);
    if (boxes?.length) {
      possibilities.push({...proposal, boxes});
      if (rotation === 0) break;
    }
  }
  return possibilities.length ? possibilities[((rotation % possibilities.length) + possibilities.length) % possibilities.length] : null;
}

export function microblockPlacement(world, selection, held, {rotation = 0, adjacent = false} = {}) {
  if (!isMicroPart(held) || !selection?.hit || !selection.offset) return null;
  if (held.pattern) return guidedPlacement(world, selection, held, rotation);
  const anchor = axes.map(axis => selection[axis]);
  const normalAxis = selection.offset.findIndex(Boolean);
  if (normalAxis < 0) return null;
  const normal = selection.offset[normalAxis];
  const point = axes.map((axis, i) => anchor[i] +
    (Math.max(0, Math.min(7, Math.floor((selection.hit[axis] - anchor[i]) * 8))) + .5) / 8);
  const targets = [anchor.map((value, i) => value + selection.offset[i])];
  if (!adjacent && isMicroblockCell(selection.cell)) targets.unshift(anchor);
  const choices = [];
  for (const [x, y, z] of targets) {
    const bounds = world.manifest?.bounds;
    if (bounds && (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY ||
        z < bounds.minZ || z > bounds.maxZ)) continue;
    if (world.hasChunk && !world.hasChunk(x, z)) continue;
    const cell = world.cellAt(x, y, z);
    if (keyOf(cell) !== 'air' && !isMicroblockCell(cell)) continue;
    const same = x === anchor[0] && y === anchor[1] && z === anchor[2];
    const local = point.map((value, i) => value - [x, y, z][i]);
    const parts = cell?.parts ?? empty;
    if (!same) local[normalAxis] = normal > 0 ? 0 : 1;
    const candidates = [];
    for (const {part, boxes} of availableParts(parts, held)) {
      const distance = Math.min(...boxes.map(box => boxDistance(box, local)));
      const weight = distance + (part.slot === held.slot ? 0 : .00001);
      candidates.push({x, y, z, part, boxes, weight});
    }
    candidates.sort((a, b) => a.weight - b.weight || a.part.slot - b.part.slot);
    choices.push(...candidates);
  }
  if (!choices.length) return null;
  const result = choices[((rotation % choices.length) + choices.length) % choices.length];
  const {x, y, z, part, boxes} = result;
  const against = {x: selection.x, y: selection.y, z: selection.z};
  if (Number.isInteger(selection.partSlot)) against.partSlot = selection.partSlot;
  return {x, y, z, part, boxes, against};
}
