import { performance } from 'node:perf_hooks';
import { displayObject, cellAddress } from './base.mjs';
import { RequestError } from './errors.mjs';
import { createMovementChannel } from './movement-channel.mjs';
import {readEye} from './presence.mjs';
import { registerMechanics } from './mechanics.mjs';
import { PLAYER, physics } from './physics.mjs';
import { createMinecarts } from './minecarts.mjs';
import { createDroppedItems } from './dropped-items.mjs';
import { createFluidSimulation } from './fluids.mjs';
import { createInventory, inventoryInput, isInventoryAction } from './inventory.mjs';
import { containerActions, containerInput, createContainers } from './containers.mjs';
import { withoutContainerContents } from '../world/containers.mjs';
import { basicRecipes,classifyTool,harvestRule } from '../world/survival-tools.mjs';
import { createBoats } from './boats.mjs';
import { createItemFrames } from './item-frames.mjs';
import { guidedMicroblock, isMicroblockCell, isMicroPart, microblockAddition, microblockKey, microblockPattern,
  microblockRemoval, partBoxesOverlapBox, partBoxesOverlapVoxels, PART_SLOT_LIMIT, publicMicroPart } from '../world/microblocks.mjs';
import { chiselMaterialShape, coverBoxes } from '../world/geometry.mjs';
import { CRAWL_SPEED, FLIGHT_SPRINT_SPEED, POSITION_BATCH_LIMIT, POSITION_FLIGHT_DROP_LIMIT, POSITION_STEP_LIMIT,
  POSITION_TRAIL_LIMIT, POSITION_VERTICAL_STEP_LIMIT, WORLD_GRAVITY, flightPositionCost, isPlayerStance,
  playerBody } from '../world/player-body.mjs';
import { bedMate, seatFor, SEATED_EYE, SEATED_HEIGHT } from '../world/seats.mjs';
import { isRideableMinecart, minecartHit, minecartSeat } from '../world/minecarts.mjs';
import { isRideableBoat,boatHeading,boatHit,boatSeat } from '../world/boats.mjs';
import { pistonHead } from './pistons.mjs';
import { orientedRail, railFor } from '../world/rails.mjs';
import { blockKey, blockState, buttonDuration, jammyAppliance, pressurePlate, relatedBlockStates, signalSides } from '../world/block-interactions.mjs';
import { CREATIVE_BOAT_KEY,CREATIVE_FRAME_KEY,CREATIVE_INVISIBLE_FRAME_KEY,CREATIVE_MINECART_KEY,shapedLampData,
  signItemKey,signPlacementCell } from '../world/creative-items.mjs';
import { fluidAt, fluidCurrent, liquidLevel, movementMedium } from '../world/block-movement.mjs';
import { canLogLiquid, liquidCell, liquidKind } from '../world/logged-fluid.mjs';
import { FAKE_WATER, bucketKeys, fluidState, plantBlock } from '../world/fluid-state.mjs';
import { isChiselMaterial, voxelBrush, voxelKey, voxelMaterialAt, voxelRemovalBrush,
  VOXEL_COUNT, VOXEL_MATERIAL_LIMIT, writeVoxelBrush } from '../world/voxel-chisel.mjs';
import { chiselMaterialKey, chiselPlacementAtHit, chiselSourceVolume, chiselVoxelAtHit } from '../world/chisel-surface.mjs';

const partActions = new Set(['copy_part', 'place_part', 'remove_part']);
const voxelActions = new Set(['copy_voxel', 'place_voxel', 'remove_voxel']);
const liquidActions = new Set(['place_liquid', 'remove_liquid', 'copy_liquid', 'scoop_liquid']);
const dryOnlyActions = new Set(['remove', 'remove_microblocks', 'place_part', 'remove_part', 'place_voxel', 'remove_voxel']);
const frameActions = new Set(['frame_item','frame_use','frame_remove']);
const itemPlacements = new Set(['place','place_part','place_voxel','place_liquid','place_frame','frame_item','place_minecart','place_boat']);
const unlimitedActions = new Set(['inventory_copy','inventory_give','inventory_clone','copy','copy_part','copy_voxel','copy_liquid']);
const vehiclePlacements = new Map([['place_minecart',CREATIVE_MINECART_KEY],['place_boat',CREATIVE_BOAT_KEY]]);
const vehicleRemovals = new Map([['remove_minecart','not_a_minecart'],['remove_boat','not_a_boat']]);
const actions = new Set(['place', 'remove', 'remove_microblocks', 'copy', 'interact', 'edit_sign', ...containerActions,
  'place_frame', ...vehiclePlacements.keys(), ...vehicleRemovals.keys(), ...frameActions, ...partActions, ...voxelActions, ...liquidActions]);
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
const actionRate = {player:24,playerBurst:48,total:192,totalBurst:384};
const receiptCleanupInterval=60_000;

function point(input, integers = false) {
  const valid = integers ? Number.isSafeInteger : Number.isFinite;
  if (!input || axes.some(axis => !valid(input[axis]))) throw new RequestError(400, 'invalid_coordinates');
  return { x: input.x, y: input.y, z: input.z };
}

function trailPoint(input) {
  if (!Array.isArray(input) || ![3,4].includes(input.length) || input.length === 4 && !isPlayerStance(input[3])) {
    throw new RequestError(400, 'invalid_position_trail');
  }
  return {...point({x:input[0], y:input[1], z:input[2]}), stance:input[3]};
}

const samePoint = (left, right) => axes.every(axis => left[axis] === right[axis]);
const slotNumber = value => Number.isInteger(value) && value >= 0 && value < PART_SLOT_LIMIT;

