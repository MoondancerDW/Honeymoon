import {arrangeCreativeCatalog} from './creative-layout.mjs';

const pageSize = 108;
const hotbarSize = 9;
const inventorySize = 36;
const dragType = 'application/x-honeymoon-inventory';
const normalized = text => String(text ?? '').normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё','е');

function cardData({entry,icon,code}) {
  const name = entry.name || entry.english || entry.key;
  const description = [entry.mod, code].filter(Boolean).join(' · ');
  return {entry,icon,name,description,
    search:normalized([name,entry.english,entry.mod,entry.key,icon.name,icon.key,code,entry.variant].filter(Boolean).join(' '))};
}

function missingIcon(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.beginPath();
  ctx.moveTo(16,4);
  ctx.lineTo(27,10);
  ctx.lineTo(27,23);
  ctx.lineTo(16,29);
  ctx.lineTo(5,23);
  ctx.lineTo(5,10);
  ctx.closePath();
  ctx.moveTo(5,10);
  ctx.lineTo(16,16);
  ctx.lineTo(27,10);
  ctx.moveTo(16,16);
  ctx.lineTo(16,29);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#555';
  ctx.stroke();
}

export function createCreativeMenu({load,choose,select,move,trash,pause,resume,notice,icon}) {
  const byId = id => document.getElementById(id);
  const dialog = byId('creative-menu');
  const toggle = byId('creative-toggle');
  const search = byId('creative-search');
  const tabsBar = byId('creative-tabs');
  const list = byId('creative-list');
  const grid = byId('creative-grid');
  const more = byId('creative-more');
  const count = byId('creative-count');
  const retry = byId('creative-retry');
  const previousPage = byId('creative-prev-page');
  const nextPage = byId('creative-next-page');
  const trashTarget = byId('inventory-trash');
  const hotbar = byId('hotbar');
  const touch = matchMedia('(pointer: coarse)').matches;
  let catalog, allCards, pending, choosing = false, active = 'buildingBlocks', tabPage = 0;
  let matches = [], shown = 0, dragging, picked, requestedSlot;
  let state = {slots:Array(inventorySize).fill(null),selected:0};
  let queued = Promise.resolve();

  function request(callback,...args) {
    if (!callback) return Promise.resolve(false);
    const operation = queued.then(()=>callback(...args)).catch(error => {
      count.textContent = error.message || 'Ошибка инвентаря';
      notice?.(count.textContent);
      return false;
    });
    queued = operation;
    return operation;
  }

  function draw(entry) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    canvas.setAttribute('aria-hidden','true');
    Promise.resolve().then(()=>icon?.(entry,canvas) ?? false).then(result => {
      if (result === false) missingIcon(canvas);
    },() => missingIcon(canvas));
    return canvas;
  }

  function close(continuePlaying = true) {
    if (!dialog.open) return;
    clearTransfer();
    dialog.close();
    if (continuePlaying) resume();
  }

  async function chooseBlock(entry,slot = state.selected,closeMenu = true) {
    if (choosing || entry.placeable === false) return false;
    choosing = true;
    try {
      const chosen = await request(choose,entry,slot);
      if (chosen !== false && closeMenu) close();
      return chosen;
    } finally { choosing = false; }
  }

  function beginDrag(event,source) {
    if (!event.dataTransfer) return;
    picked = null;
    dragging = source;
    event.dataTransfer.setData(dragType,source.entry?.key ?? String(source.slot));
    event.dataTransfer.effectAllowed = source.entry ? 'copy' : 'move';
    highlightPicked();
  }

  function clearTransfer() {
    dragging = picked = null;
    highlightPicked();
  }

  function acceptDrop(target,callback,allowed = () => true) {
    target.addEventListener('dragover',event => {
      if (!dragging || !allowed(dragging)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = dragging.entry ? 'copy' : 'move';
      target.classList.add('drop-target');
    });
    target.addEventListener('dragleave',() => target.classList.remove('drop-target'));
    target.addEventListener('drop',event => {
      target.classList.remove('drop-target');
      if (!dragging || !allowed(dragging)) return;
      event.preventDefault();
      const source = dragging;
      clearTransfer();
      callback(source);
    });
  }

  function transferTo({entry,slot},destination) {
    if (entry) void chooseBlock(entry,destination,false);
    else if (slot !== destination && state.slots[slot]) void request(move,slot,destination);
  }

  function selectSlot(slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= hotbarSize || (requestedSlot ?? state.selected) === slot) return;
    if (!select) return;
    requestedSlot = slot;
    return request(select,slot).finally(()=>{ if (requestedSlot === slot) requestedSlot = undefined; });
  }

  function makeSlot(slot,inWorld) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'inventory-slot';
    button.dataset.slot = slot;
    button.addEventListener('click',() => {
      if (inWorld) { void selectSlot(slot); return; }
      if (picked) {
        const source = picked;
        clearTransfer();
        transferTo(source,slot);
      } else if (state.slots[slot]) {
        picked = {slot};
        highlightPicked();
      }
    });
    if (!inWorld) {
      button.addEventListener('dragstart',event => {
        if (!state.slots[slot]) { event.preventDefault(); return; }
        beginDrag(event,{slot});
      });
      button.addEventListener('dragend',clearTransfer);
      acceptDrop(button,source=>transferTo(source,slot));
    }
    return button;
  }

  const worldSlots = Array.from({length:hotbarSize},(_,i)=>makeSlot(i,true));
  const menuSlots = Array.from({length:inventorySize},(_,i)=>makeSlot(i,false));
  hotbar.replaceChildren(...worldSlots);
  byId('inventory-hotbar').replaceChildren(...menuSlots.slice(0,hotbarSize));
  byId('inventory-slots').replaceChildren(...menuSlots.slice(hotbarSize));

  function highlightPicked() {
    for (let slot=0;slot<menuSlots.length;slot++) {
      const button = menuSlots[slot];
      button.classList.toggle('picked-slot',picked?.slot === slot);
      if (!dragging) button.classList.remove('drop-target');
    }
    if (!dragging) trashTarget.classList.remove('drop-target');
  }

  function inventoryEntry(stack) {
    if (!stack) return null;
    const entry = catalog?.byKey.get(stack.key);
    if (entry) return entry;
    const id = Number(/^legacy:(\d+):/.exec(stack.cell ?? stack.key)?.[1]);
    if (stack.part) return {key:stack.key,kind:'microblock',part:stack.part,name:stack.name || 'Микроблок'};
    return {key:stack.cell ?? stack.key,id,name:stack.name || (id ? `Блок ${id}` : stack.key),data:stack.object?.data};
  }

  function paintInventory() {
    for (let slot=0;slot<state.slots.length;slot++) {
      const stack = state.slots[slot];
      const entry = inventoryEntry(stack);
      const renditions = slot < hotbarSize ? [menuSlots[slot],worldSlots[slot]] : [menuSlots[slot]];
      const selected = state.selected === slot;
      const quantity = stack?.count ?? 1;
      const name = entry ? entry.name || entry.key : 'Пусто';
      for (const button of renditions) {
        button.classList.toggle('selected-slot',selected);
        if (slot < hotbarSize) button.setAttribute('aria-pressed',String(selected));
        button.draggable = Boolean(stack) && button === menuSlots[slot];
        const label = `Ячейка ${slot+1} · ${name}${quantity > 1 ? ' ×'+quantity : ''}`;
        button.title = label;
        button.setAttribute('aria-label',label);
        const image = entry ? `${entry.key}:${quantity}:${stack?.part?.material ?? ''}:${stack?.part?.shape ?? ''}` : '';
        if (button.dataset.image === image) continue;
        button.dataset.image = image;
        button.replaceChildren();
        if (entry) {
          button.append(draw(entry));
          if (quantity > 1) {
            const count = document.createElement('span');
            count.className = 'stack-count';
            count.textContent = quantity;
            button.append(count);
          }
        }
      }
    }
  }

  function setInventory(next) {
    if (!Array.isArray(next?.slots) || next.slots.length !== inventorySize ||
        !Number.isInteger(next.selected) || next.selected < 0 || next.selected >= hotbarSize) return false;
    state = next;
    if (picked?.slot !== undefined && !state.slots[picked.slot]) clearTransfer();
    hotbar.hidden = false;
    paintInventory();
    if (!catalog && next.slots.some(Boolean)) fetchCatalog();
    return true;
  }

  const discard = source => { if (state.slots[source.slot]) void request(trash,source.slot); };
  acceptDrop(trashTarget,discard,source=>source.slot !== undefined);
  trashTarget.addEventListener('click',() => {
    if (picked?.slot === undefined) return;
    const source = picked;
    clearTransfer();
    discard(source);
  });

  function blockButton({entry,icon,name,description}) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'creative-card';
    card.dataset.key = entry.key;
    card.disabled = entry.placeable === false;
    card.draggable = !card.disabled;
    card.title = [name,description,entry.variant].filter(Boolean).join('\n');
    card.setAttribute('aria-label',name);
    card.append(draw(icon));
    card.addEventListener('click',event => {
      if (touch && event.detail) {
        picked = {entry};
        count.textContent = `${name} · выберите ячейку`;
      } else void chooseBlock(entry);
    });
    card.addEventListener('dragstart',event=>beginDrag(event,{entry}));
    card.addEventListener('dragend',clearTransfer);
    return card;
  }

  function appendPage() {
    const end = Math.min(matches.length,shown+pageSize);
    const cards = matches.slice(shown,end).map(blockButton);
    grid.append(...cards);
    shown = end;
    more.hidden = shown >= matches.length;
    more.textContent = `Показать ещё ${Math.min(pageSize,matches.length-shown)}`;
    count.textContent = !matches.length ? 'Нет подходящих предметов' : shown < matches.length
      ? `Показано ${shown} из ${matches.length}` : `Предметов: ${matches.length}`;
    return cards;
  }

  function render() {
    const storage = active === 'inventory';
    dialog.classList.toggle('inventory-only',storage);
    byId('creative-title').textContent = storage ? 'Инвентарь' : 'Креатив';
    search.hidden = list.hidden = storage;
    if (!catalog) return;
    const currentTab = catalog.tabs.find(tab=>tab.id === active);
    const terms = normalized(search.value).trim().split(/\s+/).filter(Boolean);
    const available = active === 'all' ? allCards : (currentTab?.cards ?? []).map(cardData);
    matches = available.filter(card=>terms.every(term=>card.search.includes(term)));
    if (active === 'all' && !matches.length && terms.length === 1) {
      const entry = catalog.byKey.get(terms[0]);
      if (entry) matches = [cardData({entry,icon:entry,code:entry.key})];
    }
    shown = 0;
    list.scrollTop = 0;
    grid.replaceChildren();
    updateTabs();
    if (!storage) appendPage();
    else count.textContent = '';
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
    clearTransfer();
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
      tab.style.gridColumn = position%6+1;
      tab.style.gridRow = Math.floor(position/6)+1;
      tab.title = label;
      tab.setAttribute('aria-label',label);
      tab.setAttribute('role','tab');
      tab.setAttribute('aria-controls',id === 'inventory' ? 'creative-inventory' : list.id);
      if (iconEntry) tab.append(draw(iconEntry));
      const title = document.createElement('span');
      title.textContent = label;
      tab.append(title);
      tab.addEventListener('click',() => { active = id; search.value = ''; clearTransfer(); render(); });
      return tab;
    });
    tabsBar.replaceChildren(...buttons);
    for (const button of [...menuSlots,...worldSlots]) delete button.dataset.image;
    paintInventory();
    render();
  }

  function fetchCatalog() {
    if (catalog || pending) return;
    retry.hidden = true;
    count.textContent = 'Загружаем каталог…';
    pending = Promise.resolve().then(load).then(init).catch(() => {
      count.textContent = 'Не удалось загрузить каталог';
      retry.hidden = false;
    }).finally(()=>{ pending = null; });
  }

  function open(storage = false) {
    if (toggle.disabled || dialog.open) return;
    active = storage ? 'inventory' : active === 'inventory' ? 'buildingBlocks' : active;
    if (active === 'buildingBlocks') tabPage = 0;
    dialog.showModal();
    pause();
    fetchCatalog();
    render();
    if (storage) menuSlots[state.selected].focus();
    else search.focus();
  }

  toggle.addEventListener('click',()=>open());
  byId('inventory-toggle').addEventListener('click',()=>open(true));
  byId('creative-close').addEventListener('click',()=>close());
  previousPage.addEventListener('click',()=>setPage(tabPage-1));
  nextPage.addEventListener('click',()=>setPage(tabPage+1));
  retry.addEventListener('click',fetchCatalog);
  more.addEventListener('click',()=>appendPage().find(card=>!card.disabled)?.focus());
  dialog.addEventListener('cancel',event=>{ event.preventDefault(); close(); });
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
  paintInventory();

  return {
    open:()=>open(), openInventory:()=>open(true), close, isOpen:()=>dialog.open, setInventory, selectSlot,
    scrollHotbar(direction) {
      if (direction) return selectSlot(((requestedSlot ?? state.selected)+Math.sign(direction)+hotbarSize)%hotbarSize);
    },
    keydown(event) {
      if (!dialog.open) return false;
      if (event.code === 'Escape') { event.preventDefault(); close(); }
      if (event.code === 'Delete' && picked?.slot !== undefined && event.target !== search) {
        event.preventDefault();
        const source = picked;
        clearTransfer();
        discard(source);
      }
      return true;
    },
  };
}
