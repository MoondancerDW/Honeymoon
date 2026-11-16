const pageSize = 96;
const collator = new Intl.Collator('ru', {numeric:true, sensitivity:'base'});
const defaultTabs = [
  ['build','Строительство'], ['decor','Декор'], ['nature','Природа'], ['redstone','Механизмы'],
  ['jammy','Мебель Jammy'], ['chisel','Chisel'], ['redpower','RedPower'], ['mods','Другие моды'],
  ['technical','Технические'], ['items','Предметы'],
];

function normalized(text) {
  return String(text ?? '').normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё', 'е');
}

function cardData(entry) {
  const name = entry.name || entry.english || entry.key;
  const address = Number.isInteger(entry.id) ? entry.id + ':' + (entry.damage ?? entry.meta ?? 0) : entry.key;
  return {entry, name, address, category:entry.category ?? 'mods',
    search:normalized([name, entry.english, entry.mod, entry.key, address, entry.variant].filter(Boolean).join(' '))};
}

function missingIcon(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.moveTo(16, 4);
  ctx.lineTo(27, 10);
  ctx.lineTo(27, 23);
  ctx.lineTo(16, 29);
  ctx.lineTo(5, 23);
  ctx.lineTo(5, 10);
  ctx.closePath();
  ctx.moveTo(5, 10);
  ctx.lineTo(16, 16);
  ctx.lineTo(27, 10);
  ctx.moveTo(16, 16);
  ctx.lineTo(16, 29);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#7d989b';
  ctx.stroke();
}

export function createCreativeMenu({load, choose, pause, resume, notice, icon}) {
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
  let catalog, tabs = [], pending, choosing = false, active = 'all', matches = [], shown = 0;

  function close(continuePlaying = true) {
    if (!dialog.open) return;
    dialog.close();
    if (continuePlaying) resume();
  }

  function chooseBlock(entry) {
    if (choosing) return;
    choosing = true;
    function finished(result) {
      choosing = false;
      if (result !== false) close();
    }
    function failed(error) {
      choosing = false;
      count.textContent = 'Не удалось выбрать блок';
      notice?.(error.message || count.textContent);
    }
    try {
      const result = choose(entry);
      if (result && typeof result.then === 'function') result.then(finished, failed);
      else finished(result);
    } catch (error) { failed(error); }
  }

  function blockButton({entry, name, address}) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'creative-card';
    card.dataset.key = entry.key;
    card.disabled = entry.placeable === false;
    const details = [entry.mod, address].filter(Boolean).join(' · ');
    card.title = [name, details, entry.variant].filter(Boolean).join('\n');
    const preview = document.createElement('canvas');
    preview.width = preview.height = 32;
    preview.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    const label = document.createElement('strong');
    const subtitle = document.createElement('small');
    label.textContent = name;
    subtitle.textContent = details;
    text.append(label, subtitle);
    card.append(preview, text);
    card.addEventListener('click', () => chooseBlock(entry));
    if (!icon) missingIcon(preview);
    else {
      try {
        const result = icon(entry, preview);
        if (result && typeof result.then === 'function') {
          result.then(rendered => { if (rendered === false) missingIcon(preview); }, () => missingIcon(preview));
        } else if (result === false) missingIcon(preview);
      } catch { missingIcon(preview); }
    }
    return card;
  }

  function appendPage() {
    const end = Math.min(matches.length, shown + pageSize);
    const cards = matches.slice(shown, end).map(blockButton);
    grid.append(...cards);
    shown = end;
    more.hidden = shown >= matches.length;
    more.textContent = `Показать ещё ${Math.min(pageSize, matches.length - shown)}`;
    count.textContent = !matches.length ? 'Нет подходящих блоков' : shown < matches.length
      ? `Показано ${shown} из ${matches.length}` : `Блоков и вариантов: ${matches.length}`;
    return cards;
  }

  function render() {
    if (!catalog) return;
    const terms = normalized(search.value).trim().split(/\s+/).filter(Boolean);
    matches = catalog.filter(card => (active === 'all' || card.category === active) &&
      terms.every(term => card.search.includes(term)));
    shown = 0;
    list.scrollTop = 0;
    grid.replaceChildren();
    for (const tab of tabs) {
      const current = tab.dataset.tab === active;
      tab.setAttribute('aria-selected', String(current));
      tab.tabIndex = current ? 0 : -1;
      if (current) list.setAttribute('aria-labelledby', tab.id);
    }
    appendPage();
  }

  function init(data) {
    const entries = Array.isArray(data) ? data : data?.entries;
    if (!Array.isArray(entries)) throw new Error('Неверный формат каталога');
    catalog = entries.map(cardData).sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.address, b.address));
    const available = new Set(catalog.map(card => card.category));
    const known = new Map(data.tabs?.map(({id, label}) => [id, label]) ?? defaultTabs);
    const categories = [['all','Все'], ...[...known].filter(([id]) => id !== 'all' && available.has(id))];
    for (const id of available) if (id !== 'all' && !known.has(id)) categories.push([id, id]);
    tabs = categories.map(([id, label], index) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.id = `creative-tab-${index}`;
      tab.dataset.tab = id;
      tab.textContent = label;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', list.id);
      tab.addEventListener('click', () => { active = id; render(); });
      return tab;
    });
    tabsBar.replaceChildren(...tabs);
    render();
  }

  function fetchCatalog() {
    if (catalog || pending) return;
    retry.hidden = true;
    count.textContent = 'Загружаем блоки…';
    pending = Promise.resolve().then(load).then(init).catch(() => {
      count.textContent = 'Не удалось загрузить каталог блоков';
      retry.hidden = false;
    }).finally(() => { pending = null; });
  }

  function open() {
    if (toggle.disabled || dialog.open) return;
    dialog.showModal();
    pause();
    search.focus();
    fetchCatalog();
  }

  toggle.addEventListener('click', open);
  byId('creative-close').addEventListener('click', () => close());
  retry.addEventListener('click', fetchCatalog);
  more.addEventListener('click', () => appendPage().find(card => !card.disabled)?.focus());
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  search.addEventListener('input', render);
  search.addEventListener('keydown', event => {
    if (event.isComposing || event.code !== 'ArrowDown' && event.code !== 'Enter') return;
    const first = grid.querySelector('button:enabled');
    if (!first) return;
    event.preventDefault();
    if (event.code === 'Enter') first.click();
    else first.focus();
  });
  tabsBar.addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.code)) return;
    const index = tabs.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    const next = event.code === 'Home' ? 0 : event.code === 'End' ? tabs.length - 1 :
      (index + (event.code === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click();
    tabs[next].focus();
  });

  return {
    open, close, isOpen: () => dialog.open,
    keydown(event) {
      if (!dialog.open) return false;
      if (event.code === 'Escape') { event.preventDefault(); close(); }
      return true;
    },
  };
}
