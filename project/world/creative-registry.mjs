import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const project = fileURLToPath(new URL('..', import.meta.url));
const tabs = [
  ['build','Строительство'], ['decor','Декор'], ['nature','Природа'], ['redstone','Механизмы'],
  ['jammy','Мебель Jammy'], ['chisel','Chisel'], ['redpower','RedPower'], ['microblocks','Микроблоки'], ['mods','Другие моды'],
  ['technical','Технические'],
].map(([id,label]) => ({id,label}));
const mods = [
  ['net.minecraft.jammy780.', 'Jammy Furniture', 'jammy'],
  ['info.jbcs.minecraft.chisel.', 'Chisel', 'chisel'],
  ['com.eloraam.redpower.', 'RedPower', 'redpower'],
  ['jds.bibliocraft.', 'BiblioCraft', 'mods'],
  ['teotoo.minelittlebrony.', 'Mine Little Brony', 'mods'],
  ['twilightforest.', 'Twilight Forest', 'mods'],
  ['pamsmods.common.harvestcraft.', 'Pam’s HarvestCraft', 'mods'],
  ['pamsmods.common.weeeflowers.', 'Pam’s Weee! Flowers', 'nature'],
  ['drzhark.mocreatures.', 'Mo’ Creatures', 'mods'],
  ['noppes.npcs.', 'Custom NPCs', 'mods'],
  ['com.JSOneStudios.', 'Campfire Mod', 'mods'],
];
const natural = new Set([2,6,8,9,10,11,12,13,14,15,16,17,18,21,30,31,32,37,38,39,40,56,59,60,73,74,78,79,80,81,82,83,99,100,103,104,105,106,110,111,115,127,129,141,142]);
const aliases = new Map([
  [34,['Головка поршня','Piston Head']], [36,['Движущийся поршень','Moving Piston']],
  [63,['Напольная табличка','Standing Sign']], [68,['Настенная табличка','Wall Sign']],
  [75,['Погасший красный факел','Unlit Redstone Torch']],
  [93,['Повторитель','Redstone Repeater']], [94,['Активный повторитель','Powered Redstone Repeater']],
  [104,['Росток тыквы','Pumpkin Stem']], [105,['Росток арбуза','Melon Stem']],
  [117,['Варочная стойка','Brewing Stand']], [119,['Портал Края','End Portal']],
  [125,['Двойная деревянная плита','Double Wooden Slab']], [140,['Цветочный горшок','Flower Pot']],
  [144,['Голова','Mob Head']], [752,['Ячейка большой конструкции','Multiblock Proxy']],
  [2240,['Служебный блок BiblioCraft','BiblioCraft Blocker']],
]);
const hiddenCells = new Set([36,752,2240]);
// The original Twilight Forest atlas has no pixels for these unregistered subtypes.
const hiddenVariants = new Map([[2169,new Set([0,1,2,3,4,5,6,7,10,11,12,15])],
  [2175,new Set([10,11,12,13,14,15])]]);
const parseNumber = value => value && value !== 'null' && Number.isFinite(Number(value)) ? Number(value) : null;
const yes = value => value === 'true';
const csv = value => value?.split(',') ?? [];
const clean = value => typeof value === 'string' && value.trim() && !/^(?:tile\.|item\.|null$)/.test(value.trim()) ? value.trim() : '';

export function readRegistryTsv(source) {
  const [header, ...lines] = source.trimEnd().split(/\r?\n/);
  const fields = header.replace(/^\uFEFF/, '').split('\t');
  return lines.map(line => {
    const values = line.split('\t');
    return Object.fromEntries(fields.map((field,index) => [field, values[index] ?? '']));
  });
}

export function readNativeCreativeTabs(source) {
  const tabs = new Map();
  for (const row of readRegistryTsv(source)) {
    const index = Number(row.index);
    if (!Number.isInteger(index) || index < 0 || !row.key) throw new Error('Invalid native creative tab');
    if (!tabs.has(index)) tabs.set(index,{index,id:row.key,label:row.label || row.key,
      icon:row.iconId ? `${row.iconId}:${row.iconDamage || 0}` : null,entries:[]});
    if (row.id) tabs.get(index).entries.push(`${row.id}:${row.damage || 0}`);
  }
  return Array.from(tabs.values()).sort((a,b)=>a.index-b.index);
}

