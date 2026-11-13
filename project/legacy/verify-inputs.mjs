import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const manifest = JSON.parse(await readFile(new URL('client-inputs.json', import.meta.url), 'utf8'));
const [mode = 'atlas', folder = fileURLToPath(new URL('../../sources/Honeymoon/', import.meta.url))] =
  process.argv.slice(2);
if (!['atlas', 'legacy'].includes(mode)) {
  throw new Error('Usage: node legacy/verify-inputs.mjs [atlas|legacy] [source directory]');
}
const inputs = mode === 'atlas' ? manifest.atlasInputs :
  [...new Map([...manifest.atlasInputs, ...manifest.originalMods, manifest.originalModifiedJar]
    .map(file => [file.path, file])).values()];

let failures = 0;
for (const file of inputs) {
  const path = resolve(folder, file.path);
  try {
    if ((await stat(path)).size !== file.bytes) throw new Error('wrong size');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest('hex') !== file.sha256) throw new Error('SHA-256 mismatch');
    console.log('OK  ' + file.path);
  } catch (error) {
    console.error('ERR ' + file.path + ' — ' + (error.code === 'ENOENT' ? 'missing' : error.message));
    failures++;
  }
}
console.log(inputs.length - failures + '/' + inputs.length + ' verified');
process.exitCode = failures ? 1 : 0;
