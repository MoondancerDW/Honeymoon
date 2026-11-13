import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
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
    assert.equal(initial.contentHash, next.contentHash);
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
    assert.equal(files.length, 64);
    for (const file of files) {
      const bytes = readFileSync(join(out, 'chunks', file));
      assert.equal(sha256(bytes), next.chunkHash[file]);
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
    assert.equal(terrain.chunks.length, 192);
    assert.ok(terrain.palette.some((key) => key.startsWith('cover-material:')));
    for (const { x, z, levels } of terrain.chunks) {
      assert.ok(x < -4 || x >= 4 || z < -4 || z >= 4);
      for (const { indices } of levels) assert.equal(Buffer.from(indices, 'base64').length, 128);
    }
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
