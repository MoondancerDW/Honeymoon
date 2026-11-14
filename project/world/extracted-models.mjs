import { biblioFor } from './biblio-models.mjs';
import { redPowerLamp } from './redpower-lamps.mjs';

export const modelFamilies = ['jammy', 'biblio', 'redpower'];

export function extractedModel(catalogs, cell) {
  const key = typeof cell === 'string' ? cell : cell?.key;
  if (!catalogs || !key?.startsWith('legacy:')) return null;
  if (catalogs.redpower && key.startsWith('legacy:768:')) return redPowerLamp(catalogs.redpower, cell?.object?.data);
  const jammy = catalogs.jammy?.models[key];
  if (jammy) return { ...jammy, family: 'jammy',
    surfaces: cell?.object?.data?.open && jammy.openSurfaces ? jammy.openSurfaces : jammy.surfaces };
  if (!catalogs.biblio?.models[key]) return null;
  const [, id, meta] = key.split(':');
  const biblio = biblioFor(catalogs.biblio, Number(id), Number(meta), cell?.object?.data);
  return biblio && { ...biblio, family: 'biblio' };
}

export function withExtractedModels(geometry, catalogs) {
  return {
    ...geometry,
    collisionFor: (cell, neighbors) => extractedModel(catalogs, cell)?.collision ?? geometry.collisionFor(cell, neighbors),
    shapeFor: (cell, neighbors) => extractedModel(catalogs, cell)?.selection ?? geometry.shapeFor(cell, neighbors),
  };
}
