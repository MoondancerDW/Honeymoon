import {collisionFor, shapeFor} from '../world/geometry.mjs';
import {extractedModel} from '../world/extracted-models.mjs';
import {movementMedium} from '../world/block-movement.mjs';

const HALF = .29;
export const HEIGHT = 1.77;
export const EYE = 1.62;
const EPSILON = .00001;

export class Movement {
  constructor(world) {
    this.world = world;
    this.fall = 0;
    this.grounded = false;
    this.medium = null;
    this.cellAt = (...coordinates) => this.world.cellAt(...coordinates);
  }

  blocked(x, y, z) {
    const b = this.world.manifest.bounds;
    if (x - HALF < b.minX || x + HALF > b.maxX + 1 || z - HALF < b.minZ || z + HALF > b.maxZ + 1 ||
        y < b.minY || y + HEIGHT > b.maxY + 1) return true;
    for (let yy = Math.floor(y) - 1; yy <= Math.floor(y + HEIGHT); yy++) {
      for (let zz = Math.floor(z - HALF - .0625); zz <= Math.floor(z + HALF + .0625); zz++) {
        for (let xx = Math.floor(x - HALF - .0625); xx <= Math.floor(x + HALF + .0625); xx++) {
          if (!this.world.hasChunk(xx, zz) && xx >= Math.floor(x - HALF) && xx <= Math.floor(x + HALF) && zz >= Math.floor(z - HALF) && zz <= Math.floor(z + HALF)) return true;
          const cell = this.world.cellAt(xx, yy, zz);
          if (!cell) continue;
          const boxes = extractedModel(this.world.models, cell)?.collision
            ?? collisionFor(cell, (dx, dy, dz) => this.world.cellAt(xx + dx, yy + dy, zz + dz));
          for (const box of boxes) {
            if (x + HALF > xx + box.x0 + EPSILON && x - HALF < xx + box.x1 - EPSILON &&
                y + HEIGHT > yy + box.y0 + EPSILON && y < yy + box.y1 - EPSILON &&
                z + HALF > zz + box.z0 + EPSILON && z - HALF < zz + box.z1 - EPSILON) return true;
          }
        }
      }
    }
    return false;
  }

  axis(position, axis, amount) {
    if (!amount) return false;
    const target = position[axis] + amount;
    position[axis] = target;
    if (!this.blocked(position.x, position.y, position.z)) return false;
    position[axis] = target - amount;
    let safe = 0, hit = 1;
    for (let i = 0; i < 7; i++) {
      const fraction = (safe + hit) / 2;
      position[axis] += amount * fraction;
      const blocked = this.blocked(position.x, position.y, position.z);
      position[axis] -= amount * fraction;
      if (blocked) hit = fraction;
      else safe = fraction;
    }
    position[axis] += amount * safe;
    return true;
  }

  horizontal(position, axis, amount, swimOut = false) {
    if (!amount) return false;
    const before = position[axis];
    if (!this.axis(position, axis, amount)) return false;
    if (!(this.grounded && !this.medium) && !swimOut) return true;
    const partial = position[axis];
    const feet = position.y;
    // Test clearance during the lift before trying the horizontal step.
    for (let lift = .125; lift <= .5; lift += .125) {
      const raised = feet + lift;
      if (this.blocked(position.x, raised, position.z)) return true;
      position.y = raised;
      position[axis] = before + amount;
      if (!this.blocked(position.x, raised, position.z)) {
        this.axis(position, 'y', -lift);
        return false;
      }
      position.y = feet;
      position[axis] = partial;
    }
    return true;
  }

  update(position, dx, dz, jump, dt, {descend = false, rise = jump} = {}) {
    this.medium = movementMedium(this.cellAt, position.x, position.y, position.z);
    if (!this.medium && jump && this.grounded) { this.fall = 6.8; this.grounded = false; }
    const n = Math.max(1, Math.ceil(dt / .016));
    const step = dt / n;
    for (let i = 0; i < n; i++) {
      const drag = this.medium === 'water' ? .48 : this.medium === 'ladder' ? .62 : 1;
      const swimOut = this.medium === 'water' && rise && !descend;
      const wallX = this.horizontal(position, 'x', dx * step * drag, swimOut);
      const wallZ = this.horizontal(position, 'z', dz * step * drag, swimOut);
      this.medium = movementMedium(this.cellAt, position.x, position.y, position.z) ?? this.medium;
      if (this.medium === 'ladder') {
        this.fall = descend ? -1.8 : rise || wallX || wallZ ? 2.4 : Math.max(-1.8, this.fall - 12 * step);
      } else if (this.medium === 'water') {
        this.fall = descend ? -2 : rise || wallX || wallZ ? 2.5 : Math.max(-.85, this.fall - 5 * step);
      } else {
        this.fall = Math.max(-16, this.fall - 20 * step);
      }
      const hit = this.axis(position, 'y', this.fall * step);
      this.grounded = hit && this.fall < 0;
      if (hit) this.fall = 0;
      this.medium = movementMedium(this.cellAt, position.x, position.y, position.z);
    }
  }
}

function intersect(origin, direction, box, x, y, z) {
  const starts = [x + box.x0, y + box.y0, z + box.z0];
  const ends = [x + box.x1, y + box.y1, z + box.z1];
  let entry = -Infinity, exit = Infinity, face = -1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(direction[i]) < 1e-9) {
      if (origin[i] < starts[i] || origin[i] > ends[i]) return null;
      continue;
    }
    const low = (starts[i] - origin[i]) / direction[i];
    const high = (ends[i] - origin[i]) / direction[i];
    if (Math.min(low, high) > entry) {
      entry = Math.min(low, high);
      face = 2 * i + Number(low > high);
    }
    exit = Math.min(exit, Math.max(low, high));
    if (entry > exit) return null;
  }
  if (exit < 0 || entry > 6 || face < 0) return null;
  const length = Math.max(0, entry);
  const offset = [0, 0, 0];
  offset[face >> 1] = face & 1 ? 1 : -1;
  return {length, offset};
}

export function pick(world, origin, direction) {
  const min = origin.map((value, axis) => Math.floor(Math.min(value, value + direction[axis] * 6)));
  const max = origin.map((value, axis) => Math.floor(Math.max(value, value + direction[axis] * 6)));
  let best = null;
  for (let y = min[1] - 1; y <= max[1]; y++) {
    for (let z = min[2] - 1; z <= max[2] + 1; z++) {
      for (let x = min[0] - 1; x <= max[0] + 1; x++) {
        const cell = world.cellAt(x, y, z);
        if (!cell) continue;
        const boxes = extractedModel(world.models, cell)?.selection
          ?? shapeFor(cell, (dx, dy, dz) => world.cellAt(x + dx, y + dy, z + dz));
        for (const box of boxes) {
          const result = intersect(origin, direction, box, x, y, z);
          if (!result || (best && result.length >= best.length)) continue;
          const hit = origin.map((value, axis) => value + direction[axis] * result.length);
          best = {x, y, z, cell, length: result.length, offset: result.offset, hit: {x: hit[0], y: hit[1], z: hit[2]}};
        }
      }
    }
  }
  return best;
}
