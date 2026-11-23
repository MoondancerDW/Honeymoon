const keyActions = {
  'touch-orbit':'KeyU','touch-spectator':'KeyP','touch-seat':'KeyX','touch-wave':'KeyB','touch-dance':'KeyZ',
  'touch-drop':'KeyQ','touch-inventory':'KeyJ','touch-catalog':'KeyI','touch-chat':'KeyT',
  'touch-teleport':'KeyG','touch-clock':'KeyL','touch-chisel':'KeyK','touch-chisel-size':'KeyK',
};

export function bindTouchControls({element,stick,enabled,sendKey,crouch,use,block,attack,repeat,pause}) {
  const panel = element('touch-more-panel');
  const toggle = element('touch-more');
  const build = element('touch-build');
  const buildPanel = element('touch-build-panel');
  const useButton = element('touch-use');
  const jumpButton = element('jump');
  const lowerButton = element('touch-lower');
  const pad = element('stick'), nub = pad.querySelector('i');
  const captured = new Map();
  let joystick;
  let sprint = false;
  let flying = false;
  let previous;
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

  function hold(id,act,allowed=enabled) {
    const button=element(id);
    button.addEventListener('pointerdown',event=>{
      if (event.button!==0 || !allowed() || captured.has(id)) return;
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
      act(false,event.type==='pointerup');
    }
    button.addEventListener('pointerup',finish);
    button.addEventListener('pointercancel',finish);
    button.addEventListener('lostpointercapture',finish);
    button.addEventListener('click',event=>{
      if (event.detail || !allowed()) return;
      act(true);
      act(false,true);
    });
  }
  hold('jump',pressed=>sendKey('Space',pressed));
  hold('touch-lower',pressed=>sendKey('KeyC',pressed),()=>enabled() && flying);
  lowerButton.addEventListener('click',()=>{if (enabled() && !flying) crouch();});
  hold('touch-place',(pressed,released)=>{
    repeat(pressed,released);
    if (pressed) block('place');
  });
  hold('touch-remove',attack);

  function pressKey(id,code) {
    extra(false);
    sendKey(code,true,{shiftKey:id==='touch-chisel-size'});
    sendKey(code,false);
  }

  for (const [id,code] of Object.entries(keyActions)) element(id).addEventListener('click',()=>{
    if (enabled()) pressKey(id,code);
  });
  for (const [id,code] of [['touch-flight','KeyF'],['touch-camera','F5'],['touch-crawl','KeyV']]) {
    hold(id,pressed=>{if (pressed) pressKey(id,code);});
  }
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
  hold('touch-sprint',pressed=>{
    if (!pressed) return;
    sprint=!sprint;
    sprintButton.setAttribute('aria-pressed',String(sprint));
  });

  function clear() {
    attack(false);
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
  function label(button,text) {
    button.title=text;
    button.setAttribute('aria-label',text);
  }
  return {clear,get sprinting(){return sprint;},update({flying:inFlight,spectator,stance,crawlRequested,touchCrouching,seated,orbit,chisel,actionLabel='Действие'}) {
    flying=inFlight;
    if (actionLabel!==previousAction) label(useButton,previousAction=actionLabel);
    const state=Number(flying)+2*Number(spectator)+4*Number(crawlRequested || stance==='crawl')+
      8*Number(seated)+16*Number(orbit)+32*Number(chisel)+64*Number(touchCrouching);
    if (state===previous) return;
    previous=state;
    label(jumpButton,flying?'Подняться':'Прыжок');
    label(lowerButton,flying?'Спуститься':'Пригнуться');
    lowerButton.toggleAttribute('data-flight',flying);
    if (flying) lowerButton.removeAttribute('aria-pressed');
    else lowerButton.setAttribute('aria-pressed',String(touchCrouching));
    for (const [id,active] of [['touch-flight',flying&&!spectator],['touch-spectator',spectator],
      ['touch-crawl',crawlRequested || stance==='crawl'],['touch-seat',seated],['touch-orbit',orbit],['touch-chisel',chisel]]) {
      element(id).setAttribute('aria-pressed',String(active));
    }
  }};
}

export function bindTouchLook(canvas,{enabled,look,tap}) {
  const dragThreshold=7;
  const tapDuration=300;
  let finger;

  canvas.addEventListener('pointerdown',event=>{
    if (event.button!==0 || !enabled()) return;
    if (finger) {
      finger.canTap=false;
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    finger={id:event.pointerId,x:event.clientX,y:event.clientY,started:event.timeStamp,dragging:false,canTap:true};
  });
  canvas.addEventListener('pointermove',event=>{
    if (finger?.id!==event.pointerId) return;
    if (!enabled()) {
      finger.canTap=false;
      return;
    }
    const dx=event.clientX-finger.x, dy=event.clientY-finger.y;
    if (!finger.dragging && Math.hypot(dx,dy)<dragThreshold) return;
    finger.dragging=true;
    finger.x=event.clientX;
    finger.y=event.clientY;
    look(dx,dy);
  });
  canvas.addEventListener('pointerup',event=>{
    if (finger?.id!==event.pointerId) return;
    const active=finger;
    finger=undefined;
    if (tap && enabled() && active.canTap && !active.dragging && event.timeStamp-active.started<=tapDuration &&
        Math.hypot(event.clientX-active.x,event.clientY-active.y)<dragThreshold &&
        document.elementFromPoint(event.clientX,event.clientY)===canvas) tap();
  });
  for (const name of ['pointercancel','lostpointercapture']) canvas.addEventListener(name,event=>{
    if (finger?.id===event.pointerId) finger=undefined;
  });
  window.addEventListener('blur',()=>{finger=undefined;});
}
