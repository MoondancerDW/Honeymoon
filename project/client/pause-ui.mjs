export function createPauseMenu(game, touchMode) {
  const byId = id => document.getElementById(id);
  const menu = byId('pause-menu');
  const start = byId('entry-start');
  const profile = start.querySelector('.profile');
  const play = byId('play');
  const skin = byId('pony-skin');
  const quickSkin = byId('pause-skin');
  const entryWorld = byId('entry-world-switch');
  const pauseWorld = byId('pause-world-switch');
  const heading = byId('pause-heading');
  const homeTitle = heading.textContent;
  const back = byId('pause-back');
  const home = byId('pause-home');
  const content = menu.querySelector('.pause-content');
  const footer = menu.querySelector('.pause-footer');
  const guide = byId('keys');
  const guideParent = guide.parentElement;
  const commands = byId('pause-commands');
  const wideLayout = matchMedia('(min-width: 65rem) and (min-height: 35rem)');
  const sections = [...home.querySelectorAll('[data-pause-section]')].map(button => ({
    button, panel:byId(button.getAttribute('aria-controls')),
  }));
  const tabs = [...menu.querySelectorAll('[data-pause-tab]')];
  let activeSection, watchingClose, setSocialDock;

  function layout() {
    const docked = !menu.hidden && wideLayout.matches;
    const parent = docked ? commands : guideParent;
    if (guide.parentElement !== parent) parent.append(guide);
    setSocialDock?.(docked);
  }

  function selectTab(tab, focus = false) {
    for (const button of tabs) {
      const selected = button === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      byId(button.getAttribute('aria-controls')).hidden = !selected;
    }
    content.scrollTop = 0;
    if (focus) tab.focus({preventScroll:true});
  }

  function openSection(section, focus = true) {
    const previous = activeSection;
    activeSection = section;
    home.hidden = Boolean(section);
    back.hidden = !section;
    for (const page of sections) page.panel.hidden = page !== section;
    heading.textContent = section?.button.textContent ?? homeTitle;
    content.scrollTop = 0;
    if (focus) {
      const target = section ? heading : previous?.button ?? play;
      target.focus({preventScroll:true});
    }
  }

  function childOpen() {
    return game.classList.contains('altitude-map-open') ||
      Boolean(game.querySelector('dialog[open], #chat.expanded, #clock-form:not([hidden]), #teleport-form:not([hidden]), #warps-menu:not([hidden])'));
  }

  function closeMenu() {
    if (activeSection) openSection(null);
    else play.click();
  }

  function watchClose() {
    if (typeof CloseWatcher !== 'function' || !game.classList.contains('touch') || menu.hidden) return;
    watchingClose = new CloseWatcher();
    watchingClose.onclose = () => {
      watchingClose = undefined;
      if (!childOpen()) closeMenu();
      watchClose();
    };
  }

  function show(paused) {
    if (paused === !menu.hidden) return;
    if (paused) {
      footer.prepend(play);
      byId('pause-profile').prepend(profile);
      pauseWorld.append(entryWorld);
      start.hidden = true;
      menu.hidden = false;
      selectTab(tabs[0]);
      openSection(null,false);
      layout();
      if (!childOpen()) heading.focus({preventScroll:true});
      watchClose();
    } else {
      const soloEntry = start.querySelector('.solo-entry-button');
      start.insertBefore(play, soloEntry);
      start.insertBefore(profile, play);
      start.insertBefore(entryWorld,byId('entry-help'));
      menu.hidden = true;
      start.hidden = false;
      layout();
      watchingClose?.destroy();
      watchingClose = undefined;
    }
  }

  back.addEventListener('click', () => openSection(null));
  wideLayout.addEventListener('change',layout);
  for (const page of sections) page.button.addEventListener('click', () => openSection(page));
  quickSkin.addEventListener('click', () => {
    if (skin.disabled) return;
    openSection(sections.find(page => page.panel.id === 'pause-profile'),false);
    skin.click();
  });
  const syncSkinButton = () => { quickSkin.disabled = skin.disabled; };
  new MutationObserver(syncSkinButton).observe(skin,{attributeFilter:['disabled']});
  syncSkinButton();
  for (const tab of tabs) tab.addEventListener('click', () => selectTab(tab));
  menu.querySelector('.pause-tabs').addEventListener('keydown', event => {
    const index = tabs.indexOf(event.target);
    if (index < 0) return;
    const next = {ArrowLeft:(index + tabs.length - 1) % tabs.length, ArrowRight:(index + 1) % tabs.length,
      Home:0, End:tabs.length - 1}[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectTab(tabs[next],true);
  });

  document.addEventListener('keydown', event => {
    if (event.code !== 'Escape' || menu.hidden || childOpen() || event.target?.closest?.('#pause-chat-slot > #chat') ||
        (!activeSection && !game.classList.contains('touch'))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat) closeMenu();
  },true);

  const clock = byId('clock-toggle');
  const pauseClock = byId('pause-clock');
  const updateClock = () => {
    pauseClock.disabled = clock.disabled;
    const label = `Игровое время · ${clock.textContent}`;
    if (pauseClock.textContent !== label) pauseClock.textContent = label;
  };
  new MutationObserver(updateClock).observe(clock,{attributeFilter:['disabled'],childList:true,characterData:true,subtree:true});
  updateClock();
  pauseClock.addEventListener('click', () => clock.click());

  for (const id of ['show-coordinates','show-metrics']) {
    const input = byId(id);
    const key = 'honeymoon-' + id + (touchMode ? '' : '-desktop');
    input.checked = !touchMode;
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null) input.checked = saved === 'true';
    } catch { /* Storage can be disabled. */ }
    game.classList.toggle(id,input.checked);
    input.addEventListener('change', () => {
      game.classList.toggle(id,input.checked);
      try { localStorage.setItem(key,String(input.checked)); } catch { /* The setting applies to this page. */ }
    });
  }

  return {
    show,
    setSocialDock(handler) { setSocialDock = handler; layout(); },
    focusProfile() {
      if (menu.hidden) return;
      openSection(sections.find(page => page.button.dataset.pauseSection === 'profile'),false);
      byId('nickname').focus({preventScroll:true});
    },
  };
}
