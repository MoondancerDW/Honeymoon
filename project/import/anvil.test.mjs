import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadBase } from '../server/base.mjs';
import { importWorld } from './anvil.mjs';
import { readNbt, readRegionChunk, sectionBlocks } from './nbt.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(project, '../sources/Honeymoon/saves/equestria');
const work = join(project, 'work');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

test('Reads Java modified UTF-8 and exact signed 64-bit values', () => {
  const root = Buffer.from([
    10, 0, 0,
    8, 0, 1, 115, 0, 8, 0xc0, 0x80, 0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80,
    4, 0, 1, 110, 0x80, 0, 0, 0, 0, 0, 0, 0,
    0,
  ]);
  const result = readNbt(root);
  assert.equal(result.s, '\0😀');
  assert.deepEqual(result.n, { $nbt: 'long', value: '-9223372036854775808' });
  assert.throws(() => readNbt(root.subarray(0, 10)), /Invalid NBT payload length/);
});

test('Anvil rectangle rounds outward and keeps original cells in independent chunk palettes', {
  skip: !existsSync(join(source, 'level.dat')) ? 'Honeymoon transfer files are required' : false,
}, () => {
  mkdirSync(work, {recursive:true});
  const temporary = mkdtempSync(join(work, 'anvil-area-test-'));
  try {
    const out = join(temporary, 'map');
    const manifest = importWorld({out, area:'-33,-47,7,-17'});
    assert.deepEqual(manifest.bounds, {minX:-48,maxX:15,minZ:-48,maxZ:-17,minY:0,maxY:255});
    assert.equal(manifest.chunks.length, 8);
    assert.equal(manifest.chunkPalettes, true);
    assert.deepEqual(manifest.spawn, [-7.5,65,-19.5]);
    const base = loadBase(out);
    assert.deepEqual(base.publicManifest.palette, ['air']);
    assert.deepEqual(base.publicManifest.compositions, {});
    assert.equal(base.getCell(-8,64,-20).key, 'legacy:2:0');
    const chunk = base.publicChunk(-1,-2);
    assert.equal(chunk.palette[0], 'air');
    assert.ok(chunk.palette.length > 1 && chunk.palette.length < manifest.palette.length);
    assert.ok(chunk.palette.every(key => base.catalog.has(key)));
    assert.ok(base.inBounds(-48,0,-48) && !base.inBounds(-49,0,-48));
    assert.throws(() => importWorld({out, area:'1,1,2,2'}), /include the original spawn/);
    assert.throws(() => importWorld({out, area:'0,0,-1,-1'}), /Invalid area coordinates/);
  } finally {
    if (dirname(temporary) === work && basename(temporary).startsWith('anvil-area-test-')) {
      rmSync(temporary, {recursive:true,force:true});
    }
  }
});

test('Reads both Add and metadata nibbles and validates bad sectors', () => {
  const section = { Y: 4, Blocks: Buffer.alloc(4096), Add: Buffer.alloc(2048), Data: Buffer.alloc(2048) };
  section.Blocks[0] = 0xee;
  section.Blocks[1] = 0xf9;
  section.Add[0] = 0x32;
  section.Data[0] = 0xba;
  const decoded = sectionBlocks(section);
  assert.deepEqual([...decoded.blocks.slice(0, 2)], [750, 1017]);
  assert.deepEqual([...decoded.variants.slice(0, 2)], [10, 11]);
  const region = Buffer.alloc(8192);
  region.writeUInt32BE(0x000101, 1023 * 4);
  assert.throws(() => readRegionChunk(region, -1, -1), /Invalid region sector/);
  assert.equal(readRegionChunk(region, 0, 0), null);
});

