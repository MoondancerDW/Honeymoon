import {button,field,node} from './npc-controls.mjs';
import {raceLabels} from './pony-ability-ui.mjs';

const titles={player:'Игрок',admin:'Администратор',device:'Устройство'};
const sizeLabels={normal:'Обычный',small:'Жеребёнок',large:'Крупный',tall:'Высокий'};
const ponyTraits={
  race:{field:'ponyType',override:'raceOverride',labels:raceLabels,fallback:'earth',
    title:'Текущая раса',label:'Назначить расу',changed:'назначена раса',restored:'восстановлена раса'},
  size:{field:'size',override:'sizeOverride',labels:sizeLabels,fallback:'normal',
    title:'Текущий размер',label:'Назначить размер',changed:'назначен размер',restored:'восстановлен размер'},
};
const inviteStatus={active:'Действует',available:'Действует',pending:'Действует',used:'Использовано',
  expired:'Истекло',revoked:'Отозвано'};
const textErrors={
  admin_required:'Нужен профиль администратора.',
  access_denied:'Доступ к этому действию закрыт.',
  owner_required:'Это действие доступно владельцу.',
  invalid_invite_kind:'Выберите тип приглашения.',
  invite_profile_missing:'Профиль больше недоступен.',
  profile_not_found:'Профиль больше недоступен.',
  invite_not_found:'Приглашение больше недоступно.',
  device_not_found:'Устройство больше недоступно.',
  profile_missing:'Профиль больше недоступен.',
  profile_banned:'Доступ профиля заблокирован.',
  player_missing:'Игрок больше недоступен.',
  target_offline:'Игрок вышел из игры.',
  not_online:'Для телепорта оба игрока должны быть в игре.',
  teleport_blocked:'Рядом с игроком нет места для телепорта.',
  outside_playable_area:'Игрок за пределами доступной области.',
  player_dead:'Персонаж должен возродиться перед телепортом.',
  movement_blocked:'Сервер скорректировал позицию. Повторите действие.',
  invalid_ban_reason:'Проверьте текст причины блокировки.',
  invalid_pony_type:'Выберите расу из списка.',
  invalid_race:'Выберите расу из списка.',
  invalid_pony_size:'Выберите размер из списка.',
  invalid_night_vision:'Выберите состояние ночного зрения.',
  owner_protected:'Профиль владельца защищён от блокировки.',
  admin_target_self:'Выберите профиль другого игрока.',
};
const date=new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short'});
const stamp=value=>Number.isFinite(value)?date.format(value):'';
const nameOf=profile=>profile.profileName||profile.nickname||profile.uid;

