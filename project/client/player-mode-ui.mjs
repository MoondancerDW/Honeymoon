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
  const health=element('health'), death=element('death-screen'), reviveButton=element('revive');
  const admin=element('mode-menu'), administrator=element('mode-toggle'), list=element('mode-players');
  const defaultRow=element('mode-default'), craftMenu=element('craft-menu'), craftToggle=element('craft-toggle');
  const right=element('mode-error'), craftError=element('craft-error');
  const cells=Array.from({length:10},()=>document.createElement('span'));
  health.append(...cells);
  let state, deathTime, retry, pending=false;
  function update(next) {
    if (!next) return;
    state=next;
    health.hidden=next.mode!=='game'||Boolean(next.death);
    health.setAttribute('aria-valuenow',String(next.health));
    cells.forEach((cell,index)=>cell.classList.toggle('filled',index<next.health));
    administrator.hidden=!next.admin;
    craftToggle.hidden=next.mode!=='game';
    death.hidden=!next.death;
    if (deathTime!==next.death?.at) {
      deathTime=next.death?.at;
      clearTimeout(retry);
      reviveButton.hidden=true;
      if (next.death) retry=setTimeout(()=>{reviveButton.hidden=false;},850);
    }
    changed(next);
  }
  function render(config) {
    const global=selectMode(config.mode);
    global.setAttribute('aria-label','Режим по умолчанию');
    global.addEventListener('change',()=>void change({mode:global.value}));
    defaultRow.replaceChildren(global);
    list.replaceChildren(...config.players.map(profile=>{
      const row=document.createElement('label'), name=document.createElement('span');
      const mode=selectMode(profile.override,true);
      name.textContent=profile.nickname;
      row.append(name,mode);
      mode.addEventListener('change',()=>void change({target:profile.id,mode:mode.value||null}));
      return row;
    }));
    if (config.players.length===0) list.textContent='Пока нет игроков в мире';
  }
  async function change(fields) {
    if (pending) return;
    pending=true;
    right.textContent='';
    try {
      const result=await changeMode(fields);
      if (!result.ok) throw new Error(result.body.error);
      if (admin.open) render(result.body);
    } catch {
      right.textContent='Не удалось обновить режим';
      try {if (admin.open) render(await fetchModes());} catch {}
    } finally {pending=false;}
  }
  administrator.addEventListener('click',async()=>{
    if (!state?.admin||admin.open) return;
    pause();
    admin.showModal();
    right.textContent='';
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
  return {update,get active(){return Boolean(state);},get creative(){return state?.mode!=='game';},
    get admin(){return Boolean(state?.admin);},get death(){return state?.mode==='game'?state.death:null;},
    isOpen:()=>admin.open||craftMenu.open};
}
