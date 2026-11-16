import {block,button,caption,field,node,stackChip,textComponent} from './npc-controls.mjs';
import {itemPicker,modelPicker} from './npc-picker.mjs';

const tabs=[
  ['identity','Основное'],['appearance','Модель'],['movement','Движение'],['npcActions','Роль и реплики'],
  ['dialogs','Диалоги'],['quests','Задания'],['settings','Каталоги'],['other','Бой'],
];
const roles=[['none','Нет роли'],['trader','Торговец'],['follower','Спутник'],['bank','Банкир'],['transport','Перевозчик']];
const jobs=[['none','Нет занятия'],['bard','Бард'],['healer','Целитель'],['guard','Страж'],['itemGiver','Выдаёт предметы']];
const animations=[['idle','Стоит'],['walk','Ходьба'],['sit','Сидит'],['crawl','Ползёт'],
  ['sneak','Пригибается'],['dance','Танцует']];
const movements=[['stationary','На месте'],['wander','Ходит поблизости'],['route','Следует по точкам']];
const optionTypes=[['dialog','К диалогу'],['close','Закрывает разговор'],['role','Открывает услуги NPC'],
  ['command','Действие сценария'],['disabled','Недоступно']];
const questTypes=[['item','Принести предметы'],['dialog','Поговорить'],['kill','Победить цель']];
const point=()=>({x:0,y:64,z:0});
const copy=structuredClone;
const textArray=value=>String(value??'').split(/\r?\n/).map(row=>row.trim()).filter(Boolean);
const numberArray=value=>value.split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
const assign=(data,key)=>next=>{data[key]=next;};
const settings=[
  ['transport','Перевозки','Новая точка'],['factions','Фракции','Новая фракция'],
  ['recipes','Рецепты','Новый рецепт'],['banks','Банки','Новый банк'],
];
const globalTabs=['dialogs','quests','settings'];

