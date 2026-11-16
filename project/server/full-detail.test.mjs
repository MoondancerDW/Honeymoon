import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {loadBase} from './base.mjs';
import {DETAIL_HEADER_SIZE,DETAIL_INDEX_OFFSET,detailCoverage,detailSlot} from '../world/full-detail.mjs';

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
    const payload=gzipSync(JSON.stringify(source));
    const header=Buffer.alloc(DETAIL_HEADER_SIZE);
    header.write('HDTL');
    header.writeUInt16LE(1,4);
    const offset=DETAIL_INDEX_OFFSET+slot*8;
    header.writeUInt32LE(header.length,offset);
    header.writeUInt32LE(payload.length,offset+4);
    writeFileSync(join(detail,`${x>>5}.${z>>5}.bin`),Buffer.concat([header,payload]));

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
