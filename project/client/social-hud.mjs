import {formatClock, tickFromTime} from '../world/world-time.mjs';

const teleportErrors = {
  invalid_coordinates:'Введите числовые координаты X, Y и Z',
  outside_playable_area:'Координаты за пределами карты',
  teleport_blocked:'В выбранной точке недостаточно места',
  not_online:'Сначала войдите в мир',
  action_pending:'Дождитесь завершения текущего действия',
};

export function createSocialHud({post, notice, pause, resume, teleport}) {
  const byId = id => document.getElementById(id);
  const chat = byId('chat');
  const channels = {
    global:{log:byId('chat-log'), seen:new Set(), label:'Глобальный'},
    local:{log:byId('local-chat-log'), seen:new Set(), label:'Локальный · 18 блоков'},
  };
  const channelButton = byId('chat-channel');
  const chatForm = byId('chat-form');
  const chatInput = byId('chat-input');
  const clockButton = byId('clock-toggle');
  const clockForm = byId('clock-form');
  const clockInput = byId('clock-input');
  const frozen = byId('clock-frozen');
  const teleportButton = byId('teleport-toggle');
  const teleportForm = byId('teleport-form');
  const coordinateInputs = ['x','y','z'].map(axis => [axis, byId(`teleport-${axis}`)]);
  const online = byId('online');
  const names = byId('online-names');
  let panel, onlineVisible = false, connected = false, players = [], clockText, writingTime = false;
  let channel = 'global';

  function entry({id, kind, nickname, text, channel:target = 'global'}, recent) {
    const {log, seen} = channels[target] ?? channels.global;
    if (seen.has(id)) return;
    seen.add(id);
    const row = document.createElement('li');
    row.dataset.messageId = id;
    if (kind === 'message') {
      const sender = document.createElement('strong');
      sender.textContent = nickname;
      row.append(sender, document.createTextNode(`  ${text}`));
    } else {
      row.className = 'chat-status';
      row.textContent = `${nickname} ${kind === 'join' ? 'входит в игру' : 'выходит из игры'}`;
    }
    if (recent) {
      row.classList.add('recent');
      setTimeout(() => row.classList.remove('recent'), 8500);
    }
    log.append(row);
    if (log.childElementCount > 60) {
      seen.delete(Number(log.firstElementChild.dataset.messageId));
      log.firstElementChild.remove();
    }
    log.scrollTop = log.scrollHeight;
  }

  function close(continuePlaying = true) {
    if (!panel) return;
    panel = null;
    chat.classList.remove('expanded');
    chatForm.hidden = clockForm.hidden = teleportForm.hidden = true;
    if (continuePlaying) resume();
  }

  function open(next) {
    if (!connected) return;
    if (panel === next) return close();
    pause();
    panel = next;
    chat.classList.toggle('expanded', panel === 'chat');
    chatForm.hidden = panel !== 'chat';
    clockForm.hidden = panel !== 'clock';
    teleportForm.hidden = panel !== 'teleport';
    if (panel === 'clock') clockInput.value = clockText;
    const input = panel === 'chat' ? chatInput : panel === 'clock' ? clockInput : coordinateInputs[0][1];
    input.focus();
    const {log} = channels[channel];
    log.scrollTop = log.scrollHeight;
  }

  function showOnline(active) {
    onlineVisible = active;
    online.hidden = !active;
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
    const message = await submit('chat', {text, channel:destination}, 'Введите сообщение длиной до 240 символов');
    send.disabled = false;
    if (message) {
      entry(message, true);
      if (channel === destination && chatInput.value.trim() === text) chatInput.value = '';
    }
  });
  byId('chat-toggle').addEventListener('click', () => open('chat'));
  channelButton.addEventListener('click', () => {
    const next = channel === 'global' ? 'local' : 'global';
    channels[channel].log.hidden = true;
    channel = next;
    const {log, label} = channels[channel];
    log.hidden = false;
    log.scrollTop = log.scrollHeight;
    channelButton.textContent = label;
    channelButton.setAttribute('aria-pressed', String(channel === 'local'));
    chatInput.focus();
  });
  clockButton.addEventListener('click', () => open('clock'));
  teleportButton.addEventListener('click', () => open('teleport'));
  byId('chat-close').addEventListener('click', () => close());
  byId('clock-close').addEventListener('click', () => close());
  byId('teleport-close').addEventListener('click', () => close());
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
    isOpen: () => !!panel,
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
      const next = {KeyT:'chat', KeyK:'clock', KeyG:'teleport'}[event.code];
      if (!event.repeat && next) {
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
    roster(peers, self) {
      players = [...(self ? [self] : []), ...peers].map(({nickname}) => nickname)
        .sort((a, b) => a.localeCompare(b, 'ru'));
      connected = Boolean(self);
      byId('online-count').textContent = String(players.length);
      names.replaceChildren(...players.map(nick => {
        const item = document.createElement('li');
        item.textContent = nick;
        return item;
      }));
      clockButton.disabled = byId('chat-toggle').disabled = teleportButton.disabled = !connected;
    },
    history(list) {
      const {log, seen} = channels.global;
      log.replaceChildren();
      seen.clear();
      for (const message of list) entry(message, false);
    },
    message(message) { entry(message, true); },
    updateClock(tick, isFrozen) {
      const text = formatClock(tick);
      if (clockText !== text || clockButton.classList.contains('frozen') !== isFrozen) {
        clockText = text;
        clockButton.textContent = text;
        clockButton.classList.toggle('frozen', isFrozen);
        clockButton.title = isFrozen ? 'Время остановлено · K' : 'Игровое время · K';
      }
    },
    clockState(state) { frozen.checked = state.frozen; },
    names: () => players.slice(),
  };
}
