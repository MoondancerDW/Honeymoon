import nativeTabs from '../world/creative-tab-order.mjs';

// The original game stocks these as items. Honeymoon places their block states.
const placementAliases = new Map([
  ['323:0','legacy:63:0'], ['324:0','legacy:64:0'], ['326:0','legacy:9:0'], ['327:0','legacy:11:0'],
  ['330:0','legacy:71:0'], ['331:0','legacy:55:0'], ['355:0','legacy:26:0'], ['356:0','legacy:93:0'],
]);

const registryCode = entry => Number.isInteger(entry.id)
  ? `${entry.id}:${entry.damage ?? entry.meta ?? 0}` : entry.key?.split(':').slice(1,3).join(':');

export function arrangeCreativeCatalog(entries) {
  const byKey = new Map(), byCode = new Map();
  for (const entry of entries) {
    const {key} = entry;
    if (!key) continue;
    const previous = byKey.get(key);
    if (!previous || previous.placeable === false && entry.placeable !== false) byKey.set(key,entry);
    const code = registryCode(entry);
    const registered = byCode.get(code);
    if (!registered || registered.technical && !entry.technical || registered.placeable === false && entry.placeable !== false) {
      byCode.set(code,entry);
    }
  }
  const cards = new Map();
  const tabs = nativeTabs.map(tab => {
    const selected = new Map();
    for (const code of tab.entries) {
      const original = byCode.get(code);
      const entry = byKey.get(placementAliases.get(code)) ?? original;
      if (entry && !selected.has(entry.key)) {
        const card = {entry,icon:original ?? entry,code};
        selected.set(entry.key,card);
        if (!cards.has(entry.key)) cards.set(entry.key,card);
      }
      if (entry?.key === 'creative:389:0' && byKey.has('creative:389:1')) {
        const invisible = byKey.get('creative:389:1');
        const card = {entry:invisible,icon:invisible,code:registryCode(invisible)};
        selected.set(invisible.key,card);
        cards.set(invisible.key,card);
      }
    }
    return {...tab, id:tab.id === 'search' ? 'all' : tab.id, iconEntry:byCode.get(tab.icon),cards:[...selected.values()]};
  });
  const aliases = new Set([...placementAliases].filter(([,key])=>byKey.has(key))
    .map(([code])=>byCode.get(code)?.key));
  const additional = [];
  for (const entry of byKey.values()) {
    if (cards.has(entry.key) || aliases.has(entry.key)) continue;
    const card = {entry,icon:entry,code:registryCode(entry)};
    if (!entry.technical && entry.placeable !== false) additional.push(card);
  }
  return {tabs,byKey,cards:[...cards.values(),...additional]};
}
