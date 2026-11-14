import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Movement } from '../client/movement.mjs';
import { loadBase } from '../server/base.mjs';
import { createGame } from '../server/game.mjs';
import { openStore } from '../server/store.mjs';
import { registerMechanics } from '../server/mechanics.mjs';
import * as geometry from '../world/geometry.mjs';
import { modelFamilies, withExtractedModels } from '../world/extracted-models.mjs';

// Run from project: node qa/east-access.mjs REFERENCE_ROUTE OUTPUT [WORLD] [MODELS]
const [reference, output, worldDirectory = 'generated/world', modelsDirectory = 'generated/models'] =
  process.argv.slice(2);
assert.ok(reference && output, 'Supply a reference route and an output directory');
const report = JSON.parse(readFileSync(reference, 'utf8'));
const base = loadBase(worldDirectory);
assert.ok(base.manifest.bounds.maxX >= 117, 'The entire east hall must be playable');
const models = Object.fromEntries(modelFamilies.map(family =>
  [family, JSON.parse(readFileSync(join(modelsDirectory, family + '.json'), 'utf8'))]));
const physicalGeometry = withExtractedModels(geometry, models);
const xyz = ([x, y, z]) => ({x, y, z});
const point = ({x, y, z}) => [x, y, z];
const address = ([x, y, z]) => [x, y, z].join(',');
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const anchor = [91, 65, 45];
const nearHall = [90.5, 65.25, 54.5];
const farHall = [117.5, 65, 52.5];

// Straight pieces retain the half-block probes, and the dance floor alternates its cover depths.
const turns = [
  anchor, [94.5, 65, 45], [94.5, 65, 43.5], [95.5, 65, 43.5],
  [96, 65.125, 43.5], [96, 65.125, 43], [96.5, 65.125, 43], [97, 65.5, 43],
  [100.5, 65.5, 43], [100.5, 66, 43.5], [100.5, 66, 45.5], [99.5, 66, 45.5],
  [99.5, 65.5, 46], [99.5, 65.5, 47], [99.5, 65, 47.5], [99, 65, 47.5],
  [98.5, 66, 47.5], [97, 66, 47.5], [96.5, 65, 47.5], [90.5, 65, 47.5],
  [90.5, 65, 52.5], [90.5, 66, 53], [90.5, 66, 54], nearHall,
];
const route = [anchor];
for (let i = 1; i < turns.length; i++) {
  const [x, y, z] = turns[i], [lastX, lastY, lastZ] = turns[i - 1];
  const steps = Math.round(2 * Math.hypot(x - lastX, z - lastZ));
  for (let step = 1; step <= steps; step++) {
    const f = step / steps;
    route.push([lastX + (x - lastX) * f, lastY + (y - lastY) * f, lastZ + (z - lastZ) * f]);
  }
}
const covers = [.25, .25, .125, .125, .125, .25, .25, 0];
for (let i = 1; i <= 47; i++) route.push([90.5 + i * .5, 65 + covers[i % covers.length], 54.5]);
route.push([114.5, 65, 54.5], [115, 65, 54.5], [115.5, 65, 54.5], [116, 66, 54.5],
  [116.5, 66, 54.5], [117, 66, 54.5], [117.5, 66, 54.5], [117.5, 66, 54],
  [117.5, 66, 53.5], [117.5, 66, 53], farHall);

