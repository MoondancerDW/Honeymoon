import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Movement } from '../client/movement.mjs';
import { loadBase } from '../server/base.mjs';
import { createGame } from '../server/game.mjs';
import { registerMechanics } from '../server/mechanics.mjs';
import { PLAYER, physics } from '../server/physics.mjs';
import { openStore } from '../server/store.mjs';
import { isLadder, liquidLevel, movementMedium } from '../world/block-movement.mjs';
import { modelFamilies, withExtractedModels } from '../world/extracted-models.mjs';
import * as geometry from '../world/geometry.mjs';

// Run from project: node qa/building-survey.mjs [generated-world] [output] [model-directory] [--extended]
// Optional repeatable pair: native-walk-result.tsv original-walk.tsv
// Replay: node qa/building-survey.mjs --replay route.json [generated-world] [model-directory]
// Probe: node qa/building-survey.mjs --movement-probes route.json result.tsv original-walk.tsv output.tsv [generated-world] [model-directory]
const project = fileURLToPath(new URL('..', import.meta.url));
const defaultWorld = join(project, 'generated/world');
const defaultOutput = join(project, 'work/building-survey');
const regionDirectory = join(project, '../sources/Honeymoon/saves/equestria/region');
const horizontal = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const half = PLAYER.halfWidth;
const epsilon = .00001;
const step = .5;
const roomMinArea = 2;
const roomCameraSpacing = 5;
const compass = [0, 90, 180, 270];
const noBoxes = [];
const trunkIds = new Set([17, 162, 3968]);
const point = ([x, y, z]) => ({ x, y, z });
const keyOf = (x, y, z) => `${x},${y},${z}`;
const legacy = key => /^legacy:(\d+):(\d+)$/.exec(key);
const defaultModels = join(project, 'generated/models');

