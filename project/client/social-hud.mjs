import {formatClock, tickFromTime} from '../world/world-time.mjs';
import {createWarpMenu} from './warp-menu.mjs';

const teleportErrors = {
  invalid_coordinates:'Введите числовые координаты X, Y и Z',
  outside_playable_area:'Координаты за пределами карты',
  teleport_blocked:'В выбранной точке недостаточно места',
  admin_required:'Телепорт и варпы доступны администраторам.',
  solo_asset_unavailable:'Район ещё не скачан. Проверьте интернет или загрузку карты.',
  not_online:'Сначала войдите в мир',
  action_pending:'Дождитесь завершения текущего действия',
};
const historyLimit = 100;

export function createSocialHud({post, notice, pause, resume, teleport, loadWarps, placeWarp, worldEditCommand, weatherChanged}) {
  const byId = id => document.getElementById(id);
  const chat = byId('chat');
  const log = byId('chat-log');
  const touchChat = byId('touch-chat'), unreadBadge = byId('chat-unread');
  const chatHeader = byId('chat-header');
  const seen = new Set();
  const channelButton = byId('chat-channel');
  const chatForm = byId('chat-form');
  const chatInput = byId('chat-input');
  const clockButton = byId('clock-toggle');
  const clockForm = byId('clock-form');
  const clockInput = byId('clock-input');
  const frozen = byId('clock-frozen');
  const dynamic = byId('clock-dynamic-weather');
  const teleportButton = byId('teleport-toggle');
  const teleportForm = byId('teleport-form');
  const warpButton = byId('warp-toggle');
  const warpMenu = createWarpMenu({load:loadWarps,add:placeWarp,
    remove:id=>post('warps/remove',{id},AbortSignal.timeout(5000)),
    teleport:warpId=>teleport({warpId}),close:()=>{ if (panel === 'warps') close(false); },notice,teleportErrors});
  const coordinateInputs = ['x','y','z'].map(axis => [axis, byId(`teleport-${axis}`)]);
  const online = byId('online');
  const names = byId('online-names');
  let panel, onlineVisible = false, connected = false, players = [], clockText, writingTime = false;
  let peers = [];
  let channel = 'global';
  let unread = 0;
  let admin=false;
  let dynamicWeather=false;

  function updateUnread(value) {
    unread=value;
    unreadBadge.hidden=!unread;
    unreadBadge.textContent=unread>99?'99+':String(unread);
    touchChat.setAttribute('aria-label',unread ? `Открыть чат. Непрочитанных: ${unread}` : 'Открыть чат');
  }

  function updateChannel() {
    const local = channel === 'local';
    channelButton.querySelector('span').textContent = local ? 'Рядом' : 'Мир';
    channelButton.setAttribute('aria-pressed',String(local));
    channelButton.title = local ? 'Локальный чат · 18 блоков. Нажмите для глобального чата' :
      'Глобальный чат. Нажмите для локального чата';
    channelButton.setAttribute('aria-label',channelButton.title);
  }
  updateChannel();

  function entry({id, kind, nickname, newNickname, text, channel:target = 'global'}, recent) {
    if (seen.has(id)) return;
    const follow = panel !== 'chat' || log.scrollHeight - log.clientHeight - log.scrollTop < 8;
    seen.add(id);
    const row = document.createElement('li');
    row.dataset.messageId = id;
    if (target === 'global') {
      const marker = document.createElement('span');
      marker.className = 'chat-global';
      marker.textContent = '[G] ';
      row.append(marker);
    }
    if (kind === 'message') {
      const sender = document.createElement('strong');
      sender.textContent = nickname;
      row.append(sender, document.createTextNode(`  ${text}`));
    } else {
      row.className = 'chat-status';
      const changes = kind === 'death' ? 'помер' : kind === 'rename' ? `сменил ник на ${newNickname}` :
        kind === 'join' ? 'входит в игру' : 'выходит из игры';
      row.append(document.createTextNode(`${nickname} ${changes}`));
    }
    if (recent) {
      row.classList.add('recent');
      if (kind==='message' && panel!=='chat') updateUnread(unread+1);
      setTimeout(() => row.classList.add('fading'), 6500);
      setTimeout(() => row.classList.remove('recent', 'fading'), 8500);
    }
    let previous = log.lastElementChild;
    while (previous && Number(previous.dataset.messageId) > id) previous = previous.previousElementSibling;
    if (previous) previous.after(row);
    else log.prepend(row);
    if (log.childElementCount > historyLimit) {
      seen.delete(Number(log.firstElementChild.dataset.messageId));
      log.firstElementChild.remove();
    }
    if (follow) log.scrollTop = log.scrollHeight;
  }

  function close(continuePlaying = true) {
    if (!panel) return;
    const wasWarpMenu = panel === 'warps';
    panel = null;
    chat.classList.remove('expanded');
    chatHeader.hidden = true;
    chatForm.hidden = clockForm.hidden = teleportForm.hidden = true;
    if (wasWarpMenu) {
      warpMenu.show(false);
      warpButton.setAttribute('aria-expanded','false');
      warpButton.focus({preventScroll:true});
    } else if (continuePlaying) resume();
  }

  function open(next) {
    if (next!=='chat'&&!admin) return;
    if (!connected) return;
    if (panel === next) return close();
    pause();
    panel = next;
    chat.classList.toggle('expanded', panel === 'chat');
    chatHeader.hidden = panel !== 'chat';
    chatForm.hidden = panel !== 'chat';
    clockForm.hidden = panel !== 'clock';
    teleportForm.hidden = panel !== 'teleport';
    warpButton.setAttribute('aria-expanded',String(panel === 'warps'));
    warpMenu.show(panel === 'warps');
    if (panel === 'warps') return;
    if (panel === 'clock') clockInput.value = clockText;
    if (panel === 'chat') {
      updateUnread(0);
      if (byId('game').classList.contains('touch')) log.focus({preventScroll:true});
      else chatInput.focus();
      log.scrollTop = log.scrollHeight;
    } else {
      const input = panel === 'clock' ? clockInput : coordinateInputs[0][1];
      input.focus();
    }
  }

  function showOnline(active) {
    onlineVisible = active;
    online.hidden = !active;
  }

  function roster(others, self) {
    peers = others;
    players = [...(self ? [self] : []), ...peers].map(({nickname}) => nickname)
      .sort((a, b) => a.localeCompare(b, 'ru'));
    connected = Boolean(self);
    byId('online-count').textContent = String(players.length);
    names.replaceChildren(...players.map(nick => {
      const item = document.createElement('li');
      item.textContent = nick;
      return item;
    }));
    byId('chat-toggle').disabled = !connected;
    clockButton.disabled=teleportButton.disabled=warpButton.disabled=!connected||!admin;
  }

  async function submit(path, payload, fallback) {
    try {
      const result = await post(path, payload, AbortSignal.timeout(5000));
      if (result.ok) return result.body;
      notice(result.body.error === 'chat_rate_limit' ? 'Подожди несколько секунд перед отправкой' : fallback);
    } catch {
      notice('Связь с сервером прервана');
    }
  }

  chatForm.addEventListener('submit', async event => {
    event.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    const send = byId('chat-send');
    if (send.disabled) return;
    send.disabled = true;
    const destination = channel;
    if (text.startsWith('//') && worldEditCommand) {
      try {
        if (await worldEditCommand(text) && chatInput.value.trim()===text) chatInput.value='';
      } finally {send.disabled=false;}
      return;
    }
    const message = await submit('chat', {text, channel:destination}, 'Введите сообщение длиной до 240 символов');
    send.disabled = false;
    if (message) {
      entry(message, true);
      if (chatInput.value.trim() === text) chatInput.value = '';
    }
  });
  byId('chat-toggle').addEventListener('click', () => open('chat'));
  channelButton.addEventListener('pointerdown',event=>{
    if (document.activeElement===chatInput) event.preventDefault();
  });
  channelButton.addEventListener('click', () => {
    channel = channel === 'global' ? 'local' : 'global';
    updateChannel();
  });
  clockButton.addEventListener('click', () => open('clock'));
  teleportButton.addEventListener('click', () => open('teleport'));
  warpButton.addEventListener('click', () => open('warps'));
  byId('chat-close').addEventListener('click', () => close());
  byId('clock-close').addEventListener('click', () => close());
  byId('teleport-close').addEventListener('click', () => close());
  dynamic.addEventListener('change',async()=>{
    if (!admin || dynamic.disabled) return;
    dynamic.disabled=true;
    try {
      const result=await submit('weather',{dynamic:dynamic.checked},'Не удалось изменить динамическую погоду');
      if (result) weatherChanged(result);
    } finally {
      dynamic.checked=dynamicWeather;
      dynamic.disabled=false;
    }
  });
  clockForm.addEventListener('submit', async event => {
    event.preventDefault();
    const tick = tickFromTime(clockInput.value);
    if (!Number.isFinite(tick) || writingTime) return;
    writingTime = true;
    await submit('time', {tick, frozen:frozen.checked}, 'Не удалось применить время');
    writingTime = false;
  });
  teleportForm.addEventListener('submit', async event => {
    event.preventDefault();
    const send = byId('teleport-send');
    if (send.disabled) return;
    const target = Object.fromEntries(coordinateInputs.map(([axis, input]) => [axis, input.valueAsNumber]));
    if (!Object.values(target).every(Number.isFinite)) return;
    send.disabled = true;
    try {
      const {ok, body} = await teleport(target);
      notice(ok ? 'Телепорт выполнен' : teleportErrors[body.error] ?? 'Не удалось телепортироваться');
    } catch {
      notice('Связь с сервером прервана');
    } finally {
      send.disabled = false;
    }
  });

  return {
    setAdmin(allowed) {
      admin=Boolean(allowed);
      if (!admin&&panel&&panel!=='chat') close(false);
      clockButton.disabled=teleportButton.disabled=warpButton.disabled=!connected||!admin;
      teleportButton.hidden=warpButton.hidden=byId('touch-teleport').hidden=!admin;
      for (const hint of document.querySelectorAll('[data-admin-control-hint]')) hint.hidden=!admin;
    },
    isOpen: () => !!panel,
    isChatOpen: () => panel === 'chat',
    close,
    keydown(event, playing) {
      if (panel) {
        if (event.code === 'Escape') { event.preventDefault(); close(); }
        return true;
      }
      if (!playing || !connected) return false;
      if (event.code === 'Tab') {
        event.preventDefault();
        showOnline(true);
        return true;
      }
      const next = {KeyT:'chat', Enter:'chat', NumpadEnter:'chat', KeyL:'clock', KeyG:'teleport'}[event.code];
      if (!event.repeat && next && (next==='chat'||admin)) {
        event.preventDefault();
        open(next);
        return true;
      }
      return false;
    },
    keyup(event) {
      if (event.code === 'Tab' && onlineVisible) { event.preventDefault(); showOnline(false); }
    },
    blur() { showOnline(false); },
    roster,
    warpsChanged:warpMenu.update,
    refreshWarps() { if (panel === 'warps') void warpMenu.refresh(); },
    profileUpdated(profile) { if (connected) roster(peers, profile); },
    history(list) {
      for (const message of list) entry(message, false);
    },
    message(message) { entry(message, true); },
    updateClock(tick, isFrozen) {
      const text = formatClock(tick);
      if (clockText !== text || clockButton.classList.contains('frozen') !== isFrozen) {
        clockText = text;
        clockButton.textContent = text;
        clockButton.classList.toggle('frozen', isFrozen);
        clockButton.title = isFrozen ? 'Время остановлено · L' : 'Игровое время · L';
      }
    },
    clockState(state) { frozen.checked = state.frozen; },
    weatherState(state) {
      dynamicWeather=state.dynamic;
      dynamic.checked=dynamicWeather;
    },
    names: () => players.slice(),
  };
}
