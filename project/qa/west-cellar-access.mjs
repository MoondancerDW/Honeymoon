import assert from 'node:assert/strict';
import {runAccess} from './underground-access.mjs';

const start = [-60, 65.125, 56.5];
const room = [-61.5, 60, 58.5];
const shaftFloor = [-59.5, 60, 56.5];
const upperExit = [-60.5, 65.125, 56.5];
const hallTurns = [[-59.5, 60, 57.5], [-60.5, 60, 57.5], [-60.5, 60, 58.5], room];
const poses = [
  ['west-cellar-entry', ...start, -90, 55],
  ['west-cellar-room', ...room, 180, 3],
  ['west-cellar-new-rung', -59.5, 61.7, 56.45, 180, -68],
  ['west-cellar-exit', ...upperExit, -90, 45],
];

function travel(walk, current) {
  walk(shaftFloor, {descend: true});
  for (const target of hallTurns) walk(target);
  const {feet: reached, sample: roomSample} = current();
  for (const target of [...hallTurns.slice(0, -1).reverse(), shaftFloor]) walk(target);
  walk([-59.5, 65.03, 56.5], {rise: true, grounded: false});
  walk(upperExit, {rise: true});
  const returned = current().feet;
  assert.ok(returned[1] > 65.1 && returned[0] < -60.3, 'Player must stand outside the shaft');
  return {reached, returned, roomSample};
}

const [routePath, output, worldPath, modelPath] = process.argv.slice(2);
runAccess(routePath, output, worldPath, modelPath, {name: 'west-cellar', start, poses, travel, localStart: true});
