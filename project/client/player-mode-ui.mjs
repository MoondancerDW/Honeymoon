import {basicRecipes} from '../world/survival-tools.mjs';

const labels={game:'Игровой',creative:'Креатив'};
function selectMode(value,inherit=false) {
  const select=document.createElement('select');
  for (const [mode,title] of [...(inherit?[['','Как на сервере']]:[]),...Object.entries(labels)]) {
    const option=document.createElement('option');
    option.value=mode;
    option.textContent=title;
    select.append(option);
  }
  select.value=value??'';
  return select;
}

export function createPlayerModeUi({element,fetchModes,changeMode,craft,revive,changed,pause,notice}) {
  const health=element('health'), death=element('death-screen'), deathTitle=element('death-title'), reviveButton=element('revive');
  const admin=element('mode-menu'), administrator=element('mode-toggle'), list=element('mode-players');
  const selfMode=element('self-mode-toggle');
  const defaultRow=element('mode-default'), craftMenu=element('craft-menu'), craftToggle=element('craft-toggle');
  const right=element('mode-error'), craftError=element('craft-error');
  let cells=[];
  let state, deathTime, retry, selfUid, pending=false;
  function update(next) {
    if (!next) return;
    state=next;
    health.hidden=next.mode!=='game'||Boolean(next.death);
    const maxHealth=next.maxHealth??10;
    if (cells.length!==maxHealth) {
      cells=Array.from({length:maxHealth},()=>document.createElement('span'));
      health.setAttribute('aria-valuemax',String(maxHealth));
      health.replaceChildren(...cells);
    }
    health.setAttribute('aria-valuenow',String(next.health));
    cells.forEach((cell,index)=>cell.classList.toggle('filled',index<next.health));
    administrator.hidden=!next.admin;
    selfMode.hidden=!next.admin||!selfUid;
    selfMode.disabled=pending;
    selfMode.textContent=`Режим: ${labels[next.mode]}`;
    craftToggle.hidden=next.mode!=='game';
    death.hidden=!next.death;
    deathTitle.textContent=next.death?.cause==='lava'?'Сгорел':'Помер';
    if (deathTime!==next.death?.at) {
      deathTime=next.death?.at;
      clearTimeout(retry);
      reviveButton.hidden=true;
      if (next.death) retry=setTimeout(()=>{reviveButton.hidden=false;},850);
    }
    changed(next);
  }
  function render(config) {
    const openRows=new Set([...list.querySelectorAll('[data-mode-player-uid][open]')].map(row=>row.dataset.modePlayerUid));
    const focused=document.activeElement;
    const focusedPlayer=focused?.closest('[data-mode-player-uid]')?.dataset.modePlayerUid;
    const focusDefault=defaultRow.contains(focused);
    const global=selectMode(config.mode);
    global.setAttribute('aria-label','Режим по умолчанию');
    global.addEventListener('change',()=>void change({mode:global.value}));
    defaultRow.replaceChildren(global);
    list.replaceChildren(...config.players.map(profile=>{
      const row=document.createElement('details'), summary=document.createElement('summary');
      const label=document.createElement('label');
      const mode=selectMode(profile.override,true);
      row.className='mode-player-management';
      row.dataset.modePlayerUid=profile.id;
      row.open=openRows.has(profile.id);
      summary.textContent=`${profile.nickname} · ${labels[profile.mode??config.mode]}`;
      label.append('Изменить режим',mode);
      row.append(summary,label);
      mode.addEventListener('change',()=>void change({target:profile.id,mode:mode.value||null}));
      return row;
    }));
    if (config.players.length===0) list.textContent='Пока нет игроков в мире';
    if (focusedPlayer) list.querySelector(`[data-mode-player-uid="${CSS.escape(focusedPlayer)}"] > summary`)?.focus({preventScroll:true});
    else if (focusDefault) global.focus({preventScroll:true});
  }
  async function change(fields) {
    if (pending) return;
    pending=true;
    selfMode.disabled=true;
    right.textContent='';
    try {
      const result=await changeMode(fields);
      if (!result.ok) throw new Error(result.body.error);
      if (result.body.selfMode) update(result.body.selfMode);
      if (admin.open) render(result.body);
    } catch {
      right.textContent='Не удалось обновить режим';
      if (!admin.open && fields.target===selfUid) notice(right.textContent);
      try {if (admin.open) render(await fetchModes());} catch {}
    } finally {
      pending=false;
      selfMode.disabled=false;
    }
  }
  selfMode.addEventListener('click',()=>{
    if (state?.admin&&selfUid) void change({target:selfUid,mode:state.mode==='creative'?'game':'creative'});
  });
  administrator.addEventListener('click',async()=>{
    if (!state?.admin||admin.open) return;
    pause();
    admin.showModal();
    right.textContent='';
    list.replaceChildren();
    defaultRow.replaceChildren();
    try {render(await fetchModes());}
    catch {right.textContent='Список игроков недоступен';}
  });
  element('mode-close').addEventListener('click',()=>admin.close());
  element('craft-close').addEventListener('click',()=>craftMenu.close());
  craftToggle.addEventListener('click',()=>{
    if (state?.mode!=='game'||state.death||craftMenu.open) return;
    pause();
    craftError.textContent='';
    craftMenu.showModal();
  });
  for (const recipe of basicRecipes) {
    const button=document.createElement('button'),name=document.createElement('strong'),details=document.createElement('small');
    button.type='button';
    name.textContent=recipe.title;
    details.textContent=recipe.ingredients.map(value=>`${value.name} ×${value.count}`).join(' · ');
    button.append(name,details);
    button.addEventListener('click',async()=>{
      if (pending) return;
      pending=true;
      try {
        const result=await craft(recipe.id);
        craftError.textContent=result.ok ? 'Готово' : result.body.error==='missing_ingredients' ?
          'В инвентаре не хватает материалов' : 'Не удалось изготовить';
      } catch {craftError.textContent='Связь с сервером прервана';}
      finally {pending=false;}
    });
    element('craft-list').append(button);
  }
  reviveButton.addEventListener('click',async()=>{
    if (!state?.death||reviveButton.disabled) return;
    reviveButton.disabled=true;
    try {await revive();}
    catch {notice('Не удалось ожить');}
    finally {reviveButton.disabled=false;}
  });
  return {update,setSelf(uid){selfUid=uid;},get active(){return Boolean(state);},get creative(){return state?.mode!=='game';},
    get admin(){return Boolean(state?.admin);},get death(){return state?.mode==='game'?state.death:null;},
    isOpen:()=>admin.open||craftMenu.open};
}
