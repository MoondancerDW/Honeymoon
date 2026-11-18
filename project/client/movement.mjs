import * as geometry from '../world/geometry.mjs';
import {extractedModel} from '../world/extracted-models.mjs';
import {fluidAt,fluidCurrent,movementMedium} from '../world/block-movement.mjs';
import {CRAWL_SPEED, FLIGHT_SPEED, FLIGHT_SPRINT_SPEED, GROUND_SPRINT_SPEED, HIGH_FLIGHT_Y, HIGH_FLIGHT_SPEED,
  HIGH_FLIGHT_SPRINT_SPEED, PLAYER, POSITION_STEP_LIMIT, POSITION_VERTICAL_STEP_LIMIT, WALK_SPEED, WORLD_GRAVITY,
  isPlayerStance, playerBody} from '../world/player-body.mjs';
import {intersectSelection} from '../world/selection.mjs';
import {withLoggedFluid} from '../world/logged-fluid.mjs';
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
const JUMP_ASCENT_GRAVITY = 20;
const MINECRAFT_TICK = .05;
const MINECRAFT_JUMP_SPEED = .42 / MINECRAFT_TICK;
const nextMinecraftJumpSpeed = speed => (speed - .08 / MINECRAFT_TICK) * .98;
const MINECRAFT_JUMP_HEIGHT = 1.252203352512;
const VERTICAL_STEP = POSITION_VERTICAL_STEP_LIMIT - .01;
const cartsByChunk = new WeakMap();
const framesByChunk = new WeakMap();

