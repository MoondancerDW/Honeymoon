import { cellAddress } from './base.mjs';
import { RequestError } from './errors.mjs';

const DIAGNOSTIC = 'diagnostic';
const WORLD = 'world';
const SWITCH = 'game:switch';
const DOOR = 'game:door';

function layoutNearSpawn(base, geometry) {
  const [sx, sy, sz] = base.manifest.spawn.map(Math.floor);
  const candidateY = [sy, sy - 1, sy + 1, sy - 2, sy + 2];
  const empty = (x, y, z) => base.inBounds(x, y, z) && base.getCell(x, y, z).key === 'air';
  const solidTop = (x, y, z) => {
    const cell = base.getCell(x, y, z);
    const parts = base.manifest.compositions?.[cell.key]?.parts;
    return geometry.collisionFor({ ...cell, parts })
      .some(box => box.y1 >= 1 && box.x0 <= 0.3 && box.x1 >= 0.7 && box.z0 <= 0.3 && box.z1 >= 0.7);
  };

  for (let distance = 2; distance <= 12; distance++) {
    for (const y of candidateY) {
      for (let dx = -distance; dx <= distance; dx++) {
        for (let dz = -distance; dz <= distance; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== distance) continue;
          const x = sx + dx;
          const z = sz + dz;
          for (const [doorX, doorZ] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]]) {
            if (!empty(x, y, z) || !empty(x, y + 1, z) || !solidTop(x, y - 1, z)) continue;
            if (!empty(doorX, y, doorZ) || !empty(doorX, y + 1, doorZ) || !solidTop(doorX, y - 1, doorZ)) continue;
            if (doorX === sx && doorZ === sz) continue;
            return { switch: [x, y, z], door: [[doorX, y, doorZ], [doorX, y + 1, doorZ]] };
          }
        }
      }
    }
  }
  return null;
}

function makeDiagnostics(base, store, geometry) {
  const savedLayout = store.getState(DIAGNOSTIC, WORLD, 'layout');
  const previous = savedLayout?.value;
  const valid = previous && [previous.switch, ...previous.door].every(position => base.inBounds(...position) && base.getCell(...position).key === 'air');
  const layout = valid ? previous : layoutNearSpawn(base, geometry);
  if (!valid && layout) store.putState(DIAGNOSTIC, WORLD, 'layout', 1, layout);
  const reserved = new Set(layout ? [layout.switch, ...layout.door].map(pos => cellAddress(...pos)) : []);
  const switchKey = layout && cellAddress(...layout.switch);

  function switchState() {
    const record = store.getState(DIAGNOSTIC, WORLD, 'door');
    return record?.value ?? { open: false, revision: 0 };
  }

  function cells(state) {
    if (!layout) return [];
    return [
      { x: layout.switch[0], y: layout.switch[1], z: layout.switch[2], cell: SWITCH, revision: state.revision, object: null },
      ...layout.door.map(([x, y, z]) => ({ x, y, z, cell: state.open ? null : DOOR, revision: state.revision, object: null })),
    ];
  }

  return {
    id: DIAGNOSTIC,
    version: 1,
    catalog: [SWITCH, DOOR],
    reserved(x, y, z) { return reserved.has(cellAddress(x, y, z)); },
    snapshot() { return cells(switchState()); },
    describe(player) {
      if (!layout) return null;
      const [x, y, z] = layout.switch;
      return {
        ...layout,
        flagZone: { minX: x, maxX: x + 1, minY: y, maxY: y + 2, minZ: z, maxZ: z + 1 },
        doorOpen: switchState().open,
        visited: Boolean(store.getState(DIAGNOSTIC, player, 'visited')?.value),
      };
    },
    prepareInteraction(context) {
      const { x, y, z, playerOverlaps } = context;
      if (cellAddress(x, y, z) !== switchKey) return null;
      const current = switchState();
      const open = !current.open;
      if (!open && layout.door.some(([dx, dy, dz]) => playerOverlaps(dx, dy, dz, DOOR))) {
        throw new RequestError(409, 'occupied');
      }
      return {
        cells: cells({ open, revision: 0 }),
        state: [{ owner: WORLD, key: 'door', value: { open }, useRevision: true }],
        effects: [{ type: 'door', open, message: open ? 'Дверь открыта' : 'Дверь закрыта' }],
      };
    },
    prepareEntry({ player, position }) {
      if (!layout || store.getState(DIAGNOSTIC, player, 'visited')?.value) return null;
      const [x, y, z] = layout.switch;
      if (position.x < x || position.x >= x + 1 || position.y < y || position.y >= y + 2 || position.z < z || position.z >= z + 1) return null;
      return {
        state: [{ owner: player, key: 'visited', value: true }],
        effects: [{ type: 'flag', flag: 'diagnostic.visited', message: 'Контрольная область посещена' }],
      };
    },
  };
}

export function registerMechanics(base, store, geometry) {
  return [makeDiagnostics(base, store, geometry)];
}
