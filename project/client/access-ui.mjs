const errors={
  invite_required:'Для входа откройте ссылку-приглашение.',
  profile_name_required:'Введите имя профиля.',
  invalid_profile_name:'Проверьте имя профиля.',
  invalid_invite:'Приглашение недействительно. Запросите новую ссылку.',
  invite_expired:'Срок действия приглашения истёк. Запросите новую ссылку.',
  invite_used:'Приглашение уже использовано. Запросите новую ссылку.',
  invite_revoked:'Приглашение отозвано. Запросите новую ссылку.',
  owner_key:'Проверьте ключ владельца.',
  owner_only:'Откройте локальный адрес владельца.',
  owner_rate_limit:'Слишком много попыток. Попробуйте через минуту.',
  owner_unavailable:'Вход владельца сейчас недоступен.',
  profile_missing:'Профиль для этого приглашения недоступен.',
  profile_active_elsewhere:'Этот профиль уже в игре в другом браузере. Закройте прежний сеанс и повторите вход.',
};

function browserLabel() {
  const agent=navigator.userAgent;
  const names=[[/OPR\//,'Opera'],[/EdgA?\//i,'Edge'],[/EdgiOS\//,'Edge'],[/FxiOS\/|Firefox\//,'Firefox'],
    [/CriOS\/|Chrome\//,'Chrome'],[/Safari\//,'Safari']];
  const systems=[[/Android/,'Android'],[/iPad|iPhone|iPod/,'iOS'],[/Windows/,'Windows'],[/Macintosh/,'macOS'],[/Linux/,'Linux']];
  const name=names.find(([match])=>match.test(agent))?.[1]??'Браузер';
  const system=systems.find(([match])=>match.test(agent))?.[1];
  return system?name+' · '+system:name;
}

function clearInviteFromUrl() {
  const current=new URL(location.href);
  const hash=new URLSearchParams(current.hash.slice(1));
  if (!hash.has('invite')) return;
  hash.delete('invite');
  current.hash=hash.toString();
  history.replaceState(history.state,'',current);
}

export function createAccessUi({element,post}) {
  const gate=element('access-gate'),form=element('access-form'),status=element('access-error');
  const key=element('access-key'),name=element('access-name'),submit=element('access-submit');
  const nameRow=element('access-name-row'),keyRow=element('access-key-row');
  const profile=element('access-profile');
  let invitation;

  function hint(code) {
    status.textContent=errors[code]??'Не удалось войти. Проверьте ссылку или попробуйте снова.';
  }

  function display({owner=false,needsName=false,code}={}) {
    gate.hidden=false;
    nameRow.hidden=!needsName;
    keyRow.hidden=!owner;
    name.required=needsName&&!owner;
    key.required=owner;
    submit.hidden=!owner&&!needsName;
    submit.textContent='Войти';
    status.textContent='';
    if (code) hint(code);
    if (owner) key.focus();
    else if (needsName) name.focus();
  }

  function waitForForm({owner}) {
    display({owner,needsName:true});
    return new Promise(resolve=>{
      form.onsubmit=async event=>{
        event.preventDefault();
        if (submit.disabled) return;
        submit.disabled=true;
        status.textContent='';
        const profileName=name.value.trim();
        const path=owner?'access/owner':'session';
        const credentials=owner?{key:key.value}:{invite:invitation};
        credentials.deviceName=browserLabel();
        if (profileName) credentials.profileName=profileName;
        try {
          const response=await post(path,credentials,AbortSignal.timeout(10000));
          if (response.ok) {
            form.onsubmit=null;
            form.reset();
            resolve(response);
          } else {
            hint(response.body.error);
            if (response.body.error==='profile_name_required') {name.required=true; name.focus();}
            else if (owner) {key.value=''; key.focus();}
          }
        } catch {status.textContent='Связь с сервером прервана. Попробуйте снова.';}
        finally {submit.disabled=false;}
      };
    });
  }

  function profileIdentity(access) {
    const active=access?.profileName;
    profile.hidden=!active;
    profile.textContent=active?'Используется профиль '+active:'';
  }

  function waitForProfileSlot() {
    display({code:'profile_active_elsewhere'});
    submit.textContent='Повторить вход';
    submit.hidden=false;
    submit.focus();
    return new Promise(resolve=>{
      form.onsubmit=async event=>{
        event.preventDefault();
        if (submit.disabled) return;
        submit.disabled=true;
        try {
          const response=await post('session',{},AbortSignal.timeout(10000));
          if (response.ok && !response.body.access?.activeElsewhere) {
            form.onsubmit=null;
            resolve(response);
          } else hint(response.body.error??'profile_active_elsewhere');
        } catch {status.textContent='Не удалось связаться с сервером. Повторите вход.';}
        finally {submit.disabled=false;}
      };
    });
  }

  async function acquire() {
    invitation=new URLSearchParams(location.hash.slice(1)).get('invite');
    let attempt=await post('session',invitation?{invite:invitation,deviceName:browserLabel()}:{},AbortSignal.timeout(10000));
    if (invitation && attempt.body?.error==='already_authenticated') {
      attempt=await post('session',{},AbortSignal.timeout(10000));
    }
    let ready=attempt;
    if (!attempt.ok) {
      const code=attempt.body?.error;
      if (invitation && code==='profile_name_required') ready=await waitForForm({owner:false});
      else if (code==='profile_active_elsewhere') ready=await waitForProfileSlot();
      else if (!invitation && attempt.body?.ownerBootstrap) ready=await waitForForm({owner:true});
      else {
        display({code:code??'invite_required'});
        return null;
      }
    }
    if (invitation) {
      clearInviteFromUrl();
      invitation=undefined;
    }
    if (ready.body.access?.activeElsewhere) ready=await waitForProfileSlot();
    if (ready.body.access?.authenticated) addEventListener('hashchange',clearInviteFromUrl);
    gate.hidden=true;
    profileIdentity(ready.body.access);
    return ready.body;
  }

  return {acquire};
}
