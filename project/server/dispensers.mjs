import {blockKey,blockState,signalSides} from '../world/block-interactions.mjs';

const pointOf = ({x,y,z}) => [x,y,z];
const inventory = cell => (Array.isArray(cell.object?.data?.Items) ? cell.object.data.Items : [])
  .filter(item => Number.isInteger(item.id) && item.id > 0 && Number.isInteger(item.Slot) &&
    item.Slot >= 0 && item.Slot < 9 && item.Count > 0);

function setItems(cell,Items) {
  const position = pointOf(cell);
  const object = cell.object ?? {type:'Trap',key:'tile:' + position.join(':'),position};
  return {...cell,object:{...object,data:{...object.data,Items}}};
}

export function loadDispenser(cell,stack) {
  const feedback = message => [{type:'dispenser',message}];
  if (!stack) return {effects:feedback('Возьмите предмет и нажмите E, чтобы загрузить раздатчик')};
  const items = inventory(cell).slice();
  const index = items.findIndex(item => item.id === stack.id && (item.Damage ?? 0) === stack.Damage &&
    !item.tag && item.Count < 64);
  if (index >= 0) items[index] = {...items[index],Count:items[index].Count + 1};
  else {
    const slot = Array.from({length:9},(_,i) => i).find(slot => items.every(item => item.Slot !== slot));
    if (slot === undefined) return {effects:feedback('Раздатчик заполнен')};
    items.push({...stack,Count:1,Slot:slot});
  }
  return {cells:[setItems(cell,items)],effects:feedback('Предмет загружен в раздатчик')};
}

export function dispense(cell,getCell,context) {
  const [,meta] = blockState(cell);
  const side = signalSides[meta & 7];
  if (!side) return null;
  const position = pointOf(cell);
  const items = inventory(cell).slice();
  const stack = items[0];
  if (!stack) return {cells:[],effects:[{type:'sound',sound:'click.off',position}]};
  const front = getCell(...position.map((value,index) => value + side[index]));
  const cells = [];
  const effects = [{type:'dispense',sound:'click.on',position,direction:side,
    stack:{id:stack.id,Damage:stack.Damage ?? 0,...(stack.Block && {Block:true})}}];
  const liquid = stack.id === 326 ? 9 : stack.id === 327 ? 11 : 0;
  const [frontId,frontMeta] = blockState(front);
  const scoop = stack.id === 325 && frontMeta === 0 && context.ownerAt(front) && [8,9,10,11].includes(frontId);
  if ((liquid && front.cell === null || scoop) && context.pistonDestination(front)) {
    cells.push({...front,cell:scoop ? null : blockKey(liquid,0),object:null,moveOwner:context.ownerAt(cell)});
    const remainder = {...stack,id:scoop ? (frontId <= 9 ? 326 : 327) : 325,Damage:0,Count:1};
    if (stack.Count === 1) items[0] = remainder;
    else {
      const slot = Array.from({length:9},(_,i) => i).find(slot => items.every(item => item.Slot !== slot));
      items[0] = {...stack,Count:stack.Count - 1};
      if (slot !== undefined) items.push({...remainder,Slot:slot});
    }
    effects[0] = {type:'sound',sound:'click.on',position};
  } else if (stack.Count > 1) items[0] = {...stack,Count:stack.Count - 1};
  else items.shift();
  return {cells:[setItems(cell,items),...cells],effects};
}
