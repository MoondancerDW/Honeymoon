import * as geometry from '../world/geometry.mjs';
import {extractedModel} from '../world/extracted-models.mjs';
import {movementMedium} from '../world/block-movement.mjs';
import {FLIGHT_SPEED, FLIGHT_SPRINT_SPEED, GROUND_SPRINT_SPEED, PLAYER, WALK_SPEED, isPlayerStance, playerBody} from '../world/player-body.mjs';
import {intersectSelection} from '../world/selection.mjs';
import {isRideableMinecart, minecartHit} from '../world/minecarts.mjs';
import {isRideableBoat,boatHit} from '../world/boats.mjs';
import {itemFrameHit} from '../world/item-frames.mjs';
import {isChiselMaterial, voxelBox, voxelMaterialAt} from '../world/voxel-chisel.mjs';
import {chiselMaterialKey, chiselVoxelAtHit} from '../world/chisel-surface.mjs';

const {height: HEIGHT, eye: EYE} = PLAYER;
const {collisionFor} = geometry;
export {HEIGHT, EYE};
const EPSILON = .00001;
const CAMERA_OFFSET = 4;
const CAMERA_RADIUS = .1;
const cartsByChunk = new WeakMap();
const framesByChunk = new WeakMap();

export function movementSpeed({flying = false, sprint = false, stance = 'stand'} = {}) {
  if (flying) return sprint ? FLIGHT_SPRINT_SPEED : FLIGHT_SPEED;
  if (stance !== 'stand') return WALK_SPEED * (stance === 'crawl' ? .26 : .3);
  return sprint ? GROUND_SPRINT_SPEED : WALK_SPEED;
}

export function cameraClearance(world, origin, direction, distance = CAMERA_OFFSET) {
  const min = origin.map((value, axis) => Math.floor(Math.min(value, value + direction[axis] * distance) - CAMERA_RADIUS));
  const max = origin.map((value, axis) => Math.floor(Math.max(value, value + direction[axis] * distance) + CAMERA_RADIUS));
  let nearest = distance;
  for (let y = min[1] - 1; y <= max[1]; y++) {
    for (let z = min[2] - 1; z <= max[2] + 1; z++) {
      for (let x = min[0] - 1; x <= max[0] + 1; x++) {
        const cell = world.cellAt(x, y, z);
        if (!cell) continue;
        const neighbors = (dx, dy, dz) => world.cellAt(x + dx, y + dy, z + dz);
        const boxes = extractedModel(world.models, cell, neighbors)?.collision ?? collisionFor(cell, neighbors);
        for (const box of boxes) {
          const padded = {x0:box.x0 - CAMERA_RADIUS, y0:box.y0 - CAMERA_RADIUS, z0:box.z0 - CAMERA_RADIUS,
            x1:box.x1 + CAMERA_RADIUS, y1:box.y1 + CAMERA_RADIUS, z1:box.z1 + CAMERA_RADIUS};
          const hit = intersectSelection(origin, direction, padded, x, y, z, nearest);
          if (!hit) continue;
          // The eye can be within the camera margin while moving the camera away from a wall.
          if (hit.length === 0 && !intersectSelection(origin, direction, box, x, y, z, nearest)) continue;
          nearest = hit.length;
        }
      }
    }
  }
  return nearest;
}

export function pickItemFrame(world,origin,direction,block) {
  let target = null, nearest = Math.min(6,block?.length ?? 6);
  const consider = entity => {
    const length = itemFrameHit(entity,origin,direction,nearest);
    if (length >= nearest) return;
    nearest = length;
    const [x,y,z] = entity.position.map(Math.floor);
    const [hx,hy,hz] = origin.map((value,index) => value + length * direction[index]);
    target = {x,y,z,entity:entity.key,length,revision:entity.revision ?? 0,hit:{x:hx,y:hy,z:hz}};
  };
  const [ox,,oz] = origin;
  for (let z = Math.floor((oz - 7) / 16); z <= Math.floor((oz + 7) / 16); z++) {
    for (let x = Math.floor((ox - 7) / 16); x <= Math.floor((ox + 7) / 16); x++) {
      const source = world.chunks?.get(x + ',' + z);
      if (!source || source.visualOnly) continue;
      if (!framesByChunk.has(source)) framesByChunk.set(source,(source.entities ?? []).filter(entity => entity.type === 'ItemFrame'));
      for (const entity of framesByChunk.get(source)) {
        if (!world.frames?.has(entity.key)) consider(entity);
      }
    }
  }
  for (const entity of world.frames?.values() ?? []) {
    const [x,,z] = entity.position;
    if (Math.abs(x-ox) <= 7 && Math.abs(z-oz) <= 7 && world.hasChunk(x,z)) consider(entity);
  }
  return target;
}

