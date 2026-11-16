import {itemName,plainMinecraftText,stackType} from '../world/item-text.mjs';
import {itemStackLimit} from '../world/item-stack.mjs';

export function createContainerMenu({action,entryFor,draw,inventory,pause,resume}) {
  const node=id=>document.getElementById(id);
  const dialog=node('container-menu'), storage=node('container-slots'), bag=node('container-inventory');
  const heading=node('container-title'), status=node('container-status'), closeButton=node('container-close');
  const cursor=node('container-carried');
  let anchor,container,picked,dragged,busy=false,needsRead=false;
  const iconCache=new Map();
  function paintStack(element,stack) {
    element.replaceChildren();
    if (!stack) return;
    const entry=entryFor(stack);
    const image=document.createElement('canvas');
    image.width=image.height=32;
    element.append(image);
    if (entry) {
      const key=entry.key+(stack.part?JSON.stringify(stack.part):'');
      if (!iconCache.has(key)) {
        iconCache.set(key,Promise.resolve(draw(entry,image)).then(()=>image).catch(()=>null));
      }
      iconCache.get(key).then(source=>{if (source&&source!==image) image.getContext('2d').drawImage(source,0,0);});
    }
    if (stack.count>1) {
      const label=document.createElement('span');
      label.textContent=stack.count;
      label.className='stack-count';
      element.append(label);
    }
  }
  const slots=side=>side==='storage'?container?.slots:inventory().slots;
  const at=ref=>ref && slots(ref.side)?.[ref.slot];
  const same=(a,b)=>a?.side===b.side && a?.slot===b.slot;

  function setCursor(source) {
    picked=source;
    const current=at(source);
    cursor.hidden=!current;
    paintStack(cursor,current && {...current,count:source.count??current.count});
    for (const cell of dialog.querySelectorAll('[data-side]')) {
      cell.classList.toggle('container-source',source?.side===cell.dataset.side&&String(source.slot)===cell.dataset.slot);
    }
  }

  function render() {
    if (!container) return;
    heading.textContent=plainMinecraftText(container.title);
    function cells(side) {
      return (slots(side)??[]).map((stack,slot)=>{
        const button=document.createElement('button');
        const position={side,slot};
        button.type='button';
        button.className='inventory-slot';
        button.dataset.side=side;
        button.dataset.slot=slot;
        button.draggable=!!stack;
        button.title=plainMinecraftText(itemName(stack)||entryFor(stack)?.name)||`Ячейка ${slot+1}`;
        button.setAttribute('aria-label',button.title);
        paintStack(button,stack);
        button.addEventListener('click',event=>click(position,event,false));
        button.addEventListener('contextmenu',event=>{event.preventDefault();click(position,event,true);});
        button.addEventListener('dragstart',event=>{
          if (!at(position)) {event.preventDefault();return;}
          dragged=position;
          event.dataTransfer.setData('text/plain','Honeymoon');
          event.dataTransfer.effectAllowed='move';
        });
        button.addEventListener('dragend',()=>{dragged=null;});
        button.addEventListener('dragover',event=>{
          if (dragged&&!same(dragged,position)) event.preventDefault();
        });
        button.addEventListener('drop',event=>{
          event.preventDefault();
          if (dragged) void move(dragged,position);
        });
        return button;
      });
    }
    storage.replaceChildren(...cells('storage'));
    const player=cells('inventory');
    bag.replaceChildren(...player.slice(9),...player.slice(0,9));
    setCursor(at(picked)?picked:null);
  }

  function click(to,event,right) {
    if (busy) return;
    const stack=at(to);
    if (event.shiftKey&&stack) {
      const side=to.side==='storage'?'inventory':'storage';
      const available=slots(side);
      const match=available.findIndex(other=>other&&stackType(other)===stackType(stack)&&other.count<itemStackLimit(other.key));
      const slot=match>=0?match:available.indexOf(null);
      if (slot>=0) void move(to,{side,slot});
    } else if (picked) {
      if (same(picked,to)) setCursor(null);
      else void move(picked,to,right?1:picked.count);
    } else if (stack) setCursor({...to,count:right?Math.ceil(stack.count/2):stack.count});
  }

  function accept(body) {
    if (body?.container) {
      container=body.container;
      render();
    }
    if (body?.error) status.textContent=body.message??'Действие не выполнено';
  }
  async function move(from,to,count) {
    if (busy||same(from,to)||!at(from)) return;
    busy=true;
    status.textContent='';
    try {
      const response=await action('container_move',anchor,{version:container.version,
        from:{side:from.side,slot:from.slot},to,...(count&&{count:Math.min(64,count)})});
      if (response.ok) setCursor(null);
      accept(response.body);
    } catch { status.textContent='Связь с сервером прервалась'; }
    finally {busy=false;if (needsRead) void refresh();}
  }

  async function refresh() {
    if (!dialog.open) return;
    if (busy) {needsRead=true;return;}
    needsRead=false;
    busy=true;
    try {accept((await action('container_read',anchor)).body);}
    catch {status.textContent='Связь с сервером прервалась';}
    finally {busy=false;if (needsRead) void refresh();}
  }
  async function open(target) {
    if (busy||dialog.open) return false;
    busy=true;
    try {
      const response=await action('container_open',target);
      if (!response.ok) return false;
      anchor=target;
      status.textContent='';
      accept(response.body);
      dialog.showModal();
      pause();
      return true;
    } finally {busy=false;}
  }
  async function close() {
    if (!dialog.open || busy) return;
    const target=anchor;
    setCursor(null);
    dialog.close();
    anchor=container=null;
    needsRead=false;
    try {await action('container_close',target);}
    catch {}
    finally {resume();}
  }
  dialog.addEventListener('cancel',event=>{event.preventDefault();void close();});
  closeButton.addEventListener('click',()=>void close());
  dialog.addEventListener('pointermove',event=>{
    cursor.style.left=event.clientX+'px';
    cursor.style.top=event.clientY+'px';
  });
  function changed(changes) {
    if (dialog.open&&changes.some(({x,y,z})=>y===anchor.y&&Math.abs(x-anchor.x)+Math.abs(z-anchor.z)<=1)) void refresh();
  }
  return {isOpen:()=>dialog.open,open,changed};
}
