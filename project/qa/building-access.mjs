import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Movement } from '../client/movement.mjs';
import { createGame } from '../server/game.mjs';
import { loadBase } from '../server/base.mjs';
import { openStore } from '../server/store.mjs';
import { registerMechanics } from '../server/mechanics.mjs';
import { modelFamilies, withExtractedModels } from '../world/extracted-models.mjs';
import * as geometry from '../world/geometry.mjs';

const xyz = ([x, y, z]) => ({ x, y, z });
const feet = ({x, y, z}) => [x, y, z];
const address = (...coordinates) => coordinates.join(',');
const same = (a, b) => a.every((value, i) => value === b[i]);
const iron = [-91, 65, 39];
const outside = [-90, 66, 39];
const inside = [-92, 66, 39];
const outsideStand = [-89.625, 65, 39.375];
const insideStand = [-92, 65, 38.5];
const doorStart = [-88.5, 65, 37.5];
const approach = [[-88.75, 65, 37.5], [-88.75, 65, 38.25], [-89.625, 65, 38.25], outsideStand];
const crossing = [[-90.625, 65, 39.375], [-90.625, 65, 38.625], [-92, 65, 38.625], insideStand];

const [input = 'work/building-survey/extended-validated/route.json', destination = 'work/building-survey/access'] =
  process.argv.slice(2);
const report = JSON.parse(readFileSync(resolve(input), 'utf8'));
const output = resolve(destination);
const base = loadBase(resolve('generated/world'));
const models = Object.fromEntries(modelFamilies.map(family => [family,
  JSON.parse(readFileSync(resolve('generated/models', family + '.json'), 'utf8'))]));
const physicalGeometry = withExtractedModels(geometry, models);
assert.equal(report.scope.contentHash, base.hash, 'Routes and playable world must share the same import');

function scenario() {
  const store = openStore(':memory:');
  let now = 0;
  const modules = registerMechanics(base, store, physicalGeometry).filter(module => module.id !== 'diagnostic');
  const game = createGame(base, store, physicalGeometry, { modules, clock: () => now });
  const {id} = store.createPlayer();
  const overrides = new Map();
  const apply = result => {
    for (const change of result?.changes ?? []) overrides.set(address(change.x, change.y, change.z), change);
    return result;
  };
  const world = {
    models,
    manifest: base.manifest,
    hasChunk: (x, z) => base.inBounds(x, base.manifest.spawn[1], z),
    cellAt(x, y, z) {
      const edit = overrides.get(address(x, y, z));
      const original = base.getCell(x, y, z);
      const key = edit ? edit.cell : original.key;
      return key === 'air' || key === null ? null : { key, object: edit ? edit.object : original.object,
        parts: base.manifest.compositions?.[key]?.parts };
    },
  };
  const movement = new Movement(world);
  let requestId = 0;
  function wait(ms) {
    now += ms;
    apply(game.advance?.());
  }
  function move(target, ms) {
    wait(ms);
    return apply(game.position(id, xyz(target)));
  }
  function interact(target) {
    const result = game.action(id, {...xyz(target), type: 'interact', requestId: 'access-' + ++requestId,
      expectedRevision: overrides.get(address(...target))?.revision ?? 0});
    assert.equal(result.status, 200, 'Interact ' + address(...target) + ': ' + JSON.stringify(result.output));
    return apply(result.output);
  }
  const actions = Map.groupBy(report.route.actions, action => action.pathIndex);
  const special = new Map(report.route.movementSegments.map(segment => [segment.pathIndex, segment.samples]));
  function reach(target) {
    const index = report.route.feet.findIndex(position => same(position, target));
    assert.ok(index >= 0, 'No certified route to ' + address(...target));
    for (let i = 0; i <= index; i++) {
      for (const sample of special.get(i) ?? []) move(sample, 50);
      move(report.route.feet[i], 125);
      for (const action of actions.get(i) ?? []) interact(action.interactionPosition);
    }
    return index;
  }
  return { game, id, movement, world, reach, move, interact, wait, close: () => store.close() };
}

