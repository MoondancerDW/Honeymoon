import {Display} from './display.mjs';
import {Movement, EYE, movementSpeed, overlapsPlacement, pick, pickItemFrame, pickVehicle} from './movement.mjs';
import {World, chunkKey, json} from './world-data.mjs';
import {WorldAudio,audioDefaults} from './audio.mjs';
import {windAt} from './wind.mjs';
import {PlayerProfile, skinDescription, skinTooLarge} from './player-profile.mjs';
import {createSocialHud} from './social-hud.mjs';
import {createCreativeMenu} from './creative-menu.mjs';
import {createItemDocuments} from './item-documents.mjs';
import {createContainerMenu} from './container-menu.mjs';
import {createAccessUi} from './access-ui.mjs';
import {createAdminUi} from './admin-ui.mjs';
import {createNpcUi} from './npc-ui.mjs';
import {createWorldEdit,isWoodAxe} from './world-edit.mjs';
import {renderCreativeIcon} from './creative-icons.mjs';
import {renderInventoryPreview} from './inventory-preview.mjs';
import {blockState, jammyUseSound} from '../world/block-interactions.mjs';
import {seatFor, SEATED_EYE, SEATED_HEIGHT} from '../world/seats.mjs';
import {extractedModel, isJammyConnectableSeat, placementModelObject} from '../world/extracted-models.mjs';
import {jammyBenchState} from '../world/jammy-benches.mjs';
import {CRAWL_SPEED,FLIGHT_VERTICAL_MULTIPLIER,POSITION_TRAIL_LIMIT,playerBody} from '../world/player-body.mjs';
import {isMicroblockCell, microblockPlacement, partBoxesOverlapBox, publicMicroPart} from '../world/microblocks.mjs';
import {minecartSeat} from '../world/minecarts.mjs';
import {boatSeat} from '../world/boats.mjs';
import {canLogLiquid, liquidKind} from '../world/logged-fluid.mjs';
import {FAKE_WATER,bucketCell,bucketKeys,fluidState} from '../world/fluid-state.mjs';
import {detailCoverage} from '../world/full-detail.mjs';
import {bookType,plainMinecraftText,stackRevision} from '../world/item-text.mjs';
import {containerSpec} from '../world/containers.mjs';
import {chiselMaterialShape, coverBoxes, signFor} from '../world/geometry.mjs';
import {creativeMicroblock} from '../world/creative-items.mjs';
import {isChiselMaterial, voxelBrush, voxelKey, voxelMaterialAt, voxelRemovalBrush, VOXEL_MATERIAL_LIMIT} from '../world/voxel-chisel.mjs';
import {chiselMaterialKey, chiselPlacementAtHit, chiselVoxelAtHit} from '../world/chisel-surface.mjs';
import {positionBatch} from './position-packet.mjs';
import {supportsFarTerrain} from './far-terrain.mjs';
import {bindTouchControls} from './touch-controls.mjs';
import {createPlayerModeUi} from './player-mode-ui.mjs';

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
const inventoryToggle = element('inventory-toggle');
const microHint = element('micro-hint');
const touchRotate = element('touch-rotate');
const chiselHint = element('chisel-hint');
const touchChisel = element('touch-chisel');
const signEditor = element('sign-editor');
const signFields = [...element('sign-form').querySelectorAll('input')];
const signStatus = element('sign-status');
const signSave = element('sign-save');
const audioSettings = element('audio-settings');
const teleportLoading = element('teleport-loading');
const keys = new Set();
const touchMode = matchMedia('(pointer: coarse)').matches;
const detailPreference=touchMode?'honeymoon-touch-detail-distance':'honeymoon-detail-distance';
const lowDevicePreference='honeymoon-low-device';
const heading = {yaw: 0, pitch: -.045};
let orbitHeading = null, orbitReturn = 0;
const stick = {x: 0, z: 0};
let world, view, movement, position, selection, clipboard, worldRevision = 0;
let heldPart = null, heldPonyPart, partRotation = 0, placement = null, placementKey = '';
let heldSofa = null, sofaTurns = 0;
let chiseling = false, chiselMaterial = null, chiselSize = 1;
let heldVersion = 0;
let fromCreative = false;
let heldCreativeItem = null;
let creativeAvailable = false;
const creativeNames = new Map();
const creativeEntries = new Map();
let catalogRequest, inventoryRequest = Promise.resolve();
let inventory = {slots:Array(36).fill(null),selected:0};
let emote=null;
let heldSignature = '';
let selectionInputs, selectionRevision = 0;
let seatTarget = null;
let frameTarget = null, rayFrameTarget;
let npcTarget, npcEditorAvailable = false;
const npcBards=new Map();
let nextBardCheck=0;
let npcActionQueue=Promise.resolve();
const positionInterval = 130;
const mobileFrameMs = 1000/32;
let nextMobileFrame;
const positionMetrics = {requests: 0, corrections: 0, errors: 0};
const positionTrail = [];
let playing = false, jump = false, lastFrame = 0, nextPositionSync = 0, timer;
let flying = false;
let crawlRequested = false, confirmedStance = 'stand';
let spectator = false, spectatorReturn = null;
let seat = null, seatPending = false, seatEpoch = 0;
let seatedMoveSince;
let signTarget;
let sync = null, pendingPosition = null, confirmedPosition, retryCount = 0, acting = false, resetting = false;
let arrivalVersion = 0;
let metrics = {started: performance.now(), playable: 0, chunksLoaded: 0, visualChunksLoaded: 0, lastEdit: 0};
let feed;
let nearbyStream;
let entered = false, presenceDirty = true, presenceRequest = null, lastSentPose, nextPresence = 0;
let horizontalSpeed = 0;
let nextSprintDust = 0;
let crouchUntil = 0;
let hoofSwing = 0;
let repeatPlacement = false, nextPlacement = 0, resumeOnEscape = false, resuming = false;
let pointerReleasedAt = -Infinity;
let touchControls;
let hitPlayer, deathOrbit;
let nextClockUpdate = 0;
const audio = new WorldAudio();
const profile = new PlayerProfile({nickname:element('nickname'), skin:element('pony-skin'), status:element('skin-status'),
  clear:element('clear-skin'), label:element('player-name')}, notice);
