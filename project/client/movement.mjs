import * as geometry from '../world/geometry.mjs';
import {extractedModel} from '../world/extracted-models.mjs';
import {movementMedium} from '../world/block-movement.mjs';
import {PLAYER} from '../world/player-body.mjs';
import {intersectSelection} from '../world/selection.mjs';
import {isChiselMaterial, voxelBox, voxelMaterialAt} from '../world/voxel-chisel.mjs';
import {chiselMaterialKey, chiselVoxelAtHit} from '../world/chisel-surface.mjs';

const {halfWidth: HALF, height: HEIGHT, eye: EYE} = PLAYER;
const {collisionFor} = geometry;
export {HEIGHT, EYE};
const EPSILON = .00001;
export function overlapsPlacement(position, placement) {
  const {x, y, z} = position;
  const {x: cx, y: cy, z: cz, boxes} = placement;
  return boxes.some(box => x + HALF > cx + box.x0 + EPSILON && x - HALF < cx + box.x1 - EPSILON &&
    y + HEIGHT > cy + box.y0 + EPSILON && y < cy + box.y1 - EPSILON &&
    z + HALF > cz + box.z0 + EPSILON && z - HALF < cz + box.z1 - EPSILON);
}

export class Movement {
  constructor(world) {
    this.world = world;
    this.fall = 0;
    this.grounded = false;
    this.medium = null;
    this.pendingPlacement = null;
    this.cellAt = (...coordinates) => this.world.cellAt(...coordinates);
  }

