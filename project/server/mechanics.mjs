import { cellAddress } from './base.mjs';
import { RequestError } from './errors.mjs';
import { biblioWeaponCase, blockKey, blockState, buttonDuration, jammyAppliance, jammyLamp, jammyUseSound, manualHatch, pressurePlate } from '../world/block-interactions.mjs';
import { paneOpaqueBlocks } from '../world/block-geometry-properties.mjs';
import { PLAYER } from './physics.mjs';
import { affectedCircuit, redstone, wireLevels } from './redstone.mjs';
import { musicBlocks, noteSound } from './music-blocks.mjs';

const DIAGNOSTIC = 'diagnostic';
const WORLD = 'world';
const SWITCH = 'game:switch';
const DOOR = 'game:door';
const CONTROL_TASKS = 'pending';
const CLICK_VOLUME = .3;

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
        effects: [doorEffect(open, layout.door[0])],
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

function doorEffect(open, position) {
  return {type: 'door', open, message: open ? 'Дверь открыта' : 'Дверь закрыта',
    sound: open ? 'door.open' : 'door.close', position};
}

const pointOf = cell => [cell.x, cell.y, cell.z];
const metaChanged = (cell, id, meta) => ({...cell, cell: blockKey(id, meta)});
const at = point => cellAddress(...point);

function clickEffect(cell, active) {
  return {type: 'control', sound: active ? 'click.on' : 'click.off', position: pointOf(cell),
    pitch: active ? .6 : .5, volume: CLICK_VOLUME};
}

function doorCells(current, getCell, playerOverlaps, desired) {
  const [id, meta] = blockState(current);
  if (id !== 64 && id !== 71) return null;
  const {x, y, z} = current;
  const lower = meta & 8 ? getCell(x, y - 1, z) : current;
  const upper = meta & 8 ? current : getCell(x, y + 1, z);
  const [lowerId, lowerMeta] = blockState(lower);
  const [upperId, upperMeta] = blockState(upper);
  if (lowerId !== id || upperId !== id || lowerMeta >= 8 || upperMeta < 8 || upperMeta > 15) return null;
  const open = desired ?? !Boolean(lowerMeta & 4);
  if (open === Boolean(lowerMeta & 4)) return null;
  const nextLower = metaChanged(lower, id, lowerMeta ^ 4);
  const plannedUpper = (dx, dy, dz) => dx === 0 && dy === 1 && dz === 0 ? upper.cell : undefined;
  const plannedLower = (dx, dy, dz) => dx === 0 && dy === -1 && dz === 0 ? nextLower.cell : undefined;
  if (playerOverlaps(x, lower.y, z, nextLower.cell, plannedUpper)
    || playerOverlaps(x, upper.y, z, upper.cell, plannedLower)) return {blocked: true};
  return {cells: [nextLower, upper], effects: [doorEffect(open, pointOf(lower))]};
}

const woodDoors = {
  id: 'wood-doors',
  version: 1,
  prepareInteraction({current, getCell, playerOverlaps}) {
    if (blockState(current)[0] !== 64) return null;
    const result = doorCells(current, getCell, playerOverlaps);
    if (result?.blocked) throw new RequestError(409, 'occupied');
    return result;
  },
};

function hatchCell(current, id, meta, open, playerOverlaps, playerPosition, yaw) {
  if (open === Boolean(meta & 4)) return null;
  let nextMeta = meta ^ 4;
  if (id === 107 && open && playerPosition) {
    // Minecraft compares the player's facing to the gate direction when opening by hand.
    const dx = current.x + .5 - playerPosition.x, dz = current.z + .5 - playerPosition.z;
    const facing = Math.round((yaw === undefined ? Math.atan2(-dx, dz) : Math.PI - yaw) / (Math.PI / 2)) & 3;
    if ((meta & 3) === (facing ^ 2)) nextMeta = facing | 4;
  }
  const change = metaChanged(current, id, nextMeta);
  if (playerOverlaps(current.x, current.y, current.z, change.cell)) return {blocked: true};
  const message = id === 96 ? (open ? 'Люк открыт' : 'Люк закрыт') : (open ? 'Калитка открыта' : 'Калитка закрыта');
  return {cells: [change], effects: [{...doorEffect(open, pointOf(current)), message}]};
}

