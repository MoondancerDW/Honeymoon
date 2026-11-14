import { performance } from 'node:perf_hooks';
import { displayObject, cellAddress } from './base.mjs';
import { RequestError } from './errors.mjs';
import { registerMechanics } from './mechanics.mjs';
import { PLAYER, physics } from './physics.mjs';
import { guidedMicroblock, isMicroblockCell, isMicroPart, microblockAddition, microblockKey, microblockPattern,
  microblockRemoval, partBoxesOverlapBox, partBoxesOverlapVoxels, PART_SLOT_LIMIT, publicMicroPart } from '../world/microblocks.mjs';
import { chiselMaterialShape, coverBoxes } from '../world/geometry.mjs';
import { POSITION_TRAIL_LIMIT } from '../world/player-body.mjs';
import { bedMate, seatFor, SEATED_EYE, SEATED_HEIGHT } from '../world/seats.mjs';
import { blockKey, blockState, jammyAppliance, relatedBlockStates, signalSides } from '../world/block-interactions.mjs';
import { shapedLampData } from '../world/creative-items.mjs';
import { isChiselMaterial, voxelBox, voxelKey, voxelMaterialAt,
  VOXEL_COUNT, VOXEL_MATERIAL_LIMIT, writeVoxel } from '../world/voxel-chisel.mjs';
import { chiselMaterialKey, chiselPlacementAtHit, chiselSourceVolume, chiselVoxelAtHit } from '../world/chisel-surface.mjs';

