import { performance } from 'node:perf_hooks';
import { displayObject, cellAddress } from './base.mjs';
import { RequestError } from './errors.mjs';
import {readEye} from './presence.mjs';
import { registerMechanics } from './mechanics.mjs';
import { PLAYER, physics } from './physics.mjs';
import { createMinecarts } from './minecarts.mjs';
import { createBoats } from './boats.mjs';
import { createItemFrames } from './item-frames.mjs';
import { guidedMicroblock, isMicroblockCell, isMicroPart, microblockAddition, microblockKey, microblockPattern,
  microblockRemoval, partBoxesOverlapBox, partBoxesOverlapVoxels, PART_SLOT_LIMIT, publicMicroPart } from '../world/microblocks.mjs';
import { chiselMaterialShape, coverBoxes } from '../world/geometry.mjs';
import { FLIGHT_SPRINT_SPEED, POSITION_BATCH_LIMIT, POSITION_STEP_LIMIT, POSITION_TRAIL_LIMIT, positionCost } from '../world/player-body.mjs';
import { bedMate, seatFor, SEATED_EYE, SEATED_HEIGHT } from '../world/seats.mjs';
import { isRideableMinecart, minecartHit, minecartSeat } from '../world/minecarts.mjs';
import { isRideableBoat,boatHeading,boatHit,boatSeat } from '../world/boats.mjs';
import { orientedRail, railFor } from '../world/rails.mjs';
import { blockKey, blockState, buttonDuration, jammyAppliance, pressurePlate, relatedBlockStates, signalSides } from '../world/block-interactions.mjs';
import { CREATIVE_BOAT_KEY,CREATIVE_FRAME_KEY,CREATIVE_MINECART_KEY,shapedLampData } from '../world/creative-items.mjs';
import { liquidLevel } from '../world/block-movement.mjs';
import { isChiselMaterial, voxelBrush, voxelKey, voxelMaterialAt, voxelRemovalBrush,
  VOXEL_COUNT, VOXEL_MATERIAL_LIMIT, writeVoxelBrush } from '../world/voxel-chisel.mjs';
import { chiselMaterialKey, chiselPlacementAtHit, chiselSourceVolume, chiselVoxelAtHit } from '../world/chisel-surface.mjs';

const partActions = new Set(['copy_part', 'place_part', 'remove_part']);
const voxelActions = new Set(['copy_voxel', 'place_voxel', 'remove_voxel']);
const frameActions = new Set(['frame_item','frame_use','frame_remove']);
const vehiclePlacements = new Map([['place_minecart',CREATIVE_MINECART_KEY],['place_boat',CREATIVE_BOAT_KEY]]);
const vehicleRemovals = new Map([['remove_minecart','not_a_minecart'],['remove_boat','not_a_boat']]);
const actions = new Set(['place', 'remove', 'remove_microblocks', 'copy', 'interact', 'edit_sign',
  'place_frame', ...vehiclePlacements.keys(), ...vehicleRemovals.keys(), ...frameActions, ...partActions, ...voxelActions]);
const axes = ['x', 'y', 'z'];
const faceOffsets = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];
const bedDirections = [[0,1], [-1,0], [0,-1], [1,0]];
const pairedBlocks = new Set([26, 64, 71]);
const signBlocks = new Set([63, 68]);
const mountingMeta = [0, 5, 4, 3, 2, 1];
const MOVEMENT_GRACE = 0.24;
const RUN_SPEED = FLIGHT_SPRINT_SPEED + 1;
const MAX_ACTIVE_IDLE_MS = 30000;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;

function point(input, integers = false) {
  const valid = integers ? Number.isSafeInteger : Number.isFinite;
  if (!input || axes.some(axis => !valid(input[axis]))) throw new RequestError(400, 'invalid_coordinates');
  return { x: input.x, y: input.y, z: input.z };
}

function trailPoint(input) {
  if (!Array.isArray(input) || input.length !== 3) throw new RequestError(400, 'invalid_position_trail');
  return point({ x: input[0], y: input[1], z: input[2] });
}

const samePoint = (left, right) => axes.every(axis => left[axis] === right[axis]);
const slotNumber = value => Number.isInteger(value) && value >= 0 && value < PART_SLOT_LIMIT;

function normalizeAction(body) {
  if (typeof body.requestId !== 'string' || !REQUEST_ID.test(body.requestId)) throw new RequestError(400, 'invalid_request_id');
  if (!actions.has(body.type)) throw new RequestError(400, 'unknown_action');
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw new RequestError(400, 'invalid_revision');
  const input = { type: body.type, ...point(body, true), expectedRevision: body.expectedRevision };
  if (body.eye !== undefined) input.eye = readEye(body.eye);
  if (vehiclePlacements.has(body.type)) {
    if (body.creativeItem !== vehiclePlacements.get(body.type)) throw new RequestError(400,'unknown_cell_type');
    input.creativeItem = body.creativeItem;
  } else if (body.type === 'place_frame' || body.type === 'frame_item') {
    if (body.type === 'place_frame' && body.creativeItem !== CREATIVE_FRAME_KEY ||
        body.creativeItem !== undefined && !/^creative:\d{1,5}:\d{1,5}$/.test(body.creativeItem)) {
      throw new RequestError(400,'unknown_cell_type');
    }
    if (body.creativeItem !== undefined) input.creativeItem = body.creativeItem;
    if (body.type === 'frame_item' && body.cell !== undefined) {
      if (typeof body.cell !== 'string' || !/^legacy:\d{1,4}:\d{1,2}$/.test(body.cell)) throw new RequestError(400,'invalid_cell');
      input.cell = body.cell;
    }
  } else if (body.creativeItem !== undefined) {
    if (!['place','place_part'].includes(body.type) || typeof body.creativeItem !== 'string' ||
        !/^creative:(?:750|753|768):\d{1,5}$/.test(body.creativeItem)) throw new RequestError(400, 'unknown_cell_type');
    input.creativeItem = body.creativeItem;
  }
  if (body.hit !== undefined) input.hit = point(body.hit);
  if (vehicleRemovals.has(body.type) || frameActions.has(body.type)) {
    if (typeof body.entity !== 'string' || body.entity.length > 160) {
      throw new RequestError(400,vehicleRemovals.get(body.type) ?? 'not_a_frame');
    }
    input.entity = body.entity;
  }
  if ((vehiclePlacements.has(body.type) || vehicleRemovals.has(body.type) ||
      body.type === 'place_frame' || frameActions.has(body.type)) && !input.hit) {
    throw new RequestError(400,'invalid_coordinates');
  }
  if (body.type === 'remove_microblocks' && !input.hit) throw new RequestError(400, 'invalid_coordinates');
  if ((['interact','place','place_frame'].includes(body.type) || vehiclePlacements.has(body.type)) && body.yaw !== undefined) {
    if (!Number.isFinite(body.yaw)) throw new RequestError(400, 'invalid_heading');
    input.yaw = body.yaw % (2 * Math.PI);
  }
  if (body.type === 'place' && body.pitch !== undefined) {
    if (!Number.isFinite(body.pitch) || Math.abs(body.pitch) > Math.PI / 2) throw new RequestError(400,'invalid_heading');
    input.pitch = body.pitch;
  }
  if (body.type === 'interact' && body.sneaking !== undefined) {
    if (typeof body.sneaking !== 'boolean') throw new RequestError(400, 'invalid_modifier');
    if (body.sneaking) input.sneaking = true;
  }
  if (body.type === 'interact') {
    if (body.heldItem !== undefined) {
      if (typeof body.heldItem !== 'string' || !/^creative:\d{1,5}:\d{1,5}$/.test(body.heldItem)) {
        throw new RequestError(400,'unknown_cell_type');
      }
      input.heldItem = body.heldItem;
    }
    if (body.heldCell !== undefined) {
      if (typeof body.heldCell !== 'string' || !/^legacy:\d{1,4}:\d{1,2}$/.test(body.heldCell)) {
        throw new RequestError(400,'invalid_cell');
      }
      input.heldCell = body.heldCell;
    }
  }
  if (body.type === 'edit_sign') {
    if (!Array.isArray(body.lines) || body.lines.length !== 4 ||
        body.lines.some(line => typeof line !== 'string' || line.length > 80 || /[\u0000-\u001f\u007f]/.test(line))) {
      throw new RequestError(400, 'invalid_sign_text');
    }
    input.lines = body.lines;
  }
  if (body.type === 'place') {
    if (typeof body.cell !== 'string' || body.cell.length > 128) throw new RequestError(400, 'invalid_cell');
    input.cell = body.cell;
    if (body.creative === true) input.creative = true;
    if (body.turns !== undefined) {
      if (!Number.isInteger(body.turns) || body.turns < 0 || body.turns > 3) throw new RequestError(400, 'invalid_heading');
      if (body.turns) input.turns = body.turns;
    }
    if (body.against !== undefined) input.against = point(body.against, true);
  }
  if (partActions.has(body.type)) {
    if (!input.hit) throw new RequestError(400, 'invalid_coordinates');
    if (body.type === 'place_part') {
      if (!isMicroPart(body.part)) throw new RequestError(400, 'invalid_part');
      if (input.creativeItem && !body.part.bounds) throw new RequestError(400, 'invalid_part');
      input.part = publicMicroPart(body.part);
      if (body.part.bounds) {
        if (!Number.isInteger(body.orientation) || body.orientation < 0 || body.orientation >= 24) {
          throw new RequestError(400, 'invalid_heading');
        }
        input.orientation = body.orientation;
      }
      input.against = point(body.against, true);
      if (body.against.partSlot !== undefined) {
        if (!slotNumber(body.against.partSlot)) throw new RequestError(400, 'invalid_part');
        input.against.partSlot = body.against.partSlot;
      }
    } else {
      if (!slotNumber(body.partSlot)) throw new RequestError(400, 'invalid_part');
      input.partSlot = body.partSlot;
    }
  }
  if (voxelActions.has(body.type)) {
    if (!input.hit) throw new RequestError(400, 'invalid_coordinates');
    if (!Number.isInteger(body.voxel) || body.voxel < 0 || body.voxel >= VOXEL_COUNT) {
      throw new RequestError(400, 'invalid_voxel');
    }
    input.voxel = body.voxel;
    if (body.type !== 'copy_voxel' && body.size !== undefined) {
      if (body.size !== 1 && body.size !== 2) throw new RequestError(400, 'invalid_voxel');
      if (body.size === 2) input.size = 2;
    }
    if (body.type === 'place_voxel') {
      if (typeof body.material !== 'string' || body.material.length > 128) throw new RequestError(400, 'invalid_material');
      input.material = body.material;
      input.against = point(body.against, true);
      if (body.against.partSlot !== undefined) {
        if (!slotNumber(body.against.partSlot)) throw new RequestError(400, 'invalid_part');
        input.against.partSlot = body.against.partSlot;
      }
    }
  }
  return input;
}