export function movementSpeed({flying = false, sprint = false, stance = 'stand', y = -Infinity} = {}) {
  if (flying) {
    const speed = sprint ? FLIGHT_SPRINT_SPEED : FLIGHT_SPEED;
    const highSpeed = sprint ? HIGH_FLIGHT_SPRINT_SPEED : HIGH_FLIGHT_SPEED;
    const blend = Math.max(0,Math.min(1,(y-HIGH_FLIGHT_Y)/1.5));
    return speed + (highSpeed-speed)*blend;
  }
  if (stance === 'swim') return WALK_SPEED;
  if (stance !== 'stand') return stance === 'crawl' ? CRAWL_SPEED : WALK_SPEED * .3;
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
    this.ponyType = 'earth';
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
    if (stance === 'swim') {
      if (movementMedium(this.cellAt,x,y,z,this.world.models) !== 'water') return this.stance;
    } else if (stance !== 'stand' && (!this.grounded || movementMedium(this.cellAt,x,y,z,this.world.models))) return this.stance;
    if (!this.blocked(x,y,z,playerBody(this.size, stance))) this.stance = stance;
    return this.stance;
  }

  wantsSwim({x,y,z}, sprinting) {
    if (!sprinting && this.stance !== 'swim') return false;
    const depth = this.stance === 'swim' ? .24 : Math.max(.5,this.body.height - .18);
    return fluidAt(this.cellAt,x,y+depth,z,this.world.models) === 'water';
  }

  withinBounds(x, y, z, {halfWidth:half, height} = this.body) {
    const b = this.world.manifest.bounds;
    return x - half >= b.minX && x + half <= b.maxX + 1 && z - half >= b.minZ && z + half <= b.maxZ + 1 &&
      y >= b.minY && y + height <= b.maxY + 1;
  }

  blocked(x, y, z, body = this.body) {
    const {halfWidth:half, height} = body;
    if (!this.withinBounds(x,y,z,body)) return true;
    if (this.pendingPlacement && overlapsPlacement({x,y,z}, this.pendingPlacement,body)) return true;
    for (let yy = Math.floor(y) - 1; yy <= Math.floor(y + height); yy++) {
      for (let zz = Math.floor(z - half - .0625); zz <= Math.floor(z + half + .0625); zz++) {
        for (let xx = Math.floor(x - half - .0625); xx <= Math.floor(x + half + .0625); xx++) {
          if (!this.world.hasChunk(xx, zz, y) && xx >= Math.floor(x - half + EPSILON) && xx <= Math.floor(x + half - EPSILON) &&
              zz >= Math.floor(z - half + EPSILON) && zz <= Math.floor(z + half - EPSILON)) {
            this.waitingForTerrain = true;
            return true;
          }
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
    const iterations = axis === 'y' && Math.abs(amount) > .02 ? 16 : 7;
    for (let i = 0; i < iterations; i++) {
      const fraction = (safe + hit) / 2;
      position[axis] = start + amount * fraction;
      const blocked = this.blocked(position.x, position.y, position.z);
      if (blocked) hit = fraction;
      else safe = fraction;
    }
    const change = amount * safe;
    position[axis] = Math.abs(change) <= EPSILON ? start : start + change;
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

  slideSeated(position, dx, dz, dt, body, recordStep) {
    const steps = Math.max(1,Math.ceil(dt / .016));
    for (let i = 0; i < steps; i++) {
      for (const [axis,amount] of [['x',dx],['z',dz]]) {
        if (!amount) continue;
        const next = {...position,[axis]:position[axis]+amount*dt/steps};
        if (this.blocked(next.x,next.y,next.z,body) || !this.blocked(next.x,next.y-.03,next.z,body) ||
            movementMedium(this.cellAt,next.x,next.y,next.z,this.world.models)) continue;
        position[axis] = next[axis];
      }
      recordStep?.(position);
    }
  }

  startJump(y) {
    const regular = this.stance !== 'crawl';
    this.jumpArc = regular ? {y, tickLeft:MINECRAFT_TICK,
      slowDescent:this.ponyType === 'pegasus' || this.ponyType === 'alicorn'} : undefined;
    this.fall = regular ? MINECRAFT_JUMP_SPEED : Math.sqrt(2 * JUMP_ASCENT_GRAVITY * this.body.jumpHeight);
    this.grounded = false;
  }

  resetFall() {
    this.fall = 0;
    this.jumpArc = undefined;
  }

  dryVerticalDelta(y, remaining) {
    let delta = 0;
    while (this.jumpArc && remaining > 0) {
      const arc = this.jumpArc;
      const step = Math.min(remaining,arc.tickLeft);
      // Only the jump above takeoff uses Minecraft ticks. Continue with world gravity below it.
      const toTakeoff = this.fall < 0 ? Math.max(0,y + delta - arc.y) / -this.fall : Infinity;
      if (toTakeoff <= step) {
        delta += this.fall * toTakeoff;
        remaining -= toTakeoff;
        this.jumpArc = undefined;
        break;
      }
      delta += this.fall * step;
      remaining -= step;
      arc.tickLeft -= step;
      if (arc.tickLeft <= 0) {
        this.fall = nextMinecraftJumpSpeed(this.fall);
        if (arc.slowDescent && this.fall < 0) {
          // Winged ponies share the same ascent, then fall from rest at the apex.
          this.resetFall();
          break;
        }
        arc.tickLeft = MINECRAFT_TICK;
      }
    }
    if (remaining <= 0) return delta;
    const initial = this.fall;
    this.fall -= (initial > 0 ? JUMP_ASCENT_GRAVITY : WORLD_GRAVITY) * remaining;
    if (initial > 0 && this.fall < 0) {
      // Resolve the apex exactly so the player can land on a full block.
      this.fall = 0;
      return delta + initial * initial / (2 * JUMP_ASCENT_GRAVITY);
    }
    return delta + (initial + this.fall) * .5 * remaining;
  }

  update(position, dx, dz, jump, dt, {descend = false, rise = jump, swimPitch = 0, recordStep, automatic = false} = {}) {
    this.medium = movementMedium(this.cellAt, position.x, position.y, position.z, this.world.models);
    if (!this.medium && jump && this.grounded) this.startJump(position.y);
    const fastestDrop = (Math.max(0,-this.fall) + WORLD_GRAVITY * dt) * dt;
    const n = Math.max(1, Math.ceil(dt / .016), Math.ceil(fastestDrop / VERTICAL_STEP));
    const step = dt / n;
    for (let i = 0; i < n; i++) {
      const startMedium = this.medium;
      const submerged = startMedium === 'water' || startMedium === 'lava';
      const swimming = this.stance === 'swim' && startMedium === 'water';
      const current = submerged ? fluidCurrent(this.cellAt,position.x,position.y,position.z,startMedium) : [0,0,0];
      let deltaY;
      if (startMedium) this.jumpArc = undefined;
      if (startMedium === 'ladder') {
        this.fall = descend ? -1.8 : rise ? 2.4 : Math.max(-1.8, this.fall - 12 * step);
      } else if (startMedium === 'water') {
        this.fall = descend ? -2 : rise ? 2.5 : swimming ? swimPitch*2.6 : Math.max(-.85,this.fall-5*step);
      } else if (startMedium === 'lava') {
        this.fall = descend ? -1.04 : rise ? 1.15 : Math.max(-.63,this.fall-3.5*step);
      } else {
        deltaY = this.dryVerticalDelta(position.y,step);
      }
      // Resolve Y before X and Z, including when leaving a ledge or climbing
      // past a ceiling. Contact with a wall can start ascent on the next step.
      this.vertical(position,(deltaY ?? this.fall*step)+current[1]*step);
      const drag = swimming ? .88 : startMedium === 'water' ? .48 : startMedium === 'lava' ? .29 : startMedium === 'ladder' ? .62 : 1;
      const swimOut = submerged && rise && !descend;
      const wallX = this.horizontal(position, 'x',(dx*drag+current[0])*step,swimOut);
      const wallZ = this.horizontal(position, 'z',(dz*drag+current[2])*step,swimOut);
      this.medium = movementMedium(this.cellAt, position.x, position.y, position.z, this.world.models);
      if (!descend && (wallX || wallZ)) {
        if (this.medium === 'ladder') this.fall = 2.4;
        if (this.medium === 'water') this.fall = 2.5;
        if (this.medium === 'lava') this.fall = 1.15;
      }
      if (automatic && (wallX || wallZ) && this.grounded && !this.medium && this.stance === 'stand' && !this.waitingForTerrain) {
        // A normal step already failed. Jump only if the body can rise and advance at its apex.
        const {x,y,z}=position;
        const apex=y+MINECRAFT_JUMP_HEIGHT;
        if (!this.blocked(x,(y+apex)/2,z) && !this.blocked(x,apex,z) &&
            !this.blocked(x+dx*step,apex,z) && !this.blocked(x+dx*step,apex,z+dz*step)) {
          this.startJump(y);
        }
      }
      recordStep?.(position);
    }
  }

  fly(position, dx, dy, dz, dt, recordStep, spectator = false, automatic = false) {
    this.resetFall();
    this.grounded = false;
    this.medium = null;
    if (!dx && !dy && !dz) return;
    const steps = Math.max(1, Math.ceil(dt / .016),Math.ceil(Math.hypot(dx,dz)*dt/(POSITION_STEP_LIMIT-.001)),
      Math.ceil(Math.abs(dy)*dt/VERTICAL_STEP));
    const time = dt / steps;
    const stepX=dx*time,stepZ=dz*time;
    for (let i = 0; i < steps; i++) {
      if (spectator) {
        const {halfWidth, height} = this.body;
        const {minX,maxX,minY,maxY,minZ,maxZ} = this.world.manifest.bounds;
        position.x = Math.max(minX + halfWidth, Math.min(maxX + 1 - halfWidth, position.x + dx * time));
        position.y = Math.max(minY, Math.min(maxY + 1 - height, position.y + dy * time));
        position.z = Math.max(minZ + halfWidth, Math.min(maxZ + 1 - halfWidth, position.z + dz * time));
      } else {
        this.axis(position, 'y', dy * time);
        const {x,z}=position;
        const wallX=this.axis(position,'x',stepX);
        const wallZ=this.axis(position,'z',stepZ);
        if (automatic && !dy && (wallX || wallZ) && !this.waitingForTerrain &&
            this.withinBounds(x+stepX,position.y,z+stepZ)) {
          // Use the remaining movement budget for ascent if the forward step is clipped.
          const remaining=stepX**2+stepZ**2-(position.x-x)**2-(position.z-z)**2;
          this.axis(position,'y',Math.sqrt(Math.max(0,remaining)));
        }
      }
      recordStep?.(position);
    }
  }

  vertical(position, amount) {
    // While dropping fast, endpoint-only checks could skip a thin surface with a short body.
    const segments = Math.max(1, Math.ceil(-amount / this.body.height));
    let hit = false;
    for (let i = 0; i < segments && !hit; i++) hit = this.axis(position, 'y', amount / segments);
    this.grounded = hit && amount < 0;
    if (hit) this.resetFall();
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
        const selection = extractedModel(world.models, cell, neighbors)?.selection
          ?? (geometry.selectionFor ?? geometry.shapeFor)(cell, neighbors);
        const boxes = solidOnly ? selection : withLoggedFluid(selection, cell, neighbors, world.models);
        for (const box of boxes) {
          if (solidOnly && box.solid === false) continue;
          const result = intersectSelection(origin, direction, box, x, y, z, 6, Boolean(box.loggedFluid) || chiseling && box.solid === false);
          if (!result) continue;
          const solid = box.solid !== false;
          const preferSolid = chiseling && solid && !bestSolid && Math.abs(result.length - (best?.length ?? -1)) < 1e-7;
          if (best && result.length >= best.length && !preferSolid) continue;
          const hit = origin.map((value, axis) => value + direction[axis] * result.length);
          best = {x, y, z, cell, length: result.length, offset: result.offset, hit: {x: hit[0], y: hit[1], z: hit[2]}};
          bestSolid = solid;
          if (box.loggedFluid) {
            best.liquid = box.loggedFluid;
            best.boxes = [box];
          }
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
  if (chiseling && best && !best.liquid && best.partSlot === undefined) {
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
