export const PLAYER = Object.freeze({ halfWidth: 0.29, height: 1.77, eye: 1.62 });
const epsilon = 0.00001;
const axisNames = ['x', 'y', 'z'];

function overlapsPlayer(position, box, x, y, z) {
  return position.x + PLAYER.halfWidth > x + box.x0 + epsilon
    && position.x - PLAYER.halfWidth < x + box.x1 - epsilon
    && position.y + PLAYER.height > y + box.y0 + epsilon
    && position.y < y + box.y1 - epsilon
    && position.z + PLAYER.halfWidth > z + box.z0 + epsilon
    && position.z - PLAYER.halfWidth < z + box.z1 - epsilon;
}

function rayBox(origin, delta, minima, maxima) {
  let first = 0;
  let last = 1;
  for (let axis = 0; axis < 3; axis++) {
    const start = origin[axis];
    const step = delta[axis];
    if (Math.abs(step) < epsilon) {
      if (start < minima[axis] || start > maxima[axis]) return Infinity;
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
  function boxesAt(kind, x, y, z, override, plannedNeighbor) {
    const cell = typeof override === 'string' ? { key: override, parts: base.manifest.compositions?.[override]?.parts }
      : override ?? getCell(x, y, z);
    if (!cell || cell.key === 'air') return [];
    return geometry[kind](cell, (dx, dy, dz) => plannedNeighbor?.(dx, dy, dz) ?? getCell(x + dx, y + dy, z + dz));
  }

  function collides(position) {
    for (let y = Math.floor(position.y) - 1; y <= Math.floor(position.y + PLAYER.height); y++) {
      for (let z = Math.floor(position.z - PLAYER.halfWidth) - 1; z <= Math.floor(position.z + PLAYER.halfWidth) + 1; z++) {
        for (let x = Math.floor(position.x - PLAYER.halfWidth) - 1; x <= Math.floor(position.x + PLAYER.halfWidth) + 1; x++) {
          if (boxesAt('collisionFor', x, y, z).some(box => overlapsPlayer(position, box, x, y, z))) return true;
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

  function firstHit(origin, target) {
    const delta = target.map((value, axis) => value - origin[axis]);
    const min = target.map((value, axis) => Math.floor(Math.min(origin[axis], value) - epsilon));
    const max = target.map((value, axis) => Math.floor(Math.max(origin[axis], value) + epsilon));
    let closest = Infinity;
    let hit = null;
    for (let y = min[1] - 1; y <= max[1]; y++) {
      for (let z = min[2] - 1; z <= max[2] + 1; z++) {
        for (let x = min[0] - 1; x <= max[0] + 1; x++) {
          if (rayBox(origin, delta, [x - 0.125, y, z - 0.125], [x + 1.125, y + 1.5, z + 1.125]) > closest) continue;
          for (const box of boxesAt('shapeFor', x, y, z)) {
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
    const origin = [position.x, position.y + PLAYER.eye, position.z];
    const targets = [];
    if (hit) targets.push([hit.x, hit.y, hit.z]);
    for (const box of boxesAt('shapeFor', x, y, z)) {
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

  return {
    collides,
    movementAllowed,
    visible,
    overlaps(position, x, y, z, cell, plannedNeighbor) {
      return boxesAt('collisionFor', x, y, z, cell, plannedNeighbor).some(box => overlapsPlayer(position, box, x, y, z));
    },
  };
}