export function createAdminUi({element,load,loadUids,post,pause,worldSettings,teleport}) {
  const toggle=element('admin-toggle'),dialog=element('admin-menu'),body=element('admin-body'),status=element('admin-status');
  const networkReport=element('admin-network-report');
  networkReport.addEventListener('click',()=>window.open('/api/admin/network-diagnostics?hours=6','_blank','noopener'));
  const tabs=[...dialog.querySelectorAll('[data-admin-tab]')];
  const identity=element('game');
  let data,access,busy=false,tab='profiles',freshLink,searchText='',banTarget;
  let worldWeather;
  let uidRows,uidSearch='';
  const activeTab=()=>tabs.forEach(control=>control.setAttribute('aria-pressed',String(control.dataset.adminTab===tab)));

  function tell(message='',error=false) {
    status.textContent=message;
    status.hidden=!message;
    status.classList.toggle('admin-error',error);
  }

  function setAccess(value) {
    access=value;
    if (access?.singlePlayer) tab='world';
    for (const control of tabs) control.hidden=Boolean(access?.singlePlayer && !['profiles','world'].includes(control.dataset.adminTab));
    identity.classList.toggle('with-access',Boolean(access?.inviteRequired));
    networkReport.hidden=!(access?.ownerBootstrap && access?.owner);
    toggle.hidden=access?.role!=='admin';
    if (toggle.hidden && dialog.open) dialog.close();
  }

  async function fetchList() {
    const response=await load();
    if (!response.ok) throw new Error(textErrors[response.body?.error]??'Список профилей и приглашений недоступен.');
    data=response.body;
  }

  function section(title,...content) {
    const result=node('section','admin-section');
    result.append(node('h3',null,title),...content);
    return result;
  }

  function linkBox() {
    const box=node('div','admin-link');
    const label=field(freshLink.name,{value:freshLink.url});
    label.input.readOnly=true;
    label.input.spellcheck=false;
    const copy=button('Копировать ссылку',async()=>{
      try {
        if (!navigator.clipboard) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(label.input.value);
        tell('Ссылка скопирована.');
      } catch {
        label.input.focus();
        label.input.select();
        tell('Ссылка выделена. Скопируйте её.');
      }
    },'admin-primary');
    box.append(label.wrapper,copy);
    return box;
  }

  function createdLink(reply,person) {
    const {invite,code}=reply;
    const generated=new URL(reply.url??'/',location.origin);
    if (!reply.url) generated.hash=new URLSearchParams({invite:code}).toString();
    freshLink={id:invite?.id,url:generated.href,
      name:person?'Ссылка для профиля '+nameOf(person):'Ссылка-приглашение'};
    tell('Приглашение создано.');
  }

  async function submit(path,payload,done,refresh=true) {
    if (busy) return;
    busy=true;
    dialog.setAttribute('aria-busy','true');
    tell();
    const controls=[...body.querySelectorAll('button,input,select')].filter(control=>!control.disabled);
    for (const control of controls) control.disabled=true;
    try {
      const response=await post(path,payload);
      if (!response.ok) {
        tell(textErrors[response.body.error]??'Действие сейчас недоступно.',true);
        return;
      }
      await done?.(response.body);
      if (refresh) await fetchList();
      if (dialog.open) render();
    } catch(error) {tell(error.message||'Связь с сервером прервана.',true);}
    finally {
      busy=false;
      dialog.setAttribute('aria-busy','false');
      for (const control of controls) control.disabled=false;
    }
  }

  function deviceLine(device,manageable) {
    const summary=node('div','admin-details');
    summary.append(node('strong',null,device.label||'Браузер'),
      node('small',null,[device.current?'Этот браузер':'',device.revokedAt?'Отозвано '+stamp(device.revokedAt):
        device.lastSeen?'Последний вход '+stamp(device.lastSeen):''].filter(Boolean).join(' · ')));
    const row=node('div','admin-device');
    row.dataset.deviceId=device.id;
    row.append(summary);
    if (manageable && !device.revokedAt) row.append(button('Отозвать доступ',()=>{
      if (!window.confirm(device.current?'Отозвать доступ этого браузера?':'Отозвать доступ этого устройства?')) return;
      void submit('admin/devices/revoke',{id:device.id},()=>{
        tell('Доступ устройства отозван.');
        if (device.current) location.reload();
      },!device.current);
    }));
    return row;
  }

  function profileActions(person,manageable) {
    const actions=node('div','admin-actions');
    const other=person.uid!==access.uid;
    if (other && person.online && !person.ban) {
      actions.append(button('Телепортироваться к игроку',()=>teleportProfile(person,'to')));
      if (manageable) actions.append(button('Телепортировать игрока к себе',()=>teleportProfile(person,'bring')));
    }
    if (other && manageable && !person.owner) {
      const label=person.ban?'Снять бан':'Забанить';
      actions.append(button(label,()=>{
        if (person.ban) {
          void submit('admin/profiles/unban',{uid:person.uid},()=>tell('Блокировка снята.'));
        } else {
          banTarget=person.uid;
          render();
          body.querySelector('input[name="ban-reason"]')?.focus();
        }
      },person.ban?'':'admin-danger'));
    }
    return actions;
  }

  function teleportProfile(person,direction) {
    void submit('admin/teleport',{target:person.uid,direction},async reply=>{
      if (direction==='to') {
        dialog.close();
        await teleport(reply.teleport);
      } else tell('Игрок перенесён к вам.');
    },false);
  }

  function banForm(person) {
    const form=node('form','admin-ban-form');
    const reason=field('Причина блокировки (необязательно)',{maxLength:240});
    reason.input.name='ban-reason';
    const actions=node('div','admin-actions');
    const confirm=button('Подтвердить бан',undefined,'admin-danger');
    confirm.type='submit';
    actions.append(confirm,button('Отмена',()=>{banTarget=undefined;render();}));
    form.append(reason.wrapper,actions);
    form.addEventListener('submit',event=>{
      event.preventDefault();
      const message=reason.input.value.trim();
      void submit('admin/profiles/ban',{uid:person.uid,...(message&&{reason:message})},()=>{
        banTarget=undefined;
        tell('Профиль заблокирован.');
      });
    });
    return form;
  }

  function ponyTraitForm(person,key,trait) {
    const form=node('form','admin-pony-trait-form');
    const selected=person[trait.override]??'';
    const apply=button('Применить');
    apply.type='submit';
    apply.dataset[key+'Apply']='';
    apply.disabled=true;
    const choice=field(trait.label,{choices:[['','По скину'],...Object.entries(trait.labels)],value:selected,
      changed:value=>{apply.disabled=value===selected;}});
    choice.input.name='pony-'+key;
    form.append(choice.wrapper,apply);
    form.addEventListener('submit',event=>{
      event.preventDefault();
      const value=choice.input.value;
      if (value===selected) return;
      void submit('admin/profiles/'+key,{uid:person.uid,[trait.field]:value||null},()=>{
        tell(value ? `Для ${nameOf(person)} ${trait.changed} «${trait.labels[value]}».` :
          `Для ${nameOf(person)} ${trait.restored} по скину.`);
      });
    });
    return form;
  }

  function nightVisionControls(person) {
    const group=node('div','admin-night-vision');
    group.setAttribute('role','group');
    group.setAttribute('aria-label',`Ночное зрение · ${nameOf(person)}`);
    const state=node('small',null,person.nightVision===true ? 'Включено' :
      person.nightVision===false ? 'Выключено' : 'Состояние неизвестно');
    state.dataset.currentNightVision='';
    const caption=node('div','admin-vision-state');
    caption.append(node('span',null,'Ночное зрение'),state);
    const actions=node('div','admin-actions');
    for (const [enabled,label] of [[true,'Включить'],[false,'Выключить']]) {
      const control=button(label,()=>void submit('admin/profiles/night-vision',{uid:person.uid,enabled},()=>{
        tell(`Ночное зрение для ${nameOf(person)} ${enabled?'включено':'выключено'}.`);
      }));
      control.dataset.nightVision=enabled?'on':'off';
      actions.append(control);
    }
    group.append(caption,actions);
    return group;
  }

  function profileCard(person) {
    const row=node('article','admin-record');
    row.dataset.profileUid=person.uid;
    const header=node('div','admin-summary');
    const information=node('div','admin-details');
    const short=person.uid.slice(0,8);
    const manageable=access.owner || person.uid===access.uid || person.role==='player';
    const identification=[person.owner?'Владелец':titles[person.role],
      person.ban?'Заблокирован':person.online?'В сети':'Не в сети',short].filter(Boolean);
    information.append(node('strong',null,nameOf(person)),node('small',null,identification.join(' · ')));
    if (person.nickname && person.nickname!==nameOf(person)) information.append(node('small',null,'Ник в игре · '+person.nickname));
    for (const [key,trait] of Object.entries(ponyTraits)) {
      const label=trait.labels[person[trait.field]]??trait.labels[trait.fallback];
      const source=person[trait.override]?'назначение администратора':'по скину';
      const current=node('small',null,`${trait.title} · ${label} · ${source}`);
      current.setAttribute('data-current-'+key,'');
      information.append(current);
    }
    header.append(information);
    if (!access.singlePlayer && manageable && !person.ban) header.append(button('Привязать устройство',
      ()=>void submit('admin/invites',{kind:'device',profileUid:person.uid},reply=>createdLink(reply,person))));
    row.append(header);
    for (const [key,trait] of Object.entries(ponyTraits)) row.append(ponyTraitForm(person,key,trait));
    row.append(nightVisionControls(person));
    if (access.singlePlayer) return row;
    if (person.ban?.reason) row.append(node('small','admin-error','Причина блокировки · '+person.ban.reason));
    const actions=profileActions(person,manageable);
    if (actions.childElementCount) row.append(actions);
    if (banTarget===person.uid) row.append(banForm(person));
    const devices=person.devices??[];
    if (devices.length) {
      const details=node('details');
      details.append(node('summary',null,'Устройства · '+devices.filter(device=>!device.revokedAt).length));
      details.append(...devices.map(device=>deviceLine(device,manageable)));
      row.append(details);
    }
    return row;
  }

  function profiles() {
    if (access.singlePlayer) {
      const self=data?.profiles.find(person=>person.uid===access.uid);
      return section('Профиль игрока',self ? profileCard(self) : node('p','admin-subtle','Профиль не найден.'));
    }
    const active=section('Профили игроков');
    const search=field('Найти профиль',{type:'search',value:searchText,placeholder:'Имя, ник или UID'});
    const list=node('div','admin-cards');
    function filter() {
      searchText=search.input.value;
      const value=searchText.trim().toLocaleLowerCase('ru');
      const people=(data?.profiles??[]).filter(person=>!value ||
        [person.profileName,person.nickname,person.uid].join(' ').toLocaleLowerCase('ru').includes(value));
      list.replaceChildren(...people.map(profileCard));
      if (!people.length) list.append(node('p','admin-subtle','Профили не найдены.'));
    }
    search.input.addEventListener('input',filter);
    filter();
    active.append(search.wrapper,list);
    return active;
  }

  function inviteCard(invitation) {
    const target=data.profiles.find(profile=>profile.uid===invitation.profileUid);
    const header=node('div','admin-details');
    const title=invitation.label||(target?'Устройство профиля '+nameOf(target):titles[invitation.kind]);
    const meta=[inviteStatus[invitation.status]??invitation.status,
      invitation.expiresAt?'до '+stamp(invitation.expiresAt):''].filter(Boolean);
    header.append(node('strong',null,title),node('small',null,meta.join(' · ')));
    const row=node('article','admin-record');
    row.dataset.inviteId=invitation.id;
    const actions=node('div','admin-summary');
    actions.append(header);
    if ((access.owner || invitation.role!=='admin') && ['active','available','pending'].includes(invitation.status)) actions.append(button('Отозвать приглашение',
      ()=>void submit('admin/invites/revoke',{id:invitation.id},()=>{
        tell('Приглашение отозвано.');
        if (freshLink?.id===invitation.id) freshLink=undefined;
      })));
    row.append(actions);
    return row;
  }

  function invitations() {
    const panel=section('Приглашения');
    const buttons=node('div','admin-actions');
    buttons.append(button('Пригласить игрока',()=>void submit('admin/invites',{kind:'player'},createdLink),'admin-primary'));
    if (access.owner) buttons.append(button('Пригласить администратора',()=>void submit('admin/invites',{kind:'admin'},createdLink)));
    panel.append(buttons);
    const records=data?.invites??[];
    if (records.length) panel.append(...records.map(inviteCard));
    else panel.append(node('p','admin-subtle','Приглашений пока нет.'));
    return panel;
  }

  function uidDirectory() {
    if (!uidRows) return section('UID игроков',node('p','admin-subtle','Загружаем UID…'));
    const search=field('Поиск по имени или UID',{type:'search',value:uidSearch});
    const list=node('div','admin-uid-list'), summary=node('small','admin-subtle');
    const previous=button('Назад',()=>{page--; draw();});
    const next=button('Дальше',()=>{page++; draw();});
    const pages=node('div','admin-actions');
    pages.append(previous,summary,next);
    let page=0;
    const pageSize=40;
    function draw() {
      const needle=uidSearch.normalize('NFKC').trim().toLowerCase();
      const rows=uidRows.filter(row=>!needle||row.uid.toLowerCase().includes(needle)||
        row.names.some(name=>name.normalize('NFKC').toLowerCase().includes(needle)));
      const start=page*pageSize;
      const visible=rows.slice(start,start+pageSize);
      summary.textContent=rows.length ? `${start+1}–${start+visible.length} из ${rows.length}` : '0';
      previous.disabled=page===0;
      next.disabled=start+pageSize>=rows.length;
      list.replaceChildren(...visible.map(row=>{
        const entry=node('div','admin-uid-entry');
        const origin=row.source==='original' ? (row.claimed?'Из мира · привязан':'Из мира · свободен') : 'Профиль Lilium Moonlight';
        entry.append(node('strong',null,row.names.join(', ')||'Профиль без имени'),node('code',null,row.uid),
          node('small','admin-subtle',origin));
        return entry;
      }));
      if (!rows.length) list.append(node('p','admin-subtle','UID по этому запросу не найдены.'));
    }
    search.input.addEventListener('input',()=>{uidSearch=search.input.value; page=0; draw();});
    draw();
    return section('UID игроков',search.wrapper,pages,list);
  }

  async function refreshUids() {
    uidRows=undefined;
    render();
    try {
      const response=await loadUids();
      if (!response.ok) throw new Error(textErrors[response.body?.error]??'Список UID недоступен.');
      uidRows=response.body.rows;
      if (dialog.open&&tab==='uids') render();
    } catch (error) {
      if (dialog.open&&tab==='uids') {
        body.replaceChildren();
        tell(error.message||'Список UID недоступен.',true);
      }
    }
  }

  function world() {
    const values=worldSettings();
    const shortcuts=node('div','admin-actions');
    for (const [label,key] of [['Игровые режимы','modes'],['Время','clock'],['Редактор NPC','npcs']]) {
      const shortcut=button(label,()=>{
        dialog.close();
        values.open(key);
      });
      shortcuts.append(shortcut);
    }
    const weather=field('Погода',{choices:[['clear','Ясно'],['cloudy','Облачно'],['rain','Дождь'],['snow','Снег']],
      value:values.weather,changed:mode=>void submit('weather',{mode},reply=>{
        values.weatherChanged(reply);
        tell('Погода обновлена.');
      },false)});
    worldWeather=weather.input;
    const clearDrop=button('Очистить весь дроп на карте',()=>void submit('admin/dropped-items/clear',{},({removed})=>{
      tell(removed ? 'Выпавшие предметы убраны с карты.' : 'Выпавших предметов на карте нет.');
    },false),'admin-danger');
    shortcuts.append(clearDrop);
    return section('Мир',shortcuts,weather.wrapper);
  }

  function render() {
    activeTab();
    worldWeather=undefined;
    if (!data&&tab!=='world'&&tab!=='uids') return;
    const page=tab==='profiles'?profiles():tab==='invites'?invitations():tab==='uids'?uidDirectory():world();
    const inviteVisible=freshLink&&(tab==='profiles'||tab==='invites');
    body.replaceChildren(...(inviteVisible?[linkBox(),page]:[page]));
  }

  toggle.addEventListener('click',async()=>{
    if (access?.role!=='admin'||dialog.open) return;
    dialog.showModal();
    pause();
    tell();
    if (access.singlePlayer && tab==='world') { data=undefined; render(); return; }
    if (tab==='uids') {
      await refreshUids();
      return;
    }
    body.replaceChildren(node('p','admin-subtle','Загружаем профили…'));
    try {await fetchList(); if (dialog.open) render();}
    catch(error) {body.replaceChildren(); tell(error.message,true);}
  });
  element('admin-close').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{freshLink=undefined;banTarget=undefined;});
  for (const control of tabs) control.addEventListener('click',()=>{
    tab=control.dataset.adminTab;
    tell();
    if (tab==='uids') void refreshUids();
    else if (!data&&tab!=='world') {
      void fetchList().then(()=>{if(dialog.open) render();}).catch(error=>tell(error.message,true));
    } else render();
  });
  return {setAccess,isOpen:()=>dialog.open,weatherChanged(mode) {
    if (worldWeather) worldWeather.value=mode;
  }};
}
