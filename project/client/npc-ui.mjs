import {block,button,field,node,stackChip,textComponent} from './npc-controls.mjs';
import {createNpcEditor} from './npc-editor.mjs';
import {npcNameVisible} from '../world/npc-editor-wand.mjs';

const errors={
  npc_editor_required:'Введите ключ администратора',
  npc_editor_disabled:'Редактор отключён на сервере',
  npc_editor_key:'Проверьте ключ администратора',
  npc_editor_rate_limit:'Слишком много попыток. Подождите минуту.',
  npc_definition_changed:'Этого NPC уже изменили. Откройте его заново.',
  invalid_npc_definition:'Проверьте имя и модель персонажа',
  invalid_npc_position:'Позиция должна находиться внутри игровой карты',
  invalid_npc_texture:'Выберите текстуру из каталога',
  invalid_npc_stack:'Проверьте предметы и их количество',
  invalid_npc_content:'Проверьте данные записи',
  npc_missing_items:'Не хватает предметов',
  npc_bank_full:'В хранилище нет места',
  npc_bank_locked:'Сначала откройте хранилище',
  npc_interaction_required:'Откройте разговор с NPC снова',
  npc_quest_unfinished:'Условия задания ещё не выполнены',
  npc_quest_unavailable:'Задание сейчас недоступно',
  npc_dialog_unavailable:'Диалог сейчас недоступен',
  npc_command_unavailable:'Действие этого ответа недоступно в браузере',
  npc_missing:'Этот NPC больше недоступен',
  npc_too_far:'Подойдите ближе к персонажу',
  npc_not_visible:'NPC закрыт препятствием',
  out_of_reach:'Подойдите ближе к персонажу',
  not_visible:'NPC закрыт препятствием',
  npc_unavailable:'Сейчас действие недоступно',
  npc_admin_required:'Введите ключ администратора',
  npc_admin_disabled:'Редактор отключён на сервере',
  invalid_npc_key:'Проверьте ключ администратора',
  invalid_admin_key:'Проверьте ключ администратора',
  missing_items:'Не хватает предметов',
  insufficient_items:'Не хватает предметов',
  invalid_npc:'Проверьте настройки персонажа',
  invalid_dialog:'Диалог недоступен',
  invalid_quest:'Задание недоступно',
  already_completed:'Задание уже выполнено',
  movement_blocked:'Сервер скорректировал позицию. Повторите действие.',
  inventory_full:'Освободите место в инвентаре',
  action_pending:'Дождитесь завершения предыдущего действия',
};
const questState={available:'Доступно',active:'В процессе',completed:'Завершено'};

