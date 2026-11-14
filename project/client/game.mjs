import {Display} from './display.mjs';
import {Movement, EYE, pick} from './movement.mjs';
import {World, json} from './world-data.mjs';
import {WorldAudio} from './audio.mjs';
import {biblioWeaponCase, blockState, jammyAppliance, jammyUseSound} from '../world/block-interactions.mjs';
import {POSITION_TRAIL_LIMIT} from '../world/player-body.mjs';

const element = id => document.getElementById(id);
const game = element('game');
const entry = element('entry');
const loading = element('loading');
const button = element('play');
const surface = element('scene');
const toast = element('toast');
const keys = new Set();
const touchMode = matchMedia('(pointer: coarse)').matches;
const heading = {yaw: 0, pitch: -.045};
const handControls = new Set([25,64,69,77,84,93,94,96,107,143,219,220]);
const stick = {x: 0, z: 0};
let world, view, movement, position, selection, clipboard, worldRevision = 0;
const positionInterval = 130;
const positionMetrics = {requests: 0, corrections: 0, errors: 0};
const positionTrail = [];
let playing = false, jump = false, lastFrame = 0, nextPositionSync = 0, timer;
let sync = null, pendingPosition = null, confirmedPosition, retryCount = 0, acting = false, resetting = false;
let metrics = {started: performance.now(), playable: 0, chunksLoaded: 0, visualChunksLoaded: 0, lastEdit: 0};
let feed;
const audio = new WorldAudio();

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
  block_not_owned: 'Можно ломать только свои блоки',
  outside_playable_area: 'Граница района', protected_cell: 'Это часть контрольной механики',
  no_interaction: 'С этим объектом нельзя взаимодействовать'
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
  feed = new EventSource('/api/events?since=' + worldRevision);
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

function updateCamera() {
  view.camera.rotation.order = 'YXZ';
  view.camera.rotation.set(heading.pitch, heading.yaw, 0, 'YXZ');
  view.camera.position.set(position.x, position.y + EYE, position.z);
  view.camera.translateZ(.1);
  view.camera.updateMatrixWorld();
}

function look(dx, dy, sensitivity = .0023) {
  heading.yaw -= dx * sensitivity;
  heading.pitch = Math.min(1.55, Math.max(-1.55, heading.pitch - dy * sensitivity));
}

