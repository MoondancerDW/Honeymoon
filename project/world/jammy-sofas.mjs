const directions = [[1, 0], [0, 1], [-1, 0], [0, -1]];

function sofaState(catalog, cell) {
  const ids = catalog?.sofaIds;
  const key = typeof cell === 'string' ? cell : cell?.key;
  if (!ids || !key?.startsWith('legacy:')) return null;
  const [, block, metadata] = key.split(':');
  const id = Number(block), meta = Number(metadata);
  if (!Number.isInteger(meta) || meta < 0 || meta > 15) return null;
  const role = id === ids.left ? 'left' : id === ids.right ? 'right' :
    id === ids.center ? 'center' : id === ids.corner ? 'corner' : null;
  if (!role) return null;
  const automatic = cell?.object?.type === 'JammySofa';
  const turns = automatic ? cell.object.data?.rotation ?? 0 : 0;
  return {role, color: meta & 12, rotation: (meta + turns) & 3, automatic};
}

export function isJammySofa(catalog, key) {
  return Boolean(sofaState(catalog, key));
}

function ports({role, rotation, automatic}) {
  // The native model's orientation zero faces north. Its corner backs sit
  // on the west and south edges, and the arm on the left-end model sits east.
  const opposite = (rotation + 2) & 3;
  const back = (rotation + 1) & 3;
  if (role === 'corner') return [[rotation, back], [(rotation + 3) & 3, opposite]];
  if (!automatic && role === 'left') return [[opposite, back]];
  if (!automatic && role === 'right') return [[rotation, back]];
  return [[rotation, back], [opposite, back]];
}

export function jammySofaModel(catalog, cell, neighbors) {
  if (cell?.object?.type !== 'JammySofa' || !neighbors) return null;
  const sofa = sofaState(catalog, cell);
  if (!sofa) return null;
  const [along, across] = ports(sofa);
  const connected = ([direction, back]) => {
    const [dx, dz] = directions[direction];
    const neighbor = sofaState(catalog, neighbors(dx, 0, dz));
    return neighbor?.color === sofa.color && ports(neighbor).some(([side, neighborBack]) =>
      side === ((direction + 2) & 3) && neighborBack === back);
  };

  const joinsAlong = connected(along);
  const joinsAcross = connected(across);
  let role = 'chair';
  let rotation = sofa.rotation;
  if (joinsAlong && joinsAcross) role = sofa.role === 'corner' ? 'corner' : 'center';
  else if (joinsAlong) role = 'right';
  else if (joinsAcross) {
    role = 'left';
    if (sofa.role === 'corner') rotation = (rotation + 1) & 3;
  }
  return catalog.models[`legacy:${catalog.sofaIds[role]}:${sofa.color | rotation}`] ?? null;
}
