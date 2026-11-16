import {Display} from './display.mjs';
import {Movement, EYE, movementSpeed, overlapsPlacement, pick, pickItemFrame, pickVehicle} from './movement.mjs';
import {World, chunkKey, json} from './world-data.mjs';
import {WorldAudio} from './audio.mjs';
import {PlayerProfile, skinDescription, skinTooLarge} from './player-profile.mjs';
import {createSocialHud} from './social-hud.mjs';
import {createCreativeMenu} from './creative-menu.mjs';
import {blockState, jammyUseSound} from '../world/block-interactions.mjs';
import {seatFor, SEATED_EYE} from '../world/seats.mjs';
import {extractedModel, isJammyConnectableSeat, placementModelObject} from '../world/extracted-models.mjs';
import {jammyBenchState} from '../world/jammy-benches.mjs';
import {FLIGHT_VERTICAL_MULTIPLIER, POSITION_TRAIL_LIMIT} from '../world/player-body.mjs';
import {isMicroblockCell, microblockPlacement, partBoxesOverlapBox} from '../world/microblocks.mjs';
import {minecartSeat} from '../world/minecarts.mjs';
import {boatSeat} from '../world/boats.mjs';
import {ATLAS_GRID, TILE_SIZE, chiselMaterialShape, coverBoxes, creativeIcon, signFor} from '../world/geometry.mjs';
import {creativeMicroblock, shapedLampData} from '../world/creative-items.mjs';
import {isChiselMaterial, voxelBrush, voxelKey, voxelMaterialAt, voxelRemovalBrush, VOXEL_MATERIAL_LIMIT} from '../world/voxel-chisel.mjs';
import {chiselMaterialKey, chiselPlacementAtHit, chiselVoxelAtHit} from '../world/chisel-surface.mjs';
import {positionBatch} from './position-packet.mjs';
import {supportsFarTerrain} from './far-terrain.mjs';

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
const creativeToggle = element('creative-toggle');
const microHint = element('micro-hint');
const touchRotate = element('touch-rotate');
const chiselHint = element('chisel-hint');
const touchChisel = element('touch-chisel');
const signEditor = element('sign-editor');
const signFields = [...element('sign-form').querySelectorAll('input')];
const signStatus = element('sign-status');
const signSave = element('sign-save');
const teleportLoading = element('teleport-loading');
const keys = new Set();
const touchMode = matchMedia('(pointer: coarse)').matches;
const heading = {yaw: 0, pitch: -.045};
let orbitHeading = null, orbitReturn = 0;
const stick = {x: 0, z: 0};
let world, view, movement, position, selection, clipboard, worldRevision = 0;
let heldPart = null, partRotation = 0, placement = null, placementKey = '';
let heldSofa = null, sofaTurns = 0;
let chiseling = false, chiselMaterial = null, chiselSize = 1;
let heldVersion = 0;
let fromCreative = false;
let heldCreativeItem = null;
let creativeAvailable = false;
const creativeNames = new Map();
let iconImage, itemIconImage;
let selectionInputs, selectionRevision = 0;
let seatTarget = null;
let frameTarget = null, rayFrameTarget;
const positionInterval = 130;
const positionMetrics = {requests: 0, corrections: 0, errors: 0};
const positionTrail = [];
let playing = false, jump = false, lastFrame = 0, nextPositionSync = 0, timer;
let flying = false;
let spectator = false, spectatorReturn = null;
let seat = null, seatPending = false, seatEpoch = 0;
let signTarget;
let sync = null, pendingPosition = null, confirmedPosition, retryCount = 0, acting = false, resetting = false;
let metrics = {started: performance.now(), playable: 0, chunksLoaded: 0, visualChunksLoaded: 0, lastEdit: 0};
let feed;
let nearbyStream;
let entered = false, presenceDirty = true, presenceRequest = null, lastSentPose, nextPresence = 0;
let horizontalSpeed = 0;
let hoofSwing = 0;
let repeatPlacement = false, nextPlacement = 0, resumeOnEscape = false, resuming = false;
let pointerReleasedAt = -Infinity;
let nextClockUpdate = 0;
const audio = new WorldAudio();
const profile = new PlayerProfile({nickname:element('nickname'), skin:element('pony-skin'), status:element('skin-status'),
  clear:element('clear-skin'), label:element('player-name')}, notice);
const pause = () => {
  repeatPlacement = false;
  keys.clear();
  jump = false;
  stick.x = stick.z = 0;
  if (document.pointerLockElement) document.exitPointerLock();
};
function resume() {
  if (touchMode || !view || !entered) return;
  const canvas = view.renderer.domElement;
  if (document.pointerLockElement === canvas || resuming) return;
  resuming = true;
  const rejected = () => {
    resuming = false;
    setPlaying(false);
    element('resume-help').hidden = false;
    element('resume-help').textContent = 'Нажмите Enter или «Продолжить», чтобы вернуть управление мышью';
    button.focus({preventScroll:true});
  };
  try { Promise.resolve(canvas.requestPointerLock()).catch(rejected); }
  catch { rejected(); }
}
const social = createSocialHud({post, notice, pause, resume, teleport});
const creative = createCreativeMenu({load:loadCreative, choose:chooseCreative,
  pause() { social.close(false); pause(); }, resume, notice, icon:drawCreativeIcon});
const menuOpen = () => social.isOpen() || creative.isOpen() || signEditor.open;

async function loadCreative() {
  const catalog = await json('/generated/creative/catalog.json');
  for (const {key, name} of catalog.entries) if (key && name) creativeNames.set(key, name);
  return catalog;
}

function chooseCreative(entry) {
  if (entry.placeable === false) return false;
  heldVersion++;
  fromCreative = true;
  heldCreativeItem = entry.kind ? entry : null;
  clipboard = ['microblock','minecart','boat','item-frame','flat-item'].includes(entry.kind) ? null : entry.blockKey ?? entry.key;
  heldSofa = isJammyConnectableSeat(world.models?.jammy, clipboard) ? {} : null;
  sofaTurns = 0;
  chiselMaterial = isChiselMaterial(clipboard) ? chiselMaterialKey(clipboard) : null;
  if (chiseling) toggleChisel();
  setHeldPart(entry.kind === 'microblock' ? creativeMicroblock(entry) : null);
  notice(entry.kind === 'minecart' ? 'Вагонетка в руке · ПКМ по рельсам' :
    entry.kind === 'boat' ? 'Лодка в руке · ПКМ по воде' : 'В руке · ' + entry.name);
  return true;
}

