import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CREATIVE_BOAT_KEY, CREATIVE_FRAME_KEY, CREATIVE_INVISIBLE_FRAME_KEY, CREATIVE_MINECART_KEY, creativeMicroblock,
  itemPlacementCells} from '../world/creative-items.mjs';
import {consumableName} from '../world/held-consumables.mjs';
import {isCoverMaterial} from '../world/geometry.mjs';
import {FAKE_WATER} from '../world/fluid-state.mjs';
import {NPC_EDITOR_WAND_ID,NPC_EDITOR_WAND_KEY} from '../world/npc-editor-wand.mjs';
import {lightingPlacementName} from '../world/placement-lighting.mjs';

const rails = [
  [66, 'Рельсы', 'Rail'],
  [27, 'Энергорельсы', 'Powered Rail'],
  [28, 'Рельсы с датчиком', 'Detector Rail'],
];
const railState = /^legacy:(?:27|28|66):\d+$/;
const minecart = {key:CREATIVE_MINECART_KEY, id:328, damage:0, kind:'minecart', name:'Пассажирская вагонетка',
  english:'Passenger Minecart', mod:'Minecraft', category:'redstone', technical:false, placeable:true};
const boat = {key:CREATIVE_BOAT_KEY,id:333,damage:0,kind:'boat',name:'Лодка',
  english:'Boat',mod:'Minecraft',category:'items',technical:false,placeable:true};
const frame = {key:CREATIVE_FRAME_KEY,id:389,damage:0,kind:'item-frame',name:'Рамка для предметов',
  english:'Item Frame',mod:'Minecraft',category:'items',technical:false,placeable:true};
const invisibleFrame = {...frame,key:CREATIVE_INVISIBLE_FRAME_KEY,damage:1,name:'Невидимая рамка для предметов',
  english:'Invisible Item Frame',invisible:true};
const painting={...frame,key:'creative:321:0',id:321,kind:'painting',name:'Картина',english:'Painting'};
const placeableProps=[
  {...frame,key:'creative:354:0',id:354,kind:'block-item',name:'Торт',english:'Cake',blockKey:'legacy:92:0'},
  {...frame,key:'creative:390:0',id:390,kind:'block-item',name:'Цветочный горшок',english:'Flower Pot',blockKey:'legacy:140:0'},
];
const npcWand = {key:NPC_EDITOR_WAND_KEY,id:NPC_EDITOR_WAND_ID,damage:0,kind:'flat-item',name:'Инструмент настройки NPC',
  english:'NPC Wand',mod:'Custom NPCs',category:'items',technical:false,placeable:true};

