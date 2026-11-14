import {Display} from './display.mjs';
import {Movement, EYE, overlapsPlacement, pick} from './movement.mjs';
import {World, json} from './world-data.mjs';
import {WorldAudio} from './audio.mjs';
import {PlayerProfile} from './player-profile.mjs';
import {createSocialHud} from './social-hud.mjs';
import {blockState} from '../world/block-interactions.mjs';
import {seatFor, SEATED_EYE} from '../world/seats.mjs';
import {extractedModel, isJammyConnectableSeat, placementModelObject} from '../world/extracted-models.mjs';
import {jammyBenchState} from '../world/jammy-benches.mjs';
import {POSITION_TRAIL_LIMIT} from '../world/player-body.mjs';
import {isMicroblockCell, microblockPlacement, partBoxesOverlapBox} from '../world/microblocks.mjs';
import {coverBoxes} from '../world/geometry.mjs';
import {isChiselMaterial, voxelBox, voxelKey, voxelMaterialAt, voxelPlacementAtHit, VOXEL_MATERIAL_LIMIT} from '../world/voxel-chisel.mjs';

const element = id => document.getElementById(id);
const game = element('game');
const entry = element('entry');
const loading = element('loading');
const button = element('play');
const surface = element('scene');
const toast = element('toast');
const selectionStatus = element('selected');
const coordinateStatus = element('coords');
const clearSelection = element('clear-selection');
const microHint = element('micro-hint');
const touchRotate = element('touch-rotate');
const chiselHint = element('chisel-hint');
const touchChisel = element('touch-chisel');
const keys = new Set();
const touchMode = matchMedia('(pointer: coarse)').matches;
const heading = {yaw: 0, pitch: -.045};
const stick = {x: 0, z: 0};
let world, view, movement, position, selection, clipboard, worldRevision = 0;
let heldPart = null, partRotation = 0, placement = null, placementKey = '';
let heldSofa = null, sofaTurns = 0;
let chiseling = false, chiselMaterial = null;
let heldVersion = 0;
let selectionInputs, selectionRevision = 0;
const positionInterval = 130;
const positionMetrics = {requests: 0, corrections: 0, errors: 0};
const positionTrail = [];
let playing = false, jump = false, lastFrame = 0, nextPositionSync = 0, timer;
let flying = false;
let seat = null, seatPending = false, seatEpoch = 0;
let sync = null, pendingPosition = null, confirmedPosition, retryCount = 0, acting = false, resetting = false;
let metrics = {started: performance.now(), playable: 0, chunksLoaded: 0, visualChunksLoaded: 0, lastEdit: 0};
let feed;
let entered = false, presenceDirty = true, presenceRequest = null, lastSentPose, nextPresence = 0;
let horizontalSpeed = 0;
let nextClockUpdate = 0;
const audio = new WorldAudio();
const profile = new PlayerProfile({nickname:element('nickname'), skin:element('pony-skin'), status:element('skin-status'),
  clear:element('clear-skin'), label:element('player-name')}, notice);
const social = createSocialHud({post, notice,
  pause() { keys.clear(); jump = false; stick.x = stick.z = 0; if (document.pointerLockElement) document.exitPointerLock(); },
  resume() {
    if (touchMode || !view) return;
    const canvas = view.renderer.domElement;
    if (document.pointerLockElement === canvas) return;
    try { Promise.resolve(canvas.requestPointerLock()).catch(() => setPlaying(false)); }
    catch { setPlaying(false); }
  },
});

if (touchMode) {
  game.classList.add('touch');
  element('entry-help').textContent = 'Стик — ходьба · Проведите по экрану, чтобы осмотреться';
}

function notice(message) {
  clearTimeout(timer);
  const label = document.createElement('span');
  label.textContent = message;
  toast.replaceChildren(label);
  timer = setTimeout(() => toast.replaceChildren(), 3800);
}

const messages = {
  occupied: 'Здесь уже есть блок или игрок', stale_cell: 'Ячейка изменилась. Повторите действие.',
  out_of_reach: 'Цель вне досягаемости', not_visible: 'Блок закрыт', outside_bounds: 'Граница района',
  reserved: 'Это часть контрольной механики', nothing_to_copy: 'Сначала скопируйте блок',
  empty_cell: 'В ячейке нет блока', cannot_interact: 'С этим объектом нельзя взаимодействовать',
  movement_blocked: 'Позиция скорректирована сервером', outside_reach: 'Цель вне досягаемости',
  block_not_owned: 'Можно ломать только свои блоки', part_not_owned: 'Можно ломать только свои детали',
  part_missing: 'Деталь уже убрана', invalid_part: 'Эта форма или материал недоступны',
  part_required: 'Наведите прицел на отдельную деталь',
  incompatible_part: 'Деталь здесь не помещается',
  voxel_required: 'Нажмите V, чтобы взять резец',
  voxel_not_owned: 'Резцом можно менять только свои блоки',
  invalid_voxel: 'Наведите прицел на нужную часть блока',
  invalid_material: 'Материал для резца берётся с полного блока или с части, созданной резцом',
  voxel_material_limit: 'В кубе уже слишком много разных материалов',
  outside_playable_area: 'Граница района', protected_cell: 'Это часть контрольной механики',
  no_interaction: 'С этим объектом нельзя взаимодействовать',
  not_a_seat: 'На этот блок нельзя сесть', seat_taken: 'Место уже занято',
  seat_blocked: 'Над сиденьем недостаточно места',
  invalid_nickname: 'Проверьте ник · от 2 до 24 символов',
  invalid_skin: 'Скин должен быть изображением PNG поддерживаемого размера',
  invalid_skin_size: 'Размер PNG должен быть 64×32, 64×64, 128×64 или 256×128',
  skin_too_large: 'Размер скина превышает 192 КБ'
};