async function drawCreativeIcon(entry, canvas) {
  const sprite = world.models.biblio?.items?.[entry.id + ':' + (entry.damage ?? 0)];
  if (sprite?.uv && ['flat-item','item-frame','minecart','boat'].includes(entry.kind)) {
    if (!itemIconImage) {
      const image = new Image();
      image.src = '/generated/models/biblio.png';
      itemIconImage = image.decode().then(() => image).catch(error => { itemIconImage = undefined; throw error; });
    }
    const image = await itemIconImage;
    const [u0,v0,u1,v1] = sprite.uv;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.clearRect(0,0,canvas.width,canvas.height);
    context.drawImage(image,u0*image.width,v0*image.height,(u1-u0)*image.width,(v1-v0)*image.height,
      0,0,canvas.width,canvas.height);
    return true;
  }
  if (entry.kind === 'minecart') {
    const context = canvas.getContext('2d');
    context.fillStyle = '#333a44';
    context.fillRect(3, 8, 26, 7);
    context.fillRect(7, 21, 6, 5);
    context.fillRect(19, 21, 6, 5);
    context.fillStyle = '#aeb3bc';
    context.beginPath();
    context.moveTo(3, 11);
    context.lineTo(29, 11);
    context.lineTo(25, 22);
    context.lineTo(7, 22);
    context.fill();
    context.fillStyle = '#d3d8df';
    context.fillRect(3, 9, 26, 2);
    return true;
  }
  const model = entry.kind === 'microblock' ? {part:creativeMicroblock(entry)} :
    entry.kind === 'shaped-lamp' ? {data:shapedLampData(entry.damage), lit:Boolean(entry.damage & 16)} : undefined;
  const info = creativeIcon({...entry, ...model, key:entry.blockKey ?? entry.key});
  if (!info || !Number.isInteger(info.tile) || info.tile < 0) return false;
  if (!iconImage) {
    const image = new Image();
    image.src = '/generated/textures/atlas.png';
    iconImage = image.decode().then(() => image).catch(error => { iconImage = undefined; throw error; });
  }
  const image = await iconImage;
  const tile = info.tile;
  const left = tile % ATLAS_GRID * TILE_SIZE;
  const top = Math.floor(tile / ATLAS_GRID) * TILE_SIZE;
  if (top + TILE_SIZE > image.naturalHeight) return false;
  const context = canvas.getContext('2d');
  if (!context) return false;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = false;
  context.drawImage(image, left, top, TILE_SIZE, TILE_SIZE, 0, 0, canvas.width, canvas.height);
  const tint = Number.isInteger(info.tint) ? [info.tint >> 16 & 255, info.tint >> 8 & 255, info.tint & 255] : info.tint;
  if (Array.isArray(tint) && tint.some(channel => channel !== 255)) {
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      for (let channel = 0; channel < 3; channel++) pixels.data[offset + channel] *= tint[channel] / 255;
    }
    context.putImageData(pixels, 0, 0);
  }
  return true;
}

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
  block_not_owned: 'Исходный блок карты защищён', part_not_owned: 'Исходные детали карты защищены',
  part_missing: 'Деталь уже убрана', invalid_part: 'Эта форма или материал недоступны',
  part_required: 'Наведите прицел на отдельную деталь',
  incompatible_part: 'Деталь здесь не помещается',
  voxel_required: 'Нажмите V, чтобы взять резец',
  voxel_not_owned: 'Резцом можно менять блоки, установленные игроками',
  invalid_voxel: 'Наведите прицел на нужную часть блока',
  invalid_material: 'Резец берёт материал с полного блока, жидкости или уже вырезанной части',
  voxel_material_limit: 'В кубе уже слишком много разных материалов',
  outside_playable_area: 'Граница района', protected_cell: 'Это часть контрольной механики',
  no_interaction: 'С этим объектом нельзя взаимодействовать',
  not_a_seat: 'На этот блок нельзя сесть', seat_taken: 'Место уже занято',
  seat_blocked: 'Над сиденьем недостаточно места',
  invalid_sign_face: 'Табличку можно поставить сверху или сбоку блока',
  invalid_sign_text: 'Каждая строка должна содержать до 80 символов без переноса',
  not_a_sign: 'Здесь больше нет таблички',
  not_a_frame: 'Здесь больше нет рамки',
  stale_frame: 'Рамка изменилась. Повторите действие.',
  invalid_frame_face: 'Для рамки нужна широкая сторона прочного блока',
  frame_limit: 'Достигнут предел рамок',
  invalid_control_face: 'Этот механизм нельзя закрепить на выбранной грани',
  rail_needs_support: 'Рельсам нужна опора снизу',
  minecart_requires_rail: 'Поставьте вагонетку на рельсы',
  not_a_minecart: 'Здесь больше нет вагонетки',
  minecart_limit: 'Достигнут предел числа вагонеток',
  boat_requires_water: 'Поставьте лодку на поверхность воды',
  not_a_boat: 'Здесь больше нет лодки',
  boat_limit: 'Достигнут предел числа лодок',
  invalid_nickname: 'Проверьте ник · от 2 до 24 символов',
  invalid_skin: 'Скин должен быть изображением PNG поддерживаемого размера',
  invalid_skin_size: skinDescription,
  skin_too_large: skinTooLarge
};

async function post(path, payload, signal) {
  const response = await fetch('/api/' + path, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload), signal
  });
  const body = await response.json();
  return {ok: response.ok, body};
}

function requestId() {
  return [...crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(16).padStart(8, '0')).join('');
}

async function postAction(request) {
  try { return await post('action', request); }
  catch { return post('action', request); }
}

function effects(data, showMessages = true) {
  audio.effects(data.effects ?? [], world);
  for (const effect of data.effects || []) {
    if (effect.type === 'dispense') view.dispense(effect);
    if (showMessages && effect.message) notice(effect.message);
  }
}

function changes(list = [], revision = 0, frames) {
  const changed = [];
  for (const change of list) {
    if (world.setOverride(change)) changed.push(change);
  }
  if (frames) world.setFrames(frames,revision);
  if (changed.length || frames) selectionRevision++;
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
  changes(snapshot.overrides, snapshot.worldRevision, snapshot.frames);
}