function plateOccupied(players, x, y, z) {
  return players.some(player => player.x + PLAYER.halfWidth > x + .125 && player.x - PLAYER.halfWidth < x + .875
    && player.z + PLAYER.halfWidth > z + .125 && player.z - PLAYER.halfWidth < z + .875 && player.y >= y && player.y < y + .25);
}

function applianceAction(cell, name) {
  if (!cell.object) return null;
  const data = cell.object.data ?? {};
  const open = !data.open;
  return {
    cells: [{...cell, object: {...cell.object, data: {...data, open}}}],
    effects: [{type: 'appliance', open, message: name + (open ? ' · открыто' : ' · закрыто'),
      sound: open ? 'chest.open' : 'chest.close', volume: .5, position: pointOf(cell)}],
  };
}

const chestNeighbors = [[0, -1], [0, 1], [-1, 0], [1, 0]];
const isChest = id => id === 54 || id === 130;

function chestAction(current, getCell) {
  const [id] = blockState(current);
  const {x, y, z} = current;
  const neighbor = id === 54
    ? chestNeighbors.map(([dx, dz]) => getCell(x + dx, y, z + dz)).find(cell => blockState(cell)[0] === id)
    : undefined;
  const chests = neighbor ? [current, neighbor] : [current];
  const open = !chests.some(cell => cell.object?.data?.open);
  if (open && chests.some(cell => paneOpaqueBlocks.has(blockState(getCell(cell.x, y + 1, cell.z))[0]))) {
    throw new RequestError(409, 'occupied');
  }
  const cells = chests.map(cell => {
    const position = pointOf(cell);
    const object = cell.object ?? {type: id === 54 ? 'Chest' : 'EnderChest', position, key: `tile:${position.join(':')}`};
    return {...cell, object: {...object, data: {...object.data, open}}};
  });
  const position = pointOf(current).map((axis, i) => .5 + (axis + (neighbor ? pointOf(neighbor)[i] : axis)) / 2);
  return {cells, effects: [{type: 'appliance', open, message: open ? 'Сундук открыт' : 'Сундук закрыт',
    sound: open ? 'chest.open' : 'chest.close', volume: .5, position}]};
}

function weaponCaseAction(cell, playerPosition) {
  if (cell.object?.type !== 'WeaponCaseTile') return null;
  const data = cell.object.data ?? {};
  const open = !data.LidOpen;
  // The legacy block plays the lid sound at the player who opens it.
  const position = [playerPosition.x - .5, playerPosition.y - .5, playerPosition.z - .5];
  return {
    cells: [{...cell, object: {...cell.object, data: {...data, LidOpen: open}}}],
    effects: [{type: 'sound', sound: `jds.bibliocraft.sound.case${open ? 'open' : 'close'}`, position, volume: 1, pitch: 1}],
  };
}

