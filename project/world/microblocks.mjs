import { coverBoxes, coverPartTypes, isCoverMaterial } from './geometry.mjs';

export const microblockKey = 'legacy:750:0';
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

export function isMicroPart(part) {
  if (!Number.isInteger(part?.slot) || !Number.isInteger(part.shape) || !isCoverMaterial(part.material)) return false;
  const type = partType(part.slot);
  return Boolean(type && part.shape >= 0 && part.shape < type.shapes);
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

export function microblockAddition(parts, part) {
  if (!isMicroPart(part) || parts.some(existing => existing.slot === part.slot)) return null;
  const clean = {slot: part.slot, shape: part.shape, material: part.material};
  const current = footprint(coverBoxes(parts));
  const candidate = standaloneFootprint(clean);
  if (!candidate || [...current.values()].some(rows => rows.some((row, index) => row & candidate[index]))) return null;
  const next = [...parts, clean].sort((a, b) => a.slot - b.slot);
  const boxes = coverBoxes(next);
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

export function microblockPlacement(world, selection, held, {rotation = 0, adjacent = false} = {}) {
  if (!isMicroPart(held) || !selection?.hit || !selection.offset) return null;
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