function family(row) {
  const [,mod,category] = mods.find(([prefix]) => row.class.startsWith(prefix)) ?? [];
  if (mod) return {mod, category};
  if (/campfire/i.test(row.class)) return {mod:'Campfire Mod', category:'mods'};
  if (/^pamsmods\./.test(row.class)) return {mod:'Pam’s HarvestCraft', category:'mods'};
  if (/\./.test(row.class)) return {mod:row.class.slice(0,row.class.lastIndexOf('.')), category:'mods'};
  const fallback = natural.has(Number(row.id)) ? 'nature' : row.tab === 'buildingBlocks' ? 'build' :
    row.tab === 'redstone' || row.tab === 'transportation' ? 'redstone' : 'decor';
  return {mod:'Minecraft', category:fallback};
}

function plainClass(row) {
  const name = row.class.split('.').at(-1);
  const base = name.replace(/^(?:jfm_)?Block(?:Pam|TF)?/, '').replace(/^TileEntity/, '');
  if (base.length < 4 || !/[A-Z]/.test(base)) return '';
  return base.replace(/([a-z\d])([A-Z])/g, '$1 $2');
}

function displayNames(row, fallback) {
  const id = Number(row.id);
  const [russian, english] = aliases.get(id) ?? [];
  const exact = clean(row.stackName) || clean(row.nameRu) || clean(row.nameEn);
  const blockTranslation = clean(row.translation) && (row.blockName || !/^pamsmods\./.test(row.class) ||
    clean(row.translation).toLowerCase().includes(plainClass(row).toLowerCase().split(' ')[0])) ? clean(row.translation) : '';
  const suffix = row.stackKey && row.blockName && row.stackKey.startsWith(row.blockName + '.') ? row.stackKey.slice(row.blockName.length + 1) : '';
  const maybeTitle = exact || (row.class === fallback?.class && clean(fallback?.stackName)) || blockTranslation;
  const name = russian || clean(row.nameRu) || maybeTitle || plainClass(row) || `Блок ${id}`;
  const englishName = english || clean(row.nameEn) || (/[а-яё]/i.test(maybeTitle) ? plainClass(row) : maybeTitle);
  return {name, english:englishName || name, ...(suffix && {variant:suffix})};
}