async function post(path, payload, signal) {
  const response = await fetch('/api/' + path, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload), signal
  });
  const body = await response.json();
  return {ok: response.ok, body};
}

function effects(data) {
  audio.effects(data.effects ?? [], world);
  for (const effect of data.effects || []) {
    if (effect.message) notice(effect.message);
  }
}

function changes(list = [], revision = 0) {
  const changed = [];
  for (const change of list) {
    if (world.setOverride(change)) changed.push(change);
  }
  if (changed.length) selectionRevision++;
  view.remeshLighting(world.updateLighting());
  for (const change of changed) {
    if (world.hasChunk(change.x, change.z)) view.remesh(change.x, change.y, change.z, change.revision);
  }
  worldRevision = Math.max(worldRevision, revision);
}

async function refresh() {
  const snapshot = await json('/api/world');
  if (snapshot.contentHash && snapshot.contentHash !== world.manifest.contentHash) {
    location.reload();
    return;
  }
  changes(snapshot.overrides, snapshot.worldRevision);
}

function stream() {
  feed = new EventSource('/api/events?since=' + worldRevision + '&presence=1&social=1');
  feed.addEventListener('open', () => { presenceDirty = true; });
  feed.addEventListener('presence', event => {
    const {players, selfOnline} = JSON.parse(event.data);
    view.players.replace(players);
    social.roster(players, selfOnline && profile.confirmed);
  });
  feed.addEventListener('presence-motion', event => view.players.update(JSON.parse(event.data).players));
  feed.addEventListener('chat-history', event => social.history(JSON.parse(event.data).entries));
  feed.addEventListener('chat', event => social.message(JSON.parse(event.data)));
  feed.addEventListener('world-time', event => {
    const time = JSON.parse(event.data);
    view.setWorldTime(time);
    social.clockState(time);
  });
  feed.addEventListener('commit', event => {
    const data = JSON.parse(event.data);
    changes(data.changes, data.worldRevision);
    audio.effects(data.effects ?? [], world);
  });
  feed.addEventListener('reset', () => refresh().catch(error => notice(error.message)));
  feed.addEventListener('ready', event => {
    const {contentHash} = JSON.parse(event.data);
    if (contentHash && contentHash !== world.manifest.contentHash) location.reload();
  });
}

function playerPose() {
  const motion = seat ? 'sit' : !playing ? 'idle' : flying ? 'fly' : movement.medium === 'water' ? 'swim' :
    !movement.grounded && !movement.medium ? 'air' : horizontalSpeed > .15 ? 'walk' : 'idle';
  return {yaw: Math.atan2(Math.sin(heading.yaw), Math.cos(heading.yaw)), pitch:heading.pitch, motion,
    seq:Math.round(performance.timeOrigin + performance.now())};
}

function sendPresence(now) {
  if (!entered || presenceRequest || now < nextPresence || feed?.readyState !== EventSource.OPEN) return;
  const pose = playerPose();
  const changed = !lastSentPose || pose.motion !== lastSentPose.motion ||
    Math.abs(pose.yaw - lastSentPose.yaw) > .03 || Math.abs(pose.pitch - lastSentPose.pitch) > .03;
  if (!presenceDirty && !changed) return;
  nextPresence = now + positionInterval;
  presenceDirty = false;
  const epoch = seatEpoch;
  presenceRequest = post('presence', pose, AbortSignal.timeout(3000)).then(({ok, body}) => {
    if (ok && (!lastSentPose || pose.seq >= lastSentPose.seq)) {
      lastSentPose = pose;
      if (epoch === seatEpoch && !acting && !resetting && Boolean(body.seat) !== Boolean(seat)) setSeat(body.seat, body.position);
    }
    else presenceDirty = true;
  }).catch(() => { presenceDirty = true; }).finally(() => { presenceRequest = null; });
}

function updateCamera() {
  view.camera.rotation.order = 'YXZ';
  view.camera.rotation.set(heading.pitch, heading.yaw, 0, 'YXZ');
  view.camera.position.set(position.x, position.y + (seat ? SEATED_EYE : EYE), position.z);
  view.camera.translateZ(.1);
  view.camera.updateMatrixWorld();
}

