import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BIOME_PALETTE_SIZE,Climate,biomeTint,readBiomes,readWorldBiomes,biomeSnow,grassTintPalette,terrainBiomePixels} from './climate.mjs';
import {encodeBiomePalette} from '../import/biomes.mjs';

test('precipitation samples exact biome columns and changes to snow with altitude everywhere',()=>{
  const climate=new Climate();
  climate.chunks=readBiomes({version:1,chunks:[[-1,-1,'r:'+btoa(String.fromCharCode(4,254,5,0))],[0,-1,19]]});
  assert.equal(climate.biomeAt(-1,-1),5);
  assert.equal(climate.biomeAt(-2,-1),4);
  assert.equal(climate.biomeAt(.2,-.2),19);
  assert.equal(climate.biomeAt(16,0),undefined);
  assert.equal(climate.snowAt(-1,159.99,-1),false);
  assert.equal(climate.snowAt(-1,160,-1),true);
  assert.equal(climate.snowAt(-2,150,-1),false);
  assert.equal(climate.snowAt(-2,190,-1),true);
  assert.equal(biomeSnow(5,65),false);
  assert.equal(biomeSnow(13,65),true);
  assert.equal(biomeSnow(3,65),true);
  assert.equal(biomeSnow(20,65),true);
  assert.equal(biomeSnow(undefined,386),true);
});

test('compact world climates preserve original IDs and missing columns',()=>{
  for (const colors of [2,4,8,17]) {
    const columns=Buffer.from(Array.from({length:256},(_,i)=>i%colors || 255));
    const header=Buffer.alloc(20);
    header.write('HBIO');
    header.writeUInt16LE(2,4);
    header.writeInt16LE(-2,6);
    header.writeInt16LE(-3,8);
    header.writeUInt16LE(1,10);
    header.writeUInt16LE(1,12);
    header.writeUInt32LE(0x80000014,16);
    const map=Buffer.concat([header,encodeBiomePalette(columns)]);
    const sample=readWorldBiomes(map.buffer.slice(map.byteOffset,map.byteOffset+map.length));
    assert.equal(sample(-33,-48),undefined);
    for (let z=0;z<16;z++) for (let x=0;x<16;x++) {
      const id=columns[z*16+x];
      assert.equal(sample(x-32,z-48),id===255 ? undefined : id);
    }
  }
});

test('packed terrain and the detailed mesh share grass tints at biome boundaries',()=>{
  const climate=new Climate();
  climate.full=(x,z)=>x < -1534 && z===38 ? 134 : x===-1534 && z===38 ? 1 : undefined;
  const terrain=terrainBiomePixels(climate,-1536,0,64,1);
  const detailed=climate.columnTints(-96,2);
  const palette=grassTintPalette();
  assert.equal(palette.length,BIOME_PALETTE_SIZE*4);
  assert.equal(terrain.byteLength,4096);
  assert.deepEqual(terrain.slice(38*64,38*64+4),new Uint8Array([6,6,1,4]));
  for (let x=0;x<4;x++) {
    const rgb=terrain[38*64+x]*4;
    assert.equal(palette[rgb]<<16 | palette[rgb+1]<<8 | palette[rgb+2],detailed[(6*16+x)*2]);
  }
});

test('Vista samples each eight-block terrain cell at its center, including negative positions',()=>{
  const climate=new Climate();
  climate.full=(x,z)=>x===-516 && z===-4 ? 21 : x===-508 && z===-4 ? 3 : undefined;
  assert.deepEqual(terrainBiomePixels(climate,-520,-8,2,8),new Uint8Array([21,3,4,4]));
  assert.deepEqual(grassTintPalette().slice(21*4,22*4),
    new Uint8Array([biomeTint(21).grass>>16,biomeTint(21).grass>>8&255,biomeTint(21).grass&255,255]));
});
