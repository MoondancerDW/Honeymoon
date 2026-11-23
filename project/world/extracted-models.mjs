import { biblioFor } from './biblio-models.mjs';
import { jammyBenchModel, jammyBenchState } from './jammy-benches.mjs';
import { isJammySofa, jammySofaModel } from './jammy-sofas.mjs';
import { redPowerLamp } from './redpower-lamps.mjs';
import {placementHeading} from './placement-heading.mjs';

export const modelFamilies = ['jammy', 'biblio', 'redpower'];

export const isJammyConnectableSeat = (catalog, key) =>
  isJammySofa(catalog, key) || Boolean(jammyBenchState(catalog, key));

export function placementModelObject(catalogs, key, copiedObject, position, turns = 0, yaw) {
  let object = copiedObject;
  if (isJammyConnectableSeat(catalogs?.jammy, key)) {
    const type = isJammySofa(catalogs.jammy, key) ? 'JammySofa' : 'JammyBench';
    const copiedTurns = copiedObject?.type === type ? copiedObject.data?.rotation ?? 0 : 0;
    const initial=yaw===undefined?copiedTurns:2-placementHeading(yaw)-Number(key.split(':')[2]);
    const rotation = (initial + turns) & 3;
    object = {type, data: rotation ? {rotation} : {}};
  }
  return object ? { ...object, position, key: `tile:${position.join(':')}` } : null;
}

export function extractedModel(catalogs, cell, neighbors) {
  const key = typeof cell === 'string' ? cell : cell?.key;
  if (!catalogs || !key?.startsWith('legacy:')) return null;
  if (catalogs.redpower && key.startsWith('legacy:768:')) return redPowerLamp(catalogs.redpower, cell?.object?.data);
  const jammy = catalogs.jammy?.models[key];
  if (jammy) {
    const model = jammySofaModel(catalogs.jammy, cell, neighbors) ??
      jammyBenchModel(catalogs.jammy, cell, neighbors) ?? jammy;
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
    isSofa: key => isJammyConnectableSeat(catalogs?.jammy, key),
    neighborCollisionShapeDependsOn: cell => isJammyConnectableSeat(catalogs?.jammy, cell)
      || Boolean(geometry.neighborCollisionShapeDependsOn?.(cell)),
    placementObject: (key, copiedObject, position, turns, yaw) => placementModelObject(catalogs, key, copiedObject, position, turns,yaw),
    collisionFor: (cell, neighbors) => extractedModel(catalogs, cell, neighbors)?.collision ?? geometry.collisionFor(cell, neighbors),
    shapeFor: (cell, neighbors) => extractedModel(catalogs, cell, neighbors)?.selection ?? geometry.shapeFor(cell, neighbors),
    selectionFor: (cell, neighbors) => extractedModel(catalogs, cell, neighbors)?.selection ??
      (geometry.selectionFor ?? geometry.shapeFor)(cell, neighbors),
  };
}
