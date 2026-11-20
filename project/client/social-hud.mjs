import {formatClock, tickFromTime} from '../world/world-time.mjs';
import {CHAT_RETENTION_MS,CHAT_TEXT_LIMIT,limitChatText} from '../world/chat-text.mjs';
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
const globalChatPreference = 'honeymoon-chat-global';
const chatDraftKey = 'honeymoon-chat-draft';
const chatErrors={
  invalid_admin_command:'Проверь команду и её аргументы',
  player_missing:'Игрок не найден',
  player_ambiguous:'Имя неоднозначно. Уточни ник или имя профиля.',
  not_online:'Игрок сейчас вне игры',
  admin_target_self:'Нельзя телепортироваться к самому себе',
  teleport_blocked:'Рядом с игроком нет свободного места',
  owner_required:'Этого игрока может переместить или изменить только владелец',
  spectator_action:'Наблюдатель может отправлять команды администратора',
};

export function createSocialHud({post,notice,pause,resume,teleport,teleportPlayer,loadWarps,placeWarp,worldEditCommand,
  weatherChanged,commandResult}) {
  const byId = id => document.getElementById(id);
  const game = byId('game');
  const chat = byId('chat');
  const log = byId('chat-log');
  const chatToggle = byId('chat-toggle');
  const touchChat = byId('touch-chat'), unreadBadge = byId('chat-unread');
  const chatHeader = byId('chat-header');
  const chatClose = byId('chat-close');
  const globalToggle = byId('chat-global-toggle');
  const draftToggle = byId('chat-draft-toggle');
  const seen = new Set();
  const unreadRows = new Set();
  const channelButton = byId('chat-channel');
  const chatForm = byId('chat-form');
  const chatInput = byId('chat-input');
  const chatSend = byId('chat-send');
  const clockButton = byId('clock-toggle');
  const clockForm = byId('clock-form');
  const pauseClock = byId('pause-clock');
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
  const pausePlayers=byId('pause-player-list'), pausePlayerCount=byId('pause-players-count');
  const emptyPausePlayers=byId('pause-players-empty');
  const chatSlot = byId('pause-chat-slot'), clockSlot = byId('pause-clock-slot');
  const chatHome = document.createComment('gameplay chat');
  const clockHome = document.createComment('gameplay clock');
  chat.before(chatHome);
  clockForm.before(clockHome);
  let panel, onlineVisible = false, connected = false, players = [], clockText, writingTime = false;
  let pauseDock = false, openedFromPause = false, sendingChat = false;
  let peers = [], selfProfile, teleporting;
  let channel = 'global';
  let globalEnabled = true;
  let draftProfile, keepDraft = false;
  const outgoingChannel = () => globalEnabled ? channel : 'local';
  let serverClock, expiryTimer, scheduledExpiry;
  let admin=false;
  let dynamicWeather=false;
  chatInput.disabled = chatSend.disabled = true;
  chatInput.maxLength = CHAT_TEXT_LIMIT * 2;
  try { globalEnabled = localStorage.getItem(globalChatPreference) !== '0'; } catch {}

  function storedDraft() {
    try {
      const record = JSON.parse(localStorage.getItem(chatDraftKey));
      if (typeof record?.uid === 'string' && typeof record.text === 'string') return record;
    } catch {}
  }

  function removeDraft(expectedText) {
    const record = storedDraft();
    if (!record || record.uid !== draftProfile || (expectedText !== undefined && expectedText !== record.text)) return;
    try { localStorage.removeItem(chatDraftKey); }
    catch { notice('Не удалось удалить сохранённый черновик'); }
  }

  function setKeepingDraft(value) {
    keepDraft = value;
    draftToggle.disabled = !draftProfile;
    draftToggle.setAttribute('aria-pressed',String(value));
    draftToggle.title = value ? 'Не сохранять черновик' : 'Сохранить черновик';
  }

  function updateDraft() {
    const text = limitChatText(chatInput.value);
    if (chatInput.value !== text) chatInput.value = text;
    if (!keepDraft) return;
    if (!text.trim()) { removeDraft(); return; }
    try { localStorage.setItem(chatDraftKey,JSON.stringify({uid:draftProfile,text,channel:outgoingChannel()})); }
    catch {
      setKeepingDraft(false);
      notice('Не удалось сохранить черновик на устройстве');
    }
  }

  function finishSend(sentText) {
    removeDraft(sentText);
    if (chatInput.value === sentText) {
      chatInput.value = '';
      setKeepingDraft(false);
    }
  }

  function updateUnread() {
    const unread = unreadRows.size;
    unreadBadge.hidden=!unread;
    unreadBadge.textContent=unread>99?'99+':String(unread);
    touchChat.setAttribute('aria-label',unread ? `Открыть чат. Непрочитанных: ${unread}` : 'Открыть чат');
  }

  function markChatRead() {
    unreadRows.clear();
    updateUnread();
  }

  function chatTime() {
    if (!serverClock) return Date.now();
    // Wall time includes device sleep, while monotonic time protects against clock rollbacks.
    const elapsed = Math.max(Date.now() - serverClock.wall, performance.now() - serverClock.monotonic);
    return serverClock.at + elapsed;
  }

  function pruneChat(now) {
    let unreadChanged = false;
    let row;
    while ((row = log.firstElementChild) && Number(row.dataset.expiresAt) <= now) {
      seen.delete(Number(row.dataset.messageId));
      if (unreadRows.delete(row)) unreadChanged = true;
      row.remove();
    }
    if (unreadChanged) updateUnread();
  }

  function scheduleChatExpiry(now, reschedule = false) {
    const next = log.firstElementChild;
    const expiresAt = next ? Number(next.dataset.expiresAt) : undefined;
    if (!reschedule && expiresAt === scheduledExpiry) return;
    clearTimeout(expiryTimer);
    scheduledExpiry = expiresAt;
    if (!next) return;
    expiryTimer = setTimeout(refreshChatExpiry, Math.max(0, Math.ceil(expiresAt - now)));
  }

  function refreshChatExpiry() {
    const now = chatTime();
    pruneChat(now);
    scheduleChatExpiry(now, true);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshChatExpiry();
  });
  window.addEventListener('pageshow', refreshChatExpiry);

  function readingChat() {
    return panel === 'chat' || chat.classList.contains('docked');
  }

  function followsChat() {
    return !readingChat() || log.scrollHeight - log.clientHeight - log.scrollTop < 8;
  }

  function updateChannel() {
    const local = channel === 'local';
    channelButton.querySelector('span').textContent = local ? 'Рядом' : 'Мир';
    channelButton.setAttribute('aria-pressed',String(local));
    channelButton.title = local ? 'Локальный чат · 18 блоков. Нажмите для глобального чата' :
      'Глобальный чат. Нажмите для локального чата';
    channelButton.setAttribute('aria-label',channelButton.title);
  }

  function updateGlobalChat() {
    globalToggle.setAttribute('aria-pressed',String(globalEnabled));
    globalToggle.title = globalEnabled ? 'Скрыть общий чат' : 'Показать общий чат';
    channelButton.hidden = !globalEnabled;
    chatInput.placeholder = globalEnabled ? 'Сообщение…' : 'Сообщение рядом…';
    chatInput.setAttribute('aria-label',globalEnabled ? 'Сообщение' : 'Сообщение в локальный чат');
    for (const row of log.querySelectorAll('[data-chat-channel="global"]')) row.hidden = !globalEnabled;
    log.scrollTop = log.scrollHeight;
  }
  updateChannel();
  updateGlobalChat();
  setKeepingDraft(false);

  function placePanel(element, slot, home, docked) {
    if (docked) {
      if (element.parentNode !== slot) slot.append(element);
    } else if (home.nextSibling !== element) home.after(element);
    element.classList.toggle('docked', docked);
  }

  function renderPanels() {
    const wasDocked = chat.classList.contains('docked');
    const dockClock = pauseDock && openedFromPause && panel === 'clock';
    const dockChat = pauseDock && (!panel || dockClock);
    const showChat = dockChat || panel === 'chat';
    if (!showChat && !chatForm.hidden && !keepDraft) chatInput.value = '';
    if (wasDocked && !dockChat && document.activeElement === chatInput) chatInput.blur();
    placePanel(chat, chatSlot, chatHome, dockChat);
    chat.classList.toggle('expanded', panel === 'chat');
    chatHeader.hidden = chatForm.hidden = !showChat;
    chatClose.hidden = dockChat;
    if (dockChat && !wasDocked) {
      markChatRead();
      log.scrollTop = log.scrollHeight;
    }
    placePanel(clockForm, clockSlot, clockHome, dockClock);
    clockForm.hidden = panel !== 'clock';
    teleportForm.hidden = panel !== 'teleport';
  }

  function entry({id, at, kind, cause, nickname, newNickname, text, admin, channel:target = 'system'}, now, recent) {
    if (!Number.isSafeInteger(id) || !Number.isFinite(at) || seen.has(id)) return false;
    const expiresAt = at + CHAT_RETENTION_MS;
    if (expiresAt <= now) return false;
    seen.add(id);
    const row = document.createElement('li');
    row.dataset.messageId = id;
    row.dataset.expiresAt = expiresAt;
    row.dataset.chatChannel = target;
    row.hidden = !globalEnabled && target === 'global';
    if (target === 'global') {
      const marker = document.createElement('span');
      marker.className = 'chat-global';
      marker.textContent = '[G] ';
      row.append(marker);
    }
    const sender = document.createElement(kind === 'message' ? 'strong' : 'span');
    sender.textContent = nickname;
    sender.classList.toggle('chat-admin-name',admin === true);
    row.append(sender);
    if (kind === 'message') row.append(document.createTextNode(`  ${text}`));
    else {
      row.className = 'chat-status';
      const changes = kind === 'death' ? (cause==='lava' ? 'Сгорел' : 'помер') : kind === 'rename' ? `сменил ник на ${newNickname}` :
        kind === 'join' ? 'входит в игру' : 'выходит из игры';
      row.append(document.createTextNode(` ${changes}`));
    }
    if (recent) {
      row.classList.add('recent');
      if (kind==='message' && !readingChat() && !row.hidden) {
        unreadRows.add(row);
        updateUnread();
      }
      setTimeout(() => row.classList.add('fading'), 6500);
      setTimeout(() => row.classList.remove('recent', 'fading'), 8500);
    }
    let previous = log.lastElementChild;
    while (previous) {
      const previousExpiry = Number(previous.dataset.expiresAt);
      if (previousExpiry < expiresAt || (previousExpiry === expiresAt && Number(previous.dataset.messageId) < id)) break;
      previous = previous.previousElementSibling;
    }
    if (previous) previous.after(row);
    else log.prepend(row);
    return true;
  }

  function receiveChat(message) {
    const now = chatTime();
    pruneChat(now);
    const follow = followsChat();
    if (entry(message, now, true) && follow) log.scrollTop = log.scrollHeight;
    scheduleChatExpiry(now);
  }

  function close(continuePlaying = true) {
    if (!panel) return;
    const previous = panel, returnToPause = openedFromPause;
    panel = null;
    openedFromPause = false;
    renderPanels();
    if (previous === 'warps') {
      warpMenu.show(false);
      warpButton.setAttribute('aria-expanded','false');
      warpButton.focus({preventScroll:true});
    } else if (continuePlaying && returnToPause) {
      const control = {chat:chatToggle, clock:pauseClock, teleport:teleportButton}[previous];
      (control?.getClientRects().length ? control : byId('pause-heading')).focus({preventScroll:true});
    } else if (continuePlaying) resume();
  }

  function open(next) {
    if (next!=='chat'&&!admin) return;
    if (!connected) return;
    if (panel === next) return close();
    if (!panel && next === 'chat' && pauseDock) {
      chatInput.focus({preventScroll:true});
      return;
    }
    openedFromPause = game.classList.contains('paused');
    pause();
    panel = next;
    renderPanels();
    warpButton.setAttribute('aria-expanded',String(panel === 'warps'));
    warpMenu.show(panel === 'warps');
    if (panel === 'warps') return;
    if (panel === 'clock') clockInput.value = clockText;
    if (panel === 'chat') {
      markChatRead();
      if (game.classList.contains('touch')) log.focus({preventScroll:true});
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
    selfProfile=self;
    const profiles=[...(self ? [self] : []), ...peers].sort((a,b)=>a.nickname.localeCompare(b.nickname,'ru'));
    players=profiles.map(({nickname})=>nickname);
    connected = Boolean(self);
    byId('online-count').textContent = String(players.length);
    names.replaceChildren(...players.map(nick => {
      const item = document.createElement('li');
      item.textContent = nick;
      return item;
    }));
    paintPausePlayers(profiles);
    chatToggle.disabled = chatInput.disabled = !connected;
    chatSend.disabled = sendingChat || !connected;
    clockButton.disabled=teleportButton.disabled=warpButton.disabled=!connected||!admin;
  }

  function paintPausePlayers(profiles) {
    pausePlayerCount.textContent=String(profiles.length);
    emptyPausePlayers.hidden=profiles.length!==0;
    pausePlayers.replaceChildren(...profiles.map(profile=>{
      const row=document.createElement('tr');
      const name=document.createElement('td');
      const label=profile.spectator ? profile.nickname+' · наблюдатель' : profile.nickname;
      if (admin && profile.uid && profile!==selfProfile) {
        const link=document.createElement('button');
        link.type='button';
        link.className='pause-player-link';
        link.textContent=label;
        link.title='Телепортироваться к игроку «'+profile.nickname+'»';
        link.setAttribute('aria-label',link.title);
        link.addEventListener('click',async ()=>{
          if (teleporting || !admin) return;
          teleporting=link.disabled=true;
          try {await teleportPlayer(profile.uid);}
          finally {teleporting=link.disabled=false;}
        });
        name.append(link);
      } else name.textContent=label;
      row.append(name);
      return row;
    }));
  }

  async function submit(path, payload, fallback) {
    try {
      const result = await post(path, payload, AbortSignal.timeout(5000));
      if (result.ok) return result.body;
      notice(result.body.error === 'chat_rate_limit' ? 'Подожди несколько секунд перед отправкой' :
        chatErrors[result.body.error] ?? fallback);
    } catch {
      notice('Связь с сервером прервана');
    }
  }

  chatForm.addEventListener('submit', async event => {
    event.preventDefault();
    const sentText = chatInput.value;
    const text = sentText.trim();
    if (!text || !connected || sendingChat) return;
    if (limitChatText(text) !== text) {
      notice(`Введите сообщение длиной до ${CHAT_TEXT_LIMIT} символов`);
      return;
    }
    sendingChat = chatSend.disabled = true;
    const destination = outgoingChannel();
    try {
      if (text.startsWith('//') && worldEditCommand) {
        if (await worldEditCommand(text)) finishSend(sentText);
        return;
      }
      const message = await submit('chat', {text, channel:destination}, `Введите сообщение длиной до ${CHAT_TEXT_LIMIT} символов`);
      if (message) {
        finishSend(sentText);
        if (message.command) {
          if (message.feedback) notice(message.feedback);
          try {await commandResult(message);}
          catch {notice('Не удалось применить ответ сервера');}
        } else receiveChat(message);
      }
    } finally {
      sendingChat = false;
      chatSend.disabled = !connected;
    }
  });
  chatToggle.addEventListener('click', () => open('chat'));
  const keepComposerFocus = event=>{
    if (document.activeElement===chatInput) event.preventDefault();
  };
  for (const control of [channelButton,globalToggle,draftToggle]) control.addEventListener('pointerdown',keepComposerFocus);
  channelButton.addEventListener('click', () => {
    if (!globalEnabled) return;
    channel = channel === 'global' ? 'local' : 'global';
    updateChannel();
    if (keepDraft) updateDraft();
  });
  globalToggle.addEventListener('click', () => {
    globalEnabled = !globalEnabled;
    try { localStorage.setItem(globalChatPreference,globalEnabled ? '1' : '0'); } catch {}
    updateGlobalChat();
    if (keepDraft) updateDraft();
  });
  draftToggle.addEventListener('click', () => {
    if (!draftProfile) return;
    setKeepingDraft(!keepDraft);
    if (keepDraft) updateDraft();
    else removeDraft();
  });
  chatInput.addEventListener('input',event=>{ if (!event.isComposing) updateDraft(); });
  chatInput.addEventListener('compositionend',updateDraft);
  clockButton.addEventListener('click', () => open('clock'));
  teleportButton.addEventListener('click', () => open('teleport'));
  warpButton.addEventListener('click', () => open('warps'));
  chatClose.addEventListener('click', () => close());
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
    setChatProfile(uid) {
      if (draftProfile === uid) return;
      draftProfile = uid;
      const record = storedDraft();
      const text = uid && record?.uid === uid ? limitChatText(record.text) : '';
      chatInput.value = text;
      channel = text && record.channel === 'local' ? 'local' : 'global';
      updateChannel();
      setKeepingDraft(Boolean(text.trim()));
    },
    setAdmin(allowed) {
      const changed=admin!==Boolean(allowed);
      admin=Boolean(allowed);
      if (!admin&&panel&&panel!=='chat') close(false);
      clockButton.disabled=teleportButton.disabled=warpButton.disabled=!connected||!admin;
      teleportButton.hidden=warpButton.hidden=byId('touch-teleport').hidden=!admin;
      for (const hint of document.querySelectorAll('[data-admin-control-hint]')) hint.hidden=!admin;
      if (changed) roster(peers,selfProfile);
    },
    isOpen: () => !!panel,
    isChatOpen: () => panel === 'chat',
    close,
    setPauseDock(active) {
      if (pauseDock === active) return;
      pauseDock = active;
      if ((active && panel === 'chat' && openedFromPause) || (!active && clockForm.classList.contains('docked'))) close(false);
      else renderPanels();
    },
    keydown(event, playing) {
      if (chat.classList.contains('docked') && chat.contains(event.target)) {
        if (event.code === 'Escape') { event.preventDefault(); event.target.blur?.(); }
        return true;
      }
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
    history({entries, serverAt}) {
      // Batched snapshots can share the timestamp of the first packet.
      const updateClock = Number.isFinite(serverAt) && serverAt !== serverClock?.at;
      if (updateClock) serverClock = {at:serverAt, wall:Date.now(), monotonic:performance.now()};
      const now = chatTime();
      pruneChat(now);
      const follow = followsChat();
      for (const message of entries) entry(message, now, false);
      if (follow) log.scrollTop = log.scrollHeight;
      scheduleChatExpiry(chatTime(), updateClock);
    },
    message:receiveChat,
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
