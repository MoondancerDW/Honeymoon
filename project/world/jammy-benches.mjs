const benches = new WeakMap();
const chairKey = /^legacy:(\d+):([0-3])$/;

export function jammyBenchState(catalog, cell) {
  const key = typeof cell === 'string' ? cell : cell?.key;
  const match = chairKey.exec(key ?? '');
  // Older extracted catalogs predate the bench metadata. The bundled map uses block 203.
  if (!match || Number(match[1]) !== (catalog?.benchId ?? 203) || !catalog?.models[key]) return null;
  const adjustable = cell?.object?.type === 'JammyBench';
  const turns = adjustable ? cell.object.data?.rotation ?? 0 : 0;
  const rotation = (Number(match[2]) + turns) & 3;
  return {key: `legacy:${match[1]}:${rotation}`, rotation, adjustable};
}

function stretchBoard(surfaces, axis, left, right) {
  const coordinates = surfaces.flatMap(({positions}) => [positions[axis], positions[3 + axis],
    positions[6 + axis], positions[9 + axis]]);
  const min = Math.min(...coordinates), max = Math.max(...coordinates);
  return surfaces.flatMap(surface => {
    const edge = [0, 3, 6, 9].map(offset => surface.positions[offset + axis]);
    if (left && edge.every(value => value === min) || right && edge.every(value => value === max)) return [];
    const positions = surface.positions.map((value, index) => {
      if (index % 3 !== axis) return value;
      if (value === min && left) return 0;
      if (value === max && right) return 1;
      return value;
    });
    return [{...surface, positions}];
  });
}

export function jammyBenchModel(catalog, cell, neighbors) {
  const state = jammyBenchState(catalog, cell);
  if (!state) return null;
  const {key, rotation, adjustable} = state;
  const model = catalog.models[key];
  if (!model || !neighbors) return model ?? null;
  const sideways = rotation & 1;
  const joined = direction => {
    const neighbor = jammyBenchState(catalog, neighbors(sideways ? 0 : direction, 0, sideways ? direction : 0));
    return neighbor?.key === key && (adjustable || neighbor.adjustable);
  };
  const low = joined(-1), high = joined(1);
  if ((!low && !high) || model.surfaces.length !== 36) return model;
  if (!benches.has(model)) benches.set(model, new Map());
  const variants = benches.get(model);
  const variant = Number(low) | Number(high) << 1;
  if (!variants.has(variant)) {
    const axis = sideways ? 2 : 0;
    const lowEdge = sideways ? 'z0' : 'x0';
    const highEdge = sideways ? 'z1' : 'x1';
    // The capture emits four legacy legs, then six quads each for the seat and backrest.
    // Keep the original supports and only open the joined ends of the two wooden boards.
    const surfaces = [...model.surfaces.slice(0, 24),
      ...stretchBoard(model.surfaces.slice(24, 30), axis, low, high),
      ...stretchBoard(model.surfaces.slice(30, 36), axis, low, high)];
    const extend = box => ({...box, [lowEdge]: low ? 0 : box[lowEdge], [highEdge]: high ? 1 : box[highEdge]});
    variants.set(variant, {...model, surfaces, collision: model.collision.map(extend), selection: model.selection.map(extend)});
  }
  return variants.get(variant);
}
