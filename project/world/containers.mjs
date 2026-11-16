import {blockState} from './block-interactions.mjs';

const items = (title, size, type, field = 'Items', options = {}) => ({title, size, type, field, ...options});
const chest = items('Сундук', 27, 'Chest', 'Items', {lid:'open', pair:true});
const ender = items('Сундук Края', 27, 'EnderChest', 'EnderItems', {lid:'open', personal:true});
const furnace = items('Печь', 3, 'Furnace');
const fridge = items('Холодильник', 9, 'TileEntityIronBlocksOne', 'FriFreItems', {lid:'open'});
const freezer = {...fridge, title:'Морозильник'};
const dishwasher = items('Посудомоечная машина', 5, 'TileEntityIronBlocksTwo', 'dwItems', {lid:'open'});
const kitchenCupboard = items('Кухонный шкаф', 9, 'TileEntityWoodBlocksTwo');
const bathroomCupboard = items('Шкафчик для ванной', 8, 'TileEntityCeramicBlocksOne');
const clockMiddle = items('Напольные часы', 6, 'TileEntityWoodBlocks');
const campfire = items('Костёр', 5, 'Campfire');

const variants = {
  201: {0:kitchenCupboard, 4:kitchenCupboard},
  205: {
    0:fridge, 4:freezer, 8:items('Кухонная плита', 5, 'TileEntityIronBlocksOne','CookerItems'),
    12:items('Мусорное ведро', 27, 'TileEntityIronBlocksOne','BinItems'),
  },
  206: {0:dishwasher, 4:items('Стиральная машина', 5, 'TileEntityIronBlocksTwo','wmItems')},
  207: {0:bathroomCupboard},
  751: {
    0:items('Печь для сплавов', 11, 'RPAFurnace'),
    1:items('Электропечь', 2, 'RPBFurnace'),
    2:items('Буфер', 20, 'RPBuffer'),
    3:items('Проектный стол', 28, 'RPAdvBench'),
    4:items('Электропечь для сплавов', 10, 'RPBAFurnace'),
    5:items('Зарядный стол', 16, 'RPCharge'),
  },
  761: {2:items('Дисковод RedPower', 1, 'RPConDDrv')},
  763: {
    0:items('Установщик', 9, 'RPDeploy'),
    3:items('Фильтр', 9, 'RPFilter'),
    4:items('Детектор предметов', 9, 'RPItemDet'),
    5:items('Сортировщик', 40, 'RPSorter'),
    6:items('Аккумулятор', 2, 'RPBatBox'),
    8:items('Ретри́вер', 9, 'RPRetrieve'),
    9:items('Ветрогенератор', 1, 'RPWind'),
    10:items('Регулятор', 27, 'RPRegulate'),
    13:items('Сборщик', 34, 'RPAssemble'),
    14:items('Выбрасыватель', 9, 'RPEject'),
    15:items('Реле', 9, 'RPRelay'),
  },
  766: {1:items('Менеджер', 24, 'RPManager')},
};

const blocks = {
  23:items('Раздатчик', 9, 'Trap'),
  54:chest,
  61:furnace,
  62:furnace,
  84:items('Проигрыватель', 1, 'RecordPlayer', 'RecordItem', {single:true, filter:'record'}),
  117:items('Варочная стойка', 4, 'Cauldron'),
  130:ender,
  2248:items('Письменный стол', 9, 'WritingDeskTile', 'Inventory', {filter:'desk'}),
  2249:items('Стойка для брони', 4, 'ArmorStandTile', 'StandInventory', {filter:'armor'}),
  2250:items('Книжный шкаф', 16, 'BookcaseTile', 'Inventory', {filter:'book'}),
  2251:items('Деревянная табличка для предметов', 3, 'WoodLabelTile', 'LabelInventory', {limit:1}),
  2252:items('Полка для зелий', 12, 'PotionShelfTile', 'PotionInventory', {filter:'potion', limit:1}),
  2253:items('Стойка для инструментов', 4, 'ToolRackTile', 'RackInventory', {limit:1}),
  2254:items('Полка', 4, 'GenericShelfTile', 'ShelfInventory', {limit:1}),
  2255:items('Витрина для оружия', 1, 'WeaponCaseTile', 'CaseInventory', {lid:'LidOpen', limit:1}),
  3000:campfire,
  3001:campfire,
  3255:items('Облачная дробилка', 3, 'mlb_cloudmasher'),
  3256:items('Облачная дробилка', 3, 'mlb_cloudmasher'),
};

export function containerSpec(cell) {
  const [id, meta] = blockState(cell);
  if (id === 200) return meta >= 1 && meta <= 4 ? clockMiddle : undefined;
  if (id === 2249 && meta >= 4) return undefined;
  const variant = id >= 200 && id <= 207 ? meta & 12 : meta;
  return blocks[id] ?? variants[id]?.[variant];
}

export function containerVisualState(spec, slots) {
  if (spec.type === 'BookcaseTile') return {
    filledTopSlots:slots.slice(0,8).filter(Boolean).length,
    filledBottomSlots:slots.slice(8).filter(Boolean).length,
  };
  if (spec.type === 'WritingDeskTile') return {
    hasWrittenBook:Boolean(slots[0]),
    leftBookStack:slots.slice(1,5).filter(Boolean).length,
    rightBookStack:slots.slice(5).filter(Boolean).length,
  };
  return {};
}

export function withoutContainerContents(cell, object) {
  const spec=containerSpec(cell);
  if (!spec || !object?.data) return object;
  const data={...object.data,...containerVisualState(spec,[])};
  delete data[spec.field];
  if (spec.single) delete data.Record;
  return {...object,data};
}
