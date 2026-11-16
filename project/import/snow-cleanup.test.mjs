import assert from 'node:assert/strict';
import test from 'node:test';
import {findStraySnow} from './snow-cleanup.mjs';

test('cleans isolated roof and tree snow while retaining a snowy area and exposed layers', () => {
  const stray = [{x:0,y:60,z:0,layers:1},{x:12,y:60,z:0,layers:1}];
  const exposed = {x:20,y:60,z:0,layers:1};
  const cluster = Array.from({length:12},(_,i) => ({x:40+(i%4),y:60,z:Math.floor(i/4),layers:1}));
  const snow = [...stray,exposed,...cluster];
  const cellAt = (x,y) => y===59 && (x===0 || x>=40) ? 'legacy:35:0' :
    x===12 && y===64 ? 'legacy:18:0' : 'air';
  assert.deepEqual(findStraySnow(snow,cellAt),stray);
});