export function createNpcEditor({content,edit,position,preview,clearPreview,loadModels,loadCatalog,drawItem,entryFor,status}) {
  let data,draft,tab='identity',definitionId,sharedId,subview,models,modelRequest;
  let skins=[];
  let collectionName='transport';
  let filter='',filterShared='';

  function modelCatalog() {
    if (!modelRequest) modelRequest=Promise.resolve(loadModels()).then(manifest=>{
      skins=manifest.textures??[];
      models=manifest.catalog;
      return models;
    })
      .catch(()=>{modelRequest=null; return [];});
    return modelRequest;
  }

  function take(definition) {
    draft=copy(definition);
    definitionId=draft.id;
    draft.position??=point();
    draft.movement??={mode:'stationary',speed:1,range:6,route:[]};
    draft.dialogIds??=[];
    draft.trades??=[];
    draft.transport??=[];
    draft.lines??={};
  }

  function newNpc() {
    take({name:'Новый NPC',title:'',position:{...position()},yaw:0,model:'npcpony',scale:1,showName:true,
      animation:'idle',health:20,role:'none',job:'none'});
    tab='identity';
    subview=null;
    render();
  }

  function setData(next) {
    if (!Array.isArray(next?.definitions)) return;
    data=next;
    if (definitionId!=null && ['save','remove','clone'].includes(next.changedAction)) {
      const row=data.definitions.find(definition=>definition.id===definitionId);
      if (row) take(row);
      else draft=undefined;
    }
    subview=null;
    render();
  }

  function pickItem(choose) {
    subview=itemPicker({loadCatalog,drawItem,choose(item) {choose(item); subview=null; render();},
      cancel(){subview=null; render();}});
    render();
  }

  function stackSelect(stack,update,label) {
    const row=node('div','npc-stack-edit');
    const pick=button('',()=>pickItem(value=>update({...value,count:stack?.count??1})),'npc-item-card');
    pick.setAttribute('aria-label',label);
    pick.append(stack?stackChip(stack,{entryFor,drawItem}):node('span',null,'Выбрать предмет'));
    row.append(pick);
    if (stack) {
      row.append(field('Количество',{type:'number',min:1,max:64,step:1,value:stack.count??1,changed:assign(stack,'count')}).wrapper);
      row.append(button('Очистить',()=>{update(null); render();}));
    }
    return row;
  }

  function stackList(label,stacks) {
    return block(label,...stacks.map((item,index)=>stackSelect(item,value=>{
      if (value) stacks[index]=value;
      else stacks.splice(index,1);
    },label+' '+(index+1))),button('Добавить предмет',()=>pickItem(item=>stacks.push(item))));
  }

  function coordinates(at) {
    const row=node('div','npc-grid npc-coordinates');
    for (const axis of ['x','y','z']) {
      row.append(field(axis.toUpperCase(),{type:'number',step:'any',value:at[axis],changed:assign(at,axis)}).wrapper);
    }
    return row;
  }

  function useCurrent(at) {
    Object.assign(at,position());
    render();
  }

  function values(object,definitions) {
    const grid=node('div','npc-grid');
    for (const [key,label,attributes={}] of definitions) {
      grid.append(field(label,{...attributes,value:object[key]??attributes.value,changed:assign(object,key)}).wrapper);
    }
    return grid;
  }

  function identity() {
    const grid=values(draft,[['name','Имя',{maxLength:64}],['title','Подпись',{maxLength:64}],
      ['health','Здоровье',{type:'number',min:1,max:10000,step:1}],['showName','Показывать имя',{type:'checkbox'}],
      ['rotation','Реакция на игрока',{choices:[['head','Поворачивает голову'],['body','Поворачивается целиком'],
        ['fixed','Сохраняет направление']],value:'head'}],['invulnerable','Неуязвим',{type:'checkbox'}]]);
    const angle=field('Поворот в градусах',{type:'number',step:'any',value:Math.round((draft.yaw??0)*180/Math.PI),
      changed:value=>{draft.yaw=value*Math.PI/180;}});
    return block('Персонаж',grid,coordinates(draft.position),angle.wrapper,
      button('Использовать мою позицию',()=>useCurrent(draft.position)));
  }

  function appearance() {
    const body=node('div','npc-appearance');
    const image=node('canvas','npc-preview');
    image.width=320;
    image.height=250;
    image.setAttribute('aria-label','Предпросмотр модели NPC');
    const controls=node('div','npc-appearance-controls');
    body.append(image,controls);
    async function frame() {
      if (!image.isConnected) {clearPreview(image); return;}
      const appearance={...draft};
      try {
        if (await preview(image,appearance)) image.dataset.model=appearance.model;
      }
      catch {status('Предпросмотр этой модели недоступен'); return;}
      setTimeout(frame,140);
    }
    const mode=field('Тип внешности',{choices:[['mob','Модель существа'],['item','Предмет']],value:draft.model==='item'?'item':'mob',
      changed:type=>{draft.model=type==='item'?'item':'npcpony'; render();}});
    controls.append(mode.wrapper);
    if (draft.model==='item') {
      controls.append(stackSelect(draft.item,value=>{draft.item=value;},'Модель предмета'));
    } else {
      const list=node('div',null,'Загружаем модели…');
      controls.append(list);
      function showModels(rows) {
        if (!list.isConnected) return;
        if (!rows?.length) {list.textContent='Каталог моделей недоступен'; return;}
        const chosen=rows.some(row=>row.id===draft.model)?rows:[{id:draft.model,label:draft.model,category:'Исходная карта'},...rows];
        list.replaceChildren(modelPicker({models:chosen,value:draft.model,choose(model){
          draft.model=model.id;
          draft.texture=model.defaultTexture??'';
          texture.input.value=draft.texture;
          findTextures();
        }}));
        findTextures();
      }
      const texture=field('Текстура',{value:draft.texture,placeholder:'Текстура модели по умолчанию',
        changed:value=>{draft.texture=value; findTextures();}});
      const textures=node('datalist');
      textures.id='npc-texture-list';
      texture.input.setAttribute('list',textures.id);
      function findTextures() {
        const query=caption(texture.input.value);
        const slash=query.lastIndexOf('/');
        const prefix=slash>=0?query.slice(0,slash+1):'';
        const matching=skins.filter(path=>caption(path).includes(query));
        const nearby=matching.length>1?matching:skins.filter(path=>caption(path).includes(prefix));
        const suggestions=nearby.slice(0,150).map(path=>{
          const option=node('option');
          option.value=path;
          return option;
        });
        textures.replaceChildren(...suggestions);
      }
      controls.append(texture.wrapper,textures,field('Плащ',{value:draft.cloak,changed:assign(draft,'cloak')}).wrapper);
      if (models) queueMicrotask(()=>showModels(models));
      else void modelCatalog().then(showModels);
    }
    const properties=[['scale','Размер',{type:'number',min:.2,max:6,step:'any',value:1}],
      ['animation','Поза или анимация',{choices:animations,value:'idle'}]];
    for (const [key,title,attrs] of properties) {
      controls.append(field(title,{...attrs,value:draft[key]??attrs.value,changed:assign(draft,key)}).wrapper);
    }
    queueMicrotask(frame);
    return block('Модель и текстура',body);
  }

  function movement() {
    const value=draft.movement;
    const grid=values(value,[['mode','Режим',{choices:movements,value:'stationary'}],
      ['speed','Скорость',{type:'number',step:'any',min:.1,max:20,value:1}],
      ['range','Радиус прогулки',{type:'number',step:'any',min:0,max:128,value:6}],
      ['wait','Остановка у точки, секунды',{type:'number',min:0,max:120,step:'any',value:0}],
      ['loop','Повторять маршрут',{type:'checkbox',value:true}]]);
    const route=value.route??=[];
    const points=route.map((at,index)=>{
      const row=node('div','npc-record');
      const actions=node('div','npc-actions');
      const move=offset=>{
        const swap=index+offset;
        [route[index],route[swap]]=[route[swap],route[index]];
        render();
      };
      const up=button('Выше',()=>move(-1));
      const down=button('Ниже',()=>move(1));
      up.disabled=index===0;
      down.disabled=index===route.length-1;
      actions.append(up,down,button('Моя позиция',()=>useCurrent(at)),
        button('Удалить точку',()=>{route.splice(index,1); render();}));
      row.append(node('strong',null,'Точка '+(index+1)),coordinates(at),actions);
      return row;
    });
    return block('Движение',grid,...points,
      button('Добавить точку маршрута',()=>{route.push({...position()}); value.mode='route'; render();}));
  }

  function npcActions() {
    const general=values(draft,[['role','Роль',{choices:roles,value:'none'}],['job','Занятие',{choices:jobs,value:'none'}]]);
    const faction=field('Фракция',{choices:[['0','Без фракции'],...(data.shared?.factions??[]).map(row=>[row.id,row.name])],
      value:draft.factionId??0,changed:value=>{draft.factionId=Number(value);}});
    const bank=field('Банк',{choices:[['0','Не назначен'],...(data.shared?.banks??[]).map(row=>[row.id,row.name])],
      value:draft.bankId??0,changed:value=>{draft.bankId=Number(value);}});
    const station=field('Станция',{choices:[['-1','Из списка NPC'],...(data.shared?.transport??[]).map(row=>[row.id,row.name])],
      value:draft.transporterId??-1,changed:value=>{draft.transporterId=Number(value);}});
    general.append(faction.wrapper,bank.wrapper,station.wrapper);
    const bindings=node('fieldset','npc-bindings');
    bindings.append(node('legend',null,'Диалоги персонажа'));
    const all=data.shared?.dialogs??[];
    if (!all.length) bindings.append(node('p',null,'Сначала создайте диалог во вкладке «Диалоги».'));
    for (const dialog of all) {
      bindings.append(field((dialog.title||'Без названия')+' · '+dialog.id,{type:'checkbox',
        value:draft.dialogIds.includes(dialog.id),changed:chosen=>{
          if (chosen) draft.dialogIds.push(dialog.id);
          else draft.dialogIds=draft.dialogIds.filter(id=>id!==dialog.id);
        }}).wrapper);
    }
    const speech=node('div','npc-grid');
    for (const [key,label] of [['interact','При разговоре'],['world','В мире'],['attack','При нападении'],['kill','После победы']]) {
      speech.append(field(label,{type:'textarea',value:(draft.lines[key]??[]).join('\n'),
        changed:value=>{draft.lines[key]=textArray(value);}}).wrapper);
    }
    const tradeRows=draft.trades.map((trade,index)=>block('Сделка '+(index+1),
      stackSelect(trade.reward,value=>{trade.reward=value;},'Товар '+(index+1)),
      stackList('Оплата',trade.costs??=[]),
      button('Удалить сделку',()=>{draft.trades.splice(index,1); render();})));
    const destinations=draft.transport.map((place,index)=>block('Назначение '+(index+1),
      field('Название',{value:place.name,changed:assign(place,'name')}).wrapper,coordinates(place.position??=point()),
      button('Моя позиция',()=>useCurrent(place.position)),
      button('Удалить назначение',()=>{draft.transport.splice(index,1); render();})));
    const wrapper=node('div','npc-sections');
    wrapper.append(block('Поведение',general,bindings),block('Реплики',speech),
      block('Торговля',...tradeRows,button('Добавить сделку',()=>{
        draft.role='trader';
        draft.trades.push({costs:[],reward:null});
        render();
      })),
      block('Перевозки',...destinations,button('Добавить назначение',()=>{
        draft.role='transport';
        draft.transport.push({name:'Новая точка',position:{...position()}});
        render();
      })));
    const equipment=draft.equipment??=(Array(4).fill(null));
    const armor=['Голова','Туловище','Ноги','Копыта'].map((label,index)=>
      block(label,stackSelect(equipment[index],value=>{equipment[index]=value;},label)));
    const held=stackSelect(draft.held?.key?{key:draft.held.key,count:1}:null,value=>{
      draft.held=value&&{kind:'item',key:value.key};
    },'Предмет в руке');
    wrapper.append(block('Экипировка',...armor,block('Предмет в руке',held)));
    const job=draft.jobData??={};
    if (draft.job==='bard') {
      const songs=data.sounds??[];
      const options=[['','Без записи'],...songs.map(name=>[name,name])];
      if (job.song&&!songs.includes(job.song)) options.push([job.song,job.song+' · файл отсутствует']);
      wrapper.append(block('Музыка барда',values(job,[
      ['song','Файл музыки',{choices:options,value:''}],['instrument','Инструмент',{type:'number',min:0,max:4,step:1,value:0}],
      ['minRange','Ближняя дистанция',{type:'number',min:0,max:64,step:'any',value:3}],
      ['maxRange','Дальность',{type:'number',min:1,max:96,step:'any',value:16}],
      ['streamer','Стримить аудиозапись',{type:'checkbox'}]])));
    }
    if (draft.job==='guard') wrapper.append(block('Страж',values(job,[
      ['guardRange','Радиус охраны',{type:'number',min:1,max:96,step:'any',value:16}]])));
    if (draft.job==='itemGiver') {
      wrapper.append(block('Выдача предметов',stackList('Предметы',job.items??=[]),values(job,[
        ['givingMethod','Правило выдачи',{type:'number',min:0,max:4,step:1,value:0}],
        ['cooldownType','Правило повтора',{type:'number',min:0,max:2,step:1,value:0}],
        ['cooldown','Интервал, секунды',{type:'number',min:0,max:86400,step:1,value:10}]]),
      field('Реплики при выдаче',{type:'textarea',value:(job.lines??[]).join('\n'),changed:value=>{job.lines=textArray(value);}}).wrapper));
    }
    return wrapper;
  }

  function jsonField(label,value) {
    const input=field(label,{type:'textarea',value:JSON.stringify(value??{},null,2)});
    input.input.classList.add('npc-json-field');
    input.input.spellcheck=false;
    return input;
  }

  function advanced() {
    const groups=node('div','npc-sections');
    const combat=draft.combat??={};
    const combatSettings=values(combat,[
      ['behavior','Реакция на удар',{choices:[['fight','Сражается'],['retreat','Отступает'],['ignore','Игнорирует']],value:'fight'}],
      ['damage','Урон',{type:'number',min:0,max:100,step:1,value:5}],
      ['range','Дальность атаки',{type:'number',min:1,max:32,step:'any',value:2}],
      ['speed','Скорость в бою',{type:'number',min:.1,max:12,step:'any',value:1.8}],
      ['interval','Интервал атак, миллисекунды',{type:'number',min:150,max:12000,step:1,value:900}],
      ['respawn','Возрождение, секунды',{type:'number',min:0,max:3600,step:1,value:20}],
      ['experience','Опыт за победу',{type:'number',min:0,max:100000,step:1,value:0}],
      ['hideWhenKilled','Скрывать после гибели',{type:'checkbox'}],['hostile','Первым атакует игроков',{type:'checkbox'}],
      ['guard','Охраняет местность',{type:'checkbox'}],['attackOtherFactions','Сражается с враждебными фракциями',{type:'checkbox'}],
    ]);
    const drops=combat.drops??=[];
    const loot=drops.map((drop,index)=>block('Предмет '+(index+1),stackSelect(drop.stack,value=>{
      if (value) drop.stack=value;
      else drops.splice(index,1);
    },'Модель предмета'),field('Шанс, %',{type:'number',min:0,max:100,step:'any',value:drop.chance,changed:assign(drop,'chance')}).wrapper));
    groups.append(block('Бой',combatSettings),block('Трофеи',...loot,
      button('Добавить трофей',()=>pickItem(item=>drops.push({stack:item,chance:100})))));
    const native=jsonField('Данные совместимости Minecraft',draft.native);
    native.input.readOnly=true;
    const source=node('details','npc-section');
    source.append(node('summary',null,'Параметры исходного мода'),native.wrapper);
    if (draft.native) groups.append(source);
    return groups;
  }

  function sharedFields(collection,record) {
    if (settings.some(([key])=>key===collection)) return globalFields(collection,record);
    const general=values(record,[['title','Название'],['category','Категория'],
      ['text','Текст',{type:'textarea'}]]);
    if (collection==='dialogs') {
      const options=record.options??=[];
      const enabled=[['','Выберите диалог'],...(data.shared?.dialogs??[]).map(item=>[item.id,item.title||String(item.id)])];
      const edits=options.map((option,index)=>block('Ответ '+(index+1),values(option,[
        ['title','Текст ответа'],['type','Действие',{choices:optionTypes,value:'dialog'}]]),
      field('Цвет',{type:'color',value:'#'+(Number.isInteger(option.color)?option.color:0xe0e0e0).toString(16).padStart(6,'0'),
        changed:value=>{option.color=Number.parseInt(value.slice(1),16);}}).wrapper,
      field('Следующий диалог',{choices:enabled,value:option.dialogId??'',changed:value=>{option.dialogId=value?Number(value):undefined;}}).wrapper,
      field('Команда сценария',{value:option.command,changed:assign(option,'command')}).wrapper,
      button('Удалить ответ',()=>{options.splice(index,1); render();})));
      const quest=field('Привязанное задание',{choices:[['','Без задания'],...(data.shared?.quests??[]).map(item=>[item.id,item.title])],
        value:record.questId??'',changed:value=>{record.questId=value?Number(value):undefined;}});
      return block('Диалог',general,quest.wrapper,availability(record),...edits,
        button('Добавить ответ',()=>{options.push({title:'',type:'close'}); render();}));
    }
    const attributes=values(record,[['type','Тип',{choices:questTypes,value:'item'}],['completer','Кто принимает'],
      ['completion','Завершение',{choices:[['npc','У NPC'],['instant','Сразу']],value:'npc'}],
      ['repeat','Повтор',{choices:[['once','Один раз'],['repeat','Неограниченно'],['daily','Ежедневно'],['weekly','Еженедельно']],value:'once'}],
      ['experience','Опыт',{type:'number',min:0,max:100000,step:1,value:0}],
      ['completeText','Текст завершения',{type:'textarea'}]]);
    const talks=field('ID диалогов для задания',{value:(record.dialogs??[]).join(', '),changed:value=>{record.dialogs=numberArray(value);}});
    const kills=record.kills??=[];
    const targets=kills.map((target,index)=>block('Цель '+(index+1),
      values(target,[['name','Имя цели'],['count','Количество',{type:'number',min:1,step:1}]]),
      button('Удалить цель',()=>{kills.splice(index,1); render();})));
    return block('Задание',general,attributes,talks.wrapper,stackList('Нужные предметы',record.items??=[]),
      stackList('Награды',record.rewards??=[]),...targets,
      button('Добавить цель',()=>{kills.push({name:'',count:1}); render();}));
  }

  function globalFields(collection,record) {
    const name=field('Название',{value:record.name,changed:assign(record,'name')}).wrapper;
    if (collection==='transport') {
      const positionRecord=record.position??=point();
      return block('Точка перевозки',name,coordinates(positionRecord),
        button('Использовать мою позицию',()=>useCurrent(positionRecord)),
        values(record,[['category','Номер линии',{type:'number',min:0,step:1,value:0}],['categoryName','Название линии'],
          ['type','Доступность',{choices:[['1','Всем игрокам'],['0','После открытия'],['2','После открытия по условию']],value:'1'}]]));
    }
    if (collection==='factions') {
      const rivals=field('ID враждебных фракций',{value:(record.attackFactions??[]).join(', '),
        changed:value=>{record.attackFactions=numberArray(value);}});
      const color=field('Цвет',{type:'color',value:'#'+(record.color??0xffffff).toString(16).padStart(6,'0'),
        changed:value=>{record.color=Number.parseInt(value.slice(1),16);}});
      return block('Фракция',name,color.wrapper,rivals.wrapper,values(record,[['attackPlayers','Нападает на игроков',{type:'checkbox'}],
        ['canBeAttacked','Может подвергнуться нападению',{type:'checkbox'}],
        ['helpEachOther','Участники помогают друг другу',{type:'checkbox'}]]));
    }
    if (collection==='recipes') {
      return block('Рецепт',name,values(record,[['global','Общий рецепт',{type:'checkbox'}],
        ['width','Ширина',{type:'number',min:1,max:3,step:1,value:1}],
        ['height','Высота',{type:'number',min:1,max:3,step:1,value:1}]]),availability(record),
      stackList('Ингредиенты',record.items??=[]),block('Результат',stackSelect(record.result,value=>{record.result=value;},'Результат')));
    }
    return block('Банк',name,values(record,[['start','Начальное количество рядов',{type:'number',min:1,max:64,step:1,value:1}],
      ['max','Максимальное количество рядов',{type:'number',min:1,max:64,step:1,value:6}]]),
    stackList('Стоимость открытия',record.cost??=[]),stackList('Стоимость расширения',record.upgrade??=[]));
  }

  function availability(record) {
    const value=record.availability??={};
    const day=field('Время суток',{choices:[['always','Любое'],['day','День'],['night','Ночь']],
      value:value.day??'always',changed:assign(value,'day')});
    const groups=[['dialogs','Условие диалога'],['quests','Условие задания']].map(([key,label])=>{
      const list=value[key]??=[];
      const choices=[['after','После завершения'],['before','До завершения']];
      if (key==='quests') choices.push(['active','Во время выполнения'],['inactive','Вне выполнения']);
      return block(label,...list.map((condition,index)=>block(label+' '+(index+1),values(condition,
        [['id','ID записи',{type:'number',min:0,step:1}],['rule','Состояние',{choices,value:'after'}]]),
      button('Удалить условие',()=>{list.splice(index,1); render();}))),
      button('Добавить условие',()=>{list.push({id:0,rule:'after'}); render();}));
    });
    return block('Доступность',day.wrapper,...groups);
  }

  let sharedDraft;
  function sharedContent(collection) {
    const list=data.shared?.[collection]??[];
    const names=settings.find(([key])=>key===collection)?.slice(1) ??
      (collection==='dialogs'?['Диалоги карты','Новый диалог']:['Задания карты','Новое задание']);
    const search=field('Поиск по названию или ID',{type:'search',value:filterShared});
    const results=node('select','npc-shared-list');
    results.setAttribute('aria-label',names[0]);
    function populate() {
      const key=caption(search.input.value);
      filterShared=search.input.value;
      results.replaceChildren();
      const empty=node('option',null,'Выберите запись');
      empty.value='';
      results.append(empty);
      for (const record of list) {
        if (key && !caption([record.title,record.name,record.id,record.category].join(' ')).includes(key)) continue;
        const option=node('option',null,(record.title||record.name||'Без названия')+' · '+record.id);
        option.value=record.id;
        option.selected=record.id===sharedId;
        results.append(option);
      }
    }
    search.input.addEventListener('input',populate);
    results.addEventListener('change',()=>{
      const found=list.find(record=>String(record.id)===results.value);
      sharedId=found?.id;
      sharedDraft=found&&copy(found);
      render();
    });
    populate();
    const first=block(names[0],search.wrapper,results,
      button(names[1],()=>{
        sharedId=undefined;
        sharedDraft=settings.some(([key])=>key===collection)?{name:'',...(collection==='transport'&&{position:{...position()},type:1})}:
          {title:'',text:'',category:''};
        render();
      }));
    if (!sharedDraft) return first;
    const wrapper=node('div','npc-sections');
    wrapper.append(first,sharedFields(collection,sharedDraft));
    const actions=node('div','npc-actions');
    actions.append(button('Сохранить запись',async()=>{
      const definition=collection==='transport'?{...sharedDraft,type:Number(sharedDraft.type)}:sharedDraft;
      const next=await edit({action:'saveShared',collection,id:sharedId,definition});
      if (next) {
        sharedDraft=undefined;
        sharedId=undefined;
        render();
      }
    },'npc-primary'));
    if (sharedId!==undefined) actions.append(button('Удалить запись',async()=>{
      if (!window.confirm('Удалить запись из общего каталога?')) return;
      if (await edit({action:'removeShared',collection,id:sharedId})) {
        sharedId=undefined;
        sharedDraft=undefined;
        render();
      }
    }));
    wrapper.append(actions);
    return wrapper;
  }

  function settingsContent() {
    const section=node('div','npc-sections');
    const navigation=node('nav','npc-tabs');
    navigation.setAttribute('aria-label','Каталоги NPC');
    for (const [key,title] of settings) {
      const choice=button(title,()=>{
        collectionName=key;
        sharedId=sharedDraft=undefined;
        filterShared='';
        render();
      });
      choice.setAttribute('aria-pressed',String(collectionName===key));
      navigation.append(choice);
    }
    section.append(navigation,sharedContent(collectionName));
    return section;
  }

  function npcList() {
    const panel=node('aside','npc-list-pane');
    const search=field('Найти NPC',{type:'search',value:filter,placeholder:'Имя, модель или ID'});
    const results=node('div','npc-editor-list');
    function populate() {
      filter=search.input.value;
      const query=caption(filter);
      const match=data.definitions.filter(row=>!query || caption([row.name,row.title,row.model,row.id].join(' ')).includes(query));
      results.replaceChildren(...match.map(definition=>{
        const chosen=button('',()=>{
          take(definition);
          if (globalTabs.includes(tab)) tab='identity';
          render();
        });
        chosen.setAttribute('aria-pressed',String(definition.id===definitionId));
        chosen.append(textComponent(definition.name),node('small',null,definition.title||definition.model));
        return chosen;
      }));
      if (!match.length) results.append(node('p',null,'NPC не найдены'));
    }
    search.input.addEventListener('input',populate);
    populate();
    panel.append(button('Создать NPC',newNpc,'npc-primary'),search.wrapper,results);
    return panel;
  }

  function render() {
    if (!data) return;
    if (subview) {content.replaceChildren(subview); return;}
    const editor=node('div','npc-editor');
    const main=node('article','npc-editor-main');
    const nav=node('nav','npc-tabs');
    nav.setAttribute('aria-label','Разделы редактора NPC');
    for (const [id,title] of tabs) {
      const entry=button(title,()=>{
        tab=id;
        sharedId=sharedDraft=undefined;
        filterShared='';
        render();
      });
      entry.setAttribute('aria-pressed',String(id===tab));
      entry.disabled=!draft && !globalTabs.includes(id);
      nav.append(entry);
    }
    main.append(nav);
    if (tab==='settings') main.append(settingsContent());
    else if (tab==='dialogs'||tab==='quests') main.append(sharedContent(tab));
    else if (draft) {
      const editors={identity,appearance,movement,npcActions,other:advanced};
      main.append(editors[tab]());
      const actions=node('footer','npc-actions npc-editor-footer');
      actions.append(button('Сохранить NPC',async()=>{
        const invalid=main.querySelector('input:invalid,select:invalid,textarea:invalid');
        if (invalid) {invalid.reportValidity(); return;}
        const next=await edit({action:'save',definition:draft});
        const saved=next?.definition ?? next?.definitions?.find(row=>row.id===definitionId) ?? (!definitionId&&next?.definitions?.at(-1));
        if (saved) take(saved);
        if (next) render();
      },'npc-primary'));
      if (definitionId!=null) {
        actions.append(button('Дублировать',async()=>{
          const next=await edit({action:'clone',npcId:definitionId});
          const cloned=next?.definition??next?.definitions?.at(-1);
          if (cloned) {take(cloned); render();}
        }));
        actions.append(button('Удалить NPC',async()=>{
          if (!window.confirm('Удалить выбранного NPC с карты?')) return;
          if (await edit({action:'remove',npcId:definitionId})) {draft=undefined; definitionId=undefined; render();}
        }));
      }
      main.append(actions);
    } else main.append(node('p','npc-empty','Выберите персонажа или создайте нового.'));
    editor.append(npcList(),main);
    content.replaceChildren(editor);
  }

  return {
    open(next,targetId) {
      data=next;
      const selected=next.definitions.find(row=>row.id===targetId);
      if (selected) take(selected);
      else {draft=undefined; definitionId=undefined;}
      tab='identity';
      subview=sharedDraft=undefined;
      filter='';
      render();
    },
    update:setData,
  };
}
