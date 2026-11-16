import assert from 'node:assert/strict';
import test from 'node:test';
import {decodeVista, VISTA_STEP, VISTA_VERSION, vistaBytes, vistaCell} from './vista-format.mjs';

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
