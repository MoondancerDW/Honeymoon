import {itemName,plainMinecraftText,stackType,writtenBookInfo} from '../world/item-text.mjs';
import {itemStackLimit} from '../world/item-stack.mjs';
import {containerSpec} from '../world/containers.mjs';
import {createContainerCache} from './container-cache.mjs';
import {pendingItemIcon} from './creative-icons.mjs';
import {updateItemTooltip} from './item-tooltip.mjs';

const summaryView = {containerView:'summary'};
const detailsView = {containerView:'details'};
const cacheKey = ({x,y,z}) => [x,y,z].join(',');
const countsFor = slots => slots.map(stack=>stack?.count??null);

export function createContainerMenu({action,bagAction,entryFor,draw,inventory,pause,resume}) {
  const node=id=>document.getElementById(id);
  const dialog=node('container-menu'), storage=node('container-slots'), bag=node('container-inventory');
  const heading=node('container-title'), status=node('container-status'), closeButton=node('container-close');
  const cursor=node('container-carried');
  let active,picked,dragged,pendingClose;
  const pendingDetails=new Map();
  const contentsCache=createContainerCache({limit:32,ttl:5*60_000,capacity:2*1024*1024,
    sizeOf:entry=>JSON.stringify(entry).length*2});
  setInterval(()=>contentsCache.prune(),60_000);

  function spinner() {
    const element=document.createElement('span');
    element.className='container-spinner';
    element.setAttribute('aria-hidden','true');
    return element;
  }

  function paintStack(element,stack,count=stack?.count) {
    element.replaceChildren();
    if (!stack && !count) return;
    if (!stack) element.append(spinner());
    if (stack) {
      const entry=entryFor(stack);
      if (entry) element.append(pendingItemIcon(entry,draw));
    }
    if (count>1 || (!stack && count)) {
      const label=document.createElement('span');
      label.textContent=count;
      label.className='stack-count';
      element.append(label);
    }
  }

  const slots=side=>side==='storage'?active?.container?.slots:inventory().slots;
  const at=ref=>ref && slots(ref.side)?.[ref.slot];
  const same=(a,b)=>Boolean(a && b && a.side===b.side && a.slot===b.slot);
  const locked=ref=>active?.portable && ref.side==='inventory' && ref.slot===active.container.inventorySlot;
  const ready=()=>Boolean(active?.authorized && active.container?.slots && !active.transfer);

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
    const container=active?.container;
    if (!container) return;
    heading.textContent=plainMinecraftText(container.title);
    storage.classList.toggle('seed-bag',Boolean(active.portable && container.counts?.length===9));
    storage.setAttribute('aria-label',active.portable?heading.textContent:'Хранилище');
    storage.setAttribute('aria-busy',String(!active.authorized || !container.slots));
    function cells(side) {
      const stacks=slots(side);
      const counts=side==='storage'?container.counts:countsFor(stacks??[]);
      return (counts??[]).map((count,slot)=>{
        const stack=stacks?.[slot];
        const button=document.createElement('button');
        const position={side,slot};
        button.type='button';
        button.className='inventory-slot';
        button.dataset.side=side;
        button.dataset.slot=slot;
        button.disabled=!active.authorized || !container.slots || locked(position);
        button.draggable=!!stack&&!button.disabled;
        const entry=stack && entryFor(stack);
        const label=count && !stack ? `Ячейка ${slot+1}, количество ${count}, загрузка` :
          plainMinecraftText(itemName(stack)) || writtenBookInfo(stack)?.title || entry?.name || `Ячейка ${slot+1}`;
        button.setAttribute('aria-label',label);
        if (count) updateItemTooltip(button,stack,label,{entry});
        paintStack(button,stack,count);
        button.addEventListener('click',event=>click(position,event,false));
        button.addEventListener('contextmenu',event=>{event.preventDefault();click(position,event,true);});
        button.addEventListener('dragstart',event=>{
          if (!ready()||!at(position)) {event.preventDefault();return;}
          dragged=position;
          event.dataTransfer.setData('text/plain','Lilium Moonlight');
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
    if (!ready() || locked(to)) return;
    const stack=at(to);
    if (event.shiftKey&&stack) {
      const side=to.side==='storage'?'inventory':'storage';
      const available=slots(side);
      const match=available.findIndex((other,slot)=>!locked({side,slot})&&other&&
        stackType(other)===stackType(stack)&&other.count<itemStackLimit(other.key));
      const slot=match>=0?match:available.findIndex((other,slot)=>!other&&!locked({side,slot}));
      if (slot>=0) void move(to,{side,slot});
    } else if (picked) {
      if (same(picked,to)) setCursor(null);
      else void move(picked,to,right?1:picked.count);
    } else if (stack) setCursor({...to,count:right?Math.ceil(stack.count/2):stack.count});
  }

  function remember(current,fromDetails=false) {
    const {slots:items, ...description}=current;
    const summary={...description,counts:description.counts??countsFor(items??[])};
    const key=cacheKey(current);
    const previous=contentsCache.get(key);
    const sameContents=previous?.summary.contentVersion===summary.contentVersion;
    const details=items??(sameContents?previous?.details:undefined);
    const record={summary,details,fresh:true};
    if (summary.contentVersion && (!fromDetails || !previous || sameContents)) {
      if (fromDetails && previous) {
        record.summary=previous.summary;
        record.fresh=previous.fresh;
      }
      contentsCache.set(key,record);
      if (!contentsCache.get(key)) contentsCache.set(key,{...record,details:undefined});
    }
    return {summary,details};
  }

  function hydrate(context,current) {
    const key=cacheKey(current)+':'+current.contentVersion;
    let pending=pendingDetails.get(key);
    if (!pending) {
      pending=action('container_read',context.target,detailsView).then(response=>{
        if (!response.ok || !Array.isArray(response.body?.container?.slots)) {
          return {error:response.body?.message??'Не удалось загрузить предметы'};
        }
        const result=response.body.container;
        if (result.contentVersion===current.contentVersion) remember(result,true);
        return {result};
      },()=>({error:'Не удалось загрузить предметы'})).finally(()=>pendingDetails.delete(key));
      pendingDetails.set(key,pending);
    }
    void pending.then(({result,error})=>{
      if (active!==context || context.container!==current) return;
      if (error) {
        status.textContent=error+' ';
        const retry=document.createElement('button');
        retry.type='button';
        retry.textContent='Повторить';
        retry.addEventListener('click',()=>{
          status.textContent='Загружаем предметы…';
          hydrate(context,current);
        });
        status.append(retry);
        return;
      }
      if (result.contentVersion!==current.contentVersion) {
        void refresh(context);
        return;
      }
      context.container={...current,slots:result.slots};
      status.textContent='';
      render();
    });
  }

  function accept(context,current) {
    if (!current) return;
    let container;
    if (context.portable) {
      if (!Array.isArray(current.slots)) return;
      container={...current,counts:countsFor(current.slots)};
    } else {
      const {summary,details}=remember(current);
      const slots=details??(summary.counts.every(count=>count===null)?summary.counts:undefined);
      container={...summary,slots};
    }
    context.container=container;
    context.authorized=true;
    if (active===context) {
      status.textContent=container.slots?'':'Загружаем предметы…';
      render();
    }
    if (!container.slots) hydrate(context,container);
  }

  async function move(from,to,count) {
    const context=active;
    const source=at(from);
    if (!ready()||same(from,to)||!source||locked(from)||locked(to)) return;
    const carried=same(picked,from)?picked.count:0;
    context.transfer=true;
    status.textContent='';
    try {
      const fields={version:context.container.version,from:{side:from.side,slot:from.slot},to,
        ...(count&&{count:Math.min(64,count)})};
      const response=context.portable
        ? await bagAction('bag_move',{...fields,slot:context.container.inventorySlot})
        : await action('container_move',context.target,{...detailsView,...fields});
      if (active!==context) return;
      accept(context,context.portable?response.body?.bag:response.body?.container);
      if (response.ok) {
        const remainder=at(from);
        const remaining=remainder && stackType(remainder)===stackType(source) ? carried-(source.count-remainder.count) : 0;
        setCursor(remaining>0 ? {...from,count:Math.min(remaining,remainder.count)} : null);
      }
      if (context.portable && ['not_a_bag','invalid_bag_contents'].includes(response.body?.error)) {
        context.authorized=false;
        setCursor(null);
        render();
      }
      if (response.body?.error) status.textContent=response.body.message??'Действие не выполнено';
    } catch {
      if (active===context) status.textContent='Связь с сервером прервалась';
    } finally {
      context.transfer=false;
      if (context.needsRead) void refresh(context);
    }
  }

  async function refresh(context) {
    if (active!==context || !context.authorized) return;
    if (context.transfer || context.reading) {context.needsRead=true;return;}
    context.needsRead=false;
    context.reading=true;
    try {
      const response=await action('container_read',context.target,summaryView);
      if (active!==context) return;
      accept(context,response.body?.container);
      if (response.body?.error) status.textContent=response.body.message??'Не удалось обновить хранилище';
    } catch {
      if (active===context) status.textContent='Связь с сервером прервалась';
    } finally {
      context.reading=false;
      if (context.needsRead) void refresh(context);
    }
  }

  async function open(target) {
    if (active) return false;
    const preview=contentsCache.get(cacheKey(target));
    const spec=containerSpec(target.cell);
    const context={target,container:preview?.fresh ? preview.summary :
      {title:spec?.title??'Хранилище',counts:Array(spec?.size??0).fill(null)}};
    reveal(context);
    const previousClose=pendingClose;
    context.opening=(async()=>{
      if (previousClose) await previousClose;
      if (active!==context) return false;
      try {
        const response=await action('container_open',target,summaryView);
        if (response.ok && response.body?.container) {
          accept(context,response.body.container);
          return true;
        }
        if (active===context) status.textContent=response.body?.message??'Не удалось открыть хранилище';
      } catch {
        if (active===context) status.textContent='Не удалось открыть хранилище';
      }
      return false;
    })();
    return context.opening;
  }

  function reveal(context) {
    active=context;
    status.textContent='Проверяем содержимое…';
    render();
    dialog.showModal();
    pause();
  }

  async function openBag({slot,title,size,fromInventory=false}) {
    if (active) return false;
    const context={portable:true,fromInventory,container:{title,counts:Array(size).fill(null)}};
    reveal(context);
    try {
      const response=await bagAction('bag_open',slot===undefined?{}:{slot});
      if (active!==context) return false;
      if (response.ok && Array.isArray(response.body?.bag?.slots)) {
        accept(context,response.body.bag);
        return true;
      }
      status.textContent=response.body?.message??'Не удалось открыть сумку';
    } catch {
      if (active===context) status.textContent='Не удалось открыть сумку';
    }
    return false;
  }

  function close() {
    const context=active;
    if (!context || context.transfer) return;
    setCursor(null);
    dragged=null;
    active=null;
    dialog.close();
    if (!context.fromInventory) resume();
    if (context.portable) return;
    const closing=context.opening.then(async opened=>{
      if (!opened) return;
      const response=await action('container_close',context.target,summaryView);
      if (response.ok && response.body?.container) remember(response.body.container);
    }).catch(()=>{});
    pendingClose=closing;
    void closing.finally(()=>{if (pendingClose===closing) pendingClose=undefined;});
  }

  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  closeButton.addEventListener('click',close);
  dialog.addEventListener('pointermove',event=>{
    cursor.style.left=event.clientX+'px';
    cursor.style.top=event.clientY+'px';
  });
  function changed(changes) {
    const affects=({x,y,z})=>changes.some(change=>change.y===y && Math.abs(change.x-x)+Math.abs(change.z-z)<=1);
    contentsCache.forEach(record=>{if (affects(record.summary)) record.fresh=false;});
    if (active?.authorized && !active.portable && affects(active.target)) void refresh(active);
  }
  return {isOpen:()=>dialog.open,open,openBag,changed};
}