const accessUi=createAccessUi({element,post});
const pause = () => {
  repeatPlacement = false;
  keys.clear();
  jump = false;
  stick.x = stick.z = 0;
  touchControls?.clear();
  if (document.pointerLockElement) document.exitPointerLock();
};
function resume() {
  if (touchMode || !view || !entered) return;
  const canvas = view.renderer.domElement;
  if (document.pointerLockElement === canvas || resuming) return;
  resuming = true;
  audio.enable();
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
const social = createSocialHud({post, notice, pause, resume, teleport, placeWarp,
  worldEditCommand:command=>worldEdit.command(command),
  loadWarps:()=>json('/api/warps',{signal:AbortSignal.timeout(5000)})});
const inventoryStackAt=slot=>slot<36 ? inventory.slots[slot] : inventory.equipment?.[slot-36];
const itemDocuments=createItemDocuments({stackAt:inventoryStackAt,act:inventoryAction,pause,resume});
const storage=createContainerMenu({action:containerAction,entryFor:entryForInventoryStack,
  draw:drawCreativeIcon,inventory:()=>inventory,pause,resume});
const npcUi=createNpcUi({command:npcCommand,onTeleport:receiveNpcTeleport,
  loadEditor:()=>getNpc('/api/npcs/editor'),edit:payload=>post('npcs/editor',payload,AbortSignal.timeout(10000)),
  unlock:key=>post('npcs/admin',{key},AbortSignal.timeout(5000)),
  loadModels:()=>import('../world/npc-model-catalog.mjs').then(module=>module.loadNpcModelManifest()),
  loadCatalog:loadCreative,entryFor:npcItemEntry,drawItem:drawCreativeIcon,inventory:()=>inventory,
  position:()=>position,preview:(canvas,appearance)=>view.npcs?.preview(canvas,appearance,performance.now()),
  clearPreview:canvas=>view.npcs?.clearPreview(canvas),pause,resume,notice});
const modeUi=createPlayerModeUi({element,notice,pause,changed:updateGameMode,revive:revivePlayer,
  fetchModes:()=>json('/api/modes',{signal:AbortSignal.timeout(5000)}),
  changeMode:fields=>post('modes',fields,AbortSignal.timeout(5000)),
  async craft(recipe) {
    const result=await post('craft',{recipe},AbortSignal.timeout(5000));
    if (result.ok) applyInventory(result.body.inventory);
    return result;
  }});
const adminUi=createAdminUi({element,load:()=>getNpc('/api/admin/access'),
  async post(path,fields) {
    if (path==='admin/teleport' && fields.direction==='bring' && !await flushPosition()) {
      return {ok:false,body:{error:'movement_blocked'}};
    }
    return post(path,fields,AbortSignal.timeout(10000));
  },pause,teleport:receiveAdminTeleport,
  worldSettings:()=>({
    weather:view.weather,weatherChanged:updateWeather,
    open(section) {element({npcs:'npc-editor-toggle',modes:'mode-toggle',clock:'clock-toggle'}[section]).click();},
  }),
});
const worldEditEnabled=()=>modeUi.active && modeUi.creative && modeUi.admin && !spectator;
const worldEdit=createWorldEdit({
  scene:()=>view.scene,enabled:worldEditEnabled,getState:()=>getNpc('/api/worldedit'),
  send:async payload=>{
    if (!await flushPosition()) return {ok:false,body:{error:'movement_blocked'}};
    return post('worldedit',{...payload,eye:view.eyeOffset()},AbortSignal.timeout(12000));
  },
  apply:body=>{changes(body.changes,body.worldRevision,body.frames); effects(body);},
  notice,
});
const wieldWorldEdit=()=>worldEditEnabled() && isWoodAxe(inventoryStackAt(inventory.selected));
const creative = createCreativeMenu({load:loadCreative,
  choose:(entry,slot,count)=>inventoryAction('inventory_give',{key:entry.key,slot,count}),
  select:slot=>inventoryAction('inventory_select',{slot}),
  move:(from,to,count)=>inventoryAction('inventory_move',{from,to,count}),
  clone:(from,to,count)=>inventoryAction('inventory_clone',{from,to,count}),
  trash:slot=>inventoryAction('inventory_trash',{slot}),
  drop:fields=>inventoryAction('drop_item',{...fields,yaw:heading.yaw,eye:view.eyeOffset()}),
  preview:(canvas,equipment)=>renderInventoryPreview(canvas,equipment,view?.localSkin),
  editItem:itemDocuments.openItem,readBook:itemDocuments.openBook,
  canCopy:()=>modeUi.creative,
  pause() { social.close(false); pause(); }, resume, notice, icon:drawCreativeIcon});
const menuOpen = () => social.isOpen() || creative.isOpen() || signEditor.open || audioSettings?.open ||
  itemDocuments.isOpen() || storage.isOpen() || npcUi.isOpen() || modeUi.isOpen() || adminUi.isOpen();

function updateGameMode(next) {
  creativeToggle.disabled=spectator||!creativeAvailable||!modeUi.creative;
  creativeToggle.hidden=modeUi.active&&!modeUi.creative;
  element('touch-catalog').hidden=modeUi.active&&!modeUi.creative;
  element('touch-copy').hidden=modeUi.active&&!modeUi.creative;
  element('weather').disabled=modeUi.active&&!next.admin;
  social.setAdmin(!modeUi.active||next.admin);
  game.classList.toggle('dead',Boolean(next.death));
  if (!view) return;
  if (next.death&&!deathOrbit) {
    deathOrbit={perspective:view.perspective,heading:orbitHeading};
    orbitHeading={...heading,pitch:-.22};
    view.perspective=1;
    keys.clear();
    jump=repeatPlacement=false;
    touchControls?.clear();
    setFlight(false);
    Object.assign(position,next.death.position);
    if (document.pointerLockElement) document.exitPointerLock();
    setPlaying(true);
    updateCameraHint();
  } else if (!next.death&&deathOrbit) {
    view.perspective=deathOrbit.perspective;
    orbitHeading=deathOrbit.heading;
    deathOrbit=null;
    updateCameraHint();
  }
}

async function revivePlayer() {
  if (resetting) return;
  resetting=true;
  if (!touchMode) resume();
  try {
    await sync;
    const {ok,body}=await post('respawn',{},AbortSignal.timeout(5000));
    if (!ok) throw new Error(body.error);
    await arriveAt(body.position,body.stance);
    modeUi.update(body.gameMode);
  } finally {resetting=false;}
}

function npcItemEntry(stack) {
  const key=stack.key??(Number.isInteger(stack.id)?'creative:'+stack.id+':'+(stack.damage??stack.meta??0):null);
  return key?entryForInventoryStack({...stack,key}):null;
}

function entryForInventoryStack(stack) {
  if (!stack) return null;
  const known=creativeEntries.get(stack.key);
  const [,id,meta]=stack.key.split(':');
  const identity=Number(id);
  return known ?? {key:stack.key,id:identity,damage:Number(meta),name:stack.name??(stack.cell?
    labelFor(stack.cell):Number.isFinite(identity)?`Предмет ${identity}`:stack.key),part:stack.part,
    ...(stack.part&&{kind:'microblock'}),...(stack.cell&&{blockKey:stack.cell})};
}

async function loadCreative() {
  catalogRequest ??= json('/generated/creative/catalog.json').then(catalog=>{
    for (const entry of catalog.entries) if (entry.key) {
      creativeEntries.set(entry.key,entry);
      if (entry.name) creativeNames.set(entry.key,entry.name);
    }
    return catalog;
  }).catch(error=>{catalogRequest=undefined; throw error;});
  return catalogRequest;
}

function inventoryAction(type,fields = {}) {
  const run = inventoryRequest.then(async()=>{
    if (['drop_item','pickup_item'].includes(type) && !await flushPosition()) return false;
    const result = await postAction({requestId:requestId(),type,...fields});
    if (!result.ok) {
      applyInventory(result.body.inventory);
      if (result.body.error !== 'no_dropped_item') notice(messages[result.body.error] || result.body.error);
      return false;
    }
    applyInventory(result.body.inventory);
    return true;
  }).catch(error=>{console.error(error); notice('Не удалось обновить инвентарь'); return false;});
  inventoryRequest = run;
  return run;
}

async function containerAction(type,target,fields={}) {
  if (type==='container_open'&&!await flushPosition()) return {ok:false,body:{error:'movement_blocked'}};
  const {x,y,z,hit}=target;
  const result=await postAction({type,requestId:requestId(),x,y,z,hit,eye:view.eyeOffset(),
    expectedRevision:world.revisionAt(x,y,z),...fields});
  const body=result.body;
  if (result.ok) {
    changes(body.changes,body.worldRevision,body.frames);
    applyInventory(body.inventory);
    effects(body);
  } else {
    body.message=messages[body.error]??body.error;
    if (type==='container_open') notice(body.message);
  }
  return result;
}

function applyInventory(value) {
  if (!value || !Array.isArray(value.slots)) return;
  inventory = value;
  creative.setInventory(value);
  const stack = value.slots[value.selected];
  const signature = `${stackRevision(stack)}:${Boolean(stack?.copied)}`;
  if (signature === heldSignature) return;
  heldSignature = signature;
  const entry = stack && (creativeEntries.get(stack.key) ??
    (stack.key.startsWith('creative:')?{...entryForInventoryStack(stack),kind:'flat-item'}:null));
  heldVersion++;
  fromCreative = Boolean(stack && !stack.copied);
  heldCreativeItem = entry?.kind && !stack.copied ? entry : null;
  clipboard = stack?.part ? null : stack?.cell ?? bucketCell(stack?.key);
  heldSofa = isJammyConnectableSeat(world.models?.jammy,clipboard) ? {object:stack.object} : null;
  sofaTurns = 0;
  chiselMaterial = isChiselMaterial(clipboard) ? chiselMaterialKey(clipboard) : null;
  if (chiseling) toggleChisel();
  setHeldPart(entry?.kind === 'microblock' && !stack.copied ? creativeMicroblock(entry) :
    stack?.part ? {...stack.part,pattern:stack.pattern} : null);
  presenceDirty = true;
}

async function drawCreativeIcon(entry, canvas) {
  return renderCreativeIcon(entry,canvas,world?.models);
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
  admin_required:'Это действие доступно администратору', creative_only:'Предметы из каталога доступны в креативе',
  tool_required:'Нужен подходящий инструмент', held_item_required:'Выбери нужный предмет в панели',
  bucket_required:'Для удаления жидкости нужно ведро', player_dead:'Сначала нажми «Ожить»',
  occupied: 'Здесь уже есть блок или игрок', stale_cell: 'Ячейка изменилась. Повторите действие.',
  out_of_reach: 'Цель вне досягаемости', not_visible: 'Блок закрыт', outside_bounds: 'Граница района',
  reserved: 'Это часть контрольной механики', nothing_to_copy: 'Сначала скопируйте блок',
  empty_cell: 'В ячейке нет блока', cannot_interact: 'С этим объектом нельзя взаимодействовать',
  movement_blocked: 'Позиция скорректирована сервером', outside_reach: 'Цель вне досягаемости',
  block_not_owned: 'Исходный блок карты защищён', part_not_owned: 'Исходные детали карты защищены',
  part_missing: 'Деталь уже убрана', invalid_part: 'Эта форма или материал недоступны',
  part_required: 'Наведите прицел на отдельную деталь',
  incompatible_part: 'Деталь здесь не помещается',
  voxel_required: 'Нажмите Z, чтобы взять резец',
  voxel_not_owned: 'Резцом можно менять блоки, установленные игроками',
  invalid_voxel: 'Наведите прицел на нужную часть блока',
  invalid_material: 'Резец берёт материал с полного блока, жидкости или уже вырезанной части',
  voxel_material_limit: 'В кубе уже слишком много разных материалов',
  outside_playable_area: 'Граница района', protected_cell: 'Это часть контрольной механики',
  no_interaction: 'С этим объектом нельзя взаимодействовать',
  stale_container: 'Хранилище изменилось. Повторите действие',
  not_a_container: 'Хранилище больше недоступно',
  wrong_container_item: 'Этот предмет не подходит для ячейки',
  stale_inventory_item: 'Предмет изменился. Откройте его снова',
  invalid_item_text: 'Проверьте текст предмета',
  book_already_signed: 'Книга уже подписана',
  not_a_seat: 'На этот блок нельзя сесть', seat_taken: 'Место уже занято',
  seat_blocked: 'Над сиденьем недостаточно места',
  seat_requires_ground: 'Сесть можно на твёрдую поверхность',
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
  drain_liquid_first: 'Сначала уберите воду или лаву',
  incompatible_liquid: 'Здесь нет места для жидкости',
  liquid_missing: 'Здесь больше нет жидкости',
  invalid_equipment: 'Этот предмет нельзя надеть в эту ячейку',
  missing_support: 'Для этого блока нужна твёрдая опора',
  empty_inventory_slot: 'Активная ячейка пуста',
  inventory_full: 'В инвентаре нет места',
  occupied_inventory_slot: 'Освободите ячейку для этой стопки',
  too_many_dropped_items: 'Рядом слишком много выброшенных предметов',
  drop_obstructed: 'Здесь нельзя выбросить предмет',
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

async function getNpc(path) {
  const response=await fetch(path,{signal:AbortSignal.timeout(8000)});
  return {ok:response.ok,body:await response.json()};
}

function applyNpcs(payload) {
  if (!payload || !Array.isArray(payload.npcs)) return;
  npcBards.clear();
  for (const npc of payload.npcs) if (npc.bard?.sound) npcBards.set(npc.id,npc);
  view.npcs?.replace(payload.npcs);
  npcEditorAvailable=payload.editorAvailable!==false;
  npcUi.setAvailable(entered && npcEditorAvailable);
  npcUi.setAccess(payload.editor);
}

function moveNpcs({updates}) {
  if (!Array.isArray(updates)) return;
  for (const update of updates) {
    const bard=npcBards.get(update.id);
    if (bard) npcBards.set(update.id,{...bard,...update});
  }
  view.npcs?.motion(updates);
}

async function refreshNpcs() {
  try {
    const {ok,body}=await getNpc('/api/npcs');
    if (ok) applyNpcs(body);
  } catch (error) {console.warn('Не удалось обновить список NPC',error);}
}

function npcCommand(npcId,action,parameters={}) {
  const request=npcActionQueue.then(async()=>{
    if (resetting || seatPending) return {ok:false,body:{error:'action_pending'}};
    if (!await flushPosition()) return {ok:false,body:{error:'movement_blocked'}};
    const result=await post('npcs/action',{npcId,action,eye:view.eyeOffset(),...parameters},AbortSignal.timeout(8000));
    if (result.ok) applyInventory(result.body.inventory);
    return result;
  });
  npcActionQueue=request.catch(()=>{});
  return request;
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
    if (effect.type === 'break') view.breakBlock(effect);
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
  if (changed.length) storage.changed(changed);
  if (seat?.kind === 'ground' && changed.length) presenceDirty = true;
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
  applyInventory(snapshot.inventory);
  if (snapshot.droppedItems) world.setDroppedItems(snapshot.droppedItems,performance.now());
}

function stream() {
  feed = new EventSource('/api/events?since=' + worldRevision + '&presence=1&social=1&minecarts=1&droppedItems=1&npcs=1');
  feed.addEventListener('open', () => { presenceDirty = true; social.refreshWarps(); });
  feed.addEventListener('presence', event => {
    const {players, selfOnline} = JSON.parse(event.data);
    view.players.replace(players);
    social.roster(players, selfOnline && profile.confirmed);
  });
  feed.addEventListener('presence-motion', event => view.players.update(JSON.parse(event.data).players));
  feed.addEventListener('npcs',event=>applyNpcs(JSON.parse(event.data)));
  feed.addEventListener('npc-motion',event=>moveNpcs(JSON.parse(event.data)));
  feed.addEventListener('dropped-items',event=>world.setDroppedItems(JSON.parse(event.data).entities,performance.now()));
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
  feed.addEventListener('weather',event=>updateWeather(JSON.parse(event.data).mode));
  feed.addEventListener('game-mode',event=>modeUi.update(JSON.parse(event.data)));
  feed.addEventListener('access-revoked',()=>location.reload());
  feed.addEventListener('admin-teleport',event=>{
    receiveAdminTeleport(JSON.parse(event.data)).catch(error=>notice(error.message));
  });
  feed.addEventListener('warps',event=>social.warpsChanged(JSON.parse(event.data)));
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
  if (item?.kind === 'shaped-lamp') return {kind:'block',key:item.key};
  if (item && ['flat-item','item-frame','minecart','boat'].includes(item.kind)) {
    return {kind:'item', key:`${item.id}:${item.invisible ? 0 : item.damage ?? 0}`};
  }
  const partKey = heldPart ? `cover-material:${heldPart.material}` : null;
  const key = chiseling ? chiselMaterial : partKey ?? clipboard;
  return key && /^(?:legacy|cover-material):[\d:]+$/.test(key)
    ? {kind:'block',key,...(!chiseling && heldPonyPart && {part:heldPonyPart})} : null;
}

function playerPose() {
  const motion = seat ? 'sit' : !playing ? 'idle' : flying ? 'fly' : movement.stance === 'swim' ? 'swim' :
    !movement.grounded && !movement.medium && movement.stance === 'stand' ? 'air' : horizontalSpeed > .15 ?
      (sprinting() && movement.stance === 'stand' ? 'run' : 'walk') : 'idle';
  return {yaw: Math.atan2(Math.sin(heading.yaw), Math.cos(heading.yaw)), pitch:heading.pitch, motion,
    stance:seat?.bed ? 'crawl' : movement.stance, boost:!seat && flying && playing && sprinting(), eye:view.eyeOffset(),
    typing:social.isChatOpen(), swing:hoofSwing, held:heldPonyItem(), groundSeat:seat?.kind === 'ground',
    equipment:inventory.equipment,emote,
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
  const changed = !lastSentPose || pose.motion !== lastSentPose.motion || pose.stance !== lastSentPose.stance || pose.boost !== lastSentPose.boost ||
    pose.typing !== lastSentPose.typing || pose.swing !== lastSentPose.swing ||
    pose.emote?.id!==lastSentPose.emote?.id || pose.emote?.started!==lastSentPose.emote?.started ||
    pose.held?.key !== lastSentPose.held?.key || pose.held?.kind !== lastSentPose.held?.kind ||
    pose.held?.part !== lastSentPose.held?.part ||
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
      if (epoch === seatEpoch && !acting && !resetting && Boolean(body.seat) !== Boolean(seat)) {
        setSeat(body.seat, body.position,body.stance);
      }
    }
    else presenceDirty = true;
  }).catch(() => { presenceDirty = true; }).finally(() => { presenceRequest = null; });
}