function setPlaying(active) {
  playing = active;
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

function positionPacket() {
  const trail = [];
  let distance = 0;
  let from = confirmedPosition;
  // Keep a delayed batch inside the server's wall-clock movement budget.
  for (const step of positionTrail) {
    distance += Math.hypot(step[0] - from[0], Math.max(0, step[1] - from[1]), step[2] - from[2]);
    if (trail.length && (trail.length >= POSITION_TRAIL_LIMIT || distance > 1.05)) break;
    trail.push(step);
    from = step;
  }
  const [x, y, z] = from;
  return {x, y, z, from: confirmedPosition, trail,
    requestId: [...crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(16).padStart(8, '0')).join('')};
}

function syncPosition() {
  if (sync || !positionTrail.length || performance.now() < nextPositionSync) return sync;
  const payload = pendingPosition ??= positionPacket();
  nextPositionSync = performance.now() + positionInterval;
  positionMetrics.requests++;
  sync = post('position', payload, AbortSignal.timeout(3000)).then(({ok, body}) => {
    if (ok) {
      confirmedPosition = positionTuple(body.position);
      positionTrail.splice(0, payload.trail.length);
      pendingPosition = null;
    } else if (body.position) {
      positionMetrics.corrections++;
      setAuthoritativePosition(body.position);
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
  while (lastStep && positionTrail.includes(lastStep)) {
    const before = positionMetrics.errors;
    if (!sync && performance.now() < nextPositionSync) {
      await new Promise(resolve => setTimeout(resolve, nextPositionSync - performance.now()));
    }
    await syncPosition();
    if (positionMetrics.errors !== before) throw new Error('Position sync failed');
  }
}

const getKey = cell => typeof cell === 'string' ? cell : cell?.key;
const labelFor = key => {
  if (!key) return '';
  if (key === 'game:switch') return 'Переключатель';
  if (key === 'game:door') return 'Дверь';
  const id = Number(key.split(':')[1]);
  return world.manifest.legacyRegistry?.[id]?.name || ({1:'Камень',2:'Дёрн',3:'Земля',4:'Булыжник',
    5:'Доски',17:'Бревно',20:'Стекло',35:'Шерсть',44:'Плита',63:'Табличка',68:'Табличка'})[id] ||
    (key.startsWith('cover:') ? 'Микроблоки' : 'Блок ' + id);
};

async function action(type, sneaking = false) {
  if (!selection || acting || resetting || !playing) return;
  const target = selection;
  const cell = getKey(target.cell);
  const request = {requestId: [...crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(16).padStart(8, '0')).join(''), type, x: target.x, y: target.y, z: target.z, hit: target.hit};
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
  }
  request.expectedRevision = world.revisionAt(request.x, request.y, request.z);
  const started = performance.now();
  acting = true;
  try {
    await flushPosition();
    let result;
    try { result = await post('action', request); }
    catch { result = await post('action', request); }
    if (!result.ok) {
      if (result.body.current) changes([result.body.current], result.body.worldRevision);
      notice(messages[result.body.error] || result.body.error || 'Действие отклонено');
      return;
    }
    if (type === 'copy') {
      clipboard = result.body.cell || cell;
      notice('Скопировано · ' + labelFor(clipboard));
    }
    changes(result.body.changes, result.body.worldRevision);
    effects(result.body);
    metrics.lastEdit = performance.now() - started;
  } catch (error) {
    notice('Связь с сервером прервалась');
    console.error(error);
  } finally {
    acting = false;
  }
}

function tick(now) {
  const dt = Math.min(.05, (now - (lastFrame || now)) / 1000);
  lastFrame = now;
  if (playing) {
    const forward = Number(keys.has('KeyW') || keys.has('ArrowUp')) - Number(keys.has('KeyS') || keys.has('ArrowDown')) - stick.z;
    const strafe = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft')) + stick.x;
    const speed = (keys.has('ShiftLeft') ? 5.1 : 3.8) / Math.max(1, Math.hypot(forward, strafe));
    const sin = Math.sin(heading.yaw), cos = Math.cos(heading.yaw);
    if (!resetting && positionTrail.length < POSITION_TRAIL_LIMIT * 4) {
      movement.update(position, (-sin * forward + cos * strafe) * speed,
        (-cos * forward - sin * strafe) * speed, jump, dt,
        {rise: jump || keys.has('Space'), descend: keys.has('ShiftLeft') || keys.has('ShiftRight'), recordStep: recordPosition});
    }
    audio.frame(world, position, {grounded:movement.grounded, yaw:heading.yaw,
      climbing:movement.medium === 'ladder', swimming:movement.medium === 'water'});
    jump = false;
  }
  if (!resetting && now >= nextPositionSync && !acting) syncPosition();
  updateCamera();
  if (playing) {
    const cp = Math.cos(heading.pitch);
    selection = pick(world, [position.x, position.y + EYE, position.z],
      [-Math.sin(heading.yaw) * cp, Math.sin(heading.pitch), -Math.cos(heading.yaw) * cp]);
  } else selection = null;
  const selected = labelFor(getKey(selection?.cell));
  element('selected').textContent = [selected, clipboard && 'В руке · ' + labelFor(clipboard)].filter(Boolean).join('  /  ') || 'Ячейка не выбрана';
  element('coords').textContent = [position.x, position.y, position.z].map(Math.floor).join('  ·  ');
  view.render(now, selection, playing);
  requestAnimationFrame(tick);
}

function bindControls() {
  const canvas = view.renderer.domElement;
  button.addEventListener('click', () => {
    audio.enable();
    if (touchMode) setPlaying(true);
    else {
      try {
        Promise.resolve(canvas.requestPointerLock()).catch(error => notice(error.message));
      } catch (error) { notice(error.message); }
    }
  });
  document.addEventListener('pointerlockchange', () => {
    if (!touchMode) setPlaying(document.pointerLockElement === canvas);
  });
  document.addEventListener('pointerlockerror', () => notice('Браузер заблокировал захват курсора'));
  document.addEventListener('mousemove', event => {
    if (!touchMode && playing) look(event.movementX, event.movementY);
  });
  document.addEventListener('keydown', event => {
    if (!playing) return;
    if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.code)) event.preventDefault();
    keys.add(event.code);
    if (event.repeat) return;
    if (event.code === 'Space') jump = true;
    if (event.code === 'KeyQ') action('copy');
    if (event.code === 'KeyE') action('interact', event.shiftKey);
  });
  document.addEventListener('keyup', event => keys.delete(event.code));
  window.addEventListener('blur', () => keys.clear());
  canvas.addEventListener('mousedown', event => {
    if (!playing || touchMode) return;
    const key = getKey(selection?.cell);
    const [id, meta] = blockState(key);
    const interactive = key === 'game:switch' || handControls.has(id) || jammyAppliance(id, meta) || jammyUseSound(id, meta)
      || (event.shiftKey && biblioWeaponCase(id));
    const command = {0:'remove', 1:'copy', 2:interactive ? 'interact' : 'place'}[event.button];
    if (command) action(command, event.shiftKey);
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
  for (const [id, command] of [['touch-place','place'], ['touch-copy','copy'], ['touch-use','interact'], ['touch-remove','remove']]) {
    element(id).addEventListener('click', () => action(command));
  }
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
      if (ok) setAuthoritativePosition(body.position);
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
  view.onError = error => { notice('Ошибка построения участка карты'); console.error(error); };
  updateCamera();
  const available = new Set([4, ...(manifest.terrain || []).map(ring => ring.radius)]);
  const distance = element('distance');
  for (const option of distance.options) option.disabled = !available.has(Number(option.value));
  if (!available.has(Number(distance.value))) distance.value = '4';
  await Promise.all([view.loadTextures(), refresh()]);
  await view.prepareGraphics();
  bindControls();
  stream();
  requestAnimationFrame(tick);
  globalThis.honeymoon = Object.freeze({
    stats: () => ({...metrics, ...view.statistics(), revision: worldRevision, position: {...position}, audio:audio.stats(),
      movementSync: {...positionMetrics, queued: positionTrail.length, confirmed: [...confirmedPosition]},
      renderer: view.renderer.getContext().getParameter(view.renderer.getContext().RENDERER)}),
    look: (yaw, pitch = 0) => { heading.yaw = yaw; heading.pitch = pitch; updateCamera(); },
    target: () => selection && {...selection},
    setDistance: distance => {
      element('distance').value = String(distance);
      return view.setDistance(distance);
    },
    getCell: (x, y, z) => world.cellAt(x, y, z),
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
