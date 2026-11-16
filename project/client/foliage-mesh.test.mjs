import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ATLAS_GRID,TILE_SIZE,shapeFor} from '../world/geometry.mjs';
import {canopySlot,foliageAtlasColumns,foliageAtlasPixels,shortGrassSlot,shortGrassTile} from './canopy-card.mjs';
import {appendFoliage} from './foliage-mesh.mjs';

test('rounded crowns retain the 2×2 pattern and cutout alpha of the source pack', () => {
  const tiles = [...canopySlot.keys(),shortGrassTile];
  const rows = Math.floor(Math.max(...tiles)/ATLAS_GRID)+1;
  const width = ATLAS_GRID*TILE_SIZE;
  const source = new Uint8Array(width*rows*TILE_SIZE*4);
  const sourcePixel = (tile,x,y) => [x*11,y*11,tile%255,(x+y)%7===0 ? 0 : 255];
  for (const tile of tiles) {
    for (let x=0;x<16;x++) for (let y=0;y<16;y++) {
      const px = tile%ATLAS_GRID*TILE_SIZE+x;
      const py = Math.floor(tile/ATLAS_GRID)*TILE_SIZE+y;
      source.set(sourcePixel(tile,x,y),(px+py*width)*4);
    }
  }
  const atlas = foliageAtlasPixels(source,width,rows);
  const sample = (slot,x,y) => {
    const px=(slot-1)%foliageAtlasColumns*64+16+x;
    const py=Math.floor((slot-1)/foliageAtlasColumns)*64+16+y;
    const i=(px+(atlas.height-1-py)*atlas.width)*4;
    return [...atlas.pixels.subarray(i,i+4)];
  };
  for (const [tile,slot] of canopySlot) {
    let opaque=0;
    for (let x=0;x<32;x++) for (let y=0;y<32;y++) {
      const pixel=sample(slot,x,y);
      const expected=sourcePixel(tile,x%16,y%16);
      assert.deepEqual(pixel.slice(0,3),expected.slice(0,3));
      assert.ok(!pixel[3]||pixel[3]===expected[3]);
      if (pixel[3]) opaque++;
    }
    assert.ok(opaque>400&&opaque<710);
    for (const [x,y] of [[0,0],[31,0],[0,31],[31,31],[-1,16],[32,16]]) assert.equal(sample(slot,x,y)[3],0);
  }
  for (let y=0;y<32;y++) {
    const expected=sourcePixel(shortGrassTile,3,y<12 ? 0 : (y-12)>>1);
    if (y<12) expected[3]=0;
    assert.deepEqual(sample(shortGrassSlot,6,y),expected);
  }
});

test('exposed crowns form centered crossed planes and omit fully enclosed leaves', () => {
  const padding=18, step=padding**2;
  const cell=(x,y,z) => x+1+(y+1)*step+(z+1)*padding;
  const indices=new Uint16Array(padding**3);
  const light=new Uint8Array(indices.length).fill(240);
  const palette=['air','legacy:18:0','legacy:1:0','legacy:2:0'];
  const center=cell(8,8,8);
  const tints=new Uint32Array(16*16*2).fill(0x66994a);
  function collect() {
    const quads=[];
    assert.equal(appendFoliage({indices,palette,light,origin:[0,0,0],biomeTints:tints,
      emit:(...fields)=>quads.push(fields)}),quads.length);
    return quads;
  }
  indices[center]=1;
  const quads=collect();
  assert.equal(quads.length,2);
  const vectors=[];
  for (const [corners,tile,packed,tint,,wind,slot,uv] of quads) {
    const [a,b,c,d]=corners;
    const across=[b[0]-a[0],b[2]-a[2]];
    vectors.push(across);
    assert.ok(Math.abs(Math.abs(across[0]/across[1])-1)<.25);
    assert.ok(Math.abs((a[0]+b[0])/2-8.5)<.19);
    assert.ok(Math.abs((a[2]+b[2])/2-8.5)<.19);
    assert.ok(a[1]<8&&c[1]>9&&d[1]===c[1]);
    assert.equal(slot,canopySlot.get(shapeFor(palette[1])[0].faces[0]));
    assert.equal(tile,shapeFor(palette[1])[0].faces[0]);
    assert.equal(tint,0x66994a);
    assert.deepEqual(packed,[240,240,240,240]);
    assert.ok(wind<0);
    assert.equal(uv.length,4);
  }
  const [a,b]=vectors;
  assert.ok(Math.abs(a[0]*b[0]+a[1]*b[1])<1e-8);
  for (const offset of [1,-1,padding,-padding,step,-step]) indices[center+offset]=2;
  assert.deepEqual(collect(),[]);

  indices.fill(0);
  for (let x=0;x<16;x++) indices[cell(x,7,8)]=3;
  const grass=collect();
  assert.ok(grass.length>=12&&grass.length<=32);
  for (const [corners,tile,,tint,,wind,slot] of grass) {
    assert.equal(corners[0][1],8);
    assert.equal(tile,shortGrassTile);
    assert.equal(slot,shortGrassSlot);
    assert.equal(tint,0x66994a);
    assert.ok(wind>0);
  }
  for (let x=0;x<16;x++) indices[cell(x,8,8)]=2;
  assert.deepEqual(collect(),[]);
});