function signObject(position, lines, original) {
  const text = Object.fromEntries(lines.map((line, index) => [`Text${index + 1}`, line]));
  return {type:'Sign', position, key:`tile:${position.join(':')}`, data:{...original?.data, ...text}};
}

function newCreativeObject(key, position, input, item) {
  const [id, meta] = blockState(key);
  let type = jammyAppliance(id, meta) ? 'JammyAppliance' : id === 2255 ? 'WeaponCaseTile' : id === 23 ? 'Trap' : null;
  let data = {};
  const face = input.against && signalSides.findIndex(offset => axes.every((axis,i) => position[i] - input.against[axis] === offset[i]));
  const mount = face >= 0 ? face ^ 1 : 0;
  if (id === 750 && [1,2,3,5,12].includes(meta)) {
    type = ({1:'Redwire',2:'InsRedwire',3:'RedCable',5:'Bluewire',12:'RPConRibbon'})[meta];
    data = item?.kind === 'jacket' ? {cons:64, post:item.damage & 255, md:0, pwr:0} :
      {cons:1 << mount, md:item?.damage & 255, pwr:0};
  }
  if (id === 750 && meta >= 7 && meta <= 11) type = (['RPPipe','RPTube','RPRSTube','RPRTube','RPMTube'])[meta - 7];
  if (id === 753) {
    type = 'RPLogic';
    data = {sid:item?.damage & 255, rot:mount << 2, ps:0};
  }
  if (id === 768) {
    type = 'RPShLamp';
    data = shapedLampData(item?.damage ?? meta, mount);
  }
  return type ? {type, position, key:`tile:${position.join(':')}`, data} : null;
}