function stream() {
  feed = new EventSource('/api/events?since=' + worldRevision + '&presence=1&social=1&minecarts=1');
  feed.addEventListener('open', () => { presenceDirty = true; });
  feed.addEventListener('presence', event => {
    const {players, selfOnline} = JSON.parse(event.data);
    view.players.replace(players);
    social.roster(players, selfOnline && profile.confirmed);
  });
  feed.addEventListener('presence-motion', event => view.players.update(JSON.parse(event.data).players));
  feed.addEventListener('minecarts', event => {
    const {entities,boats,seat:reportedSeat,position:feet} = JSON.parse(event.data);
    world.setMinecarts(entities,performance.now(),boats);
    if (seat?.entity && !seatPending && !resetting && feet) {
      if (reportedSeat?.entity === seat.entity) confirmedPosition = positionTuple(feet);
      else setSeat(reportedSeat, feet);
    }
  });
  feed.addEventListener('chat-history', event => social.history(JSON.parse(event.data).entries));
  feed.addEventListener('chat', event => social.message(JSON.parse(event.data)));
  feed.addEventListener('world-time', event => {
    const time = JSON.parse(event.data);
    view.setWorldTime(time);
    social.clockState(time);
  });
  feed.addEventListener('commit', event => {
    const data = JSON.parse(event.data);
    changes(data.changes, data.worldRevision, data.frames);
    effects(data,false);
  });
  feed.addEventListener('reset', () => refresh().catch(error => notice(error.message)));
  feed.addEventListener('ready', event => {
    const {contentHash} = JSON.parse(event.data);
    if (contentHash && contentHash !== world.manifest.contentHash) location.reload();
  });
}

function heldPonyItem() {
  const item = heldCreativeItem;
  if (item && ['flat-item','item-frame','minecart','boat'].includes(item.kind)) {
    return {kind:'item', key:`${item.id}:${item.damage ?? 0}`};
  }
  const partKey = heldPart ? `cover-material:${heldPart.material}` : null;
  const key = chiseling ? chiselMaterial : partKey ?? clipboard;
  return key && /^(?:legacy|cover-material):[\d:]+$/.test(key) ? {kind:'block', key} : null;
}

function playerPose() {
  const motion = seat ? 'sit' : !playing ? 'idle' : flying ? 'fly' : movement.medium === 'water' ? 'swim' :
    !movement.grounded && !movement.medium ? 'air' : horizontalSpeed > .15 ? (sprinting() ? 'run' : 'walk') : 'idle';
  return {yaw: Math.atan2(Math.sin(heading.yaw), Math.cos(heading.yaw)), pitch:heading.pitch, motion,
    eye:view.eyeOffset(),
    typing:social.isChatOpen(), swing:hoofSwing, held:heldPonyItem(),
    seq:Math.round(performance.timeOrigin + performance.now())};
}

function sendPresence(now) {
  if (!entered || presenceRequest || now < nextPresence || feed?.readyState !== EventSource.OPEN) return;
  const pose = playerPose();
  if (seat?.kind === 'boat') {
    pose.boatDrive = playing && !menuOpen() ? [Math.sign(forwardInput()),Math.sign(turnInput())] : [0,0];
  } else if (seat?.entity) {
    pose.cartDrive = playing && !menuOpen() ? Math.sign(forwardInput()) : 0;
  }
  const changed = !lastSentPose || pose.motion !== lastSentPose.motion ||
    pose.typing !== lastSentPose.typing || pose.swing !== lastSentPose.swing ||
    pose.held?.key !== lastSentPose.held?.key || pose.held?.kind !== lastSentPose.held?.kind ||
    pose.cartDrive !== lastSentPose.cartDrive || Boolean(pose.cartDrive) ||
    pose.boatDrive?.[0] !== lastSentPose.boatDrive?.[0] || pose.boatDrive?.[1] !== lastSentPose.boatDrive?.[1] ||
    pose.boatDrive?.some(Boolean) ||
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
  view.updateCamera(position, orbitHeading ?? heading, seat ? SEATED_EYE : EYE);
}

function cameraMode() {
  const camera = view.perspectiveView();
  return orbitHeading ? {...camera, mode:'orbit'} : camera;
}

function updateCameraHint() {
  element('aim').style.display = spectator || orbitHeading || view.perspective === 2 ? 'none' : '';
  element('orbit-status').hidden = !orbitHeading;
}

function toggleOrbit() {
  if (orbitHeading) {
    orbitHeading = null;
    view.perspective = orbitReturn;
  } else {
    orbitHeading = {...heading};
    orbitReturn = view.perspective;
    view.perspective = 1;
    view.viewBob.reset();
    keys.clear();
    jump = false;
  }
  updateCameraHint();
}

function sprinting() {
  return keys.has('ShiftLeft') || keys.has('ShiftRight');
}

function forwardInput() {
  return Number(keys.has('KeyW') || keys.has('ArrowUp')) - Number(keys.has('KeyS') || keys.has('ArrowDown')) - stick.z;
}

function turnInput() {
  return Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft')) + stick.x;
}

function look(dx, dy, sensitivity = .0023) {
  if (orbitHeading) {
    orbitHeading.yaw -= dx * sensitivity;
    orbitHeading.pitch = Math.min(1.52, Math.max(-1.52, orbitHeading.pitch - dy * sensitivity));
    return;
  }
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
    creativeToggle.disabled = spectator || !creativeAvailable;
  }
  audio.setPlaying(active);
  game.classList.toggle('playing', active);
  game.classList.toggle('paused', !active && entered);
  element('resume-help').hidden = active || !entered;
  entry.hidden = active;
  if (!active) {
    repeatPlacement = false;
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
  element('flight-status').hidden = !active || spectator;
}

function setSpectator(active) {
  if (active === spectator) return;
  if (active) {
    if (orbitHeading) toggleOrbit();
    spectatorReturn = {perspective:view.perspective, flying};
    view.perspective = 0;
  } else {
    view.perspective = spectatorReturn.perspective;
  }
  spectator = active;
  setFlight(active || spectatorReturn.flying);
  keys.clear();
  game.classList.toggle('spectating', active);
  element('spectator-status').hidden = !active;
  creativeToggle.disabled = active || !creativeAvailable;
  updateCameraHint();
}

async function toggleSpectator() {
  if (resetting || acting || seatPending) return;
  resetting = true;
  try {
    await flushPosition();
    const {ok, body} = await post('spectator', {enabled:!spectator, pose:playerPose()}, AbortSignal.timeout(5000));
    if (!ok) {
      notice(messages[body.error] ?? body.error);
      return;
    }
    seatEpoch++;
    setSpectator(body.spectator);
    if (body.relocated) await arriveAt(body.position);
    else setSeat(null, body.position);
  } catch {
    notice('Связь с сервером прервалась');
  } finally {
    resetting = false;
  }
}

