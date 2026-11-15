import { blockState, buttonDuration, pressurePlate, signalSides } from '../world/block-interactions.mjs';
import { cellAddress } from './base.mjs';

const horizontal = signalSides.slice(2);
const offset = (a, b, y = 0) => [a[0] + b[0], a[1] + b[1] + y, a[2] + b[2]];
const address = point => cellAddress(...point);
const repeater = id => id === 93 || id === 94;
const torch = id => id === 75 || id === 76;
const dial = [3, 4, 2, 5];
const attached = [0, 5, 4, 3, 2, 1, 1, 0];
const allSides = [0, 1, 2, 3, 4, 5];
const NOT_NORMAL_CUBE = new Set([
  8, 9, 10, 11, 18, 20, 30, 52, 54, 55, 64, 65, 69, 70, 71, 72, 75, 76, 77, 79, 85, 90, 92,
  93, 94, 95, 96, 101, 102, 107, 113, 116, 117, 118, 120, 122, 130, 138, 139, 143, 145, 750, 765, 768,
]);
const receiverIds = new Set([25, 27, 64, 71, 75, 76, 93, 94, 96, 107, 123, 124, 756, 757, 758, 759, 768]);

function cellView(cell, compositions) {
  return {key: cell?.cell ?? 'air', object: cell?.object, parts: compositions?.[cell?.cell]?.parts};
}

export function redstone(getCell, geometry, compositions) {
  const block = point => blockState(getCell(...point));
  function cube(point) {
    const cell = getCell(...point);
    const [id] = blockState(cell);
    if (!id || NOT_NORMAL_CUBE.has(id)) return false;
    const view = cellView(cell, compositions);
    const boxes = geometry.shapeFor(view);
    const box = boxes[0];
    return boxes.length === 1 && box.mode === 'opaque' && box.solid
      && box.x0 === 0 && box.y0 === 0 && box.z0 === 0 && box.x1 === 1 && box.y1 === 1 && box.z1 === 1;
  }
  function ports(point) {
    const above = offset(point, signalSides[1]);
    return horizontal.flatMap(delta => {
      const adjacent = offset(point, delta);
      if (cube(adjacent)) return cube(above) ? [] : [offset(adjacent, signalSides[1])];
      return [adjacent, offset(adjacent, signalSides[0])];
    }).filter(point => block(point)[0] === 55);
  }
  function wireSides(point) {
    const above = offset(point, signalSides[1]);
    return horizontal.map((delta, direction) => {
      const neighbor = offset(point, delta);
      const [id, meta] = block(neighbor);
      if (repeater(id)) return ((dial[meta & 3] - 2) >> 1) === (direction >> 1);
      if (id === 27 || id === 55 || id === 69 || buttonDuration(id) || pressurePlate(id) || torch(id)) return true;
      return cube(neighbor)
        ? !cube(above) && block(offset(neighbor, signalSides[1]))[0] === 55
        : block(offset(neighbor, signalSides[0]))[0] === 55;
    });
  }
  function output(point, side, strong = false, dust = true) {
    const [id, meta] = block(point);
    if (id === 69 || buttonDuration(id)) return Boolean(meta & 8) && (!strong || attached[meta & 7] === side);
    if (pressurePlate(id)) return Boolean(meta) && (!strong || side === 1);
    if (id === 76) return strong ? side === 0 : attached[meta & 7] !== side;
    if (id === 94) return dial[meta & 3] === side;
    if (id !== 55 || !meta || !dust) return false;
    if (side === 1) return true;
    if (side < 2) return false;
    const links = wireSides(point);
    const direction = (side ^ 1) - 2;
    const perpendicular = (direction & 2) ^ 2;
    return links.every(link => !link) || (links[direction] && !links[perpendicular] && !links[perpendicular + 1]);
  }
  function powered(point, dust = true, sides = allSides) {
    return signalSides.some((delta, side) => {
      if (!sides.includes(side)) return false;
      const neighbor = offset(point, delta);
      if (!cube(neighbor)) return output(neighbor, side, false, dust);
      return signalSides.some((inner, face) => output(offset(neighbor, inner), face, true, dust));
    });
  }
  function repeaterInput(point, meta) {
    const side = dial[meta & 3];
    const behind = offset(point, signalSides[side]);
    const [id, power] = block(behind);
    // Repeaters accept dust from behind even when it presents no branch in that direction.
    if (id === 55) return power > 0;
    if (cube(behind)) return signalSides.some((delta, face) => output(offset(behind, delta), face, true));
    return output(behind, side);
  }
  function repeaterLocked(point, meta) {
    const forward = dial[meta & 3];
    const start = forward < 4 ? 4 : 2;
    return [start, start + 1].some(side => {
      const neighbor = offset(point, signalSides[side]);
      return block(neighbor)[0] === 94 && output(neighbor, side);
    });
  }
  function torchPowered(point, meta) {
    const side = attached[meta & 7];
    const support = offset(point, signalSides[side ^ 1]);
    if (!cube(support)) return output(support, side ^ 1, true);
    return signalSides.some((delta, face) => output(offset(support, delta), face, true));
  }
  return { block, ports, powered, repeaterInput, repeaterLocked, torchPowered };
}

export function affectedCircuit(sources, lookup) {
  const receivers = new Map(), wires = new Map();
  const changes = sources.slice();
  const seen = new Set(sources.map(address));
  for (let index = 0; index < changes.length; index++) {
    const origin = changes[index];
    const points = signalSides.flatMap(delta => {
      const one = offset(origin, delta);
      return [one, ...signalSides.map(next => offset(one, next))];
    });
    for (const point of points) {
      const [id, meta] = lookup.block(point);
      if (receiverIds.has(id)) {
        const receiver = (id === 64 || id === 71) && (meta & 8) ? offset(point, signalSides[0]) : point;
        receivers.set(address(receiver), receiver);
      }
    }
    // Component extent stops at repeaters; their output starts the next component.
    const direct = lookup.block(origin)[0] === 55 ? lookup.ports(origin) : points.filter(point => lookup.block(point)[0] === 55);
    if (lookup.block(origin)[0] === 55) wires.set(address(origin), origin);
    for (const point of direct) {
      const key = address(point);
      if (seen.has(key)) continue;
      seen.add(key);
      changes.push(point);
    }
  }
  return { wires, receivers };
}

export function wireLevels(wires, lookup) {
  const levels = new Map();
  const queue = [];
  for (const [key, point] of wires) {
    if (!lookup.powered(point, false)) continue;
    levels.set(key, 15);
    queue.push(point);
  }
  for (let i = 0; i < queue.length; i++) {
    const point = queue[i], power = levels.get(address(point)) - 1;
    if (!power) continue;
    for (const neighbor of lookup.ports(point)) {
      const key = address(neighbor);
      if ((levels.get(key) ?? 0) >= power) continue;
      levels.set(key, power);
      queue.push(neighbor);
    }
  }
  return levels;
}
