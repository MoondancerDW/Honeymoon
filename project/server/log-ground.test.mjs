import assert from 'node:assert/strict';
import test from 'node:test';
import {grassBlock,plainDirt} from '../world/tree-logs.mjs';
import {applyLogGround} from './log-ground.mjs';

const position = (x,y,z) => x + 16*z + 256*y;

function section(y,cells) {
  const indices = Buffer.alloc(8192);
  for (const [x,dy,z,value] of cells) indices.writeUInt16LE(value,2*position(x,dy,z));
  return {y,indices:indices.toString('base64')};
}

function cell(chunk,x,y,z) {
  const {indices} = chunk.sections.find(section=>section.y===y>>4);
  return chunk.palette[Buffer.from(indices,'base64').readUInt16LE(2*position(x,y&15,z))];
}

test('plain dirt under vanilla and modded logs becomes grass, including across vertical sections',()=>{
  const oak = 'legacy:17:0', moddedLog = 'legacy:2163:4', stone = 'legacy:162:0', dirtVariant = 'legacy:3:1';
  const chunk = {palette:['air',plainDirt,oak,moddedLog,stone,dirtVariant],sections:[
    section(0,[[1,15,2,1],[2,15,2,1],[1,4,2,1],[1,5,2,2],[3,4,2,5],[3,5,2,2],[4,4,2,1],[4,5,2,4]]),
    section(1,[[1,0,2,3],[2,1,2,3]]),
  ]};
  assert.equal(applyLogGround(chunk),2);
  assert.equal(cell(chunk,1,15,2),grassBlock);
  assert.equal(cell(chunk,1,4,2),grassBlock);
  assert.equal(cell(chunk,1,16,2),moddedLog);
  assert.equal(cell(chunk,2,15,2),plainDirt);
  assert.equal(cell(chunk,3,4,2),dirtVariant);
  assert.equal(cell(chunk,4,4,2),plainDirt);
  assert.equal(applyLogGround(chunk),0);
});

test('the fallback palette stays intact when an old-format chunk needs a grass entry',()=>{
  const palette = ['air',plainDirt,'legacy:17:0'];
  const chunk = {sections:[section(0,[[15,0,15,1],[15,1,15,2]])]};
  assert.equal(applyLogGround(chunk,palette),1);
  assert.equal(cell(chunk,15,0,15),grassBlock);
  assert.equal(palette.length,3);
});
