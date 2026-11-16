import {minecraftTextRuns,plainMinecraftText} from '../world/item-text.mjs';

export function node(tag,className,text) {
  const element=document.createElement(tag);
  if (className) element.className=className;
  if (text!==undefined && text!==null) element.textContent=text;
  return element;
}

export function button(label,click,className) {
  const element=node('button',className,label);
  element.type='button';
  if (click) element.addEventListener('click',click);
  return element;
}

export function textComponent(text) {
  const target=node('span');
  for (const run of minecraftTextRuns(typeof text==='string'?text:String(text??''))) {
    const fragment=node('span',null,run.text);
    if (run.color) fragment.style.color=run.color;
    if (run.bold) fragment.style.fontWeight='bold';
    if (run.italic) fragment.style.fontStyle='italic';
    if (run.underline || run.strike) fragment.style.textDecoration=
      [run.underline&&'underline',run.strike&&'line-through'].filter(Boolean).join(' ');
    target.append(fragment);
  }
  return target;
}

export function caption(value) {
  return plainMinecraftText(String(value??'')).trim().toLocaleLowerCase('ru');
}

export function field(label,{type='text',value='',changed,min,max,step,maxLength,choices,placeholder}={}) {
  const wrapper=node('label','npc-field');
  wrapper.append(node('span',null,label));
  const input=node(choices?'select':type==='textarea'?'textarea':'input');
  if (choices) {
    for (const [id,description] of choices) {
      const option=node('option',null,description);
      option.value=id;
      input.append(option);
    }
  } else if (type!=='textarea') input.type=type;
  if (type==='checkbox') {
    input.checked=Boolean(value);
    wrapper.classList.add('npc-check');
    wrapper.prepend(input);
  } else {
    input.value=value??'';
    wrapper.append(input);
  }
  if (min!==undefined) input.min=min;
  if (max!==undefined) input.max=max;
  if (step!==undefined) input.step=step;
  if (maxLength!==undefined) input.maxLength=maxLength;
  if (placeholder!==undefined) input.placeholder=placeholder;
  if (changed) input.addEventListener(choices || type==='checkbox'?'change':'input',()=>{
    if (type==='number') {
      if (input.validity.valid && Number.isFinite(input.valueAsNumber)) changed(input.valueAsNumber);
    } else changed(type==='checkbox'?input.checked:input.value);
  });
  return {wrapper,input};
}

export function block(title,...children) {
  const section=node('section','npc-section');
  const heading=node('h3');
  heading.append(textComponent(title));
  section.append(heading,...children);
  return section;
}

export function stackChip(stack,{entryFor,drawItem}) {
  const item=node('span','npc-stack');
  if (!stack) {item.textContent='Пусто'; return item;}
  const entry=entryFor(stack);
  const canvas=node('canvas','npc-stack-icon');
  canvas.width=canvas.height=32;
  canvas.setAttribute('aria-hidden','true');
  if (entry) Promise.resolve(drawItem(entry,canvas)).catch(()=>{canvas.hidden=true;});
  else canvas.hidden=true;
  item.append(canvas,textComponent(stack.name??entry?.name??stack.key??('ID '+stack.id)));
  if (stack.count>1) item.append(node('span','npc-stack-count','×'+stack.count));
  return item;
}
