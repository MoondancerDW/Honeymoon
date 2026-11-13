import { performance } from 'node:perf_hooks';
import { displayObject, cellAddress } from './base.mjs';
import { RequestError } from './errors.mjs';
import { registerMechanics } from './mechanics.mjs';
import { PLAYER, physics } from './physics.mjs';

const actions = new Set(['place', 'remove', 'copy', 'interact']);
const axes = ['x', 'y', 'z'];
const MOVEMENT_GRACE = 0.24;
const RUN_SPEED = 9;
const MAX_ACTIVE_IDLE_MS = 30000;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;

function point(input, integers = false) {
  const valid = integers ? Number.isSafeInteger : Number.isFinite;
  if (!input || axes.some(axis => !valid(input[axis]))) throw new RequestError(400, 'invalid_coordinates');
  return { x: input.x, y: input.y, z: input.z };
}

function normalizeAction(body) {
  if (typeof body.requestId !== 'string' || !REQUEST_ID.test(body.requestId)) throw new RequestError(400, 'invalid_request_id');
  if (!actions.has(body.type)) throw new RequestError(400, 'unknown_action');
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw new RequestError(400, 'invalid_revision');
  const input = { type: body.type, ...point(body, true), expectedRevision: body.expectedRevision };
  if (body.hit !== undefined) input.hit = point(body.hit);
  if (body.type === 'place') {
    if (typeof body.cell !== 'string' || body.cell.length > 128) throw new RequestError(400, 'invalid_cell');
    input.cell = body.cell;
    if (body.against !== undefined) input.against = point(body.against, true);
  }
  return input;
}

