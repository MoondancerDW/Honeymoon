import assert from 'node:assert/strict';
import test from 'node:test';
import {decodeVista, VISTA_LOFT, VISTA_STEP, VISTA_VERSION, vistaBytes, vistaCell} from './vista-format.mjs';
import {VISTA_STITCH_FACE} from './vista-stitch.mjs';

function vistaFixture() {
  const data = new DataView(new ArrayBuffer(vistaBytes));
  data.setUint32(0,0x48565354);
  data.setUint8(4,VISTA_VERSION);
  data.setUint8(5,VISTA_STEP);
  function height(x,z,value) {
    const offset = vistaCell(x,z);
    data.setUint16(offset,value*8,true);
    data.setUint16(offset+2,2,true);
    data.setUint16(offset+4,240,true);
  }
  return {data,height};
}

test('flat cells on the vista merge while cliffs close against the neighboring tile', () => {
  const {data,height} = vistaFixture();
  height(-1,0,60);
  height(0,0,65);
  height(1,0,65);
  const [mesh] = decodeVista(data.buffer).layers;
  assert.equal(mesh.count,2);
  assert.deepEqual([...mesh.offset],[0,65*8,0,0,60*8,0]);
  assert.deepEqual([...mesh.span],[8*8,16*8,8*8,5*8]);
  assert.deepEqual([...mesh.surface],[2,3,2,0]);
});

test('the far tier keeps edge samples and merges equal adjacent cliff faces', () => {
  const {data,height} = vistaFixture();
  height(0,0,50);
  height(1,0,54);
  height(2,2,60);
  height(3,2,64);
  height(2,3,68);
  height(3,3,72);
  height(1,2,40);
  height(1,3,40);
  const [fine] = decodeVista(data.buffer).layers;
  const [coarse] = decodeVista(data.buffer,true).layers;
  assert.ok(coarse.count < fine.count);
  const faces = Array.from({length:coarse.count},(_,index) => ({
    origin:[...coarse.offset.subarray(index*3,index*3+3)],
    span:[...coarse.span.subarray(index*2,index*2+2)],
    face:coarse.surface[index*2+1],
  }));
  const top = (x,y,z) => faces.find(({face,origin}) => face === 3 &&
    origin[0] === x*8 && origin[1] === y*8 && origin[2] === z*8);
  assert.ok(top(0,50,0));
  assert.ok(top(8,54,0));
  assert.deepEqual(top(16,68,16).span,[128,128]);
  const cliff = faces.find(({face,origin}) => face === 0 && origin[0] === 16*8 && origin[2] === 16*8);
  assert.deepEqual(cliff.span,[128,224]);
  assert.equal(data.getUint16(vistaCell(2,2),true),60*8);
});

test('elevated structures retain their underside and a real gap even in the coarser tier',()=>{
  const {data,height}=vistaFixture();
  for (let z=2;z<4;z++) for (let x=2;x<4;x++) height(x,z,66);
  for (const [x,mask] of [[2,0b1100],[3,0b0011]]) {
    const at=vistaCell(x,2)+VISTA_LOFT;
    data.setUint16(at,131*8,true);
    data.setUint16(at+2,35,true);
    data.setUint16(at+4,240,true);
    data.setUint16(at+9,129*8,true);
    data.setUint16(at+11,mask,true);
  }
  for (const coarse of [false,true]) {
    const [mesh]=decodeVista(data.buffer,coarse).layers;
    const faces = Array.from({length:mesh.count},(_,index)=>({face:mesh.surface[index*2+1],
      x:mesh.offset[index*3]/8,y:mesh.offset[index*3+1]/8,tile:mesh.surface[index*2]}));
    assert.ok(faces.some(face=>face.y===66 && face.face===3));
    const elevated=faces.filter(face=>face.tile===35);
    assert.ok(elevated.some(face=>face.y===129 && face.face===2));
    assert.ok(elevated.some(face=>face.y===131 && face.face===3));
    assert.ok(elevated.every(face=>face.y>=129));
    assert.ok(elevated.every(face=>face.x!==24 || face.face!==0 && face.face!==1));
  }
});

test('stitchable ground preserves a vertex every eight blocks and leaves lofts untouched', () => {
  const {data,height} = vistaFixture();
  height(0,0,67);
  height(1,0,67);
  const loft=vistaCell(0,0)+VISTA_LOFT;
  data.setUint16(loft,73*8,true);
  data.setUint16(loft+9,70*8,true);
  data.setUint16(loft+11,65535,true);
  const [mesh]=decodeVista(data.buffer,false,true).layers;
  const flags=[...mesh.surface].filter((_,index)=>index%2===1);
  assert.deepEqual(flags.filter(flag=>flag>=VISTA_STITCH_FACE),[VISTA_STITCH_FACE+3,VISTA_STITCH_FACE+3]);
  assert.ok(flags.includes(2));
  assert.ok(flags.slice(0,-2).every(flag=>flag<VISTA_STITCH_FACE));
  assert.deepEqual([...mesh.span.slice(-4)],[64,64,64,64]);
  assert.deepEqual([...mesh.offset.slice(-6)],[0,67*8,0,8*8,67*8,0]);
});