function readModels(directory) {
  const models = {};
  for (const family of modelFamilies) {
    try {
      models[family] = JSON.parse(readFileSync(join(directory, `${family}.json`), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return models;
}

export function makeWorld(directory, modelDirectory, extended = false) {
  const manifest = JSON.parse(readFileSync(join(directory, 'world.json'), 'utf8'));
  const models = readModels(modelDirectory);
  const { minX, maxX, minY, maxY, minZ, maxZ } = manifest.bounds;
  const width = maxX + 1 - minX;
  const depth = maxZ + 1 - minZ;
  const plane = width * depth;
  const volume = plane * (maxY + 1 - minY);
  const cells = new Uint16Array(volume);
  const sky = new Uint8Array(volume).fill(15);
  const objects = new Map();
  const inventory = [];
  const vegetation = [];
  const leaves = [];
  const index = (x, y, z) => x - minX + (z - minZ) * width + (y - minY) * plane;
  const inside = (x, y, z) => x >= minX && x <= maxX && z >= minZ && z <= maxZ && y >= minY && y <= maxY;
  const palette = manifest.palette.map(key => ({ key, ...manifest.compositions[key] }));
  const kinds = palette.map(cell => cell.id ?? (Number(legacy(cell.key)?.[1]) || 0));
  const hasBiblio = palette.map(cell => Boolean(models.biblio?.models[cell.key]));
  const initialDoors = palette.map(cell => /^legacy:(64|71|96|107):(\d+)$/.exec(cell.key));
  const exactChunks = new Set(manifest.chunks.map(([x, z]) => keyOf(x, 0, z)));
  const hasChunk = (x, z) => exactChunks.has(keyOf(Math.floor(x / 16), 0, Math.floor(z / 16)));
  const doors = [];

  for (const [cx, cz] of manifest.chunks) {
    const chunk = JSON.parse(readFileSync(join(directory, 'chunks', `${cx}.${cz}.json`), 'utf8'));
    for (const section of chunk.sections) {
      const indices = Buffer.from(section.indices, 'base64');
      const skylight = Buffer.from(section.skyLight, 'base64');
      for (let zz = 0; zz < 16; zz++) for (let yy = 0; yy < 16; yy++) {
        const x = cx * 16, y = section.y * 16 + yy, z = cz * 16 + zz;
        if (!inside(x, y, z)) continue;
        const source = 256 * yy + 16 * zz;
        const destination = index(x, y, z);
        for (let xx = 0; xx < 16; xx++) {
          const id = indices.readUInt16LE(2 * (source + xx));
          cells[destination + xx] = id;
          sky[destination + xx] = skylight[(source + xx) >> 1] >> ((xx & 1) * 4) & 15;
          const door = initialDoors[id];
          if (door && (Number(door[1]) >= 96 || Number(door[2]) < 8)) {
            doors.push({ position: [x + xx, y, z], id: Number(door[1]), meta: Number(door[2]) });
          }
          if (trunkIds.has(kinds[id])) vegetation.push([x + xx, y, z]);
          if (kinds[id] === 18) leaves.push([x + xx, y, z]);
        }
      }
    }
    for (const object of chunk.objects) {
      const at = index(...object.position);
      if (!inside(...object.position)) continue;
      objects.set(at, object);
      if (/^TileEntity|Tile$|^Sign$|^RPShLamp$|^Chest$/.test(object.type)) inventory.push(object);
    }
    for (const entity of chunk.entities) {
      if (/^(Painting|ItemFrame)$/.test(entity.type)) inventory.push(entity);
    }
  }

  const surveyGeometry = withExtractedModels(geometry, models);
  const paletteBoxes = palette.map(cell => surveyGeometry.collisionFor(cell));
  const neighborDependent = palette.map(cell => geometry.shapeDependsOnNeighbors(cell));
  const full = paletteBoxes.map((boxes, i) => !hasBiblio[i] && !neighborDependent[i] && boxes.length === 1
    && Object.entries({ x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 }).every(([name, value]) => boxes[0][name] === value));
  const changes = new Map();
  let boxesCache = new Map();

  function cellAt(x, y, z) {
    if (!inside(x, y, z)) return palette[0];
    const at = index(x, y, z);
    const cell = changes.get(at) ?? palette[cells[at]];
    const object = objects.get(at);
    return object ? { ...cell, object } : cell;
  }

  const isFull = (x, y, z) => inside(x, y, z) && full[cells[index(x, y, z)]];
  const idAt = (x, y, z) => inside(x, y, z) ? cells[index(x, y, z)] : 0;
  const kindAt = (x, y, z) => kinds[idAt(x, y, z)];
  const skyAt = (x, y, z) => inside(x, y, z) ? sky[index(x, y, z)] : 15;
  const wooden = new Map();
  const thresholds = new Set();
  for (const door of doors) {
    const [x, y, z] = door.position;
    const upper = legacy(cellAt(x, y + 1, z).key);
    door.paired = door.id < 96 && Number(upper?.[1]) === door.id && (Number(upper[2]) & 8) !== 0;
    door.initiallyOpen = Boolean(door.meta & 4);
    door.canOpen = (door.id === 64 && door.paired) || (extended && [96, 107].includes(door.id));
    door.core = x >= -64 && x < 64 && z >= -64 && z < 64;
    door.closed = `legacy:${door.id}:${door.meta & ~4}`;
    door.open = `legacy:${door.id}:${door.meta | 4}`;
    if (door.canOpen) wooden.set(index(x, y, z), door);
    thresholds.add(index(x, y, z));
  }

  function setDoor(door, opened) {
    const [x, y, z] = door.position;
    changes.set(index(x, y, z), { key: opened ? door.open : door.closed });
    boxesCache.delete(index(x, y, z));
    boxesCache.delete(index(x, y + 1, z));
  }

  function resetDoors(allOpen) {
    changes.clear();
    boxesCache = new Map();
    if (allOpen) for (const door of wooden.values()) setDoor(door, true);
  }

  function boxesAt(x, y, z) {
    const id = idAt(x, y, z);
    if (!id) return noBoxes;
    const at = index(x, y, z);
    const object = objects.get(at);
    if (!object && !neighborDependent[id] && !changes.has(at)) return paletteBoxes[id];
    if (boxesCache.has(at)) return boxesCache.get(at);
    const boxes = surveyGeometry.collisionFor(cellAt(x, y, z), (dx, dy, dz) => cellAt(x + dx, y + dy, z + dz));
    boxesCache.set(at, boxes);
    return boxes;
  }

  resetDoors(true);
  return { manifest, index, inside, idAt, kindAt, isFull, skyAt, boxesAt, cellAt, hasChunk, inventory, doors, wooden,
    thresholds, setDoor, resetDoors, models, surveyGeometry, vegetation, leaves };
}

function makeSurvey(world, window, nativeBlocked, extended = false) {
  const { minX, minZ, maxX, maxZ } = window;
  const minX2 = 2 * minX + 1, minZ2 = 2 * minZ + 1;
  const maxX2 = 2 * maxX + 1, maxZ2 = 2 * maxZ + 1;
  const minY = world.manifest.bounds.minY, maxY = world.manifest.bounds.maxY;
  const columns = new Map();
  const clearance = new Map();
  const linkModes = new Map();
  const positions = [];
  const browser = new Movement(world);
  const { idAt, isFull, boxesAt, index, skyAt, kindAt, thresholds } = world;
  const footprint = (x, z, xx, zz, box) => x + half > xx + box.x0 + epsilon && x - half < xx + box.x1 - epsilon
    && z + half > zz + box.z0 + epsilon && z - half < zz + box.z1 - epsilon;

  function blocked(x, y, z) {
    if (x - half < minX || x + half > maxX + 1 || z - half < minZ || z + half > maxZ + 1
      || y < minY || y + PLAYER.height > maxY + 1) return true;
    for (let yy = Math.floor(y) - 1; yy <= Math.floor(y + PLAYER.height); yy++) {
      for (let zz = Math.floor(z - half - .125); zz <= Math.floor(z + half + .125); zz++) {
        for (let xx = Math.floor(x - half - .125); xx <= Math.floor(x + half + .125); xx++) {
          for (const box of boxesAt(xx, yy, zz)) {
            if (y + PLAYER.height > yy + box.y0 + epsilon && y < yy + box.y1 - epsilon
              && footprint(x, z, xx, zz, box)) return true;
          }
        }
      }
    }
    return false;
  }
  browser.blocked = blocked;

  function column(x2, z2) {
    if (x2 < minX2 || x2 > maxX2 || z2 < minZ2 || z2 > maxZ2) return [];
    const columnKey = (x2 - minX2) + (z2 - minZ2) * (maxX2 + 1 - minX2);
    if (columns.has(columnKey)) return columns.get(columnKey);
    const x = x2 / 2, z = z2 / 2;
    const supports = new Set();
    for (let zz = Math.floor(z - half); zz <= Math.floor(z + half); zz++) {
      for (let xx = Math.floor(x - half); xx <= Math.floor(x + half); xx++) {
        for (let y = minY; y <= maxY - 1; y++) {
          if (!idAt(xx, y, zz) || isFull(xx, y + 1, zz)) continue;
          for (const box of boxesAt(xx, y, zz)) {
            if (footprint(x, z, xx, zz, box)) supports.add(y + box.y1);
          }
        }
      }
    }
    const media = new Map();
    if (extended) {
      const xx = Math.floor(x), zz = Math.floor(z);
      for (let y = minY; y <= maxY - 1; y++) {
        const block = world.cellAt(xx, y, zz);
        if (isLadder(block) && kindAt(xx, y, zz) === 65) {
          for (const height of [y, y + .5, y + .99]) media.set(height, 'ladder');
          if (!isLadder(world.cellAt(xx, y + 1, zz))) media.set(y + 1.125, 'ladder');
        }
        // Sample outdoor water surfaces. Deep cave aquifers need their own dive routes.
        if (y >= 54 && (liquidLevel(block) ?? 0) >= .44 && liquidLevel(world.cellAt(xx, y + 1, zz)) === null) {
          media.set(y + .45, 'water');
        }
      }
    }
    const nodes = [];
    for (const y of [...new Set([...supports, ...media.keys()])].sort((a, b) => a - b)) {
      if (blocked(x, y, z)) continue;
      const node = { i: positions.length, x2, z2, x, y, z,
        medium: media.get(y) ?? (extended && movementMedium(world.cellAt, x, y, z)), supported: supports.has(y) };
      positions.push(node);
      nodes.push(node);
    }
    columns.set(columnKey, nodes);
    return nodes;
  }

  function edge(from, to) {
    if (nativeBlocked?.has(edgeKey(from, to))) return false;
    const lower = Math.min(from.i, to.i), higher = Math.max(from.i, to.i);
    const pair = lower + higher * 10_000_000;
    if (clearance.has(pair)) return clearance.get(pair);
    const candidate = from.medium === 'ladder' || to.medium === 'ladder' ? 'ladder'
      : from.medium === 'water' || to.medium === 'water' ? 'water'
      : Math.abs(to.y - from.y) > step + epsilon ? 'jump' : null;
    const y = Math.max(from.y, to.y);
    const clear = !blocked(from.x, y, from.z) && !blocked(to.x, y, to.z)
      && [0.25, 0.5, 0.75].every(f => !blocked(from.x + f * (to.x - from.x), y, from.z + f * (to.z - from.z)));
    let valid = !candidate && clear && ((!extended && Math.abs(from.y - to.y) < epsilon) || (
      dist2(walkLeg(browser, from, to), to) <= .025 ** 2
      && dist2(walkLeg(browser, to, from), from) <= .025 ** 2));
    if (candidate && specialLink(browser, from, to, candidate) && specialLink(browser, to, from, candidate)) {
      linkModes.set(edgeKey(from, to), candidate);
      valid = true;
    }
    clearance.set(pair, valid);
    return valid;
  }

  function* nearby(from) {
    if (from.medium === 'ladder') {
      for (const to of column(from.x2, from.z2)) {
        if (to !== from && to.medium === 'ladder' && Math.abs(to.y - from.y) <= .51 && edge(from, to)) yield to;
      }
    }
    for (const [dx, dz] of horizontal) {
      for (const to of column(from.x2 + dx, from.z2 + dz)) {
        const limit = extended && (from.medium || to.medium || from.supported && to.supported) ? 1.05 : step;
        if (Math.abs(to.y - from.y) <= limit + epsilon && edge(from, to)) yield to;
      }
    }
  }

  const [sx, sy, sz] = world.manifest.spawn;
  const spawn = column(sx * 2, sz * 2).find(n => Math.abs(n.y - sy) < .05);
  if (!spawn) throw new Error(`No supported spawn pose at ${world.manifest.spawn.join(', ')}`);
  const reachable = [spawn];
  const parent = new Map([[spawn.i, null]]);
  for (let i = 0; i < reachable.length; i++) {
    const from = reachable[i];
    for (const to of nearby(from)) {
      if (parent.has(to.i)) continue;
      reachable.push(to);
      parent.set(to.i, from.i);
    }
  }

  // Enumerate disconnected surfaces too. For the report, candidate interiors are open spaces
  // with a constructed roof, low skylight or windows, and no intervening trees or earth.
  for (let z2 = minZ2; z2 <= maxZ2; z2++) for (let x2 = minX2; x2 <= maxX2; x2++) column(x2, z2);
  const roofMaterials = new Set([1, 4, 5, 20, 24, 35, 43, 44, 45, 47, 48, 49, 53, 67, 79, 80, 82, 89,
    95, 98, 101, 102, 108, 109, 112, 114, 125, 126, 128, 134, 135, 136, 139, 155, 750, 4027, 4039]);
  const garden = new Set([2, 3, 9, 12, 13, 18, 31, 78, 106, 111, 161, ...trunkIds]);
  const thresholdsAt = ({ x, y, z }) => {
    const xx = Math.floor(x), yy = Math.floor(y), zz = Math.floor(z);
    return thresholds.has(index(xx, yy, zz)) || thresholds.has(index(xx, yy - 1, zz));
  };
  const roof = (x, y, z) => {
    for (let yy = Math.floor(y + PLAYER.height); yy <= Math.min(maxY, Math.floor(y + 13)); yy++) {
      if (!idAt(x, yy, z)) continue;
      const id = kindAt(x, yy, z);
      if (garden.has(id)) return null;
      const boxes = boxesAt(x, yy, z);
      if (roofMaterials.has(id) && boxes.some(b => b.x0 <= .5 && b.x1 >= .5 && b.z0 <= .5 && b.z1 >= .5)) return yy;
    }
    return null;
  };
  const roofCache = new Map();
  const enclosed = node => {
    const { x, y, z } = node;
    const xx = Math.floor(x), zz = Math.floor(z);
    const cacheKey = `${xx},${y},${zz}`;
    if (!roofCache.has(cacheKey)) {
      const overhead = roof(xx, y, zz);
      const roofNeighbors = horizontal.filter(([dx, dz]) => roof(xx + dx, y, zz + dz) !== null).length;
      const sky = skyAt(xx, Math.floor(y + 1), zz);
      roofCache.set(cacheKey, overhead !== null && (roofNeighbors >= 3 || (roofNeighbors >= 1 && sky < 12)));
    }
    return roofCache.get(cacheKey) && !thresholdsAt(node);
  };
  const covered = new Set(positions.filter(n => n.supported && enclosed(n)).map(n => n.i));
  const unvisited = new Set(covered);
  const rooms = [];
  for (const root of covered) {
    if (!unvisited.delete(root)) continue;
    const nodes = [positions[root]];
    for (let i = 0; i < nodes.length; i++) {
      const from = nodes[i];
      for (const to of nearby(from)) {
        if (Math.floor(to.y + .125) !== Math.floor(from.y + .125) || linkModes.has(edgeKey(to, from))) continue;
        if (unvisited.delete(to.i)) nodes.push(to);
      }
    }
    if (nodes.length * .25 < roomMinArea) continue;
    const walkable = nodes.filter(n => parent.has(n.i));
    rooms.push({ nodes, walkable, level: Math.floor(nodes[0].y + .125) });
  }
  return { spawn, positions, reachable, parent, rooms, covered, bounds: window, column, linkModes };
}

const feet = node => [node.x, node.y, node.z];
const edgeKey = (a, b) => [keyOf(...feet(a)), keyOf(...feet(b))].sort().join('|');
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
const centroid = nodes => ({ x: nodes.reduce((sum, n) => sum + n.x, 0) / nodes.length,
  y: nodes.reduce((sum, n) => sum + n.y, 0) / nodes.length, z: nodes.reduce((sum, n) => sum + n.z, 0) / nodes.length });
const nearest = (nodes, target) => nodes.reduce((a, n) => !a || dist2(n, target) < dist2(a, target) ? n : a, null);

function walkLeg(movement, from, to) {
  const actual = point(feet(from));
  movement.grounded = true;
  movement.fall = 0;
  for (let tick = 0; tick < 20; tick++) movement.update(actual, (to.x - from.x) * 4, (to.z - from.z) * 4, false, .0125);
  for (let tick = 0; tick < 32 && !movement.grounded; tick++) movement.update(actual, 0, 0, false, .0125);
  return actual;
}

function specialLink(movement, from, to, mode, record = false) {
  const actual = point(feet(from));
  const path = [];
  const tolerance = .025;
  const dt = .0125;
  movement.grounded = from.supported;
  movement.fall = 0;
  movement.medium = movementMedium(movement.cellAt, actual.x, actual.y, actual.z);
  const startMedium = movement.medium;
  const jump = to.y > from.y + .5 && from.supported && !startMedium;
  for (let tick = 0; tick < 95; tick++) {
    const medium = movement.medium;
    const drag = medium === 'water' ? .48 : medium === 'ladder' ? .62 : 1;
    const risingOut = to.supported && !to.medium && from.medium && to.y > from.y + .1;
    const wait = (risingOut && actual.y + tolerance < to.y) || (jump && tick < 5);
    const speed = (goal, value) => wait ? 0 : Math.max(-3.8, Math.min(3.8, (goal - value) / (dt * drag)));
    const rise = mode === 'water' ? actual.y < to.y - .012
      : mode === 'ladder' && (to.y > actual.y + .012 || risingOut && actual.y < to.y + .08);
    const descend = (mode === 'ladder' || mode === 'water') && actual.y > to.y + .035;
    movement.update(actual, speed(to.x, actual.x), speed(to.z, actual.z), jump && tick === 0, dt, { rise, descend });
    if (record) path.push(feet(actual));
    if (dist2(actual, to) <= tolerance ** 2 && (!to.supported || movement.grounded)) {
      return {path, actual};
    }
  }
  return null;
}

function regionCount() {
  try {
    return readdirSync(regionDirectory).filter(name => /^r\.-?\d+\.-?\d+\.mca$/.test(name)).length;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function selectViews(world, survey, core) {
  const selected = new Map();
  const visibleInventory = new Map();
  const { rooms, reachable, covered } = survey;
  const physical = physics(world, world.surveyGeometry, world.cellAt);
  const viewIds = new Set();
  const inCore = n => core.column(n.x2, n.z2).some(c => Math.abs(c.y - n.y) < .01 && core.parent.has(c.i));
  function add(node, kind, label, angles = compass, pitch = 0, extra = {}) {
    if (!node) return;
    const entry = selected.get(node.i) ?? { node, views: [] };
    for (const [i, yaw] of angles.entries()) {
      const id = `${label}-${String(i + 1).padStart(2, '0')}`;
      if (viewIds.has(id)) continue;
      viewIds.add(id);
      entry.views.push({ id, feet: feet(node), yaw, pitch, kind, coreReachable: inCore(node), ...extra });
    }
    selected.set(node.i, entry);
  }

  add(survey.spawn, 'spawn', 'spawn', [0, 45, 90, 135, 180, 225, 270, 315], -4);
  for (const [label, target, yaw, pitch] of [
    ['armchair', [-34, 65, -61], 90, 22], ['bookcase', [-59, 76, -50], 225, 0],
    ['lamp', [-51, 73, -50], 180, -18], ['sign', [-54, 70, -49], 0, 8],
  ]) {
    const ideal = point([target[0] + .5, target[1], target[2] + .5]);
    const at = findTarget(survey, physical, target, 5);
    if (at) {
      const angles = cameraAt(at, target);
      add(at, 'model', `model-${label}`, [angles.yaw], angles.pitch, { target });
    } else {
      const view = nearest(reachable, ideal);
      if (view && dist2(view, ideal) < 30) add(view, 'model-area', `model-area-${label}`, [yaw], pitch, { target });
    }
  }

  const roomReport = [];
  for (const [i, room] of rooms.entries()) {
    const id = `interior-${String(i + 1).padStart(3, '0')}`;
    const preferred = room.walkable.filter(inCore);
    const route = room.walkable;
    const first = nearest(preferred.length ? preferred : route.length ? route : room.nodes, centroid(room.nodes));
    const centers = route.length ? [first] : [];
    for (const node of route) {
      if (centers.some(center => dist2(center, node) <= roomCameraSpacing ** 2)) continue;
      centers.push(node);
    }
    centers.forEach((node, view) => {
      const label = `${id}-${String(view + 1).padStart(2, '0')}`;
      add(node, 'interior', label, compass, 3);
      add(node, 'interior-floor', `${label}-floor`, [0], 65);
      add(node, 'interior-ceiling', `${label}-ceiling`, [0], -65);
    });
    roomReport.push({ id, level: room.level, standSamples: room.nodes.length,
      spawnReachable: room.walkable.length, coreReachable: preferred.length, representative: feet(first),
      min: [Math.min(...room.nodes.map(n => n.x)), Math.min(...room.nodes.map(n => n.y)), Math.min(...room.nodes.map(n => n.z))],
      max: [Math.max(...room.nodes.map(n => n.x)), Math.max(...room.nodes.map(n => n.y)), Math.max(...room.nodes.map(n => n.z))],
      routeStations: centers.length });
  }

  const outdoor = new Map();
  for (const n of reachable) {
    if (covered.has(n.i) || !((n.x2 & 1) && (n.z2 & 1))) continue;
    const { x, y, z } = n;
    if (world.skyAt(Math.floor(x), Math.floor(y + 1), Math.floor(z)) < 13) continue;
    const key = `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
    if (!outdoor.has(key)) outdoor.set(key, []);
    outdoor.get(key).push(n);
  }
  const exteriorReport = [];
  for (const [sector, nodes] of outdoor) {
    const [cx, cz] = sector.split(',').map(Number);
    const middle = { x: cx * 16 + 8, y: centroid(nodes).y, z: cz * 16 + 8 };
    const low = nearest(nodes, middle);
    const high = nodes.reduce((best, node) => node.y > best.y ? node : best, low);
    const label = sector.replaceAll('-', 'n').replace(',', '-');
    add(low, 'exterior', `exterior-${label}`, compass, 0);
    if (high.y >= low.y + 2.5) add(high, 'lookout', `lookout-${label}`, compass, 12);
    exteriorReport.push({ sector: [cx, cz], outdoorStandSamples: nodes.length, station: feet(low),
      lookout: high.y >= low.y + 2.5 ? feet(high) : null });
  }

  const water = reachable.filter(n => n.medium === 'water' && !n.supported);
  for (const nodes of Map.groupBy(water, n => `${Math.floor(n.x / 16)},${Math.floor(n.z / 16)}`).values()) {
    const station = nearest(nodes, centroid(nodes));
    const label = feet(station).map(n => String(n).replace('-', 'n').replace('.', 'p')).join('-');
    add(station, 'swimming', `swimming-${label}`, compass, 9);
  }

  for (const door of world.doors) {
    const [x, y, z] = door.position;
    const at = findTarget(survey, physical, door.position, 4, n => !covered.has(n.i));
    if (!at) continue;
    const { yaw, pitch } = cameraAt(at, door.position);
    const label = [x, y, z].map(n => String(n).replace('-', 'n')).join('-');
    add(at, 'facade', `facade-${label}`, [yaw], Math.min(pitch, 0), { target: door.position });
  }

  const trees = [];
  for (const [x, y, z] of world.vegetation) {
    if (trunkIds.has(world.kindAt(x, y - 1, z)) || !trunkIds.has(world.kindAt(x, y + 1, z))) continue;
    let top = y + 1;
    while (trunkIds.has(world.kindAt(x, top + 1, z))) top++;
    let canopyLeaves = 0;
    for (let zz = z - 2; zz <= z + 2; zz++) {
      for (let yy = top - 1; yy <= top + 2; yy++) {
        for (let xx = x - 2; xx <= x + 2; xx++) {
          if (world.kindAt(xx, yy, zz) === 18) canopyLeaves++;
        }
      }
    }
    if (canopyLeaves < 5) continue;
    const base = [x, y, z];
    const target = [x, Math.min(top, y + 2), z];
    const at = findTarget(survey, physical, target, 5);
    if (at) {
      const { yaw, pitch } = cameraAt(at, target);
      const label = base.map(n => String(n).replace('-', 'n')).join('-');
      add(at, 'tree', `tree-${label}`, [yaw], pitch, { target, trunkBase: base, canopyLeaves });
    }
    trees.push({ trunkBase: base, trunkBlock: world.kindAt(x, y, z), trunkHeight: top - y + 1,
      canopyLeaves, viewpoint: at ? feet(at) : null });
  }
  const canopies = foliageNearSpawn(world, survey, physical);
  for (const canopy of canopies) {
    if (!canopy.view) continue;
    const { yaw, pitch } = cameraAt(canopy.view, canopy.target);
    add(canopy.view, 'canopy', `spawn-canopy-${canopy.id}`, [yaw], pitch, { target: canopy.target });
  }

  const objects = [];
  for (const object of world.inventory) {
    const target = object.position.map(Math.floor);
    const at = findTarget(survey, physical, target, 5);
    objects.push({ position: object.position, type: object.type, viewpoint: at ? feet(at) : null });
    if (!at) continue;
    visibleInventory.set(object.type, (visibleInventory.get(object.type) ?? 0) + 1);
    const label = `${object.type.toLowerCase()}-${target.map(n => String(n).replace('-', 'n')).join('-')}`;
    const { yaw, pitch } = cameraAt(at, target);
    add(at, 'object', label, [yaw], pitch, { target, objectType: object.type });
  }
  return { selected, roomReport, exteriorReport, visibleInventory, trees, canopies, objects };
}

function foliageNearSpawn(world, survey, physical) {
  const { x, y, z } = survey.spawn;
  const close = world.leaves.filter(([xx, yy, zz]) => yy >= y && Math.hypot(x - xx, z - zz) <= 38);
  const remaining = new Set(close.map(p => keyOf(...p)));
  const adjacent = [-1, 0, 1].flatMap(dx => [-1, 0, 1].flatMap(dy => [-1, 0, 1].map(dz => [dx, dy, dz])));
  const canopies = [];
  for (const root of close) {
    if (!remaining.delete(keyOf(...root))) continue;
    const cluster = [root];
    for (let i = 0; i < cluster.length; i++) {
      const [x, y, z] = cluster[i];
      for (const [dx, dy, dz] of adjacent) {
        const next = [x + dx, y + dy, z + dz];
        if (remaining.delete(keyOf(...next))) cluster.push(next);
      }
    }
    if (cluster.length < 5) continue;
    const center = centroid(cluster.map(point));
    cluster.sort((a, b) => dist2(point(a), center) - dist2(point(b), center));
    const candidates = cluster.filter(([x, y, z]) => horizontal.some(([dx, dz]) => world.kindAt(x + dx, y, z + dz) !== 18));
    let view = null, target = cluster[0];
    for (const cell of candidates) {
      view = findTarget(survey, physical, cell, 5.9, n => !survey.covered.has(n.i), 4);
      if (!view) continue;
      target = cell;
      break;
    }
    canopies.push({ id: String(canopies.length + 1).padStart(2, '0'), target, leafCells: cluster.length, view });
  }
  return canopies;
}

export function cameraAt(node, target) {
  const dx = target[0] + .5 - node.x, dz = target[2] + .5 - node.z;
  const dy = target[1] + .5 - (node.y + PLAYER.eye);
  return { yaw: Math.round(Math.atan2(-dx, dz) * 180 / Math.PI), pitch: Math.round(Math.atan2(-dy, Math.hypot(dx, dz)) * 180 / Math.PI) };
}

function findTarget(survey, physical, target, range, accept = () => true, idealDistance = 2.5) {
  const [x, y, z] = target;
  const candidates = [];
  for (let zz = Math.ceil((z - range) * 2); zz <= (z + 1 + range) * 2; zz++) {
    for (let xx = Math.ceil((x - range) * 2); xx <= (x + 1 + range) * 2; xx++) {
      for (const n of survey.column(xx, zz)) {
        if (survey.parent.has(n.i) && Math.abs(n.y - y) <= 3.5 && accept(n)) candidates.push(n);
      }
    }
  }
  const targetPoint = { x: x + .5, y: y + .5 - PLAYER.eye, z: z + .5 };
  const framingScore = n => Math.abs(Math.sqrt(dist2(n, targetPoint)) - idealDistance)
    + .7 * Math.max(0, 1.25 - Math.hypot(n.x - targetPoint.x, n.z - targetPoint.z));
  candidates.sort((a, b) => framingScore(a) - framingScore(b));
  return candidates.find(n => dist2(n, targetPoint) >= 2.25 && dist2(n, targetPoint) <= range ** 2
    && physical.visible(n, x, y, z));
}

function captureBatch(checkpoints) {
  const unique = (list, key) => [...Map.groupBy(list, key).values()].map(group => group[0]);
  const selected = new Map();
  const add = views => views.forEach(view => selected.set(view.id, view));
  const views = kind => checkpoints.filter(p => p.kind === kind);
  const spread = (kind, limit, key) => {
    const candidates = unique(views(kind), key);
    const seed = [...selected.values()].map(p => point(p.feet));
    for (let i = 0; i < limit && candidates.length; i++) {
      const score = p => Math.min(...seed.map(n => dist2(n, point(p.feet))));
      const next = candidates.reduce((best, p) => score(p) > score(best) ? p : best);
      candidates.splice(candidates.indexOf(next), 1);
      add([next]);
      seed.push(point(next.feet));
    }
  };
  const sameFeet = p => p.feet.join(',');
  add(views('spawn'));
  add(views('model'));
  add(views('canopy'));
  spread('tree', 10, sameFeet);
  spread('exterior', 16, sameFeet);
  spread('lookout', 10, sameFeet);
  spread('interior', 16, p => p.id.slice(0, 12));
  spread('facade', 8, sameFeet);
  spread('swimming', 8, sameFeet);
  spread('object', 8, p => p.objectType);
  return [...selected.values()].sort((a, b) => a.pathIndex - b.pathIndex);
}

function routeToViews(world, survey, selected) {
  const edges = new Map();
  for (const { node } of selected.values()) {
    for (let child = node.i, parent; (parent = survey.parent.get(child)) !== null; child = parent) {
      if (!edges.has(parent)) edges.set(parent, new Set());
      if (edges.get(parent).has(child)) break;
      edges.get(parent).add(child);
    }
  }

  const positions = [feet(survey.spawn)];
  const nodeIds = [survey.spawn.i];
  const checkpoints = [];
  // Walk the union of the shortest paths from spawn. Reuse shared corridors and
  // backtrack from each branch so the capture order is a continuous route.
  function visit(id) {
    for (const view of selected.get(id)?.views ?? []) checkpoints.push({ ...view, pathIndex: positions.length - 1 });
    for (const child of edges.get(id) ?? []) {
      positions.push(feet(survey.positions[child]));
      nodeIds.push(child);
      visit(child);
      positions.push(feet(survey.positions[id]));
      nodeIds.push(id);
    }
  }
  visit(survey.spawn.i);

  const physical = physics(world, world.surveyGeometry, world.cellAt);
  const movement = new Movement(world);
  const openNow = new Set(world.doors.filter(door => door.initiallyOpen));
  const actions = [], blocked = [], clientDifferences = [], movementSegments = [];
  world.resetDoors(false);
  for (let i = 1; i < positions.length; i++) {
    const from = point(positions[i - 1]), to = point(positions[i]);
    const mode = survey.linkModes.get(edgeKey(from, to));
    const probe = () => specialLink(movement, survey.positions[nodeIds[i - 1]], survey.positions[nodeIds[i]], mode, true);
    const clear = () => mode ? Boolean(probe()) : physical.movementAllowed(from, to);
    if (!clear()) {
      const available = [];
      for (let y = Math.floor(from.y) - 1; y <= Math.floor(from.y) + 1; y++) {
        for (let z = Math.floor(from.z) - 1; z <= Math.floor(from.z) + 1; z++) {
          for (let x = Math.floor(from.x) - 1; x <= Math.floor(from.x) + 1; x++) {
            if (!world.inside(x, y, z)) continue;
            const door = world.wooden.get(world.index(x, y, z));
            if (!door || openNow.has(door)) continue;
            const hit = physical.visible(from, x, y, z) ? [x, y, z]
              : door.paired && physical.visible(from, x, y + 1, z) ? [x, y + 1, z] : null;
            if (hit) available.push({ door, hit });
          }
        }
      }
      for (const { door, hit } of available) {
        world.setDoor(door, true);
        if (physical.collides(from)) { world.setDoor(door, false); continue; }
        openNow.add(door);
        actions.push({ pathIndex: i - 1, type: 'interact', position: door.position, interactionPosition: hit, cell: door.open });
        if (clear()) break;
      }
    }
    if (mode) {
      const traversal = probe();
      if (traversal && traversal.path.every((sample, j, path) =>
        physical.movementAllowed(point(path[j - 1] ?? positions[i - 1]), point(sample)))) {
        movementSegments.push({ pathIndex: i, mode, samples: traversal.path });
      } else {
        blocked.push({ pathIndex: i, mode, from: positions[i - 1], to: positions[i] });
      }
      continue;
    }
    if (!physical.movementAllowed(from, to)) { blocked.push({ pathIndex: i, from: positions[i - 1], to: positions[i] }); continue; }
    const actual = walkLeg(movement, from, to);
    if (dist2(actual, to) > .025 ** 2) clientDifferences.push({ pathIndex: i, from: positions[i - 1], to: positions[i], actual });
  }
  const length = positions.slice(1).reduce((sum, n, i) => sum + Math.sqrt(dist2(point(n), point(positions[i]))), 0);
  return { feet: positions, length, checkpoints, actions, movementSegments, blocked, clientDifferences };
}

function readNativeBlocks(resultFile, originalWalk, blocked) {
  const path = readFileSync(originalWalk, 'utf8').trim().split(/\r?\n/).map(line => {
    const [kind, x, y, z, pathIndex] = line.split(/\s+/);
    return kind === 'p' || kind === 'm' ? { position: point([x, y, z].map(Number)), kind, pathIndex } : null;
  });
  for (const line of readFileSync(resultFile, 'utf8').trim().split(/\r?\n/).slice(1)) {
    const [index, status, x, y, z, actualX, actualY, actualZ] = line.split('\t');
    const to = point([x, y, z].map(Number));
    const actual = point([actualX, actualY, actualZ].map(Number));
    if (status !== 'different' || dist2(to, actual) <= .025 ** 2) continue;
    const toIndex = Number(index);
    // Native runs may append separately reset local probes after the primary route.
    if (toIndex >= path.length) continue;
    const row = path[toIndex];
    if (toIndex <= 0 || !row || dist2(to, row.position) > .001 ** 2) {
      throw new Error(`Native collision result ${index} does not match the supplied walk TSV`);
    }
    let fromIndex = toIndex - 1;
    if (row.kind === 'm' && row.pathIndex !== undefined) {
      while (fromIndex >= 0 && (!path[fromIndex] || path[fromIndex].pathIndex === row.pathIndex)) fromIndex--;
      let endIndex = toIndex;
      while (endIndex + 1 < path.length && path[endIndex + 1]?.pathIndex === row.pathIndex) endIndex++;
      if (fromIndex >= 0) blocked.add(edgeKey(path[fromIndex].position, path[endIndex].position));
    } else {
      if (row.kind === 'm') throw new Error('Regenerate the m rows with their parent leg index before filtering.');
      while (fromIndex >= 0 && !path[fromIndex]) fromIndex--;
      if (fromIndex >= 0) blocked.add(edgeKey(path[fromIndex].position, to));
    }
  }
}

export function buildingSurvey(worldDirectory, modelDirectory = defaultModels, nativeBlocked, extended = false) {
  const world = makeWorld(worldDirectory, modelDirectory, extended);
  const { manifest } = world;
  const coreBounds = { minX: Math.max(-64, manifest.bounds.minX), maxX: Math.min(63, manifest.bounds.maxX),
    minZ: Math.max(-64, manifest.bounds.minZ), maxZ: Math.min(63, manifest.bounds.maxZ) };
  const survey = makeSurvey(world, manifest.bounds, nativeBlocked, extended);
  const core = manifest.bounds.minX === coreBounds.minX && manifest.bounds.maxX === coreBounds.maxX
    && manifest.bounds.minZ === coreBounds.minZ && manifest.bounds.maxZ === coreBounds.maxZ
    ? survey : makeSurvey(world, coreBounds, nativeBlocked, extended);
  const { selected, roomReport, exteriorReport, visibleInventory, trees, canopies, objects } = selectViews(world, survey, core);
  const route = routeToViews(world, survey, selected);
  const inventory = world.inventory.reduce((counts, { type }) => {
    counts[type] = (counts[type] ?? 0) + 1;
    return counts;
  }, {});
  const uniqueColumns = nodes => new Set(nodes.map(n => `${Math.floor(n.x)},${Math.floor(n.z)}`)).size;
  return {
    scope: { contentHash: manifest.contentHash, bounds: manifest.bounds, detailedChunks: manifest.chunks.length,
      unscannedVisualOnlyChunks: manifest.visualChunks?.length ?? 0, sourceRegionFiles: regionCount(),
      coreBounds, coreChunks: manifest.chunks.filter(([x, z]) => x >= -4 && x < 4 && z >= -4 && z < 4).length,
      modelFamilies: Object.keys(world.models), nativeBlockedEdgesExcluded: nativeBlocked?.size ?? 0, extended, methodology: {
        samples: 'Feet on collision box tops at 0.5 block horizontal spacing, every saved height.',
        reachability: extended
          ? 'Browser controls verify walking, climbing, surface swimming and nearby hops in both directions. The graph initially opens hand-operated wooden barriers. Playback starts with saved metadata.'
          : 'Cardinal links of 0.5 block with at most 0.5 block vertical rise/drop. Browser movement verifies changes in elevation in both directions. Paired wooden doors initially considered open. Replay starts from saved door states.',
        interiors: 'Candidate covered floor patches of at least 2 square blocks; grouped by level, barriers and door thresholds. Caves with stone ceilings, furniture tops, roofs and partial open rooms can affect classification.',
        limits: extended
          ? 'Samples ladders, nearby one-block jumps, and surface water above y=54. Deep aquifers, iron doors, vines without supports, one-way drops and unloaded chunks require separate checks. A 0.5 block grid may miss narrow passages.'
          : 'Ladders, water movement, jumps, falls over 0.5 block, iron door triggers and unloaded chunks require separate checks. A 0.5 block sample grid may miss narrow passages. Views do not establish complete line-of-sight coverage.',
      } },
    counts: { standSamples: survey.positions.length, reachableStandSamples: survey.reachable.length,
      reachableHorizontalColumns: uniqueColumns(survey.reachable), coreReachableStandSamples: core.reachable.length,
      coreReachableHorizontalColumns: uniqueColumns(core.reachable), candidateInteriorPatches: roomReport.length,
      reachableInteriorPatches: roomReport.filter(r => r.spawnReachable).length,
      coreReachableInteriorPatches: roomReport.filter(r => r.coreReachable).length,
      reachableExteriorSectors: exteriorReport.length, detectedTreeTrunks: trees.length,
      treeTrunksWithViewpoint: trees.filter(tree => tree.viewpoint).length,
      stations: selected.size, cameraViews: route.checkpoints.length,
      routeSteps: route.feet.length - 1, replayDoorActions: route.actions.length,
      movementSegments: Object.fromEntries([...Map.groupBy(route.movementSegments, segment => segment.mode)].map(([mode, segments]) => [mode, segments.length])),
      blockedReplaySteps: route.blocked.length, clientReplayDifferences: route.clientDifferences.length },
    rooms: roomReport, exterior: exteriorReport, trees,
    canopiesNearSpawn: canopies.map(({ view, ...canopy }) => ({ ...canopy, viewpoint: view ? feet(view) : null })),
    doors: world.doors,
    inventory: { sampledTypes: inventory, visibleFromRoute: Object.fromEntries(visibleInventory), objects }, route,
  };
}

function verifyGameRoute(report, worldDirectory, modelDirectory) {
  const base = loadBase(worldDirectory);
  if (report.scope.contentHash !== base.hash) throw new Error('Route and imported world hashes differ');
  const physicalGeometry = withExtractedModels(geometry, readModels(modelDirectory));
  const store = openStore(':memory:');
  let time = 0;
  try {
    // Match the original map for comparison by omitting the synthetic demo cells.
    const modules = registerMechanics(base, store, physicalGeometry).filter(module => module.id !== 'diagnostic');
    const game = createGame(base, store, physicalGeometry, { clock: () => time, modules });
    const { id } = store.createPlayer();
    const { feet, actions, movementSegments = [] } = report.route;
    const byIndex = Map.groupBy(actions, action => action.pathIndex);
    const traversal = new Map(movementSegments.map(segment => [segment.pathIndex, segment.samples]));
    const spawn = Object.values(game.session(id).position);
    if (spawn.some((value, axis) => value !== feet[0][axis])) throw new Error('Route does not start at spawn');
    for (const [i, position] of feet.entries()) {
      try {
        for (const sample of traversal.get(i) ?? []) {
          time += 50;
          game.position(id, point(sample));
        }
        time += 125;
        game.position(id, point(position));
        for (const [j, action] of (byIndex.get(i) ?? []).entries()) {
          const result = game.action(id, { ...point(action.interactionPosition), type: 'interact',
            requestId: `survey-${i}-${j}`, expectedRevision: 0 });
          if (result.status !== 200 || !result.output.changes.some(change => change.cell === action.cell)) {
            throw new Error(`Door ${action.position.join(', ')} returned ${JSON.stringify(result.output)}`);
          }
        }
      } catch (error) {
        throw new Error(`Route step ${i} at ${position.join(', ')}: ${error.message}`, { cause: error });
      }
    }
    return { movementLegs: feet.length - 1, interactionActions: actions.length, specialSegments: movementSegments.length, completed: true };
  } finally {
    store.close();
  }
}

function movementProbes(route, resultFile, originalWalk, world) {
  const original = readFileSync(originalWalk, 'utf8').trim().split(/\r?\n/).map(line => line.split(/\s+/));
  const probes = new Set();
  for (const row of readFileSync(resultFile, 'utf8').trim().split(/\r?\n/).slice(1)) {
    const [index, status] = row.split('\t');
    const [kind, , , , pathIndex] = original[Number(index)] ?? [];
    const leg = Number(pathIndex);
    if (status === 'different' && kind === 'm' && Number.isInteger(leg) && leg > 0 && leg < route.feet.length) {
      probes.add(leg);
    }
  }
  const browser = new Movement(world);
  const nodes = coordinates => {
    const [x, y, z] = coordinates;
    return {x, y, z, medium:movementMedium(world.cellAt, x, y, z), supported:browser.blocked(x, y - .0001, z)};
  };
  const actions = Map.groupBy(route.actions, action => action.pathIndex);
  const modes = new Map(route.movementSegments.map(segment => [segment.pathIndex, segment.mode]));
  const doors = new Map(world.doors.map(door => [door.position.join(','), door]));
  const output = [];
  const blocked = [];
  const tested = [];
  world.resetDoors(false);
  for (const [index, from] of route.feet.entries()) {
    for (const action of actions.get(index) ?? []) {
      const door = doors.get(action.position.join(','));
      if (!door) throw new Error(`Route door ${action.position.join(', ')} is missing`);
      world.setDoor(door, true);
      output.push(['d', ...door.position, door.open.split(':').at(-1)].join(' '));
    }
    if (!probes.has(index + 1)) continue;
    const to = route.feet[index + 1];
    const mode = modes.get(index + 1);
    if (!mode) throw new Error(`Native movement leg ${index + 1} has no route movement mode`);
    const traversal = specialLink(browser, nodes(from), nodes(to), mode, true);
    if (!traversal) {
      blocked.push({leg:index + 1, mode, from, to});
      continue;
    }
    output.push(['r', ...from].join(' '));
    for (const sample of traversal.path) output.push(['m', ...sample, index + 1].join(' '));
    tested.push({leg:index + 1, mode, samples:traversal.path.length});
  }
  return {walk: `${output.join('\n')}\n`, blocked, tested};
}

function main(args) {
  const extended = args.includes('--extended');
  args = args.filter(value => value !== '--extended');
  if (args[0] === '--replay') {
    const report = JSON.parse(readFileSync(resolve(args[1]), 'utf8'));
    const replay = verifyGameRoute(report, resolve(args[2] ?? defaultWorld), resolve(args[3] ?? defaultModels));
    console.log(JSON.stringify(replay, null, 2));
    return;
  }
  if (args[0] === '--native-tsv') {
    const report = JSON.parse(readFileSync(resolve(args[1]), 'utf8'));
    writeFileSync(resolve(args[2]), nativeTsv(report.route));
    return;
  }
  if (args[0] === '--movement-probes') {
    const [, routePath, nativeResults, originalWalk, output, world = defaultWorld, models = defaultModels] = args;
    if (!output) throw new Error('Pass the route JSON, native results TSV, original walk TSV, and output TSV');
    const {route} = JSON.parse(readFileSync(resolve(routePath), 'utf8'));
    const probes = movementProbes(route, resolve(nativeResults), resolve(originalWalk), makeWorld(resolve(world), resolve(models), true));
    writeFileSync(resolve(output), probes.walk);
    console.log(JSON.stringify({blocked:probes.blocked, tested:probes.tested}, null, 2));
    return;
  }
  const directory = resolve(args[0] ?? defaultWorld);
  const output = resolve(args[1] ?? defaultOutput);
  const models = resolve(args[2] ?? defaultModels);
  const inputs = args.slice(3);
  if (inputs.length & 1) throw new Error('Pass each native result and its original walk TSV together');
  const nativeBlocked = new Set();
  for (let i = 0; i < inputs.length; i += 2) readNativeBlocks(inputs[i], inputs[i + 1], nativeBlocked);
  mkdirSync(output, { recursive: true });
  const result = buildingSurvey(directory, models, nativeBlocked, extended);
  writeFileSync(join(output, 'route.json'), JSON.stringify(result, null, 2) + '\n');
  const poseLines = poses => poses.map(pose => [pose.id, ...pose.feet, pose.yaw, pose.pitch].join(' ')).join('\n') + '\n';
  writeFileSync(join(output, 'poses.txt'), poseLines(result.route.checkpoints));
  const capture = captureBatch(result.route.checkpoints);
  writeFileSync(join(output, 'capture-poses.txt'), poseLines(capture));
  writeFileSync(join(output, 'capture-poses.json'), JSON.stringify(capture, null, 2) + '\n');
  writeFileSync(join(output, 'walk.tsv'), nativeTsv(result.route));
  console.log(JSON.stringify({ output, scope: result.scope, counts: result.counts }, null, 2));
}

export function nativeTsv(route) {
  const actions = Map.groupBy(route.actions, action => action.pathIndex);
  const traversal = new Map((route.movementSegments ?? []).map(segment => [segment.pathIndex, segment.samples]));
  return route.feet.flatMap((feet, pathIndex) => [
    ...(traversal.get(pathIndex) ?? []).map(sample => ['m', ...sample, pathIndex].join(' ')),
    traversal.has(pathIndex) ? ['m', ...feet, pathIndex].join(' ') : ['p', ...feet].join(' '),
    ...(actions.get(pathIndex) ?? []).map(action => ['d', ...action.position, action.cell.split(':').at(-1)].join(' ')),
  ]).join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
