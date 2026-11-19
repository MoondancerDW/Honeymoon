import {arrangeCreativeCatalog} from './creative-layout.mjs';
import {equipmentLabels, ponyArmor} from '../world/pony-armor.mjs';
import {itemStackLimit,offhandSlot} from '../world/item-stack.mjs';
import {bookType,stackType,writtenBookInfo} from '../world/item-text.mjs';
import {iconSignature,inventoryItemEntry,pendingItemIcon} from './creative-icons.mjs';
import {updateItemTooltip} from './item-tooltip.mjs';

const columns = 9;
const visibleRows = 5;
const inventorySize = 36;
const dragType = 'application/x-honeymoon-inventory';
const normalized = text => String(text ?? '').normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё','е');
const maxStack = entry => itemStackLimit(entry?.key);

function cardData({entry,icon,code}) {
  const name = entry.name || entry.english || entry.key;
  return {entry,icon,name,code,
    search:normalized([name,entry.english,entry.mod,entry.key,icon.name,icon.key,code,entry.variant].filter(Boolean).join(' '))};
}

export function createCreativeMenu({load,choose,select,move,clone,trash,drop,pause,resume,notice,icon,preview,editItem,readBook,swap,canCopy=()=>true}) {
  const byId = id => document.getElementById(id);
  const dialog = byId('creative-menu');
  const toggle = byId('creative-toggle');
  const search = byId('creative-search'), scrollbar = byId('creative-scroll');
  const tabsBar = byId('creative-tabs'), list = byId('creative-list'), grid = byId('creative-grid');
  const status = byId('creative-count'), retry = byId('creative-retry');
  const previousPage = byId('creative-prev-page'), nextPage = byId('creative-next-page');
  const trashTarget = byId('inventory-trash'), carried = byId('inventory-carried');
  const editingTarget=byId('inventory-edit');
  const hotbar = byId('hotbar'), equipmentPanel = byId('inventory-equipment');
  const hudOffhand = byId('hud-offhand'), menuOffhand = byId('inventory-offhand');
  const slotsPanel = byId('inventory-slots'), previewCanvas = byId('inventory-preview');
  const storageMode = () => active === 'inventory';
  let catalog, allCards, pending, active = 'buildingBlocks', tabPage = 0;
  let matches = [], firstRow = -1, dragging, picked, requestedSlot, underCursor, openedFromPause;
  let state = {slots:Array(inventorySize).fill(null), selected:0, equipment:Array(equipmentLabels.length).fill(null), offhand:null};
  let offhandAvailable = false;
  let queued = Promise.resolve();

  function request(callback,...args) {
    if (!callback) return Promise.resolve(false);
    const operation = queued.then(()=>callback(...args)).catch(error => {
      status.textContent = error.message || 'Ошибка инвентаря';
      notice?.(status.textContent);
      return false;
    });
    queued = operation;
    return operation;
  }

  const draw = entry => pendingItemIcon(entry,icon);

  function stackAt(slot) {
    return slot === offhandSlot ? state.offhand : slot < inventorySize ? state.slots[slot] : state.equipment[slot-inventorySize];
  }

  const entryFor = stack => inventoryItemEntry(stack,catalog?.byKey.get(stack?.key));

  function paintStack(target,entry,quantity) {
    target.replaceChildren();
    if (!entry) return;
    target.append(draw(entry));
    if (quantity > 1) {
      const counter = document.createElement('span');
      counter.className = 'stack-count';
      counter.textContent = quantity;
      target.append(counter);
    }
  }

  function close(continuePlaying = true) {
    if (!dialog.open) return;
    setPicked(null);
    dialog.close();
    if (continuePlaying && !openedFromPause) resume();
  }

  function setPicked(source) {
    picked = source;
    updateCarried();
    paintInventory();
  }

  function updateCarried() {
    const entry = picked?.entry ?? entryFor(stackAt(picked?.slot));
    carried.hidden = !entry || !!dragging;
    paintStack(carried,entry,picked?.count ?? 1);
  }

  function countAt(source) {
    return source.count ?? (source.entry ? 1 : stackAt(source.slot)?.count ?? 0);
  }

  function mayMove(source,slot) {
    if ((slot === offhandSlot || source.slot === offhandSlot) && !offhandAvailable) return false;
    const entry = source.entry ?? entryFor(stackAt(source.slot));
    return slot < inventorySize || slot === offhandSlot || ponyArmor(entry?.key)?.slot === slot - inventorySize;
  }

  async function transferTo(source,destination,single = false) {
    if (!source || source.slot===destination&&!source.clone || !mayMove(source,destination)) return;
    const available = countAt(source);
    const amount = single ? 1 : available;
    if (!available) return;
    const target = stackAt(destination);
    if (source.clone) {
      const origin=stackAt(source.slot);
      if (!origin || target && stackType(origin)!==stackType(target)) return;
      const accepted=Math.min(amount,itemStackLimit(origin.key)-(target?.count??0));
      if (accepted>0 && await request(clone,source.slot,destination,accepted)!==false && picked===source) {
        setPicked(available>accepted?{...source,count:available-accepted}:null);
      }
      return;
    }
    if (source.entry) {
      const {entry} = source;
      const same = target?.key === entry.key && !target.copied && !target.nbt && !target.legacyNbt;
      const count = Math.min(amount + (same ? target.count : 0),maxStack(entry));
      const added = count - (same ? target.count : 0);
      if (added <= 0) return;
      let displaced;
      if (target && !same) {
        displaced = state.slots.indexOf(null);
        if (displaced < 0 || await request(move,destination,displaced) === false) return;
      }
      if (await request(choose,entry,destination,count) === false) return;
      if (picked === source) setPicked(displaced !== undefined ? {slot:displaced,count:target.count} :
        available > added ? {...source,count:available-added} : null);
      return;
    }

    const original = stackAt(source.slot);
    if (!original || await request(move,source.slot,destination,amount) === false) return;
    if (picked !== source) return;
    const remaining = stackAt(source.slot);
    const transferred = remaining?.key === original.key ? original.count-remaining.count : original.count;
    if (remaining && remaining.key !== original.key) setPicked({slot:source.slot,count:remaining.count});
    else setPicked(available > transferred ? {...source,count:available-transferred} : null);
  }

  function beginDrag(event,source) {
    if (!event.dataTransfer || !countAt(source)) { event.preventDefault(); return; }
    dragging = source;
    event.dataTransfer.setData(dragType,source.entry?.key ?? String(source.slot));
    event.dataTransfer.effectAllowed = source.entry ? 'copy' : 'move';
    setPicked(null);
  }

  function endDrag() {
    dragging = null;
    dialog.querySelectorAll('.drop-target').forEach(target=>target.classList.remove('drop-target'));
    updateEditingTarget();
  }

  function acceptDrop(target,callback,allowed = () => true) {
    target.addEventListener('dragover',event => {
      if (!dragging || !allowed(dragging)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = dragging.entry ? 'copy' : 'move';
      target.classList.add('drop-target');
    });
    target.addEventListener('dragleave',()=>target.classList.remove('drop-target'));
    target.addEventListener('drop',event => {
      if (!dragging || !allowed(dragging)) return;
      event.preventDefault();
      event.stopPropagation();
      const source = dragging;
      endDrag();
      callback(source,event);
    });
  }

  function selectSlot(slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= columns || (requestedSlot ?? state.selected) === slot) return;
    requestedSlot = slot;
    return request(select,slot).finally(()=>{ if (requestedSlot === slot) requestedSlot = undefined; });
  }

  function quickMove(slot) {
    const stack = stackAt(slot);
    if (!stack) return;
    const armor = ponyArmor(stack.key);
    if (armor && slot < inventorySize && !state.equipment[armor.slot]) {
      void request(move,slot,inventorySize+armor.slot);
      return;
    }
    const start = slot < columns ? columns : 0;
    const end = slot < columns ? inventorySize : columns;
    const match = state.slots.findIndex((other,index)=>index >= start && index < end && other && stackType(other)===stackType(stack) &&
      other.count < maxStack(entryFor(other)));
    const available = state.slots.findIndex((other,index)=>index >= start && index < end && !other);
    if (match >= 0) void request(move,slot,match);
    else if (available >= 0) void request(move,slot,available);
  }

  function clickSlot(slot,event,secondary) {
    if (event.shiftKey && !picked) { quickMove(slot); return; }
    if (picked) {
      if (picked.slot === slot && !picked.clone) setPicked(null);
      else void transferTo(picked,slot,secondary);
      return;
    }
    const stack = stackAt(slot);
    if (stack) setPicked({slot,count:secondary ? Math.ceil(stack.count/2) : stack.count});
  }

  function makeSlot(slot,inWorld) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'inventory-slot';
    button.dataset.slot = slot;
    button.addEventListener('click',event=>{
      if (!inWorld) clickSlot(slot,event,false);
      else if (slot === offhandSlot) void request(swap);
      else void selectSlot(slot);
    });
    if (!inWorld) {
      button.addEventListener('pointerenter',()=>{ underCursor = {slot}; });
      button.addEventListener('pointerleave',()=>{ if (underCursor?.slot === slot) underCursor = null; });
      button.addEventListener('contextmenu',event=>{ event.preventDefault(); clickSlot(slot,event,true); });
      button.addEventListener('auxclick',event=>{
        if (event.button!==1||!canCopy()) return;
        event.preventDefault();
        const stack=stackAt(slot);
        if (stack) setPicked({slot,clone:true,count:itemStackLimit(stack.key)});
      });
      button.addEventListener('dblclick',()=>{
        if (!bookType(stackAt(slot))) return;
        setPicked(null);
        readBook?.(slot);
      });
      button.addEventListener('dragstart',event=>beginDrag(event,{slot}));
      button.addEventListener('dragend',endDrag);
      acceptDrop(button,source=>void transferTo(source,slot),source=>mayMove(source,slot));
    }
    return button;
  }

  const worldSlots = Array.from({length:columns},(_,i)=>makeSlot(i,true));
  const menuSlots = Array.from({length:offhandSlot+1},(_,i)=>makeSlot(i,false));
  const hudOffhandSlot = makeSlot(offhandSlot,true);
  const menuOffhandSlot = menuSlots[offhandSlot];
  for (const button of [hudOffhandSlot,menuOffhandSlot]) button.classList.add('offhand-slot');
  hudOffhand.replaceChildren(hudOffhandSlot);
  menuOffhand.replaceChildren(menuOffhandSlot);
  hotbar.replaceChildren(...worldSlots);
  byId('inventory-hotbar').replaceChildren(...menuSlots.slice(0,columns));
  slotsPanel.replaceChildren(...menuSlots.slice(columns,inventorySize));
  equipmentPanel.replaceChildren(...menuSlots.slice(inventorySize,offhandSlot));
  for (let i=0;i<equipmentLabels.length;i++) {
    const button = menuSlots[inventorySize+i];
    button.style.setProperty('--equipment-index',i);
    button.style.setProperty('--equipment-x',i < 2 ? 8 : 62);
    button.style.setProperty('--equipment-y',i % 2 === 0 ? 6 : 33);
  }

  function refreshPreview() {
    if (storageMode() && dialog.open) preview?.(previewCanvas,state.equipment);
  }

  function paintInventory() {
    for (let slot=0;slot<menuSlots.length;slot++) {
      const stack = stackAt(slot);
      const entry = entryFor(stack);
      const visible = slot===picked?.slot&&!picked.clone ? Math.max(0,(stack?.count??0)-countAt(picked)) : stack?.count??0;
      const hud = slot === offhandSlot ? hudOffhandSlot : worldSlots[slot];
      const renditions = hud ? [menuSlots[slot],hud] : [menuSlots[slot]];
      for (const button of renditions) {
        const world = button === hud;
        const count = world ? stack?.count ?? 0 : visible;
        if (world && slot < columns) {
          button.classList.toggle('selected-slot', state.selected === slot);
          button.setAttribute('aria-pressed',String(state.selected === slot));
        }
        button.draggable = Boolean(stack) && !world;
        const title = slot === offhandSlot ? 'Вторая рука' : slot < inventorySize ?
          `Ячейка ${slot+1}` : equipmentLabels[slot-inventorySize];
        const label = `${title} · ${entry?.name ?? 'Пусто'}${count > 1 ? ' ×'+count : ''}`;
        if (slot === offhandSlot) button.classList.toggle('offhand-empty', !count);
        const swapHint = world && slot === offhandSlot;
        updateItemTooltip(button,stack,count ? entry?.name : null,{entry,extra:swapHint ? 'Сменить руки (N)' : undefined});
        button.setAttribute('aria-label',swapHint ? label + ' · Сменить руки' : label);
        const signature = count && entry ? `${iconSignature(entry)}:${count}` : '';
        if (button.dataset.image === signature) continue;
        button.dataset.image = signature;
        paintStack(button,count ? entry : null,count);
        if (!entry && slot >= inventorySize && slot < offhandSlot) {
          const outline = document.createElement('div');
          outline.className = 'equipment-empty';
          button.append(outline);
        }
      }
    }
    updateEditingTarget();
    refreshPreview();
  }

  function updateEditingTarget() {
    const slot = dragging?.slot ?? picked?.slot ?? state.selected;
    editingTarget.hidden = !storageMode() || !stackAt(slot);
  }

  function setInventory(next) {
    if (!Array.isArray(next?.slots) || next.slots.length !== inventorySize ||
        !Number.isInteger(next.selected) || next.selected < 0 || next.selected >= columns) return false;
    state = {...next,equipment:next.equipment ?? Array(equipmentLabels.length).fill(null),offhand:next.offhand ?? null};
    if (picked?.slot !== undefined && !stackAt(picked.slot)) picked = null;
    hotbar.hidden = false;
    paintInventory();
    updateCarried();
    if (!catalog && (state.offhand || next.slots.some(Boolean))) fetchCatalog();
    return true;
  }

  function setOffhandAvailable(available) {
    offhandAvailable = available;
    hudOffhand.hidden = !available;
    menuOffhand.hidden = !available || !storageMode();
    if (!available && picked?.slot === offhandSlot) setPicked(null);
  }

  const discard = source => { if (source?.slot!==undefined && !source.clone && stackAt(source.slot)) void request(trash,source.slot); };
  acceptDrop(trashTarget,discard);
  trashTarget.addEventListener('click',() => { discard(picked); setPicked(null); });
  function editSource(source) {
    if (!storageMode() || source?.slot===undefined || !stackAt(source.slot)) return;
    setPicked(null);
    editItem?.(source.slot);
  }
  acceptDrop(editingTarget,editSource,source=>storageMode()&&source.slot!==undefined);
  editingTarget.addEventListener('click',()=>editSource(picked??{slot:state.selected}));

  function blockButton({entry,icon,name,code}) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'creative-card';
    card.dataset.key = entry.key;
    card.disabled = entry.placeable === false;
    card.draggable = !card.disabled;
    updateItemTooltip(card,null,name,{entry,code,extra:entry.mod});
    card.setAttribute('aria-label',name);
    card.append(draw(icon));
    const source = {entry};
    card.addEventListener('click',event=>{
      if (picked && picked.entry?.key !== entry.key) { setPicked(null); return; }
      const count = event.shiftKey ? maxStack(entry) : Math.min(maxStack(entry),(picked?.count ?? 0)+1);
      setPicked({entry,count});
    });
    card.addEventListener('contextmenu',event=>{
      if (card.disabled) return;
      event.preventDefault();
      if (!picked) setPicked({entry,count:1});
      else setPicked(picked.entry?.key === entry.key && picked.count > 1 ? {...picked,count:picked.count-1} : null);
    });
    card.addEventListener('auxclick',event=>{
      if (card.disabled || event.button !== 1) return;
      event.preventDefault();
      if (!picked) setPicked({entry,count:maxStack(entry)});
    });
    card.addEventListener('pointerenter',()=>{ underCursor = source; });
    card.addEventListener('pointerleave',()=>{ if (underCursor === source) underCursor = null; });
    card.addEventListener('dragstart',event=>beginDrag(event,source));
    card.addEventListener('dragend',endDrag);
    return card;
  }

  function renderRows() {
    if (storageMode() || !list.clientHeight || !matches.length) { grid.replaceChildren(); return; }
    const rowHeight = list.clientHeight / visibleRows;
    const row = Math.max(0,Math.floor(list.scrollTop / rowHeight)-1);
    scrollbar.value = String(list.scrollTop);
    if (firstRow === row) return;
    firstRow = row;
    underCursor = null;
    const end = Math.min(matches.length,(row+visibleRows+3)*columns);
    grid.style.minHeight = `${Math.ceil(matches.length/columns)*rowHeight}px`;
    grid.style.paddingTop = `${row*rowHeight}px`;
    grid.replaceChildren(...matches.slice(row*columns,end).map(blockButton));
    scrollbar.max = String(Math.max(0,list.scrollHeight - list.clientHeight));
    scrollbar.disabled = Number(scrollbar.max) === 0;
  }

  function render() {
    const storage = storageMode();
    dialog.classList.toggle('inventory-only',storage);
    dialog.classList.toggle('search-tab',active === 'all');
    previewCanvas.hidden = equipmentPanel.hidden = slotsPanel.hidden = trashTarget.hidden = storage === false;
    menuOffhand.hidden = !storage || !offhandAvailable;
    list.hidden = scrollbar.hidden = storage;
    search.hidden = active !== 'all';
    if (!catalog) { paintInventory(); return; }
    const currentTab = catalog.tabs.find(tab=>tab.id === active);
    byId('creative-title').textContent = currentTab?.label ?? 'Предметы';
    const terms = normalized(search.value).trim().split(/\s+/).filter(Boolean);
    const available = active === 'all' ? allCards : (currentTab?.cards ?? []).map(cardData);
    matches = storage ? [] : available.filter(card=>terms.every(term=>card.search.includes(term)));
    firstRow = -1;
    grid.style.minHeight = grid.style.paddingTop = '0';
    list.scrollTop = 0;
    scrollbar.disabled = matches.length <= columns*visibleRows;
    status.textContent = storage || matches.length ? '' : 'Нет подходящих предметов';
    updateTabs();
    renderRows();
    paintInventory();
  }

  function updateTabs() {
    const available = catalog.tabs.filter(tab=>tab.id === 'all' || tab.id === 'inventory' ||
      (tab.index < 12 ? tabPage === 0 : Math.floor((tab.index-12)/10)+1 === tabPage));
    const current = new Set(available.map(tab=>tab.id));
    for (const tab of tabsBar.children) {
      const selected = tab.dataset.tab === active;
      tab.hidden = !current.has(tab.dataset.tab);
      tab.setAttribute('aria-selected',String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected) list.setAttribute('aria-labelledby',tab.id);
    }
    const pages = Math.max(0,...catalog.tabs.map(tab=>Math.floor((tab.index-12)/10)+1));
    previousPage.hidden = nextPage.hidden = pages === 0;
    previousPage.disabled = tabPage === 0;
    nextPage.disabled = tabPage >= pages;
  }

  function setPage(page) {
    if (!catalog || page < 0) return;
    const first = catalog.tabs.find(tab=>tab.id !== 'all' && tab.id !== 'inventory' &&
      (tab.index < 12 ? page === 0 : Math.floor((tab.index-12)/10)+1 === page));
    if (!first) return;
    tabPage = page;
    active = first.id;
    search.value = '';
    setPicked(null);
    render();
  }

  function init(data) {
    const entries = Array.isArray(data) ? data : data?.entries;
    if (!Array.isArray(entries)) throw new Error('Неверный формат каталога');
    catalog = arrangeCreativeCatalog(entries);
    allCards = catalog.cards.map(cardData);
    const buttons = catalog.tabs.map(({id,label,index,iconEntry}) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.id = `creative-tab-${index}`;
      tab.dataset.tab = id;
      const position = index < 12 ? index : (index-12)%10 + Number((index-12)%10 >= 5);
      tab.dataset.position = position;
      tab.dataset.row = Math.floor(position/6);
      const column = position % 6;
      tab.style.setProperty('--tab-x', column === 5 ? 168 : 1 + column * 28);
      tab.style.setProperty('--tab-source-x',column*28);
      tab.title = label;
      tab.setAttribute('aria-label',label);
      tab.setAttribute('role','tab');
      tab.setAttribute('aria-controls',id === 'inventory' ? 'creative-inventory' : list.id);
      if (iconEntry) tab.append(draw(iconEntry));
      tab.addEventListener('click',() => {
        active = id;
        search.value = '';
        setPicked(null);
        render();
        if (id === 'all') search.focus();
      });
      return tab;
    });
    tabsBar.replaceChildren(...buttons);
    for (const button of [...menuSlots,...worldSlots]) delete button.dataset.image;
    render();
  }

  function fetchCatalog() {
    if (catalog || pending) return;
    retry.hidden = true;
    status.textContent = 'Загружаем каталог…';
    pending = Promise.resolve().then(load).then(init).catch(() => {
      status.textContent = 'Не удалось загрузить каталог';
      retry.hidden = false;
    }).finally(()=>{ pending = null; });
  }

  function open(storage = false) {
    if ((storage ? byId('inventory-toggle') : toggle).disabled || dialog.open) return;
    active = storage ? 'inventory' : active === 'inventory' ? 'buildingBlocks' : active;
    if (active === 'buildingBlocks') tabPage = 0;
    openedFromPause = byId('game').classList.contains('paused');
    dialog.showModal();
    pause();
    fetchCatalog();
    render();
    if (storage) menuSlots[state.selected].focus({preventScroll:true});
    else if (active === 'all') search.focus();
    else dialog.focus();
  }

  function outside(point) {
    const rect = dialog.getBoundingClientRect();
    return point.clientX < rect.left || point.clientY < rect.top || point.clientX >= rect.right || point.clientY >= rect.bottom;
  }

  function dropSource(source,all) {
    if (source?.entry) void request(drop,{key:source.entry.key,count:all ? countAt(source) : 1});
    else if (source?.slot !== undefined && stackAt(source.slot)) {
      void request(drop,{slot:source.slot,...(source.clone&&{clone:true}),
        ...(source.count||source.clone ? {count:all ? countAt(source):1} : {all})});
    }
  }

  toggle.addEventListener('click',()=>open());
  byId('inventory-toggle').addEventListener('click',()=>open(true));
  byId('creative-close').addEventListener('click',()=>close());
  previousPage.addEventListener('click',()=>setPage(tabPage-1));
  nextPage.addEventListener('click',()=>setPage(tabPage+1));
  retry.addEventListener('click',fetchCatalog);
  dialog.addEventListener('cancel',event=>{ event.preventDefault(); close(); });
  dialog.addEventListener('pointermove',event=>{
    carried.style.left = `${event.clientX}px`;
    carried.style.top = `${event.clientY}px`;
  });
  dialog.addEventListener('click',event=>{
    if (event.target === dialog && picked && outside(event)) {
      dropSource(picked,true);
      setPicked(null);
    }
  });
  dialog.addEventListener('contextmenu',event=>{
    if (event.target !== dialog || !picked || !outside(event)) return;
    event.preventDefault();
    dropSource(picked,false);
    setPicked(picked.count > 1 ? {...picked,count:picked.count-1} : null);
  });
  acceptDrop(dialog,(source,event)=>{ if (outside(event)) dropSource(source,true); });
  list.addEventListener('scroll',renderRows,{passive:true});
  scrollbar.addEventListener('input',()=>{ list.scrollTop = Number(scrollbar.value); });
  search.addEventListener('input',render);
  search.addEventListener('keydown',event => {
    if (event.isComposing || !['ArrowDown','Enter'].includes(event.code)) return;
    const first = grid.querySelector('button:enabled');
    if (!first) return;
    event.preventDefault();
    if (event.code === 'Enter') first.click();
    else first.focus();
  });
  tabsBar.addEventListener('keydown',event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.code)) return;
    const visible = Array.from(tabsBar.children).filter(tab=>!tab.hidden)
      .sort((a,b)=>Number(a.dataset.position)-Number(b.dataset.position));
    const index = visible.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    const next = event.code === 'Home' ? 0 : event.code === 'End' ? visible.length-1 :
      (index + (event.code === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length;
    visible[next].click();
    visible[next].focus();
  });
  new ResizeObserver(()=>{ if (dialog.open) { firstRow = -1; renderRows(); } }).observe(list);
  paintInventory();

  return {
    open:()=>open(), openInventory:()=>open(true), close, isOpen:()=>dialog.open, setInventory, setOffhandAvailable, refreshPreview, selectSlot,
    scrollHotbar(direction) {
      if (direction) return selectSlot(((requestedSlot ?? state.selected)+Math.sign(direction)+columns)%columns);
    },
    keydown(event) {
      if (!dialog.open) return false;
      if (event.code === 'KeyN' && storageMode() && offhandAvailable && !event.ctrlKey&&!event.altKey&&!event.metaKey) {
        event.preventDefault();
        if (!event.repeat) { setPicked(null); void request(swap,true); }
        return true;
      }
      if (event.code === 'Escape' || ['KeyI','KeyB'].includes(event.code) && event.target !== search) {
        event.preventDefault();
        close();
      }
      if (event.target === search) return true;
      const source = picked ?? underCursor;
      if (source && event.code === 'KeyQ') {
        event.preventDefault();
        if (event.repeat) return true;
        dropSource(source,event.ctrlKey);
        if (source === picked) setPicked(!event.ctrlKey && picked.count > 1 ? {...picked,count:picked.count-1} : null);
      }
      if (source && event.code === 'Delete') {
        event.preventDefault();
        discard(source);
        setPicked(null);
      }
      if (source && /^Digit[1-9]$/.test(event.code)) {
        event.preventDefault();
        const slot = Number(event.code.slice(-1)) - 1;
        if (source === picked) void transferTo(source,slot);
        else if (source.entry) void transferTo({entry:source.entry,count:maxStack(source.entry)},slot);
        else if (slot !== source.slot) void request(move,source.slot,slot);
      }
      return true;
    },
  };
}