function updateCamera() {
  const stance = seat?.bed ? 'crawl' : movement.stance;
  const lowCeiling = !spectator && stance !== 'stand' ? playerBody(movement.size,stance).height : undefined;
  const focus=modeUi.death ? {...position,y:position.y-(view.localAvatar?.ragdollDrop??0)} : position;
  view.updateCamera(focus,orbitHeading ?? heading,modeUi.death?.position ? .55 : seat ? SEATED_EYE : EYE,lowCeiling);
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

function enterWorld() {
  entered = true;
  presenceDirty = true;
  creativeToggle.disabled = spectator || !creativeAvailable || !modeUi.creative;
  inventoryToggle.disabled = spectator;
  npcUi.setAvailable(npcEditorAvailable);
  element('weather').disabled = modeUi.active&&!modeUi.admin;
}

function setPlaying(active) {
  playing = active;
  if (active && !entered && !button.disabled) enterWorld();
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
  if (active && !spectator && movement.stance !== 'stand') {
    const stance = movement.setStance(position,'stand');
    if (stance !== 'stand') return;
    crawlRequested = false;
    recordPosition(position);
  }
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
  creativeToggle.disabled = active || !creativeAvailable||!modeUi.creative;
  inventoryToggle.disabled = active;
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
    if (body.relocated) await arriveAt(body.position,body.stance);
    else setSeat(null, body.position,body.stance);
  } catch {
    notice('Связь с сервером прервалась');
  } finally {
    resetting = false;
  }
}

