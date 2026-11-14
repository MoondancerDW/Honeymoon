import {formatClock, tickFromTime} from '../world/world-time.mjs';

export function createSocialHud({post, notice, pause, resume}) {
  const byId = id => document.getElementById(id);
  const chat = byId('chat');
  const log = byId('chat-log');
  const chatForm = byId('chat-form');
  const chatInput = byId('chat-input');
  const clockButton = byId('clock-toggle');
  const clockForm = byId('clock-form');
  const clockInput = byId('clock-input');
  const frozen = byId('clock-frozen');
  const online = byId('online');
  const names = byId('online-names');
  const seen = new Set();
  let panel, onlineVisible = false, connected = false, players = [], clockText, writingTime = false;

  function entry({id, kind, nickname, text}, recent) {
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
    chatForm.hidden = clockForm.hidden = true;
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
    if (panel === 'clock') clockInput.value = clockText;
    const input = panel === 'chat' ? chatInput : clockInput;
    input.focus();
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
    const message = await submit('chat', {text}, 'Введите сообщение длиной до 240 символов');
    send.disabled = false;
    if (message) {
      entry(message, true);
      if (chatInput.value.trim() === text) chatInput.value = '';
    }
  });
  byId('chat-toggle').addEventListener('click', () => open('chat'));
  clockButton.addEventListener('click', () => open('clock'));
  byId('chat-close').addEventListener('click', () => close());
  byId('clock-close').addEventListener('click', () => close());
  clockForm.addEventListener('submit', async event => {
    event.preventDefault();
    const tick = tickFromTime(clockInput.value);
    if (!Number.isFinite(tick) || writingTime) return;
    writingTime = true;
    await submit('time', {tick, frozen:frozen.checked}, 'Не удалось применить время');
    writingTime = false;
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
      if (!event.repeat && ['KeyT','KeyK'].includes(event.code)) {
        event.preventDefault();
        open(event.code === 'KeyT' ? 'chat' : 'clock');
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
      clockButton.disabled = byId('chat-toggle').disabled = !connected;
    },
    history(list) {
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
