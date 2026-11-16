import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Climate,readBiomes,taigaSnow} from './climate.mjs';

test('precipitation samples full biome columns at negative coordinates and uses the height of taiga',()=>{
  const climate=new Climate();
  climate.chunks=readBiomes({version:1,chunks:[[-1,-1,'r:'+btoa(String.fromCharCode(4,254,5,0))],[0,-1,19]]});
  assert.equal(climate.biomeAt(-1,-1),5);
  assert.equal(climate.biomeAt(-2,-1),4);
  assert.equal(climate.biomeAt(.2,-.2),19);
  assert.equal(climate.biomeAt(16,0),undefined);
  assert.equal(climate.snowAt(-1,130,-1),false);
  assert.equal(climate.snowAt(-1,175,-1),true);
  assert.equal(climate.snowAt(-2,300,-1),false);
  assert.equal(taigaSnow(5,0,159,0),false);
  assert.equal(taigaSnow(5,0,160,0),true);
});