const partActions = new Set(['copy_part', 'place_part', 'remove_part']);
const voxelActions = new Set(['copy_voxel', 'place_voxel', 'remove_voxel']);
const actions = new Set(['place', 'remove', 'copy', 'interact', ...partActions, ...voxelActions]);
const axes = ['x', 'y', 'z'];
const faceOffsets = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];
const bedDirections = [[0,1], [-1,0], [0,-1], [1,0]];
const pairedBlocks = new Set([26, 64, 71]);
const MOVEMENT_GRACE = 0.24;
const RUN_SPEED = 9;
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
  if (body.creativeItem !== undefined) {
    if (!['place','place_part'].includes(body.type) || typeof body.creativeItem !== 'string' ||
        !/^creative:(?:750|753|768):\d{1,5}$/.test(body.creativeItem)) throw new RequestError(400, 'unknown_cell_type');
    input.creativeItem = body.creativeItem;
  }
  if (body.hit !== undefined) input.hit = point(body.hit);
  if (body.type === 'interact' && body.yaw !== undefined) {
    if (!Number.isFinite(body.yaw)) throw new RequestError(400, 'invalid_heading');
    input.yaw = body.yaw % (2 * Math.PI);
  }
  if (body.type === 'interact' && body.sneaking !== undefined) {
    if (typeof body.sneaking !== 'boolean') throw new RequestError(400, 'invalid_modifier');
    if (body.sneaking) input.sneaking = true;
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

function newCreativeObject(key, position, input, item) {
  const [id, meta] = blockState(key);
  let type = jammyAppliance(id, meta) ? 'JammyAppliance' : id === 2255 ? 'WeaponCaseTile' : null;
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
  const seats = new Map();
  const mechanics = modules ?? registerMechanics(base, store, geometry);
  const [sx, sy, sz] = base.manifest.spawn;
  const spawn = Object.freeze({ x: sx, y: sy, z: sz });
  const diagnostic = mechanics.find(module => module.id === 'diagnostic');
  const catalog = new Set([...(base.catalog ?? []), ...creativeBlocks]);
  catalog.add('legacy:9:0');
  catalog.add('legacy:11:0');
  for (const item of creativeItems.values()) catalog.add(item.blockKey);
  for (const key of creativeBlocks) {
    const [id] = blockState(key);
    for (const variant of relatedBlockStates(key)) catalog.add(variant);
    if (pairedBlocks.has(id)) for (let meta = 0; meta < 16; meta++) catalog.add(blockKey(id, meta));
  }
  const reserved = (x, y, z) => mechanics.some(module => module.reserved?.(x, y, z));
  const spawnProtected = (x, y, z) => x === Math.floor(sx) && z === Math.floor(sz)
    && y >= Math.floor(sy) && y <= Math.floor(sy + PLAYER.height);
  const originalAt = (x, y, z) => JSON.stringify(base.getCell(x, y, z));
  const conflicts = store.rebase({...base, catalog}, reserved, originalAt);

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

  const physical = physics(base, geometry, (x, y, z) => {
    const current = getCurrent(x, y, z);
    return current.cell === null ? null : cellView(current);
  });

  function playerAt(player) {
    return positions.get(player)?.position ?? spawn;
  }

  function playerSight(player) {
    const position = playerAt(player);
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
    const position = [prior, ...nearby].find(standable) ?? spawn;
    seats.delete(player);
    movePlayer(player, position);
    return position;
  }

  function sit(player, target, pose) {
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
    const current = getCurrent(x, y, z);
    const profile = seatFor(cellView(current), models, pose.yaw,
      (dx, dy, dz) => cellView(getCurrent(x + dx, y + dy, z + dz)));
    if (!profile) throw new RequestError(409, 'not_a_seat');
    if (!physical.targetAtHit(previous, x, y, z, hit)) throw new RequestError(403, 'outside_reach');
    const other = profile.bed ? bedMate(current, address, getCurrent) : null;
    const blocks = other ? [address, other] : [address];
    if (blocks.some(block => seatsAt(block.x, block.y, block.z))) throw new RequestError(409, 'seat_taken');
    const position = {x:x + .5, y:y + profile.height, z:z + .5};
    if (physical.collides(position, SEATED_HEIGHT, blocks)) throw new RequestError(409, 'seat_blocked');
    const anchor = {...position, yaw:profile.yaw};
    seats.set(player, {anchor, blocks, previous});
    movePlayer(player, position);
    return {seat:anchor, position};
  }

  function activePositions(player, position) {
    const now = clock();
    const active = player ? [position ?? playerAt(player)] : [];
    for (const [id, entry] of positions) {
      if (id !== player && now - (entry.seen ?? entry.updated) < MAX_ACTIVE_IDLE_MS) active.push(entry.position);
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
      playerOverlaps: (x, y, z, cell, plannedNeighbor) => active.some(position =>
        physical.overlaps(position, x, y, z, cell, plannedNeighbor)),
    };
  }

  function writePlan(module, plan, placement) {
    const revision = plan.cells?.length ? store.nextRevision() : store.worldRevision();
    const changes = (plan.cells ?? []).map(cell => ({ ...cell, revision }));
    for (const change of changes) {
      const { x, y, z } = change;
      if (module.reserved?.(x, y, z)) continue;
      const owner = change.cell !== null && (placement?.key === cellAddress(x, y, z) ||
        placement?.keys?.has(cellAddress(x, y, z))) ? placement.player : null;
      store.writeEdit(change, originalAt(x, y, z), owner);
    }
    for (const entry of plan.state ?? []) {
      const value = entry.useRevision ? { ...entry.value, revision } : entry.value;
      store.putState(module.id, entry.owner, entry.key, module.version, value);
    }
    return {
      worldRevision: revision,
      changes: changes.map(change => ({ ...change, object: displayObject(change.object) })),
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

  function writeCell(player, {x, y, z}, cell, object, companion) {
    const change = { x, y, z, cell, object };
    const changed = companion ? [change, companion] : [change];
    for (const item of changed) {
      checkAdjacentCollisions(player, item, {key:item.cell ?? 'air', object:item.object,
        parts:base.manifest.compositions?.[item.cell]?.parts});
    }
    const placement = cell === null ? undefined : {keys:new Set(changed.map(item => cellAddress(item.x, item.y, item.z))), player};
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
    const orientation = meta & 3;
    const [dx, dz] = bedDirections[orientation];
    const second = {x:x + (isBed ? dx : 0), y:y + (isBed ? 0 : 1), z:z + (isBed ? dz : 0)};
    if (!base.inBounds(second.x, second.y, second.z) || reserved(second.x, second.y, second.z) ||
        spawnProtected(second.x, second.y, second.z) || base.getCell(second.x, second.y, second.z).key !== 'air') {
      throw new RequestError(403, 'protected_cell');
    }
    if (getCurrent(second.x, second.y, second.z).cell !== null) throw new RequestError(409, 'occupied');
    const cell = blockKey(id, isBed ? orientation : meta & 7);
    const other = blockKey(id, isBed ? orientation | 8 : 8 | (meta & 8 ? meta & 1 : 0));
    const atOther = (ax, ay, az) => x + ax === second.x && y + ay === second.y && z + az === second.z ? other : undefined;
    const atOrigin = (ax, ay, az) => second.x + ax === x && second.y + ay === y && second.z + az === z ? cell : undefined;
    if (playerOverlaps(x, y, z, cell, player, atOther) ||
        playerOverlaps(second.x, second.y, second.z, other, player, atOrigin)) throw new RequestError(409, 'occupied');
    return {cell, companion:{...second, cell:other, object:null}, paired:true};
  }

  function ownedCompanion(player, current) {
    const {x, y, z} = current;
    const [id, meta] = blockState(current);
    let mate;
    if (id === 26) mate = bedMate(current, current, getCurrent);
    else if (id === 64 || id === 71) {
      const other = getCurrent(x, y + (meta & 8 ? -1 : 1), z);
      const [otherId, otherMeta] = blockState(other);
      if (id === otherId && Boolean(meta & 8) !== Boolean(otherMeta & 8)) mate = other;
    }
    if (!mate || store.getEditOwner(mate.x, mate.y, mate.z) !== player ||
        base.getCell(mate.x, mate.y, mate.z).key !== 'air') return undefined;
    if (seatsAt(mate.x, mate.y, mate.z)) throw new RequestError(409, 'seat_taken');
    return {x:mate.x, y:mate.y, z:mate.z, cell:null, object:null};
  }

  function writeMicroParts(current, ownedParts, placed, voxels = current.voxels) {
    const {x, y, z} = current;
    const revision = store.nextRevision();
    const parts = ownedParts.map(publicMicroPart);
    const cell = parts.length ? microblockKey : voxels ? voxelKey : null;
    const change = {x, y, z, cell, object: null, revision, ...(parts.length || !voxels ? {parts} : {}), ...(voxels && {voxels})};
    const owner = voxels ? store.getEditOwner(x, y, z) : null;
    store.writeEdit(change, originalAt(x, y, z), owner, parts.length || !voxels ? ownedParts : null);
    const effects = placed ? [{type: 'sound', sound: 'block.place', cell, position: [x, y, z], material: placed.material}] : [];
    return {worldRevision: revision, changes: [change], effects};
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
    const storedParts = store.getMicroParts(x, y, z);
    const owner = original === 'air' && current.cell !== null ? store.getEditOwner(x, y, z) : null;
    const owned = storedParts ?? parts.map(part => ({...publicMicroPart(part), owner}));

    if (type === 'remove_part') {
      const part = owned.find(({slot}) => slot === input.partSlot);
      if (!part) throw new RequestError(409, 'part_missing');
      if (part.owner !== player) throw new RequestError(403, 'part_not_owned');
      if (!physical.visiblePart(position, x, y, z, part.slot, hit)) throw new RequestError(403, 'outside_reach');
      const next = microblockRemoval(parts, part.slot, {
        mayReshape: slot => owned.some(remaining => remaining.slot === slot && remaining.owner === player),
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

  function checkVoxelOwner(player, {x, y, z, cell}) {
    if (reserved(x, y, z) || spawnProtected(x, y, z)) throw new RequestError(403, 'protected_cell');
    const original = base.getCell(x, y, z).key;
    if ((original !== 'air' && !isMicroblockCell({key:original, parts:base.manifest.compositions?.[original]?.parts})) ||
        (cell !== null && store.getEditOwner(x, y, z) !== player)) {
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
      const revision = store.nextRevision();
      const stored = store.getMicroParts(x, y, z);
      const owner = store.getEditOwner(x, y, z);
      const owned = stored ?? parts.map(part => ({...publicMicroPart(part), owner}));
      const combined = {...change, parts, revision};
      store.writeEdit(combined, originalAt(x, y, z), voxels ? player : null, owned);
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
    const {x, y, z, type, hit, voxel} = input;
    const position = playerSight(player);
    if (type === 'place_voxel') {
      const multipart = isMicroblockCell(cellView(current));
      if (!multipart || current.voxels) checkVoxelOwner(player, current);
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
      if (voxelMaterialAt(current.voxels, voxel)) throw new RequestError(409, 'occupied');
      const materials = current.voxels?.materials;
      if (materials?.length >= VOXEL_MATERIAL_LIMIT && !materials.includes(material)) {
        throw new RequestError(409, 'voxel_material_limit');
      }
      const box = voxelBox(voxel);
      if (multipart && partBoxesOverlapBox(coverBoxes(cellView(current).parts), box)) throw new RequestError(409, 'occupied');
      if (chiselMaterialShape(material).solid && activePositions(player).some(feet => physical.overlapsBox(feet, x, y, z, box))) {
        throw new RequestError(409, 'occupied');
      }
      return writeVoxels(player, current, writeVoxel(current.voxels, voxel, material), material);
    }

    if (type === 'remove_voxel') checkVoxelOwner(player, current);
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
    return writeVoxels(player, current, writeVoxel(voxels, voxel, null));
  }

  function execute(player, input) {
    const { x, y, z, type } = input;
    if (!base.inBounds(x, y, z)) throw new RequestError(403, 'outside_playable_area');
    const current = getCurrent(x, y, z);
    if (input.expectedRevision !== current.revision) {
      throw new RequestError(409, 'stale_cell', { current: { ...current, object: displayObject(current.object) }, worldRevision: store.worldRevision() });
    }
    if (partActions.has(type)) return editMicroParts(player, input, current);
    if (voxelActions.has(type)) return editVoxels(player, input, current);
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
    if (type === 'remove' && seatsAt(x, y, z)) throw new RequestError(409, 'seat_taken');
    if (current.cell === null) throw new RequestError(409, 'empty_cell');
    if ((type === 'remove' || type === 'copy') && current.cell === voxelKey) throw new RequestError(409, 'voxel_required');
    if ((type === 'remove' || type === 'copy') &&
        (current.parts || (!allowRemoval && isMicroblockCell(cellView(current))))) {
      throw new RequestError(409, 'part_required');
    }
    if (type === 'remove' && !allowRemoval) {
      if (store.getEditOwner(x, y, z) !== player || base.getCell(x, y, z).key !== 'air') {
        throw new RequestError(403, 'block_not_owned');
      }
    }
    if (!physical.visible(playerSight(player), x, y, z, input.hit)) throw new RequestError(403, 'outside_reach');
    if (type === 'interact') {
      for (const module of mechanics) {
        const plan = module.prepareInteraction?.(moduleContext(module, player, { x, y, z, current, input }));
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
    return writeCell(player, current, null, null, ownedCompanion(player, current));
  }

  function action(player, body) {
    const input = normalizeAction(body);
    const encoded = JSON.stringify(input);
    const { requestId } = body;
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
        output = execute(player, input);
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
    if (!result.replay && result.status === 200 && result.output.changes.length) refreshMechanicCells();
    return result;
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
    const budget = Math.min(1.5, (old?.budget ?? 1) + elapsed * RUN_SPEED);
    const bounds = base.manifest.bounds;
    const hasTrail = body.trail !== undefined || body.from !== undefined;
    const inBounds = ({ x, y, z }) => x - PLAYER.halfWidth >= bounds.minX && x + PLAYER.halfWidth <= bounds.maxX + 1
      && z - PLAYER.halfWidth >= bounds.minZ && z + PLAYER.halfWidth <= bounds.maxZ + 1
      && y >= bounds.minY && y + PLAYER.height <= bounds.maxY + 1;
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
      if (!inBounds(step) || hasTrail && (planar > .12 || Math.abs(vertical) > .55)) reject();
      distance += Math.hypot(planar, Math.max(vertical, 0));
      drop += Math.max(-vertical, 0);
      if (distance > budget + MOVEMENT_GRACE || drop > 6) reject();
      from = step;
    }
    if (!(hasTrail ? physical.movementTrailAllowed(previous, steps) : physical.movementAllowed(previous, target))) reject();

    const results = store.atomic(() => {
      const entries = [];
      for (const module of mechanics) {
        const plan = module.prepareEntry?.(moduleContext(module, player, { position: target, previous }));
        if (plan) entries.push(writePlan(module, plan));
      }
      return entries;
    });
    const effects = results.flatMap(result => result.effects);
    const changes = results.flatMap(result => result.changes);
    if (changes.length) refreshMechanicCells();
    positions.set(player, { position: target, updated: now, budget: budget - distance, requestId });
    return { position: target, effects, changes, worldRevision: store.worldRevision() };
  }

  function advance() {
    const plans = mechanics.flatMap(module => {
      const plan = module.prepareTick?.(moduleContext(module, null, {}));
      return plan ? [[module, plan]] : [];
    });
    if (!plans.length) return null;
    const results = store.atomic(() => plans.map(([module, plan]) => writePlan(module, plan)));
    const changes = results.flatMap(result => result.changes);
    if (changes.length) refreshMechanicCells();
    return {changes, effects: results.flatMap(result => result.effects), worldRevision: store.worldRevision()};
  }

  const descriptions = player => diagnostic?.describe(player) ?? null;

  return {
    action,
    position,
    advance,
    sit,
    leaveSeat,
    poseFor,
    touch(player) {
      const entry = positions.get(player);
      if (entry) entry.seen = clock();
    },
    respawn(player) {
      seats.delete(player);
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
        mechanics: descriptions(playerId), seat:publicSeat(playerId),
      };
    },
    snapshot(player) {
      return {
        bounds: base.manifest.bounds, spawn: base.manifest.spawn, worldRevision: store.worldRevision(), contentHash: base.hash,
        overrides: [...store.edits().map(edit => ({ ...edit, object: displayObject(editObject(edit)) })),
          ...snapshotCells()],
        mechanics: descriptions(player),
      };
    },
    didCommit(event) {
      for (const module of mechanics) module.onCommitted?.(event);
    },
  };
}