export function createGame(base, store, geometry, { clock = () => performance.now(), modules } = {}) {
  const positions = new Map();
  const mechanics = modules ?? registerMechanics(base, store, geometry);
  const [sx, sy, sz] = base.manifest.spawn;
  const spawn = Object.freeze({ x: sx, y: sy, z: sz });
  const diagnostic = mechanics.find(module => module.id === 'diagnostic');
  const reserved = (x, y, z) => mechanics.some(module => module.reserved?.(x, y, z));
  const spawnProtected = (x, y, z) => x === Math.floor(sx) && z === Math.floor(sz)
    && y >= Math.floor(sy) && y <= Math.floor(sy + PLAYER.height);
  const originalAt = (x, y, z) => JSON.stringify(base.getCell(x, y, z));
  const conflicts = store.rebase(base, reserved, originalAt);

  const snapshotCells = () => mechanics.flatMap(module => module.snapshot?.() ?? []);
  let mechanicCells = new Map();
  function refreshMechanicCells() {
    mechanicCells = new Map(snapshotCells().map(cell => [cellAddress(cell.x, cell.y, cell.z), cell]));
  }
  refreshMechanicCells();

  function getCurrent(x, y, z) {
    const edit = mechanicCells.get(cellAddress(x, y, z)) ?? store.getEdit(x, y, z);
    if (edit) return { x, y, z, cell: edit.cell, object: edit.object, revision: edit.revision };
    const original = base.getCell(x, y, z);
    return { x, y, z, cell: original.key === 'air' ? null : original.key, object: original.object, revision: 0 };
  }

  const physical = physics(base, geometry, (x, y, z) => {
    const { cell, object } = getCurrent(x, y, z);
    const parts = base.manifest.compositions?.[cell]?.parts;
    return cell === null ? null : { key: cell, object, parts };
  });

  function playerAt(player) {
    return positions.get(player)?.position ?? spawn;
  }

  function playerOverlaps(x, y, z, key, activePlayer, plannedNeighbor) {
    const now = clock();
    if (physical.overlaps(playerAt(activePlayer), x, y, z, key, plannedNeighbor)) return true;
    for (const [player, entry] of positions) {
      if (player !== activePlayer && now - entry.updated < MAX_ACTIVE_IDLE_MS
        && physical.overlaps(entry.position, x, y, z, key, plannedNeighbor)) return true;
    }
    return false;
  }

  function moduleContext(module, player, fields) {
    return {
      ...fields,
      player,
      getCell: getCurrent,
      readState: (owner, key) => store.getState(module.id, owner, key),
      playerOverlaps: (x, y, z, cell, plannedNeighbor) => playerOverlaps(x, y, z, cell, player, plannedNeighbor),
    };
  }

  function writePlan(module, plan) {
    const revision = plan.cells?.length ? store.nextRevision() : store.worldRevision();
    const changes = (plan.cells ?? []).map(cell => ({ ...cell, revision }));
    for (const change of changes) {
      const { x, y, z } = change;
      if (!module.reserved?.(x, y, z)) store.writeEdit(change, originalAt(x, y, z));
    }
    for (const entry of plan.state ?? []) {
      const value = entry.useRevision ? { ...entry.value, revision } : entry.value;
      store.putState(module.id, entry.owner, entry.key, module.version, value);
    }
    return {
      worldRevision: revision,
      changes: changes.map(change => ({ ...change, object: displayObject(change.object) })),
      effects: plan.effects ?? [],
    };
  }

  function writeCell(current, cell, object) {
    const revision = store.nextRevision();
    const { x, y, z } = current;
    const change = { x, y, z, cell, object, revision };
    store.writeEdit(change, originalAt(x, y, z));
    return { worldRevision: revision, changes: [change], effects: [] };
  }

  function placementAnchor(player, input) {
    const { x, y, z } = input;
    const position = playerAt(player);
    const distanceToCell = (value, minimum) => Math.max(minimum - value, value - minimum - 1, 0);
    if (Math.hypot(distanceToCell(position.x, x), distanceToCell(position.y + PLAYER.eye, y), distanceToCell(position.z, z)) > 6) return false;
    const adjacent = [
      [x - 1, y, z], [x + 1, y, z], [x, y - 1, z], [x, y + 1, z], [x, y, z - 1], [x, y, z + 1],
    ];
    const candidates = input.against ? adjacent.filter(([ax, ay, az]) => ax === input.against.x && ay === input.against.y && az === input.against.z) : adjacent;
    return candidates.some(([ax, ay, az]) => physical.visible(position, ax, ay, az, input.hit));
  }

  function execute(player, input) {
    const { x, y, z, type } = input;
    if (!base.inBounds(x, y, z)) throw new RequestError(403, 'outside_playable_area');
    const current = getCurrent(x, y, z);
    if (input.expectedRevision !== current.revision) {
      throw new RequestError(409, 'stale_cell', { current: { ...current, object: displayObject(current.object) }, worldRevision: store.worldRevision() });
    }
    if (type === 'place') {
      if (reserved(x, y, z) || spawnProtected(x, y, z)) throw new RequestError(403, 'protected_cell');
      if (!base.catalog.has(input.cell) || input.cell === 'air') throw new RequestError(400, 'unknown_cell_type');
      if (current.cell !== null) throw new RequestError(409, 'occupied');
      if (!placementAnchor(player, input)) throw new RequestError(403, 'outside_reach');
      if (playerOverlaps(x, y, z, input.cell, player)) throw new RequestError(409, 'occupied');
      const copied = store.getClipboard(player);
      const object = copied?.cell === input.cell && copied.object
        ? { ...copied.object, position: [x, y, z], key: `tile:${x}:${y}:${z}` }
        : null;
      return writeCell(current, input.cell, object);
    }

    if (current.cell === null) throw new RequestError(409, 'empty_cell');
    if (!physical.visible(playerAt(player), x, y, z, input.hit)) throw new RequestError(403, 'outside_reach');
    if (type === 'interact') {
      for (const module of mechanics) {
        const plan = module.prepareInteraction?.(moduleContext(module, player, { x, y, z, current, input }));
        if (plan) return writePlan(module, plan);
      }
      throw new RequestError(409, 'no_interaction');
    }
    if (reserved(x, y, z)) throw new RequestError(403, 'protected_cell');
    if (type === 'copy') {
      store.putClipboard(player, { cell: current.cell, object: displayObject(current.object) });
      return { worldRevision: store.worldRevision(), changes: [], effects: [], cell: current.cell };
    }
    return writeCell(current, null, null);
  }

  function action(player, body) {
    const input = normalizeAction(body);
    const encoded = JSON.stringify(input);
    const { requestId } = body;
    const result = store.atomic(() => {
      const receipt = store.getReceipt(player, requestId);
      if (receipt) {
        if (receipt.input !== encoded) throw new RequestError(409, 'request_id_reused');
        return { status: receipt.status, output: receipt.output, replay: true };
      }

      let status = 200;
      let output;
      // A rejected action can record a receipt, but may never leave partial writes.
      store.db.exec('SAVEPOINT action');
      try {
        output = execute(player, input);
      } catch (error) {
        store.db.exec('ROLLBACK TO action');
        if (!(error instanceof RequestError)) throw error;
        status = error.status;
        output = { error: error.code, ...error.details };
      }
      store.db.exec('RELEASE action');
      store.putReceipt(player, requestId, encoded, status, output);
      return { status, output, replay: false };
    });
    if (!result.replay && result.status === 200 && result.output.changes.length) refreshMechanicCells();
    return result;
  }

  function position(player, body) {
    const target = point(body);
    const previous = playerAt(player);
    const now = clock();
    const old = positions.get(player);
    const elapsed = Math.min(0.65, (now - (old?.updated ?? now - 100)) / 1000);
    const budget = Math.min(1.5, (old?.budget ?? 1) + elapsed * RUN_SPEED);
    const horizontalDistance = Math.hypot(target.x - previous.x, target.z - previous.z);
    const verticalDistance = target.y - previous.y;
    const distance = Math.hypot(horizontalDistance, Math.max(verticalDistance, 0));
    const bounds = base.manifest.bounds;
    if (target.x - PLAYER.halfWidth < bounds.minX || target.x + PLAYER.halfWidth > bounds.maxX + 1
      || target.z - PLAYER.halfWidth < bounds.minZ || target.z + PLAYER.halfWidth > bounds.maxZ + 1
      || target.y < bounds.minY || target.y + PLAYER.height > bounds.maxY + 1
      || distance > budget + MOVEMENT_GRACE || verticalDistance < -6 || !physical.movementAllowed(previous, target)) {
      throw new RequestError(409, 'movement_blocked', { position: previous });
    }

    const results = store.atomic(() => {
      const entries = [];
      for (const module of mechanics) {
        const plan = module.prepareEntry?.(moduleContext(module, player, { position: target, previous }));
        if (plan) entries.push(writePlan(module, plan));
      }
      return entries;
    });
    const effects = results.flatMap(result => result.effects);
    const changes = results.flatMap(result => result.changes);
    if (changes.length) refreshMechanicCells();
    positions.set(player, { position: target, updated: now, budget: budget - distance });
    return { position: target, effects, changes, worldRevision: store.worldRevision() };
  }

  const descriptions = player => diagnostic?.describe(player) ?? null;

  return {
    action,
    position,
    respawn(player) {
      positions.set(player, { position: spawn, updated: clock(), budget: 1 });
      return { position: spawn, effects: [], worldRevision: store.worldRevision() };
    },
    conflicts,
    contentHash: base.hash,
    worldRevision: store.worldRevision,
    session(playerId) {
      if (!positions.has(playerId)) positions.set(playerId, { position: spawn, updated: clock(), budget: 1 });
      return {
        playerId, spawn: base.manifest.spawn, position: playerAt(playerId), worldRevision: store.worldRevision(),
        catalogVersion: base.manifest.catalogVersion ?? 1, importVersion: base.manifest.importVersion, contentHash: base.hash,
        mechanics: descriptions(playerId),
      };
    },
    snapshot(player) {
      return {
        bounds: base.manifest.bounds, spawn: base.manifest.spawn, worldRevision: store.worldRevision(), contentHash: base.hash,
        overrides: [...store.edits().map(edit => ({ ...edit, object: displayObject(edit.object) })), ...snapshotCells()],
        mechanics: descriptions(player),
      };
    },
    didCommit(event) {
      for (const module of mechanics) module.onCommitted?.(event);
    },
  };
}
