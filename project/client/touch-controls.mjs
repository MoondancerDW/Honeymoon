const keyActions = {
  'touch-flight':'KeyF', 'touch-camera':'KeyY','touch-orbit':'KeyU','touch-spectator':'KeyP',
  'touch-crawl':'KeyV','touch-seat':'KeyX','touch-wave':'KeyB','touch-dance':'KeyZ',
  'touch-drop':'KeyQ','touch-inventory':'KeyJ','touch-catalog':'KeyI','touch-chat':'KeyT',
  'touch-teleport':'KeyG','touch-clock':'KeyL','touch-chisel':'KeyK','touch-chisel-size':'KeyK',
};

export function bindTouchControls({element,stick,enabled,sendKey,use,block,repeat,pause}) {
  const panel = element('touch-more-panel');
  const toggle = element('touch-more');
  const build = element('touch-build');
  const buildPanel = element('touch-build-panel');
  const useButton = element('touch-use');
  const pad = element('stick'), nub = pad.querySelector('i');
  const captured = new Map();
  let joystick;
  let sprint = false;
  let previous;
  let removeTimer;
  let previousAction;
  const sprintButton=element('touch-sprint');

  function extra(open) {
    panel.hidden=!open;
    toggle.setAttribute('aria-expanded',String(open));
  }
  function paintStick() {
    nub.style.transform=`translate(${stick.x*33}px,${stick.z*33}px)`;
  }
  function slide(event) {
    const {left,top,width,height}=pad.getBoundingClientRect();
    const x=(event.clientX-left-width/2)/(width*.36);
    const z=(event.clientY-top-height/2)/(height*.36);
    const length=Math.hypot(x,z);
    const intensity=Math.min(1,Math.max(0,(length-.13)/.87));
    stick.x=length ? x/length*intensity : 0;
    stick.z=length ? z/length*intensity : 0;
    paintStick();
  }
  pad.addEventListener('pointerdown',event=>{
    if (joystick!==undefined || !enabled()) return;
    joystick=event.pointerId;
    pad.setPointerCapture(joystick);
    slide(event);
  });
  pad.addEventListener('pointermove',event=>{if (joystick===event.pointerId) slide(event);});
  function releasePad(event) {
    if (joystick!==event.pointerId) return;
    joystick=undefined;
    stick.x=stick.z=0;
    paintStick();
  }
  pad.addEventListener('lostpointercapture',releasePad);
  pad.addEventListener('pointercancel',releasePad);

  function hold(id,act) {
    const button=element(id);
    button.addEventListener('pointerdown',event=>{
      if (!enabled() || captured.has(id)) return;
      event.preventDefault();
      captured.set(id,event.pointerId);
      button.setPointerCapture(event.pointerId);
      button.classList.add('holding');
      act(true);
    });
    function finish(event) {
      if (captured.get(id)!==event.pointerId) return;
      captured.delete(id);
      button.classList.remove('holding');
      act(false);
    }
    button.addEventListener('pointerup',finish);
    button.addEventListener('pointercancel',finish);
    button.addEventListener('lostpointercapture',finish);
    button.addEventListener('click',event=>{
      if (event.detail || !enabled()) return;
      act(true);
      act(false);
    });
  }
  hold('jump',pressed=>sendKey('Space',pressed));
  hold('touch-lower',pressed=>sendKey('KeyC',pressed));
  hold('touch-place',pressed=>{
    repeat(pressed);
    if (pressed) block('place');
  });
  hold('touch-remove',pressed=>{
    clearTimeout(removeTimer);
    if (!pressed) return;
    block('remove');
    const remove = () => {
      if (!enabled()) return;
      block('remove');
      removeTimer=setTimeout(remove,175);
    };
    removeTimer=setTimeout(remove,350);
  });

  for (const [id,code] of Object.entries(keyActions)) element(id).addEventListener('click',()=>{
    if (!enabled()) return;
    extra(false);
    sendKey(code,true,{shiftKey:id==='touch-chisel-size'});
    sendKey(code,false);
  });
  for (const [id,type] of [['touch-copy','copy'],['touch-rotate','rotate']]) {
    element(id).addEventListener('click',()=>{if(enabled()) block(type);});
  }
  useButton.addEventListener('click',()=>{if (enabled()) use(false);});
  element('touch-alternative').addEventListener('click',()=>{if (enabled()) {extra(false);use(true);}});
  toggle.addEventListener('click',()=>{if (enabled()) extra(panel.hidden);});
  build.addEventListener('click',()=>{
    if (!enabled()) return;
    buildPanel.hidden=!buildPanel.hidden;
    build.setAttribute('aria-pressed',String(!buildPanel.hidden));
    extra(false);
  });
  element('touch-pause').addEventListener('click',()=>{if (enabled()) pause();});
  sprintButton.addEventListener('click',()=>{
    if (!enabled()) return;
    sprint=!sprint;
    sprintButton.setAttribute('aria-pressed',String(sprint));
    sendKey('ShiftLeft',sprint);
  });

  function clear() {
    clearTimeout(removeTimer);
    if (joystick!==undefined && pad.hasPointerCapture(joystick)) pad.releasePointerCapture(joystick);
    joystick=undefined;
    stick.x=stick.z=0;
    paintStick();
    for (const [id,pointer] of captured) {
      const button=element(id);
      if (button.hasPointerCapture(pointer)) button.releasePointerCapture(pointer);
      button.classList.remove('holding');
    }
    captured.clear();
    sprint=false;
    sprintButton.setAttribute('aria-pressed','false');
    extra(false);
  }
  return {clear,update({flying,spectator,stance,crawlRequested,seated,orbit,chisel,actionLabel='Действие'}) {
    if (actionLabel!==previousAction) useButton.textContent=previousAction=actionLabel;
    const state=Number(flying)+2*Number(spectator)+4*Number(crawlRequested || stance==='crawl')+
      8*Number(seated)+16*Number(orbit)+32*Number(chisel);
    if (state===previous) return;
    previous=state;
    element('jump').textContent=flying?'Вверх':'Прыжок';
    element('touch-lower').textContent=flying?'Вниз':'Пригнуться';
    for (const [id,active] of [['touch-flight',flying&&!spectator],['touch-spectator',spectator],
      ['touch-crawl',crawlRequested || stance==='crawl'],['touch-seat',seated],['touch-orbit',orbit],['touch-chisel',chisel]]) {
      element(id).setAttribute('aria-pressed',String(active));
    }
  }};
}
