import {intersectSelection} from './selection.mjs';

export function isRideableMinecart(entity) {
  return entity?.type === 'Minecart' && entity.data?.Type === 0 && typeof entity.key === 'string' &&
    Array.isArray(entity.position) && entity.position.length === 3 && entity.position.every(Number.isFinite);
}

export function minecartRotation(entity) {
  const yaw = entity.data?.Rotation?.[0];
  return Math.PI - (Number.isFinite(yaw) ? yaw * Math.PI / 180 : 0);
}

export function minecartTilt(entity) {
  const tilt = entity.data?.Rotation?.[1];
  return Number.isFinite(tilt) ? tilt * Math.PI / 180 : 0;
}

// Minecraft 1.4.7 model and its original 64×32 atlas, in 1/16-block units.
const parts = [
  {size:[20,16,2], offset:[-10,-8,-1], pivot:[0,4,0], uv:[0,10], pitch:Math.PI/2},
  {size:[16,8,2], offset:[-8,-9,-1], pivot:[-9,4,0], uv:[0,0], yaw:3*Math.PI/2},
  {size:[16,8,2], offset:[-8,-9,-1], pivot:[9,4,0], uv:[0,0], yaw:Math.PI/2},
  {size:[16,8,2], offset:[-8,-9,-1], pivot:[0,4,-7], uv:[0,0], yaw:Math.PI},
  {size:[16,8,2], offset:[-8,-9,-1], pivot:[0,4,7], uv:[0,0]},
  {size:[18,14,1], offset:[-9,-7,-1], pivot:[0,4.1,0], uv:[44,10], pitch:-Math.PI/2},
];
const faces = [[5,1,2,6],[0,4,7,3],[5,4,0,1],[2,3,7,6],[1,0,3,2],[4,5,6,7]];
const corners = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];

function rotateMinecart([x,y,z], yaw) {
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  return [x * cos + z * sin, y, -x * sin + z * cos];
}

function modelPart({size,offset,pivot,uv:[u,v],pitch = 0,yaw = 0}) {
  const [width,height,depth] = size;
  const vertices = corners.map(corner => {
    const [x,y,z] = corner.map((value,axis) => offset[axis] + value * size[axis]);
    const rotated = rotateMinecart([x, y * Math.cos(pitch) - z * Math.sin(pitch),
      y * Math.sin(pitch) + z * Math.cos(pitch)],yaw);
    return rotated.map((value,axis) => (value + pivot[axis]) * (axis < 2 ? -1 : 1) / 16);
  });
  const top = v + depth, bottom = top + height;
  const widths = [u,u+depth,u+depth+width,u+2*depth+width,u+2*(depth+width)];
  const [a,b,c,d,e] = widths;
  const regions = [[c,top,d,bottom],[a,top,b,bottom],[b,v,c,top],
    [c,top,c+width,v],[b,top,c,bottom],[d,top,e,bottom]];
  const box = Object.fromEntries(['x','y','z'].flatMap((axis,index) => {
    const values = vertices.map(vertex => vertex[index]);
    return [[axis+'0',Math.min(...values)],[axis+'1',Math.max(...values)]];
  }));
  return {box, quads:faces.map((face,i) => {
    const [u0,v0,u1,v1] = regions[i];
    return {positions:face.flatMap(index => vertices[index]),
      uv:[u1/64,v0/32,u0/64,v0/32,u0/64,v1/32,u1/64,v1/32]};
  })};
}

const models = parts.map(modelPart);
export const minecartQuads = models.flatMap(({quads}) => quads);

export function minecartHit(entity, origin, direction, range = 6) {
  const yaw = minecartRotation(entity);
  const tilt = -minecartTilt(entity);
  const sin = Math.sin(tilt), cos = Math.cos(tilt);
  const local = vector => {
    const [x,y,z] = rotateMinecart(vector,-yaw);
    return [x*cos-y*sin,x*sin+y*cos,z];
  };
  const ray = local(origin.map((n,axis) => n - entity.position[axis]));
  const forward = local(direction);
  let distance = Infinity;
  for (const {box} of models) {
    const hit = intersectSelection(ray,forward,box,0,0,0,range);
    if (hit && hit.length < distance) distance = hit.length;
  }
  return distance;
}

export function minecartSeat(entity, heading) {
  const [x,y,z] = entity.position;
  const yaw = minecartRotation(entity) + Math.PI / 2;
  return {x,y:y - 3/16,z,yaw:Math.cos(heading - yaw) < 0 ? yaw + Math.PI : yaw};
}