export function pickVehicle(world,origin,direction,block) {
  const chunk = (n, offset) => Math.floor((n + offset) / 16);
  const endX = origin[0] + direction[0] * 6, endZ = origin[2] + direction[2] * 6;
  let target = null, nearest = 6;
  const consider = entity => {
    const [cx, cy, cz] = entity.position.map(Math.floor);
    const boat = isRideableBoat(entity);
    const distance = (boat ? boatHit : minecartHit)(entity,origin,direction,nearest);
    if (distance >= nearest) return;
    nearest = distance;
    const [hx, hy, hz] = origin.map((n,axis) => n + direction[axis] * distance);
    target = {x:cx,y:cy,z:cz,entity:entity.key,length:distance,...(boat && {kind:'boat'}),hit:{x:hx,y:hy,z:hz}};
  };
  for (let z = chunk(Math.min(origin[2], endZ),-1); z <= chunk(Math.max(origin[2], endZ),1); z++) {
    for (let x = chunk(Math.min(origin[0], endX),-1); x <= chunk(Math.max(origin[0], endX),1); x++) {
      const source = world.chunks?.get(`${x},${z}`);
      if (!source || source.visualOnly) continue;
      if (!cartsByChunk.has(source)) cartsByChunk.set(source,(source.entities ?? []).filter(entity =>
        isRideableMinecart(entity) || isRideableBoat(entity)));
      for (const entity of cartsByChunk.get(source)) {
        if (!world.minecarts?.has(entity.key) && !world.boats?.has(entity.key)) consider(entity);
      }
    }
  }
  for (const {entity} of world.minecarts?.values() ?? []) {
    const [x, , z] = entity.position;
    if (Math.abs(x - origin[0]) <= 7 && Math.abs(z - origin[2]) <= 7 && world.hasChunk(x,z)) consider(entity);
  }
  for (const {entity} of world.boats?.values() ?? []) {
    const [x,,z] = entity.position;
    if (Math.abs(x-origin[0]) <= 7 && Math.abs(z-origin[2]) <= 7 && world.hasChunk(x,z)) consider(entity);
  }
  if (target && block?.length < nearest && (pick(world,origin,direction,false,true)?.length ?? Infinity) < nearest) return null;
  return target;
}
export {pickVehicle as pickMinecart};

export function overlapsPlacement(position, placement, {halfWidth, height} = PLAYER) {
  const {x, y, z} = position;
  const {x: cx, y: cy, z: cz, boxes} = placement;
  return boxes.some(box => x + halfWidth > cx + box.x0 + EPSILON && x - halfWidth < cx + box.x1 - EPSILON &&
    y + height > cy + box.y0 + EPSILON && y < cy + box.y1 - EPSILON &&
    z + halfWidth > cz + box.z0 + EPSILON && z - halfWidth < cz + box.z1 - EPSILON);
}

export class Movement {
  constructor(world) {
    this.world = world;
    this.size = 'normal';
    this.stance = 'stand';
    this.fall = 0;
    this.grounded = false;
    this.medium = null;
    this.pendingPlacement = null;
    this.cellAt = (...coordinates) => this.world.cellAt(...coordinates);
  }

  get body() { return playerBody(this.size, this.stance); }

  setStance({x,y,z}, stance) {
    if (stance === this.stance || !isPlayerStance(stance)) return this.stance;
    if (stance !== 'stand' && (!this.grounded || movementMedium(this.cellAt,x,y,z))) return this.stance;
    if (!this.blocked(x,y,z,playerBody(this.size, stance))) this.stance = stance;
    return this.stance;
  }

