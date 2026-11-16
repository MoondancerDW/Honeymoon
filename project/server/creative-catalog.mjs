import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CREATIVE_FRAME_KEY, CREATIVE_MINECART_KEY, creativeMicroblock} from '../world/creative-items.mjs';
import {isCoverMaterial} from '../world/geometry.mjs';

const rails = [
  [66, 'Рельсы', 'Rail'],
  [27, 'Энергорельсы', 'Powered Rail'],
  [28, 'Рельсы с датчиком', 'Detector Rail'],
];
const railState = /^legacy:(?:27|28|66):\d+$/;
const minecart = {key:CREATIVE_MINECART_KEY, id:328, damage:0, kind:'minecart', name:'Пассажирская вагонетка',
  english:'Passenger Minecart', mod:'Minecraft', category:'redstone', technical:false, placeable:true};
const frame = {key:CREATIVE_FRAME_KEY,id:389,damage:0,kind:'item-frame',name:'Рамка для предметов',
  english:'Item Frame',mod:'Minecraft',category:'items',technical:false,placeable:true};

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
    entry.key !== CREATIVE_MINECART_KEY && entry.key !== CREATIVE_FRAME_KEY);
  for (const [id, name, english] of rails) {
    const key = `legacy:${id}:0`;
    catalog.entries.push({...captured.get(key), key, id, meta:0, name, english, mod:'Minecraft', category:'redstone',
      technical:false, placeable:true});
  }
  const extra = new Map([[minecart.key,minecart],[frame.key,frame]]);
  for (const {id,damage,name,english,mod} of flatItems) {
    if (!Number.isInteger(id) || id < 1 || id > 32767 || !Number.isInteger(damage) || damage < 0 || damage > 32767 ||
        typeof name !== 'string' || !name) continue;
    const key = 'creative:' + id + ':' + damage;
    if (!extra.has(key) && !captured.has(key)) extra.set(key,{key,id,damage,name,english,mod,kind:'flat-item',
      category:'items',technical:false,placeable:true});
  }
  catalog.entries.push(...extra.values());
  if (catalog.tabs && !catalog.tabs.some(tab => tab.id === 'items')) catalog.tabs.push({id:'items',label:'Предметы'});
  const placeable = new Set();
  const items = new Map();
  for (const entry of catalog.entries) {
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