function walkTurns(run, start, turns, speedLimit = 5.1) {
  const route = [start];
  const position = xyz(start);
  run.movement.fall = 0;
  run.movement.grounded = true;
  const dt = .0125;
  for (const target of turns) {
    for (let tick = 0; tick < 400; tick++) {
      const speed = (goal, at) => Math.max(-speedLimit, Math.min(speedLimit, (goal - at) / dt));
      run.movement.update(position, speed(target[0], position.x), speed(target[2], position.z), false, dt);
      const sample = feet(position);
      route.push(sample);
      run.move(sample, 12.5);
      if (Math.hypot(target[0] - position.x, target[1] - position.y, target[2] - position.z) < .02) break;
      if (tick === 399) throw new Error('Browser could not walk from ' + address(...start) + ' through ' + address(...target));
    }
  }
  return route;
}

function ironDoor() {
  const run = scenario();
  try {
    const pathIndex = run.reach(doorStart);
    const outerWalk = walkTurns(run, doorStart, approach);
    assert.equal(run.world.cellAt(...iron).key, 'legacy:71:2');
    const opening = run.interact(outside);
    assert.equal(run.world.cellAt(...iron).key, 'legacy:71:6');
    const transit = walkTurns(run, outsideStand, crossing);
    run.wait(1600);
    assert.equal(run.world.cellAt(...iron).key, 'legacy:71:2');
    const reopening = run.interact(inside);
    assert.equal(run.world.cellAt(...iron).key, 'legacy:71:6');
    const back = walkTurns(run, insideStand, [...crossing.slice(0, -1).reverse(), outsideStand]);
    run.wait(1100);
    assert.equal(run.world.cellAt(...iron).key, 'legacy:71:2');
    return {pathIndex, iron, outside, inside, outsideStand, insideStand,
      opening: opening.effects, reopening: reopening.effects, outerWalk, transit, back};
  } finally {
    run.close();
  }
}

function coveredStops() {
  const stops = [
    { name: 'north-cellar', feet: [-48, 60, -93], barrier: [-54, 65, -91] },
    { name: 'loft', feet: [-47.5, 74, 58.5] },
    { name: 'west-cellar', feet: [-61.5, 60, 58.5], barrier: [-60, 64, 56] },
    { name: 'attic', feet: [-64, 74, 28], barrier: [-72, 73, 28] },
  ];
  return stops.map(stop => {
    const pathIndex = report.route.feet.findIndex(point => same(point, stop.feet));
    const sample = report.rooms.find(room => same(room.representative, stop.feet));
    return {...stop, pathIndex, room: sample?.id ?? null, standSamples: sample?.standSamples ?? 0};
  });
}

function westCellar(stops) {
  const run = scenario();
  const start = [-60, 65.125, 56.5];
  const target = stops.find(stop => stop.name === 'west-cellar').feet;
  const position = xyz(start);
  const frames = [start];
  try {
    const pathIndex = run.reach(start);
    run.movement.fall = 0;
    run.movement.grounded = true;
    // Traverse the opening at its center and descend using the mounted ladder.
    for (let tick = 0; tick < 300; tick++) {
      const dx = Math.min(1, Math.max(0, (-59.5 - position.x) * 40));
      run.movement.update(position, dx, 0, false, .0125, {descend: true});
      const sample = feet(position);
      frames.push(sample);
      run.move(sample, 12.5);
      if (dx < .02 && run.movement.grounded && Math.abs(position.y - 60) < .02) break;
    }
    assert.ok(Math.abs(position.y - 60) < .02, 'West cellar descent never reached its floor');
    const basement = walkTurns(run, feet(position), [[-59.5, 60, 57.5], [-60.5, 60, 57.5],
      [-60.5, 60, 58.5], target], 3.8);
    return {pathIndex, arrival: target, descent: frames, basement, returnVerified: false};
  } finally {
    run.close();
  }
}