export function createGame(base, store, geometry, {
  clock = () => performance.timeOrigin + performance.now(), modules, allowRemoval = false, models, creativeBlocks = new Set(),
  creativeItems = new Map(),
} = {}) {
  const positions = new Map();
  const eyes = new Map();
  const spectators = new Set();
  const seats = new Map();
  let occupiedDetectors = new Map();
  const mechanics = modules ?? registerMechanics(base, store, geometry);
  const [sx, sy, sz] = base.manifest.spawn;
  const spawn = Object.freeze({ x: sx, y: sy, z: sz });
  const diagnostic = mechanics.find(module => module.id === 'diagnostic');
  const catalog = new Set([...(base.catalog ?? []), ...creativeBlocks]);
  catalog.add('legacy:9:0');
  catalog.add('legacy:11:0');
  for (const item of creativeItems.values()) if (item.blockKey) catalog.add(item.blockKey);
  for (const key of creativeBlocks) {
    const [id] = blockState(key);
    for (const variant of relatedBlockStates(key)) catalog.add(variant);
    if (pairedBlocks.has(id)) for (let meta = 0; meta < 16; meta++) catalog.add(blockKey(id, meta));
  }
  for (const id of [23,29,33,50,69,70,72,75,76,77,93,94,143]) {
    if ([...catalog].some(key => blockState(key)[0] === id)) {
      for (let meta = 0; meta < 16; meta++) catalog.add(blockKey(id,meta));
    }
  }
  for (let meta = 0; meta < 16; meta++) catalog.add(blockKey(34,meta));
  if ([...catalog].some(key => signBlocks.has(blockState(key)[0]))) {
    for (let meta = 0; meta < 16; meta++) catalog.add(blockKey(63, meta));
    for (let meta = 2; meta <= 5; meta++) catalog.add(blockKey(68, meta));
  }
  const reserved = (x, y, z) => mechanics.some(module => module.reserved?.(x, y, z));
  const spawnProtected = (x, y, z) => x === Math.floor(sx) && z === Math.floor(sz)
    && y >= Math.floor(sy) && y <= Math.floor(sy + PLAYER.height);
  const originalAt = (x, y, z) => JSON.stringify(base.getCell(x, y, z));
  const conflicts = store.rebase({...base, catalog}, reserved, originalAt);
  occupiedDetectors = new Map(store.edits().filter(cell => {
    const [id,meta] = blockState(cell);
    return id === 28 && Boolean(meta & 8);
  }).map(({x,y,z}) => [cellAddress(x,y,z),[x,y,z]]));

  const snapshotCells = () => mechanics.flatMap(module => module.snapshot?.() ?? []);
  let mechanicCells = new Map();
  function refreshMechanicCells() {
    mechanicCells = new Map(snapshotCells().map(cell => [cellAddress(cell.x, cell.y, cell.z), cell]));
  }
  refreshMechanicCells();

  function editObject(edit) {
    if (edit.object || (edit.cell !== 'legacy:96:8' && edit.cell !== 'legacy:96:12')) return edit.object;
    // Older saved hatch toggles predate the added rung and have no object.
    const original = base.getCell(edit.x, edit.y, edit.z).object;
    return original?.type === 'WestCellarHatch' ? original : null;
  }

  function getCurrent(x, y, z) {
    const edit = mechanicCells.get(cellAddress(x, y, z)) ?? store.getEdit(x, y, z);
    if (edit) return { x, y, z, cell: edit.cell, object: editObject(edit), revision: edit.revision,
      ...(edit.parts && {parts: edit.parts}), ...(edit.voxels && {voxels: edit.voxels}) };
    const original = base.getCell(x, y, z);
    return { x, y, z, cell: original.key === 'air' ? null : original.key, object: original.object, revision: 0 };
  }

  function cellView(current) {
    const {cell, object, voxels} = current;
    return {key: cell, object, parts: current.parts ?? base.manifest.compositions?.[cell]?.parts, voxels};
  }

  function publicChange(change, object = change.object) {
    const parts = change.parts ?? (base.manifest.chunkPalettes ? base.manifest.compositions?.[change.cell]?.parts : undefined);
    return {...change, ...(parts && {parts}), object:displayObject(object)};
  }

  const physical = physics(base, geometry, (x, y, z) => {
    const current = getCurrent(x, y, z);
    return current.cell === null ? null : cellView(current);
  });
  const frames = createItemFrames({base,store,physical,getCurrent,faceSupports,
    protectedCell:(x,y,z) => reserved(x,y,z) || spawnProtected(x,y,z)});
  const carts = createMinecarts({
    base,store,clock,cellAt:getCurrent,
    canTouch:physical.visiblePoint,
    solidAt:(x,y,z) => (geometry.collisionFor ?? geometry.shapeFor)(cellView(getCurrent(x,y,z)))
      .some(box => box.solid !== false && box.x0 < .5 && box.x1 > .5 && box.z0 < .5 && box.z1 > .5),
    canMove(entity,rider,track,rail) {
      const [x,y,z] = entity.position;
      const feet = {x,y:y - 3 / 16,z};
      const raised = rail.ends.find(end => end[1] === 1);
      const ignored = raised ? [{x:track.x + raised[0] * 2 - 1,y:track.y,z:track.z + raised[2] * 2 - 1}] : [];
      return bodyWithinMap(feet) && !physical.collides(feet,rider ? SEATED_HEIGHT : .44,ignored);
    },
  });
  const boats = createBoats({base,store,clock,cellAt:getCurrent,canMove(entity,rider) {
    const [x,y,z] = entity.position;
    const yaw = boatHeading(entity), cos = Math.cos(yaw), sin = Math.sin(yaw);
    const anchor = boatSeat(entity);
    if (!bodyWithinMap(anchor) || rider && physical.collides(anchor,SEATED_HEIGHT)) return false;
    return [[0,0],[-.31,-.43],[-.31,.43],[.31,-.43],[.31,.43]].every(([side,end]) => {
      const sample = {x:x + side*cos + end*sin,y:y-.12,z:z - side*sin + end*cos};
      return base.inBounds(Math.floor(sample.x),Math.floor(sample.y),Math.floor(sample.z)) &&
        !physical.collides(sample,.56);
    });
  }});

  function playerAt(player) {
    return positions.get(player)?.position ?? spawn;
  }

  function playerSight(player) {
    const position = playerAt(player);
    const eye = eyes.get(player);
    if (eye) {
      const origin = [position.x,position.y + eye[1],position.z];
      const target = [origin[0] + eye[0],origin[1],origin[2] + eye[2]];
      if (physical.visiblePoint([target[0],target[1] + .02,target[2]],target) &&
          physical.visiblePoint(origin,target)) return {x:target[0],y:position.y,z:target[2],eye:eye[1]};
    }
    return seats.has(player) ? {...position, eye:SEATED_EYE} : position;
  }

  function movePlayer(player, position) {
    const now = clock();
    positions.set(player, {position, updated:now, seen:now, budget:1});
  }

  function seatsAt(x, y, z) {
    return [...seats.values()].some(seat => seat.blocks.some(block => block.x === x && block.y === y && block.z === z));
  }

  function publicSeat(player) {
    const seat = seats.get(player);
    return seat ? seat.anchor : null;
  }

  function poseFor(player, pose) {
    if (pose?.eye) eyes.set(player,pose.eye);
    else if (pose) eyes.delete(player);
    if (spectators.has(player)) return {...pose, spectator:true};
    const seat = publicSeat(player);
    if (!seat) return pose?.motion === 'sit' ? {...pose, motion:'idle'} : pose;
    return { ...pose, yaw:seat.yaw, lookYaw:pose?.yaw ?? seat.yaw, pitch:pose?.pitch ?? 0, motion:'sit' };
  }

  function leaveSeat(player) {
    const seat = seats.get(player);
    if (!seat) return;
    const withinBounds = point => base.inBounds(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z)) &&
      base.inBounds(Math.floor(point.x), Math.floor(point.y + PLAYER.height - 1e-5), Math.floor(point.z));
    const standable = point => withinBounds(point) && !physical.collides(point);
    const prior = seat.previous;
    const {x, y, z, yaw} = seat.anchor;
    const offsets = [[-Math.round(Math.sin(yaw)), -Math.round(Math.cos(yaw))], [1, 0], [-1, 0], [0, 1], [0, -1]];
    const nearby = offsets.flatMap(([dx, dz]) => [y, y + .5, y + 1].map(level =>
      ({x:x + dx, y:level, z:z + dz})));
    const stillNearby = !seat.ridden || Math.hypot(prior.x - x,prior.y - y,prior.z - z) < 2;
    const shore = seat.anchor.kind === 'boat' ? boatLanding(seat.anchor) : null;
    const position = shore ?? [...(stillNearby ? [prior] : []),...nearby,{x,y,z}].find(standable) ?? spawn;
    releaseSeat(player);
    movePlayer(player, position);
    return position;
  }

  function boatLanding({x,y,z}) {
    const candidates = [];
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const distance = dx*dx + dz*dz;
      if (distance && distance <= 5) candidates.push({dx,dz,distance});
    }
    candidates.sort((a,b) => a.distance-b.distance);
    for (const {dx,dz} of candidates) {
      const stand = physical.standAbove({x:x+dx,y:y-.18,z:z+dz},y+1.12);
      if (!stand || !bodyWithinMap(stand)) continue;
      const floor = [stand.x,stand.y+.01,stand.z].map(Math.floor);
      if (liquidLevel(getCurrent(...floor).cell) !== null) continue;
      if (physical.visiblePoint([x,y+SEATED_EYE,z],[stand.x,stand.y+.85,stand.z])) return stand;
    }
    return null;
  }

  function releaseSeat(player) {
    const seat = seats.get(player);
    if (seat?.entity) {
      if (seat.anchor.kind === 'boat') boats.steering(seat.entity,null);
      else carts.steering(seat.entity,0);
    }
    seats.delete(player);
  }

  function takeSeat(player, previous, anchor, blocks, entity) {
    const {x, y, z} = anchor;
    const position = {x, y, z};
    if (physical.collides(position, SEATED_HEIGHT, blocks)) throw new RequestError(409, 'seat_blocked');
    seats.set(player, {anchor, blocks, previous, entity});
    movePlayer(player, position);
    return {seat:anchor, position};
  }

  function visibleVehicle(player,address,hit,key,missing,vehicle) {
    const position = playerSight(player);
    const eye = [position.x, position.y + (position.eye ?? PLAYER.eye), position.z];
    const target = [hit.x, hit.y, hit.z];
    const delta = target.map((value,axis) => value - eye[axis]);
    const distance = Math.hypot(...delta);
    if (distance > 6 || distance < .00001) throw new RequestError(403, 'outside_reach');
    const validKey = typeof key === 'string' && key.length <= 160;
    const boat = validKey && vehicle !== 'minecart' ? boats.current(address.x,address.z,key) : null;
    const entity = boat ?? (validKey && vehicle !== 'boat' ? carts.current(address.x,address.z,key) : null);
    if (!isRideableBoat(entity) && !isRideableMinecart(entity)) throw new RequestError(409,missing);
    const hitVehicle = boat ? boatHit : minecartHit;
    const recent = boat ? boats.recent : carts.recent;
    const poses = recent(entity).filter(pose => axes.every((axis,index) => Math.floor(pose.position[index]) === address[axis]));
    if (!poses.length) throw new RequestError(409,missing);
    const direction = delta.map(value => value / distance);
    if (!physical.visiblePoint(eye,target) || !poses.some(pose =>
      Math.abs(hitVehicle(pose,eye,direction,distance + .08) - distance) <= .08)) {
      throw new RequestError(403, 'outside_reach');
    }
    return entity;
  }

  function sitInVehicle(player,previous,pose,address,hit,key) {
    const entity = visibleVehicle(player,address,hit,key,'not_a_seat');
    if ([...seats.values()].some(seat => seat.entity === entity.key)) throw new RequestError(409, 'seat_taken');
    const ship = isRideableBoat(entity);
    const anchor = ship ? boatSeat(entity) : minecartSeat(entity,pose.yaw);
    const result = takeSeat(player,previous,{...anchor,entity:entity.key},[],entity.key);
    (ship ? boats : carts).board(entity);
    seats.get(player).pose = pose;
    return result;
  }

  function sit(player, target, pose) {
    if (pose?.eye) eyes.set(player,pose.eye);
    else eyes.delete(player);
    if (spectators.has(player)) throw new RequestError(403, 'spectator_action');
    const previous = playerAt(player);
    const existing = publicSeat(player);
    if (existing || !target) {
      const position = target ? previous : leaveSeat(player) ?? previous;
      return {seat:publicSeat(player), position};
    }
    const address = point(target, true);
    const hit = point(target.hit);
    const {x, y, z} = address;
    if (!base.inBounds(x, y, z)) throw new RequestError(403, 'outside_playable_area');
    if (target.entity !== undefined) return sitInVehicle(player,previous,pose,address,hit,target.entity);
    const current = getCurrent(x, y, z);
    const profile = seatFor(cellView(current), models, pose.yaw,
      (dx, dy, dz) => cellView(getCurrent(x + dx, y + dy, z + dz)));
    if (!profile) throw new RequestError(409, 'not_a_seat');
    if (!physical.targetAtHit(playerSight(player), x, y, z, hit)) throw new RequestError(403, 'outside_reach');
    const other = profile.bed ? bedMate(current, address, getCurrent) : null;
    const blocks = other ? [address, other] : [address];
    if (blocks.some(block => seatsAt(block.x, block.y, block.z))) throw new RequestError(409, 'seat_taken');
    return takeSeat(player, previous, {x:x + .5, y:y + profile.height, z:z + .5, yaw:profile.yaw}, blocks);
  }

  function activePositions(player, position) {
    const now = clock();
    const active = player ? [position ?? playerAt(player)] : [];
    for (const [id, entry] of positions) {
      if (id !== player && !spectators.has(id) && now - (entry.seen ?? entry.updated) < MAX_ACTIVE_IDLE_MS) active.push(entry.position);
    }
    return active;
  }

  function playerOverlaps(x, y, z, key, activePlayer, plannedNeighbor) {
    return activePositions(activePlayer).some(position => physical.overlaps(position, x, y, z, key, plannedNeighbor));
  }

  function moduleContext(module, player, fields) {
    const position = player ? fields.position ?? playerAt(player) : null;
    const active = activePositions(player, position);
    return {
      ...fields,
      player,
      now: clock(),
      playerPosition: position,
      activePositions: active,
      getCell: getCurrent,
      readState: (owner, key) => store.getState(module.id, owner, key),
      ownerAt: ({x,y,z,moveOwner}) => moveOwner ?? store.getEditOwner(x,y,z),
      pistonDestination: ({x,y,z}) => base.inBounds(x,y,z) && !reserved(x,y,z) &&
        !spawnProtected(x,y,z) && !seatsAt(x,y,z) && !frames.hasMountAt(x,y,z),
      pistonMovable: cell => !reserved(cell.x,cell.y,cell.z) && !spawnProtected(cell.x,cell.y,cell.z) &&
        !seatsAt(cell.x,cell.y,cell.z) && !frames.hasMountAt(cell.x,cell.y,cell.z) &&
        (allowRemoval || cell.moveOwner || store.getEditOwner(cell.x,cell.y,cell.z)) &&
        geometry.collisionFor(cellView(cell)).some(box => box.solid !== false),
      playerOverlaps: (x, y, z, cell, plannedNeighbor) => active.some(position =>
        physical.overlaps(position, x, y, z, cell, plannedNeighbor)),
    };
  }

  function writePlan(module, plan, placement) {
    const revision = plan.cells?.length ? store.nextRevision() : store.worldRevision();
    const changes = [];
    for (const {moveOwner,...cell} of plan.cells ?? []) {
      const change = {...cell,revision};
      changes.push(change);
      const { x, y, z } = change;
      if (module.reserved?.(x, y, z)) continue;
      const placed = change.cell !== null && (placement?.key === cellAddress(x, y, z) ||
        placement?.keys?.has(cellAddress(x, y, z)));
      const owner = moveOwner ?? (placed ? placement.player : null);
      store.writeEdit(change, originalAt(x, y, z), owner);
    }
    for (const entry of plan.state ?? []) {
      const value = entry.useRevision ? { ...entry.value, revision } : entry.value;
      store.putState(module.id, entry.owner, entry.key, module.version, value);
    }
    return {
      worldRevision: revision,
      changes: changes.map(change => publicChange(change)),
      effects: plan.effects ?? [],
    };
  }

  function checkAdjacentCollisions(player, {x, y, z}, next) {
    if (!geometry.neighborCollisionShapeDependsOn) return;
    const active = activePositions(player);
    for (const [dx, dy, dz] of faceOffsets) {
      const [ax, ay, az] = [x + dx, y + dy, z + dz];
      const adjacent = cellView(getCurrent(ax, ay, az));
      if (!geometry.neighborCollisionShapeDependsOn(adjacent)) continue;
      const plannedNeighbor = (nx, ny, nz) => dx + nx === 0 && dy + ny === 0 && dz + nz === 0 ? next : undefined;
      if (active.some(position => physical.overlaps(position, ax, ay, az, adjacent, plannedNeighbor)
          && !physical.overlaps(position, ax, ay, az, adjacent))) {
        throw new RequestError(409, 'occupied');
      }
    }
  }

  function writeCell(player, {x, y, z}, cell, object, companion, adjusted = []) {
    const change = { x, y, z, cell, object };
    const replaced = companion ? [change, companion] : [change];
    const changed = [...replaced, ...adjusted];
    for (const item of changed) {
      checkAdjacentCollisions(player, item, {key:item.cell ?? 'air', object:item.object,
        parts:base.manifest.compositions?.[item.cell]?.parts});
    }
    const placement = cell === null ? undefined : {keys:new Set(replaced.map(item => cellAddress(item.x, item.y, item.z))), player};
    const effects = cell === null ? [] : [{type: 'sound', sound: 'block.place', cell, position: [x, y, z]}];
    for (const module of mechanics) {
      const plan = module.prepareBlockChange?.(moduleContext(module, player, {change, changed}));
      if (plan) return writePlan(module, {...plan, effects: [...effects, ...plan.effects]}, placement);
    }
    return writePlan({}, {cells:changed, effects}, placement);
  }

  function placementAnchor(player, input) {
    const { x, y, z } = input;
    const position = playerSight(player);
    const distanceToCell = (value, minimum) => Math.max(minimum - value, value - minimum - 1, 0);
    if (Math.hypot(distanceToCell(position.x, x), distanceToCell(position.y + (position.eye ?? PLAYER.eye), y), distanceToCell(position.z, z)) > 6) return false;
    const adjacent = [
      [x - 1, y, z], [x + 1, y, z], [x, y - 1, z], [x, y + 1, z], [x, y, z - 1], [x, y, z + 1],
    ];
    const candidates = input.against ? adjacent.filter(([ax, ay, az]) => ax === input.against.x && ay === input.against.y && az === input.against.z) : adjacent;
    return candidates.some(([ax, ay, az]) => physical.visible(position, ax, ay, az, input.hit));
  }

  function creativePlacement(input, current, player) {
    const {x, y, z} = current;
    const [id, meta] = blockState(input.cell);
    if (!pairedBlocks.has(id)) return {cell:input.cell};
    const isBed = id === 26;
    const orientation = !isBed && input.yaw !== undefined ? (1 - Math.round(input.yaw * 2 / Math.PI)) & 3 : meta & 3;
    const [dx, dz] = bedDirections[orientation];
    const second = {x:x + (isBed ? dx : 0), y:y + (isBed ? 0 : 1), z:z + (isBed ? dz : 0)};
    if (!base.inBounds(second.x, second.y, second.z) || reserved(second.x, second.y, second.z) ||
        spawnProtected(second.x, second.y, second.z) || base.getCell(second.x, second.y, second.z).key !== 'air') {
      throw new RequestError(403, 'protected_cell');
    }
    if (getCurrent(second.x, second.y, second.z).cell !== null) throw new RequestError(409, 'occupied');
    const cell = blockKey(id, isBed ? orientation : orientation | (meta & 4));
    const other = blockKey(id, isBed ? orientation | 8 : 8 | (meta & 8 ? meta & 1 : 0));
    const atOther = (ax, ay, az) => x + ax === second.x && y + ay === second.y && z + az === second.z ? other : undefined;
    const atOrigin = (ax, ay, az) => second.x + ax === x && second.y + ay === y && second.z + az === z ? cell : undefined;
    if (playerOverlaps(x, y, z, cell, player, atOther) ||
        playerOverlaps(second.x, second.y, second.z, other, player, atOrigin)) throw new RequestError(409, 'occupied');
    return {cell, companion:{...second, cell:other, object:null}, paired:true};
  }

  function controlPlacement(input) {
    const [id, meta] = blockState(input.cell);
    if (!input.against || !input.creative && input.yaw === undefined) return null;
    if ((id === 23 || id === 29 || id === 33) && input.yaw !== undefined) {
      const direction = [3,4,2,5][-Math.round(input.yaw * 2 / Math.PI) & 3];
      const pitch = input.pitch ?? 0;
      return blockKey(id,id === 23 || Math.abs(pitch) < Math.PI / 3 ? direction : Number(pitch < 0));
    }
    const button = Boolean(buttonDuration(id));
    const torch = id === 50 || id === 75 || id === 76;
    const repeater = id === 93 || id === 94;
    const floor = repeater || pressurePlate(id) || id === 55;
    if (!floor && !button && !torch && id !== 69) return null;
    const face = signalSides.findIndex(offset => axes.every((axis,index) => input[axis] - input.against[axis] === offset[index]));
    if (face < 0 || floor && face !== 1 || (torch || button) && face === 0 || button && face === 1) {
      throw new RequestError(409,'invalid_control_face');
    }
    const {x,y,z} = input.against;
    if (!faceSupports(x,y,z,face,.35)) throw new RequestError(409,'invalid_control_face');
    const heading = input.yaw === undefined ? meta & 3 : -Math.round(input.yaw * 2 / Math.PI) & 3;
    if (repeater) return blockKey(93,heading | (meta & 12));
    if (floor) return blockKey(id,0);
    if (id === 69 && face <= 1) return blockKey(id,face ? 5 + (heading & 1) : (heading & 1) * 7);
    return blockKey(id === 75 ? 76 : id,mountingMeta[face]);
  }

  function faceSupports(x,y,z,face,inset) {
    const neighbors = (dx,dy,dz) => cellView(getCurrent(x + dx,y + dy,z + dz));
    const axis = [1,1,2,2,0,0][face];
    const lower = face % 2 === 0;
    const minimum = ['x0','y0','z0'], maximum = ['x1','y1','z1'];
    return geometry.collisionFor(neighbors(0,0,0),neighbors).some(box =>
      (lower ? box[minimum[axis]] <= 0 : box[maximum[axis]] >= 1) &&
      minimum.every((key,index) => index === axis || box[key] <= inset && box[maximum[index]] >= 1 - inset));
  }

  function placeSign(player, current, input) {
    const {x, y, z, against, hit} = input;
    const face = against ? signalSides.findIndex(offset => axes.every((axis, index) => input[axis] - against[axis] === offset[index])) : undefined;
    const orient = input.creative || input.yaw !== undefined;
    if (orient && face === 0) throw new RequestError(409, 'invalid_sign_face');
    if (face === -1 || (!against && hit)) throw new RequestError(403, 'outside_reach');
    const standing = input.yaw === undefined ? blockState(input.cell)[1] : -Math.round(input.yaw * 8 / Math.PI) & 15;
    const cell = !orient ? input.cell : face === 1 ? blockKey(63, standing) : face >= 2 ? blockKey(68, face) : input.cell;
    const position = [x, y, z];
    const copied = input.creative ? null : store.getClipboard(player);
    const original = copied?.cell === input.cell ? copied.object : null;
    const object = original ? (geometry.placementObject ? geometry.placementObject(cell, original, position) :
      {...original, position, key:`tile:${position.join(':')}`}) : signObject(position, ['', '', '', '']);
    return writeCell(player, current, cell, object);
  }

  function railSupport(x, y, z) {
    const get = (dx, dy, dz) => cellView(getCurrent(x + dx, y + dy, z + dz));
    return geometry.collisionFor(get(0, 0, 0), get).some(box =>
      box.y1 >= 1 && box.x0 <= .5 && box.x1 >= .5 && box.z0 <= .5 && box.z1 >= .5);
  }

  function orientRail({x, y, z}, track, read, preferred, flexible = false) {
    return orientedRail(track, (dx, rise, dz) => {
      const nx = x + dx, nz = z + dz, height = y + rise;
      if (rise && !railSupport(nx, height - 1, nz)) return false;
      return [height, height - 1].some(level => {
        const other = railFor(read(nx, level, nz));
        if (!other) return false;
        const edge = [.5 - dx * .5, height - level, .5 - dz * .5];
        if (other.ends.some(end => end.every((value, index) => edge[index] === value))) return true;
        return flexible && Boolean(store.getEditOwner(nx, level, nz)) &&
          (level === height || railSupport(x, y - 1, z));
      });
    }, preferred);
  }

  function updateRailNeighbors(current, replacement) {
    const {x, y, z} = current;
    const staged = new Map([[cellAddress(x, y, z), {...current, cell:replacement}]]);
    const read = (rx, ry, rz) => staged.get(cellAddress(rx, ry, rz)) ?? getCurrent(rx, ry, rz);
    const changes = [];
    for (const [dx, , dz] of signalSides.slice(2)) {
      for (let level = y - 1; level <= y + 1; level++) {
        const near = read(x + dx, level, z + dz);
        const rail = railFor(near);
        if (!rail || !store.getEditOwner(near.x, near.y, near.z) || reserved(near.x, near.y, near.z)) continue;
        const cell = orientRail(near, rail, read, rail.shape);
        if (cell === near.cell) continue;
        const change = {...near, cell};
        changes.push(change);
        staged.set(cellAddress(near.x, near.y, near.z), change);
      }
    }
    return changes;
  }

  function placeRail(player, current, input, rail) {
    const {x, y, z, yaw} = input;
    if (!railSupport(x, y - 1, z)) throw new RequestError(409, 'rail_needs_support');
    const preferred = yaw === undefined ? Number(rail.ends[0][0] !== rail.ends[1][0]) :
      Number(Math.abs(Math.sin(yaw)) > Math.abs(Math.cos(yaw)));
    const cell = orientRail(current, rail, getCurrent, preferred, true);
    return writeCell(player, current, cell, null, undefined, updateRailNeighbors(current, cell));
  }

  function placedCompanion(current) {
    const {x, y, z} = current;
    const [id, meta] = blockState(current);
    let mate;
    if (id === 26) mate = bedMate(current, current, getCurrent);
    else if (id === 64 || id === 71) {
      const other = getCurrent(x, y + (meta & 8 ? -1 : 1), z);
      const [otherId, otherMeta] = blockState(other);
      if (id === otherId && Boolean(meta & 8) !== Boolean(otherMeta & 8)) mate = other;
    }
    if (!mate || !store.getEditOwner(mate.x, mate.y, mate.z) ||
        base.getCell(mate.x, mate.y, mate.z).key !== 'air') return undefined;
    if (seatsAt(mate.x, mate.y, mate.z)) throw new RequestError(409, 'seat_taken');
    return {x:mate.x, y:mate.y, z:mate.z, cell:null, object:null};
  }

  function writeMicroParts(current, ownedParts, placed, voxels = current.voxels) {
    const {x, y, z} = current;
    const revision = store.nextRevision();
    const parts = ownedParts.map(publicMicroPart);
    const original = !voxels && parts.length && ownedParts.every(part => !part.owner) ? base.getCell(x, y, z) : null;
    const restored = original?.key === 'air' ? null : original;
    const cell = parts.length ? (restored?.key ?? microblockKey) : voxels ? voxelKey : null;
    const change = {x, y, z, cell, object:restored?.object ?? null, revision,
      ...(parts.length || !voxels ? {parts} : {}), ...(voxels && {voxels})};
    const owner = voxels ? store.getEditOwner(x, y, z) : null;
    store.writeEdit(change, originalAt(x, y, z), owner, parts.length || !voxels ? ownedParts : null);
    const effects = placed ? [{type: 'sound', sound: 'block.place', cell, position: [x, y, z], material: placed.material}] : [];
    return {worldRevision: revision, changes: [publicChange(change)], effects};
  }

  function microParts(current) {
    const {x, y, z} = current;
    const owner = base.getCell(x, y, z).key === 'air' ? store.getEditOwner(x, y, z) : null;
    return store.getMicroParts(x, y, z) ?? (cellView(current).parts ?? []).map(part => ({...publicMicroPart(part), owner}));
  }

  function removeMicroblocks(player, input, current) {
    const {x, y, z, hit} = input;
    if (reserved(x, y, z) || spawnProtected(x, y, z)) throw new RequestError(403, 'protected_cell');
    if (!physical.targetAtHit(playerSight(player), x, y, z, hit, true)) throw new RequestError(403, 'outside_reach');
    const parts = microParts(current);
    const remaining = parts.filter(part => !part.owner);
    const clearVoxels = current.voxels && store.getEditOwner(x, y, z);
    if (remaining.length === parts.length && !clearVoxels) throw new RequestError(403, 'part_not_owned');
    return writeMicroParts(current, remaining, null, clearVoxels ? null : current.voxels);
  }

  function editMicroParts(player, input, current) {
    const {x, y, z, type, hit} = input;
    const view = cellView(current);
    const isMultipart = isMicroblockCell(view);
    const position = playerSight(player);
    if (type === 'copy_part') {
      const part = view.parts?.find(({slot}) => slot === input.partSlot);
      if (!part || !isMicroPart(part)) throw new RequestError(409, 'part_missing');
      if (!physical.visiblePart(position, x, y, z, part.slot, hit)) throw new RequestError(403, 'outside_reach');
      const neighbors = (dx, dy, dz) => cellView(getCurrent(x + dx, y + dy, z + dz));
      const boxes = (geometry.selectionFor ?? geometry.shapeFor)(view, neighbors).filter(box => box.partSlot === part.slot);
      const pattern = microblockPattern(boxes);
      if (!pattern) throw new RequestError(409, 'incompatible_part');
      const copied = publicMicroPart(part);
      store.putClipboard(player, {part:copied, pattern});
      return {worldRevision: store.worldRevision(), changes: [], effects: [], part: copied, pattern};
    }

    if (reserved(x, y, z) || spawnProtected(x, y, z)) throw new RequestError(403, 'protected_cell');
    const original = base.getCell(x, y, z).key;
    if ((!isMultipart && (!current.voxels && current.cell !== null || original !== 'air')) ||
        (isMultipart && original !== 'air' && !isMicroblockCell({key: original, parts: base.manifest.compositions?.[original]?.parts}))) {
      throw new RequestError(409, 'incompatible_part');
    }
    const parts = view.parts ?? [];
    // Copies placed by the older whole-cell API inherit their proven owner on the first part edit.
    const owned = microParts(current);

    if (type === 'remove_part') {
      const part = owned.find(({slot}) => slot === input.partSlot);
      if (!part) throw new RequestError(409, 'part_missing');
      if (!part.owner) throw new RequestError(403, 'part_not_owned');
      if (!physical.visiblePart(position, x, y, z, part.slot, hit)) throw new RequestError(403, 'outside_reach');
      const next = microblockRemoval(parts, part.slot, {
        mayReshape: slot => owned.some(remaining => remaining.slot === slot && remaining.owner),
      });
      if (!next || partBoxesOverlapVoxels(next.boxes, current.voxels)) throw new RequestError(409, 'incompatible_part');
      if (next.reshaped && playerOverlaps(x, y, z, {key: microblockKey, parts: next.parts}, player)) {
        throw new RequestError(409, 'occupied');
      }
      return writeMicroParts(current, owned.filter(({slot}) => slot !== part.slot));
    }

    const against = input.against;
    const anchor = physical.targetAtHit(position, against.x, against.y, against.z, hit);
    const sameCell = samePoint(input, against);
    if (!anchor || against.partSlot !== anchor.partSlot || (sameCell && against.partSlot === undefined && !input.part.bounds) ||
        (!sameCell && !axes.every((axis, index) => input[axis] === against[axis] + anchor.face[index]))) {
      throw new RequestError(403, 'outside_reach');
    }
    if (input.part.bounds) {
      const item = input.creativeItem && creativeItems.get(input.creativeItem);
      const copied = input.creativeItem ? item?.part && {part:item.part, pattern:item.part.pattern} : store.getClipboard(player);
      if (!copied?.pattern || input.part.material !== copied.part.material || input.part.shape !== copied.part.shape ||
          input.part.sourceSlot !== (copied.part.sourceSlot ?? copied.part.slot)) throw new RequestError(409, 'nothing_to_copy');
      const proposal = guidedMicroblock({...against, hit: anchor.hit, offset: anchor.face}, copied.part, copied.pattern, input.orientation);
      if (!proposal || !samePoint(proposal, input) ||
          JSON.stringify(proposal.part.bounds) !== JSON.stringify(input.part.bounds)) throw new RequestError(403, 'outside_reach');
    }
    const added = microblockAddition(parts, input.part, current.voxels);
    if (!added) throw new RequestError(409, 'incompatible_part');
    const next = {key: microblockKey, object: null, parts: added.parts, voxels: current.voxels};
    if (playerOverlaps(x, y, z, next, player)) throw new RequestError(409, 'occupied');
    const nextOwners = [...owned, {...input.part, owner: player}].sort((a, b) => a.slot - b.slot);
    return writeMicroParts(current, nextOwners, input.part);
  }

  function chiselMaterial(cell) {
    return isChiselMaterial(cell.cell) && catalog.has(chiselMaterialKey(cell.cell));
  }

  function checkVoxelEditable({x, y, z, cell}) {
    if (reserved(x, y, z) || spawnProtected(x, y, z)) throw new RequestError(403, 'protected_cell');
    const original = base.getCell(x, y, z).key;
    if ((original !== 'air' && !isMicroblockCell({key:original, parts:base.manifest.compositions?.[original]?.parts})) ||
        (cell !== null && !store.getEditOwner(x, y, z))) {
      throw new RequestError(403, 'voxel_not_owned');
    }
  }

  function writeVoxels(player, current, voxels, material) {
    const {x, y, z} = current;
    const parts = cellView(current).parts;
    const cell = parts?.length ? microblockKey : voxels ? voxelKey : null;
    checkAdjacentCollisions(player, current, {key: cell ?? 'air', voxels, parts});
    const change = {x, y, z, cell, object: null, ...(voxels && {voxels})};
    const placement = voxels ? {key: cellAddress(x, y, z), player} : undefined;
    const effects = material ? [{type: 'sound', sound: 'block.place', cell: voxelKey,
      position: [x, y, z], voxelMaterial: material}] : [];
    if (parts?.length) {
      const owned = microParts(current);
      if (!voxels) return writeMicroParts(current, owned, null, null);
      const revision = store.nextRevision();
      const combined = {...change, parts, revision};
      store.writeEdit(combined, originalAt(x, y, z), player, owned);
      return {worldRevision: revision, changes: [combined], effects};
    }
    // Re-evaluate neighbours if chiselling converts an ordinary solid block.
    if (current.cell !== null && current.cell !== voxelKey) {
      for (const module of mechanics) {
        const plan = module.prepareBlockChange?.(moduleContext(module, player, {change}));
        if (plan) return writePlan(module, {...plan, effects: [...effects, ...plan.effects]}, placement);
      }
    }
    return writePlan({}, {cells: [change], effects}, placement);
  }

  function editVoxels(player, input, current) {
    const {x, y, z, type, hit, voxel, size = 1} = input;
    const position = playerSight(player);
    if (type === 'place_voxel') {
      const multipart = isMicroblockCell(cellView(current));
      if (!multipart || current.voxels) checkVoxelEditable(current);
      else if (reserved(x, y, z) || spawnProtected(x, y, z)) throw new RequestError(403, 'protected_cell');
      if (!chiselMaterial({cell: input.material})) throw new RequestError(400, 'invalid_material');
      const material = chiselMaterialKey(input.material);
      if (current.cell !== null && !current.voxels && !multipart) throw new RequestError(409, 'occupied');
      const against = input.against;
      const anchor = getCurrent(against.x, against.y, against.z);
      const surface = physical.targetAtHit(position, against.x, against.y, against.z, hit, true);
      if (!surface || against.partSlot !== surface.partSlot ||
          (!anchor.voxels && surface.partSlot === undefined && !chiselMaterial(anchor))) throw new RequestError(403, 'outside_reach');
      const next = chiselPlacementAtHit(against, surface.hit, surface.face,
        surface.partSlot === undefined ? anchor.voxels : undefined, surface.partSlot);
      if (!next || !samePoint(next, input) || next.voxel !== voxel) throw new RequestError(403, 'outside_reach');
      const brush = voxelBrush(voxel, size);
      if (brush.indices.some(index => voxelMaterialAt(current.voxels, index))) throw new RequestError(409, 'occupied');
      const materials = current.voxels?.materials;
      if (materials?.length >= VOXEL_MATERIAL_LIMIT && !materials.includes(material)) {
        throw new RequestError(409, 'voxel_material_limit');
      }
      const {box} = brush;
      if (multipart && partBoxesOverlapBox(coverBoxes(cellView(current).parts), box)) throw new RequestError(409, 'occupied');
      if (chiselMaterialShape(material).solid && activePositions(player).some(feet => physical.overlapsBox(feet, x, y, z, box))) {
        throw new RequestError(409, 'occupied');
      }
      return writeVoxels(player, current, writeVoxelBrush(current.voxels, brush, material), material);
    }

    if (type === 'remove_voxel') checkVoxelEditable(current);
    if (!current.voxels && !chiselMaterial(current)) throw new RequestError(409, 'invalid_material');
    const surface = physical.targetAtHit(position, x, y, z, hit, true);
    if (!surface || surface.partSlot !== undefined ||
        chiselVoxelAtHit(current, surface.hit, surface.face, current.voxels, current.cell) !== voxel) {
      throw new RequestError(403, 'outside_reach');
    }
    const material = chiselMaterialKey(current.voxels ? voxelMaterialAt(current.voxels, voxel) : current.cell);
    if (!material) throw new RequestError(409, 'empty_cell');
    if (type === 'copy_voxel') return {worldRevision: store.worldRevision(), changes: [], effects: [], material};
    const voxels = current.voxels ?? chiselSourceVolume(current.cell, geometry.shapeFor(cellView(current),
      (dx, dy, dz) => cellView(getCurrent(x + dx, y + dy, z + dz))));
    return writeVoxels(player, current, writeVoxelBrush(voxels, voxelRemovalBrush(current.voxels, voxel, size), null));
  }

  function execute(player, input, transport) {
    const { x, y, z, type } = input;
    if (!base.inBounds(x, y, z)) throw new RequestError(403, 'outside_playable_area');
    if (frameActions.has(type)) {
      let stack;
      if (type === 'frame_item') {
        stack = heldStack(input.cell,input.creativeItem);
        if (!stack) throw new RequestError(400,'unknown_cell_type');
      }
      return frames.edit(input,playerSight(player),stack);
    }
    if (vehicleRemovals.has(type)) {
      const ship = type === 'remove_boat';
      const entity = visibleVehicle(player,input,input.hit,input.entity,vehicleRemovals.get(type),ship ? 'boat' : 'minecart');
      if ([...seats.values()].some(seat => seat.entity === entity.key)) throw new RequestError(409,'seat_taken');
      (ship ? boats : carts).remove(entity.key);
      return {worldRevision:store.worldRevision(),changes:[],effects:[],
        ...(ship ? {removedBoat:entity.key} : {removedMinecart:entity.key})};
    }
    const current = getCurrent(x, y, z);
    if (input.expectedRevision !== current.revision) {
      throw new RequestError(409, 'stale_cell', {current:publicChange(current), worldRevision:store.worldRevision()});
    }
    if (type === 'place_frame') {
      if (creativeItems.get(input.creativeItem)?.kind !== 'item-frame') throw new RequestError(400,'unknown_cell_type');
      return frames.place(input,playerSight(player));
    }
    if (type === 'place_minecart') {
      if (creativeItems.get(input.creativeItem)?.kind !== 'minecart') throw new RequestError(400,'unknown_cell_type');
      const rail = railFor(current);
      if (!rail) throw new RequestError(409,'minecart_requires_rail');
      if (!physical.targetAtHit(playerSight(player),x,y,z,input.hit)) throw new RequestError(403,'outside_reach');
      transport.placed = carts.place(input,rail);
      return {worldRevision:store.worldRevision(),changes:[],effects:[],minecart:transport.placed.entity};
    }
    if (type === 'place_boat') {
      if (creativeItems.get(input.creativeItem)?.kind !== 'boat') throw new RequestError(400,'unknown_cell_type');
      if (liquidLevel(current.cell) === null) throw new RequestError(409,'boat_requires_water');
      if (!physical.targetAtHit(playerSight(player),x,y,z,input.hit)) throw new RequestError(403,'outside_reach');
      transport.placedBoat = boats.place(input);
      return {worldRevision:store.worldRevision(),changes:[],effects:[],boat:transport.placedBoat.entity};
    }
    if (partActions.has(type)) return editMicroParts(player, input, current);
    if (voxelActions.has(type)) return editVoxels(player, input, current);
    if (type === 'remove_microblocks') return removeMicroblocks(player, input, current);
    if (type === 'place') {
      if (reserved(x, y, z) || spawnProtected(x, y, z)) throw new RequestError(403, 'protected_cell');
      const item = input.creativeItem && creativeItems.get(input.creativeItem);
      const allowed = input.creativeItem ? item && !item.part && item.blockKey === input.cell :
        input.creative ? creativeBlocks.has(input.cell) : catalog.has(input.cell);
      if (!allowed || input.cell === 'air' || input.cell === voxelKey) {
        throw new RequestError(400, 'unknown_cell_type');
      }
      if (input.turns && !geometry.isSofa?.(input.cell)) throw new RequestError(400, 'invalid_heading');
      if (!allowRemoval && (input.cell === microblockKey ||
          isMicroblockCell({key: input.cell, parts: base.manifest.compositions?.[input.cell]?.parts}))) {
        throw new RequestError(409, 'part_required');
      }
      if (current.cell !== null) throw new RequestError(409, 'occupied');
      if (!allowRemoval && base.getCell(x, y, z).key !== 'air') throw new RequestError(403, 'protected_cell');
      if (!placementAnchor(player, input)) throw new RequestError(403, 'outside_reach');
      if (signBlocks.has(blockState(input.cell)[0])) return placeSign(player, current, input);
      const rail = railFor(input.cell);
      if (rail) return placeRail(player, current, input, rail);
      const control = controlPlacement(input);
      if (control) {
        const object = newCreativeObject(control,[x,y,z],input,item);
        if (playerOverlaps(x,y,z,{key:control,object},player)) throw new RequestError(409,'occupied');
        return writeCell(player,current,control,object);
      }
      const actual = input.creative ? creativePlacement(input, current, player) : input;
      const copied = input.creative ? null : store.getClipboard(player);
      const copiedObject = input.creative || item ? newCreativeObject(actual.cell, [x, y, z], input, item) :
        copied?.cell === actual.cell ? copied.object : null;
      const object = geometry.placementObject
        ? geometry.placementObject(actual.cell, copiedObject, [x, y, z], input.turns)
        : copiedObject ? { ...copiedObject, position: [x, y, z], key: `tile:${x}:${y}:${z}` } : null;
      const parts = base.manifest.compositions?.[actual.cell]?.parts;
      if (!actual.paired && playerOverlaps(x, y, z, {key:actual.cell, object, parts}, player)) throw new RequestError(409, 'occupied');
      return writeCell(player, current, actual.cell, object, actual.companion);
    }

    if (type === 'remove' && reserved(x, y, z)) throw new RequestError(403, 'protected_cell');
    if (type === 'remove' && blockState(current)[0] === 34) throw new RequestError(403,'protected_cell');
    if (type === 'remove' && seatsAt(x, y, z)) throw new RequestError(409, 'seat_taken');
    if (current.cell === null) throw new RequestError(409, 'empty_cell');
    if ((type === 'remove' || type === 'copy') && current.cell === voxelKey) throw new RequestError(409, 'voxel_required');
    if ((type === 'remove' || type === 'copy') &&
        (current.parts || (!allowRemoval && isMicroblockCell(cellView(current))))) {
      throw new RequestError(409, 'part_required');
    }
    if (type === 'remove' && !allowRemoval) {
      if (!store.getEditOwner(x, y, z) || base.getCell(x, y, z).key !== 'air') {
        throw new RequestError(403, 'block_not_owned');
      }
    }
    if (!physical.visible(playerSight(player), x, y, z, input.hit)) throw new RequestError(403, 'outside_reach');
    if (type === 'edit_sign') {
      if (!signBlocks.has(blockState(current)[0])) throw new RequestError(409, 'not_a_sign');
      if (!store.getEditOwner(x, y, z) || reserved(x, y, z) || spawnProtected(x, y, z)) throw new RequestError(403, 'protected_cell');
      const change = {...current, object:signObject([x, y, z], input.lines, current.object)};
      return writePlan({}, {cells:[change]});
    }
    if (type === 'interact') {
      for (const module of mechanics) {
        const plan = module.prepareInteraction?.(moduleContext(module,player,{x,y,z,current,input,
          stack:heldStack(input.heldCell,input.heldItem)}));
        if (plan) return writePlan(module, plan);
      }
      throw new RequestError(409, 'no_interaction');
    }
    if (type === 'copy') {
      if (reserved(x, y, z)) throw new RequestError(403, 'protected_cell');
      const object = current.object?.type === 'WestCellarHatch' ? null : displayObject(current.object);
      store.putClipboard(player, { cell: current.cell, object });
      return { worldRevision: store.worldRevision(), changes: [], effects: [], cell: current.cell };
    }
    const adjusted = railFor(current) ? updateRailNeighbors(current, null) : [];
    const result = writeCell(player,current,null,null,placedCompanion(current),adjusted);
    const remaining = frames.removeSupported(x,y,z);
    return remaining === undefined ? result : {...result,frames:remaining};
  }

  function heldStack(cell,itemKey) {
    const item = creativeItems.get(itemKey);
    if (item) return {id:item.id,Damage:item.damage ?? item.meta ?? 0,...(item.blockKey && {Block:true})};
    const [id,meta] = blockState(cell);
    if (id && !itemKey && catalog.has(cell)) return {id,Damage:meta,Block:true};
  }

  function action(player, body) {
    if (spectators.has(player)) throw new RequestError(403, 'spectator_action');
    const input = normalizeAction(body);
    if (input.eye) eyes.set(player,input.eye);
    else eyes.delete(player);
    const encoded = JSON.stringify(input);
    const { requestId } = body;
    const transport = {};
    const result = store.atomic(() => {
      const receipt = store.getReceipt(player, requestId);
      if (receipt) {
        if (receipt.input !== encoded) throw new RequestError(409, 'request_id_reused');
        return { status: receipt.status, output: receipt.output, replay: true };
      }

      let status = 200;
      let output;
      // A rejected action can record a receipt, but may never leave partial writes.
      store.db.exec('SAVEPOINT action');
      try {
        output = execute(player, input, transport);
      } catch (error) {
        store.db.exec('ROLLBACK TO action');
        if (!(error instanceof RequestError)) throw error;
        status = error.status;
        output = { error: error.code, ...error.details };
      }
      store.db.exec('RELEASE action');
      store.putReceipt(player, requestId, encoded, status, output);
      return { status, output, replay: false };
    });
    if (!result.replay && result.status === 200) {
      if (result.output.changes.length) refreshMechanicCells();
      carts.accept(transport.placed,result.output.removedMinecart);
      boats.accept(transport.placedBoat,result.output.removedBoat);
    }
    return result;
  }

  function bodyWithinMap({x, y, z}) {
    const bounds = base.manifest.bounds;
    return x - PLAYER.halfWidth >= bounds.minX && x + PLAYER.halfWidth <= bounds.maxX + 1
      && z - PLAYER.halfWidth >= bounds.minZ && z + PLAYER.halfWidth <= bounds.maxZ + 1
      && y >= bounds.minY && y + PLAYER.height <= bounds.maxY + 1;
  }

  function teleport(player, body) {
    const target = point(body);
    if (!bodyWithinMap(target)) throw new RequestError(403, 'outside_playable_area');
    if (base.hasPlayableChunk) {
      const chunk = value => Math.floor(value / 16);
      for (const x of [chunk(target.x - PLAYER.halfWidth), chunk(target.x + PLAYER.halfWidth - 1e-6)]) {
        for (const z of [chunk(target.z - PLAYER.halfWidth), chunk(target.z + PLAYER.halfWidth - 1e-6)]) {
          if (!base.hasPlayableChunk(x, z)) throw new RequestError(403, 'outside_playable_area');
        }
      }
    }
    const observing = spectators.has(player);
    if (!observing && physical.collides(target)) throw new RequestError(409, 'teleport_blocked');
    const entry = observing ? passivePosition(target) : enterPosition(player, target, playerAt(player));
    releaseSeat(player);
    movePlayer(player, target);
    return {...entry, seat:null};
  }

  function passivePosition(position) {
    return {position, effects:[], changes:[], worldRevision:store.worldRevision()};
  }

  function setSpectator(player, body) {
    if (typeof body?.enabled !== 'boolean') throw new RequestError(400, 'invalid_spectator');
    const previous = playerAt(player);
    if (spectators.has(player) === body.enabled) {
      return {...passivePosition(previous), seat:publicSeat(player), spectator:body.enabled, relocated:false};
    }
    let position = previous;
    let relocated = false;
    if (body.enabled) {
      releaseSeat(player);
      spectators.add(player);
    } else {
      if (physical.collides(previous)) {
        const highest = base.manifest.bounds.maxY + 1 - PLAYER.height;
        const center = {...previous, x:Math.floor(previous.x) + .5, z:Math.floor(previous.z) + .5};
        position = physical.standAbove(previous, highest) ?? physical.standAbove(center, highest) ?? spawn;
        relocated = !samePoint(position, previous);
      }
      spectators.delete(player);
    }
    movePlayer(player, position);
    return {...passivePosition(position), seat:null, spectator:body.enabled, relocated};
  }

  function enterPosition(player, position, previous) {
    const results = store.atomic(() => {
      const entries = [];
      for (const module of mechanics) {
        const plan = module.prepareEntry?.(moduleContext(module, player, { position, previous }));
        if (plan) entries.push(writePlan(module, plan));
      }
      return entries;
    });
    const effects = results.flatMap(result => result.effects);
    const changes = results.flatMap(result => result.changes);
    if (changes.length) refreshMechanicCells();
    return { position, effects, changes, worldRevision: store.worldRevision() };
  }

  function position(player, body) {
    const target = point(body);
    const previous = playerAt(player);
    if (seats.has(player)) {
      if (!samePoint(previous, target)) throw new RequestError(409, 'movement_blocked', {position:previous, seat:publicSeat(player)});
      return {position:previous, seat:publicSeat(player), effects:[], changes:[], worldRevision:store.worldRevision()};
    }
    const now = clock();
    const old = positions.get(player);
    const elapsed = Math.min(0.65, (now - (old?.updated ?? now - 100)) / 1000);
    const budget = Math.min(POSITION_BATCH_LIMIT + .4, (old?.budget ?? 1) + elapsed * RUN_SPEED);
    const hasTrail = body.trail !== undefined || body.from !== undefined;
    const reject = () => {
      throw new RequestError(409, 'movement_blocked', { position: previous });
    };
    let steps = [target];
    let requestId;
    if (hasTrail) {
      if (!Array.isArray(body.trail) || body.trail.length < 1 || body.trail.length > POSITION_TRAIL_LIMIT) {
        throw new RequestError(400, 'invalid_position_trail');
      }
      requestId = body.requestId;
      if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw new RequestError(400, 'invalid_request_id');
      const from = trailPoint(body.from);
      steps = body.trail.map(trailPoint);
      if (!samePoint(steps.at(-1), target)) throw new RequestError(400, 'invalid_position_trail');
      // A response can be lost after the server has already applied the batch.
      if (old?.requestId === requestId) {
        if (!samePoint(previous, target)) reject();
        return { position: previous, effects: [], changes: [], worldRevision: store.worldRevision() };
      }
      if (!samePoint(previous, from)) reject();
    }

    let distance = 0, drop = 0, from = previous;
    for (const step of steps) {
      const planar = Math.hypot(step.x - from.x, step.z - from.z);
      const vertical = step.y - from.y;
      if (!bodyWithinMap(step) || hasTrail && (planar > POSITION_STEP_LIMIT || Math.abs(vertical) > .55)) reject();
      distance += positionCost(planar,vertical);
      drop += Math.max(-vertical, 0);
      if (distance > budget + MOVEMENT_GRACE || drop > 6) reject();
      from = step;
    }
    const observing = spectators.has(player);
    if (!observing && !(hasTrail ? physical.movementTrailAllowed(previous, steps) : physical.movementAllowed(previous, target))) reject();

    const entry = observing ? passivePosition(target) : enterPosition(player, target, previous);
    positions.set(player, { position: target, updated: now, budget: budget - distance, requestId });
    if (!observing) carts.pushAlongPath(previous,steps);
    return entry;
  }

  function advance() {
    const plans = mechanics.flatMap(module => {
      const plan = module.prepareTick?.(moduleContext(module, null, {}));
      return plan ? [[module, plan]] : [];
    });
    const active = new Map(carts.trackCells().filter(point => blockState(getCurrent(...point))[0] === 28)
      .map(point => [cellAddress(...point),point]));
    const detectors = [...active].filter(([key]) => !occupiedDetectors.has(key))
      .map(([,point]) => ({point,occupied:true}));
    detectors.push(...[...occupiedDetectors].filter(([key]) => !active.has(key)).map(([,point]) => ({point,occupied:false})));
    if (!plans.length && !detectors.length) return null;
    const results = store.atomic(() => {
      const written = plans.map(([module,plan]) => writePlan(module,plan));
      if (detectors.length) {
        for (const module of mechanics) {
          const plan = module.prepareCartChange?.(moduleContext(module,null,{detectors}));
          if (plan) written.push(writePlan(module,plan));
        }
      }
      return written;
    });
    occupiedDetectors = active;
    const changes = results.flatMap(result => result.changes);
    if (changes.length) refreshMechanicCells();
    return {changes, effects: results.flatMap(result => result.effects), worldRevision: store.worldRevision()};
  }

  function advanceMinecarts() {
    const riders = new Map([...seats].filter(([,seat]) => seat.entity)
      .map(([player,seat]) => [seat.entity,{player,yaw:seat.anchor.yaw}]));
    const updates = [];
    function updateRider(player,entity) {
      const seat = seats.get(player);
      let position;
      if (entity) {
        const anchor = {...(isRideableBoat(entity) ? boatSeat(entity) : minecartSeat(entity,seat.anchor.yaw)),entity:entity.key};
        seat.anchor = anchor;
        seat.ridden = true;
        position = {x:anchor.x,y:anchor.y,z:anchor.z};
        movePlayer(player,position);
      } else position = leaveSeat(player);
      updates.push({player,position,pose:poseFor(player,seat.pose)});
    }
    const cartsChanged = carts.advance(riders,updateRider);
    const boatsChanged = boats.advance(riders,updateRider);
    return cartsChanged || boatsChanged ? updates : null;
  }

  const descriptions = player => diagnostic?.describe(player) ?? null;

  return {
    action,
    position,
    teleport,
    setSpectator,
    advance,
    advanceMinecarts,
    driveMinecart(player,pose,direction,boatDrive) {
      const seat = seats.get(player);
      if (!seat?.entity) return;
      seat.pose = pose;
      if (seat.anchor.kind === 'boat') {
        if (boatDrive !== undefined) boats.steering(seat.entity,boatDrive);
      } else if (direction !== undefined) carts.steering(seat.entity,direction);
    },
    minecartSnapshot(player) {
      return {entities:carts.snapshot(),boats:boats.snapshot(),position:playerAt(player),seat:publicSeat(player)};
    },
    flushMinecarts() { carts.flush(); boats.flush(); },
    sit,
    leaveSeat,
    poseFor,
    touch(player) {
      const entry = positions.get(player);
      if (entry) entry.seen = clock();
    },
    respawn(player) {
      releaseSeat(player);
      movePlayer(player, spawn);
      return { position: spawn, seat:null, effects: [], worldRevision: store.worldRevision() };
    },
    conflicts,
    contentHash: base.hash,
    worldRevision: store.worldRevision,
    session(playerId) {
      if (!positions.has(playerId)) positions.set(playerId, { position: spawn, updated: clock(), budget: 1 });
      return {
        playerId, spawn: base.manifest.spawn, position: playerAt(playerId), worldRevision: store.worldRevision(),
        catalogVersion: base.manifest.catalogVersion ?? 1, importVersion: base.manifest.importVersion, contentHash: base.hash,
        mechanics: descriptions(playerId), seat:publicSeat(playerId), spectator:spectators.has(playerId),
      };
    },
    snapshot(player) {
      return {
        bounds: base.manifest.bounds, spawn: base.manifest.spawn, worldRevision: store.worldRevision(), contentHash: base.hash,
        overrides: [...store.edits().map(edit => publicChange(edit, editObject(edit))),
          ...snapshotCells()],
        frames:frames.snapshot(),
        mechanics: descriptions(player),
      };
    },
    didCommit(event) {
      for (const module of mechanics) module.onCommitted?.(event);
    },
  };
}
