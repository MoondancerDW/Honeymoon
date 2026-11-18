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
