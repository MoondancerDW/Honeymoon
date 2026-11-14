import {writeFileSync} from 'node:fs';

const filename = process.argv[2];
if (!filename) throw new Error('Usage: node qa/climb-probes.mjs OUTPUT_TSV');

// Top rung coordinates in the original west cellar and attic shafts.
const shafts = [[-60, 63, 56], [-72, 72, 28]];
const offsets = [.38, .5, .64];
const starts = [-2.99, .5, .98];
const rows = [];
for (const [x, y, z] of shafts) {
  for (const dx of offsets) {
    for (const dz of offsets) {
      for (let yaw = 0; yaw < 360; yaw += 45) {
        for (const dy of starts) {
          rows.push(['c', x + dx, y + dy, z + dz, yaw, dy > 0 ? .1176 : 0].join(' '));
        }
      }
    }
  }
}
writeFileSync(filename, `${rows.join('\n')}\n`);
