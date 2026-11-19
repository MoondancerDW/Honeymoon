import {itemTooltip} from '../world/item-text.mjs';
import {formatMinecraftId,minecraftItemCode} from '../world/minecraft-id.mjs';
import {CREATIVE_INVISIBLE_FRAME_KEY} from '../world/creative-items.mjs';

const descriptions=new WeakMap();
const padding=8;
let tooltip,anchor,keyboard=false,pointer,observer;

function itemAt(target) {
  return target instanceof Element ? target.closest('[data-item-tooltip]') : null;
}

function hide() {
  observer?.disconnect();
  tooltip?.remove();
  anchor=undefined;
}

function position() {
  const item=anchor.getBoundingClientRect();
  const {width,height}=tooltip.getBoundingClientRect();
  const x=Math.max(padding,Math.min(item.left,innerWidth-width-padding));
  const above=item.top-height-padding;
  const y=above>=padding ? above : Math.max(padding,Math.min(item.bottom+padding,innerHeight-height-padding));
  tooltip.style.left=`${x}px`;
  tooltip.style.top=`${y}px`;
}

function line(tag,className,value) {
  const element=document.createElement(tag);
  element.className=className;
  element.textContent=value;
  return element;
}

function refresh() {
  if (!anchor) return;
  if (keyboard) {
    if (anchor.isConnected && anchor.getClientRects().length) position();
    else hide();
    return;
  }
  if (!pointer) { hide(); return; }
  const current=itemAt(document.elementFromPoint(...pointer));
  if (current===anchor) position();
  else if (current) show(current,false);
  else hide();
}

function show(element,fromKeyboard) {
  const description=descriptions.get(element);
  if (!description || document.pointerLockElement) { hide(); return; }
  observer.disconnect();
  anchor=element;
  keyboard=fromKeyboard;
  const {name,details,id}=description;
  const lines=[line('strong','item-tooltip-name',name)];
  if (details) lines.push(line('span','item-tooltip-details',details));
  if (id) lines.push(line('span','item-tooltip-id',id));
  tooltip.replaceChildren(...lines);
  const parent=element.closest('dialog')??document.body;
  if (tooltip.parentElement!==parent) parent.append(tooltip);
  position();
  // Storage slots are replaced when their metadata arrives. Rebind under a stationary pointer.
  observer.observe(parent,{childList:true,subtree:true});
}

function initialize() {
  tooltip=document.createElement('div');
  tooltip.className='item-tooltip';
  tooltip.setAttribute('role','tooltip');
  observer=new MutationObserver(refresh);
  document.addEventListener('pointerover',event=>{
    if (event.pointerType==='touch') { pointer=undefined; hide(); return; }
    pointer=[event.clientX,event.clientY];
    const next=itemAt(event.target);
    if (next && (next!==anchor || keyboard)) show(next,false);
  },true);
  document.addEventListener('pointermove',event=>{
    if (anchor && !keyboard && event.pointerType!=='touch') pointer=[event.clientX,event.clientY];
  },true);
  document.addEventListener('pointerout',event=>{
    if (!anchor || keyboard || itemAt(event.target)!==anchor || itemAt(event.relatedTarget)===anchor) return;
    hide();
  },true);
  document.addEventListener('focusin',event=>{
    const next=itemAt(event.target);
    if (next?.matches(':focus-visible') && !matchMedia('(hover: none)').matches) show(next,true);
  });
  document.addEventListener('focusout',event=>{
    if (keyboard && itemAt(event.target)===anchor) hide();
  });
  document.addEventListener('dragstart',hide,true);
  document.addEventListener('close',event=>{
    if (anchor?.closest('dialog')===event.target) hide();
  },true);
  document.addEventListener('pointerlockchange',hide);
  document.addEventListener('scroll',refresh,{capture:true,passive:true});
  window.addEventListener('resize',refresh);
  window.addEventListener('blur',hide);
}

export function updateItemTooltip(element,stack,name,{entry,code,extra}={}) {
  element.removeAttribute('title');
  if (!name) {
    if (anchor===element) hide();
    descriptions.delete(element);
    element.removeAttribute('data-item-tooltip');
    element.removeAttribute('aria-description');
    return;
  }
  if (!tooltip) initialize();
  const nativeCode=entry?.key!==CREATIVE_INVISIBLE_FRAME_KEY && /^\d+:\d+$/.test(code) ? code : minecraftItemCode(stack,entry);
  const id=formatMinecraftId(nativeCode);
  const metadata=itemTooltip(stack,name,{withLore:true}).slice(name.length+1);
  const details=[metadata,extra].filter(Boolean).join('\n');
  const previous=descriptions.get(element);
  if (previous?.name===name && previous.details===details && previous.id===id) return;
  descriptions.set(element,{name,details,id});
  element.setAttribute('data-item-tooltip','');
  const accessible=[details,id].filter(Boolean).join('\n');
  if (accessible) element.setAttribute('aria-description',accessible);
  else element.removeAttribute('aria-description');
  if (anchor===element) show(element,keyboard);
}