function look(dx, dy, sensitivity = .0023) {
  heading.yaw -= dx * sensitivity;
  if (seat) {
    const difference = heading.yaw - seat.yaw;
    const offset = Math.atan2(Math.sin(difference), Math.cos(difference));
    heading.yaw = seat.yaw + Math.min(1.35, Math.max(-1.35, offset));
  }
  heading.pitch = Math.min(1.55, Math.max(-1.55, heading.pitch - dy * sensitivity));
}

function setPlaying(active) {
  playing = active;
  if (active && !entered && !button.disabled) {
    entered = true;
    presenceDirty = true;
  }
  audio.setPlaying(active);
  game.classList.toggle('playing', active);
  entry.hidden = active;
  if (!active) {
    keys.clear();
    jump = false;
    button.textContent = 'Продолжить';
    loading.textContent = 'Пауза';
  }
}

function setFlight(active) {
  flying = active;
  movement.fall = 0;
  movement.grounded = false;
  jump = false;
  element('flight-status').hidden = !active;
}

const positionTuple = ({x, y, z}) => [x, y, z];

function recordPosition(feet) {
  const sample = positionTuple(feet);
  const previous = positionTrail.at(-1) ?? confirmedPosition;
  if (sample.some((value, axis) => value !== previous[axis])) positionTrail.push(sample);
}

function setAuthoritativePosition(feet) {
  Object.assign(position, feet);
  confirmedPosition = positionTuple(feet);
  positionTrail.length = 0;
  pendingPosition = null;
  movement.fall = 0;
  movement.grounded = false;
}

function setSeat(next, feet) {
  seatEpoch++;
  seat = next;
  setAuthoritativePosition(feet);
  game.classList.toggle('seated', Boolean(seat));
  element('seat-status').hidden = !seat;
  if (seat) {
    setFlight(false);
    heading.yaw = seat.yaw;
    heading.pitch = -.045;
  }
  presenceDirty = true;
}

async function rightClick(buildInstead = false) {
  if (!playing || acting || resetting) return;
  if (!seat && (buildInstead || !seatFor(selection?.cell, world.models))) return action('place');
  const {x, y, z, hit} = selection ?? {};
  const target = seat ? undefined : {x, y, z, hit};
  acting = true;
  seatPending = true;
  seatEpoch++;
  try {
    if (!await flushPosition()) return;
    const {ok, body} = await post('seat', {...playerPose(), target}, AbortSignal.timeout(4000));
    if (ok) setSeat(body.seat, body.position);
    else notice(messages[body.error] ?? body.error);
  } catch {
    presenceDirty = true;
    notice('Связь с сервером прервалась');
  } finally {
    seatPending = false;
    acting = false;
  }
}

function positionPacket(lastStep) {
  const trail = [];
  let distance = 0;
  let from = confirmedPosition;
  // Keep a delayed batch inside the server's wall-clock movement budget.
  for (const step of positionTrail) {
    distance += Math.hypot(step[0] - from[0], Math.max(0, step[1] - from[1]), step[2] - from[2]);
    if (trail.length && (trail.length >= POSITION_TRAIL_LIMIT || distance > 1.05)) break;
    trail.push(step);
    from = step;
    if (step === lastStep) break;
  }
  const [x, y, z] = from;
  return {x, y, z, from: confirmedPosition, trail, ...(entered && {pose:playerPose()}),
    requestId: [...crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(16).padStart(8, '0')).join('')};
}

function syncPosition(lastStep) {
  if (sync || !positionTrail.length || performance.now() < nextPositionSync) return sync;
  const payload = pendingPosition ??= positionPacket(lastStep);
  nextPositionSync = performance.now() + positionInterval;
  positionMetrics.requests++;
  sync = post('position', payload, AbortSignal.timeout(3000)).then(({ok, body}) => {
    if (ok) {
      confirmedPosition = positionTuple(body.position);
      positionTrail.splice(0, payload.trail.length);
      pendingPosition = null;
      if (payload.pose && (!lastSentPose || payload.pose.seq >= lastSentPose.seq)) lastSentPose = payload.pose;
    } else if (body.position) {
      positionMetrics.corrections++;
      if (body.seat) setSeat(body.seat, body.position);
      else setAuthoritativePosition(body.position);
    } else {
      throw new Error(body.error || 'Position sync failed');
    }
    retryCount = 0;
    effects(body);
  }).catch(() => {
    positionMetrics.errors++;
    retryCount++;
    nextPositionSync = performance.now() + Math.min(2000, positionInterval * retryCount);
  }).finally(() => { sync = null; });
  return sync;
}

async function flushPosition() {
  const lastStep = positionTrail.at(-1);
  const corrections = positionMetrics.corrections;
  while (lastStep && positionTrail.includes(lastStep)) {
    const before = positionMetrics.errors;
    if (!sync && performance.now() < nextPositionSync) {
      await new Promise(resolve => setTimeout(resolve, nextPositionSync - performance.now()));
    }
    await syncPosition(lastStep);
    if (positionMetrics.errors !== before) throw new Error('Position sync failed');
  }
  return positionMetrics.corrections === corrections;
}

