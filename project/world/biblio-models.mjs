const ANGLES = {
  2248: 'deskAngle',
  2250: 'bookcaseAngle',
  2251: 'labelAngle',
  2252: 'potionshelfAngle',
  2253: 'rackAngle',
  2254: 'genericShelfAngle',
  2255: 'caseAngle',
};

const ITEM_SLOTS = {
  2251: 'LabelInventory',
  2252: 'PotionInventory',
  2253: 'RackInventory',
  2254: 'ShelfInventory',
  2255: 'CaseInventory',
};

const box = ([x0, y0, z0, x1, y1, z1]) => ({x0, y0, z0, x1, y1, z1});

function turn(x, z, angle) {
  switch (angle & 3) {
    case 0: return [1 - z, x];
    case 1: return [1 - x, 1 - z];
    case 2: return [z, 1 - x];
    default: return [x, z];
  }
}

function boundsFor(id, angle) {
  if (id === 2240) return [];
  if (id === 2248) return [box([0, 0, 0, 1, 1, 1])];
  let bounds = [0, 0, 0, 1, 1, 0.5];
  if (id === 2249) bounds = [0, 0, 0.3, 1, 1, 0.7];
  if (id === 2251) bounds = [0.3, 0.2, 0, 0.7, 0.4, 0.06];
  if (id === 2255) bounds = angle < 4 ? [0, 0, 0.06, 1, 0.5, 0.94] : [0.06, 0, 0, 0.94, 1, 0.5];
  const [x0, y0, z0, x1, y1, z1] = bounds;
  const [a, b] = turn(x0, z0, angle);
  const [c, d] = turn(x1, z1, angle);
  return [box([Math.min(a, c), y0, Math.min(b, d), Math.max(a, c), y1, Math.max(b, d)])];
}

function rotateSurface(surface, angle) {
  if ((angle & 3) === 3) return surface;
  const positions = [];
  for (let i = 0; i < surface.positions.length; i += 3) {
    const [x, y, z] = surface.positions.slice(i, i + 3);
    const [tx, tz] = turn(x, z, angle);
    positions.push(tx, y, tz);
  }
  return {...surface, positions};
}

function itemQuad(positions, [u0, v0, u1, v1]) {
  return {positions, uv: [u0, v1, u1, v1, u1, v0, u0, v0], mode: 'cutout'};
}

function itemCube({faces}, [x, y, z], size) {
  const x0 = x - size / 2, x1 = x + size / 2;
  const y0 = y - size / 2, y1 = y + size / 2;
  const z0 = z - size / 2, z1 = z + size / 2;
  return [
    [x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1],
    [x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0],
    [x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0],
    [x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1],
    [x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0],
    [x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1],
  ].map((positions, i) => itemQuad(positions, faces[i]));
}

function itemSprite({uv}, [x, y, z], size, horizontal) {
  const half = size / 2;
  if (horizontal) return itemQuad([
    x - half, y, z + half, x + half, y, z + half,
    x + half, y, z - half, x - half, y, z - half,
  ], uv);
  return itemQuad([
    x - half, y - half, z, x + half, y - half, z,
    x + half, y + half, z, x - half, y + half, z,
  ], uv);
}

function itemPlacement(id, angle, slot, item, items) {
  if (id === 2251) {
    const x = [0.5, 0.35, 0.65][slot];
    const centerOnly = slot === 0 && items.length === 1;
    const block = item.block || item.faces;
    const scale = block ? (centerOnly ? .8 : .45) : (centerOnly ? .6 : .35);
    const blockLift = block ? (centerOnly ? .048 : slot === 0 ? .009 : .05) : 0;
    return [[x, (slot === 0 ? .17 : .25) + blockLift, .048], scale];
  }
  if (id === 2252) return [[[.17, .4, .63, .86][slot % 4], [.7, .37, .02][slot >> 2], .25], .7];
  if (id === 2253) return [[slot % 2 === 0 ? .3 : .7, slot < 2 ? .48 : .11, slot < 2 ? .4 : .42], 1];
  if (id === 2254) return [[slot % 2 === 0 ? .2 : .8, slot < 2 ? .59 : .10, .25], 1];
  const blockOffset = item.block || item.faces ? .12 : 0;
  return [angle > 3 ? [.5, .27 + blockOffset, .22] : [.45, .25, .73 + blockOffset], 1.2];
}

function displayContents(catalog, id, angle, data) {
  const items = data?.[ITEM_SLOTS[id]] ?? [];
  const surfaces = [];
  for (const stack of items) {
    const item = catalog.items?.[`${stack.id}:${stack.Damage ?? 0}`];
    if (!item) continue;
    const [position, scale] = itemPlacement(id, angle, stack.Slot, item, items);
    if (!position.every(Number.isFinite)) continue;
    if (item.faces) {
      position[1] += id === 2255 && angle < 4 ? .043 : scale * .1;
      surfaces.push(...itemCube(item, position, scale * .25));
    } else {
      const horizontal = id === 2255 && angle < 4;
      position[1] += horizontal ? .043 : scale * .225;
      surfaces.push(itemSprite(item, position, scale * .5, horizontal));
    }
  }
  return surfaces;
}

export function biblioFor(catalog, id, meta, data) {
  const name = `legacy:${id}:${meta}`;
  const model = catalog?.models?.[name];
  if (!model) return null;
  const angle = id === 2249 ? meta : (data?.[ANGLES[id]] ?? 3);
  const collision = boundsFor(id, angle);
  if (id === 2249 && meta >= 4) return {surfaces: [], collision, selection: collision};
  const groups = model.groups ?? {};
  const surfaces = id === 2255 && angle > 3 ? [...groups.wall] : [...model.surfaces];
  if (id === 2250) {
    for (const [field, prefix] of [['filledTopSlots', 'top'], ['filledBottomSlots', 'bottom']]) {
      for (let i = 1; i <= Math.min(data?.[field] ?? 0, 8); i++) surfaces.push(...groups[prefix + i]);
    }
  }
  if (id === 2248) {
    if (data?.hasWrittenBook) surfaces.push(...groups.written);
    for (const [field, prefix] of [['leftBookStack', 'left'], ['rightBookStack', 'right']]) {
      for (let i = 1; i <= Math.min(data?.[field] ?? 0, 4); i++) surfaces.push(...groups[prefix + i]);
    }
  }
  if (id === 2255) {
    const lid = angle > 3 ? 'wallLid' : 'floorLid';
    surfaces.push(...groups[data?.LidOpen ? lid + 'Open' : lid]);
  }
  if (id === 2249) {
    for (const item of data?.StandInventory ?? []) {
      const color = item.tag?.display?.color ?? (item.id === 6310 ? 0xffffff : 10511680);
      surfaces.push(...(catalog.armor?.[`${item.id}:${color}`] ?? []));
    }
  }
  surfaces.push(...displayContents(catalog, id, angle, data));
  return {surfaces: surfaces.map(surface => rotateSurface(surface, angle)), collision, selection: collision};
}
