import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Movement} from '../client/movement.mjs';
import {physics} from '../server/physics.mjs';
import {cameraAt, makeWorld, nativeTsv} from './building-survey.mjs';

// Restore the branches in the locally saved, unpruned native-body survey.
const [source, output, worldDirectory = 'generated/world', models = 'generated/models'] = process.argv.slice(2);
assert.ok(source && output, 'Pass the unpruned survey route.json and an output directory');
const report = JSON.parse(readFileSync(source, 'utf8'));
const {route} = report;
const world = makeWorld(worldDirectory, models, true);
assert.equal(report.scope.contentHash, world.manifest.contentHash, 'Survey and world hashes must agree');
const body = physics(world, world.surveyGeometry, world.cellAt);
const browser = new Movement(world);
const position = ([x, y, z]) => ({x, y, z});
const coords = ({x, y, z}) => [x, y, z];
const actions = Map.groupBy(route.actions, action => action.pathIndex);
const checkpoints = Map.groupBy(route.checkpoints, checkpoint => checkpoint.pathIndex);
const segments = new Map(route.movementSegments.map(segment => [segment.pathIndex, segment]));

function trace(from, to, jump = false, delay = 5) {
  const moving = position(from);
  const samples = [];
  const dt = .0125;
  browser.grounded = true;
  browser.fall = 0;
  browser.medium = null;
  for (let tick = 0; tick < 95; tick++) {
    const speed = (goal, value) => jump && tick < delay ? 0 : Math.max(-3.8, Math.min(3.8, (goal - value) / dt));
    const before = {...moving};
    browser.update(moving, speed(to[0], moving.x), speed(to[2], moving.z), jump && tick === 0, dt);
    assert.ok(body.movementAllowed(before, moving), `Server rejected ${coords(moving)} on ${from} → ${to}`);
    samples.push(coords(moving));
    if (browser.grounded && Math.hypot(...coords(moving).map((value, axis) => value - to[axis])) < .0125) {
      assert.ok(body.movementAllowed(moving, position(to)), `Server rejected landing ${to}`);
      return samples;
    }
  }
  throw new Error(`Browser could not reach ${to} from ${from}`);
}

const cover = {from: 22915, to: 22921, feet: [-20.5, -21, -21.5, -22, -22.5, -23, -23.5]
  .map(x => [x, 70, -94.5]).concat([[-23.5, 70, -95], [-23, 70.125, -95]])};
assert.deepEqual(route.feet[cover.from], [-20, 70, -94.5]);
assert.deepEqual(route.feet[cover.to], [-22.5, 70.125, -95]);
const lamp = {from: 104685, to: 104695, anchor: 104830,
  feet: [[-97, 70, 54], [-97, 71, 55], [-96.5, 71, 55.5], [-96.5, 71, 55]]};
assert.deepEqual(route.feet[lamp.from], [-96, 69.875, 56.5]);
assert.deepEqual(route.feet[lamp.to], route.feet[lamp.from]);
assert.deepEqual(route.feet[lamp.anchor], [-96.5, 69, 54.5]);
const underLamp = 111758;
assert.deepEqual(route.feet[underLamp], [-109, 70.125, 19]);
const cake = 111958;
assert.deepEqual(route.feet[cake], [-109, 66.5, 19]);

const exactY = new Map([[60.80000001, 60 + Math.fround(.8)], [70.80000001, 70 + Math.fround(.8)]]);
const precise = ([x, y, z]) => [x, exactY.get(y) ?? y, z];
const restored = {feet: [], actions: [], checkpoints: [], movementSegments: []};
function append(feet, segment) {
  const pathIndex = restored.feet.length;
  restored.feet.push(precise(feet));
  if (segment) restored.movementSegments.push({...segment, pathIndex, samples: segment.samples.map(precise)});
  return pathIndex;
}
function appendChecked(feet, mode, delay) {
  const samples = trace(restored.feet.at(-1), feet, mode === 'jump', delay);
  return append(feet, mode && {mode, samples});
}
function moveViews(views, pathIndex, reaim = false) {
  const feet = restored.feet[pathIndex];
  for (const view of views) {
    const angles = reaim && view.target ? cameraAt(position(feet), view.target) : {};
    restored.checkpoints.push({...view, ...angles, pathIndex, feet});
  }
}