const positionTuple = ({x, y, z}) => [x, y, z];

function recordPosition(feet) {
  const sample = [...positionTuple(feet),movement.stance];
  const previous = positionTrail.at(-1) ?? [...confirmedPosition,confirmedStance];
  if (sample.some((value, axis) => value !== previous[axis])) positionTrail.push(sample);
}

function setAuthoritativePosition(feet, stance = 'stand') {
  Object.assign(position, feet);
  view?.viewBob.reset();
  confirmedPosition = positionTuple(feet);
  confirmedStance = movement.stance = stance;
  crawlRequested = stance === 'crawl' && !seat;
  positionTrail.length = 0;
  pendingPosition = null;
  movement.fall = 0;
  movement.grounded = false;
}

function setSeat(next, feet, stance) {
  seatEpoch++;
  seat = next;
  setAuthoritativePosition(feet,stance);
  game.classList.toggle('seated', Boolean(seat));
  const status = element('seat-status');
  status.hidden = !seat;
  status.textContent = seat?.kind === 'boat' ? (touchMode ? 'Лодка · стик — управление · Действие — выйти' :
    'Лодка · WASD или стрелки · E — выйти') : seat?.entity ? (touchMode ? 'Вагонетка · стик — движение · Действие — встать' :
      'Вагонетка · W/S или ↑/↓ — движение · E — встать') : seat?.bed ? 'Лежите · E — встать' :
    seat?.kind === 'ground' ? 'Сидите · X — встать' : 'Сидите · E — встать';
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
    if (result.ok) await acceptTeleport(result.body);
    return result;
  } finally {
    resetting = false;
  }
}

async function acceptTeleport(body) {
  const arriving=arriveAt(body.position,body.stance);
  if (body.flight===true) setFlight(true);
  changes(body.changes,body.worldRevision,body.frames);
  effects(body);
  presenceDirty=true;
  selectionInputs=null;
  placementKey='';
  await arriving;
}

async function receiveNpcTeleport(body) {
  resetting=true;
  const arrival=acceptTeleport(body),version=arrivalVersion;
  try {await arrival;}
  finally {if (version===arrivalVersion) resetting=false;}
}

const handledAdminTeleports=new Set();
async function receiveAdminTeleport(body) {
  const id=body?.teleportId;
  if (!id || handledAdminTeleports.has(id)) return;
  handledAdminTeleports.add(id);
  if (handledAdminTeleports.size>32) handledAdminTeleports.delete(handledAdminTeleports.values().next().value);
  await receiveNpcTeleport(body);
}

async function placeWarp(title) {
  if (resetting || acting || seatPending) return {ok:false,body:{error:'action_pending'}};
  if (!await flushPosition()) return {ok:false,body:{error:'movement_blocked'}};
  return post('warps',{title},AbortSignal.timeout(5000));
}

async function arriveAt(feet, stance) {
  const version=++arrivalVersion;
  const cx = Math.floor(feet.x / 16), cz = Math.floor(feet.z / 16);
  const visible = world.playableAround(cx,cz,view.detailedDistance);
  const covered = !view.chunksReady(visible);
  teleportLoading.hidden = !covered;
  if (covered) {
    element('teleport-loading-text').textContent = 'Загрузка, подождите...';
    element('teleport-reload').hidden = true;
  }
  setSeat(null, feet,stance);
  nearbyStream?.update();
  if (!covered) return;
  try {
    await view.whenReady(visible);
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (version===arrivalVersion) teleportLoading.hidden = true;
  } catch (error) {
    if (version!==arrivalVersion) return;
    element('teleport-loading-text').textContent = 'Не удалось загрузить локацию';
    element('teleport-reload').hidden = false;
    throw error;
  }
}

