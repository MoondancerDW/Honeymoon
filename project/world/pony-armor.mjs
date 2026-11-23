export const equipmentLabels = ['Шлем', 'Нагрудник', 'Поножи', 'Ботинки'];

// Item IDs and equipment slots in the original Forge registry.
const families = [
  ['cloth',298], ['chain',302], ['iron',306], ['diamond',310], ['gold',314],
  ['reptile',[9049,9048,9050,9051]], ['fur',[9087,9086,9088,9089]],
  ['hide',[9104,9103,9105,9106]], ['desertScorpion',[9119,9118,9120,9121]],
  ['frostScorpion',[9123,9122,9124,9125]], ['caveScorpion',[9127,9126,9128,9129]],
  ['netherScorpion',[9131,9130,9132,9133]], ['hardened',15887],
  ['naga',[null,27958,27959]], ['ironwood',27975], ['fiery',27992], ['steeleaf',27999],
];

export const ponyArmorFamilies = families.map(([material]) => material);
const definitions = new Map();
for (const [material, ids] of families) {
  for (let slot = 0; slot < equipmentLabels.length; slot++) {
    const id = Array.isArray(ids) ? ids[slot] : ids + slot;
    if (id) definitions.set(id,{material,slot});
  }
}

export function ponyArmor(key) {
  const item = /^creative:(\d+):\d+$/.exec(key);
  return item ? definitions.get(Number(item[1])) : undefined;
}

const accessories = new Map();
// Lilium.Items registry IDs, grouped by the place where the accessory is worn.
const accessoryGroups = [
  [0,'hat',[5856,5857,5858,5859,5865,5930,5956,6286,6287,6288,6289,6308,6309,6310]],
  [0,'face',[5860,5861,5862,5863,5864,5866,6247,6291,6292,6293,6294,6295,6296,6297,6311]],
  [1,'neck',[5867,5868,5869,5870,5871,5872,5873,5874,5875,5876,5877,5878,5879,5880,5881,5882,5883,5884,5885,
    6246,6298,6299,6300,6301,6302,6303,6304,6305,6306,6307]],
  [1,'body',[6290]],
];
for (const [slot,placement,ids] of accessoryGroups) {
  for (const id of ids) accessories.set(`creative:${id}:0`,{id,slot,placement});
}

export const ponyAccessory = key => accessories.get(key);
export const ponyEquipment = key => ponyArmor(key) ?? ponyAccessory(key);
