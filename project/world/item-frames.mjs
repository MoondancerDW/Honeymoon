import {signalSides} from './block-interactions.mjs';
import {creativeIcon,shapeFor,tiles} from './geometry.mjs';
import {intersectSelection} from './selection.mjs';

const LEGACY_SIDES = [3,4,2,5];
const YAW = [0,0,Math.PI,0,-Math.PI/2,Math.PI/2];
const QUAD_UV = [0, 1, 1, 1, 1, 0, 0, 0];

function quad(positions, [u0, v0, u1, v1], coords = QUAD_UV) {
  return {positions, uv: coords.map((coord, i) => i & 1 ? v0 + coord * (v1 - v0) : u0 + coord * (u1 - u0))};
}

function cuboid([x0, y0, z0, x1, y1, z1], uv) {
  return [
    [x0,y0,z0, x1,y0,z0, x1,y0,z1, x0,y0,z1],
    [x0,y1,z1, x1,y1,z1, x1,y1,z0, x0,y1,z0],
    [x1,y0,z0, x0,y0,z0, x0,y1,z0, x1,y1,z0],
    [x0,y0,z1, x1,y0,z1, x1,y1,z1, x0,y1,z1],
    [x0,y0,z0, x0,y0,z1, x0,y1,z1, x0,y1,z0],
    [x1,y0,z1, x1,y0,z0, x1,y1,z0, x1,y1,z1],
  ].map((points, side) => quad(points, uv[side]));
}

function terrainBox(bounds, tile) {
  const u = tile % 64, v = Math.floor(tile / 64);
  const uv = [(u + .002) / 64, (v + .002) / 64, (u + .998) / 64, (v + .998) / 64];
  const axes = [[0, 2], [0, 2], [0, 1], [0, 1], [2, 1], [2, 1]];
  return cuboid(bounds, Array(6).fill(uv)).map(({positions}, side) => {
    const [a, b] = axes[side];
    const coords = [];
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i + a] + (a === 2 ? 0 : .5);
      const y = positions[i + b] + (b === 2 ? 0 : .5);
      coords.push(side === 2 || side === 5 ? 1 - x : x, b === 2 ? y : 1 - y);
    }
    return quad(positions, uv, coords);
  });
}

// RenderItemFrame builds five cuboids: recessed 10-pixel back plus a 1-pixel spruce rim.
const frame = [
  [[-5/16,-5/16,0,5/16,5/16,1/32], 185],
  [[-6/16,-6/16,0,6/16,-5/16,1/16], 214],
  [[-6/16,5/16,0,6/16,6/16,1/16], 214],
  [[-6/16,-5/16,0,-5/16,5/16,1/16], 214],
  [[5/16,-5/16,0,6/16,5/16,1/16], 214],
].flatMap(([bounds, tile]) => terrainBox(bounds, tile));

function atlasRect(tile,rows) {
  const u = tile % 64, v = Math.floor(tile / 64);
  return [(u + .002)/64,(v + .002)/rows,(u + .998)/64,(v + .998)/rows];
}

function blockItem({id,Damage = 0},rows) {
  const key = 'legacy:' + id + ':' + (Damage & 15);
  const [shape] = shapeFor(key);
  if (shape?.solid && !shape.kind && shape.mode === 'opaque') {
    return {faces:shape.faces.map(tile => atlasRect(tile,rows))};
  }
  return {uv:atlasRect(creativeIcon({key})?.tile ?? tiles.unknown,rows)};
}

function displayItem(item, turns) {
  if (!item) return [];
  const depth = 6 / 128;
  const spin = (turns & 3) * Math.PI / 2;
  const sine = Math.sin(spin), cosine = Math.cos(spin);
  if (item.faces) {
    const size = 5 / 32;
    const halfDepth = item.cover ? size / 8 : size;
    return cuboid([-size, -size, -halfDepth, size, size, halfDepth], item.faces).map(surface => ({
      ...surface, positions: surface.positions.map((point, index, points) => {
        const axis = index % 3;
        if (axis === 0) return point * cosine - points[index + 1] * sine;
        if (axis === 1) return points[index - 1] * sine + point * cosine;
        return depth + halfDepth + point;
      }),
    }));
  }
  if (!item.uv) return [];
  const size = item.map ? 71 / 256 : .5128205 / 2;
  const height = item.map ? 0 : .02;
  const points = [[-size,-size], [size,-size], [size,size], [-size,size]]
    .flatMap(([x,y]) => [x * cosine - y * sine, x * sine + y * cosine + height, depth]);
  return [quad(points, item.uv)];
}

export function itemFrameMount(entity) {
  const {Dir, Direction, TileX, TileY, TileZ, Item, ItemRotation} = entity.data ?? {};
  // EntityHanging saved north/south reversed in Dir for older readers.
  const dir = Number.isInteger(Direction) && Direction >= 0 && Direction < 4 ? Direction
    : Number.isInteger(Dir) && Dir >= 0 && Dir < 4 ? Dir ^ (Dir & 1 ? 0 : 2) : -1;
  const side = entity.data?.MountSide ?? LEGACY_SIDES[dir];
  const normal = signalSides[side];
  if (!normal) return null;
  const fromTile = [TileX, TileY, TileZ].every(Number.isInteger);
  const position = fromTile ? [TileX + .5, TileY + .5, TileZ + .5] : entity.position;
  if (!position?.every(Number.isFinite)) return null;
  const center = position.map((value, axis) => value + normal[axis] * (fromTile ? .5 : -1 / 16));
  const rotationY = side <= 1 ? (entity.data?.MountTurn & 3) * Math.PI / 2 : YAW[side];
  const rotationX = side === 1 ? -Math.PI / 2 : side === 0 ? Math.PI / 2 : 0;
  return {center,normal,side,rotationY,rotationX,support:fromTile ? [TileX,TileY,TileZ] : null,Item,ItemRotation};
}

export function itemFrameModel(entity, items, atlasRows = 64) {
  const mount = itemFrameMount(entity);
  if (!mount) return null;
  const {Item:stack,ItemRotation} = mount;
  const atlasItem = stack && items?.[stack.id + ':' + (stack.Damage ?? 0)];
  const terrainItem = stack && !atlasItem && (stack.Block || stack.id < 256);
  const item = terrainItem ? blockItem(stack,atlasRows) : atlasItem;
  const scale = 64 / atlasRows;
  const surfaces = entity.data?.Invisible ? [] : scale === 1 ? frame : frame.map(quad => ({
    ...quad,uv:quad.uv.map((coordinate,index) => index & 1 ? coordinate * scale : coordinate),
  }));
  return {...mount,frame:surfaces,item:displayItem(item,ItemRotation),terrainItem};
}

export function itemFrameHit(entity, origin, direction, range = 6) {
  const mount = itemFrameMount(entity);
  if (!mount) return Infinity;
  const {center,rotationX,rotationY} = mount;
  const cos = Math.cos(rotationY), sin = Math.sin(rotationY);
  const tilt = Math.sin(rotationX), incline = Math.cos(rotationX);
  const local = ([x,y,z]) => {
    const depth = x * sin + z * cos;
    return [x * cos - z * sin,y * incline + depth * tilt,depth * incline - y * tilt];
  };
  const eye = local(origin.map((value,index) => value - center[index]));
  const bounds = {x0:-.375,x1:.375,y0:-.375,y1:.375,z0:.001,z1:.065};
  return intersectSelection(eye,local(direction),bounds,0,0,0,range)?.length ?? Infinity;
}
