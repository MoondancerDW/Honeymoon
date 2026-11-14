import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {creativeMicroblock} from '../world/creative-items.mjs';
import {isCoverMaterial} from '../world/geometry.mjs';

export function readCreativeCatalog(generated, project = fileURLToPath(new URL('..', import.meta.url))) {
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(join(generated, 'creative', 'catalog.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { catalog = JSON.parse(readFileSync(join(project, 'world', 'creative-catalog.json'), 'utf8')); }
    catch (fallback) { if (fallback.code === 'ENOENT') return null; throw fallback; }
  }
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.entries)) throw new Error('Invalid creative catalog');
  const placeable = new Set();
  const items = new Map();
  for (const entry of catalog.entries) {
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
  if (catalog.counts) catalog.counts.placeable = catalog.entries.filter(entry => entry.placeable !== false).length;
  return {catalog, placeable, items};
}
