import {intersectSelection} from './selection.mjs';

export function isRideableBoat(entity) {
  return entity?.type === 'Boat' && typeof entity.key === 'string' &&
    entity.position?.length === 3 && entity.position.every(Number.isFinite);
}

export function boatHeading(entity) {
  const yaw = entity.data?.Rotation?.[0];
  return Number.isFinite(yaw) ? yaw * Math.PI / 180 : 0;
}

export function boatSeat(entity) {
  const [x,y,z] = entity.position;
  return {x,y:y+.10,z,yaw:boatHeading(entity),kind:'boat'};
}

export function boatHit(entity,origin,direction,range = 6) {
  const yaw = boatHeading(entity), sin = Math.sin(yaw), cos = Math.cos(yaw);
  const local = ([x,y,z]) => [x*cos-z*sin,y,x*sin+z*cos];
  const eye = local(origin.map((value,index) => value - entity.position[index]));
  const box = {x0:-.61,x1:.61,y0:0,y1:.45,z0:-.82,z1:.82};
  return intersectSelection(eye,local(direction),box,0,0,0,range)?.length ?? Infinity;
}
