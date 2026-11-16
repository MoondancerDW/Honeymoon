import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join} from 'node:path';
import {test} from 'node:test';
import {deflateSync} from 'node:zlib';
import {VISTA_LOFT,vistaCell} from '../client/vista-format.mjs';
import {buildVista} from './vista.mjs';

const end = Buffer.from([0]);
function named(type,name,value) {
  const header = Buffer.alloc(3);
  header[0] = type;
  header.writeUInt16BE(Buffer.byteLength(name),1);
  return Buffer.concat([header,Buffer.from(name),value]);
}

function integer(n) {
  const value = Buffer.alloc(4);
  value.writeInt32BE(n);
  return value;
}

function section(y,blocks,metadata,add) {
  const array = (name,data) => named(7,name,Buffer.concat([integer(data.length),data]));
  return Buffer.concat([named(1,'Y',Buffer.from([y])),array('Blocks',blocks),array('Data',metadata),
    ...(add ? [array('Add',add)] : []),end]);
}

function originalChunk(x,fill,loft) {
  const ground = Buffer.alloc(4096);
  const groundAdd = Buffer.alloc(2048);
  ground.fill(80,15*256); // Mod ID 336 (low byte 80) beneath the grass.
  groundAdd.fill(0x11,15*128);
  const surface = Buffer.alloc(4096);
  const metadata = Buffer.alloc(2048);
  surface.fill(2,0,256);
  fill((x,z,id) => {
    const at = 256+16*z+x;
    surface[at] = id;
    if (id === 78) metadata[at>>1] |= 1 << ((at&1)*4);
  });
  const sections = Buffer.concat([Buffer.from([10]),integer(loft ? 3 : 2),
    section(3,ground,Buffer.alloc(2048),groundAdd),section(4,surface,metadata),
    ...(loft ? [section(8,loft,Buffer.alloc(2048))] : [])]);
  return named(10,'',Buffer.concat([named(10,'Level',Buffer.concat([
    named(3,'xPos',integer(x)),named(3,'zPos',integer(0)),named(9,'Sections',sections),end])),end]));
}

function saveRegion(path,chunks) {
  const header = Buffer.alloc(8192);
  const payloads = [];
  let sector = 2;
  for (const [slot,nbt] of chunks) {
    const compressed = deflateSync(nbt);
    const sectors = Math.ceil((compressed.length+5)/4096);
    const data = Buffer.alloc(sectors*4096);
    header.writeUInt32BE(sector*256+sectors,slot*4);
    data.writeUInt32BE(compressed.length+1);
    data[4] = 2;
    compressed.copy(data,5);
    payloads.push(data);
    sector += sectors;
  }
  writeFileSync(path,Buffer.concat([header,...payloads]));
}

test('vista removes sparse ID 78, preserves snow supported by another region, and checks the Add nibble', () => {
  const temporary = mkdtempSync(join(tmpdir(),'honeymoon-vista-snow-'));
  try {
    const region = join(temporary,'region');
    const output = join(temporary,'vista');
    mkdirSync(region);
    const thin = offset => set => {
      for (let i=0;i<7;i++) set(offset+1+2*(i%4),1+2*Math.floor(i/4),78);
    };
    saveRegion(join(region,'r.0.0.mca'),[[0,originalChunk(0,thin(0))],[31,originalChunk(31,thin(8))]]);
    saveRegion(join(region,'r.1.0.mca'),[[0,originalChunk(32,set=>{
      for (let z=0;z<8;z++) for (let x=0;x<8;x++) set(x,z,80);
    })]]);
    const manifest = buildVista(temporary,output,[0,0,32,0]);
    assert.equal(manifest.chunks,3);
    assert.deepEqual(manifest.corrupt,[]);
    const tile = readFileSync(join(output,'0.0.bin'));
    const top = column => tile.readUInt16LE(vistaCell(column,0));
    assert.equal(top(0),65*8);
    assert.equal(top(63),65*8+2);
  } finally {
    const path = realpathSync(temporary);
    if (dirname(path) === realpathSync(tmpdir()) && basename(path).startsWith('honeymoon-vista-snow-')) {
      rmSync(path,{recursive:true,force:true});
    }
  }
});

test('vista import separates a two-block construction from the terrain and preserves its footprint',()=>{
  const temporary=mkdtempSync(join(tmpdir(),'honeymoon-vista-loft-'));
  try {
    const region=join(temporary,'region'), output=join(temporary,'vista');
    mkdirSync(region);
    const loft=Buffer.alloc(4096);
    loft.set([35],1+16);
    loft.set([35],1+16+256);
    saveRegion(join(region,'r.0.0.mca'),[[0,originalChunk(0,()=>{},loft)]]);
    assert.deepEqual(buildVista(temporary,output,[0,0,0,0]).corrupt,[]);
    const tile=readFileSync(join(output,'0.0.bin'));
    const ground=vistaCell(0,0), upper=ground+VISTA_LOFT;
    assert.equal(tile.readUInt16LE(ground),65*8);
    assert.equal(tile.readUInt16LE(upper),130*8);
    assert.equal(tile.readUInt16LE(upper+9),128*8);
    assert.equal(tile.readUInt16LE(upper+11),1);
  } finally {
    const path=realpathSync(temporary);
    if (dirname(path)===realpathSync(tmpdir()) && basename(path).startsWith('honeymoon-vista-loft-')) {
      rmSync(path,{recursive:true,force:true});
    }
  }
});
