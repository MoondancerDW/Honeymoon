import assert from 'node:assert/strict';
import {test} from 'node:test';
import {creativeBlock} from './creative-blocks.mjs';
import {shapeFor} from './geometry.mjs';

test('piston bodies use the face tiles captured from the original modded client',()=>{
  for (const id of [29,33]) for (const extent of [0,8]) for (let facing=0;facing<6;facing++) {
    const meta = facing|extent;
    assert.deepEqual(shapeFor(`legacy:${id}:${meta}`)[0].faces,creativeBlock(id,meta)[0]);
  }
});
