export const writableBook='creative:386:0';
export const writtenBook='creative:387:0';
export const bookPageLimit=2048;
export const bookPagesLimit=100;
export const bookTitleLimit=64;
export const itemNameLimit=96;
export const loreLineLimit=32;
export const loreLimit=1500;
export const bookType=stack=>stack?.key===writableBook ? 'draft' : stack?.key===writtenBook ? 'signed' : null;
export const itemName=stack=>typeof stack?.nbt?.display?.Name==='string' ? stack.nbt.display.Name : '';
export const itemLore=stack=>Array.isArray(stack?.nbt?.display?.Lore) ? stack.nbt.display.Lore.filter(value=>typeof value==='string') : [];
export const bookPages=stack=>Array.isArray(stack?.nbt?.pages) && stack.nbt.pages.length ? stack.nbt.pages : [''];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value!=='object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
}

export function stackType({count:_count,copied:_copied,object,nbt,legacyNbt,...stack}) {
  const portable=object && {...object};
  if (portable) { delete portable.position; delete portable.key; }
  return JSON.stringify(canonical({...stack,...(portable&&{object:portable}),
    ...(nbt&&Object.keys(nbt).length&&{nbt}),...(legacyNbt&&Object.keys(legacyNbt).length&&{legacyNbt})}));
}

export function stackRevision(stack) {
  if (!stack) return '';
  const content=stackType(stack)+'|'+stack.count;
  let left=0x811c9dc5,right=0x7ed55d16;
  for (let i=0; i<content.length; i++) {
    const number=content.charCodeAt(i);
    left=Math.imul(left^number,0x01000193);
    right=Math.imul(right^number,0x9e3779b1);
  }
  return [left,right].map(value=>(value>>>0).toString(16).padStart(8,'0')).join('');
}

export const plainMinecraftText=text=>String(text??'').replace(/§[0-9a-fk-or]/gi,'');

export function writtenBookInfo(stack) {
  if (bookType(stack)!=='signed') return null;
  const text=value=>typeof value==='string' ? plainMinecraftText(value).trim() : '';
  return {title:text(stack.nbt?.title)||'Написанная книга',author:text(stack.nbt?.author)};
}

export function itemTooltip(stack,label,{withLore=false}={}) {
  const lines=[label];
  const author=writtenBookInfo(stack)?.author;
  if (author) lines.push(`Автор: ${author}`);
  if (withLore) lines.push(...itemLore(stack).map(plainMinecraftText));
  return lines.join('\n');
}

export const formatColors=['#000000','#0000aa','#00aa00','#00aaaa','#aa0000','#aa00aa','#ffaa00','#aaaaaa',
  '#555555','#5555ff','#55ff55','#55ffff','#ff5555','#ff55ff','#ffff55','#ffffff'];

export function minecraftTextRuns(text) {
  const parts=String(text??'').split(/(§[0-9a-fk-or])/gi);
  const runs=[];
  let style={};
  for (let i=0;i<parts.length;i++) {
    const part=parts[i];
    if (i%2===0) {
      if (part) runs.push({text:part,...style});
      continue;
    }
    const code=part[1].toLowerCase();
    if (/[0-9a-f]/.test(code)) style={color:formatColors[parseInt(code,16)]};
    else if (code==='r') style={};
    else style={...style,[{k:'obfuscated',l:'bold',m:'strike',n:'underline',o:'italic'}[code]]:true};
  }
  return runs;
}