const store = openStore(':memory:');
try {
  let now = 0;
  const modules = registerMechanics(base, store, physicalGeometry).filter(module => module.id !== 'diagnostic');
  const game = createGame(base, store, physicalGeometry, { modules, clock: () => now });
  const { id } = store.createPlayer();
  const edits = new Map();
  function apply(result) {
    for (const change of result?.changes ?? []) edits.set(address(point(change)), change);
  }
  const world = {
    models,
    manifest: base.manifest,
    hasChunk: (x, z) => base.inBounds(x, 65, z),
    cellAt(x, y, z) {
      const edit = edits.get(address([x, y, z]));
      const original = base.getCell(x, y, z);
      const key = edit ? edit.cell : original.key;
      return !key || key === 'air' ? null : {key, object: edit ? edit.object : original.object,
        parts: base.manifest.compositions?.[key]?.parts};
    },
  };
  function move(target, elapsed) {
    now += elapsed;
    apply(game.advance());
    apply(game.position(id, xyz(target)));
  }

  const approach = route.slice(0, 3);
  const approachIndex = approach.findIndex(target =>
    report.route.feet.some(position => distance(position, target) < .001));
  assert.ok(approachIndex >= 0, 'Reference route must connect to the eastern approach at ' + address(anchor));
  const start = approach[approachIndex];
  const pathIndex = report.route.feet.findIndex(position => distance(position, start) < .001);
  const actions = Map.groupBy(report.route.actions, action => action.pathIndex);
  const special = new Map(report.route.movementSegments.map(segment => [segment.pathIndex, segment.samples]));
  let request = 0;
  for (let index = 0; index <= pathIndex; index++) {
    for (const sample of special.get(index) ?? []) move(sample, 50);
    move(report.route.feet[index], 125);
    for (const action of actions.get(index) ?? []) {
      const target = action.interactionPosition;
      const result = game.action(id, { ...xyz(target), type: 'interact', requestId: 'east-access-' + ++request,
        expectedRevision: edits.get(address(target))?.revision ?? 0 });
      assert.equal(result.status, 200, 'Reference interaction ' + address(target));
      apply(result.output);
    }
  }
  const savedDoors = [[100, 66, 44], [101, 66, 44]].map(position =>
    [...position, world.cellAt(...position)?.key]);
  assert.deepEqual(savedDoors.map(door => door[3]), ['legacy:64:7', 'legacy:64:3']);

  const movement = new Movement(world);
  const position = xyz(start);
  const samples = [start], milestones = [];
  movement.grounded = true;
  const dt = .0125;
  for (const target of route.slice(approachIndex + 1)) {
    const jump = target[1] > position.y + .50001;
    for (let tick = 0; tick < 95; tick++) {
      const speed = (goal, at) => jump && tick < 5 ? 0 : Math.max(-3.8, Math.min(3.8, (goal - at) / dt));
      movement.update(position, speed(target[0], position.x), speed(target[2], position.z), jump && tick === 0, dt);
      const sample = point(position);
      move(sample, dt * 1000);
      samples.push(sample);
      if (movement.grounded && distance(sample, target) < .02) break;
      assert.ok(tick < 94, 'Browser could not traverse to ' + address(target));
    }
    milestones.push({ target, sampleIndex: samples.length - 1 });
  }
  assert.ok(distance(point(position), farHall) < .02);

  mkdirSync(output, {recursive: true});
  const result = {worldHash:base.hash, referenceWorldHash:report.scope.contentHash, pathIndex,
    start, endpoint:point(position), savedDoors, milestones, samples};
  writeFileSync(join(output, 'east-access.json'), JSON.stringify(result, null, 2) + '\n');
  const roundNoise = value => Math.abs(value - Math.round(value * 8) / 8) < .00001 ? Math.round(value * 8) / 8 : value;
  writeFileSync(join(output, 'east-walk.tsv'), samples.map((sample, index) =>
    [index === 0 ? 'r' : 'm', ...sample.map(roundNoise)].join(' ')).join('\n') + '\n');
  const poses = [
    ['east-exterior', ...anchor, 90, 0], ['east-main-entrance', 100.5, 65.5, 43, 0, -3],
    ['east-interior-west', ...nearHall, 90, 0], ['east-interior-east', ...nearHall, -90, 0],
    ['east-interior-south', ...nearHall, 0, 0], ['east-far-interior', ...farHall, 90, 0],
  ];
  writeFileSync(join(output, 'east-poses.txt'), poses.map(row => row.join(' ')).join('\n') + '\n');
  console.log(JSON.stringify({pathIndex, legs:milestones.length, samples:samples.length, endpoint:result.endpoint}));
} finally {
  store.close();
}
