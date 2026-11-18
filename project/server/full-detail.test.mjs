import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {loadBase} from './base.mjs';
import {soloRegionFile} from './solo-assets.mjs';
import {DETAIL_HEADER_SIZE,DETAIL_INDEX_OFFSET,detailCoverage,detailSlot} from '../world/full-detail.mjs';

function writePack(folder, source) {
  const payload=gzipSync(JSON.stringify(source));
  const header=Buffer.alloc(DETAIL_HEADER_SIZE);
  header.write('HDTL');
  header.writeUInt16LE(1,4);
  const offset=DETAIL_INDEX_OFFSET+detailSlot(source.x,source.z)*8;
  header.writeUInt32LE(header.length,offset);
  header.writeUInt32LE(payload.length,offset+4);
  writeFileSync(join(folder,`${source.x>>5}.${source.z>>5}.bin`),Buffer.concat([header,payload]));
}

test('full detail extends playable coverage without changing original chunks or the save hash',()=>{
  const folder=mkdtempSync(join(tmpdir(),'honeymoon-detail-assets-'));
  try {
    const world=join(folder,'world'), detail=join(folder,'full-world');
    mkdirSync(world);
    mkdirSync(detail);
    const contentHash='a'.repeat(64), x=-65, z=69;
    const manifest={schemaVersion:1,contentHash,chunkPalettes:true,palette:['air'],
      spawn:[.5,65,.5],bounds:{minX:0,maxX:15,minZ:0,maxZ:15,minY:0,maxY:255},chunks:[[0,0]]};
    writeFileSync(join(world,'world.json'),JSON.stringify(manifest));
    const slot=detailSlot(x,z), mask=Buffer.alloc(128);
    mask[slot>>3]=1<<(slot&7);
    const descriptor={version:1,sourceHash:contentHash,hash:'b'.repeat(64),bounds:[x,z,x,z],regions:[[x>>5,z>>5,mask.toString('base64')]]};
    writeFileSync(join(detail,'manifest.json'),JSON.stringify(descriptor));
    const indices=Buffer.alloc(8192);
    indices.writeUInt16LE(1);
    const source={x,z,palette:['air','legacy:1:0'],sections:[{y:4,indices:indices.toString('base64')}],
      objects:[],entities:[],compositions:{}};
    writePack(detail,source);

    const base=loadBase(world);
    const has=detailCoverage(base.publicManifest.fullChunks);
    assert.equal(base.hash,contentHash);
    assert.deepEqual(base.manifest.chunks,manifest.chunks);
    assert.equal(has(x,z),true);
    assert.equal(has(x+1,z),false);
    assert.equal(base.publicManifest.fullWorldPlayable,true);
    assert.equal(base.hasPlayableChunk(x,z),true);
    assert.equal(base.hasPlayableChunk(0,0),true);
    assert.equal(base.hasPlayableChunk(x,z+1),false);
    assert.equal(base.inBounds(x*16,64,z*16),true);
    assert.equal(base.getCell(x*16,64,z*16).key,'legacy:1:0');
    assert.deepEqual(base.publicChunk(x,z),source);
    assert.equal(base.publicChunk(x+1,z),null);
    assert.deepEqual(base.publicChunk(x,z,true),{x,z,sections:[],palette:['air'],objects:[],entities:[],highOnly:true});
    assert.equal(base.publicChunk(x+1,z,true),null);

    descriptor.sourceHash='c'.repeat(64);
    writeFileSync(join(detail,'manifest.json'),JSON.stringify(descriptor));
    const other=loadBase(world);
    assert.equal(other.publicManifest.fullChunks,undefined);
    assert.equal(other.publicChunk(x,z),null);
  } finally {
    const path=realpathSync(folder);
    if (dirname(path)===realpathSync(tmpdir()) && basename(path).startsWith('honeymoon-detail-assets-')) {
      rmSync(path,{recursive:true,force:true});
    }
  }
});

test('streaming solo advertises absent regions, protects their boundaries and promotes verified packs on disk',t=>{
  const folder=mkdtempSync(join(tmpdir(),'honeymoon-detail-assets-'));
  t.after(()=>{
    const path=realpathSync(folder);
    if (dirname(path)===realpathSync(tmpdir()) && basename(path).startsWith('honeymoon-detail-assets-')) {
      rmSync(path,{recursive:true,force:true});
    }
  });
  const world=join(folder,'world'), detail=join(folder,'full-world');
  mkdirSync(world);
  mkdirSync(detail);
  const contentHash='a'.repeat(64), x=-33, z=32;
  const manifest={schemaVersion:1,contentHash,chunkPalettes:true,palette:['air','legacy:54:0'],
    spawn:[x*16+.5,65,z*16+.5],bounds:{minX:x*16,maxX:x*16+15,minZ:z*16,maxZ:z*16+15,minY:0,maxY:255},chunks:[[x,z]]};
  writeFileSync(join(world,'world.json'),JSON.stringify(manifest));
  const slot=detailSlot(x,z), mask=Buffer.alloc(128);
  mask[slot>>3]=1<<(slot&7);
  const descriptor={version:1,sourceHash:contentHash,hash:'b'.repeat(64),bounds:[x,z,x,z],regions:[[x>>5,z>>5,mask.toString('base64')]]};
  writeFileSync(join(detail,'manifest.json'),JSON.stringify(descriptor));

  const files=new Set(), pack=soloRegionFile(x,z);
  const base=loadBase(world,{partial:{has:path=>files.has(path)}});
  assert.equal(pack,'full-world/-2.1.bin');
  assert.equal(soloRegionFile(NaN,z),null);
  assert.equal(base.worldCoverage(x,z),true);
  assert.equal(detailCoverage(base.publicManifest.fullChunks)(x,z),true);
  assert.equal(base.hasPlayableChunk(x,z),false);
  assert.equal(base.getCell(x*16,64,z*16).key,'legacy:1:0');
  assert.equal(base.getCell((x+1)*16,64,z*16).key,'air');
  assert.equal(base.publicChunk(x,z),null);
  assert.equal(base.publicChunk(x,z,true),null);

  const indices=Buffer.alloc(8192);
  indices.writeUInt16LE(1);
  const chest={key:'chest',position:[x*16,64,z*16],type:'Chest',data:{Items:[{id:1}]}};
  const painting={key:'painting',position:[x*16,65,z*16],type:'Painting',data:{Motive:'Kebab'}};
  writePack(detail,{x,z,palette:manifest.palette,sections:[{y:4,indices:indices.toString('base64')}],
    objects:[chest],entities:[painting,{key:'pig',position:painting.position,type:'Pig'}],compositions:{}});
  assert.equal(base.publicChunk(x,z),null);
  files.add(pack);
  assert.equal(base.hasPlayableChunk(x,z),true);
  assert.equal(base.getCell(x*16,64,z*16).key,'legacy:54:0');
  assert.deepEqual(base.getCell(x*16,64,z*16).object,chest);
  assert.deepEqual(base.publicChunk(x,z).objects[0].data,{});
  assert.deepEqual(base.publicChunk(x,z).entities.map(entity=>entity.type),['Painting']);
  assert.equal(base.publicChunk(x,z,true).highOnly,true);

  files.delete(pack);
  assert.equal(base.publicChunk(x,z),null);
  assert.equal(base.getCell(x*16,64,z*16).key,'legacy:1:0');
});
