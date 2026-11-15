import { PLAYER } from '../world/player-body.mjs';
import { intersectSelection } from '../world/selection.mjs';

export { PLAYER };
const epsilon = 0.00001;
const axisNames = ['x', 'y', 'z'];

function overlapsPlayer(position, box, x, y, z, height = PLAYER.height) {
  return position.x + PLAYER.halfWidth > x + box.x0 + epsilon
    && position.x - PLAYER.halfWidth < x + box.x1 - epsilon
    && position.y + height > y + box.y0 + epsilon
    && position.y < y + box.y1 - epsilon
    && position.z + PLAYER.halfWidth > z + box.z0 + epsilon
    && position.z - PLAYER.halfWidth < z + box.z1 - epsilon;
}

function rayBox(origin, delta, minima, maxima, open = false) {
  let first = 0;
  let last = 1;
  for (let axis = 0; axis < 3; axis++) {
    const start = origin[axis];
    const step = delta[axis];
    if (open ? step === 0 : Math.abs(step) < epsilon) {
      if (open ? start <= minima[axis] || start >= maxima[axis]
        : start < minima[axis] || start > maxima[axis]) return Infinity;
      continue;
    }
    const startHit = (minima[axis] - start) / step;
    const endHit = (maxima[axis] - start) / step;
    first = Math.max(first, Math.min(startHit, endHit));
    last = Math.min(last, Math.max(startHit, endHit));
    if (last <= first) return Infinity;
  }
  return first;
}