function normalizeAction(body) {
  if (typeof body.requestId !== 'string' || !REQUEST_ID.test(body.requestId)) throw new RequestError(400, 'invalid_request_id');
  if (isInventoryAction(body.type)) {
    return inventoryInput(body, {type:body.type, ...(body.eye !== undefined && {eye:readEye(body.eye)})});
  }
  if (!actions.has(body.type)) throw new RequestError(400, 'unknown_action');
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw new RequestError(400, 'invalid_revision');
  const input = { type: body.type, ...point(body, true), expectedRevision: body.expectedRevision };
  if (body.eye !== undefined) input.eye = readEye(body.eye);
  if (vehiclePlacements.has(body.type)) {
    if (body.creativeItem !== vehiclePlacements.get(body.type)) throw new RequestError(400,'unknown_cell_type');
    input.creativeItem = body.creativeItem;
  } else if (body.type === 'place_frame' || body.type === 'frame_item') {
    if (body.type === 'place_frame' && ![CREATIVE_FRAME_KEY,CREATIVE_INVISIBLE_FRAME_KEY].includes(body.creativeItem) ||
        body.creativeItem !== undefined && !/^creative:\d{1,5}:\d{1,5}$/.test(body.creativeItem)) {
      throw new RequestError(400,'unknown_cell_type');
    }
    if (body.creativeItem !== undefined) input.creativeItem = body.creativeItem;
    if (body.type === 'frame_item' && body.cell !== undefined) {
      if (typeof body.cell !== 'string' || !/^legacy:\d{1,4}:\d{1,2}$/.test(body.cell)) throw new RequestError(400,'invalid_cell');
      input.cell = body.cell;
    }
  } else if (body.creativeItem !== undefined) {
    const sign = body.type === 'place' && body.creativeItem === signItemKey;
    if (!sign && (!['place','place_part'].includes(body.type) || typeof body.creativeItem !== 'string' ||
        !/^creative:(?:750|753|768):\d{1,5}$/.test(body.creativeItem))) throw new RequestError(400, 'unknown_cell_type');
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
  if (liquidActions.has(body.type)) {
    if (!input.hit) throw new RequestError(400, 'invalid_coordinates');
    if (body.type === 'place_liquid') {
      if (typeof body.cell !== 'string' || body.cell.length > 128 || !liquidKind(body.cell)) throw new RequestError(400, 'invalid_cell');
      input.cell = body.cell;
      if (body.creative === true) input.creative = true;
    }
  }
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
  return containerActions.has(body.type) ? containerInput(body,input) : input;
}

function signObject(position, lines, original) {
  const text = Object.fromEntries(lines.map((line, index) => [`Text${index + 1}`, line]));
  return {type:'Sign', position, key:`tile:${position.join(':')}`, data:{...original?.data, ...text}};
}

export function newCreativeObject(key, position, input, item) {
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
  creativeItems = new Map(), playerSize = () => 'normal',
  survival, survivalChanged, persistPositions = false,
} = {}) {
  const positions = new Map();
  const flightPreferences = new Map();
  const movementChannel = createMovementChannel(player=>({
    position:playerAt(player), stance:stanceFor(player), seat:publicSeat(player),
  }));
  const eyes = new Map();
  const spectators = new Set();
  const seats = new Map();
  const actionBudgets=new Map();
  const globalActionBudget={tokens:actionRate.totalBurst,at:clock()};
  let nextReceiptCleanup=0;
  let occupiedDetectors = new Map();
  const mechanics = modules ?? registerMechanics(base, store, geometry);
  const [sx, sy, sz] = base.manifest.spawn;
  const spawn = Object.freeze({ x: sx, y: sy, z: sz });
  const {minY,maxY} = base.manifest.bounds;
  const maximumFallSpeed = Math.sqrt(2 * WORLD_GRAVITY * (maxY + 1 - minY));
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
  for (const id of [8,9,10,11]) for (let meta=0;meta<16;meta++) catalog.add(blockKey(id,meta));
  catalog.add(FAKE_WATER);
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
      ...(edit.parts && {parts: edit.parts}), ...(edit.voxels && {voxels: edit.voxels}), ...(edit.fluid && {fluid: edit.fluid}) };
    const original = base.getCell(x, y, z);
    return { x, y, z, cell: original.key === 'air' ? null : original.key, object: original.object, revision: 0 };
  }

  function cellView(current) {
    const {cell, object, voxels, fluid} = current;
    return {key: cell, object, parts: current.parts ?? base.manifest.compositions?.[cell]?.parts, voxels, fluid};
  }

  function publicChange(change, object = change.object) {
    const parts = change.parts ?? (base.manifest.chunkPalettes ? base.manifest.compositions?.[change.cell]?.parts : undefined);
    return {...change, ...(parts && {parts}), object:displayObject(object)};
  }

  const cellAt = (x, y, z) => {
    const current = getCurrent(x, y, z);
    return current.cell === null ? null : cellView(current);
  };
  const physical = physics(base, geometry, cellAt, models);
  const inventory = createInventory(store, creativeBlocks, creativeItems);
  const containers=createContainers({store,inventory,getCell:getCurrent,getOriginalCell:base.getCell,creativeBlocks,creativeItems});
  const drops = createDroppedItems({base, store, clock, collides:physical.collides, visible:physical.visiblePoint,
    liquidAt:(x,y,z)=>fluidAt(cellAt,x,y,z,models),
    currentAt:(x,y,z,kind)=>fluidCurrent(cellAt,x,y,z,kind)});
  const fluids = createFluidSimulation({read:getCurrent, clock, model:models, shape:geometry.shapeFor,
    collision:geometry.collisionFor ?? geometry.shapeFor,
    topSupports:(x,y,z)=>faceSupports(x,y,z,1,.35),
    canWrite:(x,y,z)=>base.inBounds(x,y,z) && (!base.hasPlayableChunk || base.hasPlayableChunk(x>>4,z>>4)) &&
      !reserved(x,y,z) && !spawnProtected(x,y,z) && !seatsAt(x,y,z) &&
      (allowRemoval || base.getCell(x,y,z).key === 'air')});
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
      const body = rider ? bodyAtSeat(rider.player,{}) : {halfWidth:.3,height:.44};
      return bodyWithinMap(feet,body) && !physical.collides(feet,body,ignored);
    },
  });
  const boats = createBoats({base,store,clock,cellAt:getCurrent,canMove(entity,rider) {
    const [x,y,z] = entity.position;
    const yaw = boatHeading(entity), cos = Math.cos(yaw), sin = Math.sin(yaw);
    const anchor = boatSeat(entity);
    const body = rider ? bodyAtSeat(rider.player,anchor) : {halfWidth:.3,height:.56};
    if (!bodyWithinMap(anchor,body) || rider && physical.collides(anchor,body)) return false;
    return [[0,0],[-.31,-.43],[-.31,.43],[.31,-.43],[.31,.43]].every(([side,end]) => {
      const sample = {x:x + side*cos + end*sin,y:y-.12,z:z - side*sin + end*cos};
      return base.inBounds(Math.floor(sample.x),Math.floor(sample.y),Math.floor(sample.z)) &&
        !physical.collides(sample,.56);
    });
  }});

  function initializePosition(player) {
    if (positions.has(player)) return;
    let position = spawn;
    let stance = 'stand';
    const saved = persistPositions && store.getState('movement',player,'pos');
    if (saved?.version === 1 && saved.value?.world === base.hash && isPlayerStance(saved.value.stance)) {
      const candidate = saved.value.position;
      const body = bodyFor(player,saved.value.stance);
      if (candidate && [candidate.x,candidate.y,candidate.z].every(Number.isFinite) &&
          bodyWithinMap(candidate,body) && !physical.collides(candidate,body)) {
        position = candidate;
        stance = saved.value.stance;
      }
    }
    positions.set(player,{position,stance,updated:clock(),budget:1});
  }

  function playerAt(player) {
    if (persistPositions) initializePosition(player);
    return positions.get(player)?.position ?? spawn;
  }

  const stanceFor = player => positions.get(player)?.stance ?? 'stand';
  const bodyFor = (player, stance = stanceFor(player)) => playerBody(playerSize(player), stance);
  const bodyAtSeat = (player, anchor) => anchor.bed ? bodyFor(player,'crawl') :
    {halfWidth:.3, height:Math.min(bodyFor(player,'stand').height,SEATED_HEIGHT)};

  function flightPreference(player) {
    if (!flightPreferences.has(player)) {
      flightPreferences.set(player,store.getState('movement',player,'flight')?.value ?? {enabled:false});
    }
    return flightPreferences.get(player);
  }

  function writeFlight(player, preference) {
    store.putState('movement',player,'flight',1,preference);
    flightPreferences.set(player,preference);
  }

  function forceFlight(player, enabled) {
    const previous=flightPreference(player);
    if (previous.enabled!==enabled) writeFlight(player,{...previous,enabled});
  }

  function setFlight(player,deviceId,{enabled,sequence}) {
    if (typeof enabled!=='boolean' || !Number.isSafeInteger(sequence) || sequence<1) {
      throw new RequestError(400,'invalid_flight');
    }
    const previous=flightPreference(player);
    if (previous.deviceId===deviceId && sequence<=previous.sequence) return previous.enabled;
    if (enabled && (publicSeat(player) || survival?.dead(player))) throw new RequestError(409,'flight_unavailable');
    writeFlight(player,{enabled,deviceId,sequence});
    return enabled;
  }

  function playerSight(player,eye=eyes.get(player)) {
    const position = playerAt(player);
    if (eye) {
      const origin = [position.x,position.y + eye[1],position.z];
      const target = [origin[0] + eye[0],origin[1],origin[2] + eye[2]];
      if (physical.visiblePoint([target[0],target[1] + .02,target[2]],target) &&
          physical.visiblePoint(origin,target)) return {x:target[0],y:position.y,z:target[2],eye:eye[1]};
    }
    const seat = publicSeat(player);
    if (seat && !seat.bed) return {...position, eye:SEATED_EYE};
    const stance = seat?.bed ? 'crawl' : stanceFor(player);
    return stance === 'stand' ? position : {...position, eye:bodyFor(player,stance).height * .85};
  }

  function movePlayer(player, position, stance = 'stand') {
    const now = clock();
    positions.set(player, {position, stance, updated:now, seen:now, budget:1});
    movementChannel.invalidate(player);
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
    const armor = inventory.read(player).equipment;
    const equipment = armor?.some(Boolean) ? armor : undefined;
    if (spectators.has(player)) return {...pose, equipment, spectator:true, stance:'stand'};
    const seat = publicSeat(player);
    if (!seat) return {...pose, equipment, stance:stanceFor(player), ...(pose?.motion === 'sit' && {motion:'idle'})};
    return {...pose, equipment, yaw:seat.yaw, lookYaw:pose?.yaw ?? seat.yaw, pitch:pose?.pitch ?? 0, motion:'sit', groundSeat:seat.kind === 'ground',
      stance:seat.bed ? 'crawl' : 'stand', boost:false};
  }

  function leaveSeat(player) {
    const seat = seats.get(player);
    if (!seat) return;
    if (seat.anchor.kind === 'ground') {
      const position = playerAt(player);
      const stance = ['stand','crouch','crawl'].find(name => {
        const body = bodyFor(player,name);
        return bodyWithinMap(position,body) && !physical.collides(position,body);
      });
      if (stance) {
        releaseSeat(player);
        movePlayer(player,position,stance);
        return position;
      }
    }
    const body = bodyFor(player,'stand');
    const standable = point => bodyWithinMap(point,body) && !physical.collides(point,body);
    const prior = seat.previous;
    const {x, y, z, yaw} = seat.anchor;
    const offsets = [[-Math.round(Math.sin(yaw)), -Math.round(Math.cos(yaw))], [1, 0], [-1, 0], [0, 1], [0, -1]];
    const nearby = offsets.flatMap(([dx, dz]) => [y, y + .5, y + 1].map(level =>
      ({x:x + dx, y:level, z:z + dz})));
    const stillNearby = !seat.ridden || Math.hypot(prior.x - x,prior.y - y,prior.z - z) < 2;
    const shore = seat.anchor.kind === 'boat' ? boatLanding(seat.anchor,body) : null;
    const position = shore ?? [...(stillNearby ? [prior] : []),...nearby,{x,y,z}].find(standable) ?? spawn;
    releaseSeat(player);
    movePlayer(player, position);
    return position;
  }

  function boatLanding({x,y,z},body) {
    const candidates = [];
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const distance = dx*dx + dz*dz;
      if (distance && distance <= 5) candidates.push({dx,dz,distance});
    }
    candidates.sort((a,b) => a.distance-b.distance);
    for (const {dx,dz} of candidates) {
      const stand = physical.standAbove({x:x+dx,y:y-.18,z:z+dz},y+1.12,body);
      if (!stand || !bodyWithinMap(stand,body)) continue;
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
    if (physical.collides(position, bodyAtSeat(player,anchor), blocks)) throw new RequestError(409, 'seat_blocked');
    forceFlight(player,false);
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

  function supportedGroundSeat(position,body) {
    return physical.supported(position,body) && !movementMedium(cellAt,position.x,position.y,position.z,models);
  }

  function setGroundSeat(player, previous, existing, ground, pose) {
    if (!ground || existing) {
      const position = !ground && existing?.kind === 'ground' ? leaveSeat(player) : previous;
      return {seat:publicSeat(player),position,stance:stanceFor(player)};
    }
    const anchor = {...previous,yaw:pose.yaw,kind:'ground'};
    const body = bodyAtSeat(player,anchor);
    if (!bodyWithinMap(previous,body)) throw new RequestError(403,'outside_playable_area');
    if (physical.collides(previous,body)) throw new RequestError(409,'seat_blocked');
    if (!supportedGroundSeat(previous,body)) throw new RequestError(409,'seat_requires_ground');
    return {...takeSeat(player,previous,anchor,[]),stance:'stand'};
  }

  function sit(player, target, pose, ground) {
    if (pose?.eye) eyes.set(player,pose.eye);
    else eyes.delete(player);
    if (spectators.has(player)) throw new RequestError(403, 'spectator_action');
    const previous = playerAt(player);
    const existing = publicSeat(player);
    if (ground !== undefined) return setGroundSeat(player,previous,existing,ground,pose);
    if (existing || !target) {
      const position = target ? previous : leaveSeat(player) ?? previous;
      return {seat:publicSeat(player), position};
    }
    const address = point(target, true);
    const hit = point(target.hit);
    const {x, y, z} = address;
    if (!base.inBounds(x, y, z) || base.hasPlayableChunk && !base.hasPlayableChunk(x>>4,z>>4)) {
      throw new RequestError(403, 'outside_playable_area');
    }
    if (target.entity !== undefined) return sitInVehicle(player,previous,pose,address,hit,target.entity);
    const current = getCurrent(x, y, z);
    const profile = seatFor(cellView(current), models, pose.yaw,
      (dx, dy, dz) => cellView(getCurrent(x + dx, y + dy, z + dz)));
    if (!profile) throw new RequestError(409, 'not_a_seat');
    if (!physical.targetAtHit(playerSight(player), x, y, z, hit)) throw new RequestError(403, 'outside_reach');
    const other = profile.bed ? bedMate(current, address, getCurrent) : null;
    const blocks = other ? [address, other] : [address];
    if (blocks.some(block => seatsAt(block.x, block.y, block.z))) throw new RequestError(409, 'seat_taken');
    const anchor = {x:x + .5, y:y + profile.height, z:z + .5, yaw:profile.yaw};
    if (profile.bed) {
      anchor.bed = true;
      if (other) { anchor.x += (other.x-x) / 2; anchor.z += (other.z-z) / 2; }
    }
    return takeSeat(player, previous, anchor, blocks);
  }

  function activePositions(player, position) {
    const now = clock();
    const withBody = (id, feet) => {
      const seat = publicSeat(id);
      return {...feet, body:feet.body ?? (seat ? bodyAtSeat(id,seat) : bodyFor(id))};
    };
    const active = player ? [withBody(player,position ?? playerAt(player))] : [];
    for (const [id, entry] of positions) {
      if (id !== player && !spectators.has(id) && now - (entry.seen ?? entry.updated) < MAX_ACTIVE_IDLE_MS) active.push(withBody(id,entry.position));
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
      ...(fields.position && {position:active[0]}),
      player,
      now: clock(),
      playerPosition: position,
      activePositions: active,
      getCell: getCurrent,
      readState: (owner, key) => store.getState(module.id, owner, key),
      ownerAt: ({x,y,z,moveOwner}) => moveOwner ?? store.getEditOwner(x,y,z),
      pistonDestination: ({x,y,z}) => base.inBounds(x,y,z) && !reserved(x,y,z) &&
        !spawnProtected(x,y,z) && !seatsAt(x,y,z) && !frames.hasMountAt(x,y,z) && !getCurrent(x,y,z).fluid,
      pistonMovable: cell => !cell.fluid && !reserved(cell.x,cell.y,cell.z) && !spawnProtected(cell.x,cell.y,cell.z) &&
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
    for (const {moveOwner,preserveParts,...cell} of plan.cells ?? []) {
      const { x, y, z } = cell;
      const reservedCell = module.reserved?.(x, y, z);
      const previous = reservedCell ? null : store.getEdit(x,y,z);
      const keepLiquid = cell.fluid === undefined && previous?.fluid && cell.cell !== null && blockState(previous)[0] === blockState(cell)[0];
      const change = {...cell,revision, ...(keepLiquid && {fluid:previous.fluid})};
      changes.push(change);
      if (reservedCell) continue;
      const placed = change.cell !== null && (placement?.key === cellAddress(x, y, z) ||
        placement?.keys?.has(cellAddress(x, y, z)));
      const owner = moveOwner ?? (placed ? placement.player : null);
      store.writeEdit(change, originalAt(x, y, z), owner, keepLiquid || preserveParts ? store.getMicroParts(x,y,z) : null);
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

  function writeCell(player, previous, cell, object, companion, adjusted = [], fluid) {
    const {x,y,z} = previous;
    const change = { x, y, z, cell, object, ...(fluid && {fluid}) };
    const replaced = companion ? [change, companion] : [change];
    const changed = [...replaced, ...adjusted];
    for (const item of changed) {
      checkAdjacentCollisions(player, item, {key:item.cell ?? 'air', object:item.object,
        parts:base.manifest.compositions?.[item.cell]?.parts});
    }
    const placement = cell === null ? undefined : {keys:new Set(replaced.map(item => cellAddress(item.x, item.y, item.z))), player};
    const effects = cell === null ? [breakEffect(previous), ...(companion ? [breakEffect(getCurrent(companion.x,companion.y,companion.z))] : [])] :
      [{type:'sound', sound:'block.place', cell, position:[x,y,z]}];
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
        spawnProtected(second.x, second.y, second.z) ||
        !allowRemoval && base.getCell(second.x, second.y, second.z).key !== 'air') {
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
    if (id === 107 && input.yaw !== undefined) return blockKey(id,(2 - Math.round(input.yaw * 2 / Math.PI)) & 3);
    if ((id === 23 || id === 29 || id === 33) && input.yaw !== undefined) {
      const direction = [3,4,2,5][-Math.round(input.yaw * 2 / Math.PI) & 3];
      const pitch = input.pitch ?? 0;
      return blockKey(id,id === 23 || Math.abs(pitch) < Math.PI / 3 ? direction : Number(pitch < 0));
    }
    const button = Boolean(buttonDuration(id));
    const torch = id === 50 || id === 75 || id === 76 || id >= 3909 && id <= 3924;
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
    const fromItem = input.creativeItem === signItemKey;
    const orient = fromItem || input.creative || input.yaw !== undefined;
    if (orient && face === 0 || fromItem && face === undefined) throw new RequestError(409, 'invalid_sign_face');
    if (face === -1 || (!against && hit)) throw new RequestError(403, 'outside_reach');
    if (fromItem && !faceSupports(against.x,against.y,against.z,face,.35)) throw new RequestError(409,'missing_support');
    const standing = input.yaw === undefined ? blockState(input.cell)[1] : -Math.round(input.yaw * 8 / Math.PI) & 15;
    const cell = !orient ? input.cell : face === 1 ? blockKey(63, standing) : face >= 2 ? blockKey(68, face) : input.cell;
    const position = [x, y, z];
    const copied = input.creative || fromItem ? null : clipboardFor(player, input.cell);
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

  function breakCompanion(current) {
    const {x, y, z} = current;
    const [id, meta] = blockState(current);
    let mate;
    if (id === 26) mate = bedMate(current, current, getCurrent);
    else if (id === 64 || id === 71) {
      const other = getCurrent(x, y + (meta & 8 ? -1 : 1), z);
      const [otherId, otherMeta] = blockState(other);
      if (id === otherId && Boolean(meta & 8) !== Boolean(otherMeta & 8)) mate = other;
    } else if (id === 34 && allowRemoval) {
      const side = signalSides[meta & 7];
      if (side) {
        const stem = getCurrent(x - side[0],y - side[1],z - side[2]);
        if (samePoint(pistonHead(stem,getCurrent) ?? {},current)) mate = stem;
      }
    }
    if (!mate || reserved(mate.x,mate.y,mate.z)) return undefined;
    const mateOwner = store.getEditOwner(mate.x, mate.y, mate.z);
    if (allowRemoval ? id !== 34 && mateOwner !== store.getEditOwner(x,y,z) :
        !mateOwner || base.getCell(mate.x, mate.y, mate.z).key !== 'air') return undefined;
    if (seatsAt(mate.x, mate.y, mate.z)) throw new RequestError(409, 'seat_taken');
    if (mate.fluid) throw new RequestError(409, 'drain_liquid_first');
    return {x:mate.x, y:mate.y, z:mate.z, cell:null, object:null};
  }

  function breakEffect({x,y,z,cell}, material, voxelMaterial, boxes) {
    return {type:'break', sound:'block.break', cell, position:[x,y,z], material, voxelMaterial, boxes};
  }

  function writeMicroParts(current, ownedParts, placed, voxels = current.voxels, removed = []) {
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
    const effects = placed ? [{type:'sound', sound:'block.place', cell, position:[x,y,z], material:placed.material}] : removed;
    return {worldRevision: revision, changes: [publicChange(change)], effects};
  }

  function microParts(current) {
    const {x, y, z} = current;
    const owner = store.getEditOwner(x, y, z);
    return store.getMicroParts(x, y, z) ?? (cellView(current).parts ?? []).map(part => ({...publicMicroPart(part), owner}));
  }

  function removeMicroblocks(player, input, current) {
    const {x, y, z, hit} = input;
    if (reserved(x, y, z) || !allowRemoval && spawnProtected(x, y, z)) throw new RequestError(403, 'protected_cell');
    if (!physical.targetAtHit(playerSight(player), x, y, z, hit, true)) throw new RequestError(403, 'outside_reach');
    const parts = microParts(current);
    const remaining = allowRemoval ? [] : parts.filter(part => !part.owner);
    const clearVoxels = current.voxels && (allowRemoval || store.getEditOwner(x, y, z));
    if (remaining.length === parts.length && !clearVoxels) throw new RequestError(403, 'part_not_owned');
    const effects = parts.filter(part => allowRemoval || part.owner).map(part => breakEffect(current,part.material,undefined,coverBoxes([part])));
    if (clearVoxels) effects.push(breakEffect(current,undefined,current.voxels.materials[0]));
    return writeMicroParts(current, remaining, null, clearVoxels ? null : current.voxels,effects);
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

    if (reserved(x, y, z) || (type !== 'remove_part' || !allowRemoval) && spawnProtected(x, y, z)) {
      throw new RequestError(403, 'protected_cell');
    }
    const original = base.getCell(x, y, z).key;
    if (!isMultipart && !current.voxels && current.cell !== null || !allowRemoval && original !== 'air' &&
        (!isMultipart || !isMicroblockCell({key: original, parts: base.manifest.compositions?.[original]?.parts}))) {
      throw new RequestError(409, 'incompatible_part');
    }
    const parts = view.parts ?? [];
    // Copies placed by the older whole-cell API inherit their proven owner on the first part edit.
    const owned = microParts(current);

    if (type === 'remove_part') {
      const part = owned.find(({slot}) => slot === input.partSlot);
      if (!part) throw new RequestError(409, 'part_missing');
      if (!allowRemoval && !part.owner) throw new RequestError(403, 'part_not_owned');
      if (!physical.visiblePart(position, x, y, z, part.slot, hit)) throw new RequestError(403, 'outside_reach');
      const next = microblockRemoval(parts, part.slot, {
        mayReshape: slot => owned.some(remaining => remaining.slot === slot && remaining.owner),
      });
      if (!next || partBoxesOverlapVoxels(next.boxes, current.voxels)) throw new RequestError(409, 'incompatible_part');
      if (next.reshaped && playerOverlaps(x, y, z, {key: microblockKey, parts: next.parts}, player)) {
        throw new RequestError(409, 'occupied');
      }
      const boxes = coverBoxes(parts).filter(box => box.partSlot === part.slot);
      return writeMicroParts(current, owned.filter(({slot}) => slot !== part.slot),null,current.voxels,
        [breakEffect(current,part.material,undefined,boxes)]);
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
      const copied = input.creativeItem ? item?.part && {part:item.part, pattern:item.part.pattern} : clipboardFor(player);
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

  function checkVoxelEditable({x, y, z, cell}, removing = false) {
    if (reserved(x, y, z) || !(allowRemoval && removing) && spawnProtected(x, y, z)) {
      throw new RequestError(403, 'protected_cell');
    }
    if (allowRemoval) return;
    const original = base.getCell(x, y, z).key;
    if ((original !== 'air' && !isMicroblockCell({key:original, parts:base.manifest.compositions?.[original]?.parts})) ||
        (cell !== null && !store.getEditOwner(x, y, z))) {
      throw new RequestError(403, 'voxel_not_owned');
    }
  }

  function writeVoxels(player, current, voxels, material, removed) {
    const {x, y, z} = current;
    const parts = cellView(current).parts;
    const cell = parts?.length ? microblockKey : voxels ? voxelKey : null;
    checkAdjacentCollisions(player, current, {key: cell ?? 'air', voxels, parts});
    const change = {x, y, z, cell, object: null, ...(voxels && {voxels})};
    const owner = store.getEditOwner(x,y,z) ?? (material ? player : null);
    const placement = voxels && owner ? {key: cellAddress(x,y,z), player:owner} : undefined;
    const effects = material ? [{type: 'sound', sound: 'block.place', cell: voxelKey,
      position: [x, y, z], voxelMaterial: material}] : [removed];
    if (parts?.length) {
      const owned = microParts(current);
      if (!voxels) return writeMicroParts(current, owned, null, null,effects);
      const revision = store.nextRevision();
      const combined = {...change, parts, revision};
      store.writeEdit(combined, originalAt(x, y, z), owner, owned);
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

    if (type === 'remove_voxel') checkVoxelEditable(current,true);
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
    const brush = voxelRemovalBrush(current.voxels, voxel, size);
    return writeVoxels(player,current,writeVoxelBrush(voxels,brush,null),null,breakEffect(current,undefined,material,[brush.box]));
  }

  function editLiquid(player, input, current) {
    const {x, y, z, type, hit} = input;
    if (reserved(x, y, z) || spawnProtected(x, y, z)) throw new RequestError(403, 'protected_cell');
    const target = physical.targetAtHit(playerSight(player), x, y, z, hit, true);
    if (!target) throw new RequestError(403, 'outside_reach');
    if (type === 'scoop_liquid') {
      const existing=fluidState(current);
      if (!allowRemoval && !existing?.logged && base.getCell(x,y,z).key !== 'air') {
        throw new RequestError(403,'protected_cell');
      }
      const state=inventory.read(player);
      if (state.slots[state.selected]?.key !== bucketKeys.empty || !existing || existing.falling || existing.level) {
        throw new RequestError(409,'liquid_missing');
      }
      const key=bucketKeys[existing.kind];
      const items=inventory.replaceSelectedOne(player,key);
      const result=existing.logged ? editLiquid(player,{...input,type:'remove_liquid'},current) :
        writeCell(player,current,null,null);
      return {...result,inventory:items,effects:[{type:'sound',sound:'liquid.splash',position:[x,y,z],volume:.4}]};
    }
    if (type === 'copy_liquid') {
      if (!target.liquid) throw new RequestError(409, 'liquid_missing');
      const cell = liquidCell(target.liquid);
      store.putClipboard(player, {cell, object:null});
      return {worldRevision:store.worldRevision(), changes:[], effects:[], cell};
    }

    let fluid;
    if (type === 'place_liquid') {
      const kind = liquidKind(input.cell);
      if (input.cell === FAKE_WATER) throw new RequestError(409,'incompatible_liquid');
      if (!(input.creative ? creativeBlocks.has(input.cell) : catalog.has(input.cell) || store.getClipboard(player)?.cell === input.cell)) {
        throw new RequestError(400, 'unknown_cell_type');
      }
      if (current.fluid) throw new RequestError(409, 'drain_liquid_first');
      const neighbors = (dx, dy, dz) => cellView(getCurrent(x + dx, y + dy, z + dz));
      if (!canLogLiquid(cellView(current), neighbors, models)) throw new RequestError(409, 'incompatible_liquid');
      fluid = kind;
    } else if (!current.fluid) {
      throw new RequestError(409, 'liquid_missing');
    }

    const revision = store.nextRevision();
    const change = {...current, revision};
    delete change.fluid;
    if (fluid) change.fluid = fluid;
    // Keep the drained revision tied to its original host during a later map rebase.
    store.writeEdit({...change, fluid:fluid ?? 'dry'}, originalAt(x, y, z),
      store.getEditOwner(x, y, z), store.getMicroParts(x, y, z));
    return {worldRevision:revision, changes:[publicChange(change)], effects:fluid ?
      [{type:'sound', sound:'block.place', cell:liquidCell(fluid), position:[x,y,z]}] : []};
  }

  function execute(player, input, transport) {
    const { x, y, z, type } = input;
    if (isInventoryAction(type)) {
      const output = {worldRevision:store.worldRevision(), changes:[], effects:[]};
      if (type === 'drop_item') {
        const taken = inventory.take(player,input);
        transport.drop = drops.drop(taken.stack,playerAt(player),playerSight(player),input.yaw);
        return {...output, inventory:taken.inventory, droppedItem:transport.drop.key};
      }
      if (type === 'pickup_item') {
        const item = drops.nearest(playerAt(player),playerSight(player));
        if (!item) return {...output, inventory:inventory.read(player)};
        const state = inventory.put(player,{...item.stack,count:1});
        transport.drop = drops.pick(item);
        transport.removedDrop = !transport.drop && item.key;
        return {...output, inventory:state, pickedItem:item.key};
      }
      return {...output, inventory:inventory.edit(player,input)};
    }
    if (!base.inBounds(x, y, z) || base.hasPlayableChunk && !base.hasPlayableChunk(x>>4,z>>4)) {
      throw new RequestError(403, 'outside_playable_area');
    }
    if (frameActions.has(type)) {
      let stack;
      if (type === 'frame_item') {
        stack = heldStack(input.cell,input.creativeItem,player);
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
    if (containerActions.has(type)) {
      if (!physical.visible(playerSight(player),x,y,z,input.hit)) throw new RequestError(403,'outside_reach');
      const plan=containers.prepare(player,current,input);
      return {...writePlan({},plan),...containers.response(player,input)};
    }
    if (input.expectedRevision !== current.revision) {
      throw new RequestError(409, 'stale_cell', {current:publicChange(current), worldRevision:store.worldRevision()});
    }
    if (type === 'place_frame') {
      const frame = creativeItems.get(input.creativeItem);
      if (frame?.kind !== 'item-frame') throw new RequestError(400,'unknown_cell_type');
      return frames.place(input,playerSight(player),frame.invisible);
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
    if (liquidActions.has(type)) return editLiquid(player, input, current);
    const lockedLiquid = current.voxels || current.parts || isMicroblockCell(cellView(current));
    if (current.fluid && dryOnlyActions.has(type) && (type !== 'remove' || lockedLiquid)) {
      throw new RequestError(409, 'drain_liquid_first');
    }
    if (partActions.has(type)) return editMicroParts(player, input, current);
    if (voxelActions.has(type)) return editVoxels(player, input, current);
    if (type === 'remove_microblocks') return removeMicroblocks(player, input, current);
    if (type === 'place') {
      if (reserved(x, y, z) || spawnProtected(x, y, z)) throw new RequestError(403, 'protected_cell');
      const item = input.creativeItem && creativeItems.get(input.creativeItem);
      const signItem = input.creativeItem === signItemKey && input.cell === signPlacementCell;
      const allowed = signItem || (input.creativeItem ? item && !item.part && item.blockKey === input.cell :
        input.creative ? creativeBlocks.has(input.cell) : catalog.has(input.cell));
      if (!allowed || input.cell === 'air' || input.cell === voxelKey) {
        throw new RequestError(400, 'unknown_cell_type');
      }
      if (input.turns && !geometry.isSofa?.(input.cell)) throw new RequestError(400, 'invalid_heading');
      if (!allowRemoval && (input.cell === microblockKey ||
          isMicroblockCell({key: input.cell, parts: base.manifest.compositions?.[input.cell]?.parts}))) {
        throw new RequestError(409, 'part_required');
      }
      const neighbors = (dx, dy, dz) => cellView(getCurrent(x + dx, y + dy, z + dz));
      const fluid = liquidKind(current.cell);
      const intoLiquid = fluid && current.cell !== FAKE_WATER && (allowRemoval || store.getEditOwner(x, y, z) && base.getCell(x,y,z).key === 'air')
        && canLogLiquid(input.cell, neighbors, models);
      if (current.cell !== null && !intoLiquid) throw new RequestError(409, 'occupied');
      if (!allowRemoval && base.getCell(x, y, z).key !== 'air') throw new RequestError(403, 'protected_cell');
      if (intoLiquid ? !physical.targetAtHit(playerSight(player), x, y, z, input.hit, true)
        : !placementAnchor(player, input)) throw new RequestError(403, 'outside_reach');
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
      const [actualId] = blockState(actual.cell);
      const isGroundSprite = geometry.shapeFor?.(actual.cell,neighbors).some(box=>box.kind === 'cross');
      const plant = plantBlock.ground.includes(actualId) || plantBlock.aquatic.includes(actualId) || isGroundSprite && actualId > 255;
      const floor = faceSupports(x,y-1,z,1,.35);
      const supportiveAnchor = input.against && signalSides.findIndex(offset => axes.every((axis,i)=>
        input[axis] - input.against[axis] === offset[i]));
      const backedLiquid = floor || allowRemoval && supportiveAnchor >= 0 && input.against &&
        faceSupports(input.against.x,input.against.y,input.against.z,supportiveAnchor,.35);
      if (plant && !intoLiquid && !floor && ![8,9,18,60,243,4095].includes(blockState(getCurrent(x,y-1,z))[0]) ||
          ((!allowRemoval && isGroundSprite) || actualId === 51) && !floor || liquidKind(actual.cell) && !backedLiquid) {
        throw new RequestError(409,'missing_support');
      }
      const copied = input.creative ? null : clipboardFor(player, actual.cell);
      const copiedObject = input.creative || item ? newCreativeObject(actual.cell, [x, y, z], input, item) :
        copied?.cell === actual.cell ? withoutContainerContents(actual.cell,copied.object) : null;
      const object = geometry.placementObject
        ? geometry.placementObject(actual.cell, copiedObject, [x, y, z], input.turns)
        : copiedObject ? { ...copiedObject, position: [x, y, z], key: `tile:${x}:${y}:${z}` } : null;
      const parts = base.manifest.compositions?.[actual.cell]?.parts;
      if (!actual.paired && playerOverlaps(x, y, z, {key:actual.cell, object, parts}, player)) throw new RequestError(409, 'occupied');
      return writeCell(player, current, actual.cell, object, actual.companion, [], intoLiquid ? fluid : undefined);
    }

    if (type === 'remove' && reserved(x, y, z)) throw new RequestError(403, 'protected_cell');
    if (type === 'remove' && !allowRemoval && blockState(current)[0] === 34) throw new RequestError(403,'protected_cell');
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
      if ((!allowRemoval && !store.getEditOwner(x, y, z)) || reserved(x, y, z) || spawnProtected(x, y, z)) {
        throw new RequestError(403, 'protected_cell');
      }
      const change = {...current, moveOwner:store.getEditOwner(x,y,z), object:signObject([x, y, z], input.lines, current.object)};
      return writePlan({}, {cells:[change]});
    }
    if (type === 'interact') {
      for (const module of mechanics) {
        const plan = module.prepareInteraction?.(moduleContext(module,player,{x,y,z,current,input,
          stack:heldStack(input.heldCell,input.heldItem,player)}));
        if (plan) return writePlan(module, plan);
      }
      throw new RequestError(409, 'no_interaction');
    }
    if (type === 'copy') {
      if (reserved(x, y, z)) throw new RequestError(403, 'protected_cell');
      const object = current.object?.type === 'WestCellarHatch' ? null :
        withoutContainerContents(current.cell,displayObject(current.object));
      store.putClipboard(player, { cell: current.cell, object });
      return { worldRevision: store.worldRevision(), changes: [], effects: [], cell: current.cell };
    }
    const storedStacks = containers.contents(player,current);
    if (type === 'remove' && current.fluid) {
      const replacement = writeCell(player,current,liquidCell(current.fluid),null);
      transport.containerDrops = drops.prepareScatter(storedStacks,[x,y,z]);
      return {...replacement,effects:[breakEffect(current)]};
    }
    const adjusted = railFor(current) ? updateRailNeighbors(current, null) : [];
    const mate = breakCompanion(current);
    const result = writeCell(player,current,null,null,mate,adjusted);
    transport.containerDrops = drops.prepareScatter(storedStacks,[x,y,z]);
    const existing = frames.removeSupported(x,y,z);
    const remaining = (mate && frames.removeSupported(mate.x,mate.y,mate.z)) ?? existing;
    return remaining === undefined ? result : {...result,frames:remaining};
  }

  function survivalAction(player,input,transport) {
    if (!survival?.enabled || !survival.isGame(player)) {
      const output = execute(player,input,transport);
      if (input.type !== 'copy' && input.type !== 'copy_part' && input.type !== 'copy_liquid') return output;
      return {...output,...inventory.copyToFreeSlot(player,inventory.read(player).selected)};
    }
    const {type,x,y,z}=input;
    if (unlimitedActions.has(type)||type==='drop_item'&&(input.key!==undefined||input.clone)) {
      throw new RequestError(403,'creative_only');
    }
    if (type==='remove_liquid') throw new RequestError(403,'bucket_required');
    if (type==='interact'&&(input.heldCell||input.heldItem)&&blockState(getCurrent(x,y,z))[0]===23) {
      return execute(player,{...input,heldCell:undefined,heldItem:undefined},transport);
    }
    const selected=inventory.selected(player);
    let rule;
    if (type==='remove') {
      const current=getCurrent(x,y,z);
      rule=harvestRule(current,selected,creativeItems.get(selected?.key));
      if (!rule&&current.cell) throw new RequestError(403,'tool_required');
    }
    if (['remove_voxel','remove_part','remove_microblocks'].includes(type)&&
        classifyTool(selected,creativeItems.get(selected?.key)).tool!=='saw') throw new RequestError(403,'tool_required');
    if (itemPlacements.has(type)) {
      const bucket=liquidKind(input.cell);
      const matched=selected&&(input.creativeItem ? selected.key===input.creativeItem :
        type==='place_part' ? selected.part?.slot===input.part?.slot&&selected.part?.material===input.part?.material :
        type==='place_voxel' ? chiselMaterialKey(selected.cell)===input.material :
        bucket ? selected.key===bucketKeys[bucket] : selected.cell===input.cell);
      if (!matched) throw new RequestError(403,'held_item_required');
    }
    const output=execute(player,input,transport);
    if (rule?.drops.length) transport.containerDrops=[...(transport.containerDrops??[]),...drops.prepareScatter(rule.drops,[x,y,z])];
    if (!itemPlacements.has(type)) return output;
    const kind=liquidKind(input.cell);
    const next=kind&&selected.key===bucketKeys[kind] ? inventory.replaceSelectedOne(player,bucketKeys.empty) :
      inventory.take(player,{count:1}).inventory;
    return {...output,inventory:next};
  }

  function craft(player,id) {
    if (survival?.dead(player)) throw new RequestError(409,'player_dead');
    const recipe=basicRecipes.find(entry=>entry.id===id);
    if (!recipe) throw new RequestError(400,'invalid_recipe');
    return store.atomic(()=>{
      const state=inventory.read(player);
      for (const ingredient of recipe.ingredients) {
        let need=ingredient.count;
        for (let slot=0;slot<state.slots.length&&need;slot++) {
          const stack=state.slots[slot];
          if (!stack||(ingredient.key ? stack.key!==ingredient.key : blockState(stack.cell??stack.key)[0]!==ingredient.block)) continue;
          const count=Math.min(need,stack.count);
          need-=count;
          state.slots[slot]=count===stack.count ? null : {...stack,count:stack.count-count};
        }
        if (need) throw new RequestError(409,'missing_ingredients');
      }
      const block=recipe.output.startsWith('legacy:');
      const stack={key:recipe.output,count:recipe.count,...(block&&{cell:recipe.output})};
      if (inventory.insert(state,stack)) throw new RequestError(409,'inventory_full');
      return inventory.replace(player,state);
    });
  }

  function damagePlayer(player,amount) {
    if (!survival?.enabled||!survival.isGame(player)||spectators.has(player)) return;
    const point=playerAt(player),body=bodyFor(player);
    let floor=point.y;
    if (survival.status(player).health<=amount && !physical.supported(point,body)) {
      for (let y=Math.floor(point.y);y>=base.manifest.bounds.minY;y--) {
        const found=physical.standAbove({...point,y},Math.min(point.y,y+1),{height:.3,halfWidth:.23});
        if (found) { floor=found.y; break; }
      }
    }
    const state=survival.damage(player,amount,point,floor);
    if (state) {
      if (state.death) {
        forceFlight(player,false);
        releaseSeat(player);
        movementChannel.invalidate(player);
      }
      survivalChanged?.(player,state);
    }
    return state;
  }

  function clipboardFor(player, cell) {
    const selected = inventory.selected(player);
    if (selected?.copied && (cell ? selected.cell === cell : selected.part)) return selected;
    return store.getClipboard(player);
  }

  function heldStack(cell,itemKey,player) {
    const item = creativeItems.get(itemKey);
    const selected=player && inventory.selected(player);
    const matches=selected && (itemKey ? selected.key===itemKey : selected.cell===cell);
    const tags=matches ? {...selected.legacyNbt,...(selected.nbt!==undefined&&{tag:selected.nbt})} : {};
    if (item) return {...tags,id:item.id,Damage:item.damage ?? item.meta ?? 0,...(item.blockKey && {Block:true})};
    if (matches && /^creative:\d{1,5}:\d{1,5}$/.test(itemKey??'')) {
      const [,id,damage]=itemKey.split(':').map(Number);
      return {...tags,id,Damage:damage};
    }
    const [id,meta] = blockState(cell);
    if (id && !itemKey && catalog.has(cell)) return {...tags,id,Damage:meta,Block:true};
  }

  function chargeAction(player,at) {
    const local=actionBudgets.get(player)??{tokens:actionRate.playerBurst,at};
    function replenish(bucket,rate,capacity) {
      bucket.tokens=Math.min(capacity,bucket.tokens+Math.max(0,at-bucket.at)*rate/1000);
      bucket.at=Math.max(at,bucket.at);
    }
    replenish(local,actionRate.player,actionRate.playerBurst);
    replenish(globalActionBudget,actionRate.total,actionRate.totalBurst);
    if (local.tokens<1||globalActionBudget.tokens<1) throw new RequestError(429,'action_rate_limit',{retryAfter:1});
    local.tokens--;
    globalActionBudget.tokens--;
    actionBudgets.set(player,local);
  }

  function action(player, body) {
    if (survival?.dead(player)) throw new RequestError(409,'player_dead');
    if (spectators.has(player)) throw new RequestError(403, 'spectator_action');
    const input = normalizeAction(body);
    const encoded = JSON.stringify(input);
    const { requestId } = body;
    const at=clock();
    function replay(receipt) {
      if (receipt.input!==encoded) throw new RequestError(409,'request_id_reused');
      return {status:receipt.status,output:receipt.output,replay:true};
    }
    const existing=store.getReceipt(player,requestId,at);
    if (existing) return replay(existing);
    chargeAction(player,at);
    if (input.eye) eyes.set(player,input.eye);
    else eyes.delete(player);
    const transport = {};
    const result = store.atomic(() => {
      const receipt = store.getReceipt(player,requestId,at);
      if (receipt) return replay(receipt);

      let status = 200;
      let output;
      // A rejected action can record a receipt, but may never leave partial writes.
      store.db.exec('SAVEPOINT action');
      try {
        output = survivalAction(player, input, transport);
      } catch (error) {
        store.db.exec('ROLLBACK TO action');
        if (!(error instanceof RequestError)) throw error;
        status = error.status;
        output = { error: error.code, ...error.details };
      }
      store.db.exec('RELEASE action');
      store.putReceipt(player, requestId, encoded, status, output,at);
      return { status, output, replay: false };
    });
    if (!result.replay && result.status === 200) {
      if (result.output.changes.length) refreshMechanicCells();
      carts.accept(transport.placed,result.output.removedMinecart);
      boats.accept(transport.placedBoat,result.output.removedBoat);
      drops.accept(transport.drop,transport.removedDrop);
      for (const drop of transport.containerDrops ?? []) drops.accept(drop);
    }
    return result;
  }

  function bodyWithinMap({x, y, z}, {halfWidth,height} = PLAYER) {
    const bounds = base.manifest.bounds;
    const inBox=x - halfWidth >= bounds.minX && x + halfWidth <= bounds.maxX + 1
      && z - halfWidth >= bounds.minZ && z + halfWidth <= bounds.maxZ + 1
      && y >= bounds.minY && y + height <= bounds.maxY + 1;
    if (!inBox || !base.hasPlayableChunk) return inBox;
    const margin=Math.max(0,halfWidth-.00001);
    return [x-margin,x+margin].every(xx=>[z-margin,z+margin].every(zz=>
      base.hasPlayableChunk(Math.floor(xx/16),Math.floor(zz/16))));
  }

  function teleport(player, body) {
    if (survival?.dead(player)) throw new RequestError(409,'player_dead');
    const target = point(body);
    const dimensions = bodyFor(player,'stand');
    if (!bodyWithinMap(target,dimensions)) throw new RequestError(403, 'outside_playable_area');
    if (base.hasPlayableChunk) {
      const chunk = value => Math.floor(value / 16);
      for (const x of [chunk(target.x - dimensions.halfWidth), chunk(target.x + dimensions.halfWidth - 1e-6)]) {
        for (const z of [chunk(target.z - dimensions.halfWidth), chunk(target.z + dimensions.halfWidth - 1e-6)]) {
          if (!base.hasPlayableChunk(x, z)) throw new RequestError(403, 'outside_playable_area');
        }
      }
    }
    const observing = spectators.has(player);
    if (!observing && physical.collides(target,dimensions)) throw new RequestError(409, 'teleport_blocked');
    const entry = observing ? passivePosition(target) : enterPosition(player, target, playerAt(player),'stand');
    releaseSeat(player);
    movePlayer(player, target);
    survival?.clearFall(player);
    return {...entry, seat:null, stance:'stand'};
  }

  function teleportNear(player, anchorPlayer) {
    const origin=playerAt(anchorPlayer);
    const body=bodyFor(player,'stand');
    const others=activePositions(player).slice(1);
    const clear=position=>bodyWithinMap(position,body) && !physical.collides(position,body) &&
      !others.some(other=>Math.abs(position.x-other.x)<body.halfWidth+other.body.halfWidth &&
        Math.abs(position.z-other.z)<body.halfWidth+other.body.halfWidth &&
        position.y<other.y+other.body.height && position.y+body.height>other.y) &&
      ![.06,body.height-.03].some(height=>{
        const cell=cellAt(Math.floor(position.x),Math.floor(position.y+height),Math.floor(position.z));
        return blockState(cell)[0]===51 || fluidAt(cellAt,position.x,position.y+height,position.z,models);
      });
    const directions=[[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[-1,-1],[1,-1]];
    const flight=[];
    for (const distance of [1.4,2.4]) {
      for (const [dx,dz] of directions) {
        const x=origin.x+dx*distance,z=origin.z+dz*distance;
        for (const [low,high] of [[-.12,.55],[.55,1.3],[-1.5,-.12]]) {
          const position=physical.standAbove({x,y:origin.y+low,z},origin.y+high,body);
          if (position && clear(position)) return teleport(player,position);
        }
        flight.push({x,y:origin.y,z});
      }
    }
    const air=flight.find(clear);
    if (air) {
      const result=teleport(player,air);
      if (!spectators.has(player)) forceFlight(player,true);
      return {...result,flight:true};
    }
    throw new RequestError(409,'teleport_blocked');
  }

  function passivePosition(position) {
    return {position, effects:[], changes:[], worldRevision:store.worldRevision()};
  }

  function setSpectator(player, body) {
    if (typeof body?.enabled !== 'boolean') throw new RequestError(400, 'invalid_spectator');
    const previous = playerAt(player);
    if (spectators.has(player) === body.enabled) {
      return {...passivePosition(previous), seat:publicSeat(player), stance:stanceFor(player), spectator:body.enabled, relocated:false};
    }
    let position = previous;
    let relocated = false;
    if (body.enabled) {
      releaseSeat(player);
      spectators.add(player);
    } else {
      const dimensions = bodyFor(player,'stand');
      if (physical.collides(previous,dimensions)) {
        const highest = base.manifest.bounds.maxY + 1 - dimensions.height;
        const center = {...previous, x:Math.floor(previous.x) + .5, z:Math.floor(previous.z) + .5};
        position = physical.standAbove(previous, highest,dimensions) ?? physical.standAbove(center, highest,dimensions) ?? spawn;
        relocated = !samePoint(position, previous);
      }
      spectators.delete(player);
    }
    movePlayer(player, position);
    return {...passivePosition(position), seat:null, stance:'stand', spectator:body.enabled, relocated};
  }

  function enterPosition(player, position, previous, stance) {
    const results = store.atomic(() => {
      const entries = [];
      for (const module of mechanics) {
        const plan = module.prepareEntry?.(moduleContext(module, player, {position:{...position,body:bodyFor(player,stance)}, previous}));
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
    const seat = publicSeat(player);
    const groundSeat = seat?.kind === 'ground';
    if (survival?.dead(player)) return {...passivePosition(previous),seat:null,stance:stanceFor(player)};
    if (seat && !groundSeat) {
      const stance = seat.bed ? 'crawl' : 'stand';
      if (!samePoint(previous, target)) throw new RequestError(409, 'movement_blocked', {position:previous, seat, stance});
      return {...passivePosition(previous), seat, stance};
    }
    const now = clock();
    const old = positions.get(player);
    const sequenced = body.page !== undefined;
    const flight = body.pose?.motion === 'fly' && stanceFor(player) === 'stand';
    const elapsed = Math.min(sequenced && !groundSeat ? 1.5 : .65, (now - (old?.updated ?? now - 100)) / 1000);
    const limit = sequenced ? RUN_SPEED * 1.5 : POSITION_BATCH_LIMIT + .4;
    const gravityDrop = sequenced && !flight && !groundSeat;
    const dropBudget = gravityDrop ? Math.min(POSITION_FLIGHT_DROP_LIMIT + maximumFallSpeed * 1.5,
      (old?.fallBudget ?? POSITION_FLIGHT_DROP_LIMIT) + elapsed * maximumFallSpeed) : POSITION_FLIGHT_DROP_LIMIT;
    const seatedLimit = .65 * CRAWL_SPEED + .14;
    const budget = groundSeat ? Math.min(seatedLimit,Math.min(sequenced ? seatedLimit : .14,old?.budget ?? 0) + elapsed * CRAWL_SPEED) :
      Math.min(limit, (old?.budget ?? 1) + elapsed * RUN_SPEED);
    const hasTrail = body.trail !== undefined || body.from !== undefined;
    const reject = () => {
      throw new RequestError(409, 'movement_blocked', {position:previous, stance:stanceFor(player), ...(groundSeat && {seat})});
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
        return {...passivePosition(previous), stance:stanceFor(player)};
      }
      if (!samePoint(previous, from) || from.stance !== undefined && from.stance !== stanceFor(player)) reject();
    }

    let distance = 0, drop = 0, from = previous;
    let stance = stanceFor(player);
    const size = playerSize(player);
    let dimensions = groundSeat ? bodyAtSeat(player,seat) : playerBody(size,stance);
    let segmentStart = previous, segment = [];
    const observing = spectators.has(player);
    const validateSegment = () => {
      if (!segment.length || observing) return;
      if (!(hasTrail ? physical.movementTrailAllowed(segmentStart,segment,dimensions) :
        physical.movementAllowed(segmentStart,segment[0],dimensions))) reject();
    };
    for (const step of steps) {
      const nextStance = observing ? 'stand' : step.stance ?? stance;
      if (groundSeat && (nextStance !== 'stand' || Math.abs(step.y - previous.y) > .002 ||
          !supportedGroundSeat(step,dimensions))) reject();
      if (nextStance !== stance) {
        validateSegment();
        segmentStart = from;
        segment = [];
        const next = playerBody(size,nextStance);
        const medium = movementMedium(cellAt,from.x,from.y,from.z,models);
        const valid = nextStance === 'swim' ? medium === 'water' : nextStance === 'stand' ||
          !medium && physical.supported(from,dimensions);
        if (!samePoint(from,step) || physical.collides(from,next) || !valid) reject();
        stance = nextStance;
        dimensions = next;
      }
      const planar = Math.hypot(step.x - from.x, step.z - from.z);
      const vertical = step.y - from.y;
      if (!bodyWithinMap(step,dimensions) || hasTrail && (planar > POSITION_STEP_LIMIT ||
          Math.abs(vertical) > POSITION_VERTICAL_STEP_LIMIT)) reject();
      if (stance === 'crouch' && planar > 0 && vertical <= .02 && physical.supported(from,dimensions) &&
          !physical.supported({...step,y:from.y},dimensions,.5)) reject();
      distance += flightPositionCost(planar,from.y,step.y,flight && nextStance === 'stand');
      drop += Math.max(-vertical, 0);
      if (distance > budget + (groundSeat ? .035 : MOVEMENT_GRACE) ||
          drop > dropBudget + (gravityDrop ? MOVEMENT_GRACE : 0)) reject();
      segment.push(step);
      from = step;
    }
    validateSegment();

    if (groundSeat) {
      Object.assign(seat,target);
      positions.set(player,{position:target,stance,updated:now,seen:now,budget:budget-distance,requestId});
      if (!sequenced) movementChannel.invalidate(player);
      return {...passivePosition(target),seat,stance};
    }
    const entry = observing ? passivePosition(target) : enterPosition(player, target, previous,stance);
    positions.set(player, {position:target, stance, updated:now, seen:now, budget:budget-distance, requestId,
      ...(gravityDrop && {fallBudget:dropBudget-drop})});
    if (!sequenced) movementChannel.invalidate(player);
    if (survival?.enabled&&survival.isGame(player)) {
      const medium=movementMedium(cellAt,target.x,target.y,target.z,models);
      const fall=survival.observe(player,previous,target,{grounded:physical.supported(target,dimensions,.08),
        protectedFall:observing||Boolean(medium)||body.pose?.motion==='fly'});
      if (fall) damagePlayer(player,fall);
    }
    if (!observing) carts.pushAlongPath(previous,steps.map(step => ({...step,body:playerBody(size,step.stance ?? stance)})));
    return {...entry, stance};
  }

  function advance() {
    const now=clock();
    if (now>=nextReceiptCleanup) {
      store.pruneReceipts(now);
      for (const [uid,budget] of actionBudgets) if (now-budget.at>=receiptCleanupInterval) actionBudgets.delete(uid);
      nextReceiptCleanup=now+receiptCleanupInterval;
    }
    const plans = mechanics.flatMap(module => {
      const plan = module.prepareTick?.(moduleContext(module, null, {}));
      return plan ? [[module, plan]] : [];
    });
    const active = new Map(carts.trackCells().filter(point => blockState(getCurrent(...point))[0] === 28)
      .map(point => [cellAddress(...point),point]));
    const detectors = [...active].filter(([key]) => !occupiedDetectors.has(key))
      .map(([,point]) => ({point,occupied:true}));
    detectors.push(...[...occupiedDetectors].filter(([key]) => !active.has(key)).map(([,point]) => ({point,occupied:false})));
    if (!plans.length && !detectors.length && !fluids.ready()) return null;
    let fluidPlan;
    let results;
    try {
      results = store.atomic(() => {
        const written = plans.map(([module,plan]) => writePlan(module,plan));
        if (detectors.length) {
          for (const module of mechanics) {
            const plan = module.prepareCartChange?.(moduleContext(module,null,{detectors}));
            if (plan) written.push(writePlan(module,plan));
          }
        }
        fluidPlan = fluids.advance();
        if (fluidPlan) written.push(writePlan({},fluidPlan));
        return written;
      });
    } catch (error) {
      if (fluidPlan) fluids.retry(fluidPlan);
      throw error;
    }
    if (fluidPlan) for (const {at,cell} of fluidPlan.detached) drops.scatter(cell,at);
    occupiedDetectors = active;
    if (!results.length) return null;
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

  function reconcileProfile(player) {
    if (!positions.has(player)) return;
    const previous = playerAt(player);
    const seat = publicSeat(player);
    const body = seat ? bodyAtSeat(player,seat) : bodyFor(player);
    const observing = spectators.has(player);
    if (bodyWithinMap(previous,body) && (observing || !physical.collides(previous,body,seats.get(player)?.blocks))) return;

    const standing = bodyFor(player,'stand');
    const highest = base.manifest.bounds.maxY + 1 - standing.height;
    let position;
    if (observing) position = {...previous,y:Math.min(previous.y,highest)};
    else if (seat) position = leaveSeat(player);
    else {
      const nearby = {...previous,y:Math.min(previous.y,highest)};
      const center = {x:Math.floor(nearby.x)+.5,y:nearby.y,z:Math.floor(nearby.z)+.5};
      const candidates = [nearby, center,
        ...faceOffsets.filter(([,dy]) => !dy).map(([dx, ,dz]) => ({...center,x:center.x+dx,z:center.z+dz}))];
      for (const candidate of candidates) {
        if (bodyWithinMap(candidate,standing) && !physical.collides(candidate,standing)) {
          position = candidate;
          break;
        }
        const above = physical.standAbove(candidate,Math.min(highest,previous.y+2),standing);
        if (above && bodyWithinMap(above,standing)) { position = above; break; }
      }
    }
    position ??= spawn;
    movePlayer(player,position);
    return {position, stance:'stand', seat:null};
  }

  return {
    action,
    craft,
    damageFromNpc:damagePlayer,
    healFromNpc(player) {
      const state=survival?.enabled&&survival.heal(player);
      if (state) survivalChanged?.(player,state);
    },
    hitPlayer(attacker,defender) {
      if (attacker===defender||survival?.dead(attacker)||spectators.has(attacker)) throw new RequestError(403,'attack_blocked');
      if (!survival?.enabled||!survival.isGame(defender)||survival.dead(defender)||spectators.has(defender)) return;
      const eye=playerSight(attacker),point=playerAt(defender);
      const origin=[eye.x,eye.y+(eye.eye??PLAYER.eye),eye.z];
      const target=[point.x,point.y+bodyFor(defender).height*.6,point.z];
      if (Math.hypot(...target.map((coordinate,index)=>coordinate-origin[index]))>4.2||!physical.visiblePoint(origin,target)) {
        throw new RequestError(403,'outside_reach');
      }
      if (survival.canStrike(attacker)) return damagePlayer(defender,1);
    },
    position,
    movementChannel,
    teleport,
    teleportNear,
    setSpectator,
    advance,
    advanceMinecarts,
    advanceDroppedItems: drops.advance,
    clearDroppedItems: drops.clear,
    droppedItemSnapshot: player => drops.snapshot(playerAt(player)),
    worldEdit:{
      position:playerAt,
      inBounds:({x,y,z})=>base.inBounds(x,y,z) && (!base.hasPlayableChunk || base.hasPlayableChunk(x>>4,z>>4)),
      heldWoodenAxe:player=>inventory.selected(player)?.key.split(':')[1]==='271',
      canSelect:(player,{x,y,z},hit,eye)=>!spectators.has(player) &&
        Boolean(physical.targetAtHit(playerSight(player,readEye(eye)),x,y,z,hit,true)),
      read({x,y,z}) {
        const current=getCurrent(x,y,z);
        const {parts}=cellView(current);
        return {...current,...(parts&&{parts})};
      },
      resolve:key=>catalog.has(key),
      makeObject:(key,{x,y,z})=>newCreativeObject(key,[x,y,z],{}),
      write(player,cells) {
        for (const {x,y,z} of cells) {
          if (reserved(x,y,z) || !allowRemoval&&spawnProtected(x,y,z)) throw new RequestError(403,'protected_cell');
          if (seatsAt(x,y,z)) throw new RequestError(409,'seat_taken');
        }
        const result=store.atomic(()=>{
          const revision=cells.length?store.nextRevision():store.worldRevision();
          const changes=cells.map(cell=>{
            const {x,y,z,parts}=cell;
            const edit={...cell,revision};
            const owned=parts?.map(part=>({...publicMicroPart(part),owner:player})) ?? null;
            store.writeEdit(edit,originalAt(x,y,z),edit.cell===null?null:player,owned,false);
            return publicChange(edit);
          });
          const framesView=frames.removeSupportedMany(cells.filter(cell=>cell.cell===null));
          return {worldRevision:revision,changes,effects:[],...(framesView&&{frames:framesView})};
        });
        if (result.changes.length) refreshMechanicCells();
        return result;
      },
    },
    npcPlayerView:player=>({position:playerAt(player),spectator:spectators.has(player)}),
    prepareNpcLoot(position,stacks) {
      const pending=drops.prepareScatter(stacks,[position.x-.5,position.y,position.z-.5]);
      return ()=>{for (const item of pending) drops.accept(item);};
    },
    npcReach(player,point,height) {
      const eye=playerSight(player);
      const origin=[eye.x,eye.y+(eye.eye??PLAYER.eye),eye.z];
      const target=[point.x,point.y+height,point.z];
      return Math.hypot(...target.map((value,axis)=>value-origin[axis]))<=6 && physical.visiblePoint(origin,target);
    },
    npcWalk(from,target,npc) {
      const {x,y,z}=target;
      if (!base.inBounds(x,y,z) || base.hasPlayableChunk && !base.hasPlayableChunk(x>>4,z>>4)) return;
      const body={halfWidth:Math.min(.54,.26*npc.scale),height:Math.min(3.6,1.38*npc.scale)};
      if (physical.supported(target,body) && physical.movementAllowed(from,target,body)) return target;
      const next=physical.standAbove({x,y:y-1.01,z},y+1.01,body);
      if (next && physical.movementAllowed(from,next,body)) return next;
    },
    npcVisibility(from,to) {
      return physical.visiblePoint([from.x,from.y+.9,from.z],[to.x,to.y+.9,to.z]);
    },
    droppedItemView: player => {
      const {x,y,z} = playerAt(player);
      return cellAddress(x >> 4, y >> 4, z >> 4);
    },
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
    checkpointPositions() {
      if (!persistPositions || !positions.size) return;
      store.atomic(() => {
        for (const [player, {position, stance}] of positions) {
          store.putState('movement',player,'pos',1,{world:base.hash,position,stance:stance ?? 'stand'});
        }
      });
    },
    sit,
    leaveSeat,
    poseFor,
    reconcileProfile,
    setFlight,
    touch(player) {
      const entry = positions.get(player);
      if (entry) entry.seen = clock();
    },
    respawn(player) {
      releaseSeat(player);
      forceFlight(player,false);
      movePlayer(player, spawn);
      survival?.clearFall(player);
      return { position:spawn, seat:null, stance:'stand', effects:[], worldRevision:store.worldRevision() };
    },
    revive(player,death) {
      const body=bodyFor(player,'stand');
      const point={...death.position,y:death.floor};
      const position=bodyWithinMap(point,body)&&physical.supported(point,body)&&!physical.collides(point,body) ? point :
        physical.standAbove({...point,y:point.y-.05},Math.min(base.manifest.bounds.maxY,point.y+12),body)??spawn;
      releaseSeat(player);
      forceFlight(player,false);
      movePlayer(player,position);
      survival.clearFall(player);
      return {...passivePosition(position),seat:null,stance:'stand'};
    },
    conflicts,
    contentHash: base.hash,
    worldRevision: store.worldRevision,
    session(playerId) {
      initializePosition(playerId);
      const ground = publicSeat(playerId);
      if (ground?.kind === 'ground' && !supportedGroundSeat(ground,bodyAtSeat(playerId,ground))) leaveSeat(playerId);
      return {
        playerId, spawn: base.manifest.spawn, position: playerAt(playerId), worldRevision: store.worldRevision(),
        catalogVersion: base.manifest.catalogVersion ?? 1, importVersion: base.manifest.importVersion, contentHash: base.hash,
        mechanics: descriptions(playerId), seat:publicSeat(playerId), spectator:spectators.has(playerId),
        flight:flightPreference(playerId).enabled && !publicSeat(playerId) && !survival?.dead(playerId),
        stance:publicSeat(playerId)?.bed ? 'crawl' : stanceFor(playerId),
        inventory:inventory.read(playerId),
      };
    },
    snapshot(player) {
      return {
        bounds: base.manifest.bounds, spawn: base.manifest.spawn, worldRevision: store.worldRevision(), contentHash: base.hash,
        overrides: [...store.edits().map(edit => publicChange(edit, editObject(edit))),
          ...snapshotCells()],
        frames:frames.snapshot(),
        droppedItems:drops.snapshot(playerAt(player)),
        inventory:inventory.read(player),
        mechanics: descriptions(player),
      };
    },
    didCommit(event) {
      drops.terrainChanged(event.changes);
      fluids.changed(event.changes);
      for (const module of mechanics) module.onCommitted?.(event);
    },
  };
}
