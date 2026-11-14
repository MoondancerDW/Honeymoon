import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadBase } from '../server/base.mjs';
import { browserPhotos } from './reference-route.mjs';

const [poseFile, destination, generatedDir = 'generated'] = process.argv.slice(2);
assert.ok(poseFile && destination, 'Usage: node qa/building-photos.mjs POSES_TXT DESTINATION [GENERATED]');
const output = resolve(destination);
const generated = resolve(generatedDir);
const checkPoints = (await readFile(poseFile, 'utf8')).trim().split(/\r?\n/).map(line => {
  const [id, x, y, z, yaw, pitch, ...activate] = line.trim().split(/\s+/);
  assert.match(id, /^[a-z0-9-]+$/);
  const coordinates = [x, y, z, yaw, pitch].map(Number);
  assert.ok(coordinates.every(Number.isFinite), `Invalid pose: ${line}`);
  assert.ok(activate.length === 0 || activate.length === 3 && activate.map(Number).every(Number.isInteger), `Invalid action: ${line}`);
  return {id, feet: coordinates.slice(0, 3), yaw: coordinates[3], pitch: coordinates[4],
    ...(activate.length && {activate:activate.map(Number)})};
});
assert.equal(new Set(checkPoints.map(pose => pose.id)).size, checkPoints.length, 'Duplicate pose ID');
await mkdir(output, {recursive: true});
await browserPhotos(loadBase(resolve(generated, 'world')), output, false, {checkPoints, generated});
await writeFile(resolve(output, 'poses.json'), JSON.stringify({poses: checkPoints}, null, 2) + '\n');
console.log(`${checkPoints.length} desktop poses saved to ${output}`);
