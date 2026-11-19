import assert from 'node:assert/strict';
import {test} from 'node:test';
import {blockFaceVertices,boxFaceFragments} from './block-faces.mjs';
import {shapeFor} from './geometry.mjs';

const area=(a,b,c,d)=>({x0:a,y0:b,z0:0,x1:c,y1:d,z1:.25,faces:Array(6).fill(130),mode:'opaque'});

test('different materials on an ordinary block keep one face and preserve its source UVs',()=>{
  const [first,second]=shapeFor('legacy:69:2');
  assert.equal(first.x1,second.x1);
  const boxes=[first,second];
  const lowerTile=first.faces[1]<second.faces[1]?0:1;
  const upper=boxes[1-lowerTile];
  const result=boxFaceFragments(upper,1-lowerTile,boxes,1);
  assert.deepEqual(boxFaceFragments(boxes[lowerTile],lowerTile,boxes,1),[boxes[lowerTile]]);
  assert.notDeepEqual(result,[upper]);
  const original={...area(0,0,1,1),uv:'box'};
  const fragment={...original,x0:.25,x1:.75};
  const {uv}=blockFaceVertices(original,4,-1,fragment);
  assert.deepEqual(uv.map(([u])=>u),[.75,.75,.25,.25]);
});

test('opaque parts hide only the contact area across a block boundary',()=>{
  const rail=area(0,0,1,1), beside=area(.25,.5,.75,1);
  beside.z1=1;
  const faces=boxFaceFragments(rail,0,[rail],4,[beside]);
  assert.equal(faces.reduce((a,box)=>a+(box.x1-box.x0)*(box.y1-box.y0),0),.75);
  assert.ok(faces.every(box=>box.x1<=.25 || box.x0>=.75 || box.y1<=.5));
});

test('opaque faces win over coplanar cutouts regardless of texture number',()=>{
  const rail=area(0,0,1,.25), trim={...area(.25,0,.5,1),mode:'cutout',faces:Array(6).fill(4)};
  const boxes=[trim,rail];
  assert.deepEqual(boxFaceFragments(rail,1,boxes,4),[rail]);
  assert.deepEqual(boxFaceFragments(trim,0,boxes,4),[{...trim,y0:.25}]);
});