const lampViews = route.checkpoints.filter(view => view.pathIndex > lamp.from && view.pathIndex <= lamp.to);
assert.equal(lampViews.length, 7);
world.resetDoors(false);
for (const [oldIndex, original] of route.feet.entries()) {
  const oldViews = checkpoints.get(oldIndex) ?? [];
  const oldActions = actions.get(oldIndex) ?? [];
  if (oldIndex > cover.from && oldIndex < cover.to || oldIndex > lamp.from && oldIndex <= lamp.to) {
    assert.equal(oldActions.length, 0, 'Branch replacements must preserve door interactions');
    assert.ok(oldViews.every(view => lampViews.includes(view)), 'Branch replacements must preserve views');
    continue;
  }
  const feet = oldIndex === cake ? [original[0], original[1] - 1 / 16, original[2]] : original;
  const pathIndex = oldIndex === underLamp ? appendChecked(feet, 'jump', 0)
    : oldIndex === cake || oldIndex === cake + 1 || oldIndex === cover.to ? appendChecked(feet)
    : append(feet, segments.get(oldIndex));
  moveViews(oldViews, pathIndex);
  for (const action of oldActions) {
    restored.actions.push({...action, pathIndex});
    const door = world.wooden.get(world.index(...action.position));
    assert.ok(door, `Unknown survey door ${action.position}`);
    world.setDoor(door, Boolean(Number(action.cell.split(':').at(-1)) & 4));
  }
  if (oldIndex === cover.from) for (const exit of cover.feet) appendChecked(exit);
  if (oldIndex === lamp.anchor) {
    const [first, second, room, detail] = lamp.feet;
    appendChecked(first, 'jump');
    appendChecked(second, 'jump');
    moveViews(lampViews.filter(view => view.id.startsWith('interior-2176-')), appendChecked(room, 'walk'));
    moveViews(lampViews.filter(view => !view.id.startsWith('interior-2176-')), appendChecked(detail, 'walk'), true);
    for (const step of [room, second, first, feet]) appendChecked(step, 'walk');
  }
}

assert.equal(restored.actions.length, route.actions.length);
assert.equal(restored.checkpoints.length, route.checkpoints.length);
Object.assign(route, restored);
route.length = route.feet.slice(1).reduce((total, feet, i) => total + Math.hypot(...feet.map((v, axis) => v - route.feet[i][axis])), 0);
Object.assign(report.counts, {routeSteps: route.feet.length - 1,
  stations: new Set(route.checkpoints.map(view => view.pathIndex)).size, cameraViews: route.checkpoints.length,
  movementSegments: Object.fromEntries([...Map.groupBy(route.movementSegments, segment => segment.mode)]
    .map(([mode, entries]) => [mode, entries.length]))});
for (const room of report.rooms) {
  // Reposition the representatives that depended on the incorrect support height.
  if (room.id === 'interior-2176') {
    room.representative = [...lamp.feet[2]];
    room.min[1] = room.max[1] = lamp.feet[2][1];
    room.level = lamp.feet[2][1];
  }
  if (room.id === 'interior-2114') room.representative = route.checkpoints.find(view => view.id === 'interior-2114-01-01').feet;
}
delete report.scope.nativePruning;
report.scope.restoredBranches = ['RedPower cover threshold', 'RedPower shaped lamp', 'cake'];

mkdirSync(output, {recursive: true});
writeFileSync(join(output, 'route.json'), JSON.stringify(report) + '\n');
writeFileSync(join(output, 'walk.tsv'), nativeTsv(route));
writeFileSync(join(output, 'route-poses.txt'), route.checkpoints.map(view => [view.id, ...view.feet, view.yaw, view.pitch].join(' ')).join('\n') + '\n');
console.log(JSON.stringify(report.counts, null, 2));
