import {runAccess} from './underground-access.mjs';

const start = [-63.5, 74.5, 54];
const room = [-64, 74, 28];
const poses = [
  ['attic-roof-approach', ...start, 180, -16],
  ['attic-roof-ridge', -62.5, 80.5, 28.75, 180, 15],
  ['attic-entry', -64.5, 75, 23, 0, 5],
  ['attic-interior-east', ...room, -90, 0],
  ['attic-interior-west', ...room, 90, 0],
];

function travel(walk, current) {
  // One jump between the adjacent eaves, then follow the half-block roof steps.
  walk([-63.5, 74.5, 53.75]);
  walk([-63.5, 75.5, 53.25], {jump:true});
  for (const z of [48.5, 43.75, 39, 36.75]) walk([-63.5, 75.5, z]);
  for (const feet of [[-63.25, 75.5, 36.5], [-63, 75, 36.25], [-62.75, 75, 36],
    [-62.5, 74.5, 35.75], [-62.5, 73.5, 35.5], [-62.5, 74, 35.25], [-62.5, 74, 35]]) walk(feet);
  for (let y = 74.5, z = 34.75; y <= 80.5; y += .5, z -= .5) {
    walk([-62.5, y, z]);
    walk([-62.5, y, y === 80.5 ? 27.25 : z - .25]);
  }
  for (let y = 80, z = 27; y >= 77.5; y -= .5, z -= .5) {
    walk([-62.5, y, z]);
    walk([-62.5, y, y === 77.5 ? 23.75 : z - .25]);
  }
  for (const feet of [[-62.5, 77, 23.5], [-62.5, 77, 23.25], [-62.75, 76.5, 23], [-63, 76.5, 22.75],
    [-63.25, 76, 22.5], [-63.5, 75, 22.75], [-64.5, 75, 23.75], [-64.5, 75, 24.75],
    [-64.5, 74.5, 25], [-64.5, 74.5, 25.25], [-64.5, 74, 25.5], [-64.5, 74, 27.5], room]) walk(feet);
  const {feet:reached, sample:atticSample} = current();

  // Return via the northern doorway, taking the taller roof steps as jumps.
  for (const feet of [[-64, 74, 25.5], [-64, 74.5, 25.25], [-64, 74.5, 25], [-64, 75, 24.75],
    [-64.25, 75, 24.5], [-64.5, 75, 24.25], [-64.5, 75, 23.25], [-64.5, 75, 22.75]]) walk(feet);
  walk([-64.5, 76, 22.5], {jump:true});
  walk([-64.75, 77, 22.75], {jump:true});
  for (const feet of [[-64.75, 77, 23], [-64.75, 77.5, 23.25], [-64.75, 77.5, 23.5], [-64.75, 78, 23.75],
    [-64.75, 78, 25]]) walk(feet);
  for (let y = 78.5, z = 25.25; y <= 80.5; y += .5, z += .5) {
    walk([-64.75, y, z]);
    walk([-64.75, y, y === 80.5 ? 28.75 : z + .25]);
  }
  for (const feet of [[-64.75, 80, 29], [-64.75, 80, 29.25], [-64.75, 79.5, 29.5], [-64.75, 79.5, 29.75],
    [-64.75, 79, 30], [-64.75, 79, 30.25], [-64.75, 78.5, 30.5], [-64.75, 78.5, 30.75],
    [-64.75, 78, 31], [-64.75, 78, 31.25], [-64.75, 77.5, 31.5], [-64.75, 77.5, 31.75],
    [-64.75, 77, 32], [-64.75, 77, 32.25], [-64.75, 76.5, 32.5], [-64.75, 76.5, 32.75],
    [-64.75, 76, 33], [-64.75, 76, 33.25], [-64.75, 75.5, 33.5], [-64.5, 75.5, 33.75],
    [-64.25, 75, 34], [-64, 75, 34.25], [-63.75, 74.5, 34.5], [-63.5, 74.5, 34.75],
    [-63.25, 74, 35], [-63, 74, 35.25], [-62.75, 73.5, 35.5]]) walk(feet);
  walk([-62.5, 74.5, 35.75], {jump:true});
  for (const z of [39, 43, 47, 51, 52.25]) walk([-62.5, 74.5, z]);
  for (const feet of [[-62.75, 75, 52.5], [-63, 75, 52.75], [-63.25, 75.5, 53], [-63.5, 75.5, 53.25], start]) walk(feet);
  return {reached, returned:current().feet, atticSample};
}

const [routePath, output, worldPath, modelPath] = process.argv.slice(2);
runAccess(routePath, output, worldPath, modelPath, {name:'attic', start, poses, travel});
