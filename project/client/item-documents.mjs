import {bookPageLimit,bookPages,bookPagesLimit,bookTitleLimit,bookType,formatColors,itemLore,itemName,itemNameLimit,
  loreLimit,minecraftTextRuns,plainMinecraftText,stackRevision,writtenBookInfo} from '../world/item-text.mjs';

function drawText(target,text) {
  const spans=minecraftTextRuns(text).map(run=>{
    const span=document.createElement('span');
    span.textContent=run.obfuscated ? run.text.replace(/[^\s]/g,'▰') : run.text;
    if (run.color) span.style.color=run.color;
    if (run.bold) span.style.fontWeight='700';
    if (run.italic) span.style.fontStyle='italic';
    if (run.underline || run.strike) span.style.textDecoration=[run.underline&&'underline',run.strike&&'line-through'].filter(Boolean).join(' ');
    return span;
  });
  target.replaceChildren(...spans);
}

export function createItemDocuments({stackAt,act,pause,resume}) {
  const find=id=>document.getElementById(id);
  const dialog=find('item-document'), form=find('item-document-form');
  const heading=find('item-document-title'), error=find('item-document-error');
  const details=find('item-details'), name=find('item-display-name'), lore=find('item-lore');
  const preview=find('item-text-preview'), format=find('item-format');
  const book=find('book-details'), body=find('book-page'), title=find('book-title');
  const signing=find('book-signing'), submit=find('item-document-submit');
  const author=find('book-author'), number=find('book-number');
  const previous=find('book-previous'), next=find('book-next'), clear=find('item-clear-text');
  name.maxLength=itemNameLimit;
  lore.maxLength=loreLimit;
  title.maxLength=bookTitleLimit;
  let editor, focus=name, timer, queued=Promise.resolve(true);

  for (const [code,label] of formatColors.map((color,index)=>[index.toString(16),color]).concat([
    ['l','Жирный'],['o','Курсив'],['n','Подчёркнутый'],['m','Зачёркнутый'],['k','Искажённый'],['r','Сброс стиля'],
  ])) {
    const button=document.createElement('button');
    button.type='button';
    button.title=label;
    button.setAttribute('aria-label',label);
    if (label.startsWith('#')) {
      button.style.backgroundColor=label;
      button.className='text-color';
    } else button.textContent=label;
    button.addEventListener('mousedown',event=>event.preventDefault());
    button.addEventListener('click',()=>{
      const {selectionStart:start,selectionEnd:end,value,maxLength}=focus;
      const selected=value.slice(start,end);
      const insertion='§'+code+selected+(selected&&code!=='r'?'§r':'');
      if (value.length-(end-start)+insertion.length>maxLength) return;
      focus.setRangeText(insertion,start,end,selected?'select':'end');
      focus.focus();
      repaint();
    });
    format.append(button);
  }

  function repaint() {
    drawText(preview,[name.value,lore.value].filter(Boolean).join('\n'));
  }
  for (const target of [name,lore]) {
    target.addEventListener('focus',()=>{focus=target;});
    target.addEventListener('input',repaint);
  }

  function reset(slot,mode,fromWorld) {
    if (dialog.open) return false;
    const stack=stackAt(slot);
    if (!stack) return false;
    if (fromWorld) pause();
    editor={slot,mode,fromWorld,page:0,dirty:new Map(),expected:stackRevision(stack)};
    error.textContent='';
    details.hidden=mode!=='item';
    book.hidden=mode==='item';
    submit.hidden=mode==='signed';
    submit.textContent=mode==='draft'?'Подписать':'Сохранить';
    clear.hidden=mode!=='item';
    return true;
  }
  function openItem(slot) {
    if (!reset(slot,'item',false)) return;
    const stack=stackAt(slot);
    heading.textContent='Название и описание';
    name.value=itemName(stack);
    lore.value=itemLore(stack).join('\n');
    focus=name;
    repaint();
    dialog.showModal();
    name.focus();
  }
  function openBook(slot,{world=false}={}) {
    const mode=bookType(stackAt(slot));
    if (!mode || !reset(slot,mode,world)) return false;
    const stack=stackAt(slot);
    const bookInfo=writtenBookInfo(stack);
    editor.pages=bookPages(stack).map(value=>typeof value==='string'?value:String(value??''));
    heading.textContent=bookInfo?.title ?? 'Книга и перо';
    body.readOnly=mode==='signed';
    if (mode==='draft') body.maxLength=bookPageLimit;
    else body.removeAttribute('maxlength');
    signing.hidden=mode==='signed';
    title.value='';
    author.textContent=bookInfo?.author ?? '';
    author.hidden=!author.textContent;
    renderPage();
    dialog.showModal();
    body.focus();
    return true;
  }
  function renderPage() {
    const {mode,page,pages}=editor;
    const text=pages[page]??'';
    body.value=mode==='signed'?plainMinecraftText(text):text;
    number.textContent=`${page+1} / ${pages.length}`;
    previous.disabled=page===0;
    next.disabled=mode==='signed' ? page===pages.length-1 : page===bookPagesLimit-1;
    next.textContent=page===pages.length-1 && mode==='draft' ? 'Новая страница' : 'Далее ›';
  }
  async function transmit(type,fields,current=editor) {
    const saved=await act(type,{slot:current.slot,expected:current.expected,...fields});
    if (saved) current.expected=stackRevision(stackAt(current.slot));
    return saved;
  }
  function flush() {
    clearTimeout(timer);
    const current=editor;
    if (!current || current.mode!=='draft') return Promise.resolve(true);
    queued=queued.catch(()=>false).then(async()=>{
      for (const [page,text] of current.dirty) {
        if (!await transmit('inventory_book_page',{page,text},current)) {
          error.textContent='Страница ещё не сохранена. Повторите попытку.';
          return false;
        }
        if (current.dirty.get(page)===text) current.dirty.delete(page);
      }
      error.textContent='';
      return true;
    });
    return queued;
  }
  body.addEventListener('input',()=>{
    if (editor?.mode!=='draft') return;
    editor.pages[editor.page]=body.value;
    editor.dirty.set(editor.page,body.value);
    clearTimeout(timer);
    timer=setTimeout(()=>void flush(),350);
  });
  function turn(offset) {
    if (!editor) return;
    void flush();
    editor.page+=offset;
    if (editor.page===editor.pages.length) editor.pages.push('');
    renderPage();
    body.focus();
  }
  previous.addEventListener('click',()=>turn(-1));
  next.addEventListener('click',()=>turn(1));
  clear.addEventListener('click',()=>{
    name.value=lore.value='';
    repaint();
    name.focus();
  });
  async function close() {
    if (!dialog.open || !await flush()) return;
    const fromWorld=editor.fromWorld;
    editor=undefined;
    dialog.close();
    if (fromWorld) resume();
  }
  find('item-document-close').addEventListener('click',()=>void close());
  dialog.addEventListener('cancel',event=>{event.preventDefault();void close();});
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if (!editor || editor.mode==='signed') return;
    const mode=editor.mode;
    if (mode==='draft' && !title.value.trim()) {
      title.focus();
      return;
    }
    submit.disabled=true;
    try {
      if (!await flush()) return;
      const saved=mode==='item' ?
        await transmit('inventory_annotate',{name:name.value,lore:lore.value.split('\n')}) :
        await transmit('inventory_book_sign',{title:title.value});
      if (saved) await close();
      else error.textContent='Изменения не приняты. Проверьте выбранный предмет и текст.';
    } finally { submit.disabled=false; }
  });
  return {isOpen:()=>dialog.open,openItem,openBook};
}