const getKey = cell => typeof cell === 'string' ? cell : cell?.key;
const labelFor = key => {
  if (!key) return '';
  if (key === voxelKey) return 'Резной блок';
  if (key === 'game:switch') return 'Переключатель';
  if (key === 'game:door') return 'Дверь';
  const id = Number(key.split(':')[1]);
  const sofas = world.models?.jammy?.sofaIds;
  if (sofas && id === sofas.chair) return 'Кресло';
  if (sofas && (id === sofas.left || id === sofas.right || id === sofas.center || id === sofas.corner)) return 'Секция дивана';
  if (jammyBenchState(world.models?.jammy, key)) return 'Секция скамьи';
  return world.manifest.legacyRegistry?.[id]?.name || ({1:'Камень',2:'Дёрн',3:'Земля',4:'Булыжник',
    5:'Доски',17:'Бревно',20:'Стекло',35:'Шерсть',44:'Плита',63:'Табличка',68:'Табличка'})[id] ||
    (key.startsWith('cover:') ? 'Микроблоки' : 'Блок ' + id);
};

function partLabel({slot, sourceSlot = slot, shape}) {
  slot = sourceSlot;
  if (slot < 6) return [3, 4, 5, 10, 11, 12, 13].includes(shape) ? 'Полая панель' : 'Пластина';
  if (slot < 14) return 'Уголок';
  if (slot < 26) return 'Ребро';
  return 'Стойка';
}

function updatePlacement(target) {
  if (!(chiseling ? chiselMaterial && (target?.voxel !== undefined || target?.partSlot !== undefined) :
      (heldPart || heldSofa) && target)) {
    placement = null;
    placementKey = '';
    return;
  }
  if (!chiseling && heldSofa) {
    const [dx, dy, dz] = target.offset;
    const x = target.x + dx, y = target.y + dy, z = target.z + dz;
    const key = `sofa,${x},${y},${z},${sofaTurns},${selectionRevision},${metrics.chunksLoaded}`;
    if (key !== placementKey) {
      placementKey = key;
      const object = placementModelObject(world.models, clipboard, heldSofa.object, [x, y, z], sofaTurns);
      const model = extractedModel(world.models, {key: clipboard, object},
        (ox, oy, oz) => world.cellAt(x + ox, y + oy, z + oz));
      placement = model && {x, y, z, boxes: model.collision, surfaces: model.surfaces,
        unavailable: !world.hasChunk(x, z) || world.cellAt(x, y, z)};
    }
    if (placement) placement.blocked = Boolean(placement.unavailable) || overlapsPlacement(position, placement);
    return;
  }
  const {x, y, z, hit, partSlot, offset: [dx, dy, dz]} = target;
  const adjacentRevision = world.revisionAt(x+dx,y+dy,z+dz);
  const adjacentLoaded = world.hasChunk(x+dx,z+dz);
  const revision = world.revisionAt(x,y,z);
  if (chiseling) {
    const key = `voxel,${x},${y},${z},${target.voxel},${partSlot},${target.offset},${revision},${adjacentRevision},${adjacentLoaded},` +
      `${Math.floor(hit.x * 8)},${Math.floor(hit.y * 8)},${Math.floor(hit.z * 8)}`;
    if (key !== placementKey) {
      placementKey = key;
      placement = previewVoxel(target);
    }
  } else {
    const key = [x,y,z,partSlot,dx,dy,dz,Math.floor(hit.x * 8),Math.floor(hit.y * 8),Math.floor(hit.z * 8),
      revision,adjacentRevision,adjacentLoaded,partRotation].join(',');
    if (key !== placementKey) {
      placementKey = key;
      placement = microblockPlacement(world, target, heldPart, {rotation:partRotation});
    }
  }
  if (placement) placement.blocked = Boolean(placement.unavailable) || overlapsPlacement(position, placement);
}

function previewVoxel(target) {
  const next = voxelPlacementAtHit(target, target.hit, target.offset, target.partSlot === undefined ? target.cell.voxels : undefined);
  if (!next) return null;
  const {x,y,z,voxel} = next;
  const {minX,maxX,minY,maxY,minZ,maxZ} = world.manifest.bounds;
  if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ || !world.hasChunk(x,z)) return null;
  const old = world.cellAt(x,y,z);
  const box = voxelBox(voxel);
  let unavailable = null;
  if (old && (!old.voxels && !isMicroblockCell(old) || voxelMaterialAt(old.voxels, voxel) ||
      old.parts && partBoxesOverlapBox(coverBoxes(old.parts), box))) unavailable = 'occupied';
  else if (old?.voxels?.materials.length >= VOXEL_MATERIAL_LIMIT && !old.voxels.materials.includes(chiselMaterial)) {
    unavailable = 'voxel_material_limit';
  }
  const against = {x:target.x,y:target.y,z:target.z};
  if (target.partSlot !== undefined) against.partSlot = target.partSlot;
  return {...next, boxes:[box], against, unavailable};
}

function cyclePlacement() {
  if (chiseling || acting) return;
  if (heldPart) partRotation++;
  if (heldSofa) sofaTurns = (sofaTurns + 1) & 3;
}