export function physics(base, geometry, getCell) {
  const selection = geometry.selectionFor ? 'selectionFor' : 'shapeFor';
  function boxesAt(kind, x, y, z, override, plannedNeighbor) {
    const cell = typeof override === 'string' ? { key: override, parts: base.manifest.compositions?.[override]?.parts }
      : override ?? getCell(x, y, z);
    if (!cell || cell.key === 'air') return [];
    return geometry[kind](cell, (dx, dy, dz) => plannedNeighbor?.(dx, dy, dz) ?? getCell(x + dx, y + dy, z + dz));
  }

  function collides(position, height = PLAYER.height, ignored = []) {
    for (let y = Math.floor(position.y) - 1; y <= Math.floor(position.y + height); y++) {
      for (let z = Math.floor(position.z - PLAYER.halfWidth) - 1; z <= Math.floor(position.z + PLAYER.halfWidth) + 1; z++) {
        for (let x = Math.floor(position.x - PLAYER.halfWidth) - 1; x <= Math.floor(position.x + PLAYER.halfWidth) + 1; x++) {
          if (ignored.some(cell => cell.x === x && cell.y === y && cell.z === z)) continue;
          if (boxesAt('collisionFor', x, y, z).some(box => overlapsPlayer(position, box, x, y, z, height))) return true;
        }
      }
    }
    return false;
  }

  function movePathClear(start, end) {
    const steps = Math.ceil(Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z) * 8);
    for (let step = 1; step <= steps; step++) {
      const fraction = step / steps;
      const position = Object.fromEntries(axisNames.map(axis => [axis, start[axis] + (end[axis] - start[axis]) * fraction]));
      if (collides(position)) return false;
    }
    return true;
  }

  function movementAllowed(start, end) {
    if (collides(end)) return false;
    if (movePathClear(start, end)) return true;
    // A sampled stair step may rise before moving horizontally, or land after moving.
    const corner = end.y > start.y ? { ...start, y: end.y } : { ...end, y: start.y };
    return movePathClear(start, corner) && movePathClear(corner, end);
  }

  function movementTrailAllowed(start, trail) {
    const cached = new Map();
    function clear(from, to) {
      const delta = axisNames.map(axis => to[axis] - from[axis]);
      if (delta.every(amount => amount === 0)) return true;
      const origin = axisNames.map(axis => from[axis]);
      const low = axisNames.map(axis => Math.floor(Math.min(from[axis], to[axis])));
      const highX = Math.floor(Math.max(from.x, to.x)) + 1;
      const highY = Math.floor(Math.max(from.y, to.y) + PLAYER.height);
      const highZ = Math.floor(Math.max(from.z, to.z)) + 1;
      for (let y = low[1] - 1; y <= highY; y++) {
        for (let z = low[2] - 1; z <= highZ; z++) {
          for (let x = low[0] - 1; x <= highX; x++) {
            const key = `${x},${y},${z}`;
            if (!cached.has(key)) cached.set(key, boxesAt('collisionFor', x, y, z).map(box => [
              [x + box.x0 - PLAYER.halfWidth + epsilon, y + box.y0 - PLAYER.height + epsilon, z + box.z0 - PLAYER.halfWidth + epsilon],
              [x + box.x1 + PLAYER.halfWidth - epsilon, y + box.y1 - epsilon, z + box.z1 + PLAYER.halfWidth - epsilon],
            ]));
            for (const [min, max] of cached.get(key)) {
              if (rayBox(origin, delta, min, max, true) !== Infinity) return false;
            }
          }
        }
      }
      return true;
    }

    for (const end of trail) {
      // The browser resolves Y, then X, then Z. Stepping off an edge may
      // instead settle to its final Y after the horizontal step.
      if (!clear(start, end)) {
        const raised = { ...start, y: end.y };
        const movedX = { ...raised, x: end.x };
        const lateral = { ...end, y: start.y };
        if (!(clear(start, raised) && clear(raised, movedX) && clear(movedX, end)) &&
            !(end.y < start.y && clear(start, lateral) && clear(lateral, end))) return false;
      }
      start = end;
    }
    return true;
  }

  function firstHit(origin, target, solidOnly = false) {
    const delta = target.map((value, axis) => value - origin[axis]);
    const min = target.map((value, axis) => Math.floor(Math.min(origin[axis], value) - epsilon));
    const max = target.map((value, axis) => Math.floor(Math.max(origin[axis], value) + epsilon));
    let closest = Infinity;
    let hit = null;
    for (let y = min[1] - 1; y <= max[1]; y++) {
      for (let z = min[2] - 1; z <= max[2] + 1; z++) {
        for (let x = min[0] - 1; x <= max[0] + 1; x++) {
          if (rayBox(origin, delta, [x - 0.125, y, z - 0.125], [x + 1.125, y + 1.5, z + 1.125]) > closest) continue;
          for (const box of boxesAt(selection, x, y, z)) {
            if (solidOnly && box.solid === false) continue;
            const distance = rayBox(origin, delta, [x + box.x0, y + box.y0, z + box.z0], [x + box.x1, y + box.y1, z + box.z1]);
            if (distance >= closest) continue;
            closest = distance;
            hit = [x, y, z];
          }
        }
      }
    }
    return hit;
  }

  function visible(position, x, y, z, hit) {
    const origin = [position.x, position.y + (position.eye ?? PLAYER.eye), position.z];
    const targets = [];
    if (hit) targets.push([hit.x, hit.y, hit.z]);
    for (const box of boxesAt(selection, x, y, z)) {
      targets.push([x + (box.x0 + box.x1) / 2, y + (box.y0 + box.y1) / 2, z + (box.z0 + box.z1) / 2]);
    }
    return targets.some(target => {
      if (target.some((value, axis) => Math.abs(value - [x + 0.5, y + 0.5, z + 0.5][axis]) > 1)) return false;
      const range = Math.hypot(...target.map((value, axis) => value - origin[axis]));
      if (range > 6 || range < epsilon) return false;
      // Extend a reported surface hit just far enough to enter its collision box.
      const end = target.map((value, axis) => value + (value - origin[axis]) / range * 0.002);
      const cell = firstHit(origin, end);
      return cell?.[0] === x && cell[1] === y && cell[2] === z;
    });
  }

  function visiblePoint(origin, target) {
    return firstHit(origin, target, true) === null;
  }

  function targetAtHit(position, x, y, z, hit, chiseling = false) {
    if (![hit?.x, hit?.y, hit?.z].every(Number.isFinite)) return null;
    const origin = [position.x, position.y + (position.eye ?? PLAYER.eye), position.z];
    const point = [hit.x, hit.y, hit.z];
    const delta = point.map((value, axis) => value - origin[axis]);
    const range = Math.hypot(...delta);
    const tolerance = .002;
    if (range > 6 + tolerance || range < epsilon) return null;
    const direction = delta.map(value => value / range);
    const min = point.map((value, axis) => Math.floor(Math.min(origin[axis], value)));
    const max = point.map((value, axis) => Math.floor(Math.max(origin[axis], value)));
    let closest = null;
    let closestSolid;
    // Same selection boxes, axis traversal and tie order as client picking.
    for (let yy = min[1] - 1; yy <= max[1]; yy++) {
      for (let zz = min[2] - 1; zz <= max[2] + 1; zz++) {
        for (let xx = min[0] - 1; xx <= max[0] + 1; xx++) {
          for (const box of boxesAt(selection, xx, yy, zz)) {
            const result = intersectSelection(origin, direction, box, xx, yy, zz, range + tolerance, chiseling && box.solid === false);
            if (!result) continue;
            const solid = box.solid !== false;
            const preferSolid = chiseling && solid && !closestSolid &&
              Math.abs(result.length - (closest?.length ?? -1)) < 1e-7;
            if (closest && result.length >= closest.length && !preferSolid) continue;
            closest = {x: xx, y: yy, z: zz, partSlot: box.partSlot, face: result.offset, length: result.length};
            closestSolid = solid;
          }
        }
      }
    }
    if (!closest || closest.x !== x || closest.y !== y || closest.z !== z ||
        Math.abs(closest.length - range) > tolerance) return null;
    const surface = Object.fromEntries(axisNames.map((axis, index) =>
      [axis, origin[index] + direction[index] * closest.length]));
    return {...closest, hit: surface};
  }

  function visiblePart(position, x, y, z, partSlot, hit) {
    return Number.isInteger(partSlot) && targetAtHit(position, x, y, z, hit)?.partSlot === partSlot;
  }

  return {
    collides,
    movementAllowed,
    movementTrailAllowed,
    visible,
    visiblePoint,
    visiblePart,
    targetAtHit,
    overlapsBox: (position, x, y, z, box) => overlapsPlayer(position, box, x, y, z),
    overlaps(position, x, y, z, cell, plannedNeighbor) {
      return boxesAt('collisionFor', x, y, z, cell, plannedNeighbor).some(box => overlapsPlayer(position, box, x, y, z));
    },
  };
}