function swim() {
  const run = scenario();
  const shore = [-43.5, 66, -2];
  const position = xyz(shore);
  const frames = [shore];
  let waterFrames = 0;
  let deepest = shore;
  try {
    const pathIndex = run.reach(shore);
    run.movement.fall = 0;
    run.movement.grounded = true;
    for (let tick = 0; tick < 300; tick++) {
      const dz = tick < 95 ? 2.8 : Math.max(-2.8, Math.min(0, (shore[2] - position.z) / .0125));
      run.movement.update(position, 0, dz, false, .0125, {rise: true});
      const sample = feet(position);
      frames.push(sample);
      run.move(sample, 12.5);
      if (run.movement.medium === 'water') waterFrames++;
      if (deepest[1] > position.y) deepest = sample;
      if (tick > 95 && run.movement.grounded && Math.hypot(shore[1] - position.y, shore[2] - position.z) < .02) {
        assert.ok(waterFrames > 0, 'Pond crossing never entered water');
        return {pathIndex, shore, deepest, waterFrames, frames};
      }
    }
    throw new Error('Pond crossing never returned to the shore');
  } finally {
    run.close();
  }
}

const covered = coveredStops();
const result = { ironDoor: ironDoor(), covered, westCellar: westCellar(covered), swim: swim() };
mkdirSync(output, {recursive: true});
writeFileSync(join(output, 'access.json'), JSON.stringify(result, null, 2) + '\n');
writeFileSync(join(output, 'iron-poses.txt'), [
  ['iron-outside', ...outsideStand, 90, 4], ['iron-inside', ...insideStand, -90, 5],
  ['iron-inside-west', ...insideStand, 90, 2],
].map(line => line.join(' ')).join('\n') + '\n');
writeFileSync(join(output, 'covered-poses.txt'), covered.flatMap(({name, feet: position}) => [0, 90, 180, 270].map(yaw =>
  [`access-${name}-${yaw}`, ...position, yaw, 3].join(' '))).join('\n') + '\n');
writeFileSync(join(output, 'swim-poses.txt'), [
  ['pond-shore', ...result.swim.shore, 0, 18],
  ['pond-swimming', ...result.swim.deepest, 0, 6],
].map(row => row.join(' ')).join('\n') + '\n');
const nativeWalk = (name, path) => writeFileSync(join(output, name + '-walk.tsv'),
  path.map(point => ['m', ...point].join(' ')).join('\n') + '\n');
nativeWalk('pond', result.swim.frames);
// The half-open browser collision test allows sub-pixel penetration when settling.
// Use the original full-block floor height for the native sweep of this basement.
const basementWalk = [...result.westCellar.descent, ...result.westCellar.basement.slice(1)].map(([x, y, z]) =>
  [x, Math.abs(y - 60) < .00001 ? 60 : y, z]);
nativeWalk('west-cellar', basementWalk);
const ironWalk = [
  ...result.ironDoor.outerWalk.map(point => ['m', ...point]),
  ['d', ...iron, 6],
  ...result.ironDoor.transit.slice(1).map(point => ['m', ...point]),
  ['d', ...iron, 2],
  ['d', ...iron, 6],
  ...result.ironDoor.back.slice(1).map(point => ['m', ...point]),
  ['d', ...iron, 2],
];
writeFileSync(join(output, 'iron-walk.tsv'), ironWalk.map(row => row.join(' ')).join('\n') + '\n');
writeFileSync(join(output, 'native-branches.tsv'), [
  ['r', ...basementWalk[0]],
  ...basementWalk.slice(1).map(point => ['m', ...point]),
  ['r', ...result.swim.shore],
  ...result.swim.frames.slice(1).map(point => ['m', ...point]),
  ['r', ...result.ironDoor.outerWalk[0]],
  ...ironWalk.slice(1),
].map(row => row.join(' ')).join('\n') + '\n');
console.log(JSON.stringify({pathIndex: result.ironDoor.pathIndex, crossingSamples: result.ironDoor.transit.length,
  returnSamples: result.ironDoor.back.length, covered, westCellar: result.westCellar.arrival,
  swimSamples: result.swim.frames.length, output}, null, 2));
