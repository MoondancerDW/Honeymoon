import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {writeTerrainRings} from './terrain.mjs';

test('fallback rings preserve complete cover faces and discard hollow frames', () => {
  const work = fileURLToPath(new URL('../work/',import.meta.url));
  mkdirSync(work,{recursive:true});
  const directory = mkdtempSync(join(realpathSync(work),'terrain-test-'));
  try {
    const section = {Y:0, Blocks:Buffer.alloc(4096), Add:Buffer.alloc(2048), Data:Buffer.alloc(2048)};
    for (const index of [0,8]) {
      section.Blocks[index] = 750 & 255;
      section.Add[index >> 1] = 750 >> 8;
    }
    const tile = {id:'Covers', y:0, z:0, cvm:1 << 1};
    const level = {Sections:[section], TileEntities:[
      {...tile, x:96, cvs:Buffer.from([28,0])},
      {...tile, x:104, cvs:Buffer.from([28,3])},
    ]};
    writeTerrainRings(directory,8,(x,z) => x === 6 && z === 0 ? level : null,6);
    const ring = JSON.parse(readFileSync(join(directory,'terrain-8.json'),'utf8'));
    assert.deepEqual(ring.palette,['air','full-cover-material:28']);
    const indices = Buffer.from(ring.chunks[0].levels[0].indices,'base64');
    assert.equal(indices.readUInt16LE(0),1);
    assert.equal(indices.readUInt16LE(4),0);
  } finally {
    if (dirname(directory) === realpathSync(work) && basename(directory).startsWith('terrain-test-')) {
      rmSync(directory,{recursive:true,force:true});
    }
  }
});
