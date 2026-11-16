import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sampleSnowLane,snowColumnBand,snowCoverage} from './snow-coverage.mjs';

test('snow surveying uses stable, non-overlapping density tiers at block boundaries',()=>{
  for (let z=-20;z<=20;z+=4) for (let x=-20;x<=20;x+=4) {
    const count=[0,0,0];
    for (let dz=0;dz<4;dz++) for (let dx=0;dx<4;dx++) count[snowColumnBand(x+dx,z+dz)]++;
    assert.deepEqual(count,[12,3,1]);
  }
  for (const mobile of [false,true]) {
    const {bands}=snowCoverage(mobile);
    for (const [index,band] of bands.entries()) {
      for (let cursor=0;cursor<band.offsets.length;cursor++) {
        const [x,z]=sampleSnowLane(band,cursor,-7.3,13.8);
        assert.equal(Number.isInteger(x)&&Number.isInteger(z),true);
        assert.ok(snowColumnBand(x,z)>=index);
      }
    }
  }
});

test('bounded probes keep reaching the outer coating during a sustained flight',()=>{
  for (const mobile of [false,true]) {
    const profile=snowCoverage(mobile);
    const {bands}=profile;
    assert.ok(1+bands.reduce((sum,band)=>sum+band.probes,0)<=32);
    const far=bands.at(-1);
    assert.ok(far.range[1]>=38&&profile.vertical[1]>=88);
    let cursor=0,seen=0;
    for (let update=0;update<140;update++) {
      const eyeX=update*4.1,eyeZ=-update*3.3;
      for (let probe=0;probe<far.probes;probe++) {
        const [x,z]=sampleSnowLane(far,cursor++,eyeX,eyeZ);
        const distance=Math.hypot(x+.5-eyeX,z+.5-eyeZ);
        if (distance>far.range[0]&&distance<far.range[1]) seen++;
      }
    }
    assert.ok(seen>100);
    for (const eye of [[19.1,-3.1],[-.6,40.7],[.5,.5]]) {
      const counts=[0,0,0];
      for(let z=Math.floor(eye[1])-54;z<=Math.ceil(eye[1])+54;z++) {
        for(let x=Math.floor(eye[0])-54;x<=Math.ceil(eye[0])+54;x++) {
          const band=snowColumnBand(x,z);
          if(Math.hypot(x+.5-eye[0],z+.5-eye[1])<=bands[band].radius) counts[band]++;
        }
      }
      assert.ok(counts.every((count,index)=>count<=bands[index].capacity));
    }
  }
});
