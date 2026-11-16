import * as THREE from '/vendor/three/three.module.js';

const errors={
  worldedit_forbidden:'WorldEdit доступен администратору в творческом режиме',
  worldedit_permission:'WorldEdit доступен администратору в творческом режиме',
  worldedit_too_large:'Выбранная область превышает лимит',
  worldedit_no_selection:'Выделите оба угла деревянным топором',
  worldedit_selection_required:'Выделите оба угла деревянным топором',
  worldedit_no_clipboard:'Сначала скопируйте область',
  worldedit_empty_clipboard:'Сначала скопируйте область',
  worldedit_clipboard_empty:'Сначала скопируйте область',
  worldedit_axe_required:'Возьмите деревянный топор',
  worldedit_data_limit:'В буфере слишком много данных',
  worldedit_invalid_block:'Такой блок недоступен',
  worldedit_invalid_command:'Проверьте команду WorldEdit',
  worldedit_command:'Доступны команды //set, //replace, //copy и //paste',
  worldedit_invalid_selection:'Выделите оба угла деревянным топором',
  movement_blocked:'Сервер скорректировал позицию. Повторите действие.',
  outside_reach:'Подойдите ближе к блоку',
  not_visible:'Цель скрыта препятствием',
};
const axes=['x','y','z'];
const coords=point=>Array.isArray(point)?point:point?axes.map(axis=>point[axis]):null;

function makeOutline(color) {
  const object=new THREE.Box3Helper(new THREE.Box3(),color);
  object.material.depthTest=false;
  object.material.depthWrite=false;
  object.material.transparent=true;
  object.material.opacity=.84;
  object.frustumCulled=false;
  object.renderOrder=100;
  object.visible=false;
  return object;
}

function wire(scene) {
  const group=new THREE.Group();
  const first=makeOutline(0x89dfcf);
  const second=makeOutline(0xe9bc77);
  const bounds=makeOutline(0x85d8ea);
  group.add(first,second,bounds);
  scene.add(group);
  const setBox=(outline,start,end)=>outline.box.set(new THREE.Vector3(...start),new THREE.Vector3(...end));
  return {
    visible:value=>{group.visible=value;},
    select(selection) {
      const [a,b]=selection.map(coords);
      first.visible=Boolean(a);
      second.visible=Boolean(b);
      bounds.visible=Boolean(a&&b);
      if (a) setBox(first,a.map(n=>n-.018),a.map(n=>n+1.018));
      if (b) setBox(second,b.map(n=>n-.022),b.map(n=>n+1.022));
      if (a&&b) setBox(bounds,a.map((n,i)=>Math.min(n,b[i])-.025),a.map((n,i)=>Math.max(n,b[i])+1.025));
    },
  };
}

export function isWoodAxe(stack) {
  return /^(?:creative|legacy):271:\d+$/.test(stack?.key??'');
}

export function createWorldEdit({scene,enabled,getState,send,apply,notice}) {
  let display,active=false,selection=[null,null],pending,reload=0;
  let blocks=0,limit=0;

  function update(state) {
    if (state?.selection?.length===2) selection=state.selection;
    if (Number.isFinite(state?.clipboard)) blocks=state.clipboard;
    if (Number.isFinite(state?.limit)) limit=state.limit;
    display?.select(selection);
  }

  function refresh() {
    const id=++reload;
    void getState().then(({ok,body})=>{if (ok && id===reload && active) update(body);}).catch(()=>{});
  }

  function frame() {
    const allowed=Boolean(enabled());
    if (allowed===active) return;
    active=allowed;
    if (active) {
      display??=wire(scene());
      display.select(selection);
      refresh();
    }
    display?.visible(active);
  }

  async function act(payload) {
    if (!enabled()) {notice(errors.worldedit_forbidden); return false;}
    if (pending) return false;
    reload++;
    pending=Promise.resolve().then(()=>send(payload));
    try {
      const {ok,body}=await pending;
      if (!ok) {
        notice(errors[body.error]??body.message??'Команда WorldEdit недоступна');
        return false;
      }
      update(body);
      apply(body);
      if (payload.action==='select') {
        const point=coords(selection[payload.corner-1]);
        if (point) notice('Угол '+payload.corner+' · '+point.join(', '));
      } else if (payload.action==='clear') notice('Выделение снято');
      else {
        const count=body.changed??body.changes?.length;
        notice(body.message??(count?'Изменено блоков · '+count:blocks?'Блоков в буфере · '+blocks:'WorldEdit выполнен'));
      }
      return true;
    } catch {
      notice('Нет ответа от WorldEdit');
      return false;
    } finally {pending=undefined;}
  }

  function tool(type,target) {
    if (type==='copy') return act({action:'clear'});
    if (!target) {notice('Наведите топор на блок'); return false;}
    const {x,y,z,hit}=target;
    return act({action:'select',corner:type==='remove'?1:2,x,y,z,hit});
  }

  function hint(touch=false) {
    const [a,b]=selection.map(coords);
    const count=a&&b?a.reduce((volume,n,index)=>volume*(Math.abs(n-b[index])+1),1):0;
    return count?'WorldEdit · выделено '+count.toLocaleString('ru')+(limit&&count>limit?' · превышен лимит':'') :
      (touch?'WorldEdit · − и + — углы · Копия — сброс':'WorldEdit · ЛКМ и ПКМ — углы · СКМ — сброс');
  }

  return {frame,tool,hint,command:command=>act({action:'command',command})};
}