export function readCreativeCatalog(generated, project = fileURLToPath(new URL('..', import.meta.url)), flatItems = []) {
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(join(generated, 'creative', 'catalog.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { catalog = JSON.parse(readFileSync(join(project, 'world', 'creative-catalog.json'), 'utf8')); }
    catch (fallback) {
      if (fallback.code !== 'ENOENT') throw fallback;
      catalog = {schemaVersion:1, entries:[]};
    }
  }
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.entries)) throw new Error('Invalid creative catalog');
  // Rail neighbors determine orientation at placement time. Expose one item per rail type, even with an older catalog.
  const captured = new Map(catalog.entries.map(entry => [entry.key, entry]));
  catalog.entries = catalog.entries.filter(entry => !railState.test(entry.key) &&
    ![CREATIVE_MINECART_KEY,CREATIVE_FRAME_KEY,CREATIVE_INVISIBLE_FRAME_KEY,CREATIVE_BOAT_KEY,NPC_EDITOR_WAND_KEY,
      painting.key,...itemPlacementCells.keys()].includes(entry.key));
  for (const [id, name, english] of rails) {
    const key = `legacy:${id}:0`;
    catalog.entries.push({...captured.get(key), key, id, meta:0, name, english, mod:'Minecraft', category:'redstone',
      technical:false, placeable:true});
  }
  if (!captured.has(FAKE_WATER)) catalog.entries.push({key:FAKE_WATER,id:4095,meta:0,
    name:'Фальшивая вода',english:'Fake Water',mod:'Lilium Moonlight',category:'nature',technical:false,placeable:true});
  const extra = new Map([minecart,frame,invisibleFrame,boat,npcWand,painting,...placeableProps].map(item => [item.key,item]));
  for (const {id,damage,name,english,mod} of flatItems) {
    if (!Number.isInteger(id) || id < 1 || id > 32767 || !Number.isInteger(damage) || damage < 0 || damage > 32767 ||
        typeof name !== 'string' || !name) continue;
    const key = 'creative:' + id + ':' + damage;
    const blockKey=itemPlacementCells.get(key);
    if (!extra.has(key) && (blockKey || !captured.has(key))) extra.set(key,{key,id,damage,name,english,mod,kind:blockKey?'block-item':'flat-item',
      ...consumableName(id,damage),...(blockKey&&{blockKey}),category:'items',technical:false,placeable:true});
  }
  catalog.entries.push(...extra.values());
  if (catalog.tabs && !catalog.tabs.some(tab => tab.id === 'items')) catalog.tabs.push({id:'items',label:'Предметы'});
  const placeable = new Set();
  const items = new Map();
  for (const entry of catalog.entries) {
    const fixtureName=lightingPlacementName(entry.id,entry.meta);
    if (fixtureName) entry.name=fixtureName;
    if (extra.has(entry.key)) {
      items.set(entry.key, entry);
      continue;
    }
    const key = entry.blockKey ?? entry.key;
    const [family, id, meta] = key?.split(':') ?? [];
    if (family !== 'legacy' || !/^\d+$/.test(id) || !/^\d+$/.test(meta) || Number(id) > 4095 || Number(id) < 1 ||
        Number(meta) > 15 || key !== `legacy:${Number(id)}:${Number(meta)}`) throw new Error('Invalid creative block key');
    if (entry.key !== key) {
      if (!Number.isInteger(entry.damage) || entry.damage < 0 || entry.damage > 32767 ||
          entry.key !== `creative:${Number(id)}:${entry.damage}`) throw new Error('Invalid creative item key');
      const validLamp = entry.kind === 'shaped-lamp' && key === 'legacy:768:0' && entry.damage < 64;
      const wire = entry.kind === 'wire' && key === `legacy:750:${entry.damage >> 8}` &&
        [1,2,3,5,12].includes(entry.damage >> 8) && (entry.damage & 255) <= 16;
      const high = entry.damage >> 8;
      const tube = entry.kind === 'tube' && high >= 7 && high <= 11 && key === `legacy:750:${high}`;
      const jacket = entry.kind === 'jacket' && key === `legacy:750:${[1,3,5][high - 64]}` &&
        isCoverMaterial(entry.damage & 255);
      const part = entry.kind === 'microblock' && key === 'legacy:750:0' ? creativeMicroblock(entry) : null;
      const logic = entry.kind === 'logic' && key === `legacy:753:${entry.damage >> 8}` && entry.damage <= 1024;
      if (!validLamp && !wire && !logic && !tube && !jacket && !part) entry.placeable = false;
      if (entry.placeable !== false) items.set(entry.key, {...entry, part});
    } else if (entry.placeable !== false) placeable.add(key);
  }
  if (catalog.counts) {
    catalog.counts.entries = catalog.entries.length;
    catalog.counts.technical = catalog.entries.filter(entry => entry.technical).length;
    catalog.counts.placeable = catalog.entries.filter(entry => entry.placeable !== false).length;
    if (catalog.counts.categoryCounts) {
      catalog.counts.categoryCounts.items = 0;
      for (const id of Object.keys(catalog.counts.categoryCounts)) {
        catalog.counts.categoryCounts[id] = catalog.entries.filter(entry => entry.category === id).length;
      }
    }
  }
  return {catalog, placeable, items};
}