const positionTuple = ({x, y, z}) => [x, y, z];

function recordPosition(feet) {
  const sample = positionTuple(feet);
  const previous = positionTrail.at(-1) ?? confirmedPosition;
  if (sample.some((value, axis) => value !== previous[axis])) positionTrail.push(sample);
}

function setAuthoritativePosition(feet) {
  Object.assign(position, feet);
  view?.viewBob.reset();
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
  const status = element('seat-status');
  status.hidden = !seat;
  status.textContent = seat?.kind === 'boat' ? (touchMode ? 'Лодка · стик — управление · Действие — выйти' :
    'Лодка · WASD или стрелки · E — выйти') : seat?.entity ? (touchMode ? 'Вагонетка · стик — движение · Действие — встать' :
      'Вагонетка · W/S или ↑/↓ — движение · E — встать') : 'Сидите · E — встать';
  if (seat) {
    setFlight(false);
    heading.yaw = seat.yaw;
    heading.pitch = -.045;
  }
  presenceDirty = true;
}

async function teleport(coordinates) {
  if (resetting || acting || seatPending) return {ok:false, body:{error:'action_pending'}};
  resetting = true;
  try {
    await sync;
    const result = await post('teleport', coordinates, AbortSignal.timeout(5000));
    if (result.ok) {
      const arriving = arriveAt(result.body.position);
      changes(result.body.changes, result.body.worldRevision);
      effects(result.body);
      presenceDirty = true;
      selectionInputs = null;
      placementKey = '';
      await arriving;
    }
    return result;
  } finally {
    resetting = false;
  }
}

async function arriveAt(feet) {
  const cx = Math.floor(feet.x / 16), cz = Math.floor(feet.z / 16);
  const visible = world.manifest.chunks.filter(([x,z]) =>
    Math.max(Math.abs(x - cx), Math.abs(z - cz)) <= view.detailedDistance);
  const covered = !view.chunksReady(visible);
  if (covered) teleportLoading.hidden = false;
  setSeat(null, feet);
  nearbyStream?.update();
  if (!covered) return;
  try {
    await view.whenReady(visible);
    await new Promise(resolve => requestAnimationFrame(resolve));
    teleportLoading.hidden = true;
  } catch (error) {
    element('teleport-loading-text').textContent = 'Не удалось загрузить локацию';
    element('teleport-reload').hidden = false;
    throw error;
  }
}

async function toggleSeat() {
  const {x, y, z, hit, entity} = seatTarget ?? selection ?? {};
  const target = seat ? undefined : {x, y, z, hit, ...(entity && {entity})};
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

function interact(sneaking = false) {
  if (!playing || acting || resetting || spectator || menuOpen()) return;
  if (seat || seatTarget) return toggleSeat();
  if (frameTarget) return action('interact');
  const cell = selection?.cell;
  if (seatFor(cell, world.models) && !(sneaking && jammyUseSound(...blockState(cell)))) return toggleSeat();
  const sign = signFor(cell);
  if (!sign) return action('interact', sneaking);
  const {x, y, z, hit} = selection;
  const expectedRevision = world.revisionAt(x, y, z);
  if (!expectedRevision) { notice('Исходную табличку карты нельзя редактировать'); return; }
  signTarget = {x, y, z, hit, expectedRevision};
  signFields.forEach((field, index) => { field.value = sign.lines[index]; });
  signStatus.textContent = '';
  signEditor.showModal();
  pause();
  signFields[0].focus();
}

function closeSign() {
  if (acting) return;
  signEditor.close();
  signTarget = undefined;
  resume();
}

async function saveSign(event) {
  event.preventDefault();
  if (!signTarget || acting || resetting) return;
  const request = {requestId:requestId(), type:'edit_sign', ...signTarget, lines:signFields.map(field => field.value),
    eye:view.eyeOffset()};
  signStatus.textContent = '';
  signSave.disabled = true;
  acting = true;
  try {
    if (!await flushPosition()) { signStatus.textContent = messages.movement_blocked; return; }
    const {ok, body} = await postAction(request);
    if (!ok) {
      if (body.current) changes([body.current], body.worldRevision);
      signStatus.textContent = body.error === 'stale_cell' ? 'Табличка изменилась. Закройте редактор и откройте её снова.' :
        messages[body.error] || 'Не удалось сохранить текст';
      return;
    }
    changes(body.changes, body.worldRevision);
  } catch {
    signStatus.textContent = 'Связь с сервером прервалась';
    return;
  } finally {
    acting = false;
    signSave.disabled = false;
  }
  closeSign();
}

function positionPacket(lastStep) {
  const {target:[x, y, z], trail} = positionBatch(confirmedPosition, positionTrail, lastStep);
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
  if (creativeNames.has(key)) return creativeNames.get(key);
  const id = Number(key.split(':')[1]);
  const sofas = world.models?.jammy?.sofaIds;
  if (sofas && id === sofas.chair) return 'Кресло';
  if (sofas && (id === sofas.left || id === sofas.right || id === sofas.center || id === sofas.corner)) return 'Секция дивана';
  if (jammyBenchState(world.models?.jammy, key)) return 'Секция скамьи';
  return world.manifest.legacyRegistry?.[id]?.name || ({1:'Камень',2:'Дёрн',3:'Земля',4:'Булыжник',
    5:'Доски',8:'Вода',9:'Вода',10:'Лава',11:'Лава',17:'Бревно',20:'Стекло',35:'Шерсть',44:'Плита',63:'Табличка',68:'Табличка'})[id] ||
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
    const key = `voxel,${chiselSize},${x},${y},${z},${target.voxel},${partSlot},${target.offset},${revision},${adjacentRevision},${adjacentLoaded},` +
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
  if (placement) placement.blocked = Boolean(placement.unavailable) ||
    placement.solid !== false && overlapsPlacement(position, placement);
}

function previewVoxel(target) {
  const next = chiselPlacementAtHit(target, target.hit, target.offset,
    target.partSlot === undefined ? target.cell.voxels : undefined, target.partSlot);
  if (!next) return null;
  const {x,y,z,voxel} = next;
  const {minX,maxX,minY,maxY,minZ,maxZ} = world.manifest.bounds;
  if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ || !world.hasChunk(x,z)) return null;
  const old = world.cellAt(x,y,z);
  const {box, indices} = voxelBrush(voxel, chiselSize);
  let unavailable = null;
  if (old && (!old.voxels && !isMicroblockCell(old) || indices.some(index => voxelMaterialAt(old.voxels, index)) ||
      old.parts && partBoxesOverlapBox(coverBoxes(old.parts), box))) unavailable = 'occupied';
  else if (old?.voxels?.materials.length >= VOXEL_MATERIAL_LIMIT && !old.voxels.materials.includes(chiselMaterial)) {
    unavailable = 'voxel_material_limit';
  }
  const against = {x:target.x,y:target.y,z:target.z};
  if (target.partSlot !== undefined) against.partSlot = target.partSlot;
  return {...next, boxes:[box], against, unavailable, solid:chiselMaterialShape(chiselMaterial).solid};
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
  fromCreative = false;
  heldCreativeItem = null;
  clipboard = null;
  heldSofa = null;
  sofaTurns = 0;
  chiselMaterial = null;
  placement = null;
  if (chiseling) toggleChisel();
  setHeldPart(null);
  notice('Выбор сброшен');
}