  blocked(x, y, z, body = this.body) {
    const {halfWidth:half, height} = body;
    const b = this.world.manifest.bounds;
    if (x - half < b.minX || x + half > b.maxX + 1 || z - half < b.minZ || z + half > b.maxZ + 1 ||
        y < b.minY || y + height > b.maxY + 1) return true;
    if (this.pendingPlacement && overlapsPlacement({x,y,z}, this.pendingPlacement,body)) return true;
    for (let yy = Math.floor(y) - 1; yy <= Math.floor(y + height); yy++) {
      for (let zz = Math.floor(z - half - .0625); zz <= Math.floor(z + half + .0625); zz++) {
        for (let xx = Math.floor(x - half - .0625); xx <= Math.floor(x + half + .0625); xx++) {
          if (!this.world.hasChunk(xx, zz) && xx >= Math.floor(x - half + EPSILON) && xx <= Math.floor(x + half - EPSILON) &&
              zz >= Math.floor(z - half + EPSILON) && zz <= Math.floor(z + half - EPSILON)) return true;
          const cell = this.world.cellAt(xx, yy, zz);
          if (!cell) continue;
          const neighbors = (dx, dy, dz) => this.world.cellAt(xx + dx, yy + dy, zz + dz);
          const boxes = extractedModel(this.world.models, cell, neighbors)?.collision
            ?? collisionFor(cell, neighbors);
          for (const box of boxes) {
            if (x + half > xx + box.x0 + EPSILON && x - half < xx + box.x1 - EPSILON &&
                y + height > yy + box.y0 + EPSILON && y < yy + box.y1 - EPSILON &&
                z + half > zz + box.z0 + EPSILON && z - half < zz + box.z1 - EPSILON) return true;
          }
        }
      }
    }
    return false;
  }

  axis(position, axis, amount) {
    if (!amount) return false;
    const start = position[axis];
    position[axis] = start + amount;
    if (!this.blocked(position.x, position.y, position.z)) return false;
    let safe = 0, hit = 1;
    for (let i = 0; i < 7; i++) {
      const fraction = (safe + hit) / 2;
      position[axis] = start + amount * fraction;
      const blocked = this.blocked(position.x, position.y, position.z);
      if (blocked) hit = fraction;
      else safe = fraction;
    }
    position[axis] = start + amount * safe;
    return true;
  }

  horizontal(position, axis, amount, swimOut = false) {
    if (!amount) return false;
    if (this.stance === 'crouch' && this.grounded && !this.medium) {
      const target = {...position, [axis]:position[axis] + amount};
      if (!this.blocked(target.x, target.y - .5, target.z)) return true;
    }
    const before = position[axis];
    if (!this.axis(position, axis, amount)) return false;
    if (!(this.grounded && !this.medium && this.stance !== 'crawl') && !swimOut) return true;
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
    if (!this.medium && jump && this.grounded && this.stance !== 'crawl') {
      this.fall = Math.sqrt(40 * this.body.jumpHeight);
      this.grounded = false;
    }
    const n = Math.max(1, Math.ceil(dt / .016));
    const step = dt / n;
    for (let i = 0; i < n; i++) {
      const startMedium = this.medium;
      let deltaY;
      if (startMedium === 'ladder') {
        this.fall = descend ? -1.8 : rise ? 2.4 : Math.max(-1.8, this.fall - 12 * step);
      } else if (startMedium === 'water') {
        this.fall = descend ? -2 : rise ? 2.5 : Math.max(-.85, this.fall - 5 * step);
      } else {
        const initial = this.fall;
        this.fall = Math.max(-16, initial - 20 * step);
        if (initial > 0 && this.fall < 0) {
          // Resolve the top of a one-block jump exactly so it can land on a full block.
          deltaY = initial * initial / 40;
          this.fall = 0;
        } else {
          deltaY = (initial + this.fall) * .5 * step;
        }
      }
      // Resolve Y before X and Z, including when leaving a ledge or climbing
      // past a ceiling. Contact with a wall can start ascent on the next step.
      this.vertical(position, deltaY ?? this.fall * step);
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

  fly(position, dx, dy, dz, dt, recordStep, spectator = false) {
    this.fall = 0;
    this.grounded = false;
    this.medium = null;
    if (!dx && !dy && !dz) return;
    const steps = Math.max(1, Math.ceil(dt / .016));
    const time = dt / steps;
    for (let i = 0; i < steps; i++) {
      if (spectator) {
        const {halfWidth, height} = this.body;
        const {minX,maxX,minY,maxY,minZ,maxZ} = this.world.manifest.bounds;
        position.x = Math.max(minX + halfWidth, Math.min(maxX + 1 - halfWidth, position.x + dx * time));
        position.y = Math.max(minY, Math.min(maxY + 1 - height, position.y + dy * time));
        position.z = Math.max(minZ + halfWidth, Math.min(maxZ + 1 - halfWidth, position.z + dz * time));
      } else {
        this.axis(position, 'y', dy * time);
        this.axis(position, 'x', dx * time);
        this.axis(position, 'z', dz * time);
      }
      recordStep?.(position);
    }
  }

  vertical(position, amount) {
    const hit = this.axis(position, 'y', amount);
    this.grounded = hit && amount < 0;
    if (hit) this.fall = 0;
  }
}

export function pick(world, origin, direction, chiseling = false, solidOnly = false) {
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
          if (solidOnly && box.solid === false) continue;
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
