import { biblioFor } from './biblio-models.mjs';
import { isJammySofa, jammySofaModel } from './jammy-sofas.mjs';
import { redPowerLamp } from './redpower-lamps.mjs';

export const modelFamilies = ['jammy', 'biblio', 'redpower'];

export function placementModelObject(catalogs, key, copiedObject, position, turns = 0) {
  let object = copiedObject;
  if (isJammySofa(catalogs?.jammy, key)) {
    const copiedTurns = copiedObject?.type === 'JammySofa' ? copiedObject.data?.rotation ?? 0 : 0;
    const rotation = (copiedTurns + turns) & 3;
    object = {type: 'JammySofa', data: rotation ? {rotation} : {}};
  }
  return object ? { ...object, position, key: `tile:${position.join(':')}` } : null;
}

export function extractedModel(catalogs, cell, neighbors) {
  const key = typeof cell === 'string' ? cell : cell?.key;
  if (!catalogs || !key?.startsWith('legacy:')) return null;
  if (catalogs.redpower && key.startsWith('legacy:768:')) return redPowerLamp(catalogs.redpower, cell?.object?.data);
  const jammy = catalogs.jammy?.models[key];
  if (jammy) {
    const model = jammySofaModel(catalogs.jammy, cell, neighbors) ?? jammy;
    return { ...model, family: 'jammy',
      surfaces: cell?.object?.data?.open && model.openSurfaces ? model.openSurfaces : model.surfaces };
  }
  if (!catalogs.biblio?.models[key]) return null;
  const [, id, meta] = key.split(':');
  const biblio = biblioFor(catalogs.biblio, Number(id), Number(meta), cell?.object?.data);
  return biblio && { ...biblio, family: 'biblio' };
}

export function withExtractedModels(geometry, catalogs) {
  return {
    ...geometry,
    isSofa: key => isJammySofa(catalogs?.jammy, key),
    neighborCollisionShapeDependsOn: cell => cell?.object?.type === 'JammySofa'
      || Boolean(geometry.neighborCollisionShapeDependsOn?.(cell)),
    placementObject: (key, copiedObject, position, turns) => placementModelObject(catalogs, key, copiedObject, position, turns),
    collisionFor: (cell, neighbors) => extractedModel(catalogs, cell, neighbors)?.collision ?? geometry.collisionFor(cell, neighbors),
    shapeFor: (cell, neighbors) => extractedModel(catalogs, cell, neighbors)?.selection ?? geometry.shapeFor(cell, neighbors),
    selectionFor: (cell, neighbors) => extractedModel(catalogs, cell, neighbors)?.selection ??
      (geometry.selectionFor ?? geometry.shapeFor)(cell, neighbors),
  };
}