async function toggleSeat(ground) {
  const {x, y, z, hit, entity} = seatTarget ?? selection ?? {};
  const target = seat || ground !== undefined ? undefined : {x, y, z, hit, ...(entity && {entity})};
  acting = true;
  seatPending = true;
  seatEpoch++;
  try {
    if (!await flushPosition()) return;
    const {ok, body} = await post('seat', {...playerPose(), target,ground}, AbortSignal.timeout(4000));
    if (ok) setSeat(body.seat, body.position,body.stance);
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
  if (npcTarget && !seat) {npcUi.interact(npcTarget); return;}
  if (seat || seatTarget) return toggleSeat();
  if (frameTarget) return action('interact');
  const cell = selection?.cell;
  if (!sneaking && containerSpec(cell)) {
    acting=true;
    void storage.open(selection).catch(()=>notice('Не удалось открыть хранилище')).finally(()=>{acting=false;});
    return;
  }
  if (seatFor(cell, world.models) && !(sneaking && jammyUseSound(...blockState(cell)))) return toggleSeat();
  const sign = signFor(cell);
  if (!sign) return action('interact', sneaking);
  const {x, y, z, hit} = selection;
  const expectedRevision = world.revisionAt(x, y, z);
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
    // An external teleport can arrive while the preceding position request is still in flight.
    if (pendingPosition !== payload) return;
    if (ok) {
      confirmedPosition = positionTuple(body.position);
      confirmedStance = body.stance ?? payload.trail.at(-1)[3];
      positionTrail.splice(0, payload.trail.length);
      pendingPosition = null;
      if (payload.pose && (!lastSentPose || payload.pose.seq >= lastSentPose.seq)) lastSentPose = payload.pose;
    } else if (body.position) {
      positionMetrics.corrections++;
      if (body.seat) setSeat(body.seat, body.position,body.stance);
      else setAuthoritativePosition(body.position,body.stance);
    } else {
      throw new Error(body.error || 'Position sync failed');
    }
    retryCount = 0;
    effects(body);
  }).catch(() => {
    if (pendingPosition !== payload) return;
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
    if (placement) placement.blocked = Boolean(placement.unavailable) || overlapsPlacement(position,placement,movement.body);
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
    placement.solid !== false && overlapsPlacement(position,placement,movement.body);
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
  if (old?.fluid) unavailable = 'drain_liquid_first';
  else if (old && (!old.voxels && !isMicroblockCell(old) || indices.some(index => voxelMaterialAt(old.voxels, index)) ||
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
  heldPonyPart = part ? publicMicroPart(part) : undefined;
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

function stowHeld() {
  if (!inventory.slots[inventory.selected]) { clearHeld(); return; }
  const empty = inventory.slots.indexOf(null);
  if (empty < 0) { notice(messages.inventory_full); return; }
  if (empty < 9) void inventoryAction('inventory_select',{slot:empty});
  else void inventoryAction('inventory_move',{from:inventory.selected,to:empty});
}

function updateWeather(mode) {
  view.setWeather(mode);
  element('weather').value = view.weather;
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
  chiselHint.textContent = `Резец 1/${8 / chiselSize} · B — сменить размер · ЛКМ — убрать · ПКМ — добавить · O/СКМ — взять материал`;
}

function toggleChiselSize() {
  if (!chiseling || acting) return;
  chiselSize = chiselSize === 1 ? 2 : 1;
  placementKey = '';
  updateChiselHint();
}

function updateSelection() {
  if (!playing || spectator || orbitHeading || modeUi.death) {
    selection = null;
    seatTarget = null;
    frameTarget = null;
    npcTarget = null;
    hitPlayer = null;
    selectionInputs = null;
    return;
  }
  const {x,y,z} = position;
  const {yaw,pitch} = heading;
  const stamp = [x,y,z,yaw,pitch,selectionRevision,metrics.chunksLoaded,chiseling,chiselSize,seat,movement.stance];
  const changed = !selectionInputs || stamp.some((value, index) => value !== selectionInputs[index]);
  const vehicleChanged=changed || world.minecarts.size || world.boats.size || seatTarget;
  if (!vehicleChanged && !view.npcs&&!modeUi.active) return;
  selectionInputs = stamp;
  const cp = Math.cos(pitch);
  const origin = view.sightOrigin(position,seat ? SEATED_EYE : EYE);
  const direction = [-Math.sin(yaw) * cp,Math.sin(pitch),-Math.cos(yaw) * cp];
  if (changed) selection = pick(world, origin, direction, chiseling);
  if (vehicleChanged) seatTarget = pickVehicle(world,origin,direction,selection);
  if (changed) rayFrameTarget = pickItemFrame(world,origin,direction,selection);
  frameTarget = rayFrameTarget;
  if (frameTarget && (seatTarget?.length ?? Infinity) < frameTarget.length) frameTarget = null;
  else if (frameTarget) seatTarget = null;
  npcTarget = !seat && view.npcs?.pick(origin,direction,
    Math.min(6,selection?.length??6,seatTarget?.length??6,frameTarget?.length??6));
  hitPlayer=modeUi.active&&!seat&&view.players.pick(origin,direction,Math.min(4.2,selection?.length??Infinity,
    seatTarget?.length??Infinity,frameTarget?.length??Infinity,npcTarget?.distance??Infinity));
  if (changed && chiseling && chiselSize === 2 && selection?.voxel !== undefined) {
    selection.chiselSize = chiselSize;
    selection.boxes = [voxelRemovalBrush(selection.cell.voxels, selection.voxel, chiselSize).box];
  }
}

async function action(type, sneaking = false, tapTool = false) {
  if (modeUi.death) return;
  if (type==='copy'&&!modeUi.creative) {notice('Копирование доступно в креативе'); return;}
  if (acting || resetting || spectator || !playing) return;
  if (wieldWorldEdit() && (type==='remove' || type==='place' || type==='copy' && tapTool)) {
    repeatPlacement=false;
    await worldEdit.tool(type,selection);
    return;
  }
  if (type==='remove'&&hitPlayer&&!chiseling&&!menuOpen()) {
    acting=true;
    try {
      const result=await post('combat',{target:hitPlayer.id},AbortSignal.timeout(5000));
      if (result.ok&&result.body.hit) {
        hoofSwing=(hoofSwing+1)&0x7fffffff;
        presenceDirty=true;
      }
    } catch {notice('Связь с сервером прервана');}
    finally {acting=false;}
    return;
  }
  if (npcTarget) {
    if (type==='remove' && !chiseling) {
      acting=true;
      try {
        const result=await npcCommand(npcTarget.id,'attack');
        if (!result.ok) notice(messages[result.body.error]??'Не удалось атаковать NPC');
        else {
          hoofSwing=(hoofSwing+1)&0x7fffffff;
          presenceDirty=true;
        }
      } catch {notice('Связь с сервером прервалась');}
      finally {acting=false;}
    }
    return;
  }
  const frame = frameTarget && !chiseling && ['place','remove','interact'].includes(type) ? frameTarget : null;
  if (type==='place' && !frame && !chiseling && bookType(inventoryStackAt(inventory.selected))) {
    itemDocuments.openBook(inventory.selected,{world:true});
    return;
  }
  const placingFrame = !frame && type === 'place' && heldCreativeItem?.kind === 'item-frame';
  const placingCart = !frame && type === 'place' && heldCreativeItem?.kind === 'minecart';
  const placingBoat = !frame && type === 'place' && heldCreativeItem?.kind === 'boat';
  const removingVehicle = type === 'remove' && !chiseling && seatTarget;
  const target = frame || removingVehicle || selection;
  if (!target) return;
  const selectedVersion = heldVersion;
  const cell = getKey(target.cell);
  const bucket = bucketCell(heldCreativeItem?.key);
  const neighbors = (dx,dy,dz) => world.cellAt(target.x+dx,target.y+dy,target.z+dz);
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
  } else if (type === 'place' && heldCreativeItem?.key === bucketKeys.empty && fluidState(target.cell)) {
    type = 'scoop_liquid';
  } else if (type === 'remove' && target.cell?.fluid &&
      (target.liquid || target.cell.voxels || isMicroblockCell(target.cell))) {
    type = 'remove_liquid';
  } else if (type === 'copy' && target.liquid && target.cell?.fluid) {
    type = 'copy_liquid';
  } else if (type === 'place' && !chiseling && clipboard !== FAKE_WATER && liquidKind(clipboard) && canLogLiquid(target.cell,neighbors,world.models)) {
    type = 'place_liquid';
  } else if (type === 'remove' && target.part && !isMicroblockCell(target.cell) && !target.cell?.voxels) {
    type = 'remove';
  } else if (chiseling && target.part && type === 'remove') {
    type = 'remove_part';
  } else if (chiseling && type !== 'interact') {
    if (target.voxel === undefined && !(type === 'place' && target.partSlot !== undefined)) {
      notice(messages.invalid_material);
      return;
    }
    if (type === 'place' && !chiselMaterial) { notice('Сначала скопируйте материал клавишей O или СКМ'); return; }
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
    if (heldCreativeItem?.kind === 'flat-item' && !bucket) { notice('Наведите прицел на рамку'); return; }
    if (!clipboard) { notice(messages.nothing_to_copy); return; }
    request.against = {x: target.x, y: target.y, z: target.z};
    const embedsInLiquid = getKey(target.cell) !== FAKE_WATER && liquidKind(target.cell) &&
      canLogLiquid(clipboard,neighbors,world.models);
    if (!embedsInLiquid) {
      request.x += target.offset[0];
      request.y += target.offset[1];
      request.z += target.offset[2];
    }
    request.cell = clipboard;
    request.yaw = heading.yaw;
    request.pitch = heading.pitch;
    if (fromCreative && !bucket) request.creative = true;
    if (heldCreativeItem && !bucket) request.creativeItem = heldCreativeItem.key;
    if (heldSofa) {
      updatePlacement(target);
      if (!placement || placement.blocked) { notice(messages.occupied); return; }
      request.turns = sofaTurns;
      pendingPlacement = placement;
    }
  }
  if (type === 'place_liquid') {
    request.cell = clipboard;
    if (fromCreative && !bucket) request.creative = true;
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
    if (pendingPlacement && overlapsPlacement(position,pendingPlacement,movement.body)) { notice(messages.occupied); return; }
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
    if ((type === 'copy' || type === 'copy_liquid') && selectedVersion === heldVersion) {
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
    if ((type === 'copy' || type === 'copy_part' || type === 'copy_liquid') && selectedVersion === heldVersion) {
      await inventoryAction('inventory_copy',{slot:inventory.selected});
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
  if (touchMode || view.lowDevice) {
    const deadline=nextMobileFrame??now;
    if (now+1<deadline) {
      requestAnimationFrame(tick);
      return;
    }
    // Recover cadence after a late frame without scheduling another immediately.
    nextMobileFrame=Math.max(deadline+mobileFrameMs,now+mobileFrameMs/2);
  }
  const dt = Math.min(.05, (now - (lastFrame || now)) / 1000);
  let seatedSpeed = 0;
  if (emote && (flying || seat || jump || forwardInput() || turnInput() || movement.stance!=='stand' ||
      emote.id==='wave'&&Date.now()-emote.started>2200)) {
    emote=null;
    presenceDirty=true;
  }
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
  if (seat?.kind === 'ground' && playing && !menuOpen() && !orbitHeading && (forwardInput() || turnInput())) {
    seatedMoveSince ??= now;
    if (!acting && !seatPending && !resetting) {
      if (now-seatedMoveSince >= 1000) {
        seatedMoveSince = now;
        void toggleSeat(false);
      } else if (positionTrail.length < POSITION_TRAIL_LIMIT * 4) {
        const forward = forwardInput(), strafe = turnInput();
        const speed = CRAWL_SPEED / Math.max(1,Math.hypot(forward,strafe));
        const sin = Math.sin(heading.yaw), cos = Math.cos(heading.yaw);
        const startX=position.x, startZ=position.z;
        const body = {...movement.body,height:Math.min(movement.body.height,SEATED_HEIGHT)};
        movement.slideSeated(position,(-sin*forward+cos*strafe)*speed,(-cos*forward-sin*strafe)*speed,dt,body,recordPosition);
        if (dt) seatedSpeed=Math.hypot(position.x-startX,position.z-startZ)/dt;
      }
    }
  } else seatedMoveSince = undefined;
  if (playing && !menuOpen() && !orbitHeading && !seat && !seatPending && teleportLoading.hidden) {
    const startX = position.x, startZ = position.z;
    const fallSpeed = movement.fall;
    const forward = forwardInput();
    const strafe = turnInput();
    const descending = keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC');
    const vertical = flying ? Number(keys.has('Space')) - Number(descending) : 0;
    const sin = Math.sin(heading.yaw), cos = Math.cos(heading.yaw);
    if (!resetting && positionTrail.length < POSITION_TRAIL_LIMIT * 4) {
      if (!flying) {
        const previous = movement.stance;
        const stance = movement.wantsSwim(position,sprinting()) ? 'swim' :
          crawlRequested ? 'crawl' : keys.has('KeyC') || now < crouchUntil ? 'crouch' : 'stand';
        if (movement.setStance(position,stance) !== previous) recordPosition(position);
      }
      const speed = movementSpeed({flying,sprint:sprinting(),stance:movement.stance}) / Math.max(1,Math.hypot(forward,strafe,vertical));
      const dx = (-sin * forward + cos * strafe) * speed;
      const dz = (-cos * forward - sin * strafe) * speed;
      if (flying) movement.fly(position, dx, vertical * speed * FLIGHT_VERTICAL_MULTIPLIER, dz, dt, recordPosition, spectator);
      else movement.update(position, dx, dz, jump, dt,
        {rise: jump || keys.has('Space'), descend: descending || movement.medium === 'ladder' && sprinting(),
          swimPitch: -Math.sin(heading.pitch)*forward, recordStep: recordPosition});
    }
    horizontalSpeed = dt > 0 ? Math.hypot(position.x - startX, position.z - startZ) / dt : 0;
    if (!resetting && !flying && movement.grounded && !movement.medium) {
      if (fallSpeed < -Math.sqrt(40*3)) view.groundDust(position,movement.body,[0,0],-fallSpeed,now);
      else if (sprinting() && movement.stance === 'stand' && horizontalSpeed > 4 && now >= nextSprintDust) {
        nextSprintDust = now + 70;
        view.groundDust(position,movement.body,[(position.x-startX)/dt,(position.z-startZ)/dt],0,now);
      }
    }
    jump = false;
  } else horizontalSpeed = seatedSpeed;
  if (playing && !menuOpen()) {
    const hour = view.dayTick(now);
    if (now>=nextBardCheck) {
      audio.npcMusic(npcBards.values(),position,now);
      nextBardCheck=now+200;
    }
    audio.frame(world,position,{grounded:movement.grounded && !seat && !flying,
      yaw:heading.yaw,body:movement.body,climbing:movement.medium === 'ladder',swimming:movement.medium === 'water',
      precipitation:view.precipitationKind,sheltered:view.rain?.listenerSheltered,weatherAudio:view.weatherAudio,
      biome:view.climate?.biomeAt(position.x,position.z),night:hour > 13000 && hour < 23000,
      windStrength:windAt(now,view.weather).strength});
  }
  if (!resetting && teleportLoading.hidden && now >= nextPositionSync && !acting) syncPosition();
  if (!sync || presenceDirty) sendPresence(now);
  if (playing && !menuOpen() && !seat && !flying && movement.stance === 'stand') {
    view.viewBob.step(horizontalSpeed * dt, dt, movement.grounded && !movement.medium, movement.fall);
  } else {
    view.viewBob.step(0, dt, true, 0);
  }
  view.updateVehicles();
  view.updateLocalAvatar(now, dt, position, playerPose(), horizontalSpeed, seat, spectator,modeUi.death);
  updateCamera();
  view.players.frame(now, dt);
  updateSelection();
  worldEdit.frame();
  updatePlacement(npcTarget||hitPlayer?null:selection);
  if (repeatPlacement && now >= nextPlacement && !acting && !resetting && !menuOpen() && playing &&
      !spectator && !orbitHeading && (touchMode || document.pointerLockElement === view.renderer.domElement)) {
    nextPlacement = now + 150;
    if ((clipboard || heldPart || chiseling) && !frameTarget && !seatTarget && !npcTarget) void action('place');
  }
  const selected = hitPlayer ? hitPlayer.name : npcTarget ? plainMinecraftText(npcTarget.entity?.name??'NPC') : frameTarget ? 'Рамка · ПКМ — вложить предмет · E — повернуть' :
    seatTarget ? (seatTarget.kind === 'boat' ? 'Лодка · E — сесть' : 'Вагонетка · E — сесть') :
    selection?.voxelMaterial ? labelFor(selection.voxelMaterial) :
    selection?.part ? partLabel(selection.part) : labelFor(getKey(selection?.cell));
  const targetSeat = !npcTarget && !seat && !seatTarget && !frameTarget && seatFor(selection?.cell,world.models);
  const interaction = npcTarget ? (touchMode?'Действие — разговор':'E — разговор') : targetSeat ? targetSeat.bed ? 'E — лечь' : 'E — сесть' :
    !seat && !seatTarget && !frameTarget && selection && signFor(selection.cell) ? 'E — редактировать' : '';
  const fluidHint = npcTarget?'':selection?.cell?.fluid === 'water' ? 'ЛКМ — убрать воду' :
    selection?.cell?.fluid === 'lava' ? 'ЛКМ — убрать лаву' : '';
  const status = wieldWorldEdit() ? worldEdit.hint(touchMode) : [selected,interaction,fluidHint].filter(Boolean).join('  /  ');
  if (selectionStatus.textContent !== status) selectionStatus.textContent = status;
  const coordinates = `X ${position.x.toFixed(2)}  Y ${position.y.toFixed(2)}  Z ${position.z.toFixed(2)}`;
  if (coordinateStatus.textContent !== coordinates) coordinateStatus.textContent = coordinates;
  if (now >= nextClockUpdate) {
    social.updateClock(view.dayTick(now), view.worldTime.frozen);
    nextClockUpdate = now + 200;
  }
  nearbyStream?.update();
  const eye=view.sightOrigin(position,movement.body.eye);
  touchControls?.update({flying,spectator,stance:movement.stance,crawlRequested,seated:seat?.kind==='ground',
    orbit:Boolean(orbitHeading),chisel:chiseling});
  view.render(now, npcTarget||hitPlayer?null:selection, playing && !menuOpen(), placement, document.hasFocus(),{x:eye[0],y:eye[1],z:eye[2]});
  requestAnimationFrame(tick);
}

function bindControls() {
  const canvas = view.renderer.domElement;
  clearSelection.addEventListener('click', stowHeld);
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
        movement.size = body.size ?? 'normal';
        if (body.position) setSeat(body.seat,body.position,body.stance);
        social.profileUpdated(profile.confirmed);
        view.setLocalSkin(profile.confirmed.skin);
        if (playing && !entered) enterWorld();
        else if (playing) presenceDirty = true;
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
    if (!touchMode && !menuOpen() && !modeUi.death) setPlaying(document.pointerLockElement === canvas);
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
    if ((!teleportLoading.hidden && event.target !== element('teleport-reload'))||modeUi.death) return;
    if (signEditor.open || audioSettings?.open || itemDocuments.isOpen() || storage.isOpen() || npcUi.isOpen()||
        modeUi.isOpen() || adminUi.isOpen()) return;
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
    if (!spectator && /^Digit[1-9]$/.test(event.code)) {
      event.preventDefault();
      if (!event.repeat) creative.selectSlot(Number(event.code.slice(-1)) - 1);
      return;
    }
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
    if (event.code === 'KeyV' && !resetting && !acting && !flying && !seat) {
      if (crawlRequested) crawlRequested = false;
      else if (movement.setStance(position,'crawl') === 'crawl') {
        crawlRequested = true;
        recordPosition(position);
      }
    }
    if (event.code === 'KeyK' && !resetting && !acting) {
      if (event.shiftKey && chiseling) toggleChiselSize();
      else toggleChisel();
    }
    if (event.code === 'KeyJ') creative.openInventory();
    if (['KeyB','KeyZ'].includes(event.code)&&!flying&&!seat&&movement.grounded&&movement.stance==='stand') {
      const id=event.code==='KeyB'?'wave':'dance';
      emote=emote?.id===id ? null : {id,started:Date.now()};
      presenceDirty=true;
    }
    if (event.code === 'KeyQ') {
      event.preventDefault();
      if (inventory.slots[inventory.selected]) void inventoryAction('drop_item',{yaw:heading.yaw,all:event.ctrlKey,eye:view.eyeOffset()});
    }
    if (event.code === 'KeyC' && !flying && !seat && !resetting) {
      crouchUntil = performance.now() + 180;
      if (world.droppedItems.size) void inventoryAction('pickup_item',{eye:view.eyeOffset()});
    }
    if (event.code === 'KeyX' && !flying && !acting && !resetting && (!seat || seat.kind === 'ground')) {
      event.preventDefault();
      void toggleSeat(seat?.kind !== 'ground');
    }
    if (event.code === 'KeyO') action('copy');
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
    touchControls?.clear();
    social.blur();
  });
  canvas.addEventListener('mousedown', event => {
    if (touchMode || menuOpen()||modeUi.death) return;
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
    if (event.button === 1) action('copy',false,true);
  });
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('wheel',event=>{
    if (!playing || menuOpen() || spectator || orbitHeading || !event.deltaY) return;
    event.preventDefault();
    creative.scrollHotbar(Math.sign(event.deltaY));
  },{passive:false});
  element('teleport-reload').addEventListener('click', () => location.reload());
  element('sign-form').addEventListener('submit', saveSign);
  element('sign-cancel').addEventListener('click', closeSign);
  signEditor.addEventListener('cancel', event => { event.preventDefault(); closeSign(); });

  let finger, fingerX, fingerY;
  canvas.addEventListener('pointerdown', event => {
    if ((!touchMode&&!modeUi.death) || !playing || menuOpen() || finger !== undefined) return;
    finger = event.pointerId;
    fingerX = event.clientX;
    fingerY = event.clientY;
    canvas.setPointerCapture(finger);
  });
  canvas.addEventListener('pointermove', event => {
    if (event.pointerId !== finger || menuOpen()) return;
    look(event.clientX - fingerX, event.clientY - fingerY, .006);
    fingerX = event.clientX;
    fingerY = event.clientY;
  });
  canvas.addEventListener('lostpointercapture', () => { finger = undefined; });
  if (touchMode) touchControls=bindTouchControls({element,stick,
    enabled:()=>playing&&!menuOpen()&&teleportLoading.hidden&&!modeUi.death,
    sendKey:(code,pressed,modifiers)=>document.dispatchEvent(new KeyboardEvent(pressed?'keydown':'keyup',
      {code,cancelable:true,...modifiers})),
    use:interact,
    block(type) { if (type==='rotate') cyclePlacement(); else void action(type,false,true); },
    repeat(held) {
      repeatPlacement=held&&!spectator;
      if (held) nextPlacement=performance.now()+350;
    },
    pause() { pause(); setPlaying(false); },
  });
  element('detail-distance').addEventListener('change', event => {
    const distance = Number(event.target.value);
    view.setDetailedLodDistance(distance).then(() => {
      localStorage.setItem(detailPreference,String(distance));
    }).catch(error => notice(error.message));
  });
  const night = element('night-vision');
  const lowDevice = element('low-device');
  const detail = element('detail-distance');
  const paintLowDevice = ()=>{
    lowDevice.textContent=view.lowDevice?'Слабое устройство: вкл.':'Слабое устройство: выкл.';
    lowDevice.setAttribute('aria-pressed',String(view.lowDevice));
    detail.disabled=view.farTerrain?.lod.maxDistance!==32 || view.lowDevice;
  };
  paintLowDevice();
  lowDevice.addEventListener('click',async()=>{
    lowDevice.disabled=true;
    try {
      await view.setLowDevice(!view.lowDevice);
      localStorage.setItem(lowDevicePreference,view.lowDevice?'1':'0');
      nearbyStream?.update();
    } catch (error) {notice(error.message);}
    finally {paintLowDevice(); lowDevice.disabled=false;}
  });
  const showVision = enabled=>{
    view.setNightVision(enabled);
    night.textContent = enabled ? 'Ночное зрение вкл.' : 'Ночное зрение выкл.';
    night.setAttribute('aria-pressed',String(enabled));
  };
  showVision(localStorage.getItem('honeymoon-night-vision') === '1');
  night.addEventListener('click',()=>{
    const enabled = !view.nightVision;
    localStorage.setItem('honeymoon-night-vision',enabled ? '1' : '0');
    showVision(enabled);
  });
  const weather = element('weather');
  weather.addEventListener('change',async()=>{
    weather.disabled = true;
    try {
      const {ok,body} = await post('weather',{mode:weather.value});
      if (ok) updateWeather(body.mode);
      else notice(messages[body.error] || 'Не удалось изменить погоду');
    } catch (error) {
      console.error(error);
      notice('Не удалось изменить погоду');
    } finally {
      weather.value = view.weather;
      weather.disabled = modeUi.active&&!modeUi.admin;
    }
  });
  const sound = element('audio-toggle');
  const soundLevel=element('audio-volume'), musicLevel=element('music-volume');
  const settingsKey='honeymoon-audio-settings';
  const settings={...audioDefaults,soundVolume:.13,musicVolume:.16};
  try { Object.assign(settings,JSON.parse(localStorage.getItem(settingsKey)) ?? {}); } catch {}
  audio.setEnvironment(settings);
  audio.setVolume(settings.soundVolume);
  soundLevel.value=String(Math.round(settings.soundVolume*100));
  musicLevel.value=String(Math.round(settings.musicVolume*100));
  const environmentProfileSelect=element('audio-profile');
  environmentProfileSelect.value=settings.profile;
  const persist=()=>localStorage.setItem(settingsKey,JSON.stringify(settings));
  element('audio-settings-toggle').addEventListener('click',()=>audioSettings.showModal());
  element('audio-settings-close').addEventListener('click',()=>audioSettings.close());
  environmentProfileSelect.addEventListener('change',()=>{
    settings.profile=environmentProfileSelect.value;
    audio.setEnvironment(settings);
    persist();
  });
  for (const group of ['nature','animals','other']) for (const type of ['Volume','Frequency']) {
    const range=element(group+'-'+type.toLowerCase());
    const key=group+type;
    range.value=String(Math.round(settings[key]*100));
    range.addEventListener('input',()=>{settings[key]=Number(range.value)/100; audio.setEnvironment(settings); persist();});
  }
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
  soundLevel.addEventListener('input',()=>{
    settings.soundVolume=Number(soundLevel.value)/100;
    audio.setVolume(settings.soundVolume);
    const muted=!settings.soundVolume;
    localStorage.setItem('honeymoon-muted',muted ? '1' : '0');
    showSound(muted);
    persist();
  });
  const music = element('music-toggle');
  const showMusic = enabled => {
    music.textContent = enabled ? 'Музыка вкл.' : 'Музыка выкл.';
    music.setAttribute('aria-pressed', String(enabled));
    audio.setMusicVolume(enabled ? settings.musicVolume || .16 : 0);
  };
  showMusic(localStorage.getItem('honeymoon-music') === '1');
  music.addEventListener('click', () => {
    const enabled = music.getAttribute('aria-pressed') !== 'true';
    localStorage.setItem('honeymoon-music', enabled ? '1' : '0');
    showMusic(enabled);
  });
  musicLevel.addEventListener('input',()=>{
    settings.musicVolume=Number(musicLevel.value)/100;
    const enabled=Boolean(settings.musicVolume);
    localStorage.setItem('honeymoon-music',enabled ? '1' : '0');
    showMusic(enabled);
    persist();
  });
  element('reset').addEventListener('click', async () => {
    if (resetting || acting) return;
    resetting = true;
    try {
      await sync;
      const {ok, body} = await post('respawn', {});
      if (ok) {
        await arriveAt(body.position,body.stance);
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

function streamNearby(scenery) {
  const visual = new Set(scenery.map(([x, z]) => chunkKey(x, z)));
  const inFullWorld=detailCoverage(world.manifest.fullChunks);
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
      const visualOnly = !world.isPlayableChunk(...coordinate);
      if (visualOnly && !visual.has(key) && !inFullWorld(...coordinate) || world.chunks.has(key)) continue;
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
  const sessionBody = await accessUi.acquire();
  if (!sessionBody) return;
  const session = {body:sessionBody};
  adminUi.setAccess(sessionBody.access);
  if (sessionBody.access?.role==='admin') npcUi.setAccess(true);
  const manifest = await json('/generated/world/world.json');
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
  movement.size = profile.confirmed.size ?? 'normal';
  movement.stance = confirmedStance = session.body.stance ?? 'stand';
  crawlRequested = movement.stance === 'crawl';
  view = new Display(surface, world, session.body.dayTick,{mobile:touchMode,
    lowDevice:localStorage.getItem(lowDevicePreference)==='1'});
  modeUi.update(session.body.gameMode);
  view.setLocalSkin(profile.confirmed.skin);
  if (new URLSearchParams(location.search).get('occlusion') === '1') view.setOcclusion(true);
  if (session.body.seat) setSeat(session.body.seat, p,session.body.stance);
  if (session.body.spectator) setSpectator(true);
  if (session.body.time) view.setWorldTime(session.body.time);
  if (session.body.weather) updateWeather(session.body.weather);
  view.onError = error => { notice('Ошибка построения участка карты'); console.error(error); };
  updateCamera();
  const farSupported = supportsFarTerrain(manifest) && manifest.lod.maxDistance === 32;
  const distance = element('detail-distance');
  if (touchMode) for (const option of [...distance.options]) if (Number(option.value)>24) option.remove();
  const savedDetail = Number(localStorage.getItem(detailPreference));
  if ([...distance.options].some(option => Number(option.value) === savedDetail)) distance.value = String(savedDetail);
  else if (touchMode) distance.value='12';
  distance.disabled = !farSupported || view.lowDevice;
  await Promise.all([view.loadTextures(),creativeAvailable ? loadCreative().catch(console.error) : null]);
  void refreshNpcs();
  await refresh();
  await view.prepareGraphics();
  bindControls();
  stream();
  requestAnimationFrame(tick);
  globalThis.honeymoon = Object.freeze({
    stats: () => ({...metrics, ...view.statistics(), residentChunks:world.chunks.size, streaming:nearbyStream?.status(),
      revision: worldRevision, position: {...position}, seat, audio:audio.stats(),
      flying, spectator, stance:movement.stance, body:movement.body, chiseling, chiselMaterial, chiselSize, perspective:cameraMode(),
      movementSync: {...positionMetrics, queued: positionTrail.length, confirmed: [...confirmedPosition]},
      renderer: view.renderer.getContext().getParameter(view.renderer.getContext().RENDERER)}),
    look: (yaw, pitch = 0) => { heading.yaw = yaw; heading.pitch = pitch; updateCamera(); },
    perspective: cameraMode,
    localAvatar: () => view.inspectLocalAvatar(),
    setOcclusion: enabled => view.setOcclusion(enabled),
    target: () => selection && {...selection},
    targetNpc: () => npcTarget,
    health: () => ({mode:modeUi.creative?'creative':'game',death:modeUi.death,health:Number(element('health').getAttribute('aria-valuenow'))}),
    placement: () => placement && {...placement},
    setDistance: distance => view.setDistance(distance),
    setDetailedDistance: distance => view.setDetailedLodDistance(distance),
    getCell: (x, y, z) => world.cellAt(x, y, z),
    players: () => view.players.inspect(),
    online: social.names,
    time: () => ({tick:view.dayTick(performance.now()), frozen:view.worldTime.frozen,
      sun:view.sky.material.uniforms.sunDirection.value.toArray()}),
  });
  const spawnChunk=[Math.floor(position.x/16),Math.floor(position.z/16)];
  const near = world.playableAround(...spawnChunk,1);
  const buffered = world.playableAround(...spawnChunk,2);
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
  if (manifest.chunkPalettes) nearbyStream = streamNearby(manifest.visualChunks ?? []);
  const pending = nearbyStream?.done ?? streamChunks(manifest.chunks.filter(chunk => !buffered.includes(chunk)), manifest.visualChunks ?? []);
  pending.catch(console.error);
  if (sessionBody.access?.authenticated && sessionBody.access?.inviteRequired) {
    document.addEventListener('pointerdown',()=>audio.enable(),{once:true,capture:true});
    setPlaying(true);
    if (!touchMode) notice('Нажмите на игру, чтобы управлять обзором мышью');
  }
}

start().catch(error => {
  console.error(error);
  loading.textContent = 'Ошибка загрузки. ' + error.message;
});