function toggleChisel() {
  chiseling = !chiseling;
  if (chiseling && !chiselMaterial && isChiselMaterial(clipboard)) chiselMaterial = chiselMaterialKey(clipboard);
  placementKey = '';
  placement = null;
  chiselHint.hidden = !chiseling;
  updateChiselHint();
  updatePlacementHints();
  touchChisel.setAttribute('aria-pressed', String(chiseling));
}

function updateChiselHint() {
  chiselHint.textContent = `Резец 1/${8 / chiselSize} · B — сменить размер · ЛКМ — убрать · ПКМ — добавить · Q — взять материал`;
}

function toggleChiselSize() {
  if (!chiseling || acting) return;
  chiselSize = chiselSize === 1 ? 2 : 1;
  placementKey = '';
  updateChiselHint();
}

function updateSelection() {
  if (!playing || spectator || orbitHeading) {
    selection = null;
    seatTarget = null;
    frameTarget = null;
    selectionInputs = null;
    return;
  }
  const {x,y,z} = position;
  const {yaw,pitch} = heading;
  const stamp = [x,y,z,yaw,pitch,selectionRevision,metrics.chunksLoaded,chiseling,chiselSize,seat];
  const changed = !selectionInputs || stamp.some((value, index) => value !== selectionInputs[index]);
  if (!changed && !world.minecarts.size && !world.boats.size && !seatTarget) return;
  selectionInputs = stamp;
  const cp = Math.cos(pitch);
  const origin = view.sightOrigin(position,seat ? SEATED_EYE : EYE);
  const direction = [-Math.sin(yaw) * cp,Math.sin(pitch),-Math.cos(yaw) * cp];
  if (changed) selection = pick(world, origin, direction, chiseling);
  seatTarget = pickVehicle(world,origin,direction,selection);
  if (changed) rayFrameTarget = pickItemFrame(world,origin,direction,selection);
  frameTarget = rayFrameTarget;
  if (frameTarget && (seatTarget?.length ?? Infinity) < frameTarget.length) frameTarget = null;
  else if (frameTarget) seatTarget = null;
  if (changed && chiseling && chiselSize === 2 && selection?.voxel !== undefined) {
    selection.chiselSize = chiselSize;
    selection.boxes = [voxelRemovalBrush(selection.cell.voxels, selection.voxel, chiselSize).box];
  }
}

