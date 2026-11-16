import {button,caption,field,node,stackChip} from './npc-controls.mjs';

const pageSize=24;

export function itemPicker({loadCatalog,drawItem,choose,cancel}) {
  const panel=node('section','npc-picker');
  const search=field('Найти предмет',{type:'search',placeholder:'Название, мод или ID'});
  const status=node('p','npc-picker-status','Загружаем каталог…');
  status.setAttribute('role','status');
  const results=node('div','npc-item-results');
  const controls=node('footer','npc-actions');
  const previous=button('Предыдущая',()=>{page--; render();});
  const next=button('Следующая',()=>{page++; render();});
  previous.disabled=next.disabled=true;
  controls.append(button('Назад',cancel),previous,next);
  panel.append(search.wrapper,status,results,controls);
  let entries=[],page=0,loaded=false;

  function render() {
    if (!loaded) return;
    const query=caption(search.input.value);
    const matches=query?entries.filter(row=>row.search.includes(query)):entries;
    const count=Math.ceil(matches.length/pageSize);
    page=Math.max(0,Math.min(page,count-1));
    previous.disabled=page===0;
    next.disabled=page+1>=count;
    status.textContent=matches.length?
      matches.length.toLocaleString('ru')+' · страница '+(page+1)+' из '+count:'Предметы не найдены';
    const cards=matches.slice(page*pageSize,(page+1)*pageSize).map(({entry})=>{
      const stack={key:entry.key,count:1};
      const card=button('',()=>choose(stack),'npc-item-card');
      card.dataset.key=entry.key;
      card.append(stackChip(stack,{entryFor:()=>entry,drawItem}));
      return card;
    });
    results.replaceChildren(...cards);
  }

  search.input.addEventListener('input',()=>{page=0; render();});
  loadCatalog().then(catalog=>{
    entries=catalog.entries.filter(entry=>entry.key && !entry.hidden).map(entry=>({
      entry,search:caption([entry.name,entry.mod,entry.key,entry.id].filter(Boolean).join(' ')),
    }));
    loaded=true;
    render();
  }).catch(()=>{status.textContent='Каталог предметов недоступен';});
  queueMicrotask(()=>search.input.focus());
  return panel;
}

export function modelPicker({models,value,choose}) {
  const container=node('div','npc-model-picker');
  const filter=field('Найти модель',{type:'search',placeholder:'Название, категория или ID'});
  const results=node('select','npc-model-list');
  results.setAttribute('aria-label','Подходящие модели');
  results.size=7;
  container.append(filter.wrapper,results);
  let selected=value;

  function render() {
    const query=caption(filter.input.value);
    const groups=new Map();
    const entries=models.filter(model=>!query || caption([model.label,model.id,model.category].join(' ')).includes(query));
    for (const model of entries) {
      const name=model.category||'Модели';
      let group=groups.get(name);
      if (!group) {
        group=node('optgroup');
        group.label=name;
        groups.set(name,group);
      }
      const option=node('option',null,model.label??model.id);
      option.value=model.id;
      option.selected=model.id===selected;
      group.append(option);
    }
    results.replaceChildren(...groups.values());
    results.disabled=!entries.length;
    if (!entries.length) results.append(node('option',null,'Модели не найдены'));
    else if (!entries.some(entry=>entry.id===selected)) results.selectedIndex=-1;
  }

  filter.input.addEventListener('input',render);
  results.addEventListener('change',()=>{
    const model=models.find(item=>item.id===results.value);
    if (!model) return;
    selected=model.id;
    choose(model);
  });
  render();
  return container;
}