export function readNames(source) {
  return new Map(source.split(/\r?\n/).flatMap(line => {
    const match = /^([^#=]+)=(.+)$/.exec(line);
    return match ? [match.slice(1).map(part => part.trim())] : [];
  }));
}

const keyOf = (id,meta) => `legacy:${id}:${meta}`;
const signature = row => `${row.faces}|${row.icons}|${row.color}`;

function entryFor(row, extra) {
  const id = Number(row.id), meta = Number(row.meta);
  const familyInfo = family(row);
  const technical = !yes(row.creative);
  const textureFile = row.textureFile.replace(/^\//, '');
  const bounds = csv(row.bounds).map(parseNumber);
  const names = displayNames(row, extra.fallback);
  const icons = csv(row.icons);
  const icon = icons.slice(1).find(Boolean) || icons[0];
  const textureVariant = icon?.split('/').at(-1)?.replace(/^a\d+-/, '');
  return {key:keyOf(id,meta), id, meta, ...names, ...familyInfo,
    ...(textureVariant && !names.variant && {variant:textureVariant}), className:row.class,
    category:technical && extra.hidden ? 'technical' : familyInfo.category, technical,
    ...(hiddenCells.has(id) || hiddenVariants.get(id)?.has(meta) ? {placeable:false} : {}),
    ...(extra.onMap && {onMap:true}), textureFile, faces:csv(row.faces).map(parseNumber),
    ...(icons.some(Boolean) && {icons}), renderType:parseNumber(row.renderType),
    opaque:yes(row.opaque), normal:yes(row.normal), bounds, solid:yes(row.materialBlocks), fluid:yes(row.materialLiquid),
    tileEntity:yes(row.tileEntity), opacity:parseNumber(row.opacity), emission:parseNumber(row.emission),
    pass:parseNumber(row.pass), ...(parseNumber(row.color) !== null && {color:parseNumber(row.color)}),
  };
}

export function buildCreativeCatalog(rows, palette, itemRows = []) {
  const known = new Map();
  const observed = new Set();
  for (const key of palette) {
    const state = /^(?:legacy|cover):(\d+):(\d+)(?::|$)/.exec(key);
    if (state) observed.add(keyOf(Number(state[1]), Number(state[2])));
  }
  for (const row of rows) {
    const id = Number(row.id), meta = Number(row.meta);
    if (!Number.isInteger(id) || id <= 0 || id > 4095 || !Number.isInteger(meta) || meta < 0 || meta > 15) continue;
    if (!known.has(id)) known.set(id, new Map());
    if (known.get(id).has(meta)) throw new Error(`Duplicate Forge registry state ${id}:${meta}`);
    known.get(id).set(meta, row);
  }
  const entries = [], placeholders = [], activeIds = new Set();
  for (const [id,states] of known) {
    const zero = states.get(0);
    if (!zero || states.size !== 16) throw new Error(`Incomplete Forge registry ID ${id}`);
    const inMap = [...states.keys()].some(meta => observed.has(keyOf(id,meta)));
    if (zero.class === 'amq' && !zero.blockName && !inMap) { placeholders.push(id); continue; }
    activeIds.add(id);
    const values = [...states.values()].sort((a,b) => Number(a.meta) - Number(b.meta));
    const creative = values.filter(row => yes(row.creative));
    const marked = new Set(creative.map(signature));
    for (const row of values) {
      const meta = Number(row.meta), onMap = observed.has(keyOf(id, meta));
      const faces = csv(row.faces).map(parseNumber);
      const distinct = faces.length === 6 && faces.every(value => value !== null) && !marked.has(signature(row));
      const custom = id === 750 || id === 753 || id === 768;
      if (!custom && (yes(row.creative) || onMap || !creative.length && meta === 0 || distinct)) {
        marked.add(signature(row));
        entries.push(entryFor(row, {onMap, fallback:creative[0], hidden:!creative.length || distinct && !onMap}));
      }
      // These containers require native item damage or a source tile entity.
      if (custom && (meta === 0 || onMap)) entries.push({...entryFor(row, {onMap, hidden:true}), technical:true,
        category:'technical', placeable:false, name:`Служебная ячейка RedPower ${id}`, english:`RedPower container ${id}`});
    }
  }
  const itemStates = [];
  for (const row of itemRows) {
    const id = Number(row.id), damage = Number(row.damage);
    if (!activeIds.has(id) || !Number.isSafeInteger(damage) || damage < 0) continue;
    if (![750,753,768].includes(id) && damage < 16) continue;
    const name = clean(row.nameRu) || clean(row.name) || clean(row.nameEn) || row.stackKey;
    const english = clean(row.nameEn) || name;
    if (!name) continue;
    const coverData = parseNumber(row.coverData);
    const type = damage >>> 8;
    let kind, meta = 0;
    if (id === 768 && damage < 64) kind = 'shaped-lamp';
    else if (id === 753 && type < 5) { kind = 'logic'; meta = type; }
    else if (id === 750 && [1,2,3,5,12].includes(type)) { kind = 'wire'; meta = type; }
    else if (id === 750 && type >= 7 && type <= 11) { kind = 'tube'; meta = type; }
    else if (id === 750 && type >= 64 && type <= 66) { kind = 'jacket'; meta = [1,3,5][type - 64]; }
    else if (id === 750 && (type === 0 || type >= 16 && type <= 45) && coverData >= 65536 && coverData >>> 24 <= 3) {
      kind = 'microblock';
    }
    if (kind) {
      entries.push({key:`creative:${id}:${damage}`, blockKey:keyOf(id,meta), id, meta, damage,
        name, english, mod:'RedPower', category:kind === 'microblock' ? 'microblocks' : 'redpower', technical:false, kind,
        ...(kind === 'microblock' && {coverData})});
    } else itemStates.push({id, damage, name, english, ...(row.stackKey && {nameKey:row.stackKey})});
  }
  if (itemRows.length === 0 && known.has(768)) {
    for (const row of known.get(768).values()) {
      if (!yes(row.creative)) continue;
      const meta = Number(row.meta);
      entries.push({key:`creative:768:${meta}`, blockKey:keyOf(768,0), id:768, meta:0, damage:meta,
        ...displayNames(row), mod:'RedPower', category:'redpower', technical:false, kind:'shaped-lamp'});
    }
  }
  const absent = [...observed].filter(key => !activeIds.has(Number(key.split(':')[1])));
  if (absent.length) throw new Error(`Forge registry missing map keys: ${absent.join(', ')}`);
  const categoryCounts = Object.fromEntries(tabs.map(({id}) => [id,entries.filter(entry => entry.category === id).length]));
  return {schemaVersion:1, tabs, entries, itemStates, counts:{sourceSlots:known.size, registered:activeIds.size,
    forgePlaceholders:placeholders.length, entries:entries.length, technical:entries.filter(entry => entry.technical).length,
    placeable:entries.filter(entry => entry.placeable !== false).length, itemStates:itemStates.length, categoryCounts},
    provenance:{probe:'Minecraft 1.4.7 / Forge 6.6.2.534', forgePlaceholderIds:placeholders}};
}

export function compactCreativeCatalog(catalog) {
  const fields = ['key','blockKey','id','meta','name','english','variant','mod','category','technical','placeable',
    'onMap','kind','damage','coverData'];
  const entries = catalog.entries.map(entry => Object.fromEntries(fields.filter(field => entry[field] !== undefined)
    .map(field => [field, entry[field]])));
  return {...catalog, entries};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const {values} = parseArgs({options:{
    registry:{type:'string', default:resolve(project,'work/creative-registry/registry-full.tsv')},
    items:{type:'string'}, world:{type:'string', default:resolve(project,'generated/world/world.json')}, compact:{type:'string'},
    english:{type:'string'},
    'tab-layout':{type:'string'},
    output:{type:'string', default:resolve(project,'generated/creative/catalog.json')},
  }});
  const {palette} = JSON.parse(readFileSync(values.world,'utf8'));
  const rows = readRegistryTsv(readFileSync(values.registry,'utf8'));
  const defaultEnglish = resolve(project,'work/creative-registry/english.lang');
  try {
    // The pack replaces en_US with Russian. Preserve source Russian names and add vanilla search aliases.
    const names = readNames(readFileSync(values.english ?? defaultEnglish,'utf8'));
    for (const row of rows) {
      if (!/[а-яё]/i.test(row.nameEn)) continue;
      row.nameEn = names.get((row.stackKey || row.blockName) + '.name') ?? row.nameEn;
    }
  } catch (error) { if (values.english || error.code !== 'ENOENT') throw error; }
  let items = [];
  try { items = readRegistryTsv(readFileSync(values.items ?? values.registry + '.items','utf8')); }
  catch (error) { if (values.items || error.code !== 'ENOENT') throw error; }
  const catalog = buildCreativeCatalog(rows, palette, items);
  mkdirSync(dirname(values.output), {recursive:true});
  writeFileSync(values.output, JSON.stringify(catalog) + '\n');
  if (values.compact) {
    const compact = compactCreativeCatalog(catalog);
    const {entries, ...top} = compact;
    writeFileSync(values.compact, `${JSON.stringify(top).slice(0,-1)},"entries":[\n` +
      entries.map(entry => `  ${JSON.stringify(entry)}`).join(',\n') + '\n]}\n');
  }
  if (values['tab-layout']) {
    const original = readNativeCreativeTabs(readFileSync(values.registry+'.tabs','utf8'));
    writeFileSync(values['tab-layout'],`// Creative tab order captured from the original Forge client.\nexport default [\n` +
      original.map(tab=>`  ${JSON.stringify(tab)}`).join(',\n')+'\n];\n');
  }
  console.log(JSON.stringify(catalog.counts));
}