function updatePlacementHints() {
  microHint.hidden = !(heldPart || heldSofa) || chiseling;
  touchRotate.hidden = microHint.hidden;
  touchRotate.setAttribute('aria-label', heldSofa ? 'Повернуть сиденье' : 'Сменить позицию детали');
  microHint.textContent = heldSofa ? 'ПКМ — поставить сиденье · R — повернуть' :
    'ПКМ — поставить деталь · R — выбрать позицию · E — действие';
}

function setHeldPart(part) {
  heldPart = part;
  partRotation = 0;
  placementKey = '';
  updatePlacementHints();
}

function clearHeld() {
  heldVersion++;
  clipboard = null;
  heldSofa = null;
  sofaTurns = 0;
  chiselMaterial = null;
  placement = null;
  setHeldPart(null);
  notice('Выбор сброшен');
}

function toggleChisel() {
  chiseling = !chiseling;
  if (chiseling && !chiselMaterial && isChiselMaterial(clipboard)) chiselMaterial = clipboard;
  placementKey = '';
  placement = null;
  chiselHint.hidden = !chiseling;
  updatePlacementHints();
  touchChisel.setAttribute('aria-pressed', String(chiseling));
}

function updateSelection() {
  if (!playing) {
    selection = null;
    selectionInputs = null;
    return;
  }
  const {x,y,z} = position;
  const {yaw,pitch} = heading;
  const stamp = [x,y,z,yaw,pitch,selectionRevision,metrics.chunksLoaded,chiseling,seat];
  if (selectionInputs && stamp.every((value, index) => value === selectionInputs[index])) return;
  selectionInputs = stamp;
  const cp = Math.cos(pitch);
  selection = pick(world, [x,y + (seat ? SEATED_EYE : EYE),z], [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp], chiseling);
}

async function action(type, sneaking = false) {
  if (!selection || acting || resetting || !playing) return;
  const target = selection;
  const selectedVersion = heldVersion;
  const cell = getKey(target.cell);
  let pendingPlacement;
  if (chiseling && type !== 'interact') {
    if (target.voxel === undefined && !(type === 'place' && target.partSlot !== undefined)) {
      notice(messages.invalid_material);
      return;
    }
    if (type === 'place' && !chiselMaterial) { notice('Сначала скопируйте материал клавишей Q'); return; }
    type += '_voxel';
  } else {
    if (target.part && type === 'copy') type = 'copy_part';
    if (target.part && type === 'remove') type = 'remove_part';
    if (heldPart && type === 'place') type = 'place_part';
  }
  const request = {requestId: [...crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(16).padStart(8, '0')).join(''), type, x: target.x, y: target.y, z: target.z, hit: target.hit};
  if (type === 'copy_part' || type === 'remove_part') request.partSlot = target.partSlot;
  if (type === 'copy_voxel' || type === 'remove_voxel') request.voxel = target.voxel;
  if (type === 'interact') {
    request.yaw = heading.yaw;
    if (sneaking) request.sneaking = true;
  }
  if (type === 'place') {
    if (!clipboard) { notice(messages.nothing_to_copy); return; }
    request.against = {x: target.x, y: target.y, z: target.z};
    request.x += target.offset[0];
    request.y += target.offset[1];
    request.z += target.offset[2];
    request.cell = clipboard;
    if (heldSofa) {
      updatePlacement(target);
      if (!placement || placement.blocked) { notice(messages.occupied); return; }
      request.turns = sofaTurns;
      pendingPlacement = placement;
    }
  }
  if (type === 'place_part') {
    updatePlacement(target);
    if (!placement || placement.blocked) { notice(messages[placement ? 'occupied' : 'incompatible_part']); return; }
    const {x, y, z, part, against, orientation, boxes} = placement;
    Object.assign(request, {x, y, z, part, against, orientation});
    pendingPlacement = {x, y, z, boxes};
  }
  if (type === 'place_voxel') {
    updatePlacement(target);
    if (!placement || placement.blocked) { notice(messages[placement?.unavailable ?? 'occupied']); return; }
    const {x,y,z,voxel,against,boxes} = placement;
    Object.assign(request, {x,y,z,voxel,against,material:chiselMaterial});
    pendingPlacement = {x,y,z,boxes};
  }
  request.expectedRevision = world.revisionAt(request.x, request.y, request.z);
  const started = performance.now();
  acting = true;
  try {
    if (pendingPlacement) movement.pendingPlacement = pendingPlacement;
    if (!await flushPosition()) { notice(messages.movement_blocked); return; }
    if (pendingPlacement && overlapsPlacement(position, pendingPlacement)) { notice(messages.occupied); return; }
    let result;
    try { result = await post('action', request); }
    catch { result = await post('action', request); }
    if (!result.ok) {
      if (result.body.current) changes([result.body.current], result.body.worldRevision);
      notice(messages[result.body.error] || result.body.error || 'Действие отклонено');
      return;
    }
    if (type === 'copy' && selectedVersion === heldVersion) {
      clipboard = result.body.cell || cell;
      heldSofa = isJammyConnectableSeat(world.models?.jammy, clipboard) ? {object: target.cell?.object} : null;
      sofaTurns = 0;
      setHeldPart(null);
      notice('Скопировано · ' + labelFor(clipboard));
    }
    if (type === 'copy_part' && selectedVersion === heldVersion) {
      clipboard = null;
      heldSofa = null;
      setHeldPart({...result.body.part, pattern:result.body.pattern});
      notice('Скопировано · ' + partLabel(heldPart));
    }
    if (type === 'copy_voxel' && selectedVersion === heldVersion) {
      chiselMaterial = result.body.material;
      placementKey = '';
      notice('Материал резца · ' + labelFor(chiselMaterial));
    }
    changes(result.body.changes, result.body.worldRevision);
    effects(result.body);
    metrics.lastEdit = performance.now() - started;
  } catch (error) {
    notice('Связь с сервером прервалась');
    console.error(error);
  } finally {
    if (pendingPlacement) movement.pendingPlacement = null;
    acting = false;
  }
}

