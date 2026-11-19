import assert from 'node:assert/strict';
import test from 'node:test';
import {lodBoundaryHeights,writeVistaStitch} from './vista-stitch.mjs';

test('the Vista stitch uses a negative-coordinate LOD edge and skips covered neighbors', () => {
  const land=lodBoundaryHeights({
    count: 4,
    offset: [0,68,0, 0,85,0, 1,81,1, 0,70,8],
    span: [16,16, 16,16, 2,2, 8,0],
    surface: [0,3, 304,259, 1,3, 2,4],
  });
  // The plateau is opaque; higher foliage and geometry inside a chunk
  // must not raise the Vista edge or mask an actual cliff.
  assert.deepEqual([...land.slice(0,24)],[68,0,68,0,68,0,68,0,68,0,68,0,68,0,68,0,68,0,68,0,68,0,68,0]);
  const size=4,width=size*2+1;
  const coverage=new Uint8Array(size**2);
  const sources=new Array(size**2);
  const field=new Float32Array(width**2*2);
  coverage[1+size]=255;
  coverage[2+size]=255;
  sources[1+size]={rx:-2,rz:-1,boundary:land};
  const node = (x,z) => [...field.slice((x+z*width)*2,(x+z*width)*2+2)];
  writeVistaStitch(field,coverage,sources,size,-9,-5);
  assert.deepEqual([node(2,2),node(2,3),node(2,4)],[[68,0],[68,0],[68,0]]);
  assert.deepEqual(node(4,3),[0,0]);
  assert.deepEqual(node(3,3),[0,0]);
  coverage[1+size]=0;
  sources[1+size]=undefined;
  writeVistaStitch(field,coverage,sources,size,-9,-5);
  assert.ok(field.every(value=>value===0));
});

test('a clipped eighth-block LOD face still anchors Vista in ordinary world coordinates', () => {
  const land=lodBoundaryHeights({
    count:2,
    offset:[128,544,2, 129,688,2],
    span:[126,128, 126,126],
    surface:[100,11, 101,11],
    coordinateScale:8,
    heightScale:8,
  });
  assert.deepEqual([...land.slice(24,30)],[0,0,68,100,68,100]);
  assert.deepEqual([...land.slice(30,36)],[0,0,68,100,68,100]);
  assert.deepEqual([...land.slice(42,48)],[68,100,86,101,68,100]);
});
