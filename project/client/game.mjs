import {Display} from './display.mjs';
import {Movement, EYE, pick} from './movement.mjs';
import {World, chunkKey, json} from './world-data.mjs';

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
const stick = {x: 0, z: 0};
let world, view, movement, position, selection, clipboard, worldRevision = 0;
let playing = false, jump = false, lastFrame = 0, lastSync = 0, lastPosition = '', timer;
let sync = Promise.resolve(), acting = false, syncing = false;
let metrics = {started: performance.now(), playable: 0, chunksLoaded: 0, lastEdit: 0};
let feed;

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
  outside_playable_area: 'Граница района', protected_cell: 'Это часть контрольной механики',
  no_interaction: 'С этим объектом нельзя взаимодействовать'
};

async function post(path, payload) {
  const response = await fetch('/api/' + path, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)
  });
  const body = await response.json();
  return {ok: response.ok, body};
}

function effects(data) {
  for (const effect of data.effects || []) {
    if (effect.message) notice(effect.message);
  }
}

function changes(list = [], revision = 0) {
  for (const change of list) {
    if (world.setOverride(change) && world.hasChunk(change.x, change.z)) view.remesh(change.x, change.y, change.z);
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
  view.camera.updateMatrixWorld();
}

function look(dx, dy, sensitivity = .0023) {
  heading.yaw -= dx * sensitivity;
  heading.pitch = Math.min(1.55, Math.max(-1.55, heading.pitch - dy * sensitivity));
}

function setPlaying(active) {
  playing = active;
  game.classList.toggle('playing', active);
  entry.hidden = active;
  if (!active) {
    keys.clear();
    jump = false;
    button.textContent = 'Продолжить';
    loading.textContent = 'Пауза';
  }
}

function syncPosition(force = false) {
  if (force) return sync.then(() => syncPosition());
  if (syncing) return sync;
  const payload = {...position};
  const address = [payload.x, payload.y, payload.z].map(n => n.toFixed(4)).join(',');
  if (address === lastPosition) return Promise.resolve();
  lastPosition = address;
  syncing = true;
  sync = sync.catch(() => {}).then(async () => {
    const {ok, body} = await post('position', payload);
    if (!ok && body.position) {
      Object.assign(position, body.position);
      lastPosition = '';
      movement.fall = 0;
    }
    effects(body);
  }).catch(() => {
    lastPosition = '';
  }).finally(() => { syncing = false; });
  return sync;
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

async function action(type) {
  if (!selection || acting || !playing) return;
  const target = selection;
  const cell = getKey(target.cell);
  const request = {requestId: [...crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(16).padStart(8, '0')).join(''), type, x: target.x, y: target.y, z: target.z, hit: target.hit};
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
    await syncPosition(true);
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
    movement.update(position, (-sin * forward + cos * strafe) * speed,
      (-cos * forward - sin * strafe) * speed, jump, dt);
    jump = false;
    if (now - lastSync >= 130 && !acting) {
      lastSync = now;
      syncPosition();
    }
  }
  updateCamera();
  if (playing) {
    const cp = Math.cos(heading.pitch);
    selection = pick(world, [position.x, position.y + EYE, position.z],
      [-Math.sin(heading.yaw) * cp, Math.sin(heading.pitch), -Math.cos(heading.yaw) * cp]);
  } else selection = null;
  const selected = labelFor(getKey(selection?.cell));
  element('selected').textContent = [selected, clipboard && 'В руке · ' + labelFor(clipboard)].filter(Boolean).join('  /  ') || 'Ячейка не выбрана';
  element('coords').textContent = [position.x, position.y, position.z].map(Math.floor).join('  ·  ');
  view.render(now, selection);
  requestAnimationFrame(tick);
}

function bindControls() {
  const canvas = view.renderer.domElement;
  button.addEventListener('click', () => {
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
    if (event.code === 'KeyE') action('interact');
  });
  document.addEventListener('keyup', event => keys.delete(event.code));
  window.addEventListener('blur', () => keys.clear());
  canvas.addEventListener('mousedown', event => {
    if (!playing || touchMode) return;
    const command = {0:'remove', 1:'copy', 2:'place'}[event.button];
    if (command) action(command);
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
  for (const [id, command] of [['touch-remove','remove'], ['touch-place','place'], ['touch-copy','copy'], ['touch-use','interact']]) {
    element(id).addEventListener('click', () => action(command));
  }
  element('jump').addEventListener('pointerdown', () => { jump = true; });
  element('distance').addEventListener('change', event => {
    view.setDistance(Number(event.target.value)).catch(error => notice(error.message));
  });
  element('reset').addEventListener('click', async () => {
    await sync;
    const {ok, body} = await post('respawn', {});
    if (!ok) { notice(messages[body.error] || body.error); return; }
    Object.assign(position, body.position);
    lastPosition = '';
    movement.fall = 0;
  });
}

async function loadChunks(chunks) {
  const remaining = chunks.slice().sort(([x, z], [xx, zz]) =>
    Math.hypot(x * 16 + 8 - position.x, z * 16 + 8 - position.z) -
    Math.hypot(xx * 16 + 8 - position.x, zz * 16 + 8 - position.z));
  const near = new Set(remaining.slice(0, 9).map(([x, z]) => chunkKey(x, z)));
  await Promise.all(Array.from({length: 6}, async () => {
    while (remaining.length) {
      const [x, z] = remaining.shift();
      const data = await json('/generated/world/chunks/' + x + '.' + z + '.json');
      view.addChunk(world.addChunk(data));
      metrics.chunksLoaded++;
      near.delete(chunkKey(x, z));
      if (!near.size && button.disabled) {
        metrics.playable = performance.now() - metrics.started;
        button.disabled = false;
        loading.textContent = 'Район загружен';
      }
    }
  }));
}

async function start() {
  const [manifest, session] = await Promise.all([json('/generated/world/world.json'), post('session', {})]);
  if (!session.ok) throw new Error('Сеанс не создан');
  world = new World(manifest);
  const p = session.body.position;
  const [x, y, z] = session.body.spawn || manifest.spawn;
  position = p ? {...p} : {x, y, z};
  movement = new Movement(world);
  view = new Display(surface, world);
  view.onError = error => { notice('Ошибка построения участка карты'); console.error(error); };
  updateCamera();
  const available = new Set([4, ...(manifest.terrain || []).map(ring => ring.radius)]);
  const distance = element('distance');
  for (const option of distance.options) option.disabled = !available.has(Number(option.value));
  if (!available.has(Number(distance.value))) distance.value = '4';
  await Promise.all([view.loadTextures(), refresh()]);
  bindControls();
  stream();
  requestAnimationFrame(tick);
  globalThis.honeymoon = Object.freeze({
    stats: () => ({...metrics, ...view.statistics(), revision: worldRevision, position: {...position}, renderer: view.renderer.getContext().getParameter(view.renderer.getContext().RENDERER)}),
    look: (yaw, pitch = 0) => { heading.yaw = yaw; heading.pitch = pitch; updateCamera(); },
    target: () => selection && {...selection},
    setDistance: distance => view.setDistance(distance),
    getCell: (x, y, z) => world.cellAt(x, y, z),
  });
  await loadChunks(manifest.chunks);
  await view.setDistance(Number(distance.value));
}

start().catch(error => {
  console.error(error);
  loading.textContent = 'Ошибка загрузки. ' + error.message;
});