function makeControls(base, geometry) {
  function plan(context) {
    const {getCell, now} = context;
    const tasks = {...context.readState(WORLD, CONTROL_TASKS)?.value};
    const updates = new Map(), effects = [];
    let dirty = false;
    const get = (x, y, z) => updates.get(cellAddress(x, y, z)) ?? getCell(x, y, z);
    const put = cell => { if (base.inBounds(cell.x, cell.y, cell.z)) updates.set(at(pointOf(cell)), cell); };
    function schedule(point, id, delay) {
      const key = at(point);
      if (tasks[key]?.id === id) return;
      tasks[key] = {id, at: now + delay};
      dirty = true;
    }
    function clear(key) {
      if (!Object.hasOwn(tasks, key)) return;
      delete tasks[key];
      dirty = true;
    }
    function finish() {
      return {
        cells: [...updates.values()], effects,
        state: dirty ? [{owner: WORLD, key: CONTROL_TASKS, value: tasks}] : [],
      };
    }
    return {get, put, effects, tasks, schedule, clear, finish};
  }

  function updatePower(context, current, sources, due = new Set()) {
    const prior = redstone(context.getCell, geometry, base.manifest.compositions);
    const lookup = redstone(current.get, geometry, base.manifest.compositions);
    const observed = new Set();
    let pending = sources;
    while (pending.length) {
      const {wires, receivers} = affectedCircuit(pending, lookup);
      const levels = wireLevels(wires, lookup);
      for (const [key, point] of wires) {
        const cell = current.get(...point);
        const [, meta] = blockState(cell);
        const next = levels.get(key) ?? 0;
        if (next !== meta) current.put(metaChanged(cell, 55, next));
      }
      pending = [];
      for (const [key, point] of receivers) {
        if (!due.has(key) || observed.has(key)) continue;
        const cell = current.get(...point);
        const [id, meta] = blockState(cell);
        if (id !== 75 && id !== 76 && id !== 93 && id !== 94) continue;
        observed.add(key);
        const repeater = id === 93 || id === 94;
        if (repeater && lookup.repeaterLocked(point, meta)) continue;
        const on = id === 76 || id === 94;
        const powered = repeater ? lookup.repeaterInput(point, meta) : !lookup.torchPowered(point, meta);
        if (on !== powered) {
          current.put(metaChanged(cell, repeater ? (powered ? 94 : 93) : (powered ? 76 : 75), meta));
          pending.push(point);
        }
      }
      if (pending.length) {
        pending = [...sources, ...pending];
        continue;
      }
      for (const [key, point] of receivers) {
        const cell = current.get(...point);
        const [id, meta] = blockState(cell);
        const torch = id === 75 || id === 76, repeater = id === 93 || id === 94;
        if (torch || repeater) {
          if (repeater && lookup.repeaterLocked(point, meta)) {
            current.clear(key);
            continue;
          }
          const powered = repeater ? lookup.repeaterInput(point, meta) : !lookup.torchPowered(point, meta);
          if (powered === (id === 76 || id === 94)) current.clear(key);
          else current.schedule(point, id, repeater ? 100 * ((meta >> 2) + 1) : 100);
          continue;
        }
        const side = cell.object?.data?.rot;
        const sides = id === 768 && Number.isInteger(side) && side >= 0 && side < 6 ? [side] : undefined;
        function inputPower(circuit) {
          return circuit.powered(point, true, sides) ||
            ((id === 64 || id === 71) && circuit.powered([cell.x, cell.y + 1, cell.z]));
        }
        const powered = inputPower(lookup);
        if (id === 25) {
          if (powered && !inputPower(prior)) {
            const effect = noteSound(current.get, ...point, cell.object?.data?.note ?? 0);
            if (effect) current.effects.push(effect);
          }
          continue;
        }
        if ((id === 64 || id === 71 || manualHatch(id)) && !due.has(key) && powered === inputPower(prior)) continue;
        if (id === 27 && prior.block(point)[0] === 27 && powered === inputPower(prior)) continue;
        applyReceiver(context, current, cell, id, meta, powered, due.has(key));
      }
    }
  }

  function applyReceiver(context, current, cell, id, meta, powered, due) {
    const point = pointOf(cell);
    if (id === 27) {
      const next = (meta & 7) | (powered ? 8 : 0);
      if (next !== meta) current.put(metaChanged(cell, id, next));
    } else if (id === 64 || id === 71 || manualHatch(id)) {
      const result = manualHatch(id) ? hatchCell(cell, id, meta, powered, context.playerOverlaps)
        : doorCells(cell, current.get, context.playerOverlaps, powered);
      if (result?.blocked) current.schedule(point, id, 100);
      else if (result) {
        result.cells.forEach(current.put);
        current.effects.push(...result.effects);
      }
    } else if (id === 768 && cell.object) {
      const flags = cell.object.data?.ps ?? 0;
      const ps = flags & ~1 | Number(powered);
      if (ps !== flags) current.put({...cell, object: {...cell.object, data: {...cell.object.data, ps}}});
    } else if (id >= 756 && id <= 759) {
      const nextId = id < 758 ? (powered ? 756 : 757) : (powered ? 759 : 758);
      if (nextId !== id) current.put(metaChanged(cell, nextId, meta));
    } else if (id === 123 || id === 124) {
      if ((id === 124) === powered) current.clear(at(point));
      else if (id === 124 && !due) current.schedule(point, id, 200);
      else current.put(metaChanged(cell, powered ? 124 : 123, meta));
    }
  }

  function triggerPlate(current, cell, id, powered) {
    const [, meta] = blockState(cell);
    if (Boolean(meta) !== powered) {
      current.put(metaChanged(cell, id, Number(powered)));
      current.effects.push(clickEffect(cell, powered));
    }
    if (powered) current.schedule(pointOf(cell), id, 1000);
    return Boolean(meta) !== powered;
  }

  return {
    id: 'block-controls',
    version: 1,
    prepareInteraction(context) {
      const {current: cell, playerOverlaps, playerPosition} = context;
      const [id, meta] = blockState(cell);
      if (isChest(id)) return chestAction(cell, context.getCell);
      if (biblioWeaponCase(id)) return context.input?.sneaking ? weaponCaseAction(cell, playerPosition) : null;
      const appliance = jammyAppliance(id, meta);
      if (appliance) return applianceAction(cell, appliance);
      const sound = jammyUseSound(id, meta);
      if (sound) return {effects: [{type: 'sound', sound, position: pointOf(cell), volume: 1, pitch: 1}]};
      if (jammyLamp(id)) return {cells: [metaChanged(cell, id === 219 ? 220 : 219, meta)]};
      if (id === 93 || id === 94) return {cells: [metaChanged(cell, id, (meta + 4) & 15)]};
      if (manualHatch(id)) {
        const result = hatchCell(cell, id, meta, !Boolean(meta & 4), playerOverlaps, playerPosition, context.input?.yaw);
        if (result?.blocked) throw new RequestError(409, 'occupied');
        return result;
      }
      const duration = buttonDuration(id);
      if (id !== 69 && !duration) return null;
      if (duration && (meta & 8)) return {};
      const current = plan(context);
      const point = pointOf(cell);
      current.put(metaChanged(cell, id, meta ^ 8));
      current.effects.push(clickEffect(cell, !(meta & 8)));
      if (duration) current.schedule(point, id, duration);
      updatePower(context, current, [point]);
      return current.finish();
    },
    prepareEntry(context) {
      const {position, getCell, activePositions} = context;
      const plates = [];
      const y = Math.floor(position.y);
      for (let x = Math.floor(position.x - PLAYER.halfWidth); x <= Math.floor(position.x + PLAYER.halfWidth); x++) {
        for (let z = Math.floor(position.z - PLAYER.halfWidth); z <= Math.floor(position.z + PLAYER.halfWidth); z++) {
          const cell = getCell(x, y, z);
          const [id, meta] = blockState(cell);
          if (pressurePlate(id) && !meta && plateOccupied(activePositions, x, y, z)) plates.push([cell, id]);
        }
      }
      if (!plates.length) return null;
      const current = plan(context);
      for (const [cell, id] of plates) triggerPlate(current, cell, id, true);
      updatePower(context, current, plates.map(([cell]) => pointOf(cell)));
      return current.finish();
    },
    prepareBlockChange(context) {
      const {change, changed = [change]} = context;
      const point = pointOf(change), [id, meta] = blockState(change);
      const current = plan(context);
      for (const item of changed) current.put(item);
      if (buttonDuration(id) && (meta & 8)) current.schedule(point, id, buttonDuration(id));
      if (pressurePlate(id) && meta) current.schedule(point, id, 1000);
      updatePower(context, current, changed.map(pointOf));
      return current.finish();
    },
    prepareTick(context) {
      const current = plan(context);
      const entries = Object.entries(current.tasks).filter(([, task]) => task.at <= context.now);
      if (!entries.length) return null;
      const sources = [], due = new Set();
      for (const [key, task] of entries) {
        current.clear(key);
        const point = key.split(',').map(Number);
        const cell = current.get(...point);
        const [id, meta] = blockState(cell);
        if (task.id !== id) continue;
        if (buttonDuration(id)) {
          if (meta & 8) {
            current.put(metaChanged(cell, id, meta & 7));
            current.effects.push(clickEffect(cell, false));
            sources.push(point);
          }
        } else if (pressurePlate(id)) {
          if (triggerPlate(current, cell, id, plateOccupied(context.activePositions, ...point))) sources.push(point);
        } else {
          due.add(key);
          sources.push(point);
        }
      }
      updatePower(context, current, sources, due);
      return current.finish();
    },
  };
}

export function registerMechanics(base, store, geometry) {
  return [makeDiagnostics(base, store, geometry), woodDoors, makeControls(base, geometry), musicBlocks];
}