test('Reimports all 64 real chunks reproducibly with exact negative-coordinate samples', {
  skip: !existsSync(join(source, 'level.dat')) ? 'Honeymoon transfer files are required' : false,
}, () => {
  mkdirSync(work, { recursive: true });
  const temporary = mkdtempSync(join(work, 'anvil-test-'));
  try {
    const out = join(temporary, 'world');
    const initial = importWorld({ out, terrainRadius: 8 });
    const next = importWorld({ out, terrainRadius: 8 });
    const core = importWorld({ out: join(temporary, 'core'), terrainRadius: 8, visualRadius: 0 });
    assert.equal(initial.contentHash, next.contentHash);
    assert.equal(initial.contentHash, core.contentHash);
    assert.equal(initial.visualHash, next.visualHash);
    assert.deepEqual(initial.chunkHash, core.chunkHash);
    assert.deepEqual(next.palette.slice(0, next.corePaletteSize), core.palette);
    assert.deepEqual(initial.terrain, next.terrain);
    assert.equal(initial.counts.chunks, 64);
    assert.equal(initial.counts.ids, 143);
    assert.equal(initial.counts.variants, 416);
    assert.equal(initial.counts.covers, 21023);
    assert.equal(initial.counts.coverPatterns, 4575);
    assert.equal(initial.counts.malformedCompositions, 0);
    assert.equal(initial.unknownRegistry.length, 9);
    assert.deepEqual(initial.spawn, [-7.5, 65, -19.5]);
    assert.deepEqual(initial.samples.armchair, {
      position: [-34, 65, -61], cell: 'legacy:213:0', objectType: 'TileEntityArmChair',
    });
    assert.deepEqual(initial.samples.bookcase, {
      position: [-59, 76, -50], cell: 'legacy:2250:1', objectType: 'BookcaseTile',
    });
    const files = readdirSync(join(out, 'chunks'));
    assert.equal(files.length, 144);
    assert.equal(next.visualChunks.length, 80);
    assert.ok(next.visualChunks.some(([x, z]) => x === -1 && z === -5));
    const base = loadBase(out);
    assert.ok(base.publicChunk(-1, -5).sections.length);
    assert.equal(base.getCell(-7, 66, -80).key, 'air');
    assert.equal(base.catalog.has(next.palette[next.corePaletteSize]), false);
    for (const file of files) {
      const bytes = readFileSync(join(out, 'chunks', file));
      if (next.chunkHash[file]) assert.equal(sha256(bytes), next.chunkHash[file]);
      const chunk = JSON.parse(bytes);
      assert.equal(file, `${chunk.x}.${chunk.z}.json`);
      for (const section of chunk.sections) {
        const indices = Buffer.from(section.indices, 'base64');
        assert.equal(indices.length, 8192);
        for (let offset = 0; offset < indices.length; offset += 2) {
          assert.ok(indices.readUInt16LE(offset) < next.palette.length);
        }
        if (section.skyLight) assert.equal(Buffer.from(section.skyLight, 'base64').length, 2048);
        if (section.blockLight) assert.equal(Buffer.from(section.blockLight, 'base64').length, 2048);
      }
    }

    const terrain = JSON.parse(readFileSync(join(out, 'terrain-8.json')));
    assert.equal(terrain.innerRadius, 6);
    assert.equal(terrain.chunks.length, 112);
    assert.ok(!terrain.palette.some((key) => key === 'legacy:750:0' || key.startsWith('cover-material:')));
    for (const { x, z, levels } of terrain.chunks) {
      assert.ok(x < -6 || x >= 6 || z < -6 || z >= 6);
      for (const { indices } of levels) assert.equal(Buffer.from(indices, 'base64').length, 128);
    }
    const surroundings = importWorld({out: join(temporary, 'surroundings'), radius: 4, terrainRadius: 16, visualRadius: 9});
    assert.equal(surroundings.contentHash, core.contentHash);
    assert.ok(surroundings.visualChunks.some(([x, z]) => x === -9 && z === 0));
    assert.equal(surroundings.terrain[0].chunks, 0);
    assert.equal(surroundings.terrain[1].innerRadius, 9);
    const outer = JSON.parse(readFileSync(join(temporary, 'surroundings', 'terrain-16.json')));
    assert.ok(outer.chunks.every(({ x, z }) => x < -9 || x >= 9 || z < -9 || z >= 9));
    assert.throws(() => importWorld({ out: source }), /Output must be separate/);
    writeFileSync(join(out, 'unrelated.txt'), 'keep');
    assert.throws(() => importWorld({ out }), /unrelated directory/);
    assert.equal(readFileSync(join(out, 'unrelated.txt'), 'utf8'), 'keep');
  } finally {
    if (dirname(temporary) === work && basename(temporary).startsWith('anvil-test-')) {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
});
