const errors = {
  invalid_warp_title:'Введите название до 64 символов',
  invalid_warp:'Не удалось открыть варп',
  warp_missing:'Этот варп уже удалён',
  movement_blocked:'Позиция изменилась. Поставьте варп ещё раз',
};

export function createWarpMenu({load,add,remove,teleport,close,notice,teleportErrors}) {
  const byId = id=>document.getElementById(id);
  const panel = byId('warps-menu');
  const list = byId('warp-list');
  const status = byId('warp-status');
  const actions = byId('warp-actions');
  const place = byId('warp-place');
  const form = byId('warp-form');
  const title = byId('warp-title');
  const save = byId('warp-save');
  const travel = byId('warp-travel');
  const discard = byId('warp-remove');
  let state, selected, pending = false;

  function activate(id) {
    selected = id;
    for (const button of list.querySelectorAll('button')) {
      button.setAttribute('aria-pressed',String(button.dataset.warpId === selected));
    }
    actions.hidden = !selected || !form.hidden;
  }

  function busy(active) {
    pending = active;
    travel.disabled = discard.disabled = save.disabled = place.disabled = active;
  }

  function update(next) {
    if (!Number.isInteger(next?.revision) || !Array.isArray(next.warps) || next.revision < (state?.revision ?? 0)) return;
    state = next;
    const buttons = state.warps.map(warp=>{
      const row = document.createElement('li');
      const button = document.createElement('button');
      const name = document.createElement('span');
      const coordinates = document.createElement('small');
      name.textContent = warp.title;
      coordinates.textContent = [warp.position.x,warp.position.y,warp.position.z]
        .map(value=>value.toFixed(2)).join(' · ');
      button.type = 'button';
      button.dataset.warpId = warp.id;
      button.addEventListener('click',()=>activate(warp.id));
      button.append(name,coordinates);
      row.append(button);
      return row;
    });
    status.textContent = buttons.length ? '' : 'Варпов пока нет';
    list.replaceChildren(...buttons);
    activate(state.warps.some(warp=>warp.id===selected) ? selected : undefined);
  }

  async function refresh() {
    try { update(await load()); }
    catch { status.textContent = 'Не удалось загрузить список варпов'; }
  }

  function show(visible) {
    panel.hidden = !visible;
    form.hidden = true;
    title.value = '';
    activate(undefined);
    if (visible) {
      if (!state) status.textContent = 'Загружаем варпы…';
      void refresh();
      (pending ? byId('warp-close') : place).focus();
    }
  }

  async function request(run, success, failure) {
    if (pending) return;
    busy(true);
    try {
      const {ok,body} = await run();
      if (ok) return success(body);
      if (body.error === 'warp_missing') void refresh();
      const message = errors[body.error] ?? teleportErrors[body.error] ?? failure;
      status.textContent = message;
      notice(message);
    } catch {
      const message = 'Связь с сервером прервана';
      status.textContent = message;
      notice(message);
    } finally { busy(false); }
  }

  byId('warp-close').addEventListener('click',close);
  place.addEventListener('click',()=>{
    form.hidden = false;
    actions.hidden = true;
    title.focus();
  });
  byId('warp-cancel').addEventListener('click',()=>{
    form.hidden = true;
    activate(selected);
    place.focus();
  });
  form.addEventListener('submit',event=>{
    event.preventDefault();
    if (!title.value.trim()) return;
    void request(()=>add(title.value),next=>{
      form.hidden = true;
      title.value = '';
      update(next);
      activate(next.warps.at(-1)?.id);
      notice('Варп поставлен');
    },'Не удалось поставить варп');
  });
  travel.addEventListener('click',()=>{
    if (selected) void request(()=>teleport(selected),()=>{
      close();
      notice('Телепорт выполнен');
    },'Не удалось телепортироваться');
  });
  discard.addEventListener('click',()=>{
    if (selected) void request(()=>remove(selected),next=>{
      update(next);
      notice('Варп удалён');
    },'Не удалось удалить варп');
  });
  return {show,update,refresh};
}
