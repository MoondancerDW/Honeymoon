const formats = ['Б', 'КиБ', 'МиБ', 'ГиБ'];
const number = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 1});

function size(bytes) {
  let unit = 0;
  while (bytes >= 1024 && unit < formats.length-1) {
    bytes /= 1024;
    unit++;
  }
  return number.format(bytes)+' '+formats[unit];
}

export function createSoloDownloadUi({element, request=fetch}) {
  const toggle=element('solo-download-toggle');
  const dialog=element('solo-download');
  const progress=element('solo-download-progress');
  const sizes=element('solo-download-size');
  const status=element('solo-download-status');
  const complete=element('solo-download-complete');
  const update=element('solo-download-update');
  const error=element('solo-download-error');
  const download=element('solo-download-all');
  const cancel=element('solo-download-cancel');
  let operation, controller, timer, state, actionError='', revision=0;

  const message=(target,text)=>{
    if (target.textContent!==text) target.textContent=text;
    target.hidden=!text;
  };

  function buttons() {
    const downloading=Boolean(state?.downloadingAll ?? state?.background);
    download.hidden=downloading;
    download.disabled=Boolean(operation || !state || state.complete);
    cancel.hidden=!downloading;
    cancel.disabled=Boolean(operation);
  }

  function render(value) {
    state=value;
    const ready=value.readyFiles ?? 0, total=value.totalFiles ?? 0;
    const readyBytes=value.readyBytes ?? 0, totalBytes=value.totalBytes ?? 0;
    progress.max=totalBytes || total || 1;
    progress.value=totalBytes ? readyBytes : ready;
    message(sizes,`${size(readyBytes)} из ${size(totalBytes)} · ${number.format(ready)} из ${number.format(total)} файлов`);
    message(status,value.complete ? '' : value.active ? 'Скачиваем пакеты карты…' :
      value.queued ? `В очереди ${number.format(value.queued)} файлов.` : 'Карта подгружается при приближении к новым районам.');
    complete.hidden=!value.complete;
    const newer=value.update?.build;
    message(update,Number.isSafeInteger(newer) && newer>value.build ?
      `Доступна сборка ${newer}. Новый запускатор можно скачать на GitHub.` :
      value.update?.newVersion ? 'Доступно обновление карты. Оно применится при следующем запуске.' : '');
    message(error,actionError || (typeof value.lastError==='string' ? value.lastError : ''));
    buttons();
  }

  async function send(path, signal, method='GET') {
    const response=await request('/api/solo-cache'+path,{
      method,cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(8000)]),
    });
    if (!response.ok) throw new Error('Local download status unavailable');
    return method==='GET' ? response.json() : undefined;
  }

  async function refresh(view) {
    if (!view || view!==controller || !dialog.open || operation) return;
    const requested=++revision;
    try {
      const value=await send('',view.signal);
      if (view===controller && requested===revision) render(value);
    } catch {
      if (view===controller && requested===revision) message(error,'Не удалось получить состояние загрузки.');
    } finally {
      if (view===controller && requested===revision) {
        clearTimeout(timer);
        timer=setTimeout(()=>void refresh(view),1600);
      }
    }
  }

  async function act(path) {
    if (!controller || operation) return;
    const view=controller;
    operation=view;
    revision++;
    actionError='';
    clearTimeout(timer);
    buttons();
    try {
      await send(path,view.signal,'POST');
    } catch {
      if (view===controller) {
        actionError='Не удалось изменить фоновую загрузку.';
        message(error,actionError);
      }
    } finally {
      if (operation===view) operation=undefined;
      if (view===controller) {
        buttons();
        void refresh(view);
      }
    }
  }

  toggle.addEventListener('click',()=>{
    if (toggle.hidden || dialog.open) return;
    state=undefined;
    actionError='';
    progress.removeAttribute('value');
    message(sizes,'');
    message(update,'');
    message(error,'');
    message(status,'Проверяем скачанные пакеты…');
    complete.hidden=true;
    buttons();
    controller=new AbortController();
    dialog.showModal();
    void refresh(controller);
  });
  download.addEventListener('click',()=>void act('/download-all'));
  cancel.addEventListener('click',()=>void act('/cancel'));
  element('solo-download-close').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{
    if (dialog.open) return;
    clearTimeout(timer);
    controller?.abort();
    controller=operation=undefined;
  });
  return {
    enable(enabled) {
      toggle.hidden=!enabled;
      if (!enabled && dialog.open) dialog.close();
    },
    isOpen:()=>dialog.open,
  };
}
