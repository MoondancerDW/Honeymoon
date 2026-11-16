import assert from 'node:assert/strict';
import {test} from 'node:test';
import {encodeVoxels,voxelIndex,voxelKey} from '../world/voxel-chisel.mjs';
import {RainCover} from './rain-cover.mjs';

test('a sculpted microblock and a hollow glass cover stop only the precipitation under their footprints',()=>{
  const samples=new Uint8Array(512);
  samples[voxelIndex(1,2,2)]=1;
  const carving={key:voxelKey,voxels:encodeVoxels(samples,['legacy:1:0'])};
  const hollow={key:'legacy:750:0',parts:[{slot:0,shape:3,material:7}]};
  const cells=new Map([['0,6,0',carving],['1,6,0',hollow],['0,0,0','legacy:1:0'],['1,0,0','legacy:1:0'],['2,6,0','legacy:9:0']]);
  const chunk={skyTop:15};
  const roof=new RainCover({chunks:new Map([['0,0',chunk]]),cellAt:(x,y,z)=>cells.get(`${x},${y},${z}`)});
  roof.beginFrame();
  assert.equal(roof.heightAt(.18,.31),6.375);
  assert.equal(roof.heightAt(.52,.31),1);
  assert.equal(roof.heightAt(1.1,.5),6.125);
  assert.equal(roof.heightAt(1.5,.5),1);
  assert.equal(roof.heightAt(2.5,.5),6+8/9);
  assert.equal(roof.fraction(.18,3,.31,0,.5,0),0);
  assert.equal(roof.fraction(.52,3,.31,0,.5,0),1);
  assert.equal(roof.fraction(.30,3,.31,-.10,.5,0).toFixed(2),'0.50');
  assert.equal(roof.fraction(.26,3,.31,0,.5,0,.02),0);
  assert.equal(roof.fraction(.18,6.4,.31,0,.5,0),1);
  cells.delete('0,6,0');
  roof.invalidate(0,0);
  assert.equal(roof.heightAt(.18,.31),1);
});
