import {sanitizeNpc,sanitizeNpcContent} from './npc-editor.mjs';
import {npcSharedCollections} from './npc-source.mjs';

export function createTestRangeNpc(base) {
  const inBounds=({x,y,z})=>base.inBounds(x,y,z) && base.hasPlayableChunk(x>>4,z>>4);
  const dialog=sanitizeNpcContent('dialogs',{
    title:'Тестовый полигон',
    text:'На западе полигона стоят ряды с блоками. На востоке висят рамки с предметами. Кнопка «Вернуться в Эквестрию» находится в меню паузы.',
    options:[{title:'Понятно',type:'close'}],
  },1,inBounds);
  const guide=sanitizeNpc({
    name:'Смотритель полигона',
    title:'Custom NPC',
    model:'npcpony',
    position:{x:.5,y:65,z:4.5},
    rotation:'body',
    invulnerable:true,
    dialogIds:[dialog.id],
  },{id:'test-range-guide'},inBounds);
  const shared=Object.fromEntries(npcSharedCollections.map(collection=>[collection,[]]));
  shared.dialogs.push(dialog);
  return {definitions:[guide],shared};
}