function tick(now) {
  const dt = Math.min(.05, (now - (lastFrame || now)) / 1000);
  lastFrame = now;
  if (playing && !seat && !seatPending) {
    const startX = position.x, startZ = position.z;
    const forward = Number(keys.has('KeyW') || keys.has('ArrowUp')) - Number(keys.has('KeyS') || keys.has('ArrowDown')) - stick.z;
    const strafe = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft')) + stick.x;
    const descending = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const vertical = flying ? Number(keys.has('Space')) - Number(descending) : 0;
    const speed = (flying ? 5.1 : keys.has('ShiftLeft') ? 5.1 : 3.8) / Math.max(1, Math.hypot(forward, strafe, vertical));
    const sin = Math.sin(heading.yaw), cos = Math.cos(heading.yaw);
    if (!resetting && positionTrail.length < POSITION_TRAIL_LIMIT * 4) {
      const dx = (-sin * forward + cos * strafe) * speed;
      const dz = (-cos * forward - sin * strafe) * speed;
      if (flying) movement.fly(position, dx, vertical * speed, dz, dt, recordPosition);
      else movement.update(position, dx, dz, jump, dt,
        {rise: jump || keys.has('Space'), descend: descending, recordStep: recordPosition});
    }
    horizontalSpeed = dt > 0 ? Math.hypot(position.x - startX, position.z - startZ) / dt : 0;
    audio.frame(world, position, {grounded:movement.grounded, yaw:heading.yaw,
      climbing:movement.medium === 'ladder', swimming:movement.medium === 'water'});
    jump = false;
  }
  if (!resetting && now >= nextPositionSync && !acting) syncPosition();
  if (!sync || presenceDirty) sendPresence(now);
  updateCamera();
  view.players.frame(now, dt);
  updateSelection();
  updatePlacement(selection);
  const selected = selection?.voxelMaterial ? labelFor(selection.voxelMaterial) :
    selection?.part ? partLabel(selection.part) : labelFor(getKey(selection?.cell));
  const held = chiseling ? labelFor(chiselMaterial) : heldPart ? partLabel(heldPart) : labelFor(clipboard);
  const status = [selected, held && 'В руке · ' + held].filter(Boolean).join('  /  ') || 'Ячейка не выбрана';
  if (selectionStatus.textContent !== status) selectionStatus.textContent = status;
  const coordinates = `X ${position.x.toFixed(2)}  Y ${position.y.toFixed(2)}  Z ${position.z.toFixed(2)}`;
  if (coordinateStatus.textContent !== coordinates) coordinateStatus.textContent = coordinates;
  if (now >= nextClockUpdate) {
    social.updateClock(view.dayTick(now), view.worldTime.frozen);
    nextClockUpdate = now + 200;
  }
  view.render(now, selection, playing && !social.isOpen(), placement, document.hasFocus());
  requestAnimationFrame(tick);
}

