const byId = id => document.getElementById(id);
const game = byId('game');
const fullscreen = byId('fullscreen-toggle');
const fullscreenHelp = byId('fullscreen-help');
const root = document.documentElement;
const standalone = matchMedia('(display-mode: standalone)');
const isFullscreen = () => Boolean(document.fullscreenElement || document.webkitFullscreenElement);

if (matchMedia('(pointer: coarse)').matches) byId('touch-pause').before(fullscreen);

function updateFullscreen() {
  const active = isFullscreen();
  const supported = Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  const installed = standalone.matches || navigator.standalone === true;
  fullscreen.hidden = !active && (!supported || installed);
  fullscreenHelp.hidden = active || supported || installed;
  fullscreen.setAttribute('aria-pressed', String(active));
  fullscreen.setAttribute('aria-label', active ? 'Выйти из полного экрана' : 'На весь экран');
  fullscreen.title = fullscreen.getAttribute('aria-label');
}

fullscreen.addEventListener('click', async () => {
  try {
    if (isFullscreen()) {
      const exit = document.exitFullscreen ?? document.webkitExitFullscreen;
      await exit?.call(document);
    } else {
      const enter = root.requestFullscreen ?? root.webkitRequestFullscreen;
      await enter?.call(root);
    }
  } catch {
    fullscreenHelp.hidden = false;
  }
});
for (const event of ['fullscreenchange','webkitfullscreenchange']) document.addEventListener(event,updateFullscreen);
standalone.addEventListener?.('change',updateFullscreen);
updateFullscreen();

const pauseSections = byId('mobile-pause-sections');
const sectionButtons = [...pauseSections.querySelectorAll('button')];
const pauseProfile = byId('mobile-profile'), pauseSettings = byId('mobile-settings');
const profile = document.querySelector('#entry .profile'), tools = document.querySelector('.top .tools');
const entry = document.querySelector('#entry .panel');
const top = document.querySelector('.top');
const chat = byId('chat');
const hotbar = byId('hotbar');
const hotbarToggle = byId('touch-hotbar');
const play = byId('play');
const focusEntry = () => play.focus({preventScroll:true});
let pauseSection, pauseWatcher, chatWatcher, showingPause = false;

function showSection(section) {
  pauseSection = section;
  pauseProfile.hidden = section !== 'profile';
  pauseSettings.hidden = section !== 'settings';
  for (const button of sectionButtons) button.setAttribute('aria-expanded',String(button.dataset.pauseSection===section));
}

function closePause() {
  if (pauseSection) {
    const trigger = sectionButtons.find(button=>button.dataset.pauseSection===pauseSection);
    showSection(null);
    trigger?.focus({preventScroll:true});
  } else play.click();
}

function watchPauseClose() {
  if (typeof CloseWatcher !== 'function') return;
  pauseWatcher = new CloseWatcher();
  pauseWatcher.addEventListener('close',()=>{
    pauseWatcher = undefined;
    if (!showingPause || chat.classList.contains('expanded')) return;
    closePause();
    if (game.classList.contains('paused')) watchPauseClose();
  });
}

function refreshPause() {
  const paused = game.classList.contains('touch') && game.classList.contains('paused');
  if (paused === showingPause) return;
  showingPause = paused;
  pauseSections.hidden = !paused;
  if (paused) {
    pauseProfile.append(profile);
    pauseSettings.prepend(tools);
    focusEntry();
    watchPauseClose();
  } else {
    entry.insertBefore(profile,play);
    top.insertBefore(tools,byId('connection-metrics'));
    showSection(null);
    pauseWatcher?.destroy();
    pauseWatcher = undefined;
  }
}
for (const button of sectionButtons) button.addEventListener('click',()=>{
  const section = button.dataset.pauseSection;
  showSection(pauseSection === section ? null : section);
});
new MutationObserver(refreshPause).observe(game,{attributes:true,attributeFilter:['class']});
refreshPause();

document.addEventListener('keydown',event=>{
  if (event.code !== 'Escape' || !showingPause || document.querySelector('dialog[open], #chat.expanded, .social-panel:not([hidden])')) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!event.repeat) closePause();
},true);

new MutationObserver(()=>{
  if (typeof CloseWatcher !== 'function' || !game.classList.contains('touch')) return;
  if (chat.classList.contains('expanded')) {
    chatWatcher ??= new CloseWatcher();
    chatWatcher.onclose = () => byId('chat-close').click();
  } else {
    chatWatcher?.destroy();
    chatWatcher = undefined;
  }
}).observe(chat,{attributes:true,attributeFilter:['class']});

function updateViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const keyboard = Math.max(0, innerHeight - viewport.height - viewport.offsetTop);
  game.style.setProperty('--keyboard-inset',`${keyboard}px`);
  game.style.setProperty('--visible-height',`${viewport.height}px`);
}
window.visualViewport?.addEventListener('resize',updateViewport);
window.visualViewport?.addEventListener('scroll',updateViewport);
updateViewport();

for (const [id,flag] of [['show-coordinates','show-coordinates'],['show-metrics','show-metrics']]) {
  const input = byId(id);
  const key = 'honeymoon-' + flag;
  try { input.checked = localStorage.getItem(key) === 'true'; } catch { /* Storage can be disabled. */ }
  game.classList.toggle(flag,input.checked);
  input.addEventListener('change',()=>{
    game.classList.toggle(flag,input.checked);
    try { localStorage.setItem(key,String(input.checked)); } catch { /* The setting applies to this page. */ }
  });
}

function toggleHotbar() {
  const expanded = game.classList.toggle('hotbar-expanded');
  hotbarToggle.setAttribute('aria-expanded',String(expanded));
  hotbarToggle.setAttribute('aria-label',expanded ? 'Свернуть панель предметов' : 'Показать панель предметов');
}
const portrait = matchMedia('(orientation: portrait)');
hotbarToggle.addEventListener('click',toggleHotbar);
hotbar.addEventListener('click',event=>{
  if (portrait.matches && game.classList.contains('touch') && !game.classList.contains('hotbar-expanded') &&
      event.target.closest('.selected-slot')) toggleHotbar();
});
for (const id of ['touch','hotbar','fullscreen-toggle']) byId(id).addEventListener('contextmenu',event=>{
  if (game.classList.contains('touch')) event.preventDefault();
});
