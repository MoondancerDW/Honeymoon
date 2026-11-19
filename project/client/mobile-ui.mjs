const byId = id => document.getElementById(id);
const game = byId('game');
const fullscreen = byId('fullscreen-toggle');
const fullscreenButtons = document.querySelectorAll('[data-fullscreen-toggle]');
const fullscreenHelp = byId('fullscreen-help');
const root = document.documentElement;
const standalone = matchMedia('(display-mode: standalone)');
const touchFullscreen = matchMedia('(pointer: coarse)').matches;
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
const isFullscreen = () => Boolean(document.fullscreenElement || document.webkitFullscreenElement);
const fullscreenMethod = () => (document.fullscreenEnabled && root.requestFullscreen) ||
  (document.webkitFullscreenEnabled && root.webkitRequestFullscreen);
let fullscreenOpener;

if (touchFullscreen) byId('touch-pause').before(fullscreen);
if (ios) {
  byId('fullscreen-help-instructions').textContent =
    'В Safari нажмите «Поделиться», выберите «На экран „Домой“» и включите «Открывать как веб-приложение». Затем запустите Lilium Moonlight с экрана «Домой».';
}

function updateFullscreen() {
  const active = isFullscreen();
  const supported = typeof fullscreenMethod() === 'function';
  const installed = standalone.matches || navigator.standalone === true;
  const opensHelp = !active && !supported && touchFullscreen;
  for (const control of fullscreenButtons) {
    control.hidden = control!==fullscreen && !touchFullscreen || !active && (installed || (!supported && !opensHelp));
    if (opensHelp) {
      control.removeAttribute('aria-pressed');
      control.setAttribute('aria-haspopup','dialog');
      control.setAttribute('aria-controls',fullscreenHelp.id);
    } else {
      control.setAttribute('aria-pressed',String(active));
      control.removeAttribute('aria-haspopup');
      control.removeAttribute('aria-controls');
    }
    control.setAttribute('aria-label',active?'Выйти из полного экрана':'На весь экран');
    control.title=control.getAttribute('aria-label');
  }
}

function showFullscreenHelp(control) {
  fullscreenOpener=control;
  if (!fullscreenHelp.open) fullscreenHelp.showModal();
}

async function toggleFullscreen(event) {
  const control=event.currentTarget;
  try {
    if (isFullscreen()) {
      const exit = document.exitFullscreen ?? document.webkitExitFullscreen;
      await exit?.call(document);
    } else {
      const enter = fullscreenMethod();
      if (typeof enter === 'function') await enter.call(root);
      else showFullscreenHelp(control);
    }
  } catch {
    showFullscreenHelp(control);
  }
}
for (const control of fullscreenButtons) control.addEventListener('click',toggleFullscreen);
fullscreenHelp.addEventListener('keydown',event=>event.stopPropagation());
fullscreenHelp.addEventListener('close',()=>fullscreenOpener?.focus({preventScroll:true}));
for (const event of ['fullscreenchange','webkitfullscreenchange']) document.addEventListener(event,updateFullscreen);
standalone.addEventListener?.('change',updateFullscreen);
updateFullscreen();

const chat = byId('chat');
const hotbar = byId('hotbar');
const hotbarToggle = byId('touch-hotbar');
let chatWatcher;

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