  blocked(x, y, z) {
    const b = this.world.manifest.bounds;
    if (x - HALF < b.minX || x + HALF > b.maxX + 1 || z - HALF < b.minZ || z + HALF > b.maxZ + 1 ||
        y < b.minY || y + HEIGHT > b.maxY + 1) return true;
    if (this.pendingPlacement && overlapsPlacement({x,y,z}, this.pendingPlacement)) return true;
    for (let yy = Math.floor(y) - 1; yy <= Math.floor(y + HEIGHT); yy++) {
      for (let zz = Math.floor(z - HALF - .0625); zz <= Math.floor(z + HALF + .0625); zz++) {
        for (let xx = Math.floor(x - HALF - .0625); xx <= Math.floor(x + HALF + .0625); xx++) {
          if (!this.world.hasChunk(xx, zz) && xx >= Math.floor(x - HALF) && xx <= Math.floor(x + HALF) && zz >= Math.floor(z - HALF) && zz <= Math.floor(z + HALF)) return true;
          const cell = this.world.cellAt(xx, yy, zz);
          if (!cell) continue;
          const neighbors = (dx, dy, dz) => this.world.cellAt(xx + dx, yy + dy, zz + dz);
          const boxes = extractedModel(this.world.models, cell, neighbors)?.collision
            ?? collisionFor(cell, neighbors);
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
    if (!swimOut) {
      // The original player attempts one half-block step, clipped by the
      // ceiling on the approach side, then keeps the farther horizontal move.
      position[axis] = before;
      this.axis(position, 'y', .5);
      const clipped = this.axis(position, axis, amount);
      if (Math.abs(position[axis] - before) <= Math.abs(partial - before)) {
        position.y = feet;
        position[axis] = partial;
        return true;
      }
      this.axis(position, 'y', -.5);
      return clipped;
    }
    // Try short lifts when climbing out of water.
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

  update(position, dx, dz, jump, dt, {descend = false, rise = jump, recordStep} = {}) {
    this.medium = movementMedium(this.cellAt, position.x, position.y, position.z);
    if (!this.medium && jump && this.grounded) { this.fall = 6.8; this.grounded = false; }
    const n = Math.max(1, Math.ceil(dt / .016));
    const step = dt / n;
    for (let i = 0; i < n; i++) {
      const startMedium = this.medium;
      if (startMedium === 'ladder') {
        this.fall = descend ? -1.8 : rise ? 2.4 : Math.max(-1.8, this.fall - 12 * step);
      } else if (startMedium === 'water') {
        this.fall = descend ? -2 : rise ? 2.5 : Math.max(-.85, this.fall - 5 * step);
      } else {
        this.fall = Math.max(-16, this.fall - 20 * step);
      }
      // Resolve Y before X and Z, including when leaving a ledge or climbing
      // past a ceiling. Contact with a wall can start ascent on the next step.
      this.vertical(position, step);
      const drag = startMedium === 'water' ? .48 : startMedium === 'ladder' ? .62 : 1;
      const swimOut = startMedium === 'water' && rise && !descend;
      const wallX = this.horizontal(position, 'x', dx * step * drag, swimOut);
      const wallZ = this.horizontal(position, 'z', dz * step * drag, swimOut);
      this.medium = movementMedium(this.cellAt, position.x, position.y, position.z);
      if (!descend && (wallX || wallZ)) {
        if (this.medium === 'ladder') this.fall = 2.4;
        if (this.medium === 'water') this.fall = 2.5;
      }
      recordStep?.(position);
    }
  }

  fly(position, dx, dy, dz, dt, recordStep) {
    this.fall = 0;
    this.grounded = false;
    this.medium = null;
    if (!dx && !dy && !dz) return;
    const steps = Math.max(1, Math.ceil(dt / .016));
    const time = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.axis(position, 'y', dy * time);
      this.axis(position, 'x', dx * time);
      this.axis(position, 'z', dz * time);
      recordStep?.(position);
    }
  }

  vertical(position, step) {
    const hit = this.axis(position, 'y', this.fall * step);
    this.grounded = hit && this.fall < 0;
    if (hit) this.fall = 0;
  }
}

export function pick(world, origin, direction, chiseling = false) {
  const min = origin.map((value, axis) => Math.floor(Math.min(value, value + direction[axis] * 6)));
  const max = origin.map((value, axis) => Math.floor(Math.max(value, value + direction[axis] * 6)));
  let best = null;
  let selectedBoxes;
  let bestSolid;
  for (let y = min[1] - 1; y <= max[1]; y++) {
    for (let z = min[2] - 1; z <= max[2] + 1; z++) {
      for (let x = min[0] - 1; x <= max[0] + 1; x++) {
        const cell = world.cellAt(x, y, z);
        if (!cell) continue;
        const neighbors = (dx, dy, dz) => world.cellAt(x + dx, y + dy, z + dz);
        const boxes = extractedModel(world.models, cell, neighbors)?.selection
          ?? (geometry.selectionFor ?? geometry.shapeFor)(cell, neighbors);
        for (const box of boxes) {
          const result = intersectSelection(origin, direction, box, x, y, z, 6, chiseling && box.solid === false);
          if (!result) continue;
          const solid = box.solid !== false;
          const preferSolid = chiseling && solid && !bestSolid && Math.abs(result.length - (best?.length ?? -1)) < 1e-7;
          if (best && result.length >= best.length && !preferSolid) continue;
          const hit = origin.map((value, axis) => value + direction[axis] * result.length);
          best = {x, y, z, cell, length: result.length, offset: result.offset, hit: {x: hit[0], y: hit[1], z: hit[2]}};
          bestSolid = solid;
          if (Number.isInteger(box.partSlot)) {
            best.partSlot = box.partSlot;
            selectedBoxes = boxes;
          }
        }
      }
    }
  }
  if (best?.partSlot !== undefined) {
    best.part = best.cell.parts.find(part => part.slot === best.partSlot);
    best.boxes = selectedBoxes.filter(box => box.partSlot === best.partSlot);
  }
  if (chiseling && best && best.partSlot === undefined) {
    const state = best.cell.voxels;
    const key = typeof best.cell === 'string' ? best.cell : best.cell.key;
    if (state || isChiselMaterial(key)) {
      const index = chiselVoxelAtHit(best, best.hit, best.offset, state, key);
      const material = chiselMaterialKey(state ? voxelMaterialAt(state, index) : key);
      if (index != null && material) {
        best.voxel = index;
        best.voxelMaterial = material;
        best.boxes = [voxelBox(index)];
      }
    }
  }
  return best;
}
