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
