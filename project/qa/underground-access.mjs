import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Movement} from '../client/movement.mjs';
import {loadBase} from '../server/base.mjs';
import {createGame} from '../server/game.mjs';
import {registerMechanics} from '../server/mechanics.mjs';
import {openStore} from '../server/store.mjs';
import {modelFamilies, withExtractedModels} from '../world/extracted-models.mjs';
import * as geometry from '../world/geometry.mjs';

const entrance = [-57.5, 65, -54.5];
const ladderHead = [-49.5, 57, -51.5];
const bottom = [-48.5, 53, -52.5];
const hall = [-34.5, 53, -42];
const exit = [-57.25, 65.125, -56.5];
const toLadder = [
  [-56.5, 62.5, -54.5],
  [-56.5, 60, -51.5],
  ladderHead,
];
const toHall = [bottom, [-42.5, 53, -52.5], [-42.5, 53, -42.5], [-34.5, 53, -42.5], hall];
const toExit = [
  [-49.5, 58.3, -52.5], ladderHead,
  toLadder[1], toLadder[0], [-56.5, 63.5, -55.25], [-56.5, 64, -56], [-56.5, 64.5, -56.5],
  [-57, 65.125, -56.5], exit,
];
const poses = [
  ['underground-entrance', ...entrance, -90, 15],
  ['underground-stairs', ...toLadder[1], -90, 14],
  ['underground-ladder', ...bottom, 90, -16],
  ['underground-hall-north', ...hall, 180, 0],
  ['underground-hall-east', ...hall, -90, 0],
  ['underground-hall-south', ...hall, 0, 0],
  ['underground-exit-platform', ...exit, -90, 20],
];
const asPosition = ([x, y, z]) => ({x, y, z});
const asFeet = ({x, y, z}) => [x, y, z];
const distance = (a, b) => Math.hypot(...a.map((coordinate, i) => coordinate - b[i]));
export function runAccess(routePath, output, worldPath, modelPath, branch) {
  const {name, start, poses, travel} = branch;
  assert.ok(routePath && output, `Usage: node qa/${name}-access.mjs ROUTE_JSON OUTPUT [WORLD] [MODELS]`);
  const {scope, route} = JSON.parse(readFileSync(routePath, 'utf8'));
  const base = loadBase(worldPath ?? 'generated/world');
  assert.equal(scope.contentHash, base.hash, 'Route and world must use the same import');
  const models = Object.fromEntries(modelFamilies.map(family =>
    [family, JSON.parse(readFileSync(join(modelPath ?? 'generated/models', `${family}.json`), 'utf8'))]));
  const physicalGeometry = withExtractedModels(geometry, models);
  const approach = route.feet.findIndex(feet => distance(feet, start) < .001);
  assert.ok(approach >= 0, `The district route needs to reach ${start}`);
  const store = openStore(':memory:');
  try {
    let now = 0;
    const modules = registerMechanics(base, store, physicalGeometry).filter(module => module.id !== 'diagnostic');
    const game = createGame(base, store, physicalGeometry, {modules, clock: () => now});
    const {id} = store.createPlayer();
    const edits = new Map();
    function apply(result) {
      for (const edit of result?.changes ?? []) edits.set(asFeet(edit).join(), edit);
    }
    function move(target, elapsed) {
      now += elapsed;
      apply(game.advance());
      apply(game.position(id, asPosition(target)));
    }
    const world = {
      models,
      manifest: base.manifest,
      hasChunk: (x, z) => base.inBounds(x, 65, z),
      cellAt(x, y, z) {
        const edit = edits.get([x, y, z].join());
        const original = base.getCell(x, y, z);
        const key = edit ? edit.cell : original.key;
        return key && key !== 'air' ? {key, object: edit ? edit.object : original.object,
          parts: base.manifest.compositions?.[key]?.parts} : null;
      },
    };

    const actions = Map.groupBy(route.actions, action => action.pathIndex);
    const special = new Map(route.movementSegments.map(segment => [segment.pathIndex, segment.samples]));
    let request = 0;
    for (let index = 0; index <= approach; index++) {
      for (const sample of special.get(index) ?? []) move(sample, 50);
      move(route.feet[index], 125);
      for (const action of actions.get(index) ?? []) {
        const target = action.interactionPosition;
        const response = game.action(id, {...asPosition(target), type:'interact', requestId:`qa-${name}-${++request}`,
          expectedRevision: edits.get(target.join())?.revision ?? 0});
        assert.equal(response.status, 200, `District interaction ${target}`);
        apply(response.output);
      }
    }

    const movement = new Movement(world);
    movement.grounded = true;
    const player = asPosition(start);
    const samples = [start];
    const milestones = [];
    function walk(target, {descend = false, rise = false, grounded = true, jump = false} = {}) {
      const seconds = .0125;
      for (let tick = 0; tick < 450; tick++) {
        const [x, , z] = target;
        const dx = x - player.x;
        const dz = z - player.z;
        const scale = Math.min(1 / seconds, 3.8 / (Math.hypot(dx, dz) || 1));
        movement.update(player, dx * scale, dz * scale, jump && tick === 0, seconds, {descend, rise});
        const next = asFeet(player);
        move(next, seconds * 1000);
        samples.push(next);
        if (distance(next, target) < .025 && (!grounded || movement.grounded)) {
          milestones.push({target, sampleIndex: samples.length - 1});
          return;
        }
      }
      assert.fail(`Cannot reach ${target} from ${asFeet(player)}`);
    }

    const details = travel(walk, () => ({feet:asFeet(player), sample:samples.length - 1}));
    mkdirSync(output, {recursive:true});
    const result = {worldHash:base.hash, approach, entrance:start, ...details, milestones, samples};
    writeFileSync(join(output, `${name}-access.json`), JSON.stringify(result, null, 2) + '\n');
    const snap = value => Math.abs(value - Math.round(value * 8) / 8) < .00001 ? Math.round(value * 8) / 8 : value;
    writeFileSync(join(output, `${name}-walk.tsv`), samples.map((sample, index) =>
      [index === 0 ? 'r' : 'm', ...sample.map(snap)].join(' ')).join('\n') + '\n');
    writeFileSync(join(output, `${name}-poses.txt`), poses.map(pose => pose.join(' ')).join('\n') + '\n');
    console.log(JSON.stringify({approach, ...details, samples: samples.length}));
  } finally {
    store.close();
  }
}

function travel(walk, current) {
  for (const target of toLadder) walk(target);
  // One block east of the ladder's stored X falls outside its climb column.
  walk([-49.5, 53, -52.5], {descend: true});
  for (const target of toHall) walk(target);
  const {feet:reached, sample:hallSample} = current();

  for (const target of toHall.slice(0, -1).reverse()) walk(target);
  walk(toExit[0], {rise:true, grounded:false});
  walk(toExit[1], {rise:true});
  for (const target of toExit.slice(2, 7)) walk(target);
  walk(toExit[7], {jump:true});
  walk(exit);
  return {reached, returned:current().feet, hallSample};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [routePath, output, worldPath, modelPath] = process.argv.slice(2);
  runAccess(routePath, output, worldPath, modelPath, {name:'underground', start:entrance, poses, travel});
}
