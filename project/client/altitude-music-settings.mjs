const database='honeymoon-audio';
const maximumBytes=16*1024*1024;
const trackKey='altitude-music';

function savedTrack(operation) {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(database,1);
    request.onupgradeneeded=()=>request.result.createObjectStore('tracks');
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{
      const db=request.result;
      const transaction=db.transaction('tracks',operation.mode);
      const task=operation.run(transaction.objectStore('tracks'));
      transaction.oncomplete=()=>{
        db.close();
        resolve(task.result);
      };
      transaction.onabort=()=>{
        db.close();
        reject(transaction.error);
      };
    };
  });
}

export function bindAltitudeMusic({input,clear,status,setSource}) {
  let objectUrl, revision=0;
  function activate(file) {
    const previous=objectUrl;
    objectUrl=file ? URL.createObjectURL(file) : undefined;
    setSource(objectUrl);
    if (previous) URL.revokeObjectURL(previous);
    clear.hidden=!file;
    status.textContent=file?.name ?? 'Обычная музыка';
  }
  savedTrack({mode:'readonly',run:store=>store.get(trackKey)}).then(file=>{
    if (!revision && file instanceof Blob) activate(file);
  }).catch(()=>{});

  input.addEventListener('change',async ()=>{
    const file=input.files[0];
    input.value='';
    if (!file) return;
    if (file.size>maximumBytes || !file.size) {
      status.textContent='Выберите аудиофайл размером от 1 байта до 16 МБ.';
      return;
    }
    const media=document.createElement('audio');
    if (file.type && !media.canPlayType(file.type)) {
      status.textContent='Браузер не поддерживает этот формат. Выберите MP3, OGG или WAV.';
      return;
    }
    const current=++revision;
    activate(file);
    try {
      await savedTrack({mode:'readwrite',run:store=>store.put(file,trackKey)});
    } catch {
      if (current===revision) status.textContent=file.name+' · до закрытия вкладки';
    }
  });
  clear.addEventListener('click',async ()=>{
    const current=++revision;
    activate();
    try {
      await savedTrack({mode:'readwrite',run:store=>store.delete(trackKey)});
    } catch {
      if (current===revision) status.textContent='Сохранённый выбор удалить не удалось.';
    }
  });
}