export function createNpcUi(options) {
  const element=id=>document.getElementById(id);
  const dialog=element('npc-menu');
  const heading=element('npc-menu-title');
  const subtitle=element('npc-menu-subtitle');
  const statusElement=element('npc-menu-status');
  const content=element('npc-menu-content');
  const closeButton=element('npc-menu-close');
  const editorButton=element('npc-editor-toggle');
  let panel,identity,access=false,active,task,epoch=0,fromPlay,startingInteraction=false;
  const status=(message='')=>{
    statusElement.textContent=message;
    statusElement.hidden=!message;
  };
  const title=(name,detail)=>{
    heading.replaceChildren(textComponent(name));
    subtitle.replaceChildren(detail?textComponent(detail):'');
  };
  function npcTitle(npc) {
    const visible=options.nameVisible?.(npc)??npcNameVisible(npc);
    return {name:visible ? npc.name||'NPC' : 'NPC',detail:visible ? npc.title : ''};
  }
  const editor=createNpcEditor({...options,content,edit:modify,status});
  function setAccess(value) {
    const authorized=Boolean(value);
    if (authorized===access) return;
    access=authorized;
    document.dispatchEvent(new CustomEvent('npc-admin-state',{detail:{authorized}}));
  }

  function busy(value) {
    dialog.setAttribute('aria-busy',String(value));
    closeButton.disabled=value;
    for (const control of content.querySelectorAll('button')) {
      if (value && !control.disabled) {
        control.disabled=true;
        control.dataset.npcBusy='';
      }
      if (!value && 'npcBusy' in control.dataset) {
        control.disabled=false;
        delete control.dataset.npcBusy;
      }
    }
  }

  function close(resume=true,releaseConversation=true) {
    const stayPaused=!fromPlay;
    if (!dialog.open || task) return;
    const talking=panel==='interaction'?identity:undefined;
    epoch++;
    task=undefined;
    panel=identity=active=undefined;
    dialog.close();
    content.replaceChildren();
    if (talking && releaseConversation) void options.command(talking,'close').catch(()=>{});
    if (!stayPaused && resume) options.resume();
    if (stayPaused && resume && !editorButton.hidden) editorButton.focus({preventScroll:true});
  }

  function open(next,{name,detail,playing}={}) {
    const wasOpened=dialog.open;
    if (!wasOpened) {
      fromPlay=Boolean(playing);
      dialog.showModal();
      if (fromPlay) options.pause();
    }
    epoch++;
    task=undefined;
    panel=next;
    dialog.classList.toggle('npc-editor-menu',next==='editor');
    title(name,detail);
    content.replaceChildren();
    status();
    closeButton.focus({preventScroll:true});
  }

  async function run(send) {
    if (task) return null;
    const id=epoch;
    const request=Promise.resolve().then(send);
    task=request;
    status();
    busy(true);
    try {
      const result=await request;
      if (epoch!==id || task!==request) return null;
      if (result.ok) return result.body;
      status(errors[result.body?.error]??result.body?.message??'Действие сейчас недоступно');
      return null;
    } catch (error) {
      if (epoch===id) status(error.message||'Связь с сервером прервана');
      return null;
    } finally {
      if (epoch===id && task===request) {
        task=undefined;
        busy(false);
      }
    }
  }

  function actionChoice(label,type,parameters={},available=true) {
    const control=button('',()=>void act(type,parameters));
    control.append(textComponent(label));
    control.disabled=!available;
    return control;
  }

  function stackList(stacks) {
    const list=node('div','npc-stacks');
    for (const stack of stacks) list.append(stackChip(stack,options));
    return list;
  }

  async function renderConversation(response) {
    if (!response) return;
    if (response.teleport) {
      close(false,false);
      try {await options.onTeleport(response.teleport);}
      catch (error) {options.notice(error.message||'Не удалось завершить переход');}
      finally {options.resume();}
      return;
    }
    const npc=response.npc??active;
    if (npc) {
      active=npc;
      const {name,detail}=npcTitle(npc);
      title(name,detail);
    }
    const info=response.interaction;
    if (!info || info.closed) {close(true,false); return;}
    const body=node('div','npc-conversation');
    if (info.message) {
      const message=node('p','npc-speech npc-result');
      message.append(textComponent(info.message));
      body.append(message);
    }
    for (const line of Array.isArray(info.lines)?info.lines:[]) {
      const said=node('p','npc-speech');
      said.append(textComponent(line));
      body.append(said);
    }
    if (info.dialog) {
      const said=node('p','npc-speech');
      said.append(textComponent(info.dialog.text));
      const row=node('div','npc-dialog-choices');
      for (const [index,option] of (info.dialog.options??[]).entries()) {
        if (option.type==='disabled') continue;
        const reply=actionChoice(option.title,'option',{dialogId:info.dialog.id,index});
        if (/^#[\da-f]{6}$/i.test(option.color)) reply.style.color=option.color;
        else if (Number.isInteger(option.color) && option.color>=0 && option.color<=0xffffff) {
          reply.style.color='#'+option.color.toString(16).padStart(6,'0');
        }
        row.append(reply);
      }
      body.append(block(info.dialog.title||'Разговор',said,row));
    } else if (info.dialogs?.length) {
      const row=node('div','npc-dialog-choices');
      for (const entry of info.dialogs) row.append(actionChoice(entry.title,'dialog',{dialogId:entry.id}));
      body.append(block('Разговор',row));
    }
    if (info.trade?.length) {
      const shop=node('div','npc-trade-list');
      for (const [index,trade] of info.trade.entries()) {
        const card=node('div','npc-trade');
        card.append(stackList(trade.costs??[]),node('span','npc-trade-arrow','→'),stackList([trade.reward]),
          actionChoice('Обменять','trade',{index},trade.affordable!==false));
        shop.append(card);
      }
      body.append(block('Торговля',shop));
    }
    if (info.quests?.length) {
      const entries=info.quests.map(quest=>{
        const description=node('p','npc-speech');
        description.append(textComponent(quest.state==='completed'?quest.completeText||quest.text:quest.text));
        const entry=block(quest.title,description);
        if (questState[quest.state]) entry.prepend(node('small','npc-quest-state',questState[quest.state]));
        if (quest.items?.length) entry.append(stackList(quest.items));
        if (quest.rewards?.length) {
          const rewards=node('div','npc-rewards');
          rewards.append(node('strong',null,'Награда'),stackList(quest.rewards));
          entry.append(rewards);
        }
        if (quest.state==='available') entry.append(actionChoice('Принять задание','acceptQuest',{questId:quest.id}));
        if (quest.state==='active') entry.append(actionChoice('Сдать задание','completeQuest',{questId:quest.id},quest.canComplete!==false));
        return entry;
      });
      body.append(block('Задания',...entries));
    }
    if (info.transport?.length) {
      const destinations=info.transport.map((place,index)=>actionChoice(place.name,'transport',{index},place.available!==false));
      body.append(block('Путешествие',...destinations));
    }
    if (info.follower) {
      const companion=info.follower;
      body.append(block('Спутник',stackList(companion.costs??[]),
        actionChoice(companion.following?'Остаться здесь':'Пойти за мной','follow',{},companion.affordable!==false)));
    }
    if (info.bank) {
      const bank=info.bank;
      const deposits=node('div','npc-bank-slots');
      for (const [slot,stack] of (options.inventory?.()?.slots??[]).entries()) {
        if (!stack) continue;
        deposits.append(bankSlot(stack,'bankDeposit',slot));
      }
      const withdrawals=node('div','npc-bank-slots');
      for (const [slot,stack] of (bank.items??[]).entries()) {
        if (!stack) continue;
        withdrawals.append(bankSlot(stack,'bankWithdraw',slot));
      }
      const bankBody=node('div','npc-sections');
      bankBody.append(node('p',null,'Ячейки · '+(bank.capacity??0)+' из '+(bank.max??bank.capacity??0)),
        block('В хранилище',withdrawals),block('Ваш инвентарь',deposits));
      if (!bank.unlocked || bank.capacity<bank.max) {
        bankBody.append(stackList((bank.unlocked?bank.upgrade:bank.cost)??[]),
          actionChoice(bank.unlocked?'Расширить хранилище':'Открыть хранилище','bankUpgrade'));
      }
      body.append(block(bank.name||'Банк',bankBody));
    }
    if (info.jobData?.giftAvailable) body.append(actionChoice('Получить предметы','gift'));
    if (info.jobData?.healer) body.append(actionChoice('Восстановить здоровье','heal'));
    if (info.services?.length) {
      const commands=info.services.map(item=>actionChoice(item.title,item.action,item.arguments,item.available!==false));
      body.append(block('Услуги',...commands));
    }
    if (!body.childNodes.length) body.append(node('p','npc-empty','Сейчас персонажу нечего добавить.'));
    if (access) body.append(button('Редактировать NPC',()=>void startEditor(identity,fromPlay),'npc-edit-selected'));
    content.replaceChildren(body);
  }

  function bankSlot(stack,action,slot) {
    const control=button('',()=>void act(action,{slot}),'npc-item-card');
    control.append(stackChip(stack,options));
    return control;
  }

  async function act(action,parameters) {
    const id=identity;
    if (!id) return false;
    const body=await run(()=>options.command(id,action,parameters));
    if (!body) return false;
    await renderConversation(body);
    return true;
  }

  async function interact(target) {
    if (startingInteraction || dialog.open) return;
    const npc=target.entity??target;
    const id=target.id??npc.id;
    const initialEpoch=epoch;
    startingInteraction=true;
    try {
      const result=await options.command(id,'interact');
      if (!result.ok) {
        options.notice(errors[result.body?.error]??result.body?.message??'Действие сейчас недоступно');
        return;
      }
      if (!result.body.interaction || result.body.interaction.closed) return;
      if (epoch!==initialEpoch || !options.isPlaying()) {
        void options.command(id,'close').catch(()=>{});
        return;
      }
      open('interaction',{...npcTitle(result.body.npc??npc),playing:true});
      active=npc;
      identity=id;
      await renderConversation(result.body);
    } catch (error) {
      options.notice(error.message||'Связь с сервером прервана');
    } finally {
      startingInteraction=false;
    }
  }

  async function loadEditor(targetId,playing=false) {
    if (panel==='interaction' && identity) void options.command(identity,'close').catch(()=>{});
    open('editor',{name:'Редактор NPC',playing});
    content.append(node('p','npc-empty','Загружаем персонажей…'));
    const data=await run(options.loadEditor);
    if (!data && panel==='editor') {
      setAccess(false);
      content.replaceChildren(button('Ввести ключ',()=>void startEditor(targetId)));
      return;
    }
    if (!data) return;
    setAccess(true);
    editor.open(data,targetId);
  }

  async function modify(payload) {
    const next=await run(()=>options.edit(payload));
    if (!next) return null;
    const fallback=next.definitions?next:await run(options.loadEditor);
    if (!fallback) return null;
    editor.update({...fallback,changedAction:payload.action});
    status('Изменения сохранены');
    return {...fallback,definition:next.definition??fallback.definition};
  }

  async function startEditor(targetId,playing=false) {
    if (access) return loadEditor(targetId,playing);
    open('unlock',{name:'Редактор NPC',playing});
    const form=node('form','npc-unlock');
    const key=field('Ключ администратора',{type:'password',maxLength:256});
    key.input.autocomplete='off';
    key.input.required=true;
    const send=button('Открыть редактор',null,'npc-primary');
    send.type='submit';
    form.append(key.wrapper,send);
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      const value=key.input.value;
      key.input.value='';
      const next=await run(()=>options.unlock(value));
      if (!next) {key.input.focus(); return;}
      setAccess(true);
      await loadEditor(targetId);
    });
    content.append(form);
    key.input.focus();
  }

  editorButton.addEventListener('click',()=>void startEditor());
  closeButton.addEventListener('click',()=>close());
  dialog.addEventListener('cancel',event=>{event.preventDefault(); close();});

  return {
    isOpen:()=>dialog.open,
    interact,
    editTarget:id=>startEditor(id,true),
    setAccess,
    setAvailable(value){editorButton.disabled=!value;},
    close,
  };
}