async function action(type, sneaking = false) {
  if (acting || resetting || spectator || !playing) return;
  const frame = frameTarget && !chiseling && ['place','remove','interact'].includes(type) ? frameTarget : null;
  const placingFrame = !frame && type === 'place' && heldCreativeItem?.kind === 'item-frame';
  const placingCart = !frame && type === 'place' && heldCreativeItem?.kind === 'minecart';
  const placingBoat = !frame && type === 'place' && heldCreativeItem?.kind === 'boat';
  const removingVehicle = type === 'remove' && !chiseling && seatTarget;
  const target = frame || removingVehicle || selection;
  if (!target) return;
  const selectedVersion = heldVersion;
  const cell = getKey(target.cell);
  let pendingPlacement;
  if (frame) {
    type = {place:'frame_item',remove:'frame_remove',interact:'frame_use'}[type];
  } else if (placingFrame) {
    type = 'place_frame';
  } else if (placingCart) {
    type = 'place_minecart';
  } else if (placingBoat) {
    type = 'place_boat';
  } else if (removingVehicle) {
    type = target.kind === 'boat' ? 'remove_boat' : 'remove_minecart';
  } else if (chiseling && target.part && type === 'remove') {
    type = 'remove_part';
  } else if (chiseling && type !== 'interact') {
    if (target.voxel === undefined && !(type === 'place' && target.partSlot !== undefined)) {
      notice(messages.invalid_material);
      return;
    }
    if (type === 'place' && !chiselMaterial) { notice('Сначала скопируйте материал клавишей Q'); return; }
    type += '_voxel';
  } else {
    if (target.part && type === 'copy') type = 'copy_part';
    if (type === 'remove' && (target.part || target.cell?.voxels)) {
      type = clipboard || heldPart ? (target.part ? 'remove_part' : 'remove_voxel') : 'remove_microblocks';
    }
    if (heldPart && type === 'place') type = 'place_part';
  }
  const request = {requestId: requestId(), type, x: target.x, y: target.y, z: target.z, hit: target.hit};
  request.eye = view.eyeOffset();
  if (placingCart || placingBoat || placingFrame) Object.assign(request,{creativeItem:heldCreativeItem.key,yaw:heading.yaw});
  if (frame) request.entity = frame.entity;
  if (type === 'frame_item') {
    if (heldCreativeItem) request.creativeItem = heldCreativeItem.key;
    else if (clipboard) request.cell = clipboard;
    else { notice(messages.nothing_to_copy); return; }
  }
  if (removingVehicle) request.entity = target.entity;
  if (type === 'copy_part' || type === 'remove_part') request.partSlot = target.partSlot;
  if (type === 'copy_voxel' || type === 'remove_voxel') {
    request.voxel = target.voxel ?? chiselVoxelAtHit(target, target.hit, target.offset, target.cell.voxels, cell);
    if (request.voxel == null) { notice(messages.invalid_voxel); return; }
  }
  if (type === 'remove_voxel' || type === 'place_voxel') request.size = chiseling ? chiselSize : 1;
  if (type === 'interact') {
    request.yaw = heading.yaw;
    if (sneaking) request.sneaking = true;
    if (blockState(target.cell)[0] === 23) {
      if (heldCreativeItem) request.heldItem = heldCreativeItem.key;
      else if (clipboard?.startsWith('legacy:')) request.heldCell = clipboard;
    }
  }
  if (type === 'place') {
    if (heldCreativeItem?.kind === 'flat-item') { notice('Наведите прицел на рамку'); return; }
    if (!clipboard) { notice(messages.nothing_to_copy); return; }
    request.against = {x: target.x, y: target.y, z: target.z};
    request.x += target.offset[0];
    request.y += target.offset[1];
    request.z += target.offset[2];
    request.cell = clipboard;
    request.yaw = heading.yaw;
    request.pitch = heading.pitch;
    if (fromCreative) request.creative = true;
    if (heldCreativeItem) request.creativeItem = heldCreativeItem.key;
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
    if (heldCreativeItem) request.creativeItem = heldCreativeItem.key;
    pendingPlacement = {x, y, z, boxes};
  }
  if (type === 'place_voxel') {
    updatePlacement(target);
    if (!placement || placement.blocked) { notice(messages[placement?.unavailable ?? 'occupied']); return; }
    const {x,y,z,voxel,against,boxes} = placement;
    Object.assign(request, {x,y,z,voxel,against,material:chiselMaterial});
    if (placement.solid) pendingPlacement = {x,y,z,boxes};
  }
  request.expectedRevision = frame?.revision ?? world.revisionAt(request.x, request.y, request.z);
  const started = performance.now();
  acting = true;
  try {
    if (pendingPlacement) movement.pendingPlacement = pendingPlacement;
    if (!await flushPosition()) { notice(messages.movement_blocked); return; }
    if (pendingPlacement && overlapsPlacement(position, pendingPlacement)) { notice(messages.occupied); return; }
    const result = await postAction(request);
    if (!result.ok) {
      if (result.body.current || result.body.frames) {
        changes(result.body.current ? [result.body.current] : [],result.body.worldRevision,result.body.frames);
      }
      notice(messages[result.body.error] || result.body.error || 'Действие отклонено');
      return;
    }
    if (/^(?:place|remove)(?:_|$)/.test(type)) {
      hoofSwing = (hoofSwing + 1) & 0x7fffffff;
      presenceDirty = true;
    }
    if (type === 'copy' && selectedVersion === heldVersion) {
      fromCreative = false;
      heldCreativeItem = null;
      clipboard = result.body.cell || cell;
      heldSofa = isJammyConnectableSeat(world.models?.jammy, clipboard) ? {object: target.cell?.object} : null;
      sofaTurns = 0;
      setHeldPart(null);
      notice('Скопировано · ' + labelFor(clipboard));
    }
    if (type === 'copy_part' && selectedVersion === heldVersion) {
      fromCreative = false;
      heldCreativeItem = null;
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
    changes(result.body.changes, result.body.worldRevision, result.body.frames);
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
  world.stepMinecarts(now);
  const vehicle = seat?.entity && (seat.kind === 'boat' ? world.boats : world.minecarts).get(seat.entity)?.entity;
  if (vehicle && !resetting) {
    const anchor = seat.kind === 'boat' ? boatSeat(vehicle) : minecartSeat(vehicle,seat.yaw);
    const turn = anchor.yaw - seat.yaw;
    heading.yaw += Math.atan2(Math.sin(turn), Math.cos(turn));
    Object.assign(position, {x:anchor.x, y:anchor.y, z:anchor.z});
    Object.assign(seat, anchor);
  }
  if (playing && !menuOpen() && !orbitHeading && !seat && !seatPending) {
    const startX = position.x, startZ = position.z;
    const forward = forwardInput();
    const strafe = turnInput();
    const descending = flying ? keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC') : sprinting();
    const vertical = flying ? Number(keys.has('Space')) - Number(descending) : 0;
    const speed = movementSpeed({flying, sprint:sprinting()}) / Math.max(1, Math.hypot(forward, strafe, vertical));
    const sin = Math.sin(heading.yaw), cos = Math.cos(heading.yaw);
    if (!resetting && positionTrail.length < POSITION_TRAIL_LIMIT * 4) {
      const dx = (-sin * forward + cos * strafe) * speed;
      const dz = (-cos * forward - sin * strafe) * speed;
      if (flying) movement.fly(position, dx, vertical * speed * FLIGHT_VERTICAL_MULTIPLIER, dz, dt, recordPosition, spectator);
      else movement.update(position, dx, dz, jump, dt,
        {rise: jump || keys.has('Space'), descend: descending, recordStep: recordPosition});
    }
    horizontalSpeed = dt > 0 ? Math.hypot(position.x - startX, position.z - startZ) / dt : 0;
    audio.frame(world, position, {grounded:movement.grounded, yaw:heading.yaw,
      climbing:movement.medium === 'ladder', swimming:movement.medium === 'water'});
    jump = false;
  } else horizontalSpeed = 0;
  if (!resetting && now >= nextPositionSync && !acting) syncPosition();
  if (!sync || presenceDirty) sendPresence(now);
  if (playing && !menuOpen() && !seat && !flying) {
    view.viewBob.step(horizontalSpeed * dt, dt, movement.grounded && !movement.medium, movement.fall);
  } else {
    view.viewBob.step(0, dt, true, 0);
  }
  view.updateVehicles();
  view.updateLocalAvatar(now, dt, position, playerPose(), horizontalSpeed, seat, spectator);
  updateCamera();
  view.players.frame(now, dt);
  updateSelection();
  updatePlacement(selection);
  if (repeatPlacement && now >= nextPlacement && !acting && !resetting && !menuOpen() && playing &&
      !spectator && !orbitHeading && document.pointerLockElement === view.renderer.domElement) {
    nextPlacement = now + 150;
    if ((clipboard || heldPart || chiseling) && !frameTarget && !seatTarget) void action('place');
  }
  const selected = frameTarget ? 'Рамка · ПКМ — вложить предмет · E — повернуть' :
    seatTarget ? (seatTarget.kind === 'boat' ? 'Лодка · E — сесть' : 'Вагонетка · E — сесть') :
    selection?.voxelMaterial ? labelFor(selection.voxelMaterial) :
    selection?.part ? partLabel(selection.part) : labelFor(getKey(selection?.cell));
  const interaction = !seat && !seatTarget && !frameTarget && (seatFor(selection?.cell, world.models) ? 'E — сесть' :
    selection && signFor(selection.cell) && world.revisionAt(selection.x, selection.y, selection.z) ? 'E — редактировать' : '');
  const held = chiseling ? labelFor(chiselMaterial) : heldCreativeItem?.name ?? (heldPart ? partLabel(heldPart) : labelFor(clipboard));
  const status = [selected, interaction, held && 'В руке · ' + held].filter(Boolean).join('  /  ') || 'Ячейка не выбрана';
  if (selectionStatus.textContent !== status) selectionStatus.textContent = status;
  const coordinates = `X ${position.x.toFixed(2)}  Y ${position.y.toFixed(2)}  Z ${position.z.toFixed(2)}`;
  if (coordinateStatus.textContent !== coordinates) coordinateStatus.textContent = coordinates;
  if (now >= nextClockUpdate) {
    social.updateClock(view.dayTick(now), view.worldTime.frozen);
    nextClockUpdate = now + 200;
  }
  nearbyStream?.update();
  view.render(now, selection, playing && !menuOpen(), placement, document.hasFocus());
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
      profile.setSaving(true);
      post('profile', pending, AbortSignal.timeout(5000)).then(({ok, body}) => {
        if (!ok) {
          throw new Error(messages[body.error] || 'Не удалось сохранить профиль');
        }
        profile.saved(body, pending);
        social.profileUpdated(profile.confirmed);
        view.setLocalSkin(profile.confirmed.skin);
        if (playing) {
          entered = true;
          presenceDirty = true;
          creativeToggle.disabled = spectator || !creativeAvailable;
        }
      }).catch(error => {
        if (touchMode) setPlaying(false);
        else if (document.pointerLockElement === canvas) document.exitPointerLock();
        notice(error.message);
      }).finally(() => {
        button.disabled = false;
        profile.setSaving(false);
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
    resuming = false;
    if (!document.pointerLockElement) pointerReleasedAt = performance.now();
    if (!touchMode && !menuOpen()) setPlaying(document.pointerLockElement === canvas);
  });
  document.addEventListener('pointerlockerror', () => {
    resuming = false;
    if (!playing) {
      element('resume-help').hidden = false;
      element('resume-help').textContent = 'Нажмите Enter или «Продолжить», чтобы вернуть управление мышью';
    }
  });
  document.addEventListener('mousemove', event => {
    if (!touchMode && playing && !menuOpen() && (document.pointerLockElement === canvas || event.target === canvas)) {
      look(event.movementX, event.movementY);
    }
  });
  document.addEventListener('keydown', event => {
    if (!teleportLoading.hidden && event.target !== element('teleport-reload')) return;
    if (signEditor.open) return;
    if ((event.code === 'F5' || event.code === 'KeyY' || event.code === 'KeyU') && playing && !menuOpen()) {
      event.preventDefault();
      if (!spectator && !event.repeat) {
        if (event.code === 'KeyU') toggleOrbit();
        else {
          if (orbitHeading) toggleOrbit();
          view.cyclePerspective();
          updateCameraHint();
        }
      }
      return;
    }
    if (creative.keydown(event) || creative.isOpen()) return;
    if (social.keydown(event, playing)) return;
    if (event.code === 'Enter' && entered && !playing && !menuOpen()) {
      event.preventDefault();
      if (!event.repeat) button.click();
      return;
    }
    if (event.code === 'KeyP' && playing && !menuOpen()) {
      event.preventDefault();
      if (!event.repeat) toggleSpectator();
      return;
    }
    if (event.code === 'Escape' && entered) {
      event.preventDefault();
      if (!event.repeat) {
        if (playing) {
          pause();
          setPlaying(false);
        } else if (performance.now() - pointerReleasedAt > 150) {
          resumeOnEscape = true;
        }
      }
      return;
    }
    if (!playing || orbitHeading) return;
    if (event.code === 'KeyI' && !event.repeat && !creativeToggle.disabled) {
      event.preventDefault();
      creative.open();
      return;
    }
    if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.code)) event.preventDefault();
    keys.add(event.code);
    if (event.repeat) return;
    if (event.code === 'Space') jump = true;
    if (spectator) return;
    if (event.code === 'KeyF' && !resetting && !seat) setFlight(!flying);
    if (event.code === 'KeyV' && !resetting && !acting) toggleChisel();
    if (event.code === 'KeyB') toggleChiselSize();
    if (event.code === 'KeyX') clearHeld();
    if (event.code === 'KeyQ') action('copy');
    if (event.code === 'KeyR') cyclePlacement();
    if (event.code === 'KeyE') {
      event.preventDefault();
      interact(event.shiftKey);
    }
  });
  document.addEventListener('keyup', event => {
    keys.delete(event.code);
    social.keyup(event);
    if (event.code === 'Escape' && resumeOnEscape) {
      resumeOnEscape = false;
      resume();
    }
  });
  document.addEventListener('mouseup', event => { if (event.button === 2) repeatPlacement = false; });
  window.addEventListener('blur', () => {
    repeatPlacement = resumeOnEscape = resuming = false;
    keys.clear();
    social.blur();
  });
  canvas.addEventListener('mousedown', event => {
    if (touchMode || menuOpen()) return;
    if (!playing) {
      if (entered && event.button === 0) button.click();
      return;
    }
    if (document.pointerLockElement !== canvas) { resume(); return; }
    if (orbitHeading) return;
    if (event.button === 2) {
      repeatPlacement = !spectator;
      nextPlacement = performance.now() + 350;
      action('place');
    }
    if (event.button === 0) action('remove');
    if (event.button === 1) action('copy');
  });
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  element('teleport-reload').addEventListener('click', () => location.reload());
  element('sign-form').addEventListener('submit', saveSign);
  element('sign-cancel').addEventListener('click', closeSign);
  signEditor.addEventListener('cancel', event => { event.preventDefault(); closeSign(); });

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
  element('touch-place').addEventListener('click', () => action('place'));
  element('touch-use').addEventListener('click', () => interact());
  for (const [id, command] of [['touch-copy','copy'], ['touch-remove','remove']]) {
    element(id).addEventListener('click', () => action(command));
  }
  touchRotate.addEventListener('click', cyclePlacement);
  touchChisel.addEventListener('click', () => { if (!resetting && !acting) toggleChisel(); });
  element('jump').addEventListener('pointerdown', () => { jump = true; });
  element('detail-distance').addEventListener('change', event => {
    const distance = Number(event.target.value);
    view.setDetailedLodDistance(distance).then(() => {
      localStorage.setItem('honeymoon-detail-distance', String(distance));
    }).catch(error => notice(error.message));
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
        await arriveAt(body.position);
        setFlight(spectator);
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

async function addChunk([x, z], visualOnly = false, isNeeded, signal) {
  const chunk = await json(`/generated/world/chunks/${x}.${z}.json`, {signal});
  if (isNeeded && !isNeeded()) return;
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

function streamNearby(chunks, scenery) {
  const playable = new Set(chunks.map(([x, z]) => chunkKey(x, z)));
  const visual = new Set(scenery.map(([x, z]) => chunkKey(x, z)));
  const inFlight = new Map();
  const retryAt = new Map();
  let area, planned = [];

  function status() {
    const missing = planned.filter(({key}) => !world.chunks.has(key)).length;
    return {...area, loading:inFlight.size, missing, ready:!missing && view.streamSettled()};
  }

  function updateArea() {
    const x = Math.floor(position.x / 16), z = Math.floor(position.z / 16);
    const radius = view.detailedDistance + 1;
    if (area?.x === x && area.z === z && area.radius === radius) return;
    area = {x, z, radius};
    view.streamAround(x, z, radius);
    for (const {coordinate, controller} of inFlight.values()) {
      if (!needed(coordinate)) controller.abort();
    }
    const expired = [...world.chunks.values()].filter(chunk => distanceToChunk([chunk.x, chunk.z]) > radius + 1);
    world.removeChunks(expired);
    view.removeChunks(expired);
    planned = [];
    for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
      const coordinate = [x + dx, z + dz];
      const key = chunkKey(...coordinate);
      const visualOnly = !playable.has(key);
      if (visualOnly && !visual.has(key) || world.chunks.has(key)) continue;
      planned.push({coordinate, key, visualOnly, distance:Math.max(Math.abs(dx), Math.abs(dz)), order:dx * dx + dz * dz});
    }
    planned.sort((a, b) => a.distance - b.distance || Number(a.visualOnly) - Number(b.visualOnly) || a.order - b.order);
    const wanted = new Set(planned.map(entry => entry.key));
    for (const key of retryAt.keys()) if (!wanted.has(key)) retryAt.delete(key);
  }

  const needed = coordinate => distanceToChunk(coordinate) <= area.radius;
  async function run() {
    while (!view.workerFailure) {
      updateArea();
      const now = performance.now();
      const next = planned.find(({key}) => !inFlight.has(key) && !world.chunks.has(key) && (retryAt.get(key) ?? 0) <= now);
      if (!next) {
        await new Promise(resolve => setTimeout(resolve, 80));
        continue;
      }
      const controller = new AbortController();
      inFlight.set(next.key, {coordinate:next.coordinate, controller});
      try {
        await view.waitForStreamSlot(!next.visualOnly && needed(next.coordinate) && next.distance <= 2);
        updateArea();
        if (!controller.signal.aborted) {
          await addChunk(next.coordinate, next.visualOnly, () => needed(next.coordinate),
            AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
        }
        retryAt.delete(next.key);
      } catch (error) {
        if (view.workerFailure) throw error;
        if (!controller.signal.aborted) {
          retryAt.set(next.key, performance.now() + 1500);
          console.error(error);
        }
      } finally {
        inFlight.delete(next.key);
      }
    }
  }
  return {status, update:updateArea, done:Promise.all([run(), run()])};
}

async function start() {
  const [manifest, session] = await Promise.all([json('/generated/world/world.json'), post('session', {})]);
  if (!session.ok) throw new Error('Сеанс не создан');
  creativeAvailable = session.body.creative;
  profile.initialize(session.body.profile);
  if (session.body.sounds) {
    audio.load().then(loaded => {
      element('audio-toggle').hidden = !loaded;
      element('music-toggle').hidden = !loaded;
    }).catch(error => console.error(error));
  }
  world = new World(manifest);
  world.boatTexture = session.body.boatTexture === true;
  world.models = Object.fromEntries(await Promise.all((session.body.modelFamilies ?? []).map(async family =>
    [family, await json(`/generated/models/${family}.json`)])));
  const p = session.body.position;
  const [x, y, z] = session.body.spawn || manifest.spawn;
  position = p ? {...p} : {x, y, z};
  confirmedPosition = positionTuple(position);
  movement = new Movement(world);
  view = new Display(surface, world, session.body.dayTick);
  view.setLocalSkin(profile.confirmed.skin);
  if (new URLSearchParams(location.search).get('occlusion') === '1') view.setOcclusion(true);
  if (session.body.seat) setSeat(session.body.seat, p);
  if (session.body.spectator) setSpectator(true);
  if (session.body.time) view.setWorldTime(session.body.time);
  view.onError = error => { notice('Ошибка построения участка карты'); console.error(error); };
  updateCamera();
  const farSupported = supportsFarTerrain(manifest) && manifest.lod.maxDistance === 32;
  const distance = element('detail-distance');
  const savedDetail = Number(localStorage.getItem('honeymoon-detail-distance'));
  if ([...distance.options].some(option => Number(option.value) === savedDetail)) distance.value = String(savedDetail);
  distance.disabled = !farSupported;
  await Promise.all([view.loadTextures(), refresh()]);
  await view.prepareGraphics();
  bindControls();
  stream();
  requestAnimationFrame(tick);
  globalThis.honeymoon = Object.freeze({
    stats: () => ({...metrics, ...view.statistics(), residentChunks:world.chunks.size, streaming:nearbyStream?.status(),
      revision: worldRevision, position: {...position}, seat, audio:audio.stats(),
      flying, spectator, chiseling, chiselMaterial, chiselSize, perspective:cameraMode(),
      movementSync: {...positionMetrics, queued: positionTrail.length, confirmed: [...confirmedPosition]},
      renderer: view.renderer.getContext().getParameter(view.renderer.getContext().RENDERER)}),
    look: (yaw, pitch = 0) => { heading.yaw = yaw; heading.pitch = pitch; updateCamera(); },
    perspective: cameraMode,
    localAvatar: () => view.inspectLocalAvatar(),
    setOcclusion: enabled => view.setOcclusion(enabled),
    target: () => selection && {...selection},
    placement: () => placement && {...placement},
    setDistance: distance => view.setDistance(distance),
    setDetailedDistance: distance => view.setDetailedLodDistance(distance),
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
  const horizon = farSupported ? view.setDetailedLodDistance(Number(distance.value)) : view.setDistance(4);
  horizon.catch(console.error);
  if (manifest.chunkPalettes) nearbyStream = streamNearby(manifest.chunks, manifest.visualChunks ?? []);
  const pending = nearbyStream?.done ?? streamChunks(manifest.chunks.filter(chunk => !buffered.includes(chunk)), manifest.visualChunks ?? []);
  pending.catch(console.error);
}

start().catch(error => {
  console.error(error);
  loading.textContent = 'Ошибка загрузки. ' + error.message;
});