function bindControls() {
  const canvas = view.renderer.domElement;
  clearSelection.addEventListener('click', clearHeld);
  button.addEventListener('click', () => {
    let pending;
    try {
      pending = profile.changes();
    } catch (error) {
      notice(error.message);
      return;
    }
    if (Object.keys(pending).length) {
      if (button.disabled) return;
      button.disabled = true;
      profile.nickname.disabled = profile.skin.disabled = profile.clear.disabled = true;
      post('profile', pending, AbortSignal.timeout(5000)).then(({ok, body}) => {
        if (!ok) throw new Error(messages[body.error] || 'Не удалось сохранить профиль');
        profile.saved(body, pending);
        if (playing) {
          entered = true;
          presenceDirty = true;
        }
      }).catch(error => {
        if (touchMode) setPlaying(false);
        else if (document.pointerLockElement === canvas) document.exitPointerLock();
        notice(error.message);
      }).finally(() => {
        button.disabled = false;
        profile.nickname.disabled = profile.skin.disabled = profile.clear.disabled = false;
      });
    }
    audio.enable();
    if (touchMode) setPlaying(true);
    else {
      try {
        Promise.resolve(canvas.requestPointerLock()).catch(error => notice(error.message));
      } catch (error) { notice(error.message); }
    }
  });
  document.addEventListener('pointerlockchange', () => {
    if (!touchMode && !social.isOpen()) setPlaying(document.pointerLockElement === canvas);
  });
  document.addEventListener('pointerlockerror', () => notice('Браузер заблокировал захват курсора'));
  document.addEventListener('mousemove', event => {
    if (!touchMode && playing && !social.isOpen()) look(event.movementX, event.movementY);
  });
  document.addEventListener('keydown', event => {
    if (social.keydown(event, playing)) return;
    if (!playing) return;
    if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.code)) event.preventDefault();
    keys.add(event.code);
    if (event.repeat) return;
    if (event.code === 'Space') jump = true;
    if (event.code === 'KeyF' && !resetting && !seat) setFlight(!flying);
    if (event.code === 'KeyV' && !resetting && !acting) toggleChisel();
    if (event.code === 'KeyX') clearHeld();
    if (event.code === 'KeyQ') action('copy');
    if (event.code === 'KeyR') cyclePlacement();
    if (event.code === 'KeyE') action('interact', event.shiftKey);
  });
  document.addEventListener('keyup', event => { keys.delete(event.code); social.keyup(event); });
  window.addEventListener('blur', () => { keys.clear(); social.blur(); });
  canvas.addEventListener('mousedown', event => {
    if (!playing || touchMode || social.isOpen()) return;
    if (event.button === 2) rightClick(event.shiftKey);
    if (event.button === 0) action('remove');
    if (event.button === 1) action('copy');
  });
  canvas.addEventListener('contextmenu', event => event.preventDefault());

  let finger, fingerX, fingerY;
  canvas.addEventListener('pointerdown', event => {
    if (!touchMode || finger !== undefined) return;
    finger = event.pointerId;
    fingerX = event.clientX;
    fingerY = event.clientY;
    canvas.setPointerCapture(finger);
  });
  canvas.addEventListener('pointermove', event => {
    if (event.pointerId !== finger) return;
    look(event.clientX - fingerX, event.clientY - fingerY, .006);
    fingerX = event.clientX;
    fingerY = event.clientY;
  });
  canvas.addEventListener('lostpointercapture', () => { finger = undefined; });
  const pad = element('stick');
  const nub = pad.querySelector('i');
  function slide(event) {
    const bounds = pad.getBoundingClientRect();
    const x = (event.clientX - bounds.left - bounds.width / 2) / 34;
    const z = (event.clientY - bounds.top - bounds.height / 2) / 34;
    const magnitude = Math.max(1, Math.hypot(x, z));
    stick.x = x / magnitude;
    stick.z = z / magnitude;
    nub.style.transform = 'translate(' + (stick.x * 33) + 'px,' + (stick.z * 33) + 'px)';
  }
  pad.addEventListener('pointerdown', event => { pad.setPointerCapture(event.pointerId); slide(event); });
  pad.addEventListener('pointermove', event => { if (pad.hasPointerCapture(event.pointerId)) slide(event); });
  pad.addEventListener('lostpointercapture', () => {
    stick.x = stick.z = 0;
    nub.style.transform = '';
  });
  element('touch-place').addEventListener('click', () => rightClick());
  for (const [id, command] of [['touch-copy','copy'], ['touch-use','interact'], ['touch-remove','remove']]) {
    element(id).addEventListener('click', () => action(command));
  }
  touchRotate.addEventListener('click', cyclePlacement);
  touchChisel.addEventListener('click', () => { if (!resetting && !acting) toggleChisel(); });
  element('jump').addEventListener('pointerdown', () => { jump = true; });
  element('distance').addEventListener('change', event => {
    view.setDistance(Number(event.target.value)).catch(error => notice(error.message));
  });
  const sound = element('audio-toggle');
  const showSound = muted => {
    sound.textContent = muted ? 'Звук выкл.' : 'Звук вкл.';
    sound.setAttribute('aria-pressed', String(!muted));
    audio.setMuted(muted);
  };
  showSound(localStorage.getItem('honeymoon-muted') === '1');
  sound.addEventListener('click', () => {
    const muted = sound.getAttribute('aria-pressed') === 'true';
    localStorage.setItem('honeymoon-muted', muted ? '1' : '0');
    showSound(muted);
  });
  const music = element('music-toggle');
  const showMusic = enabled => {
    music.textContent = enabled ? 'Музыка вкл.' : 'Музыка выкл.';
    music.setAttribute('aria-pressed', String(enabled));
    audio.setMusicVolume(enabled ? .16 : 0);
  };
  showMusic(localStorage.getItem('honeymoon-music') === '1');
  music.addEventListener('click', () => {
    const enabled = music.getAttribute('aria-pressed') !== 'true';
    localStorage.setItem('honeymoon-music', enabled ? '1' : '0');
    showMusic(enabled);
  });
  element('reset').addEventListener('click', async () => {
    if (resetting || acting) return;
    resetting = true;
    try {
      await sync;
      const {ok, body} = await post('respawn', {});
      if (ok) {
        setSeat(null, body.position);
        setFlight(false);
        presenceDirty = true;
      }
      else notice(messages[body.error] || body.error);
    } catch {
      notice('Связь с сервером прервалась');
    } finally {
      resetting = false;
    }
  });
}

function distanceToChunk([x, z]) {
  return Math.max(Math.abs(x - Math.floor(position.x / 16)), Math.abs(z - Math.floor(position.z / 16)));
}

async function addChunk([x, z], visualOnly = false) {
  const chunk = await json(`/generated/world/chunks/${x}.${z}.json`);
  view.addChunk(world.addChunk(chunk, visualOnly));
  if (visualOnly) metrics.visualChunksLoaded++;
  else metrics.chunksLoaded++;
}

async function streamChunks(chunks, scenery) {
  const remaining = [...chunks.map(chunk => ({chunk, visualOnly:false})),
    ...scenery.map(chunk => ({chunk, visualOnly:true}))];
  const priority = ({chunk, visualOnly}) => distanceToChunk(chunk) + (visualOnly ? 4 : 0);
  while (remaining.length) {
    let best = 0;
    for (let i = 1; i < remaining.length; i++) {
      if (priority(remaining[i]) < priority(remaining[best])) best = i;
    }
    const next = remaining[best];
    await view.waitForStreamSlot(!next.visualOnly && distanceToChunk(next.chunk) <= 2);
    try {
      await addChunk(next.chunk, next.visualOnly);
      remaining.splice(best, 1);
    } catch (error) {
      console.error(error);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function start() {
  const [manifest, session] = await Promise.all([json('/generated/world/world.json'), post('session', {})]);
  if (!session.ok) throw new Error('Сеанс не создан');
  profile.initialize(session.body.profile);
  if (session.body.sounds) {
    audio.load().then(loaded => {
      element('audio-toggle').hidden = !loaded;
      element('music-toggle').hidden = !loaded;
    }).catch(error => console.error(error));
  }
  world = new World(manifest);
  world.models = Object.fromEntries(await Promise.all((session.body.modelFamilies ?? []).map(async family =>
    [family, await json(`/generated/models/${family}.json`)])));
  const p = session.body.position;
  const [x, y, z] = session.body.spawn || manifest.spawn;
  position = p ? {...p} : {x, y, z};
  confirmedPosition = positionTuple(position);
  movement = new Movement(world);
  view = new Display(surface, world, session.body.dayTick);
  if (session.body.seat) setSeat(session.body.seat, p);
  if (session.body.time) view.setWorldTime(session.body.time);
  view.onError = error => { notice('Ошибка построения участка карты'); console.error(error); };
  updateCamera();
  const available = new Set([4, ...(manifest.terrain || []).map(ring => ring.radius)]);
  const distance = element('distance');
  for (const option of distance.options) option.disabled = !available.has(Number(option.value));
  if (manifest.visualRadius > 8 && available.has(16)) distance.value = '16';
  if (!available.has(Number(distance.value))) distance.value = '4';
  await Promise.all([view.loadTextures(), refresh()]);
  await view.prepareGraphics();
  bindControls();
  stream();
  requestAnimationFrame(tick);
  globalThis.honeymoon = Object.freeze({
    stats: () => ({...metrics, ...view.statistics(), revision: worldRevision, position: {...position}, seat, audio:audio.stats(),
      flying, chiseling, chiselMaterial, movementSync: {...positionMetrics, queued: positionTrail.length, confirmed: [...confirmedPosition]},
      renderer: view.renderer.getContext().getParameter(view.renderer.getContext().RENDERER)}),
    look: (yaw, pitch = 0) => { heading.yaw = yaw; heading.pitch = pitch; updateCamera(); },
    target: () => selection && {...selection},
    placement: () => placement && {...placement},
    setDistance: distance => {
      element('distance').value = String(distance);
      return view.setDistance(distance);
    },
    getCell: (x, y, z) => world.cellAt(x, y, z),
    players: () => view.players.inspect(),
    online: social.names,
    time: () => ({tick:view.dayTick(performance.now()), frozen:view.worldTime.frozen,
      sun:view.sky.material.uniforms.sunDirection.value.toArray()}),
  });
  const near = manifest.chunks.filter(chunk => distanceToChunk(chunk) <= 1);
  const buffered = manifest.chunks.filter(chunk => distanceToChunk(chunk) <= 2);
  const startup = [...buffered].sort((a, b) => distanceToChunk(a) - distanceToChunk(b));
  await Promise.all(Array.from({length: 4}, async () => {
    while (startup.length) await addChunk(startup.shift());
  }));
  loading.textContent = 'Подготавливаем графику…';
  await view.whenReady(near);
  metrics.playable = performance.now() - metrics.started;
  loading.textContent = 'Можно войти в мир';
  button.disabled = false;
  view.setDistance(Number(distance.value)).catch(console.error);
  streamChunks(manifest.chunks.filter(chunk => !buffered.includes(chunk)), manifest.visualChunks ?? []).catch(console.error);
}

start().catch(error => {
  console.error(error);
  loading.textContent = 'Ошибка загрузки. ' + error.message;
});
